use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::sync::oneshot;
use uuid::Uuid;
use velo_protocol::{
    AgentEvent, AgentProvider, CreateSessionRequest, MeshContextRef, MeshInvocationInfo,
    MeshInvocationKind, MeshInvocationStatus, MeshPermissionPolicy, MeshSettings,
    SessionInputRequest, SessionStatus,
};
use velo_worktree::WorktreeManager;

use crate::{DaemonState, canonical_workspace_path, clean_provider_badge, truncate_utf8_tail};

const MESH_SETTINGS_KV_KEY: &str = "mesh_settings_v1";

#[derive(Default)]
pub struct MeshRuntime {
    pub settings: MeshSettings,
    pub invocations: HashMap<String, MeshInvocationInfo>,
    /// Tracks active invocation ancestry for a currently-executing callee session:
    /// `callee_session_id -> (root_invocation_id, call_chain_including_callee)`
    pub active_call_chains: HashMap<Uuid, (String, Vec<Uuid>)>,
    /// Per-caller-session trusted cross-folder repo paths approved via SmartApproval (`always`).
    pub trusted_cross_folders: HashMap<Uuid, HashSet<String>>,
    /// Waiters blocked on `wait=true` or `velo_wait_invocations`.
    pub waiters: HashMap<String, Vec<oneshot::Sender<MeshInvocationInfo>>>,
    /// Per-session bearer token for `velo mesh` CLI fallback authentication.
    pub session_tokens: HashMap<Uuid, String>,
}

impl MeshRuntime {
    pub fn load(db: &crate::storage::VeloSqliteStore) -> Self {
        let settings = db
            .get_kv(MESH_SETTINGS_KV_KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<MeshSettings>(&raw).ok())
            .unwrap_or_default();

        let mut invocations = HashMap::new();
        if let Ok(list) = db.load_invocations(300) {
            for mut inv in list {
                if matches!(
                    inv.status,
                    MeshInvocationStatus::PendingApproval
                        | MeshInvocationStatus::Queued
                        | MeshInvocationStatus::Running
                ) {
                    inv.status = MeshInvocationStatus::Cancelled;
                    inv.completed_at = Some(Utc::now());
                    let _ = db.upsert_invocation(&inv);
                }
                invocations.insert(inv.id.clone(), inv);
            }
        }

        Self {
            settings,
            invocations,
            ..Self::default()
        }
    }

    pub fn ensure_session_token(&mut self, session_id: Uuid) -> String {
        self.session_tokens
            .entry(session_id)
            .or_insert_with(|| format!("vmt-{}", Uuid::new_v4().simple()))
            .clone()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeshAskParams {
    pub caller_session_id: Option<Uuid>,
    pub target_session_id: Uuid,
    pub prompt: String,
    #[serde(default = "default_true")]
    pub wait: bool,
    #[serde(default)]
    pub delivery: Option<String>,
    #[serde(default)]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeshSpawnParams {
    pub caller_session_id: Option<Uuid>,
    pub repo_path: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub use_worktree: Option<bool>,
    #[serde(default = "default_true")]
    pub wait: bool,
    #[serde(default)]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeshWaitParams {
    pub invocation_ids: Vec<String>,
    #[serde(default)]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionContextPacket {
    pub session_id: Uuid,
    pub name: String,
    pub provider: String,
    pub repo_root: String,
    pub branch: String,
    pub status: SessionStatus,
    pub diff_stats: velo_protocol::GitDiffStats,
    pub recent_turns: Vec<TurnDigest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unified_diff_excerpt: Option<String>,
    pub summary_markdown: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnDigest {
    pub turn_index: usize,
    pub user: String,
    pub assistant: String,
}

fn default_true() -> bool {
    true
}

fn folder_display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("workspace")
        .to_string()
}

fn extract_recent_turns(events: &[AgentEvent], fallback_prompt: &str, max_turns: usize) -> Vec<TurnDigest> {
    let mut turns: Vec<(String, Vec<String>)> = Vec::new();
    for ev in events {
        match ev {
            AgentEvent::UserMessage { text, .. } => {
                let t = text.trim();
                if !t.is_empty() {
                    turns.push((t.to_string(), Vec::new()));
                }
            }
            AgentEvent::MessageDelta { text, .. } => {
                let t = text.trim();
                if t.is_empty() {
                    continue;
                }
                if turns.is_empty() {
                    turns.push((fallback_prompt.trim().to_string(), Vec::new()));
                }
                if let Some(last) = turns.last_mut() {
                    last.1.push(t.to_string());
                }
            }
            _ => {}
        }
    }

    let total = turns.len();
    let start = total.saturating_sub(max_turns.max(1));
    turns
        .into_iter()
        .enumerate()
        .skip(start)
        .map(|(idx, (u, asst_parts))| {
            let user_clean = truncate_utf8_tail(&u, 600);
            let joined = asst_parts.join("\n\n");
            let asst_clean = if joined.len() > 1200 {
                format!("…{}", truncate_utf8_tail(&joined, 1200))
            } else {
                joined
            };
            TurnDigest {
                turn_index: idx + 1,
                user: user_clean,
                assistant: asst_clean,
            }
        })
        .collect()
}

fn latest_assistant_reply(events: &[AgentEvent], min_index: usize) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for ev in events.iter().skip(min_index) {
        if let AgentEvent::MessageDelta { text, .. } = ev {
            let t = text.trim();
            if !t.is_empty() {
                parts.push(t.to_string());
            }
        }
    }
    if parts.is_empty() {
        for ev in events.iter().rev() {
            if let AgentEvent::MessageDelta { text, .. } = ev {
                let t = text.trim();
                if !t.is_empty() {
                    return Some(truncate_utf8_tail(t, 2400));
                }
            }
        }
        return None;
    }
    let joined = parts.join("\n\n");
    Some(if joined.len() > 2400 {
        format!("…{}", truncate_utf8_tail(&joined, 2400))
    } else {
        joined
    })
}

impl DaemonState {
    pub async fn get_mesh_settings(&self) -> MeshSettings {
        self.mesh.read().await.settings.clone()
    }

