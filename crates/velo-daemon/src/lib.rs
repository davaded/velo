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
    HandoffSessionRequest, LoopSessionRequest, SessionInfo, SessionInputRequest, SessionStatus,
    WsClientMessage, WsServerMessage, default_approval_mode,
};
use velo_worktree::{WorktreeManager, default_velo_home};

pub mod automations;
pub mod pr;
pub mod relay_bridge;
pub mod service;
pub mod voice;

pub struct DaemonInner {
    pub sessions: HashMap<Uuid, SessionInfo>,
    pub event_history: HashMap<Uuid, Vec<AgentEvent>>,
    pub handles: HashMap<Uuid, AgentHandle>,
    pub shells: HashMap<Uuid, InteractiveShellHandle>,
    pub pending_approvals: HashMap<String, oneshot::Sender<String>>,
    pub pending_questions: HashMap<String, oneshot::Sender<Vec<String>>>,
    pub automations: Vec<automations::AutomationRule>,
    pub repo_hooks: HashMap<String, String>,
}

#[derive(Clone)]
pub struct DaemonState {
    pub inner: Arc<RwLock<DaemonInner>>,
    pub event_tx: broadcast::Sender<AgentEvent>,
    pub worktree_mgr: WorktreeManager,
    pub state_file: PathBuf,
    pub events_dir: PathBuf,
    pub attachments_dir: PathBuf,
    pub automations_file: PathBuf,
    pub hooks_file: PathBuf,
    pub daemon_http_base: Option<String>,
}

