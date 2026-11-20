use anyhow::Result;
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path as AxumPath, Query, Request, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    process::Command,
    sync::{RwLock, broadcast, oneshot},
};
use tracing::{error, info, warn};
use uuid::Uuid;
use velo_agent::{AgentHandle, AgentSpawner, InteractiveShellHandle};
use velo_protocol::{
    AdvisorSessionRequest, AgentEvent, AgentProvider, CommitteeRequest, CreateSessionRequest,
    HandoffSessionRequest, LoopSessionRequest, QueuedPromptItem, SessionInfo, SessionInputRequest,
    SessionStatus, WsClientMessage, WsServerMessage, default_approval_mode,
};
use velo_worktree::{WorktreeManager, default_velo_home};

pub mod automations;
pub mod checkpoints;
pub mod cli_sessions;
pub mod extensions;
pub mod hosts;
pub mod pr;
pub mod pricing;
pub mod push;
pub mod quota;
pub mod relay_bridge;
pub mod service;
pub mod storage;
pub mod voice;

pub fn canonical_workspace_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return velo_worktree::default_general_workspace()
            .to_string_lossy()
            .trim_end_matches('/')
            .to_string();
    }
    let expanded = velo_worktree::expand_tilde_path(Path::new(trimmed));
    let s = expanded.to_string_lossy().to_string();
    if s.len() > 1 {
        s.trim_end_matches('/').to_string()
    } else {
        s
    }
}

pub fn round_tps(tps: f64) -> f64 {
    if !tps.is_finite() || tps < 0.5 {
        0.0
    } else {
        ((tps.min(999.9)) * 10.0).round() / 10.0
    }
}

pub fn estimate_text_tokens(text: &str) -> u64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let mut explicit_thinking_tokens = 0u64;
    let mut cleaned = trimmed.to_string();
    while let Some(end_idx) = cleaned.find(" thinking tokens)") {
        if let Some(open_idx) = cleaned[..end_idx].rfind('(') {
            let num_str = cleaned[open_idx + 1..end_idx].trim();
            if let Ok(n) = num_str.parse::<u64>() {
                explicit_thinking_tokens += n;
            }
            let after = end_idx + " thinking tokens)".len();
            cleaned.replace_range(open_idx..after, "");
        } else {
            break;
        }
    }
    let mut cjk = 0usize;
    let mut other = 0usize;
    for ch in cleaned.chars() {
        if ch.is_whitespace() {
            continue;
        }
        if ('\u{2E80}'..='\u{9FFF}').contains(&ch) || ('\u{F900}'..='\u{FAFF}').contains(&ch) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    let text_tok = if cjk == 0 && other == 0 {
        0
    } else {
        ((cjk as f64 * 0.72) + (other as f64 * 0.27)).round().max(1.0) as u64
    };
    explicit_thinking_tokens + text_tok
}

fn event_timestamp_ms(ev: &AgentEvent) -> i64 {
    match ev {
        AgentEvent::StatusChanged { timestamp, .. }
        | AgentEvent::UserMessage { timestamp, .. }
        | AgentEvent::ProviderSessionBound { timestamp, .. }
        | AgentEvent::PtyOutput { timestamp, .. }
        | AgentEvent::ThinkingChunk { timestamp, .. }
        | AgentEvent::ThinkingDelta { timestamp, .. }
        | AgentEvent::MessageChunk { timestamp, .. }
        | AgentEvent::MessageDelta { timestamp, .. }
        | AgentEvent::UsageUpdated { timestamp, .. }
        | AgentEvent::RateLimitsUpdated { timestamp, .. }
        | AgentEvent::TerminalOutput { timestamp, .. }
        | AgentEvent::ToolCallRequested { timestamp, .. }
        | AgentEvent::ToolCallCompleted { timestamp, .. }
        | AgentEvent::PermissionRequested { timestamp, .. }
        | AgentEvent::PermissionResolved { timestamp, .. }
        | AgentEvent::UserQuestionRequested { timestamp, .. }
        | AgentEvent::UserQuestionAnswered { timestamp, .. }
        | AgentEvent::BrowserCommand { timestamp, .. }
        | AgentEvent::SetupHookOutput { timestamp, .. }
        | AgentEvent::DiffUpdated { timestamp, .. }
        | AgentEvent::Error { timestamp, .. } => timestamp.timestamp_millis(),
    }
}

fn is_terminal_status_event(ev: &AgentEvent) -> bool {
    matches!(
        ev,
        AgentEvent::StatusChanged {
            status: SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Stopped,
            ..
        }
    )
}

fn upsert_turn_usage_event(hist: &mut Vec<AgentEvent>, usage_ev: AgentEvent) {
    let turn_start = hist
        .iter()
        .rposition(|e| matches!(e, AgentEvent::UserMessage { .. }))
        .map(|idx| idx + 1)
        .unwrap_or(0);

    let mut existing_indices: Vec<usize> = hist[turn_start..]
        .iter()
        .enumerate()
        .filter_map(|(off, e)| {
            if matches!(e, AgentEvent::UsageUpdated { .. }) {
                Some(turn_start + off)
            } else {
                None
            }
        })
        .collect();

    if let Some(first_idx) = existing_indices.first().copied() {
        hist[first_idx] = usage_ev;
        for dup_idx in existing_indices.drain(1..).rev() {
            hist.remove(dup_idx);
        }
        return;
    }

    if hist.len() > turn_start && is_terminal_status_event(&hist[hist.len() - 1]) {
        hist.insert(hist.len() - 1, usage_ev);
    } else {
        hist.push(usage_ev);
    }
}

/// Normalizes turn-level `UsageUpdated` events across historical event logs so every completed or
/// multi-step turn carries a single authoritative `UsageUpdated { is_turn_total: true, output_tps, ... }`,
/// ensuring Mac Desktop and iOS Mobile always render identical `tok/s` and token counts even after
/// blind E2EE relay compaction.
pub fn enrich_history_turn_metrics(events: &[AgentEvent]) -> Vec<AgentEvent> {
    if events.is_empty() {
        return Vec::new();
    }

    #[derive(Clone, Debug)]
    struct RawUsageStep {
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
        context_window: u64,
        cost_usd: f64,
        net_llm_sec: f64,
        timestamp: chrono::DateTime<Utc>,
    }

    let mut user_positions: Vec<usize> = events
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            if matches!(e, AgentEvent::UserMessage { .. }) {
                Some(i)
            } else {
                None
            }
        })
        .collect();

    if user_positions.is_empty() {
        return events.to_vec();
    }

    let mut out: Vec<AgentEvent> = Vec::with_capacity(events.len());
    if user_positions[0] > 0 {
        out.extend_from_slice(&events[..user_positions[0]]);
    }
    user_positions.push(events.len());

    for win in user_positions.windows(2) {
        let turn_slice = &events[win[0]..win[1]];
        let session_id = turn_slice[0].session_id();
        let user_ts_ms = event_timestamp_ms(&turn_slice[0]);

        let usage_events: Vec<&AgentEvent> = turn_slice
            .iter()
            .filter(|e| matches!(e, AgentEvent::UsageUpdated { .. }))
            .collect();

        let already_normalized = !usage_events.is_empty()
            && usage_events.iter().all(|e| {
                matches!(
                    e,
                    AgentEvent::UsageUpdated {
                        is_turn_total: true,
                        ..
                    }
                )
            })
            && matches!(
                usage_events.last(),
                Some(AgentEvent::UsageUpdated { output_tps, .. }) if *output_tps >= 0.5
            );

        if already_normalized {
            let final_usage = (*usage_events.last().unwrap()).clone();
            let mut turn_out: Vec<AgentEvent> = turn_slice
                .iter()
                .filter(|e| !matches!(e, AgentEvent::UsageUpdated { .. }))
                .cloned()
                .collect();
            if turn_out.len() > 1 && is_terminal_status_event(&turn_out[turn_out.len() - 1]) {
                turn_out.insert(turn_out.len() - 1, final_usage);
            } else {
                turn_out.push(final_usage);
            }
            out.extend(turn_out);
            continue;
        }

        let mut raw_steps: Vec<RawUsageStep> = Vec::new();
        let mut step_anchor_ms = user_ts_ms;
        let mut est_anchor_ms = user_ts_ms;
        let mut tool_start_ms: Option<i64> = None;
        let mut step_tool_wait_ms: i64 = 0;
        let mut saw_item_in_turn = false;
        let mut prev_was_thinking = false;
        let mut est_tokens_total: u64 = 0;
        let mut post_thinking_tok: u64 = 0;
        let mut post_thinking_sec: f64 = 0.0;
        let mut last_ts = match &turn_slice[0] {
            AgentEvent::UserMessage { timestamp, .. } => *timestamp,
            _ => Utc::now(),
        };

        for ev in &turn_slice[1..] {
            let ts_ms = event_timestamp_ms(ev);
            match ev {
                AgentEvent::ThinkingDelta { text, timestamp, .. } => {
                    saw_item_in_turn = true;
                    last_ts = *timestamp;
                    let tok = estimate_text_tokens(text);
                    if tok > 0 {
                        est_tokens_total += tok;
                        est_anchor_ms = ts_ms;
                        prev_was_thinking = true;
                    }
                }
                AgentEvent::MessageDelta { text, timestamp, .. } => {
                    saw_item_in_turn = true;
                    last_ts = *timestamp;
                    if !text.starts_with("[stderr]") {
                        let tok = estimate_text_tokens(text);
                        if tok > 0 {
                            est_tokens_total += tok;
                            if prev_was_thinking && tok >= 12 {
                                let raw_sec = ((ts_ms - est_anchor_ms).max(0) as f64) / 1000.0;
                                if (0.15..=60.0).contains(&raw_sec) {
                                    let transition = (raw_sec * 0.18).min(0.8);
                                    post_thinking_tok += tok;
                                    post_thinking_sec += (raw_sec - transition).max(0.15);
                                }
                            }
                            est_anchor_ms = ts_ms;
                            prev_was_thinking = false;
                        }
                    }
                }
                AgentEvent::ToolCallRequested {
                    arguments,
                    timestamp,
                    ..
                } => {
                    saw_item_in_turn = true;
                    prev_was_thinking = false;
                    last_ts = *timestamp;
                    if tool_start_ms.is_none() {
                        tool_start_ms = Some(ts_ms);
                    }
                    let arg_str = arguments.to_string();
                    let tok = estimate_text_tokens(&arg_str).min(600);
                    if tok >= 4 {
                        est_tokens_total += tok;
                    }
                    est_anchor_ms = ts_ms;
                }
                AgentEvent::ToolCallCompleted { timestamp, .. } => {
                    prev_was_thinking = false;
                    last_ts = *timestamp;
                    if let Some(t0) = tool_start_ms.take() {
                        step_tool_wait_ms += (ts_ms - t0).max(0);
                    }
                    est_anchor_ms = ts_ms;
                }
                AgentEvent::PermissionRequested { .. }
                | AgentEvent::UserQuestionRequested { .. } => {
                    if tool_start_ms.is_none() {
                        tool_start_ms = Some(ts_ms);
                    }
                }
                AgentEvent::PermissionResolved { .. }
                | AgentEvent::UserQuestionAnswered { .. } => {
                    if let Some(t0) = tool_start_ms.take() {
                        step_tool_wait_ms += (ts_ms - t0).max(0);
                    }
                    est_anchor_ms = ts_ms;
                }
                AgentEvent::UsageUpdated {
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    context_window,
                    cost_usd,
                    timestamp,
                    ..
                } => {
                    last_ts = *timestamp;
                    if let Some(t0) = tool_start_ms.take() {
                        step_tool_wait_ms += (ts_ms - t0).max(0);
                    }
                    let raw_dt_sec = ((ts_ms - step_anchor_ms).max(0) as f64) / 1000.0;
                    let tool_sec = (step_tool_wait_ms.max(0) as f64) / 1000.0;
                    let net_llm_sec = (raw_dt_sec - tool_sec).max(0.05);

                    step_anchor_ms = ts_ms;
                    est_anchor_ms = ts_ms;
                    step_tool_wait_ms = 0;

                    // Drop stale Codex `thread/resume` step-0 echo before any item starts in this turn
                    if raw_steps.is_empty()
                        && !saw_item_in_turn
                        && raw_dt_sec < 1.2
                        && *input_tokens > 20_000
                        && *output_tokens >= 100
                    {
                        continue;
                    }

                    raw_steps.push(RawUsageStep {
                        input_tokens: *input_tokens,
                        output_tokens: *output_tokens,
                        cache_read_tokens: *cache_read_tokens,
                        cache_write_tokens: *cache_write_tokens,
                        context_window: *context_window,
                        cost_usd: *cost_usd,
                        net_llm_sec,
                        timestamp: *timestamp,
                    });
                }
                AgentEvent::StatusChanged { timestamp, .. } => {
                    last_ts = *timestamp;
                }
                _ => {}
            }
        }

        let synthesized_usage: Option<AgentEvent> = if !raw_steps.is_empty() {
            let n = raw_steps.len();
            let is_claude_summary_tail = n >= 2
                && raw_steps[..n - 1].iter().all(|s| s.cost_usd == 0.0)
                && raw_steps[n - 1].cost_usd > 0.0;

            let (turn_out, turn_cost, timing_steps) = if is_claude_summary_tail {
                let sum_prior: u64 = raw_steps[..n - 1].iter().map(|s| s.output_tokens).sum();
                let out_tok = raw_steps[n - 1].output_tokens.max(sum_prior);
                let slice_end = if raw_steps[n - 1].net_llm_sec < 0.5 {
                    n - 1
                } else {
                    n
                };
                (out_tok, raw_steps[n - 1].cost_usd, &raw_steps[..slice_end])
            } else {
                (
                    raw_steps.iter().map(|s| s.output_tokens).sum(),
                    raw_steps.iter().map(|s| s.cost_usd).sum(),
                    &raw_steps[..],
                )
            };

            let turn_in = raw_steps
                .iter()
                .rev()
                .map(|s| s.input_tokens)
                .find(|v| *v > 0)
                .unwrap_or(0);
            let turn_cache_read = raw_steps
                .iter()
                .rev()
                .map(|s| s.cache_read_tokens)
                .find(|v| *v > 0)
                .unwrap_or(0);
            let turn_cache_write = raw_steps
                .iter()
                .rev()
                .map(|s| s.cache_write_tokens)
                .find(|v| *v > 0)
                .unwrap_or(0);
            let turn_ctx_win = raw_steps
                .iter()
                .rev()
                .map(|s| s.context_window)
                .find(|v| *v > 0)
                .unwrap_or(0);
            let final_ts = raw_steps.last().map(|s| s.timestamp).unwrap_or(last_ts);

            let mut big_tok = 0u64;
            let mut big_sec = 0.0f64;
            for s in timing_steps {
                if s.output_tokens >= 600 && s.net_llm_sec >= 1.8 {
                    let ttft =
                        (1.8 + (s.input_tokens as f64) / 16_000.0).min(s.net_llm_sec * 0.45);
                    big_tok += s.output_tokens;
                    big_sec += (s.net_llm_sec - ttft).max(0.25);
                }
            }

            let computed_tps = if big_tok > 0 && big_sec >= 0.25 {
                round_tps(big_tok as f64 / big_sec)
            } else {
                let mut med_tok = 0u64;
                let mut med_sec = 0.0f64;
                for s in timing_steps {
                    if s.output_tokens >= 140 && s.net_llm_sec >= 0.8 {
                        let ttft =
                            (1.8 + (s.input_tokens as f64) / 15_000.0).min(s.net_llm_sec * 0.68);
                        med_tok += s.output_tokens;
                        med_sec += (s.net_llm_sec - ttft).max(0.20);
                    }
                }
                if med_tok > 0 && med_sec >= 0.20 {
                    round_tps(med_tok as f64 / med_sec)
                } else if post_thinking_tok > 0 && post_thinking_sec >= 0.15 {
                    round_tps(post_thinking_tok as f64 / post_thinking_sec)
                } else {
                    0.0
                }
            };

            Some(AgentEvent::UsageUpdated {
                session_id,
                input_tokens: turn_in,
                output_tokens: turn_out,
                total_tokens: turn_in.saturating_add(turn_out),
                cache_read_tokens: turn_cache_read,
                cache_write_tokens: turn_cache_write,
                context_window: turn_ctx_win,
                cost_usd: turn_cost,
                output_tps: computed_tps,
                is_turn_total: true,
                timestamp: final_ts,
            })
        } else if est_tokens_total >= 6 {
            let legacy_tps = if post_thinking_tok >= 12 && post_thinking_sec >= 0.15 {
                round_tps(post_thinking_tok as f64 / post_thinking_sec)
            } else {
                0.0
            };
            Some(AgentEvent::UsageUpdated {
                session_id,
                input_tokens: 0,
                output_tokens: est_tokens_total,
                total_tokens: est_tokens_total,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                context_window: 0,
                cost_usd: 0.0,
                output_tps: legacy_tps,
                is_turn_total: true,
                timestamp: last_ts,
            })
        } else {
            None
        };

        let mut turn_out: Vec<AgentEvent> = turn_slice
            .iter()
            .filter(|e| !matches!(e, AgentEvent::UsageUpdated { .. }))
            .cloned()
            .collect();
        if let Some(usage_ev) = synthesized_usage {
            if turn_out.len() > 1 && is_terminal_status_event(&turn_out[turn_out.len() - 1]) {
                turn_out.insert(turn_out.len() - 1, usage_ev);
            } else {
                turn_out.push(usage_ev);
            }
        }
        out.extend(turn_out);
    }

    out
}

pub struct LiveTurnMetrics {
    pub base_session_output_tokens: u64,
    pub base_session_cost_usd: f64,
    pub step_started_at: std::time::Instant,
    pub step_item_started_at: Option<std::time::Instant>,
    pub step_first_token_at: Option<std::time::Instant>,
    pub last_token_chunk_at: Option<std::time::Instant>,
    pub pause_started_at: Option<std::time::Instant>,
    pub step_pause_ms_since_item: u64,
    pub step_pause_ms_since_token: u64,
    pub step_pause_ms_total: u64,
    pub step_stream_thinking: String,
    pub step_stream_message: String,
    pub turn_est_tokens: u64,
    pub turn_est_decode_ms: u64,
    pub turn_input_tokens: u64,
    pub turn_output_tokens: u64,
    pub turn_cache_read_tokens: u64,
    pub turn_cache_write_tokens: u64,
    pub turn_context_window: u64,
    pub turn_cost_usd: f64,
    pub turn_tps_tokens: u64,
    pub turn_tps_decode_ms: u64,
    pub last_live_emit_at: Option<std::time::Instant>,
    pub last_computed_tps: f64,
    pub provider_emitted_usage: bool,
}

impl LiveTurnMetrics {
    pub fn new(base_session_output_tokens: u64, base_session_cost_usd: f64) -> Self {
        let now = std::time::Instant::now();
        Self {
            base_session_output_tokens,
            base_session_cost_usd,
            step_started_at: now,
            step_item_started_at: None,
            step_first_token_at: None,
            last_token_chunk_at: None,
            pause_started_at: None,
            step_pause_ms_since_item: 0,
            step_pause_ms_since_token: 0,
            step_pause_ms_total: 0,
            step_stream_thinking: String::new(),
            step_stream_message: String::new(),
            turn_est_tokens: 0,
            turn_est_decode_ms: 0,
            turn_input_tokens: 0,
            turn_output_tokens: 0,
            turn_cache_read_tokens: 0,
            turn_cache_write_tokens: 0,
            turn_context_window: 0,
            turn_cost_usd: 0.0,
            turn_tps_tokens: 0,
            turn_tps_decode_ms: 0,
            last_live_emit_at: None,
            last_computed_tps: 0.0,
            provider_emitted_usage: false,
        }
    }

    fn current_step_stream_tokens(&self) -> u64 {
        estimate_text_tokens(&self.step_stream_thinking)
            + estimate_text_tokens(&self.step_stream_message)
    }

    fn reset_step_window(&mut self, now: std::time::Instant) {
        self.step_started_at = now;
        self.step_item_started_at = None;
        self.step_first_token_at = None;
        self.last_token_chunk_at = None;
        self.pause_started_at = None;
        self.step_pause_ms_since_item = 0;
        self.step_pause_ms_since_token = 0;
        self.step_pause_ms_total = 0;
        self.step_stream_thinking.clear();
        self.step_stream_message.clear();
    }
}

fn fallback_workspace_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| velo_worktree::default_general_workspace())
}

pub struct WarmAgentEntry {
    pub handle: AgentHandle,
    pub provider: AgentProvider,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub approval_mode: String,
}

pub struct DaemonInner {
    pub sessions: HashMap<Uuid, SessionInfo>,
    pub event_history: HashMap<Uuid, Vec<AgentEvent>>,
    pub live_turns: HashMap<Uuid, LiveTurnMetrics>,
    pub handles: HashMap<Uuid, AgentHandle>,
    pub warm_handles: HashMap<Uuid, WarmAgentEntry>,
    pub shells: HashMap<Uuid, InteractiveShellHandle>,
    pub pending_approvals: HashMap<String, oneshot::Sender<String>>,
    pub pending_questions: HashMap<String, oneshot::Sender<Vec<String>>>,
    pub automations: Vec<automations::AutomationRule>,
    pub repo_hooks: HashMap<String, String>,
    pub workspaces: Vec<String>,
    pub push_config: push::PushConfig,
    pub quota_cache: quota::PersistedQuotaCache,
    pub remote_hosts: Vec<hosts::RemoteHostNode>,
}

#[derive(Clone)]
pub struct DaemonState {
    pub inner: Arc<RwLock<DaemonInner>>,
    pub db: storage::VeloSqliteStore,
    pub agent_event_tx: broadcast::Sender<AgentEvent>,
    pub event_tx: broadcast::Sender<AgentEvent>,
    pub snapshot_tx: broadcast::Sender<Vec<SessionInfo>>,
    pub worktree_mgr: WorktreeManager,
    pub state_file: PathBuf,
    pub events_dir: PathBuf,
    pub attachments_dir: PathBuf,
    pub automations_file: PathBuf,
    pub hooks_file: PathBuf,
    pub workspaces_file: PathBuf,
    pub push_config_file: PathBuf,
    pub quota_cache_file: PathBuf,
    pub hosts_file: PathBuf,
    pub daemon_http_base: Option<String>,
}

impl DaemonState {
    pub async fn new() -> Result<Self> {
        let velo_home = default_velo_home();
        tokio::fs::create_dir_all(&velo_home).await?;
        let db_path = velo_home.join("velo.db");
        let state_file = velo_home.join("sessions.json");
        let events_dir = velo_home.join("events");
        let attachments_dir = velo_home.join("attachments");
        let automations_file = velo_home.join("automations.json");
        let hooks_file = velo_home.join("repo_hooks.json");
        let workspaces_file = velo_home.join("workspaces.json");
        let push_config_file = velo_home.join("push_config.json");
        let quota_cache_file = velo_home.join("quotas.json");
        let hosts_file = velo_home.join("hosts.json");
        tokio::fs::create_dir_all(&events_dir).await?;
        tokio::fs::create_dir_all(&attachments_dir).await?;

        let db = storage::VeloSqliteStore::open(&db_path)?;
        if let Ok(true) = db.migrate_from_legacy_json_if_needed(&state_file, &events_dir) {
            info!(
                "Migrated legacy JSON sessions & event logs into SQLite WAL database at {}",
                db_path.display()
            );
        }
        let (mut sessions, event_history) = db.load_all()?;
        for s in sessions.values_mut() {
            if matches!(
                s.status,
                SessionStatus::Running | SessionStatus::WaitingForPermission
            ) {
                s.status = SessionStatus::Stopped;
                s.pid = None;
                let _ = db.upsert_session(s);
            }
        }
        let push_cfg = push::load_push_config(&push_config_file).await;
        let quota_cache = quota::load_quota_cache(&quota_cache_file);
        let remote_hosts = hosts::load_remote_hosts(&hosts_file);

        let automations_list = if let Ok(raw) = tokio::fs::read_to_string(&automations_file).await {
            serde_json::from_str::<Vec<automations::AutomationRule>>(&raw).unwrap_or_default()
        } else {
            Vec::new()
        };

        let repo_hooks_map = if let Ok(raw) = tokio::fs::read_to_string(&hooks_file).await {
            serde_json::from_str::<HashMap<String, String>>(&raw).unwrap_or_default()
        } else {
            HashMap::new()
        };

        let mut workspaces_list: Vec<String> =
            if let Ok(raw) = tokio::fs::read_to_string(&workspaces_file).await {
                serde_json::from_str::<Vec<String>>(&raw)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| canonical_workspace_path(&p))
                    .collect()
            } else {
                Vec::new()
            };
        let mut ordered_sessions: Vec<&SessionInfo> = sessions.values().collect();
        ordered_sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        for s in ordered_sessions {
            let clean = canonical_workspace_path(&s.repo_root);
            if !clean.is_empty() && !workspaces_list.contains(&clean) {
                workspaces_list.push(clean);
            }
        }
        if workspaces_list.is_empty() {
            let def_ws = canonical_workspace_path(
                &velo_worktree::default_general_workspace().to_string_lossy(),
            );
            workspaces_list.push(def_ws);
        }

        let (agent_event_tx, _) = broadcast::channel(4096);
        let (event_tx, _) = broadcast::channel(4096);
        let (snapshot_tx, _) = broadcast::channel(128);
        let state = Self {
            inner: Arc::new(RwLock::new(DaemonInner {
                sessions,
                event_history,
                live_turns: HashMap::new(),
                handles: HashMap::new(),
                warm_handles: HashMap::new(),
                shells: HashMap::new(),
                pending_approvals: HashMap::new(),
                pending_questions: HashMap::new(),
                automations: automations_list,
                repo_hooks: repo_hooks_map,
                workspaces: workspaces_list,
                push_config: push_cfg,
                quota_cache,
                remote_hosts,
            })),
            db,
            agent_event_tx,
            event_tx,
            snapshot_tx,
            worktree_mgr: WorktreeManager::default(),
            state_file,
            events_dir,
            attachments_dir,
            automations_file,
            hooks_file,
            workspaces_file,
            push_config_file,
            quota_cache_file,
            hosts_file,
            daemon_http_base: Some(format!(
                "http://127.0.0.1:{}",
                velo_protocol::DEFAULT_DAEMON_PORT
            )),
        };

