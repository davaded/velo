use anyhow::Result;
use axum::{
    Json, Router,
    extract::{
        Path as AxumPath, Request, State,
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
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    process::Command,
    sync::{RwLock, broadcast},
};
use tracing::{error, info, warn};
use uuid::Uuid;
use velo_agent::{AgentHandle, AgentSpawner};
use velo_protocol::{
    AdvisorSessionRequest, AgentEvent, AgentProvider, CommitteeRequest, CreateSessionRequest,
    HandoffSessionRequest, LoopSessionRequest, SessionInfo, SessionInputRequest, SessionStatus,
    WsClientMessage, WsServerMessage,
};
use velo_worktree::{WorktreeManager, default_velo_home};

pub struct DaemonInner {
    pub sessions: HashMap<Uuid, SessionInfo>,
    pub event_history: HashMap<Uuid, Vec<AgentEvent>>,
    pub handles: HashMap<Uuid, AgentHandle>,
}

#[derive(Clone)]
pub struct DaemonState {
    pub inner: Arc<RwLock<DaemonInner>>,
    pub event_tx: broadcast::Sender<AgentEvent>,
    pub worktree_mgr: WorktreeManager,
    pub state_file: PathBuf,
    pub events_dir: PathBuf,
}

impl DaemonState {
    pub async fn new() -> Result<Self> {
        let velo_home = default_velo_home();
        tokio::fs::create_dir_all(&velo_home).await?;
        let state_file = velo_home.join("sessions.json");
        let events_dir = velo_home.join("events");
        tokio::fs::create_dir_all(&events_dir).await?;

        let mut sessions = HashMap::new();
        let mut event_history = HashMap::new();
        if tokio::fs::try_exists(&state_file).await.unwrap_or(false) {
            if let Ok(raw) = tokio::fs::read_to_string(&state_file).await {
                if let Ok(saved) = serde_json::from_str::<Vec<SessionInfo>>(&raw) {
                    for mut s in saved {
                        if matches!(s.status, SessionStatus::Starting | SessionStatus::Running) {
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

        let (event_tx, _) = broadcast::channel(2048);
        let state = Self {
            inner: Arc::new(RwLock::new(DaemonInner {
                sessions,
                event_history,
                handles: HashMap::new(),
            })),
            event_tx,
            worktree_mgr: WorktreeManager::default(),
            state_file,
            events_dir,
        };

        state.spawn_event_supervisor();
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
                    if !matches!(event, AgentEvent::ProviderSessionBound { .. }) {
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

    pub async fn create_session(&self, req: CreateSessionRequest) -> Result<SessionInfo> {
        let session_id = Uuid::new_v4();
        let repo_path = PathBuf::from(&req.repo_path);

        let provision = self
            .worktree_mgr
            .provision_worktree(&repo_path, session_id, req.branch.as_deref())
            .await?;

        self.spawn_in_existing_worktree(
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
        )
        .await
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
        };

        {
            let mut guard = self.inner.write().await;
            guard.sessions.insert(session_id, session.clone());
            if !prompt.trim().is_empty() {
                guard
                    .event_history
                    .entry(session_id)
                    .or_default()
                    .push(AgentEvent::UserMessage {
                        session_id,
                        text: prompt.clone(),
                        timestamp: now,
                    });
            }
        }
        let _ = self.persist_session_events(session_id).await;

        let handle = AgentSpawner::spawn_agent_turn(
            session_id,
            provider,
            prompt,
            worktree_path,
            use_pty,
            model,
            effort,
            None,
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
        HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"),
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
        .route("/api/pick-folder", post(pick_folder_handler))
        .route("/api/open-editor", post(open_editor_handler))
        .route(
            "/api/sessions",
            get(list_sessions_handler).post(create_session_handler),
        )
        .route("/api/sessions/{id}", get(get_session_handler))
        .route("/api/sessions/{id}/events", get(get_session_events_handler))
        .route("/api/sessions/{id}/diff", get(get_session_diff_handler))
        .route("/api/sessions/{id}/files", get(list_worktree_files_handler))
        .route("/api/sessions/{id}/exec", post(exec_in_worktree_handler))
        .route("/api/sessions/{id}/input", post(send_input_handler))
        .route("/api/sessions/{id}/rewind", post(rewind_session_handler))
        .route("/api/sessions/{id}/stop", post(stop_session_handler))
        .route("/api/sessions/{id}/git/commit", post(git_commit_handler))
        .route("/api/sessions/{id}/git/discard", post(git_discard_handler))
        .route("/api/sessions/{id}/git/merge", post(git_merge_handler))
        .route("/api/sessions/{id}/handoff", post(handoff_session_handler))
        .route("/api/sessions/{id}/advisor", post(advisor_session_handler))
        .route("/api/committee", post(committee_handler))
        .route("/api/loop", post(loop_handler))
        .route("/mcp", post(mcp_jsonrpc_handler))
        .route("/ws", get(ws_handler))
        .layer(middleware::from_fn(cors_middleware))
        .with_state(state)
}

pub async fn run_daemon_server(addr: SocketAddr) -> Result<()> {
    let state = DaemonState::new().await?;
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

async fn list_runtimes_handler() -> impl IntoResponse {
    let runtimes = velo_agent::detect_local_runtimes().await;
    Json(json!({ "runtimes": runtimes }))
}

async fn list_models_handler() -> impl IntoResponse {
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
                        if slug.is_empty() || vis != "list" || slug == "codex-auto-review" || slug == "gpt-reserve" {
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

    Json(json!({
        "models": models,
        "defaultCodexModel": default_codex_model,
        "defaultCodexEffort": default_codex_effort,
        "defaultClaudeModel": "claude-fable-5-2",
    }))
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

async fn send_input_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<SessionInputRequest>,
) -> impl IntoResponse {
    // 1. Stop any previous running process handle for this session before spawning the new turn
    let (existing_session, prior_transcript) = {
        let mut guard = state.inner.write().await;
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

    // 2. Spawn a new real CLI turn (claude / codex) in the session's isolated worktree
    let Some(session) = existing_session else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Session not found" })),
        )
            .into_response();
    };

    let target_provider = req.provider.clone().unwrap_or_else(|| session.provider.clone());
    let can_resume_native = req.truncate_to_user_turn.is_none()
        && !req.reset_thread
        && target_provider == session.provider;
    let resume_session_id = if can_resume_native {
        session.provider_session_id.clone()
    } else {
        None
    };

    // Record the user message into event_history and persist
    {
        let mut guard = state.inner.write().await;
        guard
            .event_history
            .entry(id)
            .or_default()
            .push(AgentEvent::UserMessage {
                session_id: id,
                text: req.input.clone(),
                timestamp: Utc::now(),
            });
    }
    let _ = state.persist_session_events(id).await;

    // If native thread resume is unavailable (e.g. after Rewind/Edit or provider switch) and prior turns exist,
    // prepend the surviving conversation history so multi-turn memory is still preserved.
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

    let wt_path = PathBuf::from(&session.worktree_path);
    match AgentSpawner::spawn_agent_turn(
        id,
        target_provider.clone(),
        effective_prompt,
        wt_path,
        false,
        req.model.clone().or_else(|| session.model.clone()),
        req.effort.clone().or_else(|| session.effort.clone()),
        resume_session_id.clone(),
        state.event_tx.clone(),
    )
    .await
    {
        Ok(new_handle) => {
            let pid = new_handle.pid;
            {
                let mut guard = state.inner.write().await;
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
                    s.status = SessionStatus::Running;
                    s.pid = pid;
                    s.updated_at = Utc::now();
                }
                guard.handles.insert(id, new_handle);
            }
            let _ = state.persist_sessions().await;
            (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "mode": if resume_session_id.is_some() { "resumed_turn" } else { "spawned_turn" },
                    "pid": pid,
                    "resumed_thread_id": resume_session_id,
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

/// Phase 3 Built-in MCP Server JSON-RPC 2.0 endpoint (`POST /mcp`).
/// Allows any MCP-capable coding agent to list sessions, inspect diffs, or spawn/handoff peer agents.
pub async fn handle_mcp_request(state: &DaemonState, payload: Value) -> Value {
    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    let method = payload.get("method").and_then(|v| v.as_str()).unwrap_or("");

    match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {
                    "name": "velo-mcp-server",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "tools": {}
                }
            }
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
                        "description": "Spawn a new coding agent (claude, codex, opencode) inside an isolated Git worktree",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "provider": { "type": "string", "description": "claude, codex, or opencode" },
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
                                "session_id": { "type": "string", "description": "Session UUID" }
                            },
                            "required": ["session_id"]
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
                        parent_session_id: None,
                        model: None,
                        effort: None,
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
                    let sid_str = args
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if let Ok(sid) = Uuid::parse_str(sid_str) {
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

async fn mcp_jsonrpc_handler(
    State(state): State<DaemonState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let resp = handle_mcp_request(&state, payload).await;
    Json(resp)
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

async fn ui_index_handler() -> impl IntoResponse {
    let dist_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/velo-desktop/dist");
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
            "Velo Daemon is running. Build UI with `pnpm --dir apps/velo-desktop build`."
                .to_string(),
        )
            .into_response(),
    }
}

async fn ui_asset_handler(AxumPath(file): AxumPath<String>) -> impl IntoResponse {
    let dist_assets = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/velo-desktop/dist/assets");
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
            })),
            event_tx,
            worktree_mgr: WorktreeManager::new(wt_dir),
            state_file: temp_base.join("sessions.json"),
            events_dir: temp_base.join("events"),
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

async fn pair_ticket_handler() -> impl IntoResponse {
    let lan_ip = Command::new("ipconfig")
        .args(["getifaddr", "en0"])
        .output()
        .await
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(s) }
        })
        .unwrap_or_else(|| velo_protocol::DEFAULT_DAEMON_HOST.to_string());

    let relay_url = format!("ws://{}:{}", lan_ip, velo_relay::DEFAULT_RELAY_PORT);
    let daemon_addr = format!("{}:{}", lan_ip, velo_protocol::DEFAULT_DAEMON_PORT);
    let ticket = velo_relay::PairingTicket::generate(&relay_url, &daemon_addr);
    let mobile_url = format!(
        "http://{}/?mobile=1&room={}&key={}",
        daemon_addr,
        &ticket.room_id[..8],
        &ticket.shared_key_hex[..16]
    );

    // Render crisp SVG matrix for the QR modal
    let bytes = mobile_url.as_bytes();
    let size = 21usize;
    let mut rects = String::new();
    for r in 0..size {
        for c in 0..size {
            let in_tl = r < 7 && c < 7;
            let in_tr = r < 7 && c >= size - 7;
            let in_bl = r >= size - 7 && c < 7;
            let is_finder = if in_tl || in_tr || in_bl {
                let lr = if r >= size - 7 { r - (size - 7) } else { r };
                let lc = if c >= size - 7 { c - (size - 7) } else { c };
                lr == 0 || lr == 6 || lc == 0 || lc == 6 || (lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4)
            } else {
                let idx = (r * size + c) % bytes.len();
                ((bytes[idx] as usize) ^ (r * 11 + c * 17)) & 1 == 1
            };
            if is_finder {
                rects.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"1\" height=\"1\" fill=\"#09090b\"/>",
                    c + 2,
                    r + 2
                ));
            }
        }
    }
    let qr_svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 25 25\" width=\"160\" height=\"160\" shape-rendering=\"crispEdges\"><rect width=\"25\" height=\"25\" fill=\"#ffffff\"/>{}</svg>",
        rects
    );

    Json(json!({
        "room_id": ticket.room_id,
        "shared_key_hex": ticket.shared_key_hex,
        "relay_url": ticket.relay_url,
        "daemon_addr": ticket.daemon_addr,
        "pairing_uri": ticket.pairing_uri,
        "uri": mobile_url,
        "qr_svg": qr_svg,
    }))
}
