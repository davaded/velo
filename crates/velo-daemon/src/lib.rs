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
use serde_json::json;
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{RwLock, broadcast};
use tracing::{error, info, warn};
use uuid::Uuid;
use velo_agent::{AgentHandle, AgentSpawner};
use velo_protocol::{
    AgentEvent, CreateSessionRequest, HandoffSessionRequest, SessionInfo, SessionInputRequest,
    SessionStatus, WsClientMessage, WsServerMessage,
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
}

impl DaemonState {
    pub async fn new() -> Result<Self> {
        let velo_home = default_velo_home();
        tokio::fs::create_dir_all(&velo_home).await?;
        let state_file = velo_home.join("sessions.json");

        let mut sessions = HashMap::new();
        if tokio::fs::try_exists(&state_file).await.unwrap_or(false) {
            if let Ok(raw) = tokio::fs::read_to_string(&state_file).await {
                if let Ok(saved) = serde_json::from_str::<Vec<SessionInfo>>(&raw) {
                    for mut s in saved {
                        if matches!(s.status, SessionStatus::Starting | SessionStatus::Running) {
                            s.status = SessionStatus::Stopped;
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
                event_history: HashMap::new(),
                handles: HashMap::new(),
            })),
            event_tx,
            worktree_mgr: WorktreeManager::default(),
            state_file,
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

                {
                    let mut guard = state.inner.write().await;
                    guard
                        .event_history
                        .entry(session_id)
                        .or_default()
                        .push(event.clone());

                    if let Some(session) = guard.sessions.get_mut(&session_id) {
                        session.updated_at = Utc::now();
                        match &event {
                            AgentEvent::StatusChanged { status, .. } => {
                                session.status = *status;
                                should_refresh_diff = true;
                            }
                            AgentEvent::ToolCallCompleted { .. } => {
                                should_refresh_diff = true;
                            }
                            AgentEvent::DiffUpdated { stats, .. } => {
                                session.diff_stats = stats.clone();
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
                    let _ = state.persist_sessions().await;
                }
            }
        });
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

        let short_id = &session_id.to_string()[..8];
        let name = req
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("{}-{}", req.provider, short_id));

        let now = Utc::now();
        let mut session = SessionInfo {
            id: session_id,
            name,
            provider: req.provider.clone(),
            prompt: req.prompt.clone(),
            repo_root: provision.repo_root.to_string_lossy().to_string(),
            worktree_path: provision.worktree_path.to_string_lossy().to_string(),
            branch: provision.branch,
            status: SessionStatus::Starting,
            pid: None,
            diff_stats: Default::default(),
            created_at: now,
            updated_at: now,
            parent_session_id: req.parent_session_id,
        };

        {
            let mut guard = self.inner.write().await;
            guard.sessions.insert(session_id, session.clone());
        }

        let handle = AgentSpawner::spawn_agent(
            session_id,
            req.provider,
            req.prompt,
            provision.worktree_path,
            req.use_pty,
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
        .route("/", get(ui_index_handler)).route("/assets/{file}", get(ui_asset_handler)).route("/api/health", get(health_handler))
        .route("/api/sessions", get(list_sessions_handler).post(create_session_handler))
        .route("/api/sessions/{id}", get(get_session_handler))
        .route("/api/sessions/{id}/events", get(get_session_events_handler))
        .route("/api/sessions/{id}/diff", get(get_session_diff_handler))
        .route("/api/sessions/{id}/input", post(send_input_handler))
        .route("/api/sessions/{id}/stop", post(stop_session_handler))
        .route("/api/sessions/{id}/handoff", post(handoff_session_handler))
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

async fn send_input_handler(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<SessionInputRequest>,
) -> impl IntoResponse {
    let guard = state.inner.read().await;
    match guard.handles.get(&id) {
        Some(handle) => match handle.send_input(req.input) {
            Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
            Err(err) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response(),
        },
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Active session handle not found" })),
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
        if let Some(handle) = guard.handles.get_mut(&id) {
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
    let now = Utc::now();
    let mut new_session = SessionInfo {
        id: new_session_id,
        name: format!("handoff-{}-{}", req.target_provider, short_id),
        provider: req.target_provider.clone(),
        prompt: handoff_prompt.clone(),
        repo_root: source_session.repo_root.clone(),
        worktree_path: source_session.worktree_path.clone(),
        branch: source_session.branch.clone(),
        status: SessionStatus::Starting,
        pid: None,
        diff_stats,
        created_at: now,
        updated_at: now,
        parent_session_id: Some(source_session.id),
    };

    {
        let mut guard = state.inner.write().await;
        guard.sessions.insert(new_session_id, new_session.clone());
    }

    match AgentSpawner::spawn_agent(
        new_session_id,
        req.target_provider,
        handoff_prompt,
        PathBuf::from(&source_session.worktree_path),
        false,
        state.event_tx.clone(),
    )
    .await
    {
        Ok(handle) => {
            new_session.pid = handle.pid;
            new_session.status = SessionStatus::Running;
            let mut guard = state.inner.write().await;
            if let Some(s) = guard.sessions.get_mut(&new_session_id) {
                s.pid = handle.pid;
                s.status = SessionStatus::Running;
            }
            guard.handles.insert(new_session_id, handle);
            drop(guard);
            let _ = state.persist_sessions().await;
            (StatusCode::CREATED, Json(json!(new_session))).into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
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
        let _ = tokio::fs::remove_dir_all(&temp_base).await;
        Ok(())
    }
}

async fn ui_index_handler() -> impl IntoResponse {
    let dist_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/velo-desktop/dist");
    let index_path = dist_dir.join("index.html");
    match tokio::fs::read_to_string(&index_path).await {
        Ok(html) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
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
    // Prevent path traversal
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
        Ok(bytes) => (StatusCode::OK, [(header::CONTENT_TYPE, content_type)], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