        state.spawn_event_supervisor();
        state.spawn_cron_scheduler();
        Ok(state)
    }

    fn spawn_event_supervisor(&self) {
        let mut rx = self.agent_event_tx.subscribe();
        let state = self.clone();

        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let session_id = event.session_id();
                let now = std::time::Instant::now();
                let mut should_refresh_diff = false;
                let mut should_persist_sessions = false;
                let mut db_usage_to_upsert: Option<AgentEvent> = None;
                let mut db_event_to_append: Option<AgentEvent> = None;
                let mut next_queued_job: Option<QueuedPromptItem> = None;
                let mut push_notification_job: Option<(
                    push::PushConfig,
                    push::PushTriggerKind,
                    SessionInfo,
                    Option<String>,
                )> = None;
                let mut outbound_events: Vec<AgentEvent> = Vec::with_capacity(2);

                {
                    let mut guard = state.inner.write().await;
                    let (sess_prov, sess_model, base_out, base_cost) = guard
                        .sessions
                        .get(&session_id)
                        .map(|s| {
                            (
                                s.provider.clone(),
                                s.model.clone(),
                                s.output_tokens,
                                s.cost_usd,
                            )
                        })
                        .unwrap_or((AgentProvider::Claude, None, 0, 0.0));
                    let is_codex = matches!(sess_prov, AgentProvider::Codex);

                    let metrics = guard
                        .live_turns
                        .entry(session_id)
                        .or_insert_with(|| LiveTurnMetrics::new(base_out, base_cost));

                    match &event {
                        AgentEvent::ThinkingChunk { delta, replace, .. } => {
                            if is_codex && metrics.step_item_started_at.is_none() {
                                metrics.step_item_started_at = Some(now);
                                metrics.step_pause_ms_since_item = 0;
                            }
                            if !delta.is_empty() {
                                if let Some(prev_tok_at) = metrics.last_token_chunk_at {
                                    if now.duration_since(prev_tok_at).as_millis() > 4_500
                                        && metrics.pause_started_at.is_none()
                                        && metrics.current_step_stream_tokens() == 0
                                    {
                                        metrics.step_first_token_at = Some(now);
                                        metrics.step_pause_ms_since_token = 0;
                                    }
                                }
                                if metrics.step_first_token_at.is_none() {
                                    metrics.step_first_token_at = Some(now);
                                    metrics.step_pause_ms_since_token = 0;
                                }
                                metrics.last_token_chunk_at = Some(now);
                                if *replace {
                                    metrics.step_stream_thinking = delta.clone();
                                } else {
                                    metrics.step_stream_thinking.push_str(delta);
                                }
                            }
                        }
                        AgentEvent::MessageChunk { delta, replace, .. } => {
                            if !delta.is_empty() {
                                if metrics.step_first_token_at.is_none() {
                                    metrics.step_first_token_at = Some(now);
                                    metrics.step_pause_ms_since_token = 0;
                                }
                                metrics.last_token_chunk_at = Some(now);
                                if *replace {
                                    metrics.step_stream_message = delta.clone();
                                } else {
                                    metrics.step_stream_message.push_str(delta);
                                }
                            }
                        }
                        AgentEvent::ThinkingDelta { text, .. } => {
                            if metrics.step_stream_thinking.is_empty() {
                                let tok = estimate_text_tokens(text);
                                if tok > 0 {
                                    let raw_ms = (now
                                        .duration_since(
                                            metrics.step_item_started_at.unwrap_or(metrics.step_started_at),
                                        )
                                        .as_millis() as u64)
                                        .saturating_sub(metrics.step_pause_ms_total);
                                    let decode_ms = if metrics.step_item_started_at.is_some() {
                                        raw_ms.max(120)
                                    } else {
                                        raw_ms.saturating_sub((raw_ms / 2).min(1_800)).max(150)
                                    };
                                    metrics.turn_est_tokens += tok;
                                    metrics.turn_est_decode_ms += decode_ms;
                                }
                            }
                        }
                        AgentEvent::MessageDelta { text, .. } => {
                            if !text.starts_with("[stderr]") && metrics.step_stream_message.is_empty() {
                                let tok = estimate_text_tokens(text);
                                if tok > 0 {
                                    let raw_ms = (now
                                        .duration_since(
                                            metrics.step_item_started_at.unwrap_or(metrics.step_started_at),
                                        )
                                        .as_millis() as u64)
                                        .saturating_sub(metrics.step_pause_ms_total);
                                    let decode_ms = if metrics.step_item_started_at.is_some() {
                                        raw_ms.max(120)
                                    } else {
                                        raw_ms.saturating_sub((raw_ms * 2 / 5).min(1_600)).max(150)
                                    };
                                    metrics.turn_est_tokens += tok;
                                    metrics.turn_est_decode_ms += decode_ms;
                                }
                            }
                        }
                        AgentEvent::ToolCallRequested { .. }
                        | AgentEvent::PermissionRequested { .. }
                        | AgentEvent::UserQuestionRequested { .. } => {
                            if metrics.pause_started_at.is_none() {
                                metrics.pause_started_at = Some(now);
                            }
                        }
                        AgentEvent::ToolCallCompleted { .. }
                        | AgentEvent::PermissionResolved { .. }
                        | AgentEvent::UserQuestionAnswered { .. } => {
                            if let Some(p0) = metrics.pause_started_at.take() {
                                let dt = now.duration_since(p0).as_millis() as u64;
                                metrics.step_pause_ms_total += dt;
                                if metrics.step_item_started_at.is_some() {
                                    metrics.step_pause_ms_since_item += dt;
                                }
                                if metrics.step_first_token_at.is_some() {
                                    metrics.step_pause_ms_since_token += dt;
                                }
                            }
                            if matches!(event, AgentEvent::ToolCallCompleted { .. })
                                && !is_codex
                                && !metrics.provider_emitted_usage
                            {
                                let stream_tok = metrics.current_step_stream_tokens();
                                if stream_tok > 0 {
                                    if let Some(t0) = metrics.step_first_token_at {
                                        let dec_ms = (now.duration_since(t0).as_millis() as u64)
                                            .saturating_sub(metrics.step_pause_ms_since_token)
                                            .max(120);
                                        metrics.turn_est_tokens += stream_tok;
                                        metrics.turn_est_decode_ms += dec_ms;
                                    }
                                    metrics.reset_step_window(now);
                                }
                            }
                        }
                        _ => {}
                    }

                    // Live streaming TPS tick (~350ms cadence) while non-empty chunks are flowing
                    if matches!(
                        &event,
                        AgentEvent::ThinkingChunk { delta, .. } | AgentEvent::MessageChunk { delta, .. }
                            if !delta.is_empty()
                    ) {
                        if let Some(t0) = metrics.step_first_token_at {
                            let step_dec_ms = (now.duration_since(t0).as_millis() as u64)
                                .saturating_sub(metrics.step_pause_ms_since_token);
                            let step_tok = metrics.current_step_stream_tokens();
                            let due = metrics
                                .last_live_emit_at
                                .map(|prev| now.duration_since(prev).as_millis() >= 350)
                                .unwrap_or(true);
                            if step_dec_ms >= 280 && step_tok >= 3 && due {
                                let base_tok = if metrics.turn_tps_tokens > 0 {
                                    metrics.turn_tps_tokens
                                } else {
                                    metrics.turn_est_tokens
                                };
                                let base_ms = if metrics.turn_tps_tokens > 0 {
                                    metrics.turn_tps_decode_ms
                                } else {
                                    metrics.turn_est_decode_ms
                                };
                                let tot_tok = base_tok + step_tok;
                                let tot_ms = (base_ms + step_dec_ms).max(200);
                                let live_tps =
                                    round_tps(tot_tok as f64 / (tot_ms as f64 / 1000.0));
                                if live_tps >= 0.5 {
                                    metrics.last_live_emit_at = Some(now);
                                    metrics.last_computed_tps = live_tps;
                                    let live_out = metrics.turn_output_tokens + step_tok;
                                    outbound_events.push(event.clone());
                                    outbound_events.push(AgentEvent::UsageUpdated {
                                        session_id,
                                        input_tokens: metrics.turn_input_tokens,
                                        output_tokens: live_out,
                                        total_tokens: metrics
                                            .turn_input_tokens
                                            .saturating_add(live_out),
                                        cache_read_tokens: metrics.turn_cache_read_tokens,
                                        cache_write_tokens: metrics.turn_cache_write_tokens,
                                        context_window: metrics.turn_context_window,
                                        cost_usd: metrics.turn_cost_usd,
                                        output_tps: live_tps,
                                        is_turn_total: true,
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                        }
                    }

                    if let AgentEvent::UsageUpdated {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_write_tokens,
                        context_window,
                        cost_usd,
                        is_turn_total,
                        timestamp,
                        ..
                    } = &event
                    {
                        metrics.provider_emitted_usage = true;
                        if let Some(p0) = metrics.pause_started_at.take() {
                            let dt = now.duration_since(p0).as_millis() as u64;
                            metrics.step_pause_ms_total += dt;
                            if metrics.step_item_started_at.is_some() {
                                metrics.step_pause_ms_since_item += dt;
                            }
                            if metrics.step_first_token_at.is_some() {
                                metrics.step_pause_ms_since_token += dt;
                            }
                        }

                        if *input_tokens > 0 {
                            metrics.turn_input_tokens = *input_tokens;
                        }
                        if *cache_read_tokens > 0 {
                            metrics.turn_cache_read_tokens = *cache_read_tokens;
                        }
                        if *cache_write_tokens > 0 {
                            metrics.turn_cache_write_tokens = *cache_write_tokens;
                        }
                        if *context_window > 0 {
                            metrics.turn_context_window = *context_window;
                        }

                        let step_delta_tokens = if *is_turn_total {
                            let delta = output_tokens.saturating_sub(metrics.turn_output_tokens);
                            metrics.turn_output_tokens =
                                metrics.turn_output_tokens.max(*output_tokens);
                            if *cost_usd > 0.0 {
                                metrics.turn_cost_usd = *cost_usd;
                            } else {
                                metrics.turn_cost_usd = pricing::compute_cost_usd(
                                    &sess_prov,
                                    sess_model.as_deref(),
                                    metrics.turn_input_tokens,
                                    metrics.turn_cache_read_tokens,
                                    metrics.turn_cache_write_tokens,
                                    metrics.turn_output_tokens,
                                );
                            }
                            delta
                        } else {
                            metrics.turn_output_tokens += *output_tokens;
                            if *cost_usd > 0.0 {
                                metrics.turn_cost_usd += *cost_usd;
                            } else {
                                metrics.turn_cost_usd += pricing::compute_cost_usd(
                                    &sess_prov,
                                    sess_model.as_deref(),
                                    *input_tokens,
                                    *cache_read_tokens,
                                    *cache_write_tokens,
                                    *output_tokens,
                                );
                            }
                            *output_tokens
                        };

                        if step_delta_tokens > 0 {
                            let obs_decode_ms = if let Some(t_item) = metrics.step_item_started_at {
                                Some(
                                    (now.duration_since(t_item).as_millis() as u64)
                                        .saturating_sub(metrics.step_pause_ms_since_item),
                                )
                            } else if let Some(t_tok) = metrics.step_first_token_at {
                                Some(
                                    (now.duration_since(t_tok).as_millis() as u64)
                                        .saturating_sub(metrics.step_pause_ms_since_token),
                                )
                            } else {
                                None
                            };

                            if let Some(dec_ms) = obs_decode_ms {
                                if dec_ms >= 140 {
                                    metrics.turn_tps_tokens += step_delta_tokens;
                                    metrics.turn_tps_decode_ms += dec_ms;
                                }
                            } else if step_delta_tokens >= 180 {
                                let raw_ms = (now
                                    .duration_since(metrics.step_started_at)
                                    .as_millis() as u64)
                                    .saturating_sub(metrics.step_pause_ms_total);
                                let est_ttft_ms = (1_400
                                    + (metrics.turn_input_tokens / 22))
                                    .min((raw_ms * 3) / 10);
                                let dec_ms = raw_ms.saturating_sub(est_ttft_ms).max(250);
                                metrics.turn_tps_tokens += step_delta_tokens;
                                metrics.turn_tps_decode_ms += dec_ms;
                            }
                        }

                        if metrics.turn_tps_tokens > 0 && metrics.turn_tps_decode_ms >= 140 {
                            metrics.last_computed_tps = round_tps(
                                metrics.turn_tps_tokens as f64
                                    / (metrics.turn_tps_decode_ms as f64 / 1000.0),
                            );
                        } else if metrics.last_computed_tps < 0.5 && metrics.turn_output_tokens > 0 {
                            let raw_ms = (now
                                .duration_since(metrics.step_started_at)
                                .as_millis() as u64)
                                .saturating_sub(metrics.step_pause_ms_total);
                            let est_ttft_ms = (1_400 + (metrics.turn_input_tokens / 18))
                                .min((raw_ms * 7) / 10);
                            let dec_ms = raw_ms.saturating_sub(est_ttft_ms).max(200);
                            metrics.last_computed_tps = round_tps(
                                metrics.turn_output_tokens as f64 / (dec_ms as f64 / 1000.0),
                            );
                        }

                        metrics.reset_step_window(now);

                        let norm_usage = AgentEvent::UsageUpdated {
                            session_id,
                            input_tokens: metrics.turn_input_tokens,
                            output_tokens: metrics.turn_output_tokens,
                            total_tokens: metrics
                                .turn_input_tokens
                                .saturating_add(metrics.turn_output_tokens),
                            cache_read_tokens: metrics.turn_cache_read_tokens,
                            cache_write_tokens: metrics.turn_cache_write_tokens,
                            context_window: metrics.turn_context_window,
                            cost_usd: metrics.turn_cost_usd,
                            output_tps: metrics.last_computed_tps,
                            is_turn_total: true,
                            timestamp: *timestamp,
                        };

                        let base_out_snap = metrics.base_session_output_tokens;
                        let base_cost_snap = metrics.base_session_cost_usd;
                        let turn_in_snap = metrics.turn_input_tokens;
                        let turn_out_snap = metrics.turn_output_tokens;
                        let turn_cache_snap = metrics.turn_cache_read_tokens;
                        let turn_ctx_snap = metrics.turn_context_window;
                        let turn_cost_snap = metrics.turn_cost_usd;

                        let hist = guard.event_history.entry(session_id).or_default();
                        upsert_turn_usage_event(hist, norm_usage.clone());
                        db_usage_to_upsert = Some(norm_usage.clone());

                        if let Some(session) = guard.sessions.get_mut(&session_id) {
                            session.updated_at = Utc::now();
                            if turn_in_snap > 0 {
                                session.input_tokens = turn_in_snap;
                            }
                            session.output_tokens = base_out_snap.saturating_add(turn_out_snap);
                            if turn_cache_snap > 0 {
                                session.cache_read_tokens = turn_cache_snap;
                            }
                            if turn_ctx_snap > 0 {
                                session.context_window = turn_ctx_snap;
                            }
                            session.tokens_used = turn_in_snap.saturating_add(turn_out_snap);
                            session.cost_usd = base_cost_snap + turn_cost_snap;
                            should_persist_sessions = true;
                        }

                        outbound_events.push(norm_usage);
                    } else {
                        // Synthesize end-of-turn UsageUpdated for providers (AGY / Cursor / Grok) that didn't emit UsageUpdated
                        if is_terminal_status_event(&event) {
                            let rem_stream_tok = metrics.current_step_stream_tokens();
                            if rem_stream_tok > 0 {
                                if let Some(t0) = metrics.step_first_token_at {
                                    let dec_ms = (now.duration_since(t0).as_millis() as u64)
                                        .saturating_sub(metrics.step_pause_ms_since_token)
                                        .max(120);
                                    metrics.turn_est_tokens += rem_stream_tok;
                                    metrics.turn_est_decode_ms += dec_ms;
                                }
                            }
                            if !metrics.provider_emitted_usage && metrics.turn_est_tokens > 0 {
                                let final_tps = if metrics.turn_est_decode_ms >= 140 {
                                    round_tps(
                                        metrics.turn_est_tokens as f64
                                            / (metrics.turn_est_decode_ms as f64 / 1000.0),
                                    )
                                } else {
                                    metrics.last_computed_tps
                                };
                                let synth_cost = pricing::compute_cost_usd(
                                    &sess_prov,
                                    sess_model.as_deref(),
                                    metrics.turn_input_tokens,
                                    metrics.turn_cache_read_tokens,
                                    metrics.turn_cache_write_tokens,
                                    metrics.turn_est_tokens,
                                );
                                let synth_usage = AgentEvent::UsageUpdated {
                                    session_id,
                                    input_tokens: metrics.turn_input_tokens,
                                    output_tokens: metrics.turn_est_tokens,
                                    total_tokens: metrics
                                        .turn_input_tokens
                                        .saturating_add(metrics.turn_est_tokens),
                                    cache_read_tokens: metrics.turn_cache_read_tokens,
                                    cache_write_tokens: metrics.turn_cache_write_tokens,
                                    context_window: metrics.turn_context_window,
                                    cost_usd: synth_cost,
                                    output_tps: final_tps,
                                    is_turn_total: true,
                                    timestamp: Utc::now(),
                                };
                                let base_out_snap = metrics.base_session_output_tokens;
                                let base_cost_snap = metrics.base_session_cost_usd;
                                let est_out_snap = metrics.turn_est_tokens;
                                let hist = guard.event_history.entry(session_id).or_default();
                                upsert_turn_usage_event(hist, synth_usage.clone());
                                db_usage_to_upsert = Some(synth_usage.clone());
                                if let Some(session) = guard.sessions.get_mut(&session_id) {
                                    session.output_tokens =
                                        base_out_snap.saturating_add(est_out_snap);
                                    session.cost_usd = base_cost_snap + synth_cost;
                                }
                                outbound_events.push(synth_usage);
                                should_persist_sessions = true;
                            }
                            guard.live_turns.remove(&session_id);
                        }

                        if let AgentEvent::RateLimitsUpdated {
                            provider, windows, ..
                        } = &event
                        {
                            guard
                                .quota_cache
                                .by_provider
                                .insert(provider.clone(), windows.clone());
                            quota::save_quota_cache(&state.quota_cache_file, &guard.quota_cache);
                        }

                        if !matches!(
                            event,
                            AgentEvent::UserMessage { .. }
                                | AgentEvent::ProviderSessionBound { .. }
                                | AgentEvent::ThinkingChunk { .. }
                                | AgentEvent::MessageChunk { .. }
                                | AgentEvent::TerminalOutput { .. }
                                | AgentEvent::RateLimitsUpdated { .. }
                        ) {
                            guard
                                .event_history
                                .entry(session_id)
                                .or_default()
                                .push(event.clone());
                            db_event_to_append = Some(event.clone());
                        }

                        let g = &mut *guard;
                        let p_cfg = g.push_config.clone();
                        if let Some(session) = g.sessions.get_mut(&session_id) {
                            session.updated_at = Utc::now();
                            let s_prov_snap = session.provider.clone();
                            let s_model_snap = session.model.clone();
                            let s_effort_snap = session.effort.clone();
                            let s_appr_snap = session.approval_mode.clone();
                            match &event {
                                AgentEvent::StatusChanged {
                                    status, message, ..
                                } => {
                                    session.status = *status;
                                    should_refresh_diff = true;
                                    should_persist_sessions = true;
                                    if *status == SessionStatus::Completed {
                                        if let Some(active_h) = g.handles.remove(&session_id) {
                                            g.warm_handles.insert(
                                                session_id,
                                                WarmAgentEntry {
                                                    handle: active_h,
                                                    provider: s_prov_snap,
                                                    model: s_model_snap,
                                                    effort: s_effort_snap,
                                                    approval_mode: s_appr_snap,
                                                },
                                            );
                                        }
                                    } else if matches!(
                                        status,
                                        SessionStatus::Failed | SessionStatus::Stopped
                                    ) {
                                        g.handles.remove(&session_id);
                                        if let Some(mut wh) = g.warm_handles.remove(&session_id) {
                                            wh.handle.stop();
                                        }
                                    }
                                    if matches!(
                                        status,
                                        SessionStatus::Completed | SessionStatus::Failed
                                    ) && !session.queued_prompts.is_empty()
                                    {
                                        next_queued_job = Some(session.queued_prompts.remove(0));
                                    }
                                    if p_cfg.enabled && next_queued_job.is_none() {
                                        match status {
                                            SessionStatus::Completed => {
                                                push_notification_job = Some((
                                                    p_cfg,
                                                    push::PushTriggerKind::TurnCompleted,
                                                    session.clone(),
                                                    message.clone(),
                                                ));
                                            }
                                            SessionStatus::Failed => {
                                                push_notification_job = Some((
                                                    p_cfg,
                                                    push::PushTriggerKind::TurnFailed,
                                                    session.clone(),
                                                    message.clone(),
                                                ));
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                AgentEvent::PermissionRequested { description, .. } => {
                                    if p_cfg.enabled {
                                        push_notification_job = Some((
                                            p_cfg,
                                            push::PushTriggerKind::PermissionRequired,
                                            session.clone(),
                                            Some(description.clone()),
                                        ));
                                    }
                                }
                                AgentEvent::UserQuestionRequested { question, .. } => {
                                    if p_cfg.enabled {
                                        push_notification_job = Some((
                                            p_cfg,
                                            push::PushTriggerKind::QuestionRequired,
                                            session.clone(),
                                            Some(question.clone()),
                                        ));
                                    }
                                }
                                AgentEvent::ProviderSessionBound {
                                    provider_session_id,
                                    ..
                                } => {
                                    session.provider_session_id =
                                        Some(provider_session_id.clone());
                                    should_persist_sessions = true;
                                }
                                AgentEvent::ToolCallCompleted { .. } => {
                                    should_refresh_diff = true;
                                }
                                AgentEvent::DiffUpdated { stats, .. } => {
                                    session.diff_stats = stats.clone();
                                    should_persist_sessions = true;
                                }
                                _ => {}
                            }
                        }

                        if outbound_events.is_empty()
                            || !matches!(
                                outbound_events.first(),
                                Some(AgentEvent::ThinkingChunk { .. } | AgentEvent::MessageChunk { .. })
                            )
                        {
                            outbound_events.push(event);
                        }
                    }
                }

                for out_ev in outbound_events {
                    let _ = state.event_tx.send(out_ev);
                }

                if let Some(u_ev) = db_usage_to_upsert {
                    let _ = state.db.upsert_turn_usage_event(session_id, &u_ev);
                }
                if let Some(a_ev) = db_event_to_append {
                    let _ = state.db.append_event(session_id, &a_ev);
                }
                if let Some((cfg, kind, sess, detail)) = push_notification_job {
                    tokio::spawn(async move {
                        let _ = push::send_push_notification(
                            &cfg,
                            kind,
                            Some(&sess),
                            detail.as_deref(),
                        )
                        .await;
                    });
                }

                if should_refresh_diff {
                    let wt_path = {
                        let guard = state.inner.read().await;
                        guard
                            .sessions
                            .get(&session_id)
                            .map(|s| PathBuf::from(&s.worktree_path))
                    };
                    if let Some(path) = wt_path {
                        if let Ok(stats) = WorktreeManager::compute_diff_stats(&path).await {
                            let mut guard = state.inner.write().await;
                            if let Some(s) = guard.sessions.get_mut(&session_id) {
                                s.diff_stats = stats;
                            }
                        }
                    }
                    should_persist_sessions = true;
                }

                if should_persist_sessions {
                    let _ = state.persist_sessions().await;
                }

                if let Some(queued_item) = next_queued_job {
                    let st_next = state.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(140)).await;
                        let _ = st_next
                            .dispatch_session_input(
                                session_id,
                                SessionInputRequest {
                                    input: queued_item.input,
                                    model: queued_item.model,
                                    effort: queued_item.effort,
                                    provider: None,
                                    reset_thread: false,
                                    truncate_to_user_turn: None,
                                    images: queued_item.images,
                                    approval_mode: None,
                                    mode: None,
                                },
                            )
                            .await;
                    });
                }
            }
        });
    }

    pub async fn persist_session_events(&self, session_id: Uuid) -> Result<()> {
        let evs = {
            let guard = self.inner.read().await;
            guard.event_history.get(&session_id).cloned()
        };
        if let Some(list) = evs {
            self.db.replace_session_events(session_id, &list)?;
        }
        Ok(())
    }

    pub async fn persist_sessions(&self) -> Result<()> {
        let list: Vec<SessionInfo> = {
            let guard = self.inner.read().await;
            let mut v: Vec<SessionInfo> = guard.sessions.values().cloned().collect();
            v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            v
        };
        self.db.upsert_sessions_batch(&list)?;
        let _ = self.snapshot_tx.send(list);
        Ok(())
    }

    pub async fn persist_automations(&self) -> Result<()> {
        let list = {
            let guard = self.inner.read().await;
            guard.automations.clone()
        };
        let json_str = serde_json::to_string_pretty(&list)?;
        tokio::fs::write(&self.automations_file, json_str).await?;
        Ok(())
    }

    pub async fn persist_repo_hooks(&self) -> Result<()> {
        let map = {
            let guard = self.inner.read().await;
            guard.repo_hooks.clone()
        };
        let json_str = serde_json::to_string_pretty(&map)?;
        tokio::fs::write(&self.hooks_file, json_str).await?;
        Ok(())
    }

    pub async fn persist_workspaces(&self) -> Result<()> {
        let list = {
            let guard = self.inner.read().await;
            guard.workspaces.clone()
        };
        let json_str = serde_json::to_string_pretty(&list)?;
        tokio::fs::write(&self.workspaces_file, json_str).await?;
        Ok(())
    }

    pub async fn list_workspaces(&self) -> Vec<String> {
        let guard = self.inner.read().await;
        let mut out = guard.workspaces.clone();
        for s in guard.sessions.values() {
            let clean = canonical_workspace_path(&s.repo_root);
            if !clean.is_empty() && !out.contains(&clean) {
                out.push(clean);
            }
        }
        out
    }

    pub async fn add_workspace(&self, raw_path: &str) -> Vec<String> {
        self.add_workspace_with_options(raw_path, false).await
    }

    pub async fn add_workspace_with_options(&self, raw_path: &str, init_git: bool) -> Vec<String> {
        let clean = canonical_workspace_path(raw_path);
        let resolved = velo_worktree::ensure_usable_workspace_dir(Path::new(&clean)).await;
        if init_git && !resolved.join(".git").exists() {
            let init_main = Command::new("git")
                .args(["init", "-b", "main"])
                .current_dir(&resolved)
                .status()
                .await;
            if !matches!(init_main, Ok(s) if s.success()) {
                let _ = Command::new("git")
                    .arg("init")
                    .current_dir(&resolved)
                    .status()
                    .await;
            }
        }
        {
            let mut guard = self.inner.write().await;
            if !clean.is_empty() && !guard.workspaces.contains(&clean) {
                guard.workspaces.push(clean);
            }
        }
        let _ = self.persist_workspaces().await;
        self.list_workspaces().await
    }

    pub async fn remove_workspace(&self, raw_path: &str, delete_sessions: bool) -> Vec<String> {
        let clean = canonical_workspace_path(raw_path);
        let matching_sids: Vec<Uuid> = {
            let mut guard = self.inner.write().await;
            guard.workspaces.retain(|w| canonical_workspace_path(w) != clean);
            if delete_sessions {
                guard
                    .sessions
                    .values()
                    .filter(|s| canonical_workspace_path(&s.repo_root) == clean)
                    .map(|s| s.id)
                    .collect()
            } else {
                Vec::new()
            }
        };
        for sid in matching_sids {
            let _ = self.delete_session_by_id(sid, true).await;
        }
        let _ = self.persist_workspaces().await;
        let _ = self.persist_sessions().await;
        self.list_workspaces().await
    }

    pub async fn relocate_workspace(&self, old_raw: &str, new_raw: &str) -> Vec<String> {
        let old_clean = canonical_workspace_path(old_raw);
        let new_clean = canonical_workspace_path(new_raw);
        if new_clean.is_empty() || old_clean == new_clean {
            return self.list_workspaces().await;
        }
        let _ = velo_worktree::ensure_usable_workspace_dir(Path::new(&new_clean)).await;
        {
            let mut guard = self.inner.write().await;
            let mut replaced = false;
            let mut deduped = Vec::new();
            for w in &guard.workspaces {
                let cw = canonical_workspace_path(w);
                if cw == old_clean {
                    if !deduped.contains(&new_clean) {
                        deduped.push(new_clean.clone());
                    }
                    replaced = true;
                } else if !deduped.contains(&cw) {
                    deduped.push(cw);
                }
            }
            if !replaced && !deduped.contains(&new_clean) {
                deduped.push(new_clean.clone());
            }
            guard.workspaces = deduped;

            for s in guard.sessions.values_mut() {
                if canonical_workspace_path(&s.repo_root) == old_clean {
                    let was_main_dir = canonical_workspace_path(&s.worktree_path) == old_clean;
                    s.repo_root = new_clean.clone();
                    if was_main_dir {
                        s.worktree_path = new_clean.clone();
                    }
                    s.updated_at = Utc::now();
                }
            }
        }
        let _ = self.persist_workspaces().await;
        let _ = self.persist_sessions().await;
        self.list_workspaces().await
    }

    pub async fn await_permission_gate(
        &self,
        session_id: Uuid,
        tool_name: &str,
        command_preview: Option<String>,
        description: &str,
    ) -> String {
        let request_id = format!("perm-{}", Uuid::new_v4());
        let (tx, rx) = oneshot::channel::<String>();
        {
            let mut guard = self.inner.write().await;
            guard.pending_approvals.insert(request_id.clone(), tx);
            if let Some(s) = guard.sessions.get_mut(&session_id) {
                s.status = SessionStatus::WaitingForPermission;
                s.updated_at = Utc::now();
            }
        }
        let _ = self.agent_event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: SessionStatus::WaitingForPermission,
            message: Some(format!("Waiting for approval: {}", tool_name)),
            timestamp: Utc::now(),
        });
        let _ = self.agent_event_tx.send(AgentEvent::PermissionRequested {
            session_id,
            request_id: request_id.clone(),
            tool_name: tool_name.to_string(),
            description: description.to_string(),
            command_preview,
            timestamp: Utc::now(),
        });

        let decision = match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
            Ok(Ok(d)) => d,
            _ => {
                let mut guard = self.inner.write().await;
                guard.pending_approvals.remove(&request_id);
                "deny".to_string()
            }
        };
        decision
    }

    pub async fn resolve_permission(&self, session_id: Uuid, request_id: &str, decision: &str) -> bool {
        let tx = {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&session_id) {
                if decision == "always" {
                    s.approval_mode = "auto_edit".to_string();
                }
                s.status = SessionStatus::Running;
                s.updated_at = Utc::now();
            }
            guard.pending_approvals.remove(request_id)
        };
        let _ = self.persist_sessions().await;
        let _ = self.agent_event_tx.send(AgentEvent::PermissionResolved {
            session_id,
            request_id: request_id.to_string(),
            decision: decision.to_string(),
            timestamp: Utc::now(),
        });
        let _ = self.agent_event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: SessionStatus::Running,
            message: Some(format!("Permission {}", decision)),
            timestamp: Utc::now(),
        });
        if let Some(sender) = tx {
            let _ = sender.send(decision.to_string());
            true
        } else {
            false
        }
    }

    pub async fn await_user_question(
        &self,
        session_id: Uuid,
        question: String,
        options: Vec<String>,
        allow_multiple: bool,
    ) -> Vec<String> {
        let question_id = format!("ask-{}", Uuid::new_v4());
        let (tx, rx) = oneshot::channel::<Vec<String>>();
        {
            let mut guard = self.inner.write().await;
            guard.pending_questions.insert(question_id.clone(), tx);
            if let Some(s) = guard.sessions.get_mut(&session_id) {
                s.status = SessionStatus::WaitingForPermission;
                s.updated_at = Utc::now();
            }
        }
        let _ = self.agent_event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: SessionStatus::WaitingForPermission,
            message: Some("Waiting for user answer".to_string()),
            timestamp: Utc::now(),
        });
        let _ = self.agent_event_tx.send(AgentEvent::UserQuestionRequested {
            session_id,
            question_id: question_id.clone(),
            question,
            options,
            allow_multiple,
            timestamp: Utc::now(),
        });

        match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
            Ok(Ok(ans)) => ans,
            _ => {
                let mut guard = self.inner.write().await;
                guard.pending_questions.remove(&question_id);
                vec!["(No response — timed out)".to_string()]
            }
        }
    }

    pub async fn resolve_question(
        &self,
        session_id: Uuid,
        question_id: &str,
        answers: Vec<String>,
    ) -> bool {
        let tx = {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&session_id) {
                s.status = SessionStatus::Running;
                s.updated_at = Utc::now();
            }
            guard.pending_questions.remove(question_id)
        };
        let _ = self.agent_event_tx.send(AgentEvent::UserQuestionAnswered {
            session_id,
            question_id: question_id.to_string(),
            answers: answers.clone(),
            timestamp: Utc::now(),
        });
        let _ = self.agent_event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: SessionStatus::Running,
            message: Some("User answered question".to_string()),
            timestamp: Utc::now(),
        });
        if let Some(sender) = tx {
            let _ = sender.send(answers);
            true
        } else {
            false
        }
    }

    async fn mark_session_spawn_failed(&self, id: Uuid, err_msg: &str) {
        {
            let mut guard = self.inner.write().await;
            if let Some(session) = guard.sessions.get_mut(&id) {
                session.status = SessionStatus::Failed;
                session.pid = None;
                session.updated_at = Utc::now();
            }
        }
        let _ = self.persist_sessions().await;
        let _ = self.agent_event_tx.send(AgentEvent::Error {
            session_id: id,
            error: err_msg.to_string(),
            timestamp: Utc::now(),
        });
        let _ = self.agent_event_tx.send(AgentEvent::StatusChanged {
            session_id: id,
            status: SessionStatus::Failed,
            message: Some(err_msg.to_string()),
            timestamp: Utc::now(),
        });
    }

    pub async fn stop_session_by_id(&self, id: Uuid) {
        let (old_handle, orphan_pid) = {
            let mut guard = self.inner.write().await;
            let h = guard.handles.remove(&id);
            let mut pid = None;
            if let Some(session) = guard.sessions.get_mut(&id) {
                pid = session.pid.take();
                session.status = SessionStatus::Stopped;
                session.updated_at = Utc::now();
            }
            (h, pid)
        };

        if let Some(mut handle) = old_handle {
            handle.stop();
        } else if let Some(p) = orphan_pid {
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .args(["-9", &format!("-{}", p)])
                    .status()
                    .await;
            }
        }

        let _ = self.persist_sessions().await;
        let _ = self.agent_event_tx.send(AgentEvent::StatusChanged {
            session_id: id,
            status: SessionStatus::Stopped,
            message: Some("Session stopped by user".to_string()),
            timestamp: Utc::now(),
        });
    }

    fn spawn_cron_scheduler(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut last_minute_key = String::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                let now = Utc::now();
                let key = now.format("%Y-%m-%d %H:%M").to_string();
                if key == last_minute_key {
                    continue;
                }
                last_minute_key = key;

                let due_ids: Vec<Uuid> = {
                    let guard = state.inner.read().await;
                    guard
                        .automations
                        .iter()
                        .filter(|r| {
                            r.enabled
                                && r.trigger_type == "cron"
                                && r.cron_expr
                                    .as_deref()
                                    .map(|c| automations::matches_cron_minute(c, &now))
                                    .unwrap_or(false)
                        })
                        .map(|r| r.id)
                        .collect()
                };

                for rule_id in due_ids {
                    let _ = state.trigger_automation_rule(rule_id, "cron", &json!({})).await;
                }
            }
        });
    }

    pub async fn trigger_automation_rule(
        &self,
        rule_id: Uuid,
        event_name: &str,
        payload: &Value,
    ) -> Result<SessionInfo> {
        let rule = {
            let guard = self.inner.read().await;
            guard
                .automations
                .iter()
                .find(|r| r.id == rule_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Automation rule not found"))?
        };

        let rendered_prompt =
            automations::render_webhook_prompt(&rule.prompt_template, event_name, payload);
        let stamp = Utc::now().format("%m%d-%H%M%S").to_string();
        let branch = format!("{}-{}", rule.branch_prefix.trim_end_matches('/'), stamp);
        let sess = self
            .create_session(CreateSessionRequest {
                name: Some(format!("{}-{}", rule.name, stamp)),
                provider: rule.provider.clone(),
                prompt: rendered_prompt,
                repo_path: rule.repo_path.clone(),
                branch: Some(branch),
                use_pty: false,
                parent_session_id: None,
                model: rule.model.clone(),
                effort: None,
                images: Vec::new(),
                approval_mode: Some("auto_edit".to_string()),
                setup_command: None,
                use_worktree: true,
            })
            .await?;

        {
            let mut guard = self.inner.write().await;
            if let Some(r) = guard.automations.iter_mut().find(|r| r.id == rule_id) {
                r.last_run_at = Some(Utc::now());
                r.last_session_id = Some(sess.id);
                r.run_count += 1;
            }
        }
        let _ = self.persist_automations().await;
        Ok(sess)
    }

    pub async fn create_session(&self, req: CreateSessionRequest) -> Result<SessionInfo> {
        let session_id = Uuid::new_v4();
        let repo_path = PathBuf::from(&req.repo_path);

        let provision = if req.use_worktree {
            self.worktree_mgr
                .provision_worktree(&repo_path, session_id, req.branch.as_deref())
                .await?
        } else {
            WorktreeManager::resolve_in_place_workspace(&repo_path).await
        };

        // Run per-repo setup hook or `.velo/setup.sh` if isolated worktree was provisioned
        let configured_hook = if req.setup_command.is_some() {
            req.setup_command.clone()
        } else {
            let guard = self.inner.read().await;
            guard
                .repo_hooks
                .get(&provision.repo_root.to_string_lossy().to_string())
                .cloned()
        };

        let hook_outcome = if provision.is_isolated_worktree {
            WorktreeManager::run_setup_hook(
                &provision.repo_root,
                &provision.worktree_path,
                &provision.branch,
                configured_hook.as_deref(),
            )
            .await
        } else {
            None
        };

        let sess = self
            .spawn_in_existing_worktree_with_mode(
                session_id,
                req.name,
                req.provider,
                req.prompt,
                provision.repo_root,
                provision.worktree_path,
                provision.branch,
                req.use_pty,
                req.parent_session_id,
                req.model,
                req.effort,
                req.images,
                req.approval_mode.unwrap_or_else(default_approval_mode),
            )
            .await?;

        if let Some(hook_res) = hook_outcome {
            let _ = self.agent_event_tx.send(AgentEvent::SetupHookOutput {
                session_id: sess.id,
                command: hook_res.command,
                output: hook_res.output,
                exit_code: hook_res.exit_code,
                timestamp: Utc::now(),
            });
        }

        Ok(sess)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_in_existing_worktree(
        &self,
        session_id: Uuid,
        custom_name: Option<String>,
        provider: AgentProvider,
        prompt: String,
        repo_root: PathBuf,
        worktree_path: PathBuf,
        branch: String,
        use_pty: bool,
        parent_session_id: Option<Uuid>,
        model: Option<String>,
        effort: Option<String>,
        images: Vec<String>,
    ) -> Result<SessionInfo> {
        self.spawn_in_existing_worktree_with_mode(
            session_id,
            custom_name,
            provider,
            prompt,
            repo_root,
            worktree_path,
            branch,
            use_pty,
            parent_session_id,
            model,
            effort,
            images,
            default_approval_mode(),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_in_existing_worktree_with_mode(
        &self,
        session_id: Uuid,
        custom_name: Option<String>,
        provider: AgentProvider,
        prompt: String,
        repo_root: PathBuf,
        worktree_path: PathBuf,
        branch: String,
        use_pty: bool,
        parent_session_id: Option<Uuid>,
        model: Option<String>,
        effort: Option<String>,
        images: Vec<String>,
        approval_mode: String,
    ) -> Result<SessionInfo> {
        let worktree_path = velo_worktree::ensure_usable_workspace_dir(&worktree_path).await;
        let repo_root = if tokio::fs::metadata(&repo_root)
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false)
        {
            repo_root
        } else {
            worktree_path.clone()
        };

        let short_id = &session_id.to_string()[..8];
        let name = custom_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("{}-{}", provider, short_id));

        let diff_stats = WorktreeManager::compute_diff_stats(&worktree_path)
            .await
            .unwrap_or_default();

        let now = Utc::now();
        let canonical_repo = canonical_workspace_path(&repo_root.to_string_lossy());
        let canonical_wt = canonical_workspace_path(&worktree_path.to_string_lossy());
        let mut session = SessionInfo {
            id: session_id,
            name,
            provider: provider.clone(),
            prompt: prompt.clone(),
            repo_root: canonical_repo.clone(),
            worktree_path: canonical_wt,
            branch,
            status: SessionStatus::Starting,
            pid: None,
            diff_stats,
            created_at: now,
            updated_at: now,
            parent_session_id,
            provider_session_id: None,
            model: model.clone(),
            effort: effort.clone(),
            tokens_used: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            context_window: 0,
            cost_usd: 0.0,
            approval_mode: approval_mode.clone(),
            preview_url: None,
            queued_prompts: Vec::new(),
            archived: false,
        };

        let initial_user_ev = if !prompt.trim().is_empty() || !images.is_empty() {
            Some(AgentEvent::UserMessage {
                session_id,
                text: prompt.clone(),
                images: images.clone(),
                timestamp: now,
            })
        } else {
            None
        };

        let mut ws_added = false;
        {
            let mut guard = self.inner.write().await;
            if !canonical_repo.is_empty() && !guard.workspaces.contains(&canonical_repo) {
                guard.workspaces.insert(0, canonical_repo);
                ws_added = true;
            }
            guard.sessions.insert(session_id, session.clone());
            guard
                .live_turns
                .insert(session_id, LiveTurnMetrics::new(0, 0.0));
            if let Some(ref uev) = initial_user_ev {
                guard
                    .event_history
                    .entry(session_id)
                    .or_default()
                    .push(uev.clone());
            }
        }
        if ws_added {
            let _ = self.persist_workspaces().await;
        }
        let _ = self.db.upsert_session(&session);
        if let Some(uev) = initial_user_ev {
            let _ = self.db.append_event(session_id, &uev);
            let _ = self.event_tx.send(uev);
        }

        // If the user created an empty worktree thread (e.g. via New Thread / Advanced Worktree)
        // without typing an initial prompt yet, prepare the isolated worktree in an idle state
        // without wasting tokens on a fake prompt.
        if prompt.trim().is_empty() && images.is_empty() && !use_pty {
            session.status = SessionStatus::Completed;
            {
                let mut guard = self.inner.write().await;
                guard.live_turns.remove(&session_id);
                if let Some(s) = guard.sessions.get_mut(&session_id) {
                    s.status = SessionStatus::Completed;
                }
            }
            self.persist_sessions().await?;
            return Ok(session);
        }

        {
            let cp_wt = worktree_path.clone();
            let cp_prompt = prompt.clone();
            let _ = tokio::task::spawn_blocking(move || {
                checkpoints::capture_turn_checkpoint(session_id, &cp_wt, &cp_prompt)
            })
            .await;
        }

        let (spawn_model, spawn_effort) =
            resolve_cli_model_for_spawn(&provider, model, effort).await;
        let handle = match AgentSpawner::spawn_agent_turn_configured(
            session_id,
            provider,
            prompt,
            worktree_path,
            use_pty,
            spawn_model,
            spawn_effort,
            None,
            images,
            approval_mode,
            self.daemon_http_base.clone(),
            self.agent_event_tx.clone(),
        )
        .await
        {
            Ok(h) => h,
            Err(err) => {
                self.mark_session_spawn_failed(session_id, &err.to_string())
                    .await;
                return Err(err);
            }
        };

        session.pid = handle.pid;
        session.status = SessionStatus::Running;

        {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&session_id) {
                s.pid = handle.pid;
                s.status = SessionStatus::Running;
            }
            guard.handles.insert(session_id, handle);
        }

        self.persist_sessions().await?;
        Ok(session)
    }
}