    pub async fn update_mesh_settings(&self, mut next: MeshSettings) -> Result<MeshSettings> {
        next.max_depth = next.max_depth.clamp(1, 8);
        next.max_room_hops = next.max_room_hops.clamp(2, 50);
        {
            let mut guard = self.mesh.write().await;
            guard.settings = next.clone();
        }
        if let Ok(raw) = serde_json::to_string(&next) {
            let _ = self.db.set_kv(MESH_SETTINGS_KV_KEY, &raw);
        }
        Ok(next)
    }

    pub async fn ensure_mesh_token_for_session(&self, session_id: Uuid) -> String {
        self.mesh.write().await.ensure_session_token(session_id)
    }

    pub async fn list_mesh_invocations(&self, session_filter: Option<Uuid>) -> Vec<MeshInvocationInfo> {
        let guard = self.mesh.read().await;
        let mut items: Vec<MeshInvocationInfo> = guard
            .invocations
            .values()
            .filter(|inv| {
                session_filter.map_or(true, |sid| {
                    inv.caller_session_id == sid || inv.callee_session_id == Some(sid)
                })
            })
            .cloned()
            .collect();
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items.truncate(120);
        items
    }

    /// Mode A: Read-only compact context summary of another session (zero wakeup, zero side-effects).
    pub async fn mesh_read_session_summary(
        &self,
        session_id: Uuid,
        last_turns: usize,
        include_diff: bool,
    ) -> Result<SessionContextPacket> {
        let (session, events) = {
            let guard = self.inner.read().await;
            let Some(s) = guard.sessions.get(&session_id).cloned() else {
                anyhow::bail!("Session {} not found", session_id);
            };
            let evs = guard
                .event_history
                .get(&session_id)
                .cloned()
                .unwrap_or_default();
            (s, evs)
        };

        let recent_turns = extract_recent_turns(&events, &session.prompt, last_turns.clamp(1, 12));
        let unified_diff_excerpt = if include_diff {
            let wt = PathBuf::from(&session.worktree_path);
            let raw = WorktreeManager::get_unified_diff(&wt).await.unwrap_or_default();
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else if trimmed.len() > 6000 {
                Some(format!("{}\n… [diff truncated]", &trimmed[..trimmed.floor_char_boundary(6000)]))
            } else {
                Some(trimmed.to_string())
            }
        } else {
            None
        };

        let provider_label = clean_provider_badge(&session.provider).to_string();
        let mut md = String::new();
        md.push_str(&format!(
            "### Referenced Session: `{}` (id: `{}`)\n",
            session.name, session.id
        ));
        md.push_str(&format!(
            "- Engine: {} | Repo: `{}` | Branch: `{}` | Status: `{}`\n",
            provider_label, session.repo_root, session.branch, session.status
        ));
        if !session.diff_stats.modified_files.is_empty() {
            md.push_str(&format!(
                "- Modified files (+{} -{}): {}\n",
                session.diff_stats.insertions,
                session.diff_stats.deletions,
                session.diff_stats.modified_files.join(", ")
            ));
        }
        for t in &recent_turns {
            md.push_str(&format!("\n**Turn {} User**: {}\n", t.turn_index, t.user));
            if !t.assistant.is_empty() {
                md.push_str(&format!("**Turn {} Assistant**: {}\n", t.turn_index, t.assistant));
            }
        }
        if let Some(ref d) = unified_diff_excerpt {
            md.push_str("\n```diff\n");
            md.push_str(d);
            md.push_str("\n```\n");
        }
        md.push_str(&format!(
            "\n> Tip: Call `velo_read_session(session_id=\"{}\", include_diff=true)` if you need deeper details or diffs.",
            session.id
        ));

        Ok(SessionContextPacket {
            session_id: session.id,
            name: session.name,
            provider: provider_label,
            repo_root: session.repo_root,
            branch: session.branch,
            status: session.status,
            diff_stats: session.diff_stats,
            recent_turns,
            unified_diff_excerpt,
            summary_markdown: md,
        })
    }

    /// Mode A: Expand `@session` / `@workspace` context references attached to a composer message.
    pub async fn expand_mesh_context_refs(&self, refs: &[MeshContextRef]) -> Option<String> {
        if refs.is_empty() {
            return None;
        }
        let mut blocks: Vec<String> = Vec::new();
        for r in refs.iter().take(5) {
            match r.kind.as_str() {
                "session" => {
                    if let Ok(sid) = Uuid::parse_str(r.target_id.trim()) {
                        if let Ok(pkt) = self.mesh_read_session_summary(sid, 4, false).await {
                            blocks.push(pkt.summary_markdown);
                        }
                    }
                }
                "workspace" => {
                    let target_canon = canonical_workspace_path(&r.target_id);
                    let matched_sessions: Vec<Uuid> = {
                        let guard = self.inner.read().await;
                        let mut list: Vec<_> = guard
                            .sessions
                            .values()
                            .filter(|s| {
                                !s.archived
                                    && canonical_workspace_path(&s.repo_root) == target_canon
                            })
                            .collect();
                        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                        list.into_iter().take(2).map(|s| s.id).collect()
                    };
                    let mut ws_block = format!(
                        "### Referenced Workspace: `{}` (`{}`)\n",
                        folder_display_name(&target_canon),
                        target_canon
                    );
                    if matched_sessions.is_empty() {
                        ws_block.push_str("- No active sessions yet in this workspace.\n");
                    } else {
                        for sid in matched_sessions {
                            if let Ok(pkt) = self.mesh_read_session_summary(sid, 2, false).await {
                                ws_block.push_str(&pkt.summary_markdown);
                                ws_block.push('\n');
                            }
                        }
                    }
                    blocks.push(ws_block);
                }
                _ => {}
            }
        }
        if blocks.is_empty() {
            None
        } else {
            Some(format!(
                "[Velo Mesh Referenced Context]\n{}\n[End Referenced Context]",
                blocks.join("\n---\n")
            ))
        }
    }

    /// Emit & persist an invocation update on the caller session stream.
    async fn record_and_emit_invocation(&self, inv: &MeshInvocationInfo) {
        {
            let mut guard = self.mesh.write().await;
            guard.invocations.insert(inv.id.clone(), inv.clone());
        }
        let _ = self.db.upsert_invocation(inv);
        let _ = self.agent_event_tx.send(AgentEvent::MeshInvocationUpdated {
            session_id: inv.caller_session_id,
            invocation: inv.clone(),
            timestamp: Utc::now(),
        });
    }