impl DaemonState {
    pub async fn new() -> Result<Self> {
        let velo_home = default_velo_home();
        tokio::fs::create_dir_all(&velo_home).await?;
        let state_file = velo_home.join("sessions.json");
        let events_dir = velo_home.join("events");
        let attachments_dir = velo_home.join("attachments");
        let automations_file = velo_home.join("automations.json");
        let hooks_file = velo_home.join("repo_hooks.json");
        tokio::fs::create_dir_all(&events_dir).await?;
        tokio::fs::create_dir_all(&attachments_dir).await?;

        let mut sessions = HashMap::new();
        let mut event_history = HashMap::new();
        if tokio::fs::try_exists(&state_file).await.unwrap_or(false) {
            if let Ok(raw) = tokio::fs::read_to_string(&state_file).await {
                if let Ok(saved) = serde_json::from_str::<Vec<SessionInfo>>(&raw) {
                    for mut s in saved {
                        if matches!(
                            s.status,
                            SessionStatus::Starting
                                | SessionStatus::Running
                                | SessionStatus::WaitingForPermission
                        ) {
                            s.status = SessionStatus::Stopped;
                        }
                        let ev_path = events_dir.join(format!("{}.json", s.id));
                        if let Ok(ev_raw) = tokio::fs::read_to_string(&ev_path).await {
                            if let Ok(evs) = serde_json::from_str::<Vec<AgentEvent>>(&ev_raw) {
                                event_history.insert(s.id, evs);
                            }
                        }
                        sessions.insert(s.id, s);
                    }
                }
            }
        }

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

        let (event_tx, _) = broadcast::channel(2048);
        let state = Self {
            inner: Arc::new(RwLock::new(DaemonInner {
                sessions,
                event_history,
                handles: HashMap::new(),
                shells: HashMap::new(),
                pending_approvals: HashMap::new(),
                pending_questions: HashMap::new(),
                automations: automations_list,
                repo_hooks: repo_hooks_map,
            })),
            event_tx,
            worktree_mgr: WorktreeManager::default(),
            state_file,
            events_dir,
            attachments_dir,
            automations_file,
            hooks_file,
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
        let mut rx = self.event_tx.subscribe();
        let state = self.clone();

        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let session_id = event.session_id();
                let mut should_refresh_diff = false;
                let mut should_persist_events = false;
                let mut should_persist_sessions = false;

                {
                    let mut guard = state.inner.write().await;
                    if !matches!(
                        event,
                        AgentEvent::UserMessage { .. }
                            | AgentEvent::ProviderSessionBound { .. }
                            | AgentEvent::ThinkingChunk { .. }
                            | AgentEvent::MessageChunk { .. }
                            | AgentEvent::TerminalOutput { .. }
                            | AgentEvent::UsageUpdated { .. }
                    ) {
                        guard
                            .event_history
                            .entry(session_id)
                            .or_default()
                            .push(event.clone());
                        should_persist_events = true;
                    }

                    if let Some(session) = guard.sessions.get_mut(&session_id) {
                        session.updated_at = Utc::now();
                        match &event {
                            AgentEvent::StatusChanged { status, .. } => {
                                session.status = *status;
                                should_refresh_diff = true;
                                should_persist_sessions = true;
                            }
                            AgentEvent::ProviderSessionBound {
                                provider_session_id,
                                ..
                            } => {
                                session.provider_session_id = Some(provider_session_id.clone());
                                should_persist_sessions = true;
                            }
                            AgentEvent::UsageUpdated {
                                total_tokens,
                                cost_usd,
                                ..
                            } => {
                                if *total_tokens > 0 {
                                    session.tokens_used = *total_tokens;
                                }
                                if *cost_usd > 0.0 {
                                    session.cost_usd += *cost_usd;
                                }
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

                if should_persist_events {
                    let _ = state.persist_session_events(session_id).await;
                }
                if should_persist_sessions {
                    let _ = state.persist_sessions().await;
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
            let _ = tokio::fs::create_dir_all(&self.events_dir).await;
            let ev_path = self.events_dir.join(format!("{}.json", session_id));
            let json_str = serde_json::to_string_pretty(&list)?;
            tokio::fs::write(&ev_path, json_str).await?;
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
        let json_str = serde_json::to_string_pretty(&list)?;
        tokio::fs::write(&self.state_file, json_str).await?;
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
        let _ = self.event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: SessionStatus::WaitingForPermission,
            message: Some(format!("Waiting for approval: {}", tool_name)),
            timestamp: Utc::now(),
        });
        let _ = self.event_tx.send(AgentEvent::PermissionRequested {
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
        let _ = self.event_tx.send(AgentEvent::PermissionResolved {
            session_id,
            request_id: request_id.to_string(),
            decision: decision.to_string(),
            timestamp: Utc::now(),
        });
        let _ = self.event_tx.send(AgentEvent::StatusChanged {
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
        let _ = self.event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: SessionStatus::WaitingForPermission,
            message: Some("Waiting for user answer".to_string()),
            timestamp: Utc::now(),
        });
        let _ = self.event_tx.send(AgentEvent::UserQuestionRequested {
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
        let _ = self.event_tx.send(AgentEvent::UserQuestionAnswered {
            session_id,
            question_id: question_id.to_string(),
            answers: answers.clone(),
            timestamp: Utc::now(),
        });
        let _ = self.event_tx.send(AgentEvent::StatusChanged {
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

    pub async fn stop_session_by_id(&self, id: Uuid) {
        {
            let mut guard = self.inner.write().await;
            if let Some(mut handle) = guard.handles.remove(&id) {
                handle.stop();
            }
            if let Some(session) = guard.sessions.get_mut(&id) {
                session.status = SessionStatus::Stopped;
                session.updated_at = Utc::now();
            }
        }
        let _ = self.persist_sessions().await;
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

        let provision = self
            .worktree_mgr
            .provision_worktree(&repo_path, session_id, req.branch.as_deref())
            .await?;

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
            let _ = self.event_tx.send(AgentEvent::SetupHookOutput {
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
        let short_id = &session_id.to_string()[..8];
        let name = custom_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("{}-{}", provider, short_id));

        let diff_stats = WorktreeManager::compute_diff_stats(&worktree_path)
            .await
            .unwrap_or_default();

        let now = Utc::now();
        let mut session = SessionInfo {
            id: session_id,
            name,
            provider: provider.clone(),
            prompt: prompt.clone(),
            repo_root: repo_root.to_string_lossy().to_string(),
            worktree_path: worktree_path.to_string_lossy().to_string(),
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
            cost_usd: 0.0,
            approval_mode: approval_mode.clone(),
            preview_url: None,
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

        {
            let mut guard = self.inner.write().await;
            guard.sessions.insert(session_id, session.clone());
            if let Some(ref uev) = initial_user_ev {
                guard
                    .event_history
                    .entry(session_id)
                    .or_default()
                    .push(uev.clone());
            }
        }
        let _ = self.persist_session_events(session_id).await;
        if let Some(uev) = initial_user_ev {
            let _ = self.event_tx.send(uev);
        }

        // If the user created an empty worktree thread (e.g. via New Thread / Advanced Worktree)
        // without typing an initial prompt yet, prepare the isolated worktree in an idle state
        // without wasting tokens on a fake prompt.
        if prompt.trim().is_empty() && images.is_empty() && !use_pty {
            session.status = SessionStatus::Completed;
            {
                let mut guard = self.inner.write().await;
                if let Some(s) = guard.sessions.get_mut(&session_id) {
                    s.status = SessionStatus::Completed;
                }
            }
            self.persist_sessions().await?;
            return Ok(session);
        }

        let handle = AgentSpawner::spawn_agent_turn_configured(
            session_id,
            provider,
            prompt,
            worktree_path,
            use_pty,
            model,
            effort,
            None,
            images,
            approval_mode,
            self.daemon_http_base.clone(),
            self.event_tx.clone(),
        )
        .await?;

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
        .route("/api/open-editor", post(open_editor_handler))
        .route("/api/worktrees/prune", post(prune_worktrees_handler))
        .route("/api/attachments", post(upload_attachment_handler))
        .route("/api/attachments/{file}", get(get_attachment_handler))
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

static AGY_MODELS_CACHE: std::sync::OnceLock<tokio::sync::RwLock<Option<Vec<(String, String)>>>> =
    std::sync::OnceLock::new();
static AGY_MODELS_FETCHING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

static CURSOR_MODELS_CACHE: std::sync::OnceLock<
    tokio::sync::RwLock<Option<Vec<(String, String)>>>,
> = std::sync::OnceLock::new();
static CURSOR_MODELS_FETCHING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn parse_cursor_models_stdout(raw: &str) -> Vec<(String, String)> {
    let mut parsed = Vec::new();
    for line in raw.lines() {
        let clean = line.trim().trim_start_matches('-').trim_start_matches('*').trim();
        if clean.is_empty()
            || clean.starts_with("Available")
            || clean.starts_with("Loading")
            || clean.starts_with("Error:")
            || clean.starts_with("Tip:")
        {
            continue;
        }
        // Cursor `--list-models` formats lines like `gpt-5 - GPT-5` or `claude-sonnet-4-6 (default)` or bare `composer`
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
        let display = match label_opt {
            Some(lbl) if !lbl.starts_with('(') => format!("Cursor · {}", lbl),
            _ => format!("Cursor · {}", slug_raw),
        };
        parsed.push((format!("cursor:{}", slug_raw), display));
    }
    parsed
}

fn parse_agy_models_stdout(raw: &str) -> Vec<(String, String)> {
    let mut parsed = Vec::new();
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
        let label = parts
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(slug);
        parsed.push((slug.to_string(), label.to_string()));
    }
    parsed
}

async fn list_runtimes_handler() -> impl IntoResponse {
    let runtimes = velo_agent::detect_local_runtimes().await;
    Json(json!({ "runtimes": runtimes }))
}

async fn list_models_handler() -> impl IntoResponse {
    Json(build_models_catalog_json().await)
}

pub(crate) async fn build_models_catalog_json() -> Value {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/daiyudai".to_string());
    let home_path = PathBuf::from(&home);
    let mut models: Vec<Value> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 1. Discover Anthropic / Claude Code models from local ~/.claude.json & Claude Desktop config
    let mut push_claude = |id: &str, label: &str, short_label: &str, desc: &str, is_default: bool| {
        if seen_ids.insert(id.to_string()) {
            models.push(json!({
                "id": id,
                "label": label,
                "shortLabel": short_label,
                "family": "Anthropic",
                "agentKind": "claude",
                "runtimeId": "claude",
                "desc": desc,
                "isDefault": is_default,
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

    let mut codex_entries: Vec<(String, String, String, bool)> = Vec::new();
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
                        let is_def = slug == default_codex_model;
                        codex_entries.push((
                            slug.to_string(),
                            display.to_string(),
                            desc.to_string(),
                            is_def,
                        ));
                    }
                }
            }
        }
    }

    // Sort so default_codex_model (e.g. gpt-6.1-sol) is first among Codex models
    codex_entries.sort_by(|a, b| b.3.cmp(&a.3));

    for (slug, display, desc, is_def) in codex_entries {
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

    let agy_entries: Vec<(String, String)> = cached_agy.unwrap_or_else(|| {
        vec![
            (
                "gemini-4-carbon-high".to_string(),
                "Gemini 4 Carbon (High)".to_string(),
            ),
            (
                "gemini-4-carbon-medium".to_string(),
                "Gemini 4 Carbon (Medium)".to_string(),
            ),
            (
                "gemini-4-argon-high".to_string(),
                "Gemini 4 Argon (High)".to_string(),
            ),
            (
                "gemini-3.8-flash-high".to_string(),
                "Gemini 3.8 Flash (High)".to_string(),
            ),
            (
                "gpt-oss-120b-medium".to_string(),
                "GPT-OSS 120B (Medium)".to_string(),
            ),
        ]
    });

    for (idx, (slug, display)) in agy_entries.into_iter().enumerate() {
        if seen_ids.insert(slug.clone()) {
            let short_lbl = display
                .replace(" (Medium)", "")
                .replace(" (High)", " High")
                .replace(" (Low)", " Low");
            models.push(json!({
                "id": slug,
                "label": display,
                "shortLabel": short_lbl,
                "family": "Google Antigravity",
                "agentKind": "agy",
                "runtimeId": "agy",
                "installed": agy_installed,
                "desc": if agy_installed {
                    "Installed · Google Antigravity CLI (`agy --output-format stream-json`)"
                } else {
                    "Install via `curl -fsSL https://antigravity.google/cli/install.sh | bash`"
                },
                "isDefault": idx == 0,
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

    let mut cursor_entries: Vec<(String, String, String, String, bool)> = vec![(
        "cursor:auto".to_string(),
        "Cursor Auto".to_string(),
        "Cursor Auto".to_string(),
        if cursor_installed {
            "Installed · Cursor Agent CLI auto-router (`cursor-agent -p --output-format stream-json`)"
                .to_string()
        } else {
            "Install Cursor CLI (`cursor-agent`)"
                .to_string()
        },
        true,
    )];

    if let Some(dynamic_list) = cached_cursor {
        for (id, display) in dynamic_list {
            let short = display.replace("Cursor · ", "Cursor ");
            cursor_entries.push((
                id,
                display,
                short,
                "Cursor Agent CLI model (`--list-models`)".to_string(),
                false,
            ));
        }
    } else {
        for (id, label, short_lbl, desc) in [
            (
                "cursor:composer",
                "Cursor Composer",
                "Cursor Composer",
                "Cursor native multi-file fast coding model (`--model composer`)",
            ),
            (
                "cursor:claude-sonnet-4-6",
                "Cursor · Claude Sonnet 4.6",
                "Cursor Sonnet 4.6",
                "Claude Sonnet 4.6 routed via Cursor Agent CLI",
            ),
            (
                "cursor:claude-opus-4-8",
                "Cursor · Claude Opus 4.8",
                "Cursor Opus 4.8",
                "Claude Opus 4.8 routed via Cursor Agent CLI",
            ),
            (
                "cursor:gpt-5",
                "Cursor · GPT-5",
                "Cursor GPT-5",
                "OpenAI GPT-5 routed via Cursor Agent CLI",
            ),
        ] {
            cursor_entries.push((
                id.to_string(),
                label.to_string(),
                short_lbl.to_string(),
                desc.to_string(),
                false,
            ));
        }
    }

    for (id, label, short_lbl, desc, is_def) in cursor_entries {
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

async fn pick_folder_handler() -> impl IntoResponse {
    let out = Command::new("osascript")
        .args([
            "-e",
            "POSIX path of (choose folder with prompt \"Select Git Repository for Velo:\")",
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

async fn delete_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<DeleteSessionQuery>,
) -> impl IntoResponse {
    let cleanup_wt = query.cleanup_worktree.unwrap_or(true);
    let (removed_session, wt_still_in_use) = {
        let mut guard = state.inner.write().await;
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

    let ev_file = state.events_dir.join(format!("{}.json", id));
    let _ = tokio::fs::remove_file(&ev_file).await;

    let mut worktree_removed = false;
    if let Some(ref s) = removed_session {
        if cleanup_wt && !wt_still_in_use && s.worktree_path != s.repo_root {
            let repo_root = PathBuf::from(&s.repo_root);
            let wt_path = PathBuf::from(&s.worktree_path);
            if state
                .worktree_mgr
                .remove_worktree(&repo_root, &wt_path)
                .await
                .is_ok()
            {
                worktree_removed = true;
            }
            if wt_path.starts_with(state.worktree_mgr.base_dir()) {
                let _ = tokio::fs::remove_dir_all(&wt_path).await;
            }
        }
    }

    let _ = state.persist_sessions().await;
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
}

async fn update_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<UpdateSessionRequest>,
) -> impl IntoResponse {
    let updated = {
        let mut guard = state.inner.write().await;
        if let Some(s) = guard.sessions.get_mut(&id) {
            if let Some(name) = req.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
                s.name = name;
            }
            if let Some(new_prov) = req.provider {
                if s.provider != new_prov {
                    s.provider = new_prov;
                    s.provider_session_id = None;
                }
            }
            if let Some(model) = req.model {
                s.model = if model.trim().is_empty() {
                    None
                } else {
                    Some(model)
                };
            }
            if let Some(effort) = req.effort {
                s.effort = if effort.trim().is_empty() {
                    None
                } else {
                    Some(effort)
                };
            }
            if let Some(mode) = req.approval_mode.filter(|m| !m.trim().is_empty()) {
                s.approval_mode = mode;
            }
            if let Some(purl) = req.preview_url {
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

    match updated {
        Some(s) => {
            let _ = state.persist_sessions().await;
            (StatusCode::OK, Json(json!(s))).into_response()
        }
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

fn decode_base64_payload(input: &str) -> Result<Vec<u8>> {
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

    let ext = req
        .filename
        .as_deref()
        .and_then(|f| Path::new(f).extension().and_then(|e| e.to_str()))
        .or_else(|| match req.mime_type.as_deref() {
            Some("image/jpeg") | Some("image/jpg") => Some("jpg"),
            Some("image/webp") => Some("webp"),
            Some("image/gif") => Some("gif"),
            Some("image/svg+xml") => Some("svg"),
            _ => Some("png"),
        })
        .unwrap_or("png")
        .to_ascii_lowercase();

    let clean_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let final_ext = if clean_ext.is_empty() { "png" } else { &clean_ext };
    let saved_name = format!("{}.{}", Uuid::new_v4(), final_ext);
    let _ = tokio::fs::create_dir_all(&state.attachments_dir).await;
    let dest_path = state.attachments_dir.join(&saved_name);

    match tokio::fs::write(&dest_path, &bytes).await {
        Ok(()) => (
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
            Json(json!({ "error": format!("Failed to write attachment: {}", err) })),
        )
            .into_response(),
    }
}

async fn get_attachment_handler(
    State(state): State<DaemonState>,
    AxumPath(file): AxumPath<String>,
) -> impl IntoResponse {
    let clean_name = Path::new(&file)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if clean_name.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let full_path = state.attachments_dir.join(clean_name);
    let content_type = if clean_name.ends_with(".jpg") || clean_name.ends_with(".jpeg") {
        "image/jpeg"
    } else if clean_name.ends_with(".webp") {
        "image/webp"
    } else if clean_name.ends_with(".gif") {
        "image/gif"
    } else if clean_name.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "image/png"
    };

    match tokio::fs::read(&full_path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "public, max-age=86400"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
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
        .unwrap_or_else(|| PathBuf::from("/Users/daiyudai/code/velo"));

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
            .unwrap_or_else(|| PathBuf::from("/Users/daiyudai/code/velo"));
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
        .unwrap_or_else(|| PathBuf::from("/Users/daiyudai/code/velo"));

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

async fn get_session_events_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let guard = state.inner.read().await;
    let events = guard.event_history.get(&id).cloned().unwrap_or_default();
    Json(events)
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
            None => PathBuf::from("/Users/daiyudai/code/velo"),
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
            None => PathBuf::from("/Users/daiyudai/code/velo"),
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

impl DaemonState {
    pub async fn dispatch_session_input(
        &self,
        id: Uuid,
        req: SessionInputRequest,
    ) -> Result<Value> {
        let (existing_session, prior_transcript) = {
            let mut guard = self.inner.write().await;
            if let Some(mut old_handle) = guard.handles.remove(&id) {
                old_handle.stop();
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
            (sess, transcript)
        };

        let Some(session) = existing_session else {
            anyhow::bail!("Session not found");
        };

        let target_provider = req.provider.clone().unwrap_or_else(|| {
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
            }
            session.provider.clone()
        });
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
            guard
                .event_history
                .entry(id)
                .or_default()
                .push(user_ev.clone());
        }
        let _ = self.persist_session_events(id).await;
        let _ = self.event_tx.send(user_ev);

        let effective_prompt = if resume_session_id.is_some() {
            req.input.clone()
        } else if let Some(history) = prior_transcript {
            format!(
                "<conversation_history>\n{}\n</conversation_history>\n\nUser: {}",
                history, req.input
            )
        } else {
            req.input.clone()
        };

        let effective_approval = req
            .approval_mode
            .clone()
            .unwrap_or_else(|| session.approval_mode.clone());
        let wt_path = PathBuf::from(&session.worktree_path);

        let new_handle = AgentSpawner::spawn_agent_turn_configured(
            id,
            target_provider.clone(),
            effective_prompt,
            wt_path,
            false,
            req.model.clone().or_else(|| session.model.clone()),
            req.effort.clone().or_else(|| session.effort.clone()),
            resume_session_id.clone(),
            req.images.clone(),
            effective_approval.clone(),
            self.daemon_http_base.clone(),
            self.event_tx.clone(),
        )
        .await?;

        let pid = new_handle.pid;
        {
            let mut guard = self.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&id) {
                if s.provider != target_provider {
                    s.provider_session_id = None;
                }
                s.provider = target_provider;
                if req.model.is_some() {
                    s.model = req.model.clone();
                }
                if req.effort.is_some() {
                    s.effort = req.effort.clone();
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

#[derive(serde::Deserialize)]
struct RewindSessionRequest {
    truncate_to_user_turn: usize,
}

async fn rewind_session_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<RewindSessionRequest>,
) -> impl IntoResponse {
    {
        let mut guard = state.inner.write().await;
        if let Some(mut handle) = guard.handles.remove(&id) {
            handle.stop();
        }
        if let Some(ev_list) = guard.event_history.get_mut(&id) {
            truncate_events_at_user_turn(ev_list, req.truncate_to_user_turn);
        }
        if let Some(session) = guard.sessions.get_mut(&id) {
            session.status = SessionStatus::Stopped;
            session.provider_session_id = None;
            session.updated_at = Utc::now();
        }
    }
    let _ = state.persist_session_events(id).await;
    let _ = state.persist_sessions().await;
    Json(json!({ "ok": true, "session_id": id, "truncated_to": req.truncate_to_user_turn }))
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
    let wt_path = {
        let guard = state.inner.read().await;
        match guard.sessions.get(&id) {
            Some(s) => PathBuf::from(&s.worktree_path),
            None => PathBuf::from("/Users/daiyudai/code/velo"),
        }
    };
    let msg = if req.message.trim().is_empty() {
        "chore: commit worktree changes via Velo".to_string()
    } else {
        req.message.trim().to_string()
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
            if ok && req.push {
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
                let mut guard = state.inner.write().await;
                if let Some(s) = guard.sessions.get_mut(&id) {
                    s.diff_stats = stats.clone();
                    s.updated_at = Utc::now();
                }
            }
            let _ = state.event_tx.send(AgentEvent::DiffUpdated {
                session_id: id,
                stats: stats.clone(),
                timestamp: Utc::now(),
            });
            let _ = state.persist_sessions().await;

            (
                if ok { StatusCode::OK } else { StatusCode::BAD_REQUEST },
                Json(json!({
                    "ok": ok,
                    "stdout": stdout,
                    "stderr": stderr,
                    "push_output": push_out_str,
                    "stats": stats,
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
    let wt_path = {
        let guard = state.inner.read().await;
        match guard.sessions.get(&id) {
            Some(s) => PathBuf::from(&s.worktree_path),
            None => PathBuf::from("/Users/daiyudai/code/velo"),
        }
    };

    if req.all {
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
    } else if let Some(fp) = req.file_path.as_deref().filter(|s| !s.trim().is_empty()) {
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
        let mut guard = state.inner.write().await;
        if let Some(s) = guard.sessions.get_mut(&id) {
            s.diff_stats = stats.clone();
            s.updated_at = Utc::now();
        }
    }
    let _ = state.event_tx.send(AgentEvent::DiffUpdated {
        session_id: id,
        stats: stats.clone(),
        timestamp: Utc::now(),
    });
    let _ = state.persist_sessions().await;

    Json(json!({ "ok": true, "stats": stats }))
}

async fn git_merge_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
) -> impl IntoResponse {
    let session = {
        let guard = state.inner.read().await;
        guard.sessions.get(&id).cloned()
    };
    let Some(s) = session else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "Session not found" })),
        )
            .into_response();
    };

    let wt_path = PathBuf::from(&s.worktree_path);
    let repo_root = PathBuf::from(&s.repo_root);

    // Auto-commit any uncommitted work in the worktree before merging if needed
    let status_out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&wt_path)
        .output()
        .await;
    if let Ok(st) = status_out {
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

    let merge_out = Command::new("git")
        .args(["merge", "--no-edit", &s.branch])
        .current_dir(&repo_root)
        .output()
        .await;

    match merge_out {
        Ok(out) => {
            let ok = out.status.success();
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            (
                if ok { StatusCode::OK } else { StatusCode::BAD_REQUEST },
                Json(json!({
                    "ok": ok,
                    "branch": s.branch,
                    "stdout": stdout,
                    "stderr": stderr,
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
    let source_session = {
        let guard = state.inner.read().await;
        match guard.sessions.get(&id).cloned() {
            Some(s) => s,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Source session not found" })),
                )
                    .into_response();
            }
        }
    };

    let wt_path = Path::new(&source_session.worktree_path);
    let diff_stats = WorktreeManager::compute_diff_stats(wt_path)
        .await
        .unwrap_or_default();

    let extra = req
        .additional_instructions
        .unwrap_or_else(|| "Continue implementation and verify all changes.".to_string());

    let handoff_prompt = format!(
        "[VELO HANDOFF from session {} ({}) on branch `{}`]\n\
         Original Task: {}\n\
         Modified Files So Far ({}): {}\n\
         Handoff Instructions: {}",
        &source_session.id.to_string()[..8],
        source_session.provider,
        source_session.branch,
        source_session.prompt,
        diff_stats.files_changed,
        diff_stats.modified_files.join(", "),
        extra
    );

    let new_session_id = Uuid::new_v4();
    let short_id = &new_session_id.to_string()[..8];
    match state
        .spawn_in_existing_worktree(
            new_session_id,
            Some(format!("handoff-{}-{}", req.target_provider, short_id)),
            req.target_provider,
            handoff_prompt,
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
            let _ = loop_state.event_tx.send(AgentEvent::ToolCallRequested {
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
                    let _ = loop_state.event_tx.send(AgentEvent::ToolCallCompleted {
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
                    let _ = loop_state.event_tx.send(AgentEvent::ToolCallCompleted {
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
            .unwrap_or_else(|| PathBuf::from("/Users/daiyudai/code/velo"))
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
            .unwrap_or_else(|| PathBuf::from("/Users/daiyudai/code/velo"))
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
            .unwrap_or_else(|| PathBuf::from("/Users/daiyudai/code/velo"))
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
            .unwrap_or_else(|| PathBuf::from("/Users/daiyudai/code/velo"))
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

        let (event_tx, _) = broadcast::channel(256);
        let state = DaemonState {
            inner: Arc::new(RwLock::new(DaemonInner {
                sessions: HashMap::new(),
                event_history: HashMap::new(),
                handles: HashMap::new(),
                shells: HashMap::new(),
                pending_approvals: HashMap::new(),
                pending_questions: HashMap::new(),
                automations: Vec::new(),
                repo_hooks: HashMap::new(),
            })),
            event_tx,
            worktree_mgr: WorktreeManager::new(wt_dir),
            state_file: temp_base.join("sessions.json"),
            events_dir: temp_base.join("events"),
            attachments_dir: temp_base.join("attachments"),
            automations_file: temp_base.join("automations.json"),
            hooks_file: temp_base.join("repo_hooks.json"),
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

        let _ = tokio::fs::remove_dir_all(&temp_base).await;
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

    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/Users/daiyudai"));
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