async fn cors_middleware(req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        add_cors_headers(&mut res);
        return res;
    }
    let mut res = next.run(req).await;
    add_cors_headers(&mut res);
    res
}

fn add_cors_headers(res: &mut Response) {
    let headers = res.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type, Authorization"),
    );
}

pub fn build_router(state: DaemonState) -> Router {
    Router::new()
        .route("/", get(ui_index_handler))
        .route("/assets/{file}", get(ui_asset_handler))
        .route("/api/health", get(health_handler))
        .route("/api/runtimes", get(list_runtimes_handler))
        .route("/api/models", get(list_models_handler))
        .route("/api/pair", get(pair_ticket_handler))
        .route("/api/relay/status", get(relay_status_handler))
        .route("/api/relay/rotate", post(rotate_relay_handler))
        .route(
            "/api/system/service",
            get(get_system_service_handler).post(update_system_service_handler),
        )
        .route(
            "/api/providers/{provider}/login",
            post(provider_cli_login_handler),
        )
        .route("/api/pick-folder", post(pick_folder_handler))
        .route(
            "/api/workspaces",
            get(list_workspaces_handler)
                .post(add_workspace_handler)
                .patch(relocate_workspace_handler)
                .delete(remove_workspace_handler),
        )
        .route("/api/open-editor", post(open_editor_handler))
        .route("/api/worktrees/prune", post(prune_worktrees_handler))
        .route("/api/attachments", post(upload_attachment_handler))
        .route("/api/attachments/{file}", get(get_attachment_handler))
        .route("/api/attachments-resolve", get(resolve_attachment_handler))
        .route("/api/search", get(global_search_handler))
        .route("/api/analytics/usage", get(usage_analytics_handler))
        .route("/api/analytics/quotas", get(quotas_analytics_handler))
        .route(
            "/api/hosts",
            get(list_hosts_handler).post(add_host_handler),
        )
        .route(
            "/api/hosts/{id}",
            axum::routing::delete(remove_host_handler),
        )
        .route("/api/hosts/{id}/probe", post(probe_host_handler))
        .route("/api/hosts/{id}/dispatch", post(dispatch_ssh_host_handler))
        .route("/api/sessions/{id}/archive", post(archive_session_handler))
        .route("/api/sessions/{id}/fork", post(fork_session_handler))
        .route(
            "/api/push/config",
            get(get_push_config_handler).post(set_push_config_handler),
        )
        .route("/api/push/test", post(test_push_handler))
        .route(
            "/api/sessions",
            get(list_sessions_handler).post(create_session_handler),
        )
        .route(
            "/api/sessions/{id}",
            get(get_session_handler)
                .delete(delete_session_handler)
                .patch(update_session_handler),
        )
        .route("/api/sessions/{id}/events", get(get_session_events_handler))
        .route("/api/sessions/{id}/diff", get(get_session_diff_handler))
        .route("/api/sessions/{id}/files", get(list_worktree_files_handler))
        .route("/api/sessions/{id}/exec", post(exec_in_worktree_handler))
        .route(
            "/api/sessions/{id}/terminal/start",
            post(terminal_start_handler),
        )
        .route(
            "/api/sessions/{id}/terminal/input",
            post(terminal_input_handler),
        )
        .route(
            "/api/sessions/{id}/terminal/resize",
            post(terminal_resize_handler),
        )
        .route(
            "/api/sessions/{id}/terminal/restart",
            post(terminal_restart_handler),
        )
        .route("/api/sessions/{id}/input", post(send_input_handler))
        .route(
            "/api/sessions/{id}/queue/{queue_id}",
            axum::routing::delete(remove_queued_prompt_handler),
        )
        .route("/api/cli-sessions", get(list_cli_sessions_handler))
        .route("/api/cli-sessions/import", post(import_cli_session_handler))
        .route("/api/cli-sessions/manage", post(manage_cli_sessions_handler))
        .route("/api/sessions/{id}/checkpoints", get(list_checkpoints_handler))
        .route(
            "/api/sessions/{id}/checkpoints/rewind",
            post(rewind_checkpoint_handler),
        )
        .route("/api/extensions", get(list_extensions_handler))
        .route("/api/sessions/{id}/rewind", post(rewind_session_handler))
        .route("/api/sessions/{id}/stop", post(stop_session_handler))
        .route("/api/sessions/{id}/git/commit", post(git_commit_handler))
        .route("/api/sessions/{id}/git/discard", post(git_discard_handler))
        .route("/api/sessions/{id}/git/merge", post(git_merge_handler))
        .route("/api/sessions/{id}/handoff", post(handoff_session_handler))
        .route("/api/sessions/{id}/advisor", post(advisor_session_handler))
        .route(
            "/api/sessions/{id}/hooks/pre-tool-use",
            post(pre_tool_use_hook_handler),
        )
        .route(
            "/api/sessions/{id}/approvals/{request_id}",
            post(resolve_approval_handler),
        )
        .route(
            "/api/sessions/{id}/questions/{question_id}",
            post(answer_question_handler),
        )
        .route("/api/sessions/{id}/pr", get(get_pr_handler))
        .route("/api/sessions/{id}/pr/create", post(create_pr_handler))
        .route("/api/sessions/{id}/pr/merge", post(merge_pr_handler))
        .route("/api/sessions/{id}/pr/checks", get(get_pr_checks_handler))
        .route(
            "/api/hooks",
            get(list_repo_hooks_handler).post(set_repo_hook_handler),
        )
        .route("/api/browser/inspect", post(browser_inspect_handler))
        .route("/api/transcribe", post(transcribe_audio_handler))
        .route(
            "/api/automations",
            get(list_automations_handler).post(create_automation_handler),
        )
        .route(
            "/api/automations/{id}",
            axum::routing::patch(update_automation_handler).delete(delete_automation_handler),
        )
        .route(
            "/api/automations/{id}/trigger",
            post(trigger_automation_handler),
        )
        .route(
            "/api/webhooks/github/{id}",
            post(github_webhook_handler),
        )
        .route(
            "/api/webhooks/trigger/{id}",
            post(generic_webhook_handler),
        )
        .route("/api/committee", post(committee_handler))
        .route("/api/loop", post(loop_handler))
        .route(
            "/mcp",
            post(mcp_jsonrpc_handler).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
        )
        .route("/ws", get(ws_handler))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(middleware::from_fn(cors_middleware))
        .with_state(state)
}

pub async fn run_daemon_server(addr: SocketAddr) -> Result<()> {
    let state = DaemonState::new().await?;
    service::autostart_service_assertions().await;
    relay_bridge::autostart_background_e2ee_bridge(state.clone());
    let app = build_router(state);

    info!("Velo daemon listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health_handler() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": "velo-daemon",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Debug, Clone)]
struct GroupedCliModel {
    id: String,
    label: String,
    short_label: String,
    supported_efforts: Vec<String>,
    default_effort: Option<String>,
    /// For engines like Cursor that encode reasoning effort inside `--model`, maps normalized effort -> exact CLI slug
    effort_slugs: HashMap<String, String>,
}

const CANONICAL_EFFORT_ORDER: [&str; 7] = [
    "none", "low", "medium", "high", "xhigh", "max", "ultra",
];

fn sort_and_pick_default_effort(efforts: &mut Vec<String>) -> Option<String> {
    efforts.sort_by_key(|e| {
        CANONICAL_EFFORT_ORDER
            .iter()
            .position(|c| *c == e.as_str())
            .unwrap_or(99)
    });
    efforts.dedup();
    if efforts.is_empty() {
        return None;
    }
    for pref in ["high", "medium", "low", "xhigh", "max", "none"] {
        if efforts.iter().any(|e| e == pref) {
            return Some(pref.to_string());
        }
    }
    efforts.first().cloned()
}

fn clean_effort_words_from_label(raw: &str) -> String {
    let mut s = raw
        .replace("(Extra High)", "")
        .replace("(XHigh)", "")
        .replace("(Medium)", "")
        .replace("(High)", "")
        .replace("(Low)", "")
        .replace("(Max)", "")
        .replace("(None)", "")
        .replace(" Extra High", "")
        .replace(" XHigh", "");
    let tokens: Vec<&str> = s
        .split_whitespace()
        .filter(|tok| {
            !matches!(
                *tok,
                "Low" | "Medium" | "High" | "Max" | "None" | "XHigh"
            )
        })
        .collect();
    s = tokens.join(" ").trim().to_string();
    if s.is_empty() {
        raw.trim().to_string()
    } else {
        s
    }
}

fn split_cursor_slug_effort(slug: &str) -> (String, Option<String>) {
    // Handle `<base>-<effort>-thinking` (e.g. `claude-4.6-opus-high-thinking` -> `claude-4.6-opus-thinking`, Some("high"))
    if let Some(prefix) = slug.strip_suffix("-thinking") {
        for (suf, norm) in [
            ("-extra-high", "xhigh"),
            ("-xhigh", "xhigh"),
            ("-medium", "medium"),
            ("-high", "high"),
            ("-low", "low"),
            ("-max", "max"),
            ("-none", "none"),
        ] {
            if let Some(base) = prefix.strip_suffix(suf) {
                if !base.is_empty() {
                    return (format!("{base}-thinking"), Some(norm.to_string()));
                }
            }
        }
    }
    for (suf, norm) in [
        ("-extra-high", "xhigh"),
        ("-xhigh", "xhigh"),
        ("-medium", "medium"),
        ("-high", "high"),
        ("-low", "low"),
        ("-max", "max"),
        ("-none", "none"),
    ] {
        if let Some(base) = slug.strip_suffix(suf) {
            if !base.is_empty() {
                return (base.to_string(), Some(norm.to_string()));
            }
        }
    }
    (slug.to_string(), None)
}

static AGY_MODELS_CACHE: std::sync::OnceLock<tokio::sync::RwLock<Option<Vec<GroupedCliModel>>>> =
    std::sync::OnceLock::new();
static AGY_MODELS_FETCHING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

static CURSOR_MODELS_CACHE: std::sync::OnceLock<
    tokio::sync::RwLock<Option<Vec<GroupedCliModel>>>,
> = std::sync::OnceLock::new();
static CURSOR_MODELS_FETCHING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn parse_cursor_models_stdout(raw: &str) -> Vec<GroupedCliModel> {
    struct Acc {
        base_slug: String,
        label: String,
        bare_slug: Option<String>,
        effort_slugs: HashMap<String, String>,
    }

    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, Acc> = HashMap::new();

    for line in raw.lines() {
        let clean = line
            .trim()
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim();
        if clean.is_empty()
            || clean.starts_with("Available")
            || clean.starts_with("Loading")
            || clean.starts_with("Error:")
            || clean.starts_with("Tip:")
        {
            continue;
        }
        let (slug_raw, label_opt) = if let Some((l, r)) = clean.split_once(" - ") {
            (l.trim(), Some(r.trim()))
        } else {
            let mut parts = clean.splitn(2, char::is_whitespace);
            let s = parts.next().unwrap_or("").trim();
            let rest = parts.next().map(str::trim).filter(|x| !x.is_empty());
            (s, rest)
        };
        if slug_raw.is_empty()
            || !slug_raw
                .chars()
                .next()
                .map(|c| c.is_ascii_alphanumeric())
                .unwrap_or(false)
        {
            continue;
        }
        // Skip duplicate `-fast` variants so every model appears once cleanly
        if slug_raw.ends_with("-fast") {
            continue;
        }
        let (base_slug, eff_opt) = split_cursor_slug_effort(slug_raw);
        if base_slug == "auto" {
            continue;
        }
        let raw_lbl = match label_opt {
            Some(lbl) if !lbl.starts_with('(') => clean_effort_words_from_label(lbl),
            _ => base_slug.clone(),
        };

        if !map.contains_key(&base_slug) {
            order.push(base_slug.clone());
            map.insert(
                base_slug.clone(),
                Acc {
                    base_slug: base_slug.clone(),
                    label: raw_lbl,
                    bare_slug: None,
                    effort_slugs: HashMap::new(),
                },
            );
        }
        if let Some(acc) = map.get_mut(&base_slug) {
            if let Some(eff) = eff_opt {
                acc.effort_slugs.entry(eff).or_insert_with(|| slug_raw.to_string());
            } else {
                acc.bare_slug = Some(slug_raw.to_string());
            }
        }
    }

    let mut out = Vec::new();
    for key in order {
        let Some(mut acc) = map.remove(&key) else {
            continue;
        };
        // If Cursor exposes bare slug (e.g. `gpt-5.3-codex`) alongside `-low`/`-high`, map bare -> `medium`
        if let Some(bare) = acc.bare_slug.clone() {
            if !acc.effort_slugs.is_empty() && !acc.effort_slugs.contains_key("medium") {
                acc.effort_slugs.insert("medium".to_string(), bare);
            }
        }
        let mut supported_efforts: Vec<String> = acc.effort_slugs.keys().cloned().collect();
        let default_effort = sort_and_pick_default_effort(&mut supported_efforts);
        let display = format!("Cursor · {}", acc.label);
        out.push(GroupedCliModel {
            id: format!("cursor:{}", acc.base_slug),
            label: display,
            short_label: acc.label,
            supported_efforts,
            default_effort,
            effort_slugs: acc.effort_slugs,
        });
    }
    out
}

fn parse_agy_models_stdout(raw: &str) -> Vec<GroupedCliModel> {
    struct Acc {
        base_slug: String,
        label: String,
        efforts: Vec<String>,
    }

    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, Acc> = HashMap::new();

    for raw_line in raw.lines() {
        let clean = raw_line.rsplit('\r').next().unwrap_or(raw_line).trim();
        if clean.is_empty() || clean.contains("Fetching available models") {
            continue;
        }
        let mut parts = clean.splitn(2, char::is_whitespace);
        let Some(slug) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if !slug
            .chars()
            .next()
            .map(|c| c.is_ascii_alphanumeric())
            .unwrap_or(false)
        {
            continue;
        }
        let raw_label = parts
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(slug);
        let (base_raw, eff_opt) = velo_agent::split_effort_suffix(slug);
        let base_slug = base_raw.to_string();
        let clean_label = clean_effort_words_from_label(raw_label);

        if !map.contains_key(&base_slug) {
            order.push(base_slug.clone());
            map.insert(
                base_slug.clone(),
                Acc {
                    base_slug: base_slug.clone(),
                    label: clean_label,
                    efforts: Vec::new(),
                },
            );
        }
        if let Some(acc) = map.get_mut(&base_slug) {
            if let Some(eff) = eff_opt {
                if !acc.efforts.iter().any(|e| e == eff) {
                    acc.efforts.push(eff.to_string());
                }
            }
        }
    }

    let mut out = Vec::new();
    for key in order {
        let Some(mut acc) = map.remove(&key) else {
            continue;
        };
        let default_effort = sort_and_pick_default_effort(&mut acc.efforts);
        // Prefix Antigravity's Claude models with `agy:` so IDs never collide with Anthropic Claude Code
        let id = if acc.base_slug.starts_with("claude-") {
            format!("agy:{}", acc.base_slug)
        } else {
            acc.base_slug.clone()
        };
        out.push(GroupedCliModel {
            id,
            label: acc.label.clone(),
            short_label: acc.label,
            supported_efforts: acc.efforts,
            default_effort,
            effort_slugs: HashMap::new(),
        });
    }
    out
}

async fn resolve_cli_model_for_spawn(
    provider: &AgentProvider,
    model: Option<String>,
    effort: Option<String>,
) -> (Option<String>, Option<String>) {
    match provider {
        AgentProvider::Antigravity => {
            velo_agent::resolve_agy_model_and_effort(model.as_deref(), effort.as_deref())
        }
        AgentProvider::Cursor => {
            let Some(raw_m) = model.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
                return (model, None);
            };
            let stripped = raw_m.strip_prefix("cursor:").unwrap_or(raw_m);
            if stripped == "auto" || stripped == "default" || stripped == "cursor" {
                return (Some(format!("cursor:{stripped}")), None);
            }
            let (base_slug, embedded_eff) = split_cursor_slug_effort(stripped);
            let desired_eff = effort
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_lowercase())
                .or(embedded_eff);

            let cache_lock = CURSOR_MODELS_CACHE.get_or_init(|| tokio::sync::RwLock::new(None));
            if let Some(list) = cache_lock.read().await.as_ref() {
                let target_id = format!("cursor:{base_slug}");
                if let Some(entry) = list.iter().find(|m| m.id == target_id) {
                    if entry.effort_slugs.is_empty() {
                        return (Some(target_id), None);
                    }
                    if let Some(ref eff) = desired_eff {
                        if let Some(exact) = entry.effort_slugs.get(eff) {
                            return (Some(format!("cursor:{exact}")), None);
                        }
                        // Clamp to closest supported effort along canonical ladder
                        let target_rank = CANONICAL_EFFORT_ORDER
                            .iter()
                            .position(|c| *c == eff.as_str())
                            .unwrap_or(3) as isize;
                        if let Some(best_eff) = entry.supported_efforts.iter().min_by_key(|e| {
                            let r = CANONICAL_EFFORT_ORDER
                                .iter()
                                .position(|c| *c == e.as_str())
                                .unwrap_or(3) as isize;
                            (r - target_rank).abs()
                        }) {
                            if let Some(exact) = entry.effort_slugs.get(best_eff) {
                                return (Some(format!("cursor:{exact}")), None);
                            }
                        }
                    }
                    if let Some(def_eff) = entry.default_effort.as_deref() {
                        if let Some(exact) = entry.effort_slugs.get(def_eff) {
                            return (Some(format!("cursor:{exact}")), None);
                        }
                    }
                }
            }
            (Some(raw_m.to_string()), None)
        }
        _ => (model, effort),
    }
}

async fn list_runtimes_handler() -> impl IntoResponse {
    let runtimes = velo_agent::detect_local_runtimes().await;
    Json(json!({ "runtimes": runtimes }))
}

async fn list_models_handler() -> impl IntoResponse {
    Json(build_models_catalog_json().await)
}