    async fn finish_invocation(
        &self,
        inv_id: &str,
        status: MeshInvocationStatus,
        result_summary: Option<String>,
        diff_stats: Option<velo_protocol::GitDiffStats>,
        error: Option<String>,
    ) -> Option<MeshInvocationInfo> {
        let (updated, waiters) = {
            let mut guard = self.mesh.write().await;
            let Some(inv) = guard.invocations.get_mut(inv_id) else {
                return None;
            };
            inv.status = status;
            inv.result_summary = result_summary;
            inv.diff_stats = diff_stats;
            inv.error = error;
            inv.completed_at = Some(Utc::now());
            let cloned = inv.clone();
            if let Some(callee_id) = cloned.callee_session_id {
                guard.active_call_chains.remove(&callee_id);
            }
            let w = guard.waiters.remove(inv_id).unwrap_or_default();
            (cloned, w)
        };
        let _ = self.db.upsert_invocation(&updated);
        let _ = self.agent_event_tx.send(AgentEvent::MeshInvocationUpdated {
            session_id: updated.caller_session_id,
            invocation: updated.clone(),
            timestamp: Utc::now(),
        });
        for tx in waiters {
            let _ = tx.send(updated.clone());
        }
        Some(updated)
    }

    /// Check SmartApproval / WorkspaceAuto / AlwaysAsk policy for cross-folder execution.
    async fn check_cross_folder_permission(
        &self,
        caller_id: Option<Uuid>,
        caller_repo: &str,
        target_repo: &str,
        action_preview: String,
        reason: &str,
        pending_inv: &mut MeshInvocationInfo,
    ) -> Result<()> {
        let caller_canon = canonical_workspace_path(caller_repo);
        let target_canon = canonical_workspace_path(target_repo);
        if caller_canon == target_canon {
            return Ok(());
        }

        let (policy, already_trusted, known_workspace) = {
            let m = self.mesh.read().await;
            let trusted = caller_id
                .and_then(|cid| m.trusted_cross_folders.get(&cid))
                .map(|set| set.contains(&target_canon))
                .unwrap_or(false);
            let inner = self.inner.read().await;
            let in_ws = inner
                .workspaces
                .iter()
                .any(|w| canonical_workspace_path(w) == target_canon)
                || inner
                    .sessions
                    .values()
                    .any(|s| canonical_workspace_path(&s.repo_root) == target_canon);
            (m.settings.policy, trusted, in_ws)
        };

        let needs_approval = match policy {
            MeshPermissionPolicy::SmartApproval => !already_trusted,
            MeshPermissionPolicy::WorkspaceAuto => !known_workspace && !already_trusted,
            MeshPermissionPolicy::AlwaysAsk => true,
        };

        if !needs_approval {
            return Ok(());
        }

        let Some(cid) = caller_id else {
            // Human/CLI direct call without a caller session does not need interactive agent gate
            return Ok(());
        };

        pending_inv.status = MeshInvocationStatus::PendingApproval;
        self.record_and_emit_invocation(pending_inv).await;

        let decision = self
            .await_permission_gate(cid, "VeloMesh", Some(action_preview), reason)
            .await;

        if decision == "deny" {
            let _ = self
                .finish_invocation(
                    &pending_inv.id,
                    MeshInvocationStatus::Cancelled,
                    None,
                    None,
                    Some("Cross-folder call denied by user".to_string()),
                )
                .await;
            anyhow::bail!("Cross-folder Mesh call to `{}` was denied by user", target_canon);
        }

        if decision == "always" {
            let mut m = self.mesh.write().await;
            m.trusted_cross_folders
                .entry(cid)
                .or_default()
                .insert(target_canon);
        }
        Ok(())
    }

    /// Mode B: Ask an existing session (same or different folder/engine) to perform a task.
    pub async fn mesh_ask_session(&self, params: MeshAskParams) -> Result<MeshInvocationInfo> {
        let prompt = params.prompt.trim().to_string();
        if prompt.is_empty() {
            anyhow::bail!("prompt cannot be empty");
        }

        let (caller_info, target_info, target_initial_ev_len) = {
            let guard = self.inner.read().await;
            let Some(target) = guard.sessions.get(&params.target_session_id).cloned() else {
                anyhow::bail!("Target session {} not found", params.target_session_id);
            };
            let caller = params
                .caller_session_id
                .and_then(|cid| guard.sessions.get(&cid).cloned());
            let ev_len = guard
                .event_history
                .get(&params.target_session_id)
                .map(|v| v.len())
                .unwrap_or(0);
            (caller, target, ev_len)
        };

        let caller_id = params.caller_session_id.unwrap_or(Uuid::nil());
        let inv_id = format!("inv-{}", Uuid::new_v4().simple());

        // Loop & Depth Guard
        let (root_id, depth, next_chain) = {
            let m = self.mesh.read().await;
            let max_depth = m.settings.max_depth;
            if let Some(cid) = params.caller_session_id {
                if cid == params.target_session_id {
                    anyhow::bail!(
                        "Circular call blocked: session cannot call itself (`{}`)",
                        target_info.name
                    );
                }
                let (root, mut chain) = m
                    .active_call_chains
                    .get(&cid)
                    .cloned()
                    .unwrap_or_else(|| (inv_id.clone(), vec![cid]));
                if chain.contains(&params.target_session_id) {
                    anyhow::bail!(
                        "Circular cross-session call detected: target `{}` is already in ancestor call_chain. Return your result directly instead of calling back.",
                        target_info.name
                    );
                }
                let d = chain.len() as u32;
                if d > max_depth {
                    anyhow::bail!(
                        "Max cross-session call depth ({}) exceeded. Complete the task locally or report back to parent.",
                        max_depth
                    );
                }
                chain.push(params.target_session_id);
                (root, d, chain)
            } else {
                (inv_id.clone(), 1, vec![params.target_session_id])
            }
        };

        let caller_repo = caller_info
            .as_ref()
            .map(|c| c.repo_root.clone())
            .unwrap_or_else(|| target_info.repo_root.clone());
        let caller_name = caller_info
            .as_ref()
            .map(|c| c.name.clone())
            .unwrap_or_else(|| "Velo CLI".to_string());
        let caller_provider = caller_info
            .as_ref()
            .map(|c| clean_provider_badge(&c.provider).to_string())
            .unwrap_or_else(|| "velo".to_string());

        let mut inv = MeshInvocationInfo {
            id: inv_id.clone(),
            caller_session_id: caller_id,
            caller_session_name: caller_name.clone(),
            caller_provider: caller_provider.clone(),
            caller_repo_root: caller_repo.clone(),
            callee_session_id: Some(target_info.id),
            callee_session_name: target_info.name.clone(),
            callee_provider: clean_provider_badge(&target_info.provider).to_string(),
            callee_repo_root: target_info.repo_root.clone(),
            root_invocation_id: root_id.clone(),
            depth,
            call_chain: next_chain.clone(),
            kind: MeshInvocationKind::Ask,
            prompt: prompt.clone(),
            status: MeshInvocationStatus::Running,
            result_summary: None,
            diff_stats: None,
            error: None,
            created_at: Utc::now(),
            completed_at: None,
        };

        // SmartApproval Cross-Folder Gate
        self.check_cross_folder_permission(
            params.caller_session_id,
            &caller_repo,
            &target_info.repo_root,
            format!(
                "跨目录调用会话「{}」({})\n指令：{}",
                target_info.name,
                target_info.repo_root,
                truncate_utf8_tail(&prompt, 240)
            ),
            &format!(
                "会话「{}」({}) 请求向「{}」({}) 派发协作任务",
                caller_name,
                folder_display_name(&caller_repo),
                target_info.name,
                folder_display_name(&target_info.repo_root)
            ),
            &mut inv,
        )
        .await?;

        // Subscribe BEFORE dispatching so we never miss a fast completion event
        let mut rx = self.agent_event_tx.subscribe();
        let (wait_tx, wait_rx) = oneshot::channel::<MeshInvocationInfo>();
        {
            let mut m = self.mesh.write().await;
            m.active_call_chains
                .insert(target_info.id, (root_id.clone(), next_chain.clone()));
            if params.wait {
                m.waiters.entry(inv_id.clone()).or_default().push(wait_tx);
            }
        }

        let delivery = params
            .delivery
            .as_deref()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| s == "queue" || s == "steer")
            .unwrap_or_else(|| "queue".to_string());