pub(crate) async fn build_models_catalog_json() -> Value {
    let home_path = dirs::home_dir().unwrap_or_else(|| {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"))
    });
    let mut models: Vec<Value> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 1. Discover Anthropic / Claude Code models from local ~/.claude.json & Claude Desktop config
    let mut push_claude = |id: &str, label: &str, short_label: &str, desc: &str, is_default: bool| {
        if seen_ids.insert(id.to_string()) {
            let efforts: Vec<&str> = if id.contains("haiku") {
                vec!["low", "medium", "high"]
            } else {
                vec!["low", "medium", "high", "max"]
            };
            models.push(json!({
                "id": id,
                "label": label,
                "shortLabel": short_label,
                "family": "Anthropic",
                "agentKind": "claude",
                "runtimeId": "claude",
                "desc": desc,
                "isDefault": is_default,
                "supportedEfforts": efforts,
                "defaultEffort": "high",
            }));
        }
    };

    // Primary Claude 5 / Fable 5 models active in the user's Claude Code v2.1.317 environment
    push_claude(
        "claude-fable-5-2",
        "Claude Fable 5.2",
        "Fable 5.2",
        "Fable 5.2 · Most capable for your hardest and longest-running coding tasks",
        true,
    );

    // Also read any dynamic entries from ~/.claude.json -> additionalModelOptionsCache
    let claude_json_path = home_path.join(".claude.json");
    if let Ok(raw) = tokio::fs::read_to_string(&claude_json_path).await {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(arr) = val.get("additionalModelOptionsCache").and_then(|v| v.as_array()) {
                for item in arr {
                    let value = item.get("value").and_then(|v| v.as_str()).unwrap_or("");
                    let label = item.get("label").and_then(|v| v.as_str()).unwrap_or(value);
                    let desc = item
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Claude Code model");
                    if !value.is_empty() {
                        let display = if value.contains("fable-5-1") {
                            "Claude Fable 5.1 (1M)".to_string()
                        } else if label == "Fable" {
                            format!("Claude {}", desc.split('·').next().unwrap_or(label).trim())
                        } else {
                            label.to_string()
                        };
                        push_claude(value, &display, label, desc, false);
                    }
                }
            }
        }
    }

    push_claude(
        "claude-opus-5-5",
        "Claude Opus 5.5",
        "Opus 5.5",
        "Deep architectural reasoning & multi-file autonomous coding (Ultrathink)",
        false,
    );
    push_claude(
        "claude-sonnet-5",
        "Claude Sonnet 5",
        "Sonnet 5",
        "Fast, balanced everyday coding and agentic tool execution",
        false,
    );
    push_claude(
        "claude-opus-4-8",
        "Claude Opus 4.8",
        "Opus 4.8",
        "Previous-gen flagship Opus with Fast Mode support",
        false,
    );
    push_claude(
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
        "Sonnet 4.6",
        "High-efficiency coding with adaptive effort",
        false,
    );
    push_claude(
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        "Haiku 4.5",
        "Ultra-low latency for quick edits and lightweight lookups",
        false,
    );

    // 2. Discover OpenAI / Codex models from ~/.codex/config.toml, ~/.codex/codex-models.json & ~/.codex/models_cache.json
    let codex_dir = home_path.join(".codex");
    let mut default_codex_model = "gpt-6.1-sol".to_string();
    let mut default_codex_effort = "max".to_string();

    if let Ok(cfg_str) = tokio::fs::read_to_string(codex_dir.join("config.toml")).await {
        for line in cfg_str.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("model =") {
                let m = rest.trim().trim_matches('"').trim_matches('\'');
                if !m.is_empty() {
                    default_codex_model = m.to_string();
                }
            } else if let Some(rest) = trimmed.strip_prefix("model_reasoning_effort =") {
                let eff = rest.trim().trim_matches('"').trim_matches('\'');
                if !eff.is_empty() {
                    default_codex_effort = eff.to_string();
                }
            }
        }
    }

    let mut codex_entries: Vec<(String, String, String, bool, Vec<String>, Option<String>)> =
        Vec::new();
    for file_name in ["codex-models.json", "models_cache.json"] {
        let p = codex_dir.join(file_name);
        if let Ok(raw) = tokio::fs::read_to_string(&p).await {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(arr) = val.get("models").and_then(|v| v.as_array()) {
                    for item in arr {
                        let slug = item.get("slug").and_then(|v| v.as_str()).unwrap_or("");
                        let vis = item.get("visibility").and_then(|v| v.as_str()).unwrap_or("list");
                        if slug.is_empty()
                            || vis != "list"
                            || slug == "codex-auto-review"
                            || slug == "gpt-reserve"
                            || slug.starts_with("grok-")
                        {
                            continue;
                        }
                        let display = item
                            .get("display_name")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .unwrap_or(slug);
                        let desc = item
                            .get("description")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("Codex CLI model");
                        let mut efforts: Vec<String> = item
                            .get("supported_reasoning_levels")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|e| {
                                        e.get("effort")
                                            .and_then(|x| x.as_str())
                                            .or_else(|| e.as_str())
                                            .map(|s| s.to_lowercase())
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        if efforts.is_empty() {
                            efforts = vec![
                                "low".to_string(),
                                "medium".to_string(),
                                "high".to_string(),
                                "xhigh".to_string(),
                            ];
                        }
                        let def_eff = item
                            .get("default_reasoning_level")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_lowercase())
                            .or_else(|| sort_and_pick_default_effort(&mut efforts));
                        let _ = sort_and_pick_default_effort(&mut efforts);
                        let is_def = slug == default_codex_model;
                        codex_entries.push((
                            slug.to_string(),
                            display.to_string(),
                            desc.to_string(),
                            is_def,
                            efforts,
                            def_eff,
                        ));
                    }
                }
            }
        }
    }

    // Sort so default_codex_model (e.g. gpt-6.1-sol) is first among Codex models
    codex_entries.sort_by(|a, b| b.3.cmp(&a.3));

    for (slug, display, desc, is_def, efforts, def_eff) in codex_entries {
        if seen_ids.insert(slug.clone()) {
            models.push(json!({
                "id": slug,
                "label": display,
                "shortLabel": display,
                "family": "OpenAI",
                "agentKind": "codex",
                "runtimeId": "codex",
                "desc": if is_def { format!("Default in ~/.codex/config.toml · {}", desc) } else { desc },
                "isDefault": is_def,
                "supportedEfforts": efforts,
                "defaultEffort": def_eff.unwrap_or_else(|| default_codex_effort.clone()),
            }));
        }
    }

    // 3. Google Antigravity CLI (`agy` — https://antigravity.google/cli/install.sh)
    let agy_bin = velo_agent::resolve_cli_binary("agy");
    let agy_installed = agy_bin.is_some();
    let cache_lock = AGY_MODELS_CACHE.get_or_init(|| tokio::sync::RwLock::new(None));
    let cached_agy = cache_lock.read().await.clone();

    if cached_agy.is_none() {
        if let Some(bin_path) = agy_bin {
            if !AGY_MODELS_FETCHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                tokio::spawn(async move {
                    let aug_path = velo_agent::discover_augmented_path();
                    let mut m_cmd = Command::new(bin_path);
                    m_cmd.arg("models").env("PATH", aug_path);
                    velo_agent::apply_proxy_env_tokio(&mut m_cmd);
                    let res = tokio::time::timeout(
                        std::time::Duration::from_secs(12),
                        m_cmd.output(),
                    )
                    .await;
                    if let Ok(Ok(out)) = res {
                        if out.status.success() {
                            let parsed =
                                parse_agy_models_stdout(&String::from_utf8_lossy(&out.stdout));
                            if !parsed.is_empty() {
                                let lock =
                                    AGY_MODELS_CACHE.get_or_init(|| tokio::sync::RwLock::new(None));
                                *lock.write().await = Some(parsed);
                            }
                        }
                    }
                    AGY_MODELS_FETCHING.store(false, std::sync::atomic::Ordering::SeqCst);
                });
            }
        }
    }

    let agy_entries: Vec<GroupedCliModel> = cached_agy.unwrap_or_else(|| {
        vec![
            GroupedCliModel {
                id: "gemini-4-neon".to_string(),
                label: "Gemini 4 Neon".to_string(),
                short_label: "Gemini 4 Neon".to_string(),
                supported_efforts: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                ],
                default_effort: Some("high".into()),
                effort_slugs: HashMap::new(),
            },
            GroupedCliModel {
                id: "gemini-4-carbon".to_string(),
                label: "Gemini 4 Carbon".to_string(),
                short_label: "Gemini 4 Carbon".to_string(),
                supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                default_effort: Some("high".into()),
                effort_slugs: HashMap::new(),
            },
            GroupedCliModel {
                id: "gemini-4-argon".to_string(),
                label: "Gemini 4 Argon".to_string(),
                short_label: "Gemini 4 Argon".to_string(),
                supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                default_effort: Some("high".into()),
                effort_slugs: HashMap::new(),
            },
            GroupedCliModel {
                id: "gemini-3.8-flash".to_string(),
                label: "Gemini 3.8 Flash".to_string(),
                short_label: "Gemini 3.8 Flash".to_string(),
                supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                default_effort: Some("high".into()),
                effort_slugs: HashMap::new(),
            },
            GroupedCliModel {
                id: "agy:claude-opus-5-5".to_string(),
                label: "Claude Opus 5.5".to_string(),
                short_label: "Claude Opus 5.5".to_string(),
                supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                default_effort: Some("high".into()),
                effort_slugs: HashMap::new(),
            },
            GroupedCliModel {
                id: "gpt-oss-120b".to_string(),
                label: "GPT-OSS 120B".to_string(),
                short_label: "GPT-OSS 120B".to_string(),
                supported_efforts: vec!["medium".into()],
                default_effort: Some("medium".into()),
                effort_slugs: HashMap::new(),
            },
        ]
    });

    for (idx, item) in agy_entries.into_iter().enumerate() {
        if seen_ids.insert(item.id.clone()) {
            models.push(json!({
                "id": item.id,
                "label": item.label,
                "shortLabel": item.short_label,
                "family": "Google Antigravity",
                "agentKind": "agy",
                "runtimeId": "agy",
                "installed": agy_installed,
                "desc": if agy_installed {
                    "Installed · Google Antigravity CLI (`agy --model <base> --effort <level>`)"
                } else {
                    "Install via `curl -fsSL https://antigravity.google/cli/install.sh | bash`"
                },
                "isDefault": idx == 0,
                "supportedEfforts": item.supported_efforts,
                "defaultEffort": item.default_effort,
            }));
        }
    }

    // 4. xAI Grok CLI (`grok` at ~/.grok/bin/grok, ~/.grok/config.toml & ~/.grok/models_cache.json)
    let grok_installed = velo_agent::resolve_cli_binary("grok").is_some();
    let grok_dir = home_path.join(".grok");
    let mut default_grok_model = "grok-4.7".to_string();
    if let Ok(cfg_str) = tokio::fs::read_to_string(grok_dir.join("config.toml")).await {
        let mut in_models_section = false;
        for line in cfg_str.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                in_models_section = trimmed == "[models]";
                continue;
            }
            if in_models_section {
                if let Some(rest) = trimmed.strip_prefix("default =") {
                    let m = rest.trim().trim_matches('"').trim_matches('\'');
                    if !m.is_empty() {
                        default_grok_model = m.to_string();
                    }
                }
            }
        }
    }

    let mut grok_entries: Vec<(String, String, String, bool)> = Vec::new();
    if let Ok(raw) = tokio::fs::read_to_string(grok_dir.join("models_cache.json")).await {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(obj) = val.get("models").and_then(|v| v.as_object()) {
                for (slug, entry) in obj {
                    let info = entry.get("info").unwrap_or(entry);
                    let hidden = info.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
                    let supported = info
                        .get("supported_in_api")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    if slug.is_empty() || hidden || !supported {
                        continue;
                    }
                    let display = info
                        .get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or(slug);
                    let desc = info
                        .get("description")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("xAI Grok CLI coding model");
                    let is_def = slug == &default_grok_model;
                    grok_entries.push((
                        slug.clone(),
                        display.to_string(),
                        desc.to_string(),
                        is_def,
                    ));
                }
            }
        }
    }

    if grok_entries.is_empty() {
        for (slug, display, desc) in [
            (
                "grok-4.7",
                "Grok 4.7",
                "xAI's latest frontier coding & reasoning model",
            ),
            (
                "grok-4.7-build-fast",
                "Grok 4.7 Fast",
                "Fast low-latency Grok 4.7 coding variant",
            ),
            (
                "grok-4.6",
                "Grok 4.6",
                "Balanced frontier coding & tool execution",
            ),
            (
                "grok-4.5",
                "Grok 4.5",
                "Efficient secondary & subagent Grok model",
            ),
        ] {
            grok_entries.push((
                slug.to_string(),
                display.to_string(),
                desc.to_string(),
                slug == default_grok_model,
            ));
        }
    } else {
        // Order default model first, then descending version slug (so grok-4.7 precedes grok-4.5)
        grok_entries.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| b.0.cmp(&a.0)));
    }

    for (slug, display, desc, is_def) in grok_entries {
        if seen_ids.insert(slug.clone()) {
            models.push(json!({
                "id": slug,
                "label": display,
                "shortLabel": display,
                "family": "xAI Grok",
                "agentKind": "grok",
                "runtimeId": "grok",
                "installed": grok_installed,
                "desc": if is_def {
                    format!("Default in ~/.grok/config.toml · {}", desc)
                } else {
                    desc
                },
                "isDefault": is_def,
                "supportedEfforts": ["low", "medium", "high", "xhigh"],
                "defaultEffort": "high",
            }));
        }
    }

    // 5. Cursor Agent CLI (`cursor-agent` / `agent` at ~/.local/bin/cursor-agent)
    let cursor_bin = velo_agent::resolve_cli_binary("cursor-agent");
    let cursor_installed = cursor_bin.is_some();
    let cursor_cache_lock = CURSOR_MODELS_CACHE.get_or_init(|| tokio::sync::RwLock::new(None));
    let cached_cursor = cursor_cache_lock.read().await.clone();

    if cached_cursor.is_none() {
        if let Some(bin_path) = cursor_bin {
            if !CURSOR_MODELS_FETCHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                tokio::spawn(async move {
                    let aug_path = velo_agent::discover_augmented_path();
                    let mut c_cmd = Command::new(bin_path);
                    c_cmd.arg("--list-models").env("PATH", aug_path);
                    velo_agent::apply_proxy_env_tokio(&mut c_cmd);
                    let res = tokio::time::timeout(
                        std::time::Duration::from_secs(8),
                        c_cmd.output(),
                    )
                    .await;
                    if let Ok(Ok(out)) = res {
                        if out.status.success() {
                            let parsed =
                                parse_cursor_models_stdout(&String::from_utf8_lossy(&out.stdout));
                            if !parsed.is_empty() {
                                let lock = CURSOR_MODELS_CACHE
                                    .get_or_init(|| tokio::sync::RwLock::new(None));
                                *lock.write().await = Some(parsed);
                            }
                        }
                    }
                    CURSOR_MODELS_FETCHING.store(false, std::sync::atomic::Ordering::SeqCst);
                });
            }
        }
    }

    let mut cursor_entries: Vec<(String, String, String, String, bool, Vec<String>, Option<String>)> =
        vec![(
            "cursor:auto".to_string(),
            "Cursor Auto".to_string(),
            "Cursor Auto".to_string(),
            if cursor_installed {
                "Installed · Cursor Agent CLI auto-router (`cursor-agent -p --output-format stream-json`)"
                    .to_string()
            } else {
                "Install Cursor CLI (`cursor-agent`)".to_string()
            },
            true,
            Vec::new(),
            None,
        )];

    if let Some(dynamic_list) = cached_cursor {
        for item in dynamic_list {
            cursor_entries.push((
                item.id,
                item.label,
                item.short_label,
                "Cursor Agent CLI model (推理强度自动映射到对应变体)".to_string(),
                false,
                item.supported_efforts,
                item.default_effort,
            ));
        }
    } else {
        for (id, label, short_lbl, desc, efforts, def_eff) in [
            (
                "cursor:composer-2.5",
                "Cursor · Composer 2.5",
                "Composer 2.5",
                "Cursor native multi-file fast coding model",
                Vec::<String>::new(),
                None,
            ),
            (
                "cursor:claude-opus-5-5",
                "Cursor · Claude Opus 5.5 1M",
                "Claude Opus 5.5 1M",
                "Claude Opus 5.5 routed via Cursor Agent CLI",
                vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                ],
                Some("high".into()),
            ),
            (
                "cursor:claude-sonnet-5",
                "Cursor · Claude Sonnet 5 1M",
                "Claude Sonnet 5 1M",
                "Claude Sonnet 5 routed via Cursor Agent CLI",
                vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                ],
                Some("high".into()),
            ),
            (
                "cursor:gpt-5.6-sol",
                "Cursor · GPT-5.6 Sol 1M",
                "GPT-5.6 Sol 1M",
                "OpenAI GPT-5.6 Sol routed via Cursor Agent CLI",
                vec![
                    "none".into(),
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                ],
                Some("high".into()),
            ),
        ] {
            cursor_entries.push((
                id.to_string(),
                label.to_string(),
                short_lbl.to_string(),
                desc.to_string(),
                false,
                efforts,
                def_eff,
            ));
        }
    }

    for (id, label, short_lbl, desc, is_def, efforts, def_eff) in cursor_entries {
        if seen_ids.insert(id.clone()) {
            models.push(json!({
                "id": id,
                "label": label,
                "shortLabel": short_lbl,
                "family": "Cursor",
                "agentKind": "cursor",
                "runtimeId": "cursor-agent",
                "installed": cursor_installed,
                "desc": desc,
                "isDefault": is_def,
                "supportedEfforts": efforts,
                "defaultEffort": def_eff,
            }));
        }
    }

    // 6. ACP & Multi-Provider Catalog (OpenCode, GitHub Copilot CLI, Qwen Code)
    let acp_catalog = [
        (
            "acp-opencode",
            "OpenCode (ACP)",
            "OpenCode",
            "ACP · OpenCode",
            "acp:opencode acp",
            "opencode",
            "Agent Client Protocol stdio integration for OpenCode",
        ),
        (
            "acp-copilot",
            "GitHub Copilot CLI",
            "Copilot",
            "ACP · GitHub",
            "copilot",
            "copilot",
            "GitHub Copilot coding agent CLI adapter",
        ),
        (
            "acp-qwen-code",
            "Qwen Code (ACP)",
            "Qwen Code",
            "ACP · Qwen",
            "acp:qwen --acp",
            "qwen",
            "Agent Client Protocol stdio integration for Qwen Code",
        ),
    ];
    for (id, label, short_lbl, family, agent_kind, runtime_id, desc) in acp_catalog {
        let installed = velo_agent::resolve_cli_binary(runtime_id).is_some();
        if seen_ids.insert(id.to_string()) {
            models.push(json!({
                "id": id,
                "label": label,
                "shortLabel": short_lbl,
                "family": family,
                "agentKind": agent_kind,
                "runtimeId": runtime_id,
                "installed": installed,
                "desc": if installed { format!("Installed · {}", desc) } else { format!("Install `{}` CLI to enable · {}", runtime_id, desc) },
                "isDefault": false,
            }));
        }
    }

    json!({
        "models": models,
        "defaultCodexModel": default_codex_model,
        "defaultCodexEffort": default_codex_effort,
        "defaultClaudeModel": "claude-fable-5-2",
    })
}

#[derive(Debug, serde::Deserialize)]
struct WorkspaceMutationRequest {
    path: String,
    delete_sessions: Option<bool>,
    init_git: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
struct RelocateWorkspaceRequest {
    old_path: String,
    new_path: String,
}

async fn list_workspaces_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    let list = state.list_workspaces().await;
    Json(json!({ "workspaces": list }))
}

async fn add_workspace_handler(
    State(state): State<DaemonState>,
    Json(req): Json<WorkspaceMutationRequest>,
) -> impl IntoResponse {
    let list = state
        .add_workspace_with_options(&req.path, req.init_git.unwrap_or(false))
        .await;
    Json(json!({ "workspaces": list }))
}

async fn remove_workspace_handler(
    State(state): State<DaemonState>,
    Json(req): Json<WorkspaceMutationRequest>,
) -> impl IntoResponse {
    let delete_sessions = req.delete_sessions.unwrap_or(true);
    let list = state.remove_workspace(&req.path, delete_sessions).await;
    Json(json!({ "workspaces": list }))
}

async fn relocate_workspace_handler(
    State(state): State<DaemonState>,
    Json(req): Json<RelocateWorkspaceRequest>,
) -> impl IntoResponse {
    let list = state.relocate_workspace(&req.old_path, &req.new_path).await;
    let sessions: Vec<SessionInfo> = {
        let guard = state.inner.read().await;
        let mut s: Vec<SessionInfo> = guard.sessions.values().cloned().collect();
        s.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        s
    };
    Json(json!({ "ok": true, "workspaces": list, "sessions": sessions }))
}

async fn pick_folder_handler() -> impl IntoResponse {
    let out = Command::new("osascript")
        .args([
            "-e",
            "POSIX path of (choose folder with prompt \"选择项目文件夹，或点击左下角「新建文件夹」创建工作区：\")",
        ])
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let raw = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let clean = raw.trim_end_matches('/').to_string();
            (StatusCode::OK, Json(json!({ "path": clean }))).into_response()
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Folder selection cancelled" })),
        )
            .into_response(),
    }
}

#[derive(Debug, serde::Deserialize)]
struct OpenEditorRequest {
    path: String,
    editor: String,
}

async fn open_editor_handler(Json(req): Json<OpenEditorRequest>) -> impl IntoResponse {
    let target = req.path.trim();
    let status = match req.editor.as_str() {
        "cursor" => Command::new("open")
            .args(["-a", "Cursor", target])
            .status()
            .await,
        "vscode" => Command::new("open")
            .args(["-a", "Visual Studio Code", target])
            .status()
            .await,
        "zed" => Command::new("open")
            .args(["-a", "Zed", target])
            .status()
            .await,
        "terminal" => Command::new("open")
            .args(["-a", "Terminal", target])
            .status()
            .await,
        _ => Command::new("open").arg(target).status().await,
    };

    match status {
        Ok(s) if s.success() => (
            StatusCode::OK,
            Json(json!({ "ok": true, "editor": req.editor, "path": target })),
        )
            .into_response(),
        _ => {
            // Fallback to Finder reveal if specific IDE app is not installed
            let _ = Command::new("open").arg(target).status().await;
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "editor": "finder", "path": target })),
            )
                .into_response()
        }
    }
}

async fn list_sessions_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    let guard = state.inner.read().await;
    let mut list: Vec<SessionInfo> = guard.sessions.values().cloned().collect();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(list)
}

async fn create_session_handler(
    State(state): State<DaemonState>,
    Json(req): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    match state.create_session(req).await {
        Ok(session) => (StatusCode::CREATED, Json(json!(session))).into_response(),
        Err(err) => {
            error!("Failed to create session: {}", err);
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response()
        }
    }
}

async fn get_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let guard = state.inner.read().await;
    match guard.sessions.get(&id) {
        Some(s) => (StatusCode::OK, Json(json!(s))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Session not found" })),
        )
            .into_response(),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
struct DeleteSessionQuery {
    cleanup_worktree: Option<bool>,
}

impl DaemonState {
    pub async fn delete_session_by_id(&self, id: Uuid, cleanup_wt: bool) -> bool {
        let (removed_session, wt_still_in_use) = {
            let mut guard = self.inner.write().await;
            if let Some(mut handle) = guard.handles.remove(&id) {
                handle.stop();
            }
            if let Some(mut shell) = guard.shells.remove(&id) {
                shell.stop();
            }
            guard.event_history.remove(&id);
            let removed = guard.sessions.remove(&id);
            let in_use = removed
                .as_ref()
                .map(|rem| {
                    guard
                        .sessions
                        .values()
                        .any(|other| other.worktree_path == rem.worktree_path)
                })
                .unwrap_or(false);
            (removed, in_use)
        };

        let ev_file = self.events_dir.join(format!("{}.json", id));
        let _ = tokio::fs::remove_file(&ev_file).await;
        let _ = self.db.delete_session(id);

        let mut worktree_removed = false;
        if let Some(ref s) = removed_session {
            if cleanup_wt && !wt_still_in_use && s.worktree_path != s.repo_root {
                let repo_root = PathBuf::from(&s.repo_root);
                let wt_path = PathBuf::from(&s.worktree_path);
                if self
                    .worktree_mgr
                    .remove_worktree(&repo_root, &wt_path)
                    .await
                    .is_ok()
                {
                    worktree_removed = true;
                }
                if wt_path.starts_with(self.worktree_mgr.base_dir()) {
                    let _ = tokio::fs::remove_dir_all(&wt_path).await;
                }
            }
        }

        let _ = self.persist_sessions().await;
        worktree_removed
    }

    pub async fn update_session_fields(
        &self,
        id: Uuid,
        name: Option<String>,
        provider: Option<AgentProvider>,
        model: Option<String>,
        effort: Option<String>,
        approval_mode: Option<String>,
        preview_url: Option<String>,
        repo_path: Option<String>,
    ) -> Option<SessionInfo> {
        let clean_new_repo = repo_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(canonical_workspace_path);
        if let Some(ref nr) = clean_new_repo {
            let _ = velo_worktree::ensure_usable_workspace_dir(Path::new(nr)).await;
        }
        let updated = {
            let mut guard = self.inner.write().await;
            if let Some(ref nr) = clean_new_repo {
                if !guard.workspaces.iter().any(|w| canonical_workspace_path(w) == *nr) {
                    guard.workspaces.push(nr.clone());
                }
            }
            let has_history = guard
                .event_history
                .get(&id)
                .map(|evs| {
                    evs.iter().any(|ev| {
                        matches!(
                            ev,
                            AgentEvent::UserMessage { .. }
                                | AgentEvent::MessageDelta { .. }
                                | AgentEvent::ToolCallRequested { .. }
                        )
                    })
                })
                .unwrap_or(false);

            if let Some(s) = guard.sessions.get_mut(&id) {
                let is_engine_bound = s.provider_session_id.is_some() || has_history;
                if let Some(n) = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
                    s.name = n;
                }
                if let Some(ref nr) = clean_new_repo {
                    let is_isolated_wt = s.worktree_path.contains("/.velo/worktrees/");
                    s.repo_root = nr.clone();
                    if !is_isolated_wt {
                        s.worktree_path = nr.clone();
                    }
                }
                let mut provider_conflict = false;
                if let Some(new_prov) = provider {
                    if s.provider != new_prov {
                        if !is_engine_bound {
                            s.provider = new_prov;
                            s.provider_session_id = None;
                        } else {
                            provider_conflict = true;
                        }
                    }
                }
                if !provider_conflict {
                    if let Some(m) = model {
                        s.model = if m.trim().is_empty() { None } else { Some(m) };
                    }
                }
                if let Some(eff) = effort {
                    s.effort = if eff.trim().is_empty() {
                        None
                    } else {
                        Some(eff)
                    };
                }
                if let Some(mode) = approval_mode.filter(|m| !m.trim().is_empty()) {
                    s.approval_mode = mode;
                }
                if let Some(purl) = preview_url {
                    s.preview_url = if purl.trim().is_empty() {
                        None
                    } else {
                        Some(purl)
                    };
                }
                s.updated_at = Utc::now();
                Some(s.clone())
            } else {
                None
            }
        };

        if updated.is_some() {
            if clean_new_repo.is_some() {
                let _ = self.persist_workspaces().await;
            }
            let _ = self.persist_sessions().await;
        }
        updated
    }
}

async fn delete_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<DeleteSessionQuery>,
) -> impl IntoResponse {
    let cleanup_wt = query.cleanup_worktree.unwrap_or(true);
    let worktree_removed = state.delete_session_by_id(id, cleanup_wt).await;
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "deleted_id": id,
            "worktree_removed": worktree_removed,
        })),
    )
        .into_response()
}

#[derive(Debug, serde::Deserialize)]
struct UpdateSessionRequest {
    name: Option<String>,
    provider: Option<AgentProvider>,
    model: Option<String>,
    effort: Option<String>,
    approval_mode: Option<String>,
    preview_url: Option<String>,
    repo_path: Option<String>,
}

async fn update_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<UpdateSessionRequest>,
) -> impl IntoResponse {
    let updated = state
        .update_session_fields(
            id,
            req.name,
            req.provider,
            req.model,
            req.effort,
            req.approval_mode,
            req.preview_url,
            req.repo_path,
        )
        .await;

    match updated {
        Some(s) => (StatusCode::OK, Json(json!(s))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Session not found" })),
        )
            .into_response(),
    }
}

async fn prune_worktrees_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    let (active_wt_paths, repo_roots): (HashSet<PathBuf>, HashSet<PathBuf>) = {
        let guard = state.inner.read().await;
        let wts = guard
            .sessions
            .values()
            .map(|s| PathBuf::from(&s.worktree_path))
            .collect();
        let repos = guard
            .sessions
            .values()
            .map(|s| PathBuf::from(&s.repo_root))
            .collect();
        (wts, repos)
    };

    let mut pruned_paths: Vec<String> = Vec::new();
    let base_dir = state.worktree_mgr.base_dir().to_path_buf();
    if let Ok(mut repo_entries) = tokio::fs::read_dir(&base_dir).await {
        while let Ok(Some(repo_entry)) = repo_entries.next_entry().await {
            let repo_sub = repo_entry.path();
            if !repo_sub.is_dir() {
                continue;
            }
            if let Ok(mut wt_entries) = tokio::fs::read_dir(&repo_sub).await {
                while let Ok(Some(wt_entry)) = wt_entries.next_entry().await {
                    let wt_path = wt_entry.path();
                    if wt_path.is_dir() && !active_wt_paths.contains(&wt_path) {
                        for repo_root in &repo_roots {
                            let _ = Command::new("git")
                                .arg("-C")
                                .arg(repo_root)
                                .args(["worktree", "remove", "--force"])
                                .arg(&wt_path)
                                .output()
                                .await;
                        }
                        if tokio::fs::remove_dir_all(&wt_path).await.is_ok() {
                            pruned_paths.push(wt_path.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }

    for repo_root in &repo_roots {
        let _ = Command::new("git")
            .arg("-C")
            .arg(repo_root)
            .args(["worktree", "prune"])
            .output()
            .await;
    }

    Json(json!({
        "ok": true,
        "pruned_count": pruned_paths.len(),
        "pruned_paths": pruned_paths,
    }))
}

pub(crate) fn decode_base64_payload(input: &str) -> Result<Vec<u8>> {
    let raw = match input.find(";base64,") {
        Some(idx) => &input[idx + 8..],
        None => input,
    };
    let mut out = Vec::with_capacity(raw.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for b in raw.bytes() {
        if b.is_ascii_whitespace() || b == b'=' {
            continue;
        }
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => anyhow::bail!("Invalid base64 byte"),
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

#[derive(Debug, serde::Deserialize)]
struct UploadAttachmentRequest {
    filename: Option<String>,
    mime_type: Option<String>,
    data_base64: String,
}

fn percent_decode_utf8(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_for_image_ext(ext_or_name: &str) -> &'static str {
    let lower = ext_or_name.to_ascii_lowercase();
    if lower.ends_with("jpg") || lower.ends_with("jpeg") {
        "image/jpeg"
    } else if lower.ends_with("webp") {
        "image/webp"
    } else if lower.ends_with("gif") {
        "image/gif"
    } else if lower.ends_with("svg") {
        "image/svg+xml"
    } else if lower.ends_with("heic") {
        "image/heic"
    } else {
        "image/png"
    }
}

fn is_allowed_image_ext(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "heic" | "svg"
    )
}

impl DaemonState {
    /// Saves raw image bytes into persistent content-addressed storage (`~/.velo/attachments/<sha256>.<ext>`).
    /// Avoids OS temporary directories (`os.tmpdir()`) that macOS `dirhelper` sweeps after 3 days.
    pub async fn save_attachment_bytes(
        &self,
        bytes: &[u8],
        filename: Option<&str>,
        mime_type: Option<&str>,
    ) -> Result<(String, PathBuf), String> {
        if bytes.is_empty() {
            return Err("Empty attachment payload".to_string());
        }
        let ext = filename
            .and_then(|f| Path::new(f).extension().and_then(|e| e.to_str()))
            .or_else(|| match mime_type {
                Some("image/jpeg") | Some("image/jpg") => Some("jpg"),
                Some("image/webp") => Some("webp"),
                Some("image/gif") => Some("gif"),
                Some("image/svg+xml") => Some("svg"),
                Some("image/heic") => Some("heic"),
                _ => Some("jpg"),
            })
            .unwrap_or("jpg")
            .to_ascii_lowercase();

        let clean_ext: String = ext
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect();
        let final_ext = if clean_ext.is_empty() { "jpg" } else { &clean_ext };

        use sha2::{Digest, Sha256};
        let digest_hex = hex::encode(Sha256::digest(bytes));
        let saved_name = format!("{}.{}", &digest_hex[..32], final_ext);
        let _ = tokio::fs::create_dir_all(&self.attachments_dir).await;
        let dest_path = self.attachments_dir.join(&saved_name);

        if !tokio::fs::try_exists(&dest_path).await.unwrap_or(false) {
            tokio::fs::write(&dest_path, bytes)
                .await
                .map_err(|e| format!("Failed to write attachment: {}", e))?;
        }
        Ok((saved_name, dest_path))
    }

    /// Safely resolves an attachment reference (`/api/attachments/...`, filename, `file://...`, or Mac image path).
    /// Automatically materializes temporary `/tmp` or `/var/folders` screenshots into `~/.velo/attachments/`
    /// so historical images never break after macOS temporary directory cleanup.
    pub async fn resolve_local_image_path(&self, raw_ref: &str) -> Option<PathBuf> {
        let trimmed = raw_ref.trim();
        if trimmed.is_empty() || trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return None;
        }
        let stripped = trimmed.strip_prefix("file://").unwrap_or(trimmed);
        let decoded = percent_decode_utf8(stripped);

        if let Some(rest) = decoded.strip_prefix("/api/attachments/") {
            let clean = Path::new(rest).file_name()?.to_str()?;
            let candidate = self.attachments_dir.join(clean);
            if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
                return Some(candidate);
            }
        }

        if !decoded.contains('/') {
            let clean = Path::new(&decoded).file_name()?.to_str()?;
            let candidate = self.attachments_dir.join(clean);
            if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
                return Some(candidate);
            }
        }

        let expanded = velo_worktree::expand_tilde_path(Path::new(&decoded));
        if expanded
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return None;
        }
        if !is_allowed_image_ext(&expanded) {
            return None;
        }

        let path_str = expanded.to_string_lossy();
        let is_ephemeral_tmp = path_str.starts_with("/tmp/")
            || path_str.starts_with("/private/tmp/")
            || path_str.starts_with("/var/folders/")
            || path_str.starts_with("/private/var/folders/");

        use sha2::{Digest, Sha256};
        let ext = expanded
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let mat_hash = hex::encode(Sha256::digest(path_str.as_bytes()));
        let mat_path = self
            .attachments_dir
            .join(format!("mat-{}.{}", &mat_hash[..24], ext));

        if tokio::fs::try_exists(&expanded).await.unwrap_or(false) {
            if is_ephemeral_tmp && !tokio::fs::try_exists(&mat_path).await.unwrap_or(false) {
                let _ = tokio::fs::create_dir_all(&self.attachments_dir).await;
                let _ = tokio::fs::copy(&expanded, &mat_path).await;
                if tokio::fs::try_exists(&mat_path).await.unwrap_or(false) {
                    return Some(mat_path);
                }
            }
            return Some(expanded);
        }

        // Fallback if OS swept `/var/folders` or `/tmp` after we materialized it earlier
        if tokio::fs::try_exists(&mat_path).await.unwrap_or(false) {
            return Some(mat_path);
        }

        // Fallback by basename inside `~/.velo/attachments`
        if let Some(fname) = expanded.file_name().and_then(|s| s.to_str()) {
            let candidate = self.attachments_dir.join(fname);
            if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
                return Some(candidate);
            }
        }
        None
    }

    /// Loads image bytes at requested tier (`"thumb"` ~800px JPEG ~60KB, or `"full"` <= 2200px HD).
    /// Caches generated thumbnails on disk under `~/.velo/attachments/.thumbs/` for sub-millisecond reuse.
    pub async fn load_attachment_tier(&self, raw_ref: &str, tier: &str) -> Option<(Vec<u8>, String)> {
        let src_path = self.resolve_local_image_path(raw_ref).await?;
        let meta = tokio::fs::metadata(&src_path).await.ok()?;
        let len = meta.len();
        let ext = src_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();

        if ext == "svg" || ext == "gif" {
            let bytes = tokio::fs::read(&src_path).await.ok()?;
            return Some((bytes, mime_for_image_ext(&ext).to_string()));
        }

        let want_thumb = tier.eq_ignore_ascii_case("thumb");
        // Fast path: already compact web-friendly image
        if ext != "heic" && ((want_thumb && len <= 95_000) || (!want_thumb && len <= 2_600_000)) {
            let bytes = tokio::fs::read(&src_path).await.ok()?;
            return Some((bytes, mime_for_image_ext(&ext).to_string()));
        }

        if Path::new("/usr/bin/sips").is_file() {
            let thumbs_dir = self.attachments_dir.join(".thumbs");
            let _ = tokio::fs::create_dir_all(&thumbs_dir).await;
            use sha2::{Digest, Sha256};
            let mtime_secs = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let cache_seed = format!(
                "{}:{}:{}:{}",
                src_path.to_string_lossy(),
                len,
                mtime_secs,
                if want_thumb { "thumb800" } else { "full2200" }
            );
            let cache_hash = hex::encode(Sha256::digest(cache_seed.as_bytes()));
            let out_path = thumbs_dir.join(format!("{}.jpg", &cache_hash[..28]));

            if let Ok(cached) = tokio::fs::read(&out_path).await {
                if !cached.is_empty() {
                    return Some((cached, "image/jpeg".to_string()));
                }
            }

            let max_px = if want_thumb { "800" } else { "2200" };
            let quality = if want_thumb { "76" } else { "85" };
            let status = Command::new("/usr/bin/sips")
                .args([
                    "-Z",
                    max_px,
                    "-s",
                    "format",
                    "jpeg",
                    "-s",
                    "formatOptions",
                    quality,
                    src_path.to_str().unwrap_or(""),
                    "--out",
                    out_path.to_str().unwrap_or(""),
                ])
                .output()
                .await;

            if let Ok(res) = status {
                if res.status.success() {
                    if let Ok(converted) = tokio::fs::read(&out_path).await {
                        if !converted.is_empty() {
                            return Some((converted, "image/jpeg".to_string()));
                        }
                    }
                }
            }
        }

        let bytes = tokio::fs::read(&src_path).await.ok()?;
        Some((bytes, mime_for_image_ext(&ext).to_string()))
    }
}

async fn upload_attachment_handler(
    State(state): State<DaemonState>,
    Json(req): Json<UploadAttachmentRequest>,
) -> impl IntoResponse {
    let bytes = match decode_base64_payload(&req.data_base64) {
        Ok(b) if !b.is_empty() => b,
        Ok(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Empty attachment payload" })),
            )
                .into_response();
        }
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Invalid base64 image: {}", err) })),
            )
                .into_response();
        }
    };

    match state
        .save_attachment_bytes(&bytes, req.filename.as_deref(), req.mime_type.as_deref())
        .await
    {
        Ok((saved_name, dest_path)) => (
            StatusCode::CREATED,
            Json(json!({
                "ok": true,
                "filename": saved_name,
                "path": dest_path.to_string_lossy().to_string(),
                "url": format!("/api/attachments/{}", saved_name),
                "size": bytes.len(),
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err })),
        )
            .into_response(),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
struct AttachmentTierQuery {
    tier: Option<String>,
    #[serde(rename = "ref")]
    raw_ref: Option<String>,
}

async fn get_attachment_handler(
    State(state): State<DaemonState>,
    AxumPath(file): AxumPath<String>,
    Query(q): Query<AttachmentTierQuery>,
) -> impl IntoResponse {
    let tier = q.tier.as_deref().unwrap_or("full");
    match state.load_attachment_tier(&file, tier).await {
        Some((bytes, content_type)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type.as_str()),
                (header::CACHE_CONTROL, "public, max-age=86400"),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn resolve_attachment_handler(
    State(state): State<DaemonState>,
    Query(q): Query<AttachmentTierQuery>,
) -> impl IntoResponse {
    let Some(raw_ref) = q.raw_ref.as_deref().filter(|s| !s.trim().is_empty()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let tier = q.tier.as_deref().unwrap_or("full");
    match state.load_attachment_tier(raw_ref, tier).await {
        Some((bytes, content_type)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type.as_str()),
                (header::CACHE_CONTROL, "public, max-age=86400"),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
struct TerminalStartRequest {
    cols: Option<u16>,
    rows: Option<u16>,
}

async fn terminal_start_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    payload: Option<Json<TerminalStartRequest>>,
) -> impl IntoResponse {
    let cols = payload.as_ref().and_then(|p| p.cols).unwrap_or(96);
    let rows = payload.as_ref().and_then(|p| p.rows).unwrap_or(28);

    let mut guard = state.inner.write().await;
    let wt_path = guard
        .sessions
        .get(&id)
        .map(|s| PathBuf::from(&s.worktree_path))
        .unwrap_or_else(fallback_workspace_dir);

    if let Some(existing) = guard.shells.get(&id) {
        let _ = existing.resize(cols, rows);
        return (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "pid": existing.pid,
                "scrollback": existing.scrollback(),
                "worktree_path": wt_path,
            })),
        )
            .into_response();
    }

    match velo_agent::spawn_interactive_shell(id, wt_path.clone(), cols, rows, state.event_tx.clone())
    {
        Ok(shell) => {
            let pid = shell.pid;
            let scrollback = shell.scrollback();
            guard.shells.insert(id, shell);
            (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "pid": pid,
                    "scrollback": scrollback,
                    "worktree_path": wt_path,
                })),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, serde::Deserialize)]
struct TerminalInputRequest {
    data: String,
}

async fn terminal_input_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<TerminalInputRequest>,
) -> impl IntoResponse {
    let mut guard = state.inner.write().await;
    if !guard.shells.contains_key(&id) {
        let wt_path = guard
            .sessions
            .get(&id)
            .map(|s| PathBuf::from(&s.worktree_path))
            .unwrap_or_else(fallback_workspace_dir);
        if let Ok(shell) =
            velo_agent::spawn_interactive_shell(id, wt_path, 96, 28, state.event_tx.clone())
        {
            guard.shells.insert(id, shell);
        }
    }

    if let Some(shell) = guard.shells.get(&id) {
        match shell.write_input(&req.data) {
            Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
            Err(err) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
                .into_response(),
        }
    } else {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "Interactive shell unavailable" })),
        )
            .into_response()
    }
}