        let source_label = format!(
            "来自 {} · {}",
            folder_display_name(&caller_repo),
            caller_provider
        );

        let dispatch_res = self
            .dispatch_session_input(
                target_info.id,
                SessionInputRequest {
                    input: prompt.clone(),
                    model: None,
                    effort: None,
                    provider: None,
                    reset_thread: false,
                    truncate_to_user_turn: None,
                    images: Vec::new(),
                    approval_mode: None,
                    mode: Some(delivery.clone()),
                    skill_path: None,
                    client_msg_id: Some(format!("mesh-{}", inv_id)),
                    context_refs: Vec::new(),
                    source_session_id: params.caller_session_id,
                    source_label: Some(source_label),
                },
            )
            .await;

        let was_queued = match dispatch_res {
            Ok(v) => v.get("queued").and_then(|q| q.as_bool()).unwrap_or(false),
            Err(e) => {
                let _ = self
                    .finish_invocation(
                        &inv_id,
                        MeshInvocationStatus::Failed,
                        None,
                        None,
                        Some(e.to_string()),
                    )
                    .await;
                return Err(e);
            }
        };

        inv.status = if was_queued {
            MeshInvocationStatus::Queued
        } else {
            MeshInvocationStatus::Running
        };
        self.record_and_emit_invocation(&inv).await;

        // Spawn watcher task to track target turn completion
        let state_bg = self.clone();
        let inv_id_bg = inv_id.clone();
        let target_id = target_info.id;
        let prompt_marker = prompt.clone();
        tokio::spawn(async move {
            let mut saw_our_turn_started = !was_queued;
            loop {
                match rx.recv().await {
                    Ok(ev) if ev.session_id() == target_id => match ev {
                        AgentEvent::UserMessage { text, .. } if was_queued => {
                            if text.trim() == prompt_marker.trim() {
                                saw_our_turn_started = true;
                                if let Some(mut cur) =
                                    state_bg.mesh.read().await.invocations.get(&inv_id_bg).cloned()
                                {
                                    if cur.status == MeshInvocationStatus::Queued {
                                        cur.status = MeshInvocationStatus::Running;
                                        state_bg.record_and_emit_invocation(&cur).await;
                                    }
                                }
                            }
                        }
                        AgentEvent::StatusChanged { status, message, .. }
                            if saw_our_turn_started
                                && matches!(
                                    status,
                                    SessionStatus::Completed
                                        | SessionStatus::Failed
                                        | SessionStatus::Stopped
                                ) =>
                        {
                            let (summary, diff_stats) = {
                                let guard = state_bg.inner.read().await;
                                let evs = guard
                                    .event_history
                                    .get(&target_id)
                                    .map(|v| v.as_slice())
                                    .unwrap_or(&[]);
                                let reply = latest_assistant_reply(evs, target_initial_ev_len);
                                let stats = guard
                                    .sessions
                                    .get(&target_id)
                                    .map(|s| s.diff_stats.clone());
                                (reply, stats)
                            };
                            let final_status = match status {
                                SessionStatus::Completed => MeshInvocationStatus::Completed,
                                SessionStatus::Failed => MeshInvocationStatus::Failed,
                                _ => MeshInvocationStatus::Cancelled,
                            };
                            let err = if final_status == MeshInvocationStatus::Completed {
                                None
                            } else {
                                message
                            };
                            let _ = state_bg
                                .finish_invocation(&inv_id_bg, final_status, summary, diff_stats, err)
                                .await;
                            break;
                        }
                        _ => {}
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Re-check session status directly
                        let st = state_bg
                            .inner
                            .read()
                            .await
                            .sessions
                            .get(&target_id)
                            .map(|s| s.status);
                        if saw_our_turn_started
                            && matches!(
                                st,
                                Some(
                                    SessionStatus::Completed
                                        | SessionStatus::Failed
                                        | SessionStatus::Stopped
                                )
                            )
                        {
                            let (summary, diff_stats) = {
                                let guard = state_bg.inner.read().await;
                                let evs = guard
                                    .event_history
                                    .get(&target_id)
                                    .map(|v| v.as_slice())
                                    .unwrap_or(&[]);
                                (
                                    latest_assistant_reply(evs, target_initial_ev_len),
                                    guard.sessions.get(&target_id).map(|s| s.diff_stats.clone()),
                                )
                            };
                            let _ = state_bg
                                .finish_invocation(
                                    &inv_id_bg,
                                    if st == Some(SessionStatus::Completed) {
                                        MeshInvocationStatus::Completed
                                    } else {
                                        MeshInvocationStatus::Failed
                                    },
                                    summary,
                                    diff_stats,
                                    None,
                                )
                                .await;
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    _ => {}
                }
            }
        });

        if !params.wait {
            return Ok(inv);
        }

        let timeout_secs = params.timeout_sec.unwrap_or(300).clamp(5, 1800);
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), wait_rx).await {
            Ok(Ok(done)) => Ok(done),
            _ => {
                // Per agreed Topic 3: do NOT kill the target session on wait timeout!
                let mut timed = self
                    .mesh
                    .read()
                    .await
                    .invocations
                    .get(&inv_id)
                    .cloned()
                    .unwrap_or(inv);
                if !matches!(
                    timed.status,
                    MeshInvocationStatus::Completed
                        | MeshInvocationStatus::Failed
                        | MeshInvocationStatus::Cancelled
                ) {
                    timed.status = MeshInvocationStatus::TimedOut;
                    self.record_and_emit_invocation(&timed).await;
                }
                Ok(timed)
            }
        }
    }

    /// Mode B: Spawn a new session in any folder (cross-repo direct or same-repo isolated worktree).
    pub async fn mesh_spawn_session(&self, params: MeshSpawnParams) -> Result<MeshInvocationInfo> {
        let prompt = params.prompt.trim().to_string();
        if prompt.is_empty() {
            anyhow::bail!("prompt cannot be empty");
        }

        let caller_info = if let Some(cid) = params.caller_session_id {
            self.inner.read().await.sessions.get(&cid).cloned()
        } else {
            None
        };
        let caller_id = params.caller_session_id.unwrap_or(Uuid::nil());
        let caller_repo = caller_info
            .as_ref()
            .map(|c| c.repo_root.clone())
            .unwrap_or_else(|| params.repo_path.clone());
        let target_repo_canon = canonical_workspace_path(&params.repo_path);
        let caller_repo_canon = canonical_workspace_path(&caller_repo);
        let is_same_repo = caller_repo_canon == target_repo_canon;

        // Topic 3 Smart Worktree default:
        // - Cross-folder -> false (direct edit in target repo for immediate joint debugging)
        // - Same-folder concurrent child -> true (isolated Git worktree to prevent write clobber)
        let use_worktree = params
            .use_worktree
            .unwrap_or_else(|| is_same_repo && params.caller_session_id.is_some());

        let provider = params
            .provider
            .as_deref()
            .map(AgentProvider::from_str_loose)
            .or_else(|| caller_info.as_ref().map(|c| c.provider.clone()))
            .unwrap_or(AgentProvider::Claude);

        let inv_id = format!("inv-{}", Uuid::new_v4().simple());

        // Depth Guard
        let (root_id, depth, mut next_chain) = {
            let m = self.mesh.read().await;
            let max_depth = m.settings.max_depth;
            if let Some(cid) = params.caller_session_id {
                let (root, chain) = m
                    .active_call_chains
                    .get(&cid)
                    .cloned()
                    .unwrap_or_else(|| (inv_id.clone(), vec![cid]));
                let d = chain.len() as u32;
                if d > max_depth {
                    anyhow::bail!(
                        "Max cross-session call depth ({}) exceeded. Complete locally or return to parent.",
                        max_depth
                    );
                }
                (root, d, chain)
            } else {
                (inv_id.clone(), 1, Vec::new())
            }
        };

        let caller_name = caller_info
            .as_ref()
            .map(|c| c.name.clone())
            .unwrap_or_else(|| "Velo CLI".to_string());
        let caller_provider = caller_info
            .as_ref()
            .map(|c| clean_provider_badge(&c.provider).to_string())
            .unwrap_or_else(|| "velo".to_string());
        let callee_provider_label = clean_provider_badge(&provider).to_string();

        let mut inv = MeshInvocationInfo {
            id: inv_id.clone(),
            caller_session_id: caller_id,
            caller_session_name: caller_name.clone(),
            caller_provider: caller_provider.clone(),
            caller_repo_root: caller_repo_canon.clone(),
            callee_session_id: None,
            callee_session_name: params
                .name
                .clone()
                .unwrap_or_else(|| format!("{} · {}", folder_display_name(&target_repo_canon), callee_provider_label)),
            callee_provider: callee_provider_label.clone(),
            callee_repo_root: target_repo_canon.clone(),
            root_invocation_id: root_id.clone(),
            depth,
            call_chain: next_chain.clone(),
            kind: MeshInvocationKind::Spawn,
            prompt: prompt.clone(),
            status: MeshInvocationStatus::Running,
            result_summary: None,
            diff_stats: None,
            error: None,
            created_at: Utc::now(),
            completed_at: None,
        };

        // SmartApproval Cross-Folder Gate
        self.check_cross_folder_permission(
            params.caller_session_id,
            &caller_repo_canon,
            &target_repo_canon,
            format!(
                "跨目录新建 {} 会话 ({})\n指令：{}",
                callee_provider_label,
                target_repo_canon,
                truncate_utf8_tail(&prompt, 240)
            ),
            &format!(
                "会话「{}」({}) 请求在「{}」新建 {} 会话并执行任务",
                caller_name,
                folder_display_name(&caller_repo_canon),
                target_repo_canon,
                callee_provider_label
            ),
            &mut inv,
        )
        .await?;

        let mut rx = self.agent_event_tx.subscribe();
        let created = match self
            .create_session(CreateSessionRequest {
                name: params.name.clone(),
                provider,
                prompt: prompt.clone(),
                repo_path: target_repo_canon.clone(),
                branch: params.branch.clone(),
                use_pty: false,
                parent_session_id: params.caller_session_id,
                model: params.model.clone(),
                effort: params.effort.clone(),
                images: Vec::new(),
                approval_mode: None,
                setup_command: None,
                use_worktree,
                client_msg_id: Some(format!("mesh-spawn-{}", inv_id)),
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                let _ = self
                    .finish_invocation(
                        &inv_id,
                        MeshInvocationStatus::Failed,
                        None,
                        None,
                        Some(e.to_string()),
                    )
                    .await;
                return Err(e);
            }
        };

        next_chain.push(created.id);
        inv.callee_session_id = Some(created.id);
        inv.callee_session_name = created.name.clone();
        inv.call_chain = next_chain.clone();
        inv.status = MeshInvocationStatus::Running;

        let (wait_tx, wait_rx) = oneshot::channel::<MeshInvocationInfo>();
        {
            let mut m = self.mesh.write().await;
            m.active_call_chains
                .insert(created.id, (root_id.clone(), next_chain.clone()));
            if params.wait {
                m.waiters.entry(inv_id.clone()).or_default().push(wait_tx);
            }
        }
        self.record_and_emit_invocation(&inv).await;

        let state_bg = self.clone();
        let inv_id_bg = inv_id.clone();
        let target_id = created.id;
        tokio::spawn(async move {
            // Check if it already completed instantaneously (e.g. fast custom command in tests)
            let already_done = state_bg
                .inner
                .read()
                .await
                .sessions
                .get(&target_id)
                .map(|s| s.status);
            if matches!(
                already_done,
                Some(SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Stopped)
            ) {
                let (summary, diff_stats) = {
                    let guard = state_bg.inner.read().await;
                    let evs = guard.event_history.get(&target_id).map(|v| v.as_slice()).unwrap_or(&[]);
                    (
                        latest_assistant_reply(evs, 0),
                        guard.sessions.get(&target_id).map(|s| s.diff_stats.clone()),
                    )
                };
                let _ = state_bg
                    .finish_invocation(
                        &inv_id_bg,
                        if already_done == Some(SessionStatus::Completed) {
                            MeshInvocationStatus::Completed
                        } else {
                            MeshInvocationStatus::Failed
                        },
                        summary,
                        diff_stats,
                        None,
                    )
                    .await;
                return;
            }

            loop {
                match rx.recv().await {
                    Ok(ev) if ev.session_id() == target_id => {
                        if let AgentEvent::StatusChanged { status, message, .. } = ev {
                            if matches!(
                                status,
                                SessionStatus::Completed
                                    | SessionStatus::Failed
                                    | SessionStatus::Stopped
                            ) {
                                let (summary, diff_stats) = {
                                    let guard = state_bg.inner.read().await;
                                    let evs = guard
                                        .event_history
                                        .get(&target_id)
                                        .map(|v| v.as_slice())
                                        .unwrap_or(&[]);
                                    (
                                        latest_assistant_reply(evs, 0),
                                        guard.sessions.get(&target_id).map(|s| s.diff_stats.clone()),
                                    )
                                };
                                let final_status = match status {
                                    SessionStatus::Completed => MeshInvocationStatus::Completed,
                                    SessionStatus::Failed => MeshInvocationStatus::Failed,
                                    _ => MeshInvocationStatus::Cancelled,
                                };
                                let err = if final_status == MeshInvocationStatus::Completed {
                                    None
                                } else {
                                    message
                                };
                                let _ = state_bg
                                    .finish_invocation(&inv_id_bg, final_status, summary, diff_stats, err)
                                    .await;
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    _ => {}
                }
            }
        });

        if !params.wait {
            return Ok(inv);
        }

        let timeout_secs = params.timeout_sec.unwrap_or(300).clamp(5, 1800);
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), wait_rx).await {
            Ok(Ok(done)) => Ok(done),
            _ => {
                let mut timed = self
                    .mesh
                    .read()
                    .await
                    .invocations
                    .get(&inv_id)
                    .cloned()
                    .unwrap_or(inv);
                if !matches!(
                    timed.status,
                    MeshInvocationStatus::Completed
                        | MeshInvocationStatus::Failed
                        | MeshInvocationStatus::Cancelled
                ) {
                    timed.status = MeshInvocationStatus::TimedOut;
                    self.record_and_emit_invocation(&timed).await;
                }
                Ok(timed)
            }
        }
    }

    /// Wait for a batch of async invocations (`wait=false`) to finish.
    pub async fn mesh_wait_invocations(&self, params: MeshWaitParams) -> Vec<MeshInvocationInfo> {
        let timeout_secs = params.timeout_sec.unwrap_or(300).clamp(5, 1800);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let mut results: Vec<MeshInvocationInfo> = Vec::new();

        for inv_id in &params.invocation_ids {
            let (existing, rx_opt) = {
                let mut m = self.mesh.write().await;
                let Some(inv) = m.invocations.get(inv_id).cloned() else {
                    continue;
                };
                if matches!(
                    inv.status,
                    MeshInvocationStatus::Completed
                        | MeshInvocationStatus::Failed
                        | MeshInvocationStatus::Cancelled
                ) {
                    (inv, None)
                } else {
                    let (tx, rx) = oneshot::channel();
                    m.waiters.entry(inv_id.clone()).or_default().push(tx);
                    (inv, Some(rx))
                }
            };

            if let Some(rx) = rx_opt {
                let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
                if rem.is_zero() {
                    results.push(existing);
                } else if let Ok(Ok(done)) = tokio::time::timeout(rem, rx).await {
                    results.push(done);
                } else {
                    let latest = self
                        .mesh
                        .read()
                        .await
                        .invocations
                        .get(inv_id)
                        .cloned()
                        .unwrap_or(existing);
                    results.push(latest);
                }
            } else {
                results.push(existing);
            }
        }
        results
    }

    /// Cascade Kill Switch: stop a specific invocation or all active descendant invocations of a stopped session.
    pub async fn mesh_cancel_descendants_of(&self, caller_session_id: Uuid) -> Vec<String> {
        let active_children: Vec<(String, Option<Uuid>)> = {
            let m = self.mesh.read().await;
            m.invocations
                .values()
                .filter(|inv| {
                    matches!(
                        inv.status,
                        MeshInvocationStatus::PendingApproval
                            | MeshInvocationStatus::Queued
                            | MeshInvocationStatus::Running
                    ) && (inv.caller_session_id == caller_session_id
                        || inv.call_chain.contains(&caller_session_id))
                        && inv.callee_session_id != Some(caller_session_id)
                })
                .map(|inv| (inv.id.clone(), inv.callee_session_id))
                .collect()
        };

        let mut cancelled_ids = Vec::new();
        for (inv_id, callee_opt) in active_children {
            cancelled_ids.push(inv_id.clone());
            let _ = self
                .finish_invocation(
                    &inv_id,
                    MeshInvocationStatus::Cancelled,
                    None,
                    None,
                    Some("Parent session stopped (cascade kill switch)".to_string()),
                )
                .await;
            if let Some(callee_id) = callee_opt {
                Box::pin(self.stop_session_by_id(callee_id)).await;
            }
        }
        cancelled_ids
    }

    pub async fn mesh_cancel_invocation(&self, inv_id: &str) -> Result<MeshInvocationInfo> {
        let callee_opt = {
            let m = self.mesh.read().await;
            let Some(inv) = m.invocations.get(inv_id) else {
                anyhow::bail!("Invocation {} not found", inv_id);
            };
            inv.callee_session_id
        };
        let done = self
            .finish_invocation(
                inv_id,
                MeshInvocationStatus::Cancelled,
                None,
                None,
                Some("Cancelled by user".to_string()),
            )
            .await
            .ok_or_else(|| anyhow::anyhow!("Invocation not found"))?;
        if let Some(callee_id) = callee_opt {
            self.stop_session_by_id(callee_id).await;
        }
        Ok(done)
    }

    /// Build MCP tool definitions for Velo Mesh (Phase 1 + Phase 2).
    pub fn mesh_mcp_tool_definitions() -> Vec<Value> {
        vec![
            json!({
                "name": "velo_read_session",
                "description": "Read another Velo session's compact summary, recent turns, modified files, and optional unified git diff (read-only, zero wakeup).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "session_id": { "type": "string", "description": "Target session UUID (from velo_list_sessions)" },
                        "last_turns": { "type": "integer", "description": "Number of recent turns to include (default 6, max 12)" },
                        "include_diff": { "type": "boolean", "description": "Include truncated unified git diff excerpt (default true)" }
                    },
                    "required": ["session_id"]
                }
            }),
            json!({
                "name": "velo_ask_session",
                "description": "Send a task/question to another existing Velo session (same or different folder/engine). Defaults to queueing if busy and waiting for the result summary + diff.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "target_session_id": { "type": "string", "description": "Target session UUID" },
                        "prompt": { "type": "string", "description": "Clear instructions or question for the target session" },
                        "wait": { "type": "boolean", "description": "Wait for target turn completion and return summary (default true; set false for parallel fan-out)" },
                        "delivery": { "type": "string", "enum": ["queue", "steer"], "description": "Behavior if target is busy: queue (default) or steer" },
                        "timeout_sec": { "type": "integer", "description": "Max seconds to wait when wait=true (default 300; timeout does not kill target)" }
                    },
                    "required": ["target_session_id", "prompt"]
                }
            }),
            json!({
                "name": "velo_spawn_session",
                "description": "Spawn a new Velo session in any repository folder with a chosen AI engine (claude, codex, agy, cursor, grok, opencode) and optionally wait for its result. Cross-folder defaults to direct edits for joint debugging; same-folder defaults to isolated Git worktree.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_path": { "type": "string", "description": "Absolute repository folder path on this machine" },
                        "prompt": { "type": "string", "description": "Task instructions for the new session" },
                        "provider": { "type": "string", "description": "AI engine: claude, codex, agy, cursor, grok, opencode (defaults to caller engine)" },
                        "model": { "type": "string", "description": "Optional specific model id" },
                        "effort": { "type": "string", "description": "Optional reasoning effort (low, medium, high, max)" },
                        "name": { "type": "string", "description": "Optional short display title" },
                        "branch": { "type": "string", "description": "Optional git branch name" },
                        "use_worktree": { "type": "boolean", "description": "Override smart default (false for cross-repo, true for same-repo)" },
                        "wait": { "type": "boolean", "description": "Wait for completion and return summary (default true)" },
                        "timeout_sec": { "type": "integer", "description": "Max wait seconds (default 300)" }
                    },
                    "required": ["repo_path", "prompt"]
                }
            }),
            json!({
                "name": "velo_wait_invocations",
                "description": "Wait for one or more asynchronous cross-session invocations (started with wait=false) to finish and return their results.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "invocation_ids": { "type": "array", "items": { "type": "string" }, "description": "Invocation IDs to wait for" },
                        "timeout_sec": { "type": "integer", "description": "Max seconds to wait (default 300)" }
                    },
                    "required": ["invocation_ids"]
                }
            }),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use velo_protocol::{GitDiffStats, SessionInfo};

    #[tokio::test]
    async fn test_mesh_read_summary_and_loop_depth_guards() {
        let tmp = std::env::temp_dir().join(format!("velo-mesh-test-{}", Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&tmp);
        let db = crate::storage::VeloSqliteStore::open(&tmp.join("velo.db")).expect("open tmp db");
        let (agent_event_tx, _) = tokio::sync::broadcast::channel(64);
        let (event_tx, _) = tokio::sync::broadcast::channel(64);
        let (snapshot_tx, _) = tokio::sync::broadcast::channel(16);
        let state = DaemonState {
            inner: std::sync::Arc::new(tokio::sync::RwLock::new(crate::DaemonInner {
                sessions: HashMap::new(),
                event_history: HashMap::new(),
                live_turns: HashMap::new(),
                handles: HashMap::new(),
                warm_handles: HashMap::new(),
                suppressed_steer_stops: HashMap::new(),
                shells: HashMap::new(),
                pending_approvals: HashMap::new(),
                pending_questions: HashMap::new(),
                automations: Vec::new(),
                repo_hooks: HashMap::new(),
                workspaces: Vec::new(),
                push_config: crate::push::PushConfig::default(),
                quota_cache: crate::quota::PersistedQuotaCache::default(),
                remote_hosts: Vec::new(),
                host_identity: crate::hosts::HostIdentity {
                    host_id: "mesh-test".to_string(),
                    label: "MeshTest".to_string(),
                    os_info: "macos".to_string(),
                    arch: "aarch64".to_string(),
                    created_at: Utc::now(),
                },
                client_presences: HashMap::new(),
                monitor_version: 1,
            })),
            mesh: std::sync::Arc::new(tokio::sync::RwLock::new(MeshRuntime::default())),
            db,
            agent_event_tx,
            event_tx,
            snapshot_tx,
            worktree_mgr: WorktreeManager::default(),
            state_file: tmp.join("sessions.json"),
            events_dir: tmp.join("events"),
            attachments_dir: tmp.join("attachments"),
            automations_file: tmp.join("automations.json"),
            hooks_file: tmp.join("repo_hooks.json"),
            workspaces_file: tmp.join("workspaces.json"),
            push_config_file: tmp.join("push_config.json"),
            quota_cache_file: tmp.join("quotas.json"),
            hosts_file: tmp.join("hosts.json"),
            daemon_http_base: None,
        };
        let now = Utc::now();
        let sid_a = Uuid::new_v4();
        let sid_b = Uuid::new_v4();

        let make_sess = |id: Uuid, name: &str, repo: &str| SessionInfo {
            id,
            name: name.to_string(),
            provider: AgentProvider::Custom("true".to_string()),
            prompt: "initial".to_string(),
            repo_root: repo.to_string(),
            worktree_path: repo.to_string(),
            branch: "main".to_string(),
            status: SessionStatus::Completed,
            pid: None,
            diff_stats: GitDiffStats {
                files_changed: 1,
                insertions: 12,
                deletions: 3,
                modified_files: vec!["src/api.rs".to_string()],
            },
            created_at: now,
            updated_at: now,
            parent_session_id: None,
            provider_session_id: None,
            model: None,
            effort: None,
            tokens_used: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            context_window: 0,
            cost_usd: 0.0,
            approval_mode: "auto_edit".to_string(),
            preview_url: None,
            queued_prompts: Vec::new(),
            archived: false,
        };

        {
            let mut guard = state.inner.write().await;
            guard.sessions.insert(sid_a, make_sess(sid_a, "iOS Client", "/tmp/mesh-test-ios"));
            guard.sessions.insert(sid_b, make_sess(sid_b, "Backend API", "/tmp/mesh-test-backend"));
            guard.event_history.insert(
                sid_b,
                vec![
                    AgentEvent::UserMessage {
                        session_id: sid_b,
                        text: "Add order_total field to GET /orders".to_string(),
                        images: vec![],
                        client_msg_id: None,
                        source_session_id: None,
                        source_label: None,
                        timestamp: now,
                    },
                    AgentEvent::MessageDelta {
                        session_id: sid_b,
                        text: "Added `order_total: i64` to OrderDto and verified tests.".to_string(),
                        timestamp: now,
                    },
                ],
            );
        }

        // 1. Mode A: read summary + context_refs expansion
        let pkt = state
            .mesh_read_session_summary(sid_b, 4, false)
            .await
            .expect("summary ok");
        assert_eq!(pkt.name, "Backend API");
        assert!(pkt.summary_markdown.contains("order_total: i64"));
        assert!(pkt.summary_markdown.contains("src/api.rs"));

        let expanded = state
            .expand_mesh_context_refs(&[MeshContextRef {
                kind: "session".to_string(),
                target_id: sid_b.to_string(),
                label: Some("Backend API".to_string()),
            }])
            .await
            .expect("expanded context");
        assert!(expanded.contains("[Velo Mesh Referenced Context]"));
        assert!(expanded.contains("order_total: i64"));

        // 2. Self-call loop guard
        let self_err = state
            .mesh_ask_session(MeshAskParams {
                caller_session_id: Some(sid_a),
                target_session_id: sid_a,
                prompt: "loop myself".to_string(),
                wait: false,
                delivery: None,
                timeout_sec: None,
            })
            .await
            .expect_err("self-call must be blocked");
        assert!(self_err.to_string().contains("Circular"));

        // 3. Ancestor A -> B -> A loop guard
        {
            let mut m = state.mesh.write().await;
            m.active_call_chains
                .insert(sid_b, ("inv-root".to_string(), vec![sid_a, sid_b]));
        }
        let anc_err = state
            .mesh_ask_session(MeshAskParams {
                caller_session_id: Some(sid_b),
                target_session_id: sid_a,
                prompt: "call ancestor back".to_string(),
                wait: false,
                delivery: None,
                timeout_sec: None,
            })
            .await
            .expect_err("ancestor loop must be blocked");
        assert!(anc_err.to_string().contains("Circular"));

        // 4. Max depth guard (default max_depth = 3)
        let sid_c = Uuid::new_v4();
        let sid_d = Uuid::new_v4();
        {
            let mut guard = state.inner.write().await;
            guard.sessions.insert(sid_c, make_sess(sid_c, "Worker C", "/tmp/mesh-test-ios"));
            guard.sessions.insert(sid_d, make_sess(sid_d, "Worker D", "/tmp/mesh-test-ios"));
        }
        {
            let mut m = state.mesh.write().await;
            m.active_call_chains.insert(
                sid_c,
                ("inv-root".to_string(), vec![sid_a, sid_b, Uuid::new_v4(), sid_c]),
            );
        }
        let depth_err = state
            .mesh_ask_session(MeshAskParams {
                caller_session_id: Some(sid_c),
                target_session_id: sid_d,
                prompt: "too deep".to_string(),
                wait: false,
                delivery: None,
                timeout_sec: None,
            })
            .await
            .expect_err("depth > max_depth must be blocked");
        assert!(depth_err.to_string().contains("Max cross-session call depth"));

        // 5. MCP tool list includes all Velo Mesh tools
        let defs = DaemonState::mesh_mcp_tool_definitions();
        let names: Vec<&str> = defs
            .iter()
            .filter_map(|v| v.get("name").and_then(|n| n.as_str()))
            .collect();
        assert!(names.contains(&"velo_read_session"));
        assert!(names.contains(&"velo_ask_session"));
        assert!(names.contains(&"velo_spawn_session"));
        assert!(names.contains(&"velo_wait_invocations"));
    }
}