#[derive(Debug, serde::Deserialize)]
struct TerminalResizeRequest {
    cols: u16,
    rows: u16,
}

async fn terminal_resize_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<TerminalResizeRequest>,
) -> impl IntoResponse {
    let guard = state.inner.read().await;
    if let Some(shell) = guard.shells.get(&id) {
        let _ = shell.resize(req.cols, req.rows);
    }
    Json(json!({ "ok": true }))
}

async fn terminal_restart_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let mut guard = state.inner.write().await;
    if let Some(mut old_shell) = guard.shells.remove(&id) {
        old_shell.stop();
    }
    let wt_path = guard
        .sessions
        .get(&id)
        .map(|s| PathBuf::from(&s.worktree_path))
        .unwrap_or_else(fallback_workspace_dir);

    match velo_agent::spawn_interactive_shell(id, wt_path.clone(), 96, 28, state.event_tx.clone()) {
        Ok(shell) => {
            let pid = shell.pid;
            guard.shells.insert(id, shell);
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "pid": pid, "worktree_path": wt_path })),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
struct EventsQueryParams {
    before_seq: Option<i64>,
    limit: Option<usize>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GlobalSearchQueryParams {
    q: Option<String>,
    limit: Option<usize>,
}

async fn get_session_events_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(params): Query<EventsQueryParams>,
) -> impl IntoResponse {
    if params.before_seq.is_some() || params.limit.is_some() {
        let lim = params.limit.unwrap_or(180);
        match state.db.query_events_page(id, params.before_seq, lim) {
            Ok(page) => return Json(json!(page)).into_response(),
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": err.to_string() })),
                )
                    .into_response();
            }
        }
    }
    let guard = state.inner.read().await;
    let events = guard
        .event_history
        .get(&id)
        .map(|evs| enrich_history_turn_metrics(evs))
        .unwrap_or_default();
    Json(events).into_response()
}

async fn global_search_handler(
    State(state): State<DaemonState>,
    Query(params): Query<GlobalSearchQueryParams>,
) -> impl IntoResponse {
    let q = params.q.unwrap_or_default();
    let lim = params.limit.unwrap_or(30);
    let hits = state.db.search_global(&q, lim).unwrap_or_default();
    Json(json!({ "ok": true, "query": q, "hits": hits }))
}

async fn usage_analytics_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    Json(state.get_usage_analytics_dto().await)
}

async fn get_push_config_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    Json(json!({ "ok": true, "config": state.get_push_config_dto().await }))
}

async fn set_push_config_handler(
    State(state): State<DaemonState>,
    Json(cfg): Json<push::PushConfig>,
) -> impl IntoResponse {
    match state.set_push_config_dto(cfg.clone()).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true, "config": cfg }))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn test_push_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    Json(state.send_test_push().await)
}

async fn get_session_diff_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let wt_path = {
        let guard = state.inner.read().await;
        match guard.sessions.get(&id) {
            Some(s) => PathBuf::from(&s.worktree_path),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Session not found" })),
                )
                    .into_response();
            }
        }
    };

    let stats = WorktreeManager::compute_diff_stats(&wt_path)
        .await
        .unwrap_or_default();
    let diff = WorktreeManager::get_unified_diff(&wt_path)
        .await
        .unwrap_or_default();

    (
        StatusCode::OK,
        Json(json!({
            "session_id": id,
            "stats": stats,
            "diff": diff,
        })),
    )
        .into_response()
}

async fn list_worktree_files_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let wt_path = {
        let guard = state.inner.read().await;
        match guard.sessions.get(&id) {
            Some(s) => PathBuf::from(&s.worktree_path),
            None => fallback_workspace_dir(),
        }
    };

    let output = Command::new("git")
        .args(["ls-files"])
        .current_dir(&wt_path)
        .output()
        .await;

    let files: Vec<String> = match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .take(150)
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    };

    (StatusCode::OK, Json(json!({ "files": files }))).into_response()
}

#[derive(serde::Deserialize)]
struct ExecCommandRequest {
    command: String,
}

async fn exec_in_worktree_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<ExecCommandRequest>,
) -> impl IntoResponse {
    let wt_path = {
        let guard = state.inner.read().await;
        match guard.sessions.get(&id) {
            Some(s) => PathBuf::from(&s.worktree_path),
            None => fallback_workspace_dir(),
        }
    };

    let output = Command::new("sh")
        .arg("-c")
        .arg(&req.command)
        .current_dir(&wt_path)
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let code = out.status.code().unwrap_or(0);

            if let Ok(stats) = WorktreeManager::compute_diff_stats(&wt_path).await {
                let mut guard = state.inner.write().await;
                if let Some(s) = guard.sessions.get_mut(&id) {
                    s.diff_stats = stats.clone();
                    s.updated_at = Utc::now();
                }
            }
            let _ = state.persist_sessions().await;

            (
                StatusCode::OK,
                Json(json!({
                    "stdout": stdout,
                    "stderr": stderr,
                    "exit_code": code,
                    "worktree_path": wt_path,
                })),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

fn truncate_events_at_user_turn(events: &mut Vec<AgentEvent>, user_turn_idx: usize) {
    let mut seen_users = 0usize;
    let mut cut_index = None;
    for (i, ev) in events.iter().enumerate() {
        if matches!(ev, AgentEvent::UserMessage { .. }) {
            if seen_users == user_turn_idx {
                cut_index = Some(i);
                break;
            }
            seen_users += 1;
        }
    }
    if let Some(idx) = cut_index {
        events.truncate(idx);
    } else if user_turn_idx == 0 {
        events.clear();
    }
}

fn build_conversation_transcript_prefix(
    events: &[AgentEvent],
    fallback_initial_prompt: &str,
) -> Option<String> {
    let mut turns: Vec<String> = Vec::new();
    let mut has_user_event = false;
    for ev in events {
        match ev {
            AgentEvent::UserMessage { text, .. } => {
                has_user_event = true;
                if !text.trim().is_empty() {
                    turns.push(format!("User: {}", text.trim()));
                }
            }
            AgentEvent::MessageDelta { text, .. } => {
                if !text.trim().is_empty() {
                    turns.push(format!("Assistant: {}", text.trim()));
                }
            }
            _ => {}
        }
    }
    if !has_user_event && !fallback_initial_prompt.trim().is_empty() && !turns.is_empty() {
        turns.insert(0, format!("User: {}", fallback_initial_prompt.trim()));
    }
    if turns.is_empty() {
        None
    } else {
        Some(turns.join("\n\n"))
    }
}

fn truncate_utf8_tail(s: &str, max_chars: usize) -> String {
    let total = s.chars().count();
    if total <= max_chars {
        return s.to_string();
    }
    let tail: String = s.chars().skip(total - max_chars).collect();
    format!("...(earlier turns omitted)...\n{}", tail)
}

fn clean_provider_badge(provider: &AgentProvider) -> &'static str {
    match provider {
        AgentProvider::Claude => "Claude",
        AgentProvider::Codex => "Codex",
        AgentProvider::Antigravity => "AGY",
        AgentProvider::Grok => "Grok",
        AgentProvider::Cursor => "Cursor",
        AgentProvider::OpenCode => "OpenCode",
        AgentProvider::Copilot => "Copilot",
        AgentProvider::Qwen => "Qwen",
        AgentProvider::Acp(_) => "ACP",
        AgentProvider::Custom(_) => "Agent",
    }
}

impl DaemonState {
    pub async fn dispatch_session_input(
        &self,
        id: Uuid,
        req: SessionInputRequest,
    ) -> Result<Value> {
        if req.mode.as_deref() == Some("queue") {
            let mut enqueued_len: Option<usize> = None;
            {
                let mut guard = self.inner.write().await;
                let Some(sess) = guard.sessions.get_mut(&id) else {
                    anyhow::bail!("Session not found");
                };
                if matches!(
                    sess.status,
                    SessionStatus::Starting
                        | SessionStatus::Running
                        | SessionStatus::WaitingForPermission
                ) {
                    sess.queued_prompts.push(QueuedPromptItem {
                        id: format!("q-{}", Uuid::new_v4().simple()),
                        input: req.input.clone(),
                        images: req.images.clone(),
                        model: req.model.clone(),
                        effort: req.effort.clone(),
                        created_at: Utc::now(),
                    });
                    sess.updated_at = Utc::now();
                    enqueued_len = Some(sess.queued_prompts.len());
                }
            }
            if let Some(qlen) = enqueued_len {
                let _ = self.persist_sessions().await;
                return Ok(json!({
                    "ok": true,
                    "queued": true,
                    "queue_len": qlen,
                    "session_id": id,
                }));
            }
        }

        let mut stopped_active_handle = false;
        let (existing_session, prior_transcript, parent_handoff_context) = {
            let mut guard = self.inner.write().await;
            if let Some(mut old_handle) = guard.handles.remove(&id) {
                old_handle.stop();
                stopped_active_handle = true;
            }
            if let Some(turn_idx) = req.truncate_to_user_turn {
                if let Some(ev_list) = guard.event_history.get_mut(&id) {
                    truncate_events_at_user_turn(ev_list, turn_idx);
                }
                if let Some(s) = guard.sessions.get_mut(&id) {
                    s.provider_session_id = None;
                }
            } else if req.reset_thread {
                if let Some(s) = guard.sessions.get_mut(&id) {
                    s.provider_session_id = None;
                }
            }
            let sess = guard.sessions.get(&id).cloned();
            let transcript = sess.as_ref().and_then(|s| {
                let evs = guard.event_history.get(&id).map(|v| v.as_slice()).unwrap_or(&[]);
                build_conversation_transcript_prefix(evs, &s.prompt)
            });
            let parent_ctx = if transcript.is_none() {
                sess.as_ref()
                    .and_then(|s| s.parent_session_id)
                    .and_then(|pid| {
                        let ps = guard.sessions.get(&pid)?;
                        let pevs = guard
                            .event_history
                            .get(&pid)
                            .map(|v| v.as_slice())
                            .unwrap_or(&[]);
                        let ptr = build_conversation_transcript_prefix(pevs, &ps.prompt);
                        let mut parts: Vec<String> = vec![format!(
                            "[Context handed off from {} session \"{}\"]",
                            clean_provider_badge(&ps.provider),
                            ps.name
                        )];
                        if !ps.diff_stats.modified_files.is_empty() {
                            parts.push(format!(
                                "Modified files ({}): {}",
                                ps.diff_stats.files_changed,
                                ps.diff_stats.modified_files.join(", ")
                            ));
                        }
                        if let Some(t) = ptr {
                            parts.push(truncate_utf8_tail(&t, 6000));
                        }
                        Some(parts.join("\n"))
                    })
            } else {
                None
            };
            (sess, transcript, parent_ctx)
        };

        let Some(session) = existing_session else {
            anyhow::bail!("Session not found");
        };

        if stopped_active_handle {
            // Allow killed child process exit event to settle before starting steered turn
            tokio::time::sleep(std::time::Duration::from_millis(90)).await;
        }

        let is_engine_bound = req.truncate_to_user_turn.is_none()
            && !req.reset_thread
            && (session.provider_session_id.is_some() || prior_transcript.is_some());

        let (target_provider, effective_model) = if is_engine_bound {
            let provider_conflict = req
                .provider
                .as_ref()
                .map(|p| p != &session.provider)
                .unwrap_or(false);
            let chosen_model = if provider_conflict {
                session.model.clone()
            } else {
                req.model.clone().or_else(|| session.model.clone())
            };
            (session.provider.clone(), chosen_model)
        } else {
            let inferred_prov = req.provider.clone().unwrap_or_else(|| {
                if let Some(ref m) = req.model {
                    let ml = m.to_lowercase();
                    if ml.starts_with("gemini-") || ml.starts_with("gpt-oss-") || ml == "agy" {
                        return AgentProvider::Antigravity;
                    }
                    if ml.starts_with("grok-") || ml == "grok" {
                        return AgentProvider::Grok;
                    }
                    if ml.starts_with("cursor:") || ml == "cursor" || ml == "cursor-agent" {
                        return AgentProvider::Cursor;
                    }
                    if ml.starts_with("claude-") {
                        return AgentProvider::Claude;
                    }
                    if ml.starts_with("gpt-") || ml.starts_with("o3") || ml.starts_with("o4") {
                        return AgentProvider::Codex;
                    }
                }
                session.provider.clone()
            });
            let chosen_model = req.model.clone().or_else(|| session.model.clone());
            (inferred_prov, chosen_model)
        };

        let can_resume_native = req.truncate_to_user_turn.is_none()
            && !req.reset_thread
            && target_provider == session.provider;
        let resume_session_id = if can_resume_native {
            session.provider_session_id.clone()
        } else {
            None
        };

        let user_ev = AgentEvent::UserMessage {
            session_id: id,
            text: req.input.clone(),
            images: req.images.clone(),
            timestamp: Utc::now(),
        };
        {
            let mut guard = self.inner.write().await;
            let (base_out, base_cost) = guard
                .sessions
                .get(&id)
                .map(|s| (s.output_tokens, s.cost_usd))
                .unwrap_or((0, 0.0));
            guard
                .live_turns
                .insert(id, LiveTurnMetrics::new(base_out, base_cost));
            guard
                .event_history
                .entry(id)
                .or_default()
                .push(user_ev.clone());
        }
        if req.truncate_to_user_turn.is_some() {
            let _ = self.persist_session_events(id).await;
        } else {
            let _ = self.db.append_event(id, &user_ev);
        }
        let _ = self.event_tx.send(user_ev);

        let effective_prompt = if resume_session_id.is_some() {
            req.input.clone()
        } else if let Some(history) = prior_transcript.as_ref() {
            format!(
                "{}\n\n---\n[Prior conversation context in this session]\n{}",
                req.input,
                truncate_utf8_tail(history, 6000)
            )
        } else if let Some(parent_ctx) = parent_handoff_context {
            format!("{}\n\n---\n{}", req.input, parent_ctx)
        } else {
            req.input.clone()
        };

        let effective_approval = req
            .approval_mode
            .clone()
            .unwrap_or_else(|| session.approval_mode.clone());
        let wt_path =
            velo_worktree::ensure_usable_workspace_dir(Path::new(&session.worktree_path)).await;
        let healed_wt_str = wt_path.to_string_lossy().to_string();
        if healed_wt_str != session.worktree_path {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&id) {
                if s.repo_root == s.worktree_path {
                    s.repo_root = healed_wt_str.clone();
                }
                s.worktree_path = healed_wt_str;
            }
        }

        let effective_effort = req.effort.clone().or_else(|| session.effort.clone());

        // Capture lightweight non-invasive Git checkpoint before agent mutates files
        {
            let cp_wt = wt_path.clone();
            let cp_prompt = req.input.clone();
            let _ = tokio::task::spawn_blocking(move || {
                checkpoints::capture_turn_checkpoint(id, &cp_wt, &cp_prompt)
            })
            .await;
        }

        // Attempt 0ms hot turn dispatch via warm persistent process pool (Claude / Antigravity / Codex)
        if !stopped_active_handle && req.truncate_to_user_turn.is_none() && !req.reset_thread {
            let mut warm_candidate = {
                let mut guard = self.inner.write().await;
                guard.warm_handles.remove(&id)
            };
            if let Some(mut warm) = warm_candidate.take() {
                let can_reuse_warm = warm.handle.is_alive()
                    && warm.provider == target_provider
                    && warm.approval_mode == effective_approval
                    && (target_provider == AgentProvider::Codex
                        || (warm.model == effective_model && warm.effort == effective_effort));
                if can_reuse_warm
                    && warm
                        .handle
                        .try_send_warm_turn(
                            &req.input,
                            &req.images,
                            effective_model.as_deref(),
                            effective_effort.as_deref(),
                        )
                        .await
                {
                    let pid = warm.handle.pid;
                    {
                        let mut guard = self.inner.write().await;
                        if let Some(s) = guard.sessions.get_mut(&id) {
                            if effective_model.is_some() {
                                s.model = effective_model;
                            }
                            if effective_effort.is_some() {
                                s.effort = effective_effort;
                            }
                            s.status = SessionStatus::Running;
                            s.pid = pid;
                            s.updated_at = Utc::now();
                        }
                        guard.handles.insert(id, warm.handle);
                    }
                    let _ = self.persist_sessions().await;
                    return Ok(json!({
                        "ok": true,
                        "session_id": id,
                        "warm_reused": true,
                    }));
                } else {
                    warm.handle.stop();
                }
            }
        } else {
            let mut guard = self.inner.write().await;
            if let Some(mut wh) = guard.warm_handles.remove(&id) {
                wh.handle.stop();
            }
        }

        let (spawn_model, spawn_effort) = resolve_cli_model_for_spawn(
            &target_provider,
            effective_model.clone(),
            effective_effort.clone(),
        )
        .await;
        let new_handle = match AgentSpawner::spawn_agent_turn_configured(
            id,
            target_provider.clone(),
            effective_prompt,
            wt_path,
            false,
            spawn_model,
            spawn_effort,
            resume_session_id.clone(),
            req.images.clone(),
            effective_approval.clone(),
            self.daemon_http_base.clone(),
            self.agent_event_tx.clone(),
        )
        .await
        {
            Ok(h) => h,
            Err(err) => {
                self.mark_session_spawn_failed(id, &err.to_string()).await;
                return Err(err);
            }
        };

        let pid = new_handle.pid;
        {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&id) {
                if s.provider != target_provider {
                    s.provider_session_id = None;
                }
                s.provider = target_provider;
                if effective_model.is_some() {
                    s.model = effective_model;
                }
                if req.effort.is_some() {
                    s.effort = req.effort.clone();
                }
                if prior_transcript.is_none()
                    && (s.name == "New thread" || s.prompt.trim().is_empty())
                    && !req.input.trim().is_empty()
                {
                    let first_line = req.input.lines().next().unwrap_or("").trim();
                    if !first_line.is_empty() {
                        let clean_title: String = first_line.chars().take(44).collect();
                        if s.parent_session_id.is_none() {
                            s.name = clean_title;
                        }
                        s.prompt = req.input.clone();
                    }
                }
                s.approval_mode = effective_approval;
                s.status = SessionStatus::Running;
                s.pid = pid;
                s.updated_at = Utc::now();
            }
            guard.handles.insert(id, new_handle);
        }
        let _ = self.persist_sessions().await;
        Ok(json!({
            "ok": true,
            "mode": if resume_session_id.is_some() { "resumed_turn" } else { "spawned_turn" },
            "pid": pid,
            "resumed_thread_id": resume_session_id,
        }))
    }

    pub async fn handoff_session(
        &self,
        id: Uuid,
        req: HandoffSessionRequest,
    ) -> Result<SessionInfo> {
        let source_session = {
            let guard = self.inner.read().await;
            guard
                .sessions
                .get(&id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Source session not found"))?
        };

        let stripped_base = source_session
            .name
            .split(" · ")
            .next()
            .unwrap_or(&source_session.name)
            .trim();
        let base_title = if stripped_base.is_empty() || stripped_base == "New thread" {
            let fallback_line = source_session.prompt.lines().next().unwrap_or("").trim();
            if fallback_line.is_empty() {
                "Session".to_string()
            } else {
                fallback_line.chars().take(36).collect()
            }
        } else {
            stripped_base.chars().take(36).collect()
        };

        let target_badge = clean_provider_badge(&req.target_provider);
        let handoff_title = format!("{} · {}", base_title, target_badge);

        let new_session_id = Uuid::new_v4();
        let created = self
            .spawn_in_existing_worktree_with_mode(
                new_session_id,
                Some(handoff_title),
                req.target_provider.clone(),
                String::new(),
                PathBuf::from(&source_session.repo_root),
                PathBuf::from(&source_session.worktree_path),
                source_session.branch.clone(),
                false,
                Some(source_session.id),
                req.model.clone(),
                req.effort.clone().or_else(|| source_session.effort.clone()),
                Vec::new(),
                source_session.approval_mode.clone(),
            )
            .await?;

        if let Some(extra) = req
            .additional_instructions
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            let _ = self
                .dispatch_session_input(
                    created.id,
                    SessionInputRequest {
                        input: extra,
                        model: req.model,
                        effort: req.effort.or(source_session.effort),
                        provider: Some(req.target_provider),
                        reset_thread: false,
                        truncate_to_user_turn: None,
                        images: Vec::new(),
                        approval_mode: Some(source_session.approval_mode),
                        mode: None,
                    },
                )
                .await?;
            let guard = self.inner.read().await;
            if let Some(updated) = guard.sessions.get(&created.id).cloned() {
                return Ok(updated);
            }
        }

        Ok(created)
    }

    pub async fn remove_queued_prompt_core(&self, id: Uuid, queue_id: &str) -> Value {
        let mut removed = false;
        {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&id) {
                let prev_len = s.queued_prompts.len();
                s.queued_prompts.retain(|q| q.id != queue_id);
                removed = s.queued_prompts.len() != prev_len;
                if removed {
                    s.updated_at = Utc::now();
                }
            }
        }
        if removed {
            let _ = self.persist_sessions().await;
        }
        json!({ "ok": removed, "session_id": id, "queue_id": queue_id })
    }

    pub async fn list_checkpoints_core(&self, session_id: Uuid) -> Vec<checkpoints::TurnCheckpointDto> {
        tokio::task::spawn_blocking(move || checkpoints::list_checkpoints(session_id))
            .await
            .unwrap_or_default()
    }

    pub async fn rewind_checkpoint_core(
        &self,
        session_id: Uuid,
        checkpoint_id: String,
    ) -> Result<(checkpoints::TurnCheckpointDto, Vec<checkpoints::TurnCheckpointDto>)> {
        let wt_path = {
            let guard = self.inner.read().await;
            let Some(s) = guard.sessions.get(&session_id) else {
                anyhow::bail!("Session not found");
            };
            PathBuf::from(&s.worktree_path)
        };
        let cp_id = checkpoint_id.clone();
        let wt_clone = wt_path.clone();
        let restored = tokio::task::spawn_blocking(move || {
            checkpoints::rewind_to_checkpoint(session_id, &cp_id, &wt_clone)
        })
        .await??;

        let fresh_diff = WorktreeManager::compute_diff_stats(&wt_path).await.unwrap_or_default();
        let note_ev = AgentEvent::MessageDelta {
            session_id,
            text: format!(
                "↩️ **已回滚工作区代码至第 {} 轮检查点**（`{}` · `{}`）。",
                restored.turn_index, restored.head_short, restored.prompt_preview
            ),
            timestamp: Utc::now(),
        };
        {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&session_id) {
                s.diff_stats = fresh_diff.clone();
                s.updated_at = Utc::now();
            }
            guard.event_history.entry(session_id).or_default().push(note_ev.clone());
        }
        let _ = self.db.append_event(session_id, &note_ev);
        let _ = self.event_tx.send(note_ev);
        let _ = self.event_tx.send(AgentEvent::DiffUpdated {
            session_id,
            stats: fresh_diff,
            timestamp: Utc::now(),
        });
        let _ = self.persist_sessions().await;

        let updated_list = self.list_checkpoints_core(session_id).await;
        Ok((restored, updated_list))
    }

    pub async fn get_extensions_dto(&self) -> Value {
        let snap = tokio::task::spawn_blocking(extensions::scan_local_extensions)
            .await
            .unwrap_or(extensions::LocalExtensionsSnapshotDto {
                mcp_servers: Vec::new(),
                skills: Vec::new(),
            });
        json!({
            "ok": true,
            "mcp_servers": snap.mcp_servers,
            "skills": snap.skills,
        })
    }

    pub async fn list_cli_sessions_core(&self) -> cli_sessions::ExternalCliSessionsSnapshot {
        let existing_map: HashMap<String, Uuid> = {
            let guard = self.inner.read().await;
            guard
                .sessions
                .values()
                .filter_map(|s| s.provider_session_id.as_ref().map(|psid| (psid.clone(), s.id)))
                .collect()
        };
        tokio::task::spawn_blocking(move || {
            cli_sessions::discover_external_cli_sessions_with_stats(&existing_map, 50)
        })
        .await
        .unwrap_or(cli_sessions::ExternalCliSessionsSnapshot {
            sessions: Vec::new(),
            ephemeral_count: 0,
            hidden_count: 0,
        })
    }

    pub async fn manage_cli_sessions_core(
        &self,
        action: String,
        items: Vec<(String, String)>,
    ) -> Result<(usize, cli_sessions::ExternalCliSessionsSnapshot)> {
        let affected = tokio::task::spawn_blocking(move || {
            cli_sessions::manage_external_cli_sessions(&action, &items)
        })
        .await??;
        let snap = self.list_cli_sessions_core().await;
        Ok((affected, snap))
    }

    pub async fn import_cli_session_core(
        &self,
        provider_str: &str,
        cli_session_id: &str,
    ) -> Result<SessionInfo> {
        let existing_velo_id = {
            let guard = self.inner.read().await;
            guard
                .sessions
                .values()
                .find(|s| s.provider_session_id.as_deref() == Some(cli_session_id.trim()))
                .map(|s| s.id)
        };
        let target_id = existing_velo_id.unwrap_or_else(Uuid::new_v4);
        let p_str = provider_str.to_string();
        let c_sid = cli_session_id.to_string();

        let parsed = tokio::task::spawn_blocking(move || {
            cli_sessions::load_external_cli_session(&p_str, &c_sid, target_id)
        })
        .await??;

        let canonical_cwd = canonical_workspace_path(&parsed.cwd);
        let wt_path = PathBuf::from(&canonical_cwd);
        let branch = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&wt_path)
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "main".to_string());
        let diff_stats = WorktreeManager::compute_diff_stats(&wt_path)
            .await
            .unwrap_or_default();

        let default_model = match parsed.provider {
            AgentProvider::Codex => Some("gpt-5.4".to_string()),
            _ => Some("claude-fable-5-2".to_string()),
        };

        let mut ws_added = false;
        let out_session = {
            let mut guard = self.inner.write().await;
            if !guard.workspaces.contains(&canonical_cwd) {
                guard.workspaces.push(canonical_cwd.clone());
                ws_added = true;
            }
            if let Some(existing) = guard.sessions.get_mut(&target_id) {
                existing.name = parsed.title.clone();
                existing.updated_at = parsed.updated_at;
                existing.diff_stats = diff_stats;
                let s_clone = existing.clone();
                guard.event_history.insert(target_id, parsed.events.clone());
                s_clone
            } else {
                let s = SessionInfo {
                    id: target_id,
                    name: parsed.title,
                    provider: parsed.provider,
                    prompt: parsed.first_prompt,
                    repo_root: canonical_cwd.clone(),
                    worktree_path: canonical_cwd,
                    branch,
                    status: SessionStatus::Completed,
                    pid: None,
                    diff_stats,
                    created_at: parsed.updated_at,
                    updated_at: Utc::now(),
                    parent_session_id: None,
                    provider_session_id: Some(parsed.cli_session_id),
                    model: default_model,
                    effort: Some("high".to_string()),
                    tokens_used: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    context_window: 0,
                    cost_usd: 0.0,
                    approval_mode: default_approval_mode(),
                    preview_url: None,
                    queued_prompts: Vec::new(),
                    archived: false,
                };
                guard.sessions.insert(target_id, s.clone());
                guard.event_history.insert(target_id, parsed.events.clone());
                s
            }
        };

        let _ = self.db.replace_session_events(target_id, &parsed.events);
        if ws_added {
            let _ = self.persist_workspaces().await;
        }
        let _ = self.persist_sessions().await;
        Ok(out_session)
    }

    pub async fn archive_session_core(&self, id: Uuid, archived: bool) -> Result<SessionInfo> {
        let mut clean_wt_to_prune: Option<(PathBuf, PathBuf)> = None;
        let updated = {
            let mut guard = self.inner.write().await;
            if archived {
                if let Some(mut h) = guard.handles.remove(&id) {
                    h.stop();
                }
                if let Some(mut wh) = guard.warm_handles.remove(&id) {
                    wh.handle.stop();
                }
            }
            let Some(s) = guard.sessions.get_mut(&id) else {
                anyhow::bail!("Session not found");
            };
            s.archived = archived;
            s.updated_at = Utc::now();
            if archived
                && s.worktree_path != s.repo_root
                && s.worktree_path.contains("/.velo/worktrees/")
                && s.diff_stats.files_changed == 0
            {
                clean_wt_to_prune = Some((PathBuf::from(&s.repo_root), PathBuf::from(&s.worktree_path)));
                s.worktree_path = s.repo_root.clone();
            }
            s.clone()
        };

        if let Some((repo_p, wt_p)) = clean_wt_to_prune {
            let _ = Command::new("git")
                .args(["worktree", "remove", "--force", &wt_p.to_string_lossy()])
                .current_dir(&repo_p)
                .output()
                .await;
        }
        let _ = self.persist_sessions().await;
        Ok(updated)
    }

    pub async fn fork_session_core(
        &self,
        source_id: Uuid,
        up_to_user_turn: Option<usize>,
        custom_title: Option<String>,
    ) -> Result<SessionInfo> {
        let (src, mut cloned_events) = {
            let guard = self.inner.read().await;
            let Some(s) = guard.sessions.get(&source_id).cloned() else {
                anyhow::bail!("Source session not found");
            };
            let evs = guard
                .event_history
                .get(&source_id)
                .cloned()
                .unwrap_or_default();
            (s, evs)
        };

        if let Some(limit_turn) = up_to_user_turn {
            // Keep events up through the `limit_turn`-th user turn and its reply
            truncate_events_at_user_turn(&mut cloned_events, limit_turn.saturating_add(1));
        }

        let new_id = Uuid::new_v4();
        for ev in &mut cloned_events {
            match ev {
                AgentEvent::StatusChanged { session_id, .. }
                | AgentEvent::UserMessage { session_id, .. }
                | AgentEvent::ProviderSessionBound { session_id, .. }
                | AgentEvent::ThinkingChunk { session_id, .. }
                | AgentEvent::ThinkingDelta { session_id, .. }
                | AgentEvent::MessageChunk { session_id, .. }
                | AgentEvent::MessageDelta { session_id, .. }
                | AgentEvent::UsageUpdated { session_id, .. }
                | AgentEvent::RateLimitsUpdated { session_id, .. }
                | AgentEvent::TerminalOutput { session_id, .. }
                | AgentEvent::ToolCallRequested { session_id, .. }
                | AgentEvent::ToolCallCompleted { session_id, .. }
                | AgentEvent::PermissionRequested { session_id, .. }
                | AgentEvent::PermissionResolved { session_id, .. }
                | AgentEvent::UserQuestionRequested { session_id, .. }
                | AgentEvent::UserQuestionAnswered { session_id, .. }
                | AgentEvent::BrowserCommand { session_id, .. }
                | AgentEvent::SetupHookOutput { session_id, .. }
                | AgentEvent::PtyOutput { session_id, .. }
                | AgentEvent::DiffUpdated { session_id, .. }
                | AgentEvent::Error { session_id, .. } => {
                    *session_id = new_id;
                }
            }
        }

        let now = Utc::now();
        let fork_title = custom_title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| format!("Fork · {}", src.name));

        let forked = SessionInfo {
            id: new_id,
            name: fork_title,
            provider: src.provider.clone(),
            prompt: src.prompt.clone(),
            repo_root: src.repo_root.clone(),
            worktree_path: src.worktree_path.clone(),
            branch: src.branch.clone(),
            status: SessionStatus::Completed,
            pid: None,
            diff_stats: src.diff_stats.clone(),
            created_at: now,
            updated_at: now,
            parent_session_id: Some(source_id),
            // Clear provider_session_id so next turn reconstructs exact forked transcript without mutating parent's CLI thread!
            provider_session_id: None,
            model: src.model.clone(),
            effort: src.effort.clone(),
            tokens_used: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            context_window: src.context_window,
            cost_usd: 0.0,
            approval_mode: src.approval_mode.clone(),
            preview_url: None,
            queued_prompts: Vec::new(),
            archived: false,
        };

        {
            let mut guard = self.inner.write().await;
            guard.sessions.insert(new_id, forked.clone());
            guard.event_history.insert(new_id, cloned_events.clone());
        }
        let _ = self.db.replace_session_events(new_id, &cloned_events);
        let _ = self.persist_sessions().await;
        Ok(forked)
    }

    pub async fn get_quotas_dto(&self) -> Value {
        self.get_quotas_dto_opts(false).await
    }

    pub async fn get_quotas_dto_opts(&self, force_refresh: bool) -> Value {
        let cache_snap = {
            let guard = self.inner.read().await;
            guard.quota_cache.clone()
        };
        let cards = tokio::task::spawn_blocking(move || {
            quota::build_subscription_quotas_snapshot_opts(&cache_snap, force_refresh)
        })
        .await
        .unwrap_or_default();
        json!({ "ok": true, "providers": cards })
    }

    pub async fn list_hosts_dto(&self) -> Value {
        let remote = {
            let guard = self.inner.read().await;
            guard.remote_hosts.clone()
        };
        let mut all = vec![hosts::local_host_summary_json()];
        for h in remote {
            if let Ok(v) = serde_json::to_value(h) {
                all.push(v);
            }
        }
        json!({ "ok": true, "hosts": all })
    }

    pub async fn add_remote_host_core(
        &self,
        label: &str,
        ssh_target: &str,
        default_cwd: Option<&str>,
        prefer_hush: bool,
    ) -> Result<hosts::RemoteHostNode> {
        if ssh_target.trim().is_empty() {
            anyhow::bail!("SSH target cannot be empty");
        }
        let created = hosts::create_host_node(label, ssh_target, default_cwd, prefer_hush);
        let probed = hosts::probe_ssh_host(created).await;
        {
            let mut guard = self.inner.write().await;
            guard.remote_hosts.retain(|h| h.ssh_target != probed.ssh_target);
            guard.remote_hosts.push(probed.clone());
            hosts::save_remote_hosts(&self.hosts_file, &guard.remote_hosts);
        }
        Ok(probed)
    }

    pub async fn remove_remote_host_core(&self, host_id: &str) -> bool {
        let mut guard = self.inner.write().await;
        let before = guard.remote_hosts.len();
        guard.remote_hosts.retain(|h| h.id != host_id);
        let changed = guard.remote_hosts.len() != before;
        if changed {
            hosts::save_remote_hosts(&self.hosts_file, &guard.remote_hosts);
        }
        changed
    }

    pub async fn probe_remote_host_core(&self, host_id: &str) -> Option<hosts::RemoteHostNode> {
        let existing = {
            let guard = self.inner.read().await;
            guard.remote_hosts.iter().find(|h| h.id == host_id).cloned()
        }?;
        let updated = hosts::probe_ssh_host(existing).await;
        {
            let mut guard = self.inner.write().await;
            if let Some(slot) = guard.remote_hosts.iter_mut().find(|h| h.id == host_id) {
                *slot = updated.clone();
            }
            hosts::save_remote_hosts(&self.hosts_file, &guard.remote_hosts);
        }
        Some(updated)
    }

    pub async fn dispatch_ssh_host_session_core(
        &self,
        host_id: &str,
        provider_str: &str,
        prompt: &str,
        remote_cwd: Option<&str>,
    ) -> Result<SessionInfo> {
        let host = {
            let guard = self.inner.read().await;
            guard
                .remote_hosts
                .iter()
                .find(|h| h.id == host_id)
                .cloned()
        }
        .ok_or_else(|| anyhow::anyhow!("Remote SSH host not found"))?;

        let cwd = remote_cwd
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&host.default_cwd)
            .to_string();
        let prov = AgentProvider::from_str_loose(provider_str);
        let sid = Uuid::new_v4();
        let now = Utc::now();
        let short_title: String = prompt.trim().chars().take(42).collect();
        let sess_name = format!("[{}] {}", host.label, if short_title.is_empty() { "SSH 任务" } else { &short_title });
        let repo_tag = format!("ssh://{}/{}", host.ssh_target, cwd.trim_start_matches('/'));

        let sess = SessionInfo {
            id: sid,
            name: sess_name,
            provider: prov.clone(),
            prompt: prompt.to_string(),
            repo_root: repo_tag.clone(),
            worktree_path: repo_tag,
            branch: host.ssh_target.clone(),
            status: SessionStatus::Running,
            pid: None,
            diff_stats: Default::default(),
            created_at: now,
            updated_at: now,
            parent_session_id: None,
            provider_session_id: None,
            model: None,
            effort: Some("high".to_string()),
            tokens_used: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            context_window: 0,
            cost_usd: 0.0,
            approval_mode: default_approval_mode(),
            preview_url: None,
            queued_prompts: Vec::new(),
            archived: false,
        };

        let user_ev = AgentEvent::UserMessage {
            session_id: sid,
            text: prompt.to_string(),
            images: Vec::new(),
            timestamp: now,
        };

        {
            let mut guard = self.inner.write().await;
            guard.sessions.insert(sid, sess.clone());
            guard.event_history.insert(sid, vec![user_ev.clone()]);
            guard.live_turns.insert(sid, LiveTurnMetrics::new(0, 0.0));
        }
        let _ = self.db.append_event(sid, &user_ev);
        let _ = self.persist_sessions().await;
        let _ = self.event_tx.send(user_ev);

        let quoted_prompt = hosts::shell_quote_single(prompt);
        let remote_cmd = match prov {
            AgentProvider::Codex => format!(
                "cd {} 2>/dev/null || true; if command -v codex >/dev/null 2>&1; then codex exec --skip-git-repo-check {}; else echo 'Codex CLI not installed on remote host'; exit 1; fi",
                cwd, quoted_prompt
            ),
            AgentProvider::Claude => format!(
                "cd {} 2>/dev/null || true; if command -v claude >/dev/null 2>&1; then claude -p --permission-mode acceptEdits {}; else echo 'Claude CLI not installed on remote host'; exit 1; fi",
                cwd, quoted_prompt
            ),
            AgentProvider::Antigravity => format!(
                "cd {} 2>/dev/null || true; if command -v agy >/dev/null 2>&1; then agy -p {} --dangerously-skip-permissions; else echo 'Antigravity CLI (agy) not installed on remote host'; exit 1; fi",
                cwd, quoted_prompt
            ),
            AgentProvider::Cursor => format!(
                "cd {} 2>/dev/null || true; if command -v cursor-agent >/dev/null 2>&1; then cursor-agent -p --force {}; else echo 'Cursor Agent CLI not installed on remote host'; exit 1; fi",
                cwd, quoted_prompt
            ),
            _ => format!("cd {} 2>/dev/null || true; {}", cwd, prompt),
        };

        let tx = self.agent_event_tx.clone();
        tokio::spawn(async move {
            let mut cmd = hosts::build_ssh_command(&host, &remote_cmd);
            match cmd.output().await {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    let combined = if !stdout.is_empty() && !stderr.is_empty() {
                        format!("{}\n\n```\n{}\n```", stdout, stderr)
                    } else if !stdout.is_empty() {
                        stdout
                    } else {
                        stderr
                    };
                    if !combined.is_empty() {
                        let _ = tx.send(AgentEvent::MessageDelta {
                            session_id: sid,
                            text: combined,
                            timestamp: Utc::now(),
                        });
                    }
                    let _ = tx.send(AgentEvent::StatusChanged {
                        session_id: sid,
                        status: if out.status.success() {
                            SessionStatus::Completed
                        } else {
                            SessionStatus::Failed
                        },
                        message: None,
                        timestamp: Utc::now(),
                    });
                }
                Err(err) => {
                    let _ = tx.send(AgentEvent::Error {
                        session_id: sid,
                        error: format!("SSH dispatch failed: {}", err),
                        timestamp: Utc::now(),
                    });
                    let _ = tx.send(AgentEvent::StatusChanged {
                        session_id: sid,
                        status: SessionStatus::Failed,
                        message: Some(err.to_string()),
                        timestamp: Utc::now(),
                    });
                }
            }
        });

        Ok(sess)
    }
}

#[derive(serde::Deserialize)]
struct ArchiveSessionRequest {
    archived: bool,
}

async fn archive_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<ArchiveSessionRequest>,
) -> impl IntoResponse {
    match state.archive_session_core(id, req.archived).await {
        Ok(sess) => (StatusCode::OK, Json(json!({ "ok": true, "session": sess }))).into_response(),
        Err(err) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
struct ForkSessionRequest {
    up_to_user_turn: Option<usize>,
    title: Option<String>,
}

async fn fork_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<ForkSessionRequest>,
) -> impl IntoResponse {
    match state
        .fork_session_core(id, req.up_to_user_turn, req.title)
        .await
    {
        Ok(sess) => (
            StatusCode::CREATED,
            Json(json!({ "ok": true, "session": sess })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
struct QuotasQueryParams {
    refresh: Option<String>,
}

async fn quotas_analytics_handler(
    State(state): State<DaemonState>,
    axum::extract::Query(q): axum::extract::Query<QuotasQueryParams>,
) -> impl IntoResponse {
    let force = matches!(q.refresh.as_deref(), Some("1" | "true"));
    Json(state.get_quotas_dto_opts(force).await)
}

async fn list_hosts_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    Json(state.list_hosts_dto().await)
}

#[derive(serde::Deserialize)]
struct AddHostRequest {
    label: Option<String>,
    ssh_target: String,
    default_cwd: Option<String>,
    #[serde(default = "default_prefer_hush")]
    prefer_hush: bool,
}

fn default_prefer_hush() -> bool {
    true
}

async fn add_host_handler(
    State(state): State<DaemonState>,
    Json(req): Json<AddHostRequest>,
) -> impl IntoResponse {
    match state
        .add_remote_host_core(
            req.label.as_deref().unwrap_or(""),
            &req.ssh_target,
            req.default_cwd.as_deref(),
            req.prefer_hush,
        )
        .await
    {
        Ok(node) => (StatusCode::CREATED, Json(json!({ "ok": true, "host": node }))).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn remove_host_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    let ok = state.remove_remote_host_core(&id).await;
    Json(json!({ "ok": ok, "id": id }))
}

async fn probe_host_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match state.probe_remote_host_core(&id).await {
        Some(node) => (StatusCode::OK, Json(json!({ "ok": true, "host": node }))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "Host not found" })),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
struct DispatchSshHostRequest {
    #[serde(default = "default_ssh_provider")]
    provider: String,
    prompt: String,
    cwd: Option<String>,
}

fn default_ssh_provider() -> String {
    "claude".to_string()
}

async fn dispatch_ssh_host_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<DispatchSshHostRequest>,
) -> impl IntoResponse {
    match state
        .dispatch_ssh_host_session_core(&id, &req.provider, &req.prompt, req.cwd.as_deref())
        .await
    {
        Ok(sess) => (StatusCode::CREATED, Json(json!({ "ok": true, "session": sess }))).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn remove_queued_prompt_handler(
    State(state): State<DaemonState>,
    AxumPath((id, queue_id)): AxumPath<(Uuid, String)>,
) -> impl IntoResponse {
    Json(state.remove_queued_prompt_core(id, &queue_id).await)
}

async fn list_checkpoints_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let items = state.list_checkpoints_core(id).await;
    Json(json!({ "ok": true, "session_id": id, "checkpoints": items }))
}

#[derive(serde::Deserialize)]
struct RewindCheckpointRequest {
    checkpoint_id: String,
}

async fn rewind_checkpoint_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<RewindCheckpointRequest>,
) -> impl IntoResponse {
    match state.rewind_checkpoint_core(id, req.checkpoint_id).await {
        Ok((restored, list)) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "restored": restored, "checkpoints": list })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn list_extensions_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    Json(state.get_extensions_dto().await)
}

async fn list_cli_sessions_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    let snap = state.list_cli_sessions_core().await;
    Json(json!({
        "ok": true,
        "sessions": snap.sessions,
        "ephemeral_count": snap.ephemeral_count,
        "hidden_count": snap.hidden_count,
    }))
}

#[derive(serde::Deserialize)]
struct ManageCliSessionRef {
    provider: String,
    cli_session_id: String,
}

#[derive(serde::Deserialize)]
struct ManageCliSessionsRequest {
    action: String,
    #[serde(default)]
    items: Vec<ManageCliSessionRef>,
}

async fn manage_cli_sessions_handler(
    State(state): State<DaemonState>,
    Json(req): Json<ManageCliSessionsRequest>,
) -> impl IntoResponse {
    let pairs: Vec<(String, String)> = req
        .items
        .into_iter()
        .map(|it| (it.provider, it.cli_session_id))
        .collect();
    match state.manage_cli_sessions_core(req.action, pairs).await {
        Ok((affected, snap)) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "affected": affected,
                "sessions": snap.sessions,
                "ephemeral_count": snap.ephemeral_count,
                "hidden_count": snap.hidden_count,
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
struct ImportCliSessionRequest {
    provider: String,
    cli_session_id: String,
}

async fn import_cli_session_handler(
    State(state): State<DaemonState>,
    Json(req): Json<ImportCliSessionRequest>,
) -> impl IntoResponse {
    match state
        .import_cli_session_core(&req.provider, &req.cli_session_id)
        .await
    {
        Ok(sess) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "session": sess })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn send_input_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<SessionInputRequest>,
) -> impl IntoResponse {
    match state.dispatch_session_input(id, req).await {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(err) => {
            let code = if err.to_string().contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            (code, Json(json!({ "error": err.to_string() }))).into_response()
        }
    }
}

impl DaemonState {
    pub async fn get_usage_analytics_dto(&self) -> Value {
        let guard = self.inner.read().await;
        pricing::build_usage_analytics(&guard.sessions, &guard.event_history)
    }

    pub async fn get_push_config_dto(&self) -> push::PushConfig {
        let guard = self.inner.read().await;
        guard.push_config.clone()
    }

    pub async fn set_push_config_dto(&self, cfg: push::PushConfig) -> Result<()> {
        {
            let mut guard = self.inner.write().await;
            guard.push_config = cfg.clone();
        }
        push::save_push_config(&self.push_config_file, &cfg).await
    }

    pub async fn send_test_push(&self) -> Value {
        let cfg = self.get_push_config_dto().await;
        push::send_push_notification(&cfg, push::PushTriggerKind::TestPing, None, None).await
    }

    pub async fn rewind_session_core(&self, id: Uuid, truncate_to_user_turn: usize) -> Value {
        {
            let mut guard = self.inner.write().await;
            if let Some(mut handle) = guard.handles.remove(&id) {
                handle.stop();
            }
            if let Some(ev_list) = guard.event_history.get_mut(&id) {
                truncate_events_at_user_turn(ev_list, truncate_to_user_turn);
            }
            if let Some(session) = guard.sessions.get_mut(&id) {
                session.status = SessionStatus::Stopped;
                session.provider_session_id = None;
                session.updated_at = Utc::now();
            }
        }
        let _ = self.persist_session_events(id).await;
        let _ = self.persist_sessions().await;
        json!({ "ok": true, "session_id": id, "truncated_to": truncate_to_user_turn })
    }

    pub async fn git_commit_core(&self, id: Uuid, message: &str, push_remote: bool) -> Value {
        let wt_path = {
            let guard = self.inner.read().await;
            guard
                .sessions
                .get(&id)
                .map(|s| PathBuf::from(&s.worktree_path))
                .unwrap_or_else(fallback_workspace_dir)
        };
        let msg = if message.trim().is_empty() {
            "chore: commit worktree changes via Velo".to_string()
        } else {
            message.trim().to_string()
        };

        let _ = Command::new("git")
            .args(["add", "-A"])
            .current_dir(&wt_path)
            .output()
            .await;

        let commit_out = Command::new("git")
            .args(["commit", "-m", &msg])
            .current_dir(&wt_path)
            .output()
            .await;

        match commit_out {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let ok = out.status.success();
                let mut push_out_str = String::new();
                if ok && push_remote {
                    if let Ok(p_out) = Command::new("git")
                        .args(["push", "-u", "origin", "HEAD"])
                        .current_dir(&wt_path)
                        .output()
                        .await
                    {
                        push_out_str = format!(
                            "{}\n{}",
                            String::from_utf8_lossy(&p_out.stdout),
                            String::from_utf8_lossy(&p_out.stderr)
                        )
                        .trim()
                        .to_string();
                    }
                }
                let stats = WorktreeManager::compute_diff_stats(&wt_path)
                    .await
                    .unwrap_or_default();
                {
                    let mut guard = self.inner.write().await;
                    if let Some(s) = guard.sessions.get_mut(&id) {
                        s.diff_stats = stats.clone();
                        s.updated_at = Utc::now();
                    }
                }
                let _ = self.agent_event_tx.send(AgentEvent::DiffUpdated {
                    session_id: id,
                    stats: stats.clone(),
                    timestamp: Utc::now(),
                });
                let _ = self.persist_sessions().await;

                json!({
                    "ok": ok,
                    "stdout": stdout,
                    "stderr": stderr,
                    "push_output": push_out_str,
                    "stats": stats,
                })
            }
            Err(err) => json!({ "ok": false, "error": err.to_string() }),
        }
    }

    pub async fn git_discard_core(&self, id: Uuid, file_path: Option<&str>, all: bool) -> Value {
        let wt_path = {
            let guard = self.inner.read().await;
            guard
                .sessions
                .get(&id)
                .map(|s| PathBuf::from(&s.worktree_path))
                .unwrap_or_else(fallback_workspace_dir)
        };

        if all {
            let _ = Command::new("git")
                .args(["reset", "--hard", "HEAD"])
                .current_dir(&wt_path)
                .output()
                .await;
            let _ = Command::new("git")
                .args(["clean", "-fd"])
                .current_dir(&wt_path)
                .output()
                .await;
        } else if let Some(fp) = file_path.filter(|s| !s.trim().is_empty()) {
            let _ = Command::new("git")
                .args(["checkout", "HEAD", "--", fp])
                .current_dir(&wt_path)
                .output()
                .await;
            let _ = Command::new("git")
                .args(["clean", "-fd", "--", fp])
                .current_dir(&wt_path)
                .output()
                .await;
        }

        let stats = WorktreeManager::compute_diff_stats(&wt_path)
            .await
            .unwrap_or_default();
        {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&id) {
                s.diff_stats = stats.clone();
                s.updated_at = Utc::now();
            }
        }
        let _ = self.agent_event_tx.send(AgentEvent::DiffUpdated {
            session_id: id,
            stats: stats.clone(),
            timestamp: Utc::now(),
        });
        let _ = self.persist_sessions().await;

        json!({ "ok": true, "stats": stats })
    }

    pub async fn git_merge_core(&self, id: Uuid) -> Value {
        let session = {
            let guard = self.inner.read().await;
            guard.sessions.get(&id).cloned()
        };
        let Some(s) = session else {
            return json!({ "ok": false, "error": "Session not found" });
        };

        let wt_path = PathBuf::from(&s.worktree_path);
        let repo_root = PathBuf::from(&s.repo_root);

        if let Ok(st) = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&wt_path)
            .output()
            .await
        {
            if !String::from_utf8_lossy(&st.stdout).trim().is_empty() {
                let _ = Command::new("git")
                    .args(["add", "-A"])
                    .current_dir(&wt_path)
                    .output()
                    .await;
                let _ = Command::new("git")
                    .args([
                        "commit",
                        "-m",
                        &format!("feat({}): worktree changes from Velo session", s.branch),
                    ])
                    .current_dir(&wt_path)
                    .output()
                    .await;
            }
        }

        match Command::new("git")
            .args(["merge", "--no-edit", &s.branch])
            .current_dir(&repo_root)
            .output()
            .await
        {
            Ok(out) => json!({
                "ok": out.status.success(),
                "branch": s.branch,
                "stdout": String::from_utf8_lossy(&out.stdout).to_string(),
                "stderr": String::from_utf8_lossy(&out.stderr).to_string(),
            }),
            Err(err) => json!({ "ok": false, "error": err.to_string() }),
        }
    }

    pub async fn advisor_session_core(
        &self,
        id: Uuid,
        req: AdvisorSessionRequest,
    ) -> Result<SessionInfo> {
        let source_session = {
            let guard = self.inner.read().await;
            guard
                .sessions
                .get(&id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Target session not found"))?
        };
        let wt_path = Path::new(&source_session.worktree_path);
        let diff_stats = WorktreeManager::compute_diff_stats(wt_path)
            .await
            .unwrap_or_default();
        let focus = req.focus_question.unwrap_or_else(|| {
            "Review the current git diff for bugs, edge cases, race conditions, and architectural improvements. Do NOT modify files unless asked.".to_string()
        });
        let advisor_prompt = format!(
            "[VELO ADVISOR REVIEW for session {} ({}) on branch `{}`]\n\
             Original Task: {}\n\
             Modified Files ({}): {}\n\
             Advisor Focus: {}",
            &source_session.id.to_string()[..8],
            source_session.provider,
            source_session.branch,
            source_session.prompt,
            diff_stats.files_changed,
            diff_stats.modified_files.join(", "),
            focus
        );
        let advisor_id = Uuid::new_v4();
        let short_id = &advisor_id.to_string()[..8];
        self.spawn_in_existing_worktree(
            advisor_id,
            Some(format!("advisor-{}-{}", req.advisor_provider, short_id)),
            req.advisor_provider,
            advisor_prompt,
            PathBuf::from(&source_session.repo_root),
            PathBuf::from(&source_session.worktree_path),
            source_session.branch,
            false,
            Some(source_session.id),
            None,
            None,
            Vec::new(),
        )
        .await
    }

    pub async fn transcribe_audio_base64(
        &self,
        audio_base64: &str,
        mime_type: &str,
        language: Option<&str>,
    ) -> Value {
        let bytes = match decode_base64_payload(audio_base64) {
            Ok(b) if !b.is_empty() => b,
            _ => return json!({ "ok": false, "error": "Invalid or empty audio payload" }),
        };
        let temp_dir = self.attachments_dir.join("voice-tmp");
        voice::transcribe_audio(&temp_dir, &bytes, mime_type, language).await
    }
}

#[derive(serde::Deserialize)]
struct RewindSessionRequest {
    truncate_to_user_turn: usize,
}

async fn rewind_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<RewindSessionRequest>,
) -> impl IntoResponse {
    Json(state.rewind_session_core(id, req.truncate_to_user_turn).await)
}

#[derive(serde::Deserialize)]
struct GitCommitRequest {
    message: String,
    #[serde(default)]
    push: bool,
}

async fn git_commit_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<GitCommitRequest>,
) -> impl IntoResponse {
    let val = state.git_commit_core(id, &req.message, req.push).await;
    let ok = val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        Json(val),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
struct GitDiscardRequest {
    file_path: Option<String>,
    #[serde(default)]
    all: bool,
}

async fn git_discard_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<GitDiscardRequest>,
) -> impl IntoResponse {
    Json(
        state
            .git_discard_core(id, req.file_path.as_deref(), req.all)
            .await,
    )
}

async fn git_merge_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let val = state.git_merge_core(id).await;
    let ok = val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        Json(val),
    )
        .into_response()
}

async fn stop_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    {
        let mut guard = state.inner.write().await;
        if let Some(mut handle) = guard.handles.remove(&id) {
            handle.stop();
        }
        if let Some(session) = guard.sessions.get_mut(&id) {
            session.status = SessionStatus::Stopped;
            session.updated_at = Utc::now();
        }
    }
    let _ = state.persist_sessions().await;
    Json(json!({ "ok": true, "session_id": id }))
}

async fn handoff_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<HandoffSessionRequest>,
) -> impl IntoResponse {
    match state.handoff_session(id, req).await {
        Ok(session) => (StatusCode::CREATED, Json(json!(session))).into_response(),
        Err(err) => {
            let code = if err.to_string().contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            (code, Json(json!({ "error": err.to_string() }))).into_response()
        }
    }
}

/// Phase 3 Skill 1 (`/velo-advisor`): Spin up an independent secondary agent to review changes & provide a second opinion.
async fn advisor_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<AdvisorSessionRequest>,
) -> impl IntoResponse {
    let source_session = {
        let guard = state.inner.read().await;
        match guard.sessions.get(&id).cloned() {
            Some(s) => s,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Target session not found" })),
                )
                    .into_response();
            }
        }
    };

    let wt_path = Path::new(&source_session.worktree_path);
    let diff_stats = WorktreeManager::compute_diff_stats(wt_path)
        .await
        .unwrap_or_default();

    let focus = req.focus_question.unwrap_or_else(|| {
        "Review the current git diff for bugs, edge cases, race conditions, and architectural improvements. Do NOT modify files unless asked.".to_string()
    });

    let advisor_prompt = format!(
        "[VELO ADVISOR REVIEW for session {} ({}) on branch `{}`]\n\
         Original Task: {}\n\
         Modified Files ({}): {}\n\
         Advisor Focus: {}",
        &source_session.id.to_string()[..8],
        source_session.provider,
        source_session.branch,
        source_session.prompt,
        diff_stats.files_changed,
        diff_stats.modified_files.join(", "),
        focus
    );

    let advisor_id = Uuid::new_v4();
    let short_id = &advisor_id.to_string()[..8];
    match state
        .spawn_in_existing_worktree(
            advisor_id,
            Some(format!("advisor-{}-{}", req.advisor_provider, short_id)),
            req.advisor_provider,
            advisor_prompt,
            PathBuf::from(&source_session.repo_root),
            PathBuf::from(&source_session.worktree_path),
            source_session.branch,
            false,
            Some(source_session.id),
            None,
            None,
            Vec::new(),
        )
        .await
    {
        Ok(session) => (StatusCode::CREATED, Json(json!(session))).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

/// Phase 3 Skill 2 (`/velo-committee`): Fan out the same problem to multiple contrasting agents in separate isolated worktrees.
async fn committee_handler(
    State(state): State<DaemonState>,
    Json(req): Json<CommitteeRequest>,
) -> impl IntoResponse {
    if req.providers.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "At least one agent provider is required for a committee" })),
        )
            .into_response();
    }

    let committee_tag = &Uuid::new_v4().to_string()[..6];
    let prefix = req
        .name_prefix
        .unwrap_or_else(|| format!("committee-{}", committee_tag));

    let mut spawned = Vec::new();
    let mut errors = Vec::new();

    for (idx, provider) in req.providers.into_iter().enumerate() {
        let branch = format!("velo/{}-{}-{}", prefix, provider, idx + 1);
        let session_name = format!("{}-{}", prefix, provider);
        let create_req = CreateSessionRequest {
            name: Some(session_name),
            provider,
            prompt: req.prompt.clone(),
            repo_path: req.repo_path.clone(),
            branch: Some(branch),
            use_pty: false,
            parent_session_id: None,
            model: None,
            effort: None,
            images: Vec::new(),
            approval_mode: None,
            setup_command: None,
            use_worktree: true,
        };
        match state.create_session(create_req).await {
            Ok(s) => spawned.push(s),
            Err(e) => errors.push(e.to_string()),
        }
    }

    (
        StatusCode::CREATED,
        Json(json!({
            "committee": prefix,
            "sessions": spawned,
            "errors": errors,
        })),
    )
        .into_response()
}

/// Phase 3 Skill 3 (`/velo-loop`): Automated test-driven verification loop.
/// Runs the agent in an isolated worktree, then verifies with `check_command`.
/// If `check_command` fails, automatically re-invokes the agent with the failure output up to `max_iterations`.
async fn loop_handler(
    State(state): State<DaemonState>,
    Json(req): Json<LoopSessionRequest>,
) -> impl IntoResponse {
    let max_iters = req.max_iterations.clamp(1, 10);
    let initial_prompt = format!(
        "[VELO LOOP Iteration 1/{}]\nTask: {}\nAcceptance Check Command: `{}`",
        max_iters, req.prompt, req.check_command
    );

    let use_worktree = req.branch.is_some();
    let create_req = CreateSessionRequest {
        name: req
            .name
            .clone()
            .or_else(|| Some(format!("loop-{}", req.provider))),
        provider: req.provider.clone(),
        prompt: initial_prompt,
        repo_path: req.repo_path.clone(),
        branch: req.branch.clone(),
        use_pty: false,
        parent_session_id: None,
        model: None,
        effort: None,
        images: Vec::new(),
        approval_mode: None,
        setup_command: None,
        use_worktree,
    };

    let initial_session = match state.create_session(create_req).await {
        Ok(s) => s,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response();
        }
    };

    // Spawn background loop supervisor
    let loop_state = state.clone();
    let base_prompt = req.prompt.clone();
    let check_cmd = req.check_command.clone();
    let provider = req.provider.clone();
    let repo_root = PathBuf::from(&initial_session.repo_root);
    let wt_path = PathBuf::from(&initial_session.worktree_path);
    let branch = initial_session.branch.clone();
    let mut current_session_id = initial_session.id;

    tokio::spawn(async move {
        let mut rx = loop_state.event_tx.subscribe();
        for iter in 1..=max_iters {
            // Wait for current_session_id to finish
            loop {
                let Ok(ev) = rx.recv().await else { return };
                if ev.session_id() == current_session_id {
                    if let AgentEvent::StatusChanged { status, .. } = ev {
                        if matches!(
                            status,
                            SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Stopped
                        ) {
                            if status == SessionStatus::Stopped {
                                return;
                            }
                            break;
                        }
                    }
                }
            }

            // Execute acceptance check command inside the worktree
            let _ = loop_state.agent_event_tx.send(AgentEvent::ToolCallRequested {
                session_id: current_session_id,
                tool_id: format!("velo-check-{}", iter),
                tool_name: "velo_acceptance_check".to_string(),
                arguments: json!({ "command": check_cmd, "iteration": iter }),
                timestamp: Utc::now(),
            });

            let check_out = Command::new("sh")
                .args(["-c", &check_cmd])
                .current_dir(&wt_path)
                .output()
                .await;

            match check_out {
                Ok(out) if out.status.success() => {
                    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                    let _ = loop_state.agent_event_tx.send(AgentEvent::ToolCallCompleted {
                        session_id: current_session_id,
                        tool_id: format!("velo-check-{}", iter),
                        output: format!("✅ Acceptance check `{}` PASSED!\n{}", check_cmd, stdout),
                        is_error: false,
                        timestamp: Utc::now(),
                    });
                    return;
                }
                Ok(out) => {
                    let combined = format!(
                        "{}\n{}",
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr)
                    );
                    let _ = loop_state.agent_event_tx.send(AgentEvent::ToolCallCompleted {
                        session_id: current_session_id,
                        tool_id: format!("velo-check-{}", iter),
                        output: format!(
                            "❌ Acceptance check `{}` FAILED (iteration {}/{}):\n{}",
                            check_cmd,
                            iter,
                            max_iters,
                            combined.trim()
                        ),
                        is_error: true,
                        timestamp: Utc::now(),
                    });

                    if iter >= max_iters {
                        return;
                    }

                    // Spawn next healing iteration in the same worktree
                    let next_iter = iter + 1;
                    let next_id = Uuid::new_v4();
                    let healing_prompt = format!(
                        "[VELO LOOP Self-Heal Iteration {}/{}]\n\
                         Original Task: {}\n\
                         Acceptance Command `{}` failed with output:\n{}\n\
                         Fix the issue so the acceptance command passes.",
                        next_iter,
                        max_iters,
                        base_prompt,
                        check_cmd,
                        combined.trim()
                    );

                    match loop_state
                        .spawn_in_existing_worktree(
                            next_id,
                            Some(format!("loop-{}-iter{}", provider, next_iter)),
                            provider.clone(),
                            healing_prompt,
                            repo_root.clone(),
                            wt_path.clone(),
                            branch.clone(),
                            false,
                            Some(current_session_id),
                            None,
                            None,
                            Vec::new(),
                        )
                        .await
                    {
                        Ok(_) => {
                            current_session_id = next_id;
                        }
                        Err(_) => return,
                    }
                }
                Err(_) => return,
            }
        }
    });

    (StatusCode::CREATED, Json(json!(initial_session))).into_response()
}

fn is_destructive_shell_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    lower.contains("rm -rf /")
        || lower.contains("rm -rf ~")
        || lower.contains("git reset --hard")
        || lower.contains("git push --force")
        || lower.contains("git push -f ")
        || lower.contains("sudo ")
        || lower.contains("drop table ")
}

/// Real Claude Code & ACP `PreToolUse` live permission interceptor.
async fn pre_tool_use_hook_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let tool_name = payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("Tool");
    let tool_input = payload.get("tool_input").cloned().unwrap_or_else(|| json!({}));

    let approval_mode = {
        let guard = state.inner.read().await;
        guard
            .sessions
            .get(&id)
            .map(|s| s.approval_mode.clone())
            .unwrap_or_else(default_approval_mode)
    };

    let cmd_preview = tool_input
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            tool_input
                .get("file_path")
                .or_else(|| tool_input.get("path"))
                .and_then(|v| v.as_str())
                .map(|p| format!("{} {}", tool_name, p))
        })
        .unwrap_or_else(|| format!("{} {}", tool_name, tool_input));

    let requires_gate = match approval_mode.as_str() {
        "bypass" => false,
        "ask_before_edit" => matches!(
            tool_name,
            "Bash" | "Edit" | "Write" | "MultiEdit" | "ACP Tool" | "execute"
        ) || !tool_name.starts_with("Read"),
        _ => {
            // In `auto_edit`, normal workspace edits/commands proceed immediately;
            // high-risk destructive commands trigger interactive confirmation!
            tool_name == "Bash" && is_destructive_shell_command(&cmd_preview)
        }
    };

    if !requires_gate {
        return Json(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow"
            }
        }));
    }

    let desc = format!(
        "Agent requested `{}` in mode `{}`",
        tool_name, approval_mode
    );
    let decision = state
        .await_permission_gate(id, tool_name, Some(cmd_preview), &desc)
        .await;

    if decision == "deny" {
        Json(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "User denied permission in Velo control plane."
            }
        }))
    } else {
        Json(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow"
            }
        }))
    }
}

#[derive(Debug, serde::Deserialize)]
struct ResolveApprovalBody {
    decision: String,
}

async fn resolve_approval_handler(
    State(state): State<DaemonState>,
    AxumPath((id, request_id)): AxumPath<(Uuid, String)>,
    Json(body): Json<ResolveApprovalBody>,
) -> impl IntoResponse {
    let resolved = state
        .resolve_permission(id, &request_id, body.decision.trim())
        .await;
    Json(json!({ "ok": true, "resolved_live": resolved, "decision": body.decision }))
}

#[derive(Debug, serde::Deserialize)]
struct AnswerQuestionBody {
    answers: Vec<String>,
}

async fn answer_question_handler(
    State(state): State<DaemonState>,
    AxumPath((id, question_id)): AxumPath<(Uuid, String)>,
    Json(body): Json<AnswerQuestionBody>,
) -> impl IntoResponse {
    let resolved = state
        .resolve_question(id, &question_id, body.answers.clone())
        .await;
    Json(json!({ "ok": true, "resolved_live": resolved, "answers": body.answers }))
}

async fn get_pr_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let wt = {
        let guard = state.inner.read().await;
        guard
            .sessions
            .get(&id)
            .map(|s| PathBuf::from(&s.worktree_path))
            .unwrap_or_else(fallback_workspace_dir)
    };
    Json(pr::get_pr_status(&wt).await)
}

async fn create_pr_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<pr::CreatePrRequest>,
) -> impl IntoResponse {
    let wt = {
        let guard = state.inner.read().await;
        guard
            .sessions
            .get(&id)
            .map(|s| PathBuf::from(&s.worktree_path))
            .unwrap_or_else(fallback_workspace_dir)
    };
    Json(pr::create_pull_request(&wt, req).await)
}

async fn merge_pr_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<pr::MergePrRequest>,
) -> impl IntoResponse {
    let wt = {
        let guard = state.inner.read().await;
        guard
            .sessions
            .get(&id)
            .map(|s| PathBuf::from(&s.worktree_path))
            .unwrap_or_else(fallback_workspace_dir)
    };
    Json(pr::merge_pull_request(&wt, req).await)
}

async fn get_pr_checks_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let wt = {
        let guard = state.inner.read().await;
        guard
            .sessions
            .get(&id)
            .map(|s| PathBuf::from(&s.worktree_path))
            .unwrap_or_else(fallback_workspace_dir)
    };
    Json(pr::get_pr_checks_report(&wt).await)
}

async fn list_repo_hooks_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    let guard = state.inner.read().await;
    Json(json!({ "hooks": guard.repo_hooks }))
}

#[derive(Debug, serde::Deserialize)]
struct SetRepoHookBody {
    repo_path: String,
    setup_command: String,
}

async fn set_repo_hook_handler(
    State(state): State<DaemonState>,
    Json(body): Json<SetRepoHookBody>,
) -> impl IntoResponse {
    let repo_key = WorktreeManager::resolve_repo_root(Path::new(&body.repo_path))
        .await
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| body.repo_path.trim().to_string());
    {
        let mut guard = state.inner.write().await;
        if body.setup_command.trim().is_empty() {
            guard.repo_hooks.remove(&repo_key);
        } else {
            guard
                .repo_hooks
                .insert(repo_key.clone(), body.setup_command.trim().to_string());
        }
    }
    let _ = state.persist_repo_hooks().await;
    Json(json!({ "ok": true, "repo_root": repo_key }))
}

#[derive(Debug, serde::Deserialize)]
struct BrowserInspectRequest {
    url: String,
    session_id: Option<Uuid>,
}

async fn inspect_url_summary(url: &str) -> Value {
    let out = Command::new("curl")
        .args(["-sSL", "--max-time", "8", "-i", url])
        .output()
        .await;
    match out {
        Ok(res) if res.status.success() => {
            let raw = String::from_utf8_lossy(&res.stdout);
            let status_line = raw.lines().next().unwrap_or("HTTP/1.1 200 OK").to_string();
            let title = raw
                .find("<title>")
                .and_then(|s| {
                    let after = &raw[s + 7..];
                    after.find("</title>").map(|e| after[..e].trim().to_string())
                })
                .unwrap_or_default();
            let has_error_overlay = raw.contains("vite-error-overlay")
                || raw.contains("__next_error__")
                || raw.contains("Runtime Error");
            let body_excerpt: String = raw.chars().take(3500).collect();
            json!({
                "ok": true,
                "url": url,
                "status_line": status_line,
                "title": title,
                "has_error_overlay": has_error_overlay,
                "html_excerpt": body_excerpt,
            })
        }
        Ok(res) => json!({
            "ok": false,
            "url": url,
            "error": String::from_utf8_lossy(&res.stderr).trim().to_string()
        }),
        Err(err) => json!({
            "ok": false,
            "url": url,
            "error": err.to_string()
        }),
    }
}

async fn browser_inspect_handler(
    State(state): State<DaemonState>,
    Json(req): Json<BrowserInspectRequest>,
) -> impl IntoResponse {
    if let Some(sid) = req.session_id {
        let _ = state.event_tx.send(AgentEvent::BrowserCommand {
            session_id: sid,
            action: "open".to_string(),
            url: Some(req.url.clone()),
            selector: None,
            script: None,
            timestamp: Utc::now(),
        });
    }
    Json(inspect_url_summary(&req.url).await)
}

async fn transcribe_audio_handler(
    State(state): State<DaemonState>,
    Json(req): Json<voice::TranscribeRequest>,
) -> impl IntoResponse {
    let bytes = match decode_base64_payload(&req.audio_base64) {
        Ok(b) if !b.is_empty() => b,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": "Invalid or empty audio payload" })),
            )
                .into_response();
        }
    };
    let temp_dir = state.attachments_dir.join("voice-tmp");
    let res = voice::transcribe_audio(
        &temp_dir,
        &bytes,
        &req.mime_type,
        req.language.as_deref(),
    )
    .await;
    (StatusCode::OK, Json(res)).into_response()
}

async fn list_automations_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    let guard = state.inner.read().await;
    Json(json!({ "automations": guard.automations }))
}

async fn create_automation_handler(
    State(state): State<DaemonState>,
    Json(req): Json<automations::CreateAutomationRequest>,
) -> impl IntoResponse {
    let rule = automations::AutomationRule {
        id: Uuid::new_v4(),
        name: req.name.trim().to_string(),
        enabled: req.enabled,
        trigger_type: req.trigger_type,
        cron_expr: req.cron_expr,
        webhook_secret: req.webhook_secret,
        github_events: req.github_events,
        repo_path: req.repo_path,
        branch_prefix: req
            .branch_prefix
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "auto/hub".to_string()),
        provider: req.provider,
        model: req.model,
        prompt_template: req.prompt_template,
        created_at: Utc::now(),
        last_run_at: None,
        last_session_id: None,
        run_count: 0,
    };
    {
        let mut guard = state.inner.write().await;
        guard.automations.push(rule.clone());
    }
    let _ = state.persist_automations().await;
    (StatusCode::CREATED, Json(json!(rule)))
}

async fn update_automation_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<automations::UpdateAutomationRequest>,
) -> impl IntoResponse {
    let updated = {
        let mut guard = state.inner.write().await;
        if let Some(r) = guard.automations.iter_mut().find(|r| r.id == id) {
            if let Some(n) = req.name.filter(|s| !s.trim().is_empty()) {
                r.name = n;
            }
            if let Some(en) = req.enabled {
                r.enabled = en;
            }
            if let Some(c) = req.cron_expr {
                r.cron_expr = if c.trim().is_empty() { None } else { Some(c) };
            }
            if let Some(pt) = req.prompt_template.filter(|s| !s.trim().is_empty()) {
                r.prompt_template = pt;
            }
            Some(r.clone())
        } else {
            None
        }
    };
    match updated {
        Some(r) => {
            let _ = state.persist_automations().await;
            (StatusCode::OK, Json(json!(r))).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Automation not found" })),
        )
            .into_response(),
    }
}

async fn delete_automation_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    {
        let mut guard = state.inner.write().await;
        guard.automations.retain(|r| r.id != id);
    }
    let _ = state.persist_automations().await;
    Json(json!({ "ok": true, "deleted_id": id }))
}

async fn trigger_automation_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    match state
        .trigger_automation_rule(id, "manual_run", &json!({ "title": "Manual trigger" }))
        .await
    {
        Ok(sess) => (StatusCode::CREATED, Json(json!({ "ok": true, "session": sess }))).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn github_webhook_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let rule_opt = {
        let guard = state.inner.read().await;
        guard.automations.iter().find(|r| r.id == id).cloned()
    };
    let Some(rule) = rule_opt else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Automation rule not found" })),
        )
            .into_response();
    };
    if !rule.enabled {
        return (
            StatusCode::OK,
            Json(json!({ "ok": true, "skipped": "rule disabled" })),
        )
            .into_response();
    }

    if let Some(secret) = rule.webhook_secret.as_deref() {
        let sig_hdr = headers
            .get("x-hub-signature-256")
            .and_then(|v| v.to_str().ok());
        if !automations::verify_github_signature(secret, &body, sig_hdr) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Invalid X-Hub-Signature-256" })),
            )
                .into_response();
        }
    }

    let gh_event = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("push");
    if gh_event == "ping" {
        return (StatusCode::OK, Json(json!({ "ok": true, "pong": true }))).into_response();
    }
    if !rule.github_events.is_empty() && !rule.github_events.iter().any(|e| e == gh_event) {
        return (
            StatusCode::OK,
            Json(json!({ "ok": true, "skipped": format!("event {} not matched", gh_event) })),
        )
            .into_response();
    }

    let payload: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    match state.trigger_automation_rule(id, gh_event, &payload).await {
        Ok(sess) => (StatusCode::CREATED, Json(json!({ "ok": true, "session_id": sess.id }))).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn generic_webhook_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    match state.trigger_automation_rule(id, "webhook", &payload).await {
        Ok(sess) => (StatusCode::CREATED, Json(json!({ "ok": true, "session_id": sess.id }))).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

/// Phase 3 Built-in MCP Server JSON-RPC 2.0 endpoint (`POST /mcp`).
/// Allows any MCP-capable coding agent to list sessions, inspect diffs, ask the user questions,
/// request approvals, inspect local browser apps, or spawn/handoff peer agents.
pub async fn handle_mcp_request(state: &DaemonState, payload: Value) -> Value {
    handle_mcp_request_for_session(state, None, payload).await
}

pub async fn handle_mcp_request_for_session(
    state: &DaemonState,
    default_session_id: Option<Uuid>,
    payload: Value,
) -> Value {
    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    let method = payload.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let requested_proto = payload
        .pointer("/params/protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("2024-11-05");

    match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": requested_proto,
                "serverInfo": {
                    "name": "velo-mcp-server",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "tools": {}
                }
            }
        }),
        "ping" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [
                    {
                        "name": "velo_list_sessions",
                        "description": "List all parallel coding agent sessions and their Git worktree diff stats",
                        "inputSchema": {
                            "type": "object",
                            "properties": {}
                        }
                    },
                    {
                        "name": "velo_spawn_agent",
                        "description": "Spawn a new coding agent (claude, codex, agy, opencode, acp:...) inside an isolated Git worktree",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "provider": { "type": "string", "description": "claude, codex, agy, opencode, or acp:<cmd>" },
                                "prompt": { "type": "string", "description": "Task instructions" },
                                "repo_path": { "type": "string", "description": "Repository root path" },
                                "branch": { "type": "string", "description": "Branch name" }
                            },
                            "required": ["provider", "prompt", "repo_path"]
                        }
                    },
                    {
                        "name": "velo_get_diff",
                        "description": "Get the live unified git diff for a session's isolated worktree",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "session_id": { "type": "string", "description": "Session UUID (optional if bound)" }
                            }
                        }
                    },
                    {
                        "name": "velo_ask_user",
                        "description": "Ask the human user a clarifying multiple-choice or freeform question in the Velo UI and wait for their answer",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "question": { "type": "string", "description": "Clear question to show the user" },
                                "options": { "type": "array", "items": { "type": "string" }, "description": "Suggested choices" },
                                "allow_multiple": { "type": "boolean", "description": "Whether user can pick multiple options" }
                            },
                            "required": ["question"]
                        }
                    },
                    {
                        "name": "velo_request_approval",
                        "description": "Request interactive human approval in Velo UI before executing a sensitive command or file edit",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tool_name": { "type": "string", "description": "Tool or action name (e.g. Bash, Edit)" },
                                "command_preview": { "type": "string", "description": "Exact command or file path to preview" },
                                "reason": { "type": "string", "description": "Why this action is needed" }
                            },
                            "required": ["tool_name", "command_preview"]
                        }
                    },
                    {
                        "name": "velo_browser_open",
                        "description": "Open or navigate Velo's built-in workspace Browser Preview drawer to a local dev server URL",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string", "description": "Target URL (e.g. http://localhost:5173)" }
                            },
                            "required": ["url"]
                        }
                    },
                    {
                        "name": "velo_browser_inspect",
                        "description": "Fetch & inspect a local dev server URL (HTTP status, <title>, runtime/Vite error overlays, HTML excerpt) to verify frontend changes",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string", "description": "Target URL (e.g. http://localhost:5173)" }
                            },
                            "required": ["url"]
                        }
                    }
                ]
            }
        }),
        "tools/call" => {
            let tool_name = payload
                .pointer("/params/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let args = payload
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));

            let resolve_sid = || -> Option<Uuid> {
                args.get("session_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
                    .or(default_session_id)
            };

            match tool_name {
                "velo_list_sessions" => {
                    let guard = state.inner.read().await;
                    let list: Vec<&SessionInfo> = guard.sessions.values().collect();
                    let text = serde_json::to_string_pretty(&list).unwrap_or_default();
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": text }]
                        }
                    })
                }
                "velo_spawn_agent" => {
                    let provider_str = args
                        .get("provider")
                        .and_then(|v| v.as_str())
                        .unwrap_or("claude");
                    let prompt = args
                        .get("prompt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let repo_path = args
                        .get("repo_path")
                        .and_then(|v| v.as_str())
                        .unwrap_or(".")
                        .to_string();
                    let branch = args
                        .get("branch")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    let use_worktree = branch.is_some();
                    let req = CreateSessionRequest {
                        name: None,
                        provider: AgentProvider::from_str_loose(provider_str),
                        prompt,
                        repo_path,
                        branch,
                        use_pty: false,
                        parent_session_id: default_session_id,
                        model: None,
                        effort: None,
                        images: Vec::new(),
                        approval_mode: None,
                        setup_command: None,
                        use_worktree,
                    };
                    match state.create_session(req).await {
                        Ok(s) => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [{ "type": "text", "text": serde_json::to_string_pretty(&s).unwrap_or_default() }]
                            }
                        }),
                        Err(e) => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "isError": true,
                                "content": [{ "type": "text", "text": e.to_string() }]
                            }
                        }),
                    }
                }
                "velo_get_diff" => {
                    if let Some(sid) = resolve_sid() {
                        let wt = {
                            let guard = state.inner.read().await;
                            guard.sessions.get(&sid).map(|s| PathBuf::from(&s.worktree_path))
                        };
                        if let Some(path) = wt {
                            let diff = WorktreeManager::get_unified_diff(&path)
                                .await
                                .unwrap_or_default();
                            return json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "content": [{ "type": "text", "text": diff }]
                                }
                            });
                        }
                    }
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "isError": true,
                            "content": [{ "type": "text", "text": "Session not found" }]
                        }
                    })
                }
                "velo_ask_user" => {
                    let Some(sid) = resolve_sid() else {
                        return json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "isError": true, "content": [{ "type": "text", "text": "Missing session_id" }] }
                        });
                    };
                    let q = args
                        .get("question")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Please choose an option:")
                        .to_string();
                    let opts: Vec<String> = args
                        .get("options")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    let multi = args
                        .get("allow_multiple")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let answers = state.await_user_question(sid, q, opts, multi).await;
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": format!("User answered: {}", answers.join(", ")) }]
                        }
                    })
                }
                "velo_request_approval" => {
                    let Some(sid) = resolve_sid() else {
                        return json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "isError": true, "content": [{ "type": "text", "text": "Missing session_id" }] }
                        });
                    };
                    let t_name = args
                        .get("tool_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Bash");
                    let preview = args
                        .get("command_preview")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let reason = args
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Agent requested explicit confirmation");
                    let decision = state
                        .await_permission_gate(sid, t_name, Some(preview), reason)
                        .await;
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "isError": decision == "deny",
                            "content": [{ "type": "text", "text": format!("Permission decision: {}", decision) }]
                        }
                    })
                }
                "velo_browser_open" => {
                    let url = args
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("http://localhost:5173")
                        .to_string();
                    if let Some(sid) = resolve_sid() {
                        {
                            let mut guard = state.inner.write().await;
                            if let Some(s) = guard.sessions.get_mut(&sid) {
                                s.preview_url = Some(url.clone());
                            }
                        }
                        let _ = state.event_tx.send(AgentEvent::BrowserCommand {
                            session_id: sid,
                            action: "open".to_string(),
                            url: Some(url.clone()),
                            selector: None,
                            script: None,
                            timestamp: Utc::now(),
                        });
                    }
                    let summary = inspect_url_summary(&url).await;
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&summary).unwrap_or_default() }]
                        }
                    })
                }
                "velo_browser_inspect" => {
                    let url = args
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("http://localhost:5173");
                    let summary = inspect_url_summary(url).await;
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&summary).unwrap_or_default() }]
                        }
                    })
                }
                _ => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("Unknown tool: {}", tool_name) }
                }),
            }
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {}", method) }
        }),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
struct McpQuery {
    session_id: Option<Uuid>,
}

async fn mcp_jsonrpc_handler(
    State(state): State<DaemonState>,
    Query(query): Query<McpQuery>,
    Json(payload): Json<Value>,
) -> Response {
    // Streamable HTTP MCP 2025-03-26 compliance: JSON-RPC notifications (no `id`) return 202 Accepted
    if payload.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let resp = handle_mcp_request_for_session(&state, query.session_id, payload).await;
    (StatusCode::OK, Json(resp)).into_response()
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<DaemonState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_client(socket, state))
}

async fn handle_ws_client(socket: WebSocket, state: DaemonState) {
    let (mut sender, mut receiver) = socket.split();
    let mut event_rx = state.event_tx.subscribe();
    let mut snapshot_rx = state.snapshot_tx.subscribe();

    {
        let guard = state.inner.read().await;
        let mut sessions: Vec<SessionInfo> = guard.sessions.values().cloned().collect();
        sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        if let Ok(payload) = serde_json::to_string(&WsServerMessage::SessionsSnapshot { sessions }) {
            let _ = sender.send(Message::Text(payload.into())).await;
        }
    }

    let state_for_recv = state.clone();
    loop {
        tokio::select! {
            Ok(sessions) = snapshot_rx.recv() => {
                if let Ok(payload) = serde_json::to_string(&WsServerMessage::SessionsSnapshot { sessions }) {
                    if sender.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
            }
            Ok(event) = event_rx.recv() => {
                if let Ok(payload) = serde_json::to_string(&WsServerMessage::Event { event }) {
                    if sender.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
            }
            Some(Ok(msg)) = receiver.next() => {
                if let Message::Text(text) = msg {
                    if let Ok(client_cmd) = serde_json::from_str::<WsClientMessage>(&text) {
                        match client_cmd {
                            WsClientMessage::Ping => {
                                if let Ok(pong) = serde_json::to_string(&WsServerMessage::Pong) {
                                    let _ = sender.send(Message::Text(pong.into())).await;
                                }
                            }
                            WsClientMessage::SendInput { session_id, data } => {
                                let guard = state_for_recv.inner.read().await;
                                if let Some(h) = guard.handles.get(&session_id) {
                                    let _ = h.send_input(data);
                                }
                            }
                            WsClientMessage::ApprovePermission {
                                session_id,
                                request_id,
                                approved,
                                always,
                            } => {
                                let decision = if !approved {
                                    "deny"
                                } else if always {
                                    "always"
                                } else {
                                    "approve"
                                };
                                state_for_recv
                                    .resolve_permission(session_id, &request_id, decision)
                                    .await;
                            }
                            WsClientMessage::AnswerQuestion {
                                session_id,
                                question_id,
                                answers,
                            } => {
                                state_for_recv
                                    .resolve_question(session_id, &question_id, answers)
                                    .await;
                            }
                            _ => {}
                        }
                    } else {
                        warn!("Unrecognized WS client message: {}", text);
                    }
                }
            }
            else => break,
        }
    }
}

fn resolve_ui_dist_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("VELO_UI_DIR") {
        let p = PathBuf::from(custom);
        if p.join("index.html").is_file() {
            return p;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // Standalone macOS bundle: Velo.app/Contents/MacOS/velo-daemon -> ../Resources/dist
            let bundle_dist = exe_dir.join("../Resources/dist");
            if bundle_dist.join("index.html").is_file() {
                return bundle_dist;
            }
            let sibling_dist = exe_dir.join("dist");
            if sibling_dist.join("index.html").is_file() {
                return sibling_dist;
            }
        }
    }

    let user_dist = default_velo_home().join("ui/dist");
    if user_dist.join("index.html").is_file() {
        return user_dist;
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/velo-desktop/dist")
}

async fn ui_index_handler() -> impl IntoResponse {
    let dist_dir = resolve_ui_dist_dir();
    let index_path = dist_dir.join("index.html");
    match tokio::fs::read_to_string(&index_path).await {
        Ok(html) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
            ],
            html,
        )
            .into_response(),
        Err(_) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Velo Daemon is running. Build UI with `npm --prefix apps/velo-desktop run build`."
                .to_string(),
        )
            .into_response(),
    }
}

async fn ui_asset_handler(AxumPath(file): AxumPath<String>) -> impl IntoResponse {
    let dist_assets = resolve_ui_dist_dir().join("assets");
    let clean_name = Path::new(&file)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let full_path = dist_assets.join(clean_name);

    let content_type = if clean_name.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if clean_name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if clean_name.ends_with(".svg") {
        "image/svg+xml"
    } else if clean_name.ends_with(".png") {
        "image/png"
    } else if clean_name.ends_with(".jpg") || clean_name.ends_with(".jpeg") {
        "image/jpeg"
    } else if clean_name.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    };

    match tokio::fs::read(&full_path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command;

    #[test]
    fn test_parse_agy_and_cursor_grouped_models_with_efforts() {
        let agy_raw = "\
gemini-4-neon-high             Gemini 4 Neon (High)
gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)
gemini-4-neon-medium           Gemini 4 Neon (Medium)
gemini-4-neon-low              Gemini 4 Neon (Low)
gemini-pro-orchestrator-neon   Orchestrator (Neon)
claude-opus-5-5-low            Claude Opus 5.5 (Low)
claude-opus-5-5-high           Claude Opus 5.5 (High)
";
        let agy = parse_agy_models_stdout(agy_raw);
        assert_eq!(agy.len(), 3);
        assert_eq!(agy[0].id, "gemini-4-neon");
        assert_eq!(agy[0].label, "Gemini 4 Neon");
        assert_eq!(agy[0].supported_efforts, vec!["low", "medium", "high", "xhigh"]);
        assert_eq!(agy[1].id, "gemini-pro-orchestrator-neon");
        assert!(agy[1].supported_efforts.is_empty());
        assert_eq!(agy[2].id, "agy:claude-opus-5-5");
        assert_eq!(agy[2].supported_efforts, vec!["low", "high"]);

        let cursor_raw = "\
Available models
auto - Auto (default)
gpt-5.3-codex-low - Codex 5.3 Low
gpt-5.3-codex-low-fast - Codex 5.3 Low Fast
gpt-5.3-codex - Codex 5.3
gpt-5.3-codex-high - Codex 5.3 High
gpt-5.3-codex-xhigh - Codex 5.3 Extra High
claude-opus-5-5-medium - Claude Opus 5.5 1M
claude-opus-5-5-high - Claude Opus 5.5 1M High
claude-opus-5-5-max - Claude Opus 5.5 1M Max
composer-2.5 - Composer 2.5
";
        let cur = parse_cursor_models_stdout(cursor_raw);
        assert_eq!(cur.len(), 3);
        assert_eq!(cur[0].id, "cursor:gpt-5.3-codex");
        assert_eq!(cur[0].supported_efforts, vec!["low", "medium", "high", "xhigh"]);
        assert_eq!(
            cur[0].effort_slugs.get("medium").map(String::as_str),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            cur[0].effort_slugs.get("xhigh").map(String::as_str),
            Some("gpt-5.3-codex-xhigh")
        );
        assert_eq!(cur[1].id, "cursor:claude-opus-5-5");
        assert_eq!(cur[1].supported_efforts, vec!["medium", "high", "max"]);
        assert_eq!(cur[2].id, "cursor:composer-2.5");
        assert!(cur[2].supported_efforts.is_empty());
    }

    #[tokio::test]
    async fn test_daemon_session_lifecycle_and_diff() -> Result<()> {
        let temp_base = std::env::temp_dir().join(format!("velo-daemon-test-{}", Uuid::new_v4()));
        let repo_dir = temp_base.join("repo");
        let wt_dir = temp_base.join("worktrees");
        tokio::fs::create_dir_all(&repo_dir).await?;

        Command::new("git").arg("init").current_dir(&repo_dir).output().await?;
        Command::new("git")
            .args(["config", "user.email", "test@velo.dev"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["config", "user.name", "Velo"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        tokio::fs::write(repo_dir.join("app.rs"), "fn main() {}\n").await?;
        Command::new("git")
            .args(["add", "app.rs"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_dir)
            .output()
            .await?;

        let db = storage::VeloSqliteStore::open(&temp_base.join("velo.db"))?;
        let (agent_event_tx, _) = broadcast::channel(256);
        let (event_tx, _) = broadcast::channel(256);
        let (snapshot_tx, _) = broadcast::channel(32);
        let state = DaemonState {
            inner: Arc::new(RwLock::new(DaemonInner {
                sessions: HashMap::new(),
                event_history: HashMap::new(),
                live_turns: HashMap::new(),
                handles: HashMap::new(),
                warm_handles: HashMap::new(),
                shells: HashMap::new(),
                pending_approvals: HashMap::new(),
                pending_questions: HashMap::new(),
                automations: Vec::new(),
                repo_hooks: HashMap::new(),
                workspaces: Vec::new(),
                push_config: push::PushConfig::default(),
                quota_cache: quota::PersistedQuotaCache::default(),
                remote_hosts: Vec::new(),
            })),
            db,
            agent_event_tx,
            event_tx,
            snapshot_tx,
            worktree_mgr: WorktreeManager::new(wt_dir),
            state_file: temp_base.join("sessions.json"),
            events_dir: temp_base.join("events"),
            attachments_dir: temp_base.join("attachments"),
            automations_file: temp_base.join("automations.json"),
            hooks_file: temp_base.join("repo_hooks.json"),
            workspaces_file: temp_base.join("workspaces.json"),
            push_config_file: temp_base.join("push_config.json"),
            quota_cache_file: temp_base.join("quotas.json"),
            hosts_file: temp_base.join("hosts.json"),
            daemon_http_base: None,
        };
        state.spawn_event_supervisor();

        let req = CreateSessionRequest {
            name: Some("test-agent".to_string()),
            provider: velo_protocol::AgentProvider::Custom(
                "printf '// updated by velo\\n' >> app.rs && echo".to_string(),
            ),
            prompt: "hello-velo".to_string(),
            repo_path: repo_dir.to_string_lossy().to_string(),
            branch: Some("feat/auto-edit".to_string()),
            use_pty: false,
            parent_session_id: None,
            model: None,
            effort: None,
            images: Vec::new(),
            approval_mode: None,
            setup_command: None,
            use_worktree: true,
        };

        let session = state.create_session(req).await?;
        assert_eq!(session.branch, "feat/auto-edit");

        tokio::time::sleep(std::time::Duration::from_millis(250)).await;

        let guard = state.inner.read().await;
        let updated = guard.sessions.get(&session.id).expect("session exists");
        assert_eq!(updated.status, SessionStatus::Completed);
        assert_eq!(updated.diff_stats.files_changed, 1);
        assert_eq!(updated.diff_stats.insertions, 1);
        drop(guard);

        // Verify default in-place workspace + cross-engine handoff creates clean child session
        let inplace_req = CreateSessionRequest {
            name: Some("Check architecture".to_string()),
            provider: velo_protocol::AgentProvider::Codex,
            prompt: String::new(),
            repo_path: repo_dir.to_string_lossy().to_string(),
            branch: None,
            use_pty: false,
            parent_session_id: None,
            model: Some("gpt-5.4".to_string()),
            effort: Some("high".to_string()),
            images: Vec::new(),
            approval_mode: None,
            setup_command: None,
            use_worktree: false,
        };
        let inplace_sess = state.create_session(inplace_req).await?;
        assert_eq!(inplace_sess.worktree_path, inplace_sess.repo_root);

        let handed_off = state
            .handoff_session(
                inplace_sess.id,
                HandoffSessionRequest {
                    target_provider: velo_protocol::AgentProvider::Grok,
                    model: Some("grok-4.7".to_string()),
                    effort: Some("medium".to_string()),
                    additional_instructions: None,
                },
            )
            .await?;
        assert_eq!(handed_off.parent_session_id, Some(inplace_sess.id));
        assert_eq!(handed_off.provider, velo_protocol::AgentProvider::Grok);
        assert_eq!(handed_off.model.as_deref(), Some("grok-4.7"));
        assert_eq!(handed_off.name, "Check architecture · Grok");
        assert_eq!(handed_off.worktree_path, inplace_sess.repo_root);

        // Verify built-in MCP Server tools/list & velo_list_sessions
        let mcp_list = handle_mcp_request(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "velo_list_sessions",
                    "arguments": {}
                }
            }),
        )
        .await;
        let mcp_text = mcp_list
            .pointer("/result/content/0/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(mcp_text.contains("feat/auto-edit"));

        // Verify non-existent workspace heals cleanly on create_session and stop_session_by_id broadcasts StatusChanged(Stopped)
        let mut rx = state.event_tx.subscribe();
        let missing_dir = temp_base.join("nonexistent-project-dir");
        let missing_sess = state
            .create_session(CreateSessionRequest {
                name: Some("missing-dir-heal".to_string()),
                provider: velo_protocol::AgentProvider::Custom("sleep 30".to_string()),
                prompt: "stay running".to_string(),
                repo_path: missing_dir.to_string_lossy().to_string(),
                branch: None,
                use_pty: false,
                parent_session_id: None,
                model: None,
                effort: None,
                images: Vec::new(),
                approval_mode: None,
                setup_command: None,
                use_worktree: false,
            })
            .await?;
        assert!(missing_dir.is_dir(), "missing workspace dir should auto-create");

        state.stop_session_by_id(missing_sess.id).await;
        let mut saw_stopped = false;
        for _ in 0..16 {
            if let Ok(Ok(ev)) =
                tokio::time::timeout(std::time::Duration::from_millis(120), rx.recv()).await
            {
                if let AgentEvent::StatusChanged {
                    session_id,
                    status: SessionStatus::Stopped,
                    ..
                } = ev
                {
                    if session_id == missing_sess.id {
                        saw_stopped = true;
                        break;
                    }
                }
            }
        }
        assert!(saw_stopped, "stop_session_by_id must broadcast StatusChanged::Stopped");

        let _ = tokio::fs::remove_dir_all(&temp_base).await;
        Ok(())
    }

    #[test]
    fn test_turn_metrics_enrichment_and_relay_parity() {
        let sid = Uuid::new_v4();
        let t0 = Utc::now();
        let ms = |offset_ms: i64| t0 + chrono::Duration::milliseconds(offset_ms);

        // Simulate a multi-step Codex turn with:
        // 1) Stale resume echo at +350ms before any item starts (should be dropped)
        // 2) Small MCP step (`out=45`) with 14s prefill + 3s tool execution
        // 3) Substantial decode step (`out=2000` in 56s including ~8s prefill -> ~41.7 tok/s)
        // 4) Final tiny wrap-up step (`out=60` in 4s)
        let mut raw_events = vec![
            AgentEvent::UserMessage {
                session_id: sid,
                text: "Analyze CUA state and fix TPS".to_string(),
                images: Vec::new(),
                timestamp: ms(0),
            },
            AgentEvent::UsageUpdated {
                session_id: sid,
                input_tokens: 127_000,
                output_tokens: 1_184,
                total_tokens: 128_184,
                cache_read_tokens: 120_000,
                cache_write_tokens: 0,
                context_window: 200_000,
                cost_usd: 0.05,
                output_tps: 0.0,
                is_turn_total: false,
                timestamp: ms(350),
            },
            AgentEvent::ThinkingDelta {
                session_id: sid,
                text: "Checking state".to_string(),
                timestamp: ms(14_000),
            },
            AgentEvent::ToolCallRequested {
                session_id: sid,
                tool_id: "mcp-1".to_string(),
                tool_name: "MCP · cua_repl:js".to_string(),
                arguments: json!({ "code": "1+1" }),
                timestamp: ms(14_010),
            },
            AgentEvent::ToolCallCompleted {
                session_id: sid,
                tool_id: "mcp-1".to_string(),
                output: "x".repeat(4_000),
                is_error: false,
                timestamp: ms(17_010),
            },
            AgentEvent::UsageUpdated {
                session_id: sid,
                input_tokens: 150_000,
                output_tokens: 45,
                total_tokens: 150_045,
                cache_read_tokens: 140_000,
                cache_write_tokens: 0,
                context_window: 200_000,
                cost_usd: 0.01,
                output_tps: 0.0,
                is_turn_total: false,
                timestamp: ms(17_020),
            },
            AgentEvent::ThinkingDelta {
                session_id: sid,
                text: "Synthesizing architecture".to_string(),
                timestamp: ms(73_000),
            },
            AgentEvent::UsageUpdated {
                session_id: sid,
                input_tokens: 156_000,
                output_tokens: 2_000,
                total_tokens: 158_000,
                cache_read_tokens: 148_000,
                cache_write_tokens: 0,
                context_window: 200_000,
                cost_usd: 0.03,
                output_tps: 0.0,
                is_turn_total: false,
                timestamp: ms(73_020),
            },
            AgentEvent::MessageDelta {
                session_id: sid,
                text: "Done!".to_string(),
                timestamp: ms(77_000),
            },
            AgentEvent::UsageUpdated {
                session_id: sid,
                input_tokens: 158_000,
                output_tokens: 60,
                total_tokens: 158_060,
                cache_read_tokens: 150_000,
                cache_write_tokens: 0,
                context_window: 200_000,
                cost_usd: 0.01,
                output_tps: 0.0,
                is_turn_total: false,
                timestamp: ms(77_020),
            },
            AgentEvent::StatusChanged {
                session_id: sid,
                status: SessionStatus::Completed,
                message: None,
                timestamp: ms(77_030),
            },
            // Turn 2: AGY turn with explicit `(207 thinking tokens)` and no provider UsageUpdated
            AgentEvent::UserMessage {
                session_id: sid,
                text: "Quick AGY check".to_string(),
                images: Vec::new(),
                timestamp: ms(90_000),
            },
            AgentEvent::ThinkingDelta {
                session_id: sid,
                text: "**Reasoning completed (207 thinking tokens)**".to_string(),
                timestamp: ms(95_000),
            },
            AgentEvent::MessageDelta {
                session_id: sid,
                text: "一切正常，吞吐率已完全统一，桌面端和移动端现在完全使用同一套服务端指标数据源。".to_string(),
                timestamp: ms(95_800),
            },
            AgentEvent::StatusChanged {
                session_id: sid,
                status: SessionStatus::Completed,
                message: None,
                timestamp: ms(95_850),
            },
        ];

        // Pad with 160 tool calls in Turn 1 to force `compact_history_for_relay` second-pass trimming
        for k in 0..160 {
            raw_events.insert(
                4,
                AgentEvent::ToolCallCompleted {
                    session_id: sid,
                    tool_id: format!("pad-{}", k),
                    output: "y".repeat(3_500),
                    is_error: false,
                    timestamp: ms(15_000),
                },
            );
        }

        let desktop_enriched = enrich_history_turn_metrics(&raw_events);
        let relay_compacted = relay_bridge::compact_history_for_relay(&raw_events);

        let desktop_usages: Vec<(u64, f64, bool)> = desktop_enriched
            .iter()
            .filter_map(|e| match e {
                AgentEvent::UsageUpdated {
                    output_tokens,
                    output_tps,
                    is_turn_total,
                    ..
                } => Some((*output_tokens, *output_tps, *is_turn_total)),
                _ => None,
            })
            .collect();

        let relay_usages: Vec<(u64, f64, bool)> = relay_compacted
            .iter()
            .filter_map(|e| match e {
                AgentEvent::UsageUpdated {
                    output_tokens,
                    output_tps,
                    is_turn_total,
                    ..
                } => Some((*output_tokens, *output_tps, *is_turn_total)),
                _ => None,
            })
            .collect();

        assert_eq!(desktop_usages.len(), 2, "each turn must have 1 authoritative UsageUpdated");
        assert_eq!(
            desktop_usages, relay_usages,
            "Desktop and E2EE Relay must produce 100% identical output_tokens and output_tps"
        );
        // Turn 1: 45 + 2000 + 60 = 2105 (stale 1184 resume echo dropped!)
        assert_eq!(desktop_usages[0].0, 2_105);
        assert!(
            desktop_usages[0].1 >= 35.0 && desktop_usages[0].1 <= 50.0,
            "Turn 1 TPS should reflect ~42 tok/s decode speed, got {}",
            desktop_usages[0].1
        );
        assert!(desktop_usages[0].2);
        // Turn 2: 207 thinking tokens + ~15 message tokens
        assert!(desktop_usages[1].0 >= 215);
        assert!(desktop_usages[1].1 >= 30.0);
    }

    #[test]
    fn test_sqlite_wal_pagination_search_and_pricing() -> anyhow::Result<()> {
        let tmp = std::env::temp_dir().join(format!("velo-sqlite-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&tmp)?;
        let db = storage::VeloSqliteStore::open(&tmp.join("velo.db"))?;

        let sid = Uuid::new_v4();
        let now = Utc::now();
        let sess = SessionInfo {
            id: sid,
            name: "SQLite WAL Upgrade".to_string(),
            provider: AgentProvider::Claude,
            status: SessionStatus::Completed,
            repo_root: "/tmp/velo-repo".to_string(),
            worktree_path: "/tmp/velo-repo".to_string(),
            branch: "main".to_string(),
            prompt: "Migrate event storage to SQLite WAL".to_string(),
            pid: None,
            parent_session_id: None,
            created_at: now,
            updated_at: now,
            diff_stats: Default::default(),
            tokens_used: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            context_window: 200_000,
            cost_usd: 0.0,
            model: Some("claude-fable-5-2".to_string()),
            effort: Some("high".to_string()),
            provider_session_id: None,
            approval_mode: "auto_edit".to_string(),
            preview_url: None,
            queued_prompts: Vec::new(),
            archived: false,
        };
        db.upsert_session(&sess)?;

        for i in 0..25 {
            db.append_event(
                sid,
                &AgentEvent::MessageDelta {
                    session_id: sid,
                    text: format!("Step {} unique_keyword_alpha_{}", i, i),
                    timestamp: now + chrono::Duration::seconds(i),
                },
            )?;
        }

        let page1 = db.query_events_page(sid, None, 10)?;
        assert_eq!(page1.events.len(), 10);
        assert!(page1.has_more);

        let page2 = db.query_events_page(sid, page1.oldest_seq, 10)?;
        assert_eq!(page2.events.len(), 10);
        assert!(page2.has_more);

        let hits = db.search_global("unique_keyword_alpha_22", 10)?;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, sid);

        // Verify Fable 5.2 pricing: 100k input (80k cached @ $0.50/M + 20k uncached @ $5.00/M = $0.14) + 10k output @ $25/M ($0.25) = $0.39
        let cost = pricing::compute_cost_usd(
            &AgentProvider::Claude,
            Some("claude-fable-5-2"),
            100_000,
            80_000,
            0,
            10_000,
        );
        assert!((cost - 0.39).abs() < 0.0001, "expected $0.39, got {}", cost);

        let _ = std::fs::remove_dir_all(&tmp);
        Ok(())
    }
}

#[derive(Debug, serde::Deserialize, Default)]
struct PairTicketQuery {
    relay: Option<String>,
    web: Option<String>,
    rotate: Option<String>,
}

async fn relay_status_handler() -> impl IntoResponse {
    Json(relay_bridge::get_e2ee_status_dto().await)
}

async fn rotate_relay_handler(State(state): State<DaemonState>) -> impl IntoResponse {
    let lan_ip = match detect_interface_ipv4("en0").await {
        Some(ip) => ip,
        None => detect_interface_ipv4("en1")
            .await
            .unwrap_or_else(|| velo_protocol::DEFAULT_DAEMON_HOST.to_string()),
    };
    let identity = relay_bridge::rotate_pairing_identity();
    let relay_url = if let Some(ref custom) = identity.custom_relay_url {
        custom.clone()
    } else {
        let snap = relay_bridge::ensure_public_blind_tunnel(4500).await;
        snap.public_wss_url
            .unwrap_or_else(|| format!("ws://{}:{}", lan_ip, velo_relay::DEFAULT_RELAY_PORT))
    };
    let daemon_addr = format!("{}:{}", lan_ip, velo_protocol::DEFAULT_DAEMON_PORT);
    let ticket = velo_relay::PairingTicket::from_existing(
        identity.room_id,
        identity.shared_key_hex,
        identity.daemon_pubkey_hex,
        &relay_url,
        &daemon_addr,
    );
    relay_bridge::spawn_daemon_e2ee_bridge(state, ticket.clone());
    let qr_svg = velo_relay::render_qr_svg(&ticket.pairing_uri, 184);
    let web_qr_svg = velo_relay::render_qr_svg(&ticket.mobile_web_url, 184);
    let e2ee_status = relay_bridge::get_e2ee_status_dto().await;
    Json(json!({
        "ok": true,
        "room_id": ticket.room_id,
        "shared_key_hex": ticket.shared_key_hex,
        "daemon_pubkey_hex": ticket.daemon_pubkey_hex,
        "relay_url": ticket.relay_url,
        "pairing_uri": ticket.pairing_uri,
        "uri": ticket.mobile_web_url,
        "qr_svg": qr_svg,
        "web_qr_svg": web_qr_svg,
        "e2ee_status": e2ee_status,
    }))
}

async fn detect_interface_ipv4(iface: &str) -> Option<String> {
    Command::new("ipconfig")
        .args(["getifaddr", iface])
        .output()
        .await
        .ok()
        .and_then(|o| {
            if !o.status.success() {
                return None;
            }
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(s) }
        })
}

async fn detect_tailscale_ipv4() -> Option<String> {
    for bin in ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] {
        if let Ok(out) = Command::new(bin).args(["ip", "-4"]).output().await {
            if out.status.success() {
                if let Some(line) = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                {
                    return Some(line.to_string());
                }
            }
        }
    }
    None
}

async fn pair_ticket_handler(
    State(state): State<DaemonState>,
    Query(query): Query<PairTicketQuery>,
) -> impl IntoResponse {
    let lan_ip = match detect_interface_ipv4("en0").await {
        Some(ip) => ip,
        None => detect_interface_ipv4("en1")
            .await
            .unwrap_or_else(|| velo_protocol::DEFAULT_DAEMON_HOST.to_string()),
    };
    let tailscale_ip = detect_tailscale_ipv4().await;

    relay_bridge::ensure_local_relay_running().await;

    let mut identity = if query.rotate.as_deref() == Some("1") {
        relay_bridge::rotate_pairing_identity()
    } else {
        relay_bridge::load_or_create_pairing_identity()
    };

    if let Some(ref relay_param) = query.relay {
        let trimmed = relay_param.trim();
        if trimmed == "auto" || trimmed.is_empty() {
            identity = relay_bridge::update_custom_relay_url(None);
        } else {
            identity = relay_bridge::update_custom_relay_url(Some(trimmed.to_string()));
        }
    }

    let relay_url = if let Some(ref custom) = identity.custom_relay_url {
        custom.clone()
    } else {
        let snap = relay_bridge::ensure_public_blind_tunnel(4500).await;
        snap.public_wss_url
            .unwrap_or_else(|| format!("ws://{}:{}", lan_ip, velo_relay::DEFAULT_RELAY_PORT))
    };

    let daemon_addr = query
        .web
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}:{}", lan_ip, velo_protocol::DEFAULT_DAEMON_PORT));

    let lan_uri = format!("http://{}:{}/?mobile=1", lan_ip, velo_protocol::DEFAULT_DAEMON_PORT);
    let lan_qr_svg = velo_relay::render_qr_svg(&lan_uri, 184);

    let (tailscale_uri, tailscale_qr_svg) = match &tailscale_ip {
        Some(ts) => {
            let u = format!("http://{}:{}/?mobile=1", ts, velo_protocol::DEFAULT_DAEMON_PORT);
            let svg = velo_relay::render_qr_svg(&u, 184);
            (Some(u), Some(svg))
        }
        None => (None, None),
    };

    let ticket = velo_relay::PairingTicket::from_existing(
        identity.room_id,
        identity.shared_key_hex,
        identity.daemon_pubkey_hex,
        &relay_url,
        &daemon_addr,
    );
    let mobile_url = ticket.mobile_web_url.clone();

    relay_bridge::spawn_daemon_e2ee_bridge(state, ticket.clone());

    // Primary E2EE QR encodes `velo://pair?relay=wss://...&room=...&key=...&pub=...`
    // so both iOS Camera Deep Link AND Velo Native App QR Scanner connect over 5G with 0 local HTTP dependency!
    let qr_svg = velo_relay::render_qr_svg(&ticket.pairing_uri, 184);
    let web_qr_svg = velo_relay::render_qr_svg(&mobile_url, 184);
    let e2ee_status = relay_bridge::get_e2ee_status_dto().await;

    Json(json!({
        "lan_ip": lan_ip,
        "lan_uri": lan_uri,
        "lan_qr_svg": lan_qr_svg,
        "tailscale_ip": tailscale_ip,
        "tailscale_uri": tailscale_uri,
        "tailscale_qr_svg": tailscale_qr_svg,
        "room_id": ticket.room_id,
        "shared_key_hex": ticket.shared_key_hex,
        "daemon_pubkey_hex": ticket.daemon_pubkey_hex,
        "relay_url": ticket.relay_url,
        "custom_relay_url": identity.custom_relay_url,
        "daemon_addr": ticket.daemon_addr,
        "pairing_uri": ticket.pairing_uri,
        "uri": mobile_url,
        "qr_svg": qr_svg,
        "web_qr_svg": web_qr_svg,
        "e2ee_status": e2ee_status,
    }))
}

#[derive(Debug, serde::Deserialize)]
struct UpdateSystemServiceRequest {
    action: Option<String>,
    prevent_idle_sleep: Option<bool>,
}

pub(crate) async fn launch_provider_cli_login(provider_raw: &str) -> Result<String> {
    let prov = AgentProvider::from_str_loose(provider_raw);
    let aug_path = velo_agent::discover_augmented_path();
    let proxy_export = if let Some(p) = velo_agent::discover_system_proxy_url() {
        format!(
            "export HTTP_PROXY='{p}' HTTPS_PROXY='{p}' ALL_PROXY='{p}' http_proxy='{p}' https_proxy='{p}' all_proxy='{p}' NO_PROXY='localhost,127.0.0.1,::1'\n"
        )
    } else {
        String::new()
    };

    let (bin_name, args_str, label) = match prov {
        AgentProvider::Antigravity => ("agy", "-i \"hi\"", "Google Antigravity CLI (agy)"),
        AgentProvider::Cursor => ("cursor-agent", "login", "Cursor Agent CLI"),
        AgentProvider::Claude => ("claude", "auth login", "Claude Code"),
        AgentProvider::Codex => ("codex", "login", "OpenAI Codex CLI"),
        AgentProvider::Grok => ("grok", "", "xAI Grok CLI"),
        AgentProvider::OpenCode => ("opencode", "auth login", "OpenCode CLI"),
        AgentProvider::Copilot => ("copilot", "auth login", "GitHub Copilot CLI"),
        AgentProvider::Qwen => ("qwen", "", "Qwen Code CLI"),
        AgentProvider::Acp(_) | AgentProvider::Custom(_) => ("agy", "-i \"hi\"", "Agent CLI"),
    };

    let resolved_bin = velo_agent::resolve_cli_binary(bin_name)
        .map(|p| format!("'{}'", p.to_string_lossy().replace('\'', "'\\''")))
        .unwrap_or_else(|| bin_name.to_string());
    let full_cmd = if args_str.is_empty() {
        resolved_bin
    } else {
        format!("{} {}", resolved_bin, args_str)
    };

    let home = dirs::home_dir().unwrap_or_else(|| {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"))
    });
    let script_dir = home.join(".velo/bin");
    tokio::fs::create_dir_all(&script_dir).await?;
    let script_path = script_dir.join("velo-cli-login.command");
    let script_content = format!(
        "#!/bin/zsh\nclear\nexport PATH=\"{aug_path}:$PATH\"\n{proxy_export}echo \"🔐 正在为 Velo 启动 {label} 登录认证…\"\necho \"命令: {full_cmd}\"\necho \"\"\n{full_cmd}\necho \"\"\necho \"✅ 登录完成后可直接关闭此窗口，回到 Velo 点击重试即可。\"\nexec zsh -l\n"
    );
    tokio::fs::write(&script_path, script_content).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));
    }

    let status = Command::new("/usr/bin/open")
        .args(["-a", "Terminal", &script_path.to_string_lossy()])
        .status()
        .await?;
    if !status.success() {
        anyhow::bail!("Failed to open Terminal.app for CLI login");
    }
    Ok(format!("已在 Mac 端拉起 Terminal 执行 `{}` 登录流程", label))
}

async fn provider_cli_login_handler(
    AxumPath(provider): AxumPath<String>,
) -> impl IntoResponse {
    match launch_provider_cli_login(&provider).await {
        Ok(msg) => (StatusCode::OK, Json(json!({ "ok": true, "message": msg }))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn get_system_service_handler() -> impl IntoResponse {
    Json(json!(service::get_service_status().await))
}

async fn update_system_service_handler(
    Json(req): Json<UpdateSystemServiceRequest>,
) -> impl IntoResponse {
    if let Some(prevent) = req.prevent_idle_sleep {
        let mut cfg = service::load_service_config();
        cfg.prevent_idle_sleep = prevent;
        service::save_service_config(&cfg);
        service::sync_caffeinate_assertion(prevent).await;
    }

    if let Some(ref action) = req.action {
        match action.as_str() {
            "install" => match service::stage_launch_agent_files(None) {
                Ok(plist_path) => {
                    let cur_cfg = service::load_service_config();
                    service::sync_caffeinate_assertion(cur_cfg.prevent_idle_sleep).await;
                    let under_launchd = std::env::var("VELO_LAUNCHD").as_deref() == Ok("1");
                    if !under_launchd {
                        let my_pid = std::process::id();
                        let plist_str = plist_path.to_string_lossy().to_string();
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(350)).await;
                            let cmd_str = format!(
                                "UID_NUM=$(id -u); kill {pid} 2>/dev/null || true; sleep 0.35; launchctl bootout gui/$UID_NUM/{label} 2>/dev/null || true; launchctl bootstrap gui/$UID_NUM '{plist}' 2>/dev/null || launchctl load -w '{plist}' 2>/dev/null || true; launchctl kickstart -k gui/$UID_NUM/{label} 2>/dev/null || true",
                                pid = my_pid,
                                label = service::LAUNCH_AGENT_LABEL,
                                plist = plist_str.replace('\'', "'\\''"),
                            );
                            let _ = std::process::Command::new("sh")
                                .args(["-c", &cmd_str])
                                .spawn();
                        });
                    }
                }
                Err(err) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "ok": false, "error": err.to_string() })),
                    )
                        .into_response();
                }
            },
            "uninstall" => {
                let _ = service::bootout_and_remove_plist_sync(false);
                service::sync_caffeinate_assertion(false).await;
            }
            "restart" => {
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    let _ = service::restart_launchd_service_sync();
                });
            }
            _ => {}
        }
    }

    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "service": service::get_service_status().await,
        })),
    )
        .into_response()
}
