use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{RwLock, watch};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMsg};
use tracing::{info, warn};
use uuid::Uuid;
use velo_protocol::{
    AgentEvent, AgentProvider, CreateSessionRequest, SessionInfo, SessionInputRequest,
    SessionStatus, WsServerMessage,
};
use velo_relay::{
    DEFAULT_RELAY_PORT, EncryptedRelayFrame, PairingTicket, X25519Keypair, build_encrypted_frame,
    derive_ratcheted_session_key_hex, open_payload, run_relay_server,
};
use velo_worktree::WorktreeManager;

use crate::DaemonState;

static EMBEDDED_RELAY_STARTED: AtomicBool = AtomicBool::new(false);
static TUNNEL_SPAWNED: AtomicBool = AtomicBool::new(false);
static BRIDGE_SUPERVISOR_STARTED: AtomicBool = AtomicBool::new(false);
static BRIDGE_CONNECTED: AtomicBool = AtomicBool::new(false);
static RATCHET_ACTIVE: AtomicBool = AtomicBool::new(false);
static PEERS_SEEN_COUNT: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Default, Serialize)]
pub struct TunnelStatusSnapshot {
    pub status: String, // "idle" | "starting" | "ready" | "unavailable"
    pub public_wss_url: Option<String>,
    pub detail: Option<String>,
}

static TUNNEL_STATUS: OnceLock<RwLock<TunnelStatusSnapshot>> = OnceLock::new();

fn truncate_utf8_chars(s: &str, max_chars: usize, suffix: &str) -> String {
    if s.len() <= max_chars {
        return s.to_string();
    }
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    let head: String = s.chars().take(max_chars).collect();
    format!("{}{}", head, suffix)
}

fn compact_json_value(val: &Value, max_str_chars: usize) -> Value {
    match val {
        Value::String(s) => Value::String(truncate_utf8_chars(s, max_str_chars, "… [已截断]")),
        Value::Array(arr) => Value::Array(
            arr.iter()
                .take(32)
                .map(|v| compact_json_value(v, max_str_chars))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map.iter().take(32) {
                out.insert(k.clone(), compact_json_value(v, max_str_chars));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Compacts a single `AgentEvent` for mobile E2EE relay transport so multi-hundred-KB
/// MCP / shell outputs never blow past WebSocket frame limits or stall mobile cellular/Wi-Fi.
fn compact_event_for_relay(ev: &AgentEvent, max_tool_output_chars: usize) -> AgentEvent {
    match ev {
        AgentEvent::ToolCallCompleted {
            session_id,
            tool_id,
            output,
            is_error,
            timestamp,
        } => AgentEvent::ToolCallCompleted {
            session_id: *session_id,
            tool_id: tool_id.clone(),
            output: truncate_utf8_chars(
                output,
                max_tool_output_chars,
                "\n… [完整长输出保存在 Mac 桌面端]",
            ),
            is_error: *is_error,
            timestamp: *timestamp,
        },
        AgentEvent::ToolCallRequested {
            session_id,
            tool_id,
            tool_name,
            arguments,
            timestamp,
        } => AgentEvent::ToolCallRequested {
            session_id: *session_id,
            tool_id: tool_id.clone(),
            tool_name: tool_name.clone(),
            arguments: compact_json_value(arguments, 800),
            timestamp: *timestamp,
        },
        AgentEvent::UserMessage {
            session_id,
            text,
            images,
            timestamp,
        } => AgentEvent::UserMessage {
            session_id: *session_id,
            text: text.clone(),
            // Strip multi-MB inline base64 data URIs over blind relay; keep lightweight URLs/names
            images: images
                .iter()
                .filter(|img| img.len() < 4096)
                .cloned()
                .collect(),
            timestamp: *timestamp,
        },
        other => other.clone(),
    }
}

/// Compacts a full session `event_history` so the serialized JSON stays strictly under ~440 KB
/// (< 920 KB hex-sealed frame, safely inside any 2 MB WebSocket/relay limit) while preserving
/// 100% of user prompts, AI replies, errors, status transitions, and recent execution traces.
pub(crate) fn compact_history_for_relay(evs: &[AgentEvent]) -> Vec<AgentEvent> {
    let normalized = crate::enrich_history_turn_metrics(evs);
    // Drop noisy terminal/pty/browser raw lines not rendered in mobile chat timeline
    let mut filtered: Vec<AgentEvent> = Vec::with_capacity(normalized.len());
    for ev in &normalized {
        if matches!(
            ev,
            AgentEvent::TerminalOutput { .. }
                | AgentEvent::PtyOutput { .. }
                | AgentEvent::BrowserCommand { .. }
                | AgentEvent::ProviderSessionBound { .. }
        ) {
            continue;
        }
        filtered.push(compact_event_for_relay(ev, 2400));
    }

    const MAX_SNAPSHOT_JSON_BYTES: usize = 440_000;
    if let Ok(bytes) = serde_json::to_vec(&filtered) {
        if bytes.len() <= MAX_SNAPSHOT_JSON_BYTES {
            return filtered;
        }
    }

    // Second pass for very long 900+ event threads: tighter tool output cap (360 chars) on older steps,
    // and keep all core conversation events (`UserMessage`, `MessageDelta`, `StatusChanged`, `UsageUpdated`, `Error`)
    // plus the most recent 120 process (`ThinkingDelta` / `ToolCall*`) events.
    let total_process = filtered
        .iter()
        .filter(|e| {
            matches!(
                e,
                AgentEvent::ThinkingDelta { .. }
                    | AgentEvent::ToolCallRequested { .. }
                    | AgentEvent::ToolCallCompleted { .. }
            )
        })
        .count();
    let skip_process = total_process.saturating_sub(120);
    let mut seen_process = 0usize;
    let mut slim: Vec<AgentEvent> = Vec::with_capacity(filtered.len().min(260));

    for ev in filtered {
        let is_proc = matches!(
            ev,
            AgentEvent::ThinkingDelta { .. }
                | AgentEvent::ToolCallRequested { .. }
                | AgentEvent::ToolCallCompleted { .. }
        );
        if is_proc {
            seen_process += 1;
            if seen_process <= skip_process {
                continue;
            }
            slim.push(compact_event_for_relay(&ev, 420));
        } else {
            slim.push(ev);
        }
    }
    slim
}
static LAST_PEER_SEEN: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static BRIDGE_CONFIG_TX: OnceLock<watch::Sender<BridgeTargetConfig>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
struct BridgeTargetConfig {
    pub connect_ws_url: String,
    pub room_id: String,
    pub root_key_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedPairingIdentity {
    pub room_id: String,
    pub shared_key_hex: String,
    pub daemon_secret_hex: String,
    pub daemon_pubkey_hex: String,
    #[serde(default)]
    pub custom_relay_url: Option<String>,
}

fn pairing_identity_path() -> PathBuf {
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".velo").join("pairing_identity.json")
}

fn generate_fresh_identity(custom_relay_url: Option<String>) -> PersistedPairingIdentity {
    let kp = X25519Keypair::generate();
    let ticket = PairingTicket::generate("ws://127.0.0.1:6768", "127.0.0.1:6767");
    PersistedPairingIdentity {
        room_id: ticket.room_id,
        shared_key_hex: ticket.shared_key_hex,
        daemon_secret_hex: kp.secret_hex(),
        daemon_pubkey_hex: kp.public_hex,
        custom_relay_url,
    }
}

fn save_identity_sync(id: &PersistedPairingIdentity) {
    let path = pairing_identity_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(id) {
        let _ = std::fs::write(&path, raw);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

pub fn load_or_create_pairing_identity() -> PersistedPairingIdentity {
    let path = pairing_identity_path();
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<PersistedPairingIdentity>(&raw) {
            if !parsed.room_id.is_empty() && parsed.shared_key_hex.len() == 64 {
                return parsed;
            }
        }
    }
    let fresh = generate_fresh_identity(std::env::var("VELO_RELAY_URL").ok().filter(|s| !s.trim().is_empty()));
    save_identity_sync(&fresh);
    fresh
}

pub fn rotate_pairing_identity() -> PersistedPairingIdentity {
    let prev = load_or_create_pairing_identity();
    let fresh = generate_fresh_identity(prev.custom_relay_url);
    save_identity_sync(&fresh);
    PEERS_SEEN_COUNT.store(0, Ordering::SeqCst);
    RATCHET_ACTIVE.store(false, Ordering::SeqCst);
    fresh
}

pub fn update_custom_relay_url(relay_url: Option<String>) -> PersistedPairingIdentity {
    let mut id = load_or_create_pairing_identity();
    id.custom_relay_url = relay_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    save_identity_sync(&id);
    id
}

fn tunnel_lock() -> &'static RwLock<TunnelStatusSnapshot> {
    TUNNEL_STATUS.get_or_init(|| {
        RwLock::new(TunnelStatusSnapshot {
            status: "idle".to_string(),
            public_wss_url: None,
            detail: None,
        })
    })
}

fn last_peer_lock() -> &'static RwLock<Option<String>> {
    LAST_PEER_SEEN.get_or_init(|| RwLock::new(None))
}

pub async fn get_tunnel_snapshot() -> TunnelStatusSnapshot {
    tunnel_lock().read().await.clone()
}

#[derive(Debug, Clone, Serialize)]
pub struct E2EEBridgeStatusDto {
    pub bridge_connected: bool,
    pub ratchet_active: bool,
    pub peers_seen: usize,
    pub last_peer_seen_at: Option<String>,
    pub tunnel: TunnelStatusSnapshot,
}

pub async fn get_e2ee_status_dto() -> E2EEBridgeStatusDto {
    E2EEBridgeStatusDto {
        bridge_connected: BRIDGE_CONNECTED.load(Ordering::SeqCst),
        ratchet_active: RATCHET_ACTIVE.load(Ordering::SeqCst),
        peers_seen: PEERS_SEEN_COUNT.load(Ordering::SeqCst),
        last_peer_seen_at: last_peer_lock().read().await.clone(),
        tunnel: get_tunnel_snapshot().await,
    }
}

pub async fn ensure_local_relay_running() {
    if EMBEDDED_RELAY_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let addr: SocketAddr = ([0, 0, 0, 0], DEFAULT_RELAY_PORT).into();
        tokio::spawn(async move {
            if let Err(err) = run_relay_server(addr).await {
                warn!(
                    "Embedded velo-relay bind note (may already be running): {}",
                    err
                );
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    }
}

fn resolve_cloudflared_binary() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/cloudflared"),
        PathBuf::from("/usr/local/bin/cloudflared"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".velo/bin/cloudflared"));
        candidates.push(home.join(".local/bin/cloudflared"));
    }
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    velo_agent::resolve_cli_binary("cloudflared")
}

fn extract_public_tunnel_wss(line: &str) -> Option<String> {
    let idx = line.find("https://")?;
    let rest = &line[idx..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '|' || c == ',')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches('/');
    if url.ends_with(".lhr.life") {
        return Some(url.replacen("https://", "wss://", 1));
    }
    if url.ends_with(".trycloudflare.com") && !url.contains("api.trycloudflare.com") {
        return Some(url.replacen("https://", "wss://", 1));
    }
    None
}

/// Starts a zero-account public TLS 1.3 Blind Relay Tunnel pointing STRICTLY at `127.0.0.1:6768` (`velo-relay`),
/// exposing ONLY ChaCha20-Poly1305 AEAD blind ciphertext rooms over `wss://` (`*.lhr.life` via built-in OpenSSH,
/// with automatic fallback to `cloudflared` `*.trycloudflare.com`).
/// Local `velo-daemon` HTTP API (`6767`) is NEVER exposed to the public tunnel.
pub async fn ensure_public_blind_tunnel(wait_up_to_ms: u64) -> TunnelStatusSnapshot {
    ensure_local_relay_running().await;

    if let Some(existing) = tunnel_lock().read().await.public_wss_url.clone() {
        if !existing.is_empty() {
            return get_tunnel_snapshot().await;
        }
    }

    if TUNNEL_SPAWNED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        {
            let mut guard = tunnel_lock().write().await;
            guard.status = "starting".to_string();
            guard.detail = Some("正在建立公网 TLS 1.3 零信任盲中继加密隧道…".to_string());
        }

        tokio::spawn(async move {
            let mut attempt: usize = 0;
            loop {
                let use_ssh_primary = Path::new("/usr/bin/ssh").is_file()
                    && (attempt % 2 == 0 || resolve_cloudflared_binary().is_none());

                if use_ssh_primary {
                    let mut cmd = Command::new("/usr/bin/ssh");
                    cmd.args([
                        "-o",
                        "StrictHostKeyChecking=accept-new",
                        "-o",
                        "BatchMode=yes",
                        "-o",
                        "ExitOnForwardFailure=yes",
                        "-o",
                        "ConnectTimeout=8",
                        "-o",
                        "ServerAliveInterval=25",
                        "-o",
                        "ServerAliveCountMax=3",
                        "-R",
                        &format!("80:127.0.0.1:{DEFAULT_RELAY_PORT}"),
                        "nokey@localhost.run",
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());

                    if let Ok(mut child) = cmd.spawn() {
                        if let Some(stdout) = child.stdout.take() {
                            let mut reader = BufReader::new(stdout).lines();
                            while let Ok(Some(line)) = reader.next_line().await {
                                if let Some(wss_url) = extract_public_tunnel_wss(&line) {
                                    info!(
                                        "Zero-Trust Blind E2EE Public Tunnel active at {} -> 127.0.0.1:{}",
                                        wss_url, DEFAULT_RELAY_PORT
                                    );
                                    let mut guard = tunnel_lock().write().await;
                                    guard.status = "ready".to_string();
                                    guard.public_wss_url = Some(wss_url);
                                    guard.detail = Some(
                                        "公网 TLS 1.3 盲中继已就绪（5G 免代理直连 · 仅转发 ChaCha20-Poly1305 密文）"
                                            .to_string(),
                                    );
                                }
                            }
                        }
                        let _ = child.wait().await;
                        {
                            let mut guard = tunnel_lock().write().await;
                            guard.status = "starting".to_string();
                            guard.public_wss_url = None;
                        }
                        warn!("SSH blind relay tunnel exited; reconnecting...");
                    }
                } else if let Some(bin) = resolve_cloudflared_binary() {
                    let mut cmd = Command::new(&bin);
                    cmd.args([
                        "tunnel",
                        "--no-autoupdate",
                        "--url",
                        &format!("http://127.0.0.1:{DEFAULT_RELAY_PORT}"),
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped());

                    if let Ok(mut child) = cmd.spawn() {
                        if let Some(stderr) = child.stderr.take() {
                            let mut reader = BufReader::new(stderr).lines();
                            while let Ok(Some(line)) = reader.next_line().await {
                                if let Some(wss_url) = extract_public_tunnel_wss(&line) {
                                    info!(
                                        "Zero-Trust Blind E2EE Public Tunnel active at {} -> 127.0.0.1:{}",
                                        wss_url, DEFAULT_RELAY_PORT
                                    );
                                    let mut guard = tunnel_lock().write().await;
                                    guard.status = "ready".to_string();
                                    guard.public_wss_url = Some(wss_url);
                                    guard.detail = Some(
                                        "公网 TLS 1.3 盲中继已就绪（仅转发 ChaCha20-Poly1305 密文）"
                                            .to_string(),
                                    );
                                }
                            }
                        }
                        let _ = child.wait().await;
                        {
                            let mut guard = tunnel_lock().write().await;
                            guard.status = "starting".to_string();
                            guard.public_wss_url = None;
                        }
                    }
                } else {
                    let mut guard = tunnel_lock().write().await;
                    guard.status = "unavailable".to_string();
                    guard.detail = Some("未检测到可用隧道组件，请填入自定义 wss:// 中继地址".to_string());
                    TUNNEL_SPAWNED.store(false, Ordering::SeqCst);
                    return;
                }

                attempt = attempt.wrapping_add(1);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        });
    }

    if wait_up_to_ms > 0 {
        let steps = (wait_up_to_ms / 150).max(1);
        for _ in 0..steps {
            let snap = get_tunnel_snapshot().await;
            if snap.public_wss_url.is_some() || snap.status == "unavailable" {
                return snap;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
    }

    get_tunnel_snapshot().await
}

fn compute_daemon_connect_ws_url(ticket: &PairingTicket) -> String {
    let relay = ticket.relay_url.trim().trim_end_matches('/');
    let daemon_host = ticket
        .daemon_addr
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split(':')
        .next()
        .unwrap_or("127.0.0.1");

    // Both local `ws://<lan>:6768` AND our built-in `wss://*.lhr.life` / `wss://*.trycloudflare.com`
    // tunnels terminate directly at the embedded `127.0.0.1:6768` blind relay inside this daemon!
    // External self-hosted relays (`wss://relay.example.com`) connect outbound via TLS WebSocket.
    let terminates_locally = relay.contains(".lhr.life")
        || relay.contains(".trycloudflare.com")
        || (relay.contains(&format!(":{DEFAULT_RELAY_PORT}"))
            && (relay.contains("127.0.0.1")
                || relay.contains("localhost")
                || (!daemon_host.is_empty() && relay.contains(daemon_host))));

    if terminates_locally {
        format!("ws://127.0.0.1:{}/room/{}", DEFAULT_RELAY_PORT, ticket.room_id)
    } else {
        let ws_base = if let Some(rest) = relay.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = relay.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            relay.to_string()
        };
        format!("{}/room/{}", ws_base, ticket.room_id)
    }
}

/// Ensures the single supervised auto-reconnecting E2EE Bridge task is running and pointed at `ticket`.
pub fn spawn_daemon_e2ee_bridge(state: DaemonState, ticket: PairingTicket) {
    let target = BridgeTargetConfig {
        connect_ws_url: compute_daemon_connect_ws_url(&ticket),
        room_id: ticket.room_id.clone(),
        root_key_hex: ticket.shared_key_hex.clone(),
    };

    if let Some(tx) = BRIDGE_CONFIG_TX.get() {
        if *tx.borrow() != target {
            let _ = tx.send(target);
        }
        return;
    }

    let (tx, rx) = watch::channel(target);
    let _ = BRIDGE_CONFIG_TX.set(tx);

    if BRIDGE_SUPERVISOR_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        tokio::spawn(run_supervised_e2ee_bridge(state, rx));
    }
}

/// Bootstraps the embedded blind relay, background edge tunnel, and persistent E2EE daemon bridge on startup.
pub fn autostart_background_e2ee_bridge(state: DaemonState) {
    tokio::spawn(async move {
        ensure_local_relay_running().await;
        let id = load_or_create_pairing_identity();
        let relay_url = if let Some(ref custom) = id.custom_relay_url {
            custom.clone()
        } else {
            let snap = ensure_public_blind_tunnel(5000).await;
            snap.public_wss_url
                .unwrap_or_else(|| format!("ws://127.0.0.1:{DEFAULT_RELAY_PORT}"))
        };
        let ticket = PairingTicket::from_existing(
            id.room_id,
            id.shared_key_hex,
            id.daemon_pubkey_hex,
            &relay_url,
            "127.0.0.1:6767",
        );
        spawn_daemon_e2ee_bridge(state, ticket);
    });
}

async fn run_supervised_e2ee_bridge(
    state: DaemonState,
    mut cfg_rx: watch::Receiver<BridgeTargetConfig>,
) {
    loop {
        let cfg = cfg_rx.borrow_and_update().clone();
        match connect_async(&cfg.connect_ws_url).await {
            Ok((ws_stream, _)) => {
                BRIDGE_CONNECTED.store(true, Ordering::SeqCst);
                info!(
                    "Daemon Zero-Trust E2EE Bridge connected to {} (room {})",
                    cfg.connect_ws_url, cfg.room_id
                );

                let (mut writer, mut reader) = ws_stream.split();
                let mut event_rx = state.event_tx.subscribe();
                let mut snapshot_rx = state.snapshot_tx.subscribe();
                let mut out_nonce: u64 = (Utc::now().timestamp_millis() as u64).saturating_mul(1000);
                let mut active_key_hex = cfg.root_key_hex.clone();
                let mut max_nonce_by_sender: HashMap<String, u64> = HashMap::new();
                struct PendingE2EEUpload {
                    filename: Option<String>,
                    mime_type: Option<String>,
                    chunks: Vec<Option<Vec<u8>>>,
                    total_bytes: usize,
                }
                let mut pending_uploads: HashMap<String, PendingE2EEUpload> = HashMap::new();
                let mut last_rekey_hint_at = std::time::Instant::now()
                    .checked_sub(std::time::Duration::from_secs(10))
                    .unwrap_or_else(std::time::Instant::now);
                let mut ping_interval =
                    tokio::time::interval(std::time::Duration::from_secs(20));
                ping_interval.tick().await; // consume immediate first tick

                let send_sealed_with_key =
                    |val: &Value, key_hex: &str, nonce: &mut u64| -> Option<String> {
                        let bytes = serde_json::to_vec(val).ok()?;
                        let frame = build_encrypted_frame("daemon", key_hex, *nonce, &bytes);
                        *nonce = nonce.saturating_add(1);
                        serde_json::to_string(&frame).ok()
                    };

                // Send initial encrypted snapshot under root key
                {
                    let guard = state.inner.read().await;
                    let mut sessions: Vec<SessionInfo> = guard.sessions.values().cloned().collect();
                    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                    let snap = serde_json::to_value(WsServerMessage::SessionsSnapshot { sessions })
                        .unwrap_or_else(|_| json!({}));
                    if let Some(frame_txt) =
                        send_sealed_with_key(&snap, &active_key_hex, &mut out_nonce)
                    {
                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                    }
                }

                loop {
                    tokio::select! {
                        changed = cfg_rx.changed() => {
                            if changed.is_ok() {
                                info!("Switching E2EE Relay Bridge to updated room/relay target...");
                            }
                            break;
                        }
                        _ = ping_interval.tick() => {
                            if writer.send(WsMsg::Ping(Vec::new().into())).await.is_err() {
                                break;
                            }
                        }
                        Ok(sessions) = snapshot_rx.recv() => {
                            if let Ok(val) = serde_json::to_value(WsServerMessage::SessionsSnapshot { sessions }) {
                                if let Some(frame_txt) =
                                    send_sealed_with_key(&val, &active_key_hex, &mut out_nonce)
                                {
                                    if writer.send(WsMsg::Text(frame_txt.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                        Ok(ev) = event_rx.recv() => {
                            let compact_ev = compact_event_for_relay(&ev, 2800);
                            if let Ok(val) = serde_json::to_value(WsServerMessage::Event { event: compact_ev }) {
                                if let Some(frame_txt) =
                                    send_sealed_with_key(&val, &active_key_hex, &mut out_nonce)
                                {
                                    if writer.send(WsMsg::Text(frame_txt.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                        maybe_msg = reader.next() => {
                            let Some(Ok(msg)) = maybe_msg else { break };
                            let WsMsg::Text(raw_txt) = msg else { continue };
                            let Ok(frame) = serde_json::from_str::<EncryptedRelayFrame>(&raw_txt) else {
                                continue;
                            };
                            if frame.sender_id == "daemon" {
                                continue;
                            }

                            // Anti-replay check per sender_id
                            if let Some(&prev_nonce) = max_nonce_by_sender.get(&frame.sender_id) {
                                if frame.nonce <= prev_nonce {
                                    warn!(
                                        "Dropped replayed E2EE frame from {} (nonce {} <= {})",
                                        frame.sender_id, frame.nonce, prev_nonce
                                    );
                                    continue;
                                }
                            }

                            // Try opening with active ratcheted session key first, then fallback to QR root key
                            // (so newly reconnecting mobile peers can always initiate handshake/sync).
                            let opened = open_payload(&active_key_hex, frame.nonce, &frame.ciphertext_hex)
                                .or_else(|| {
                                    if active_key_hex != cfg.root_key_hex {
                                        open_payload(&cfg.root_key_hex, frame.nonce, &frame.ciphertext_hex)
                                    } else {
                                        None
                                    }
                                });

                            let Some(pt_bytes) = opened else {
                                warn!(
                                    "Rejected unauthenticated/stale-key E2EE frame on room {}; sending root-sealed rekey hint",
                                    cfg.room_id
                                );
                                if last_rekey_hint_at.elapsed() >= std::time::Duration::from_secs(2) {
                                    last_rekey_hint_at = std::time::Instant::now();
                                    let hint = json!({
                                        "type": "rekey_required",
                                        "ts": Utc::now().to_rfc3339(),
                                    });
                                    if let Some(frame_txt) = send_sealed_with_key(
                                        &hint,
                                        &cfg.root_key_hex,
                                        &mut out_nonce,
                                    ) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }
                                }
                                continue;
                            };

                            let is_new_sender = !max_nonce_by_sender.contains_key(&frame.sender_id);
                            max_nonce_by_sender.insert(frame.sender_id.clone(), frame.nonce);
                            if is_new_sender {
                                PEERS_SEEN_COUNT.fetch_add(1, Ordering::SeqCst);
                            }
                            *last_peer_lock().write().await = Some(Utc::now().to_rfc3339());

                            let Ok(cmd_val) = serde_json::from_slice::<Value>(&pt_bytes) else {
                                continue;
                            };
                            let cmd = cmd_val.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

                            // Optional X25519 Ephemeral Forward-Secrecy Key Ratchet on `"sync"`
                            if cmd == "sync" {
                                if let Some(client_eph_pub) = cmd_val
                                    .get("client_ephemeral_pub")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| s.len() == 64)
                                {
                                    let daemon_eph = X25519Keypair::generate();
                                    if let Some(ecdh_hex) =
                                        daemon_eph.derive_shared_key_hex(client_eph_pub)
                                    {
                                        let ratcheted = derive_ratcheted_session_key_hex(
                                            &cfg.root_key_hex,
                                            &ecdh_hex,
                                        );
                                        let ack = json!({
                                            "type": "e2ee_ratchet",
                                            "daemon_ephemeral_pub": daemon_eph.public_hex,
                                            "cipher": "X25519-ChaCha20-Poly1305-FS",
                                        });
                                        // Send ratchet response sealed under QR root key so client can derive the same ratcheted key
                                        if let Some(frame_txt) = send_sealed_with_key(
                                            &ack,
                                            &cfg.root_key_hex,
                                            &mut out_nonce,
                                        ) {
                                            let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                        }
                                        active_key_hex = ratcheted;
                                        RATCHET_ACTIVE.store(true, Ordering::SeqCst);
                                    }
                                } else {
                                    // Peer did not request ephemeral ratchet (e.g. Web mobile client); use root key
                                    active_key_hex = cfg.root_key_hex.clone();
                                    RATCHET_ACTIVE.store(false, Ordering::SeqCst);
                                }
                            }

                            match cmd {
                                "ping" => {
                                    let pong = json!({ "type": "pong", "ts": Utc::now().to_rfc3339() });
                                    if let Some(frame_txt) =
                                        send_sealed_with_key(&pong, &active_key_hex, &mut out_nonce)
                                    {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }
                                }
                                "sync" => {
                                    let models_val = crate::build_models_catalog_json().await;
                                    if let Some(models_arr) = models_val.get("models") {
                                        let m_snap = json!({
                                            "type": "models_snapshot",
                                            "models": models_arr,
                                        });
                                        if let Some(frame_txt) = send_sealed_with_key(
                                            &m_snap,
                                            &active_key_hex,
                                            &mut out_nonce,
                                        ) {
                                            let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                        }
                                    }

                                    let ws_list = state.list_workspaces().await;
                                    let ws_snap = json!({
                                        "type": "workspaces_snapshot",
                                        "workspaces": ws_list,
                                    });
                                    if let Some(frame_txt) = send_sealed_with_key(
                                        &ws_snap,
                                        &active_key_hex,
                                        &mut out_nonce,
                                    ) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }

                                    let guard = state.inner.read().await;
                                    let mut sessions: Vec<SessionInfo> =
                                        guard.sessions.values().cloned().collect();
                                    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                                    let mut top_ids: Vec<Uuid> =
                                        sessions.iter().take(8).map(|s| s.id).collect();
                                    if let Some(active_s) = cmd_val
                                        .get("active_session_id")
                                        .and_then(|v| v.as_str())
                                        .and_then(|s| Uuid::parse_str(s).ok())
                                    {
                                        if !top_ids.contains(&active_s) {
                                            top_ids.insert(0, active_s);
                                        }
                                    }
                                    if let Ok(snap) = serde_json::to_value(
                                        WsServerMessage::SessionsSnapshot { sessions },
                                    ) {
                                        if let Some(frame_txt) = send_sealed_with_key(
                                            &snap,
                                            &active_key_hex,
                                            &mut out_nonce,
                                        ) {
                                            let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                        }
                                    }
                                    for sid in top_ids {
                                        if let Some(evs) = guard.event_history.get(&sid) {
                                            let compact_evs = compact_history_for_relay(evs);
                                            let ev_snap = json!({
                                                "type": "events_snapshot",
                                                "session_id": sid,
                                                "events": compact_evs,
                                            });
                                            if let Some(frame_txt) = send_sealed_with_key(
                                                &ev_snap,
                                                &active_key_hex,
                                                &mut out_nonce,
                                            ) {
                                                let _ =
                                                    writer.send(WsMsg::Text(frame_txt.into())).await;
                                            }
                                        }
                                    }
                                }
                                "get_events" => {
                                    if let Some(sid_s) =
                                        cmd_val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            let guard = state.inner.read().await;
                                            let compact_evs = guard
                                                .event_history
                                                .get(&sid)
                                                .map(|v| compact_history_for_relay(v))
                                                .unwrap_or_default();
                                            let ev_snap = json!({
                                                "type": "events_snapshot",
                                                "session_id": sid,
                                                "events": compact_evs,
                                            });
                                            if let Some(frame_txt) = send_sealed_with_key(
                                                &ev_snap,
                                                &active_key_hex,
                                                &mut out_nonce,
                                            ) {
                                                let _ =
                                                    writer.send(WsMsg::Text(frame_txt.into())).await;
                                            }
                                        }
                                    }
                                }
                                "resolve_approval" => {
                                    let req_id = cmd_val
                                        .get("request_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let decision = cmd_val
                                        .get("decision")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("approve");
                                    if let Some(sid_s) =
                                        cmd_val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            state.resolve_permission(sid, req_id, decision).await;
                                        }
                                    }
                                }
                                "answer_question" => {
                                    let q_id = cmd_val
                                        .get("question_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let answers: Vec<String> = cmd_val
                                        .get("answers")
                                        .and_then(|v| v.as_array())
                                        .map(|arr| {
                                            arr.iter()
                                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                                .collect()
                                        })
                                        .unwrap_or_default();
                                    if let Some(sid_s) =
                                        cmd_val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            state.resolve_question(sid, q_id, answers).await;
                                        }
                                    }
                                }
                                "send_input" => {
                                    if let (Some(sid_s), Some(inp)) = (
                                        cmd_val.get("session_id").and_then(|v| v.as_str()),
                                        cmd_val.get("input").and_then(|v| v.as_str()),
                                    ) {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            let model = cmd_val
                                                .get("model")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let effort = cmd_val
                                                .get("effort")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let approval_mode = cmd_val
                                                .get("approval_mode")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let provider = cmd_val
                                                .get("provider")
                                                .and_then(|v| v.as_str())
                                                .filter(|s| !s.trim().is_empty())
                                                .map(AgentProvider::from_str_loose);
                                            let images: Vec<String> = cmd_val
                                                .get("images")
                                                .and_then(|v| v.as_array())
                                                .map(|arr| {
                                                    arr.iter()
                                                        .filter_map(|x| x.as_str().map(str::to_string))
                                                        .collect()
                                                })
                                                .unwrap_or_default();
                                            if let Err(err) = state
                                                .dispatch_session_input(
                                                    sid,
                                                    SessionInputRequest {
                                                        input: inp.to_string(),
                                                        model,
                                                        effort,
                                                        provider,
                                                        reset_thread: false,
                                                        truncate_to_user_turn: None,
                                                        images,
                                                        approval_mode,
                                                    },
                                                )
                                                .await
                                            {
                                                let err_str = err.to_string();
                                                warn!("E2EE send_input failed for {}: {}", sid, err_str);
                                                if err_str.contains("not found") {
                                                    let now = Utc::now();
                                                    for ev in [
                                                        AgentEvent::Error {
                                                            session_id: sid,
                                                            error: err_str.clone(),
                                                            timestamp: now,
                                                        },
                                                        AgentEvent::StatusChanged {
                                                            session_id: sid,
                                                            status: SessionStatus::Failed,
                                                            message: Some(err_str),
                                                            timestamp: now,
                                                        },
                                                    ] {
                                                        if let Ok(val) = serde_json::to_value(
                                                            WsServerMessage::Event { event: ev },
                                                        ) {
                                                            if let Some(frame_txt) =
                                                                send_sealed_with_key(
                                                                    &val,
                                                                    &active_key_hex,
                                                                    &mut out_nonce,
                                                                )
                                                            {
                                                                let _ = writer
                                                                    .send(WsMsg::Text(
                                                                        frame_txt.into(),
                                                                    ))
                                                                    .await;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                "stop_session" => {
                                    if let Some(sid_s) =
                                        cmd_val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            state.stop_session_by_id(sid).await;
                                            let ws_list = state.list_workspaces().await;
                                    let ws_snap = json!({
                                        "type": "workspaces_snapshot",
                                        "workspaces": ws_list,
                                    });
                                    if let Some(frame_txt) = send_sealed_with_key(
                                        &ws_snap,
                                        &active_key_hex,
                                        &mut out_nonce,
                                    ) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }

                                    let guard = state.inner.read().await;
                                            let mut sessions: Vec<SessionInfo> =
                                                guard.sessions.values().cloned().collect();
                                            sessions
                                                .sort_by(|a, b| b.created_at.cmp(&a.created_at));
                                            if let Ok(snap) = serde_json::to_value(
                                                WsServerMessage::SessionsSnapshot { sessions },
                                            ) {
                                                if let Some(frame_txt) = send_sealed_with_key(
                                                    &snap,
                                                    &active_key_hex,
                                                    &mut out_nonce,
                                                ) {
                                                    let _ = writer
                                                        .send(WsMsg::Text(frame_txt.into()))
                                                        .await;
                                                }
                                            }
                                        }
                                    }
                                }
                                "launch_cli_login" => {
                                    let prov = cmd_val
                                        .get("provider")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("agy");
                                    let _ = crate::launch_provider_cli_login(prov).await;
                                }
                                "add_workspace" => {
                                    if let Some(p) = cmd_val.get("path").and_then(|v| v.as_str()) {
                                        let ws_list = state.add_workspace(p).await;
                                        let ws_snap = json!({
                                            "type": "workspaces_snapshot",
                                            "workspaces": ws_list,
                                        });
                                        if let Some(frame_txt) = send_sealed_with_key(
                                            &ws_snap,
                                            &active_key_hex,
                                            &mut out_nonce,
                                        ) {
                                            let _ =
                                                writer.send(WsMsg::Text(frame_txt.into())).await;
                                        }
                                    }
                                }
                                "remove_workspace" => {
                                    if let Some(p) = cmd_val.get("path").and_then(|v| v.as_str()) {
                                        let ws_list = state.remove_workspace(p).await;
                                        let ws_snap = json!({
                                            "type": "workspaces_snapshot",
                                            "workspaces": ws_list,
                                        });
                                        if let Some(frame_txt) = send_sealed_with_key(
                                            &ws_snap,
                                            &active_key_hex,
                                            &mut out_nonce,
                                        ) {
                                            let _ =
                                                writer.send(WsMsg::Text(frame_txt.into())).await;
                                        }
                                    }
                                }
                                "create_session" => {
                                    let prompt = cmd_val
                                        .get("prompt")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .trim()
                                        .to_string();
                                    let fallback_repo = {
                                        let guard = state.inner.read().await;
                                        guard
                                            .sessions
                                            .values()
                                            .next()
                                            .map(|s| s.repo_root.clone())
                                            .unwrap_or_else(|| {
                                                velo_worktree::default_general_workspace()
                                                    .to_string_lossy()
                                                    .to_string()
                                            })
                                    };
                                    let repo_path = cmd_val
                                        .get("repo_path")
                                        .and_then(|v| v.as_str())
                                        .filter(|s| !s.trim().is_empty())
                                        .map(str::to_string)
                                        .unwrap_or(fallback_repo);
                                    let provider_raw = cmd_val
                                        .get("provider")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("claude");
                                    let provider = AgentProvider::from_str_loose(provider_raw);
                                    let use_worktree = cmd_val
                                        .get("use_worktree")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                    let req = CreateSessionRequest {
                                        name: cmd_val
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string),
                                        provider,
                                        prompt,
                                        repo_path,
                                        branch: cmd_val
                                            .get("branch")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string),
                                        use_pty: false,
                                        parent_session_id: None,
                                        model: cmd_val
                                            .get("model")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string),
                                        effort: cmd_val
                                            .get("effort")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string),
                                        images: cmd_val
                                            .get("images")
                                            .and_then(|v| v.as_array())
                                            .map(|arr| {
                                                arr.iter()
                                                    .filter_map(|x| x.as_str().map(str::to_string))
                                                    .collect()
                                            })
                                            .unwrap_or_default(),
                                        approval_mode: cmd_val
                                            .get("approval_mode")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string),
                                        setup_command: None,
                                        use_worktree,
                                    };
                                    match state.create_session(req).await {
                                        Ok(_) => {
                                            let ws_list = state.list_workspaces().await;
                                    let ws_snap = json!({
                                        "type": "workspaces_snapshot",
                                        "workspaces": ws_list,
                                    });
                                    if let Some(frame_txt) = send_sealed_with_key(
                                        &ws_snap,
                                        &active_key_hex,
                                        &mut out_nonce,
                                    ) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }

                                    let guard = state.inner.read().await;
                                            let mut sessions: Vec<SessionInfo> =
                                                guard.sessions.values().cloned().collect();
                                            sessions
                                                .sort_by(|a, b| b.created_at.cmp(&a.created_at));
                                            if let Ok(snap) = serde_json::to_value(
                                                WsServerMessage::SessionsSnapshot { sessions },
                                            ) {
                                                if let Some(frame_txt) = send_sealed_with_key(
                                                    &snap,
                                                    &active_key_hex,
                                                    &mut out_nonce,
                                                ) {
                                                    let _ = writer
                                                        .send(WsMsg::Text(frame_txt.into()))
                                                        .await;
                                                }
                                            }
                                        }
                                        Err(err) => {
                                            warn!("E2EE create_session failed: {}", err);
                                        }
                                    }
                                }
                                "handoff_session" => {
                                    if let Some(sid_s) =
                                        cmd_val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            let target_raw = cmd_val
                                                .get("target_provider")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("claude");
                                            let target_provider =
                                                AgentProvider::from_str_loose(target_raw);
                                            let model = cmd_val
                                                .get("model")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let effort = cmd_val
                                                .get("effort")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let additional_instructions = cmd_val
                                                .get("additional_instructions")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let req = velo_protocol::HandoffSessionRequest {
                                                target_provider,
                                                model,
                                                effort,
                                                additional_instructions,
                                            };
                                            if let Ok(new_sess) =
                                                state.handoff_session(sid, req).await
                                            {
                                                let sessions: Vec<SessionInfo> = {
                                                    let ws_list = state.list_workspaces().await;
                                    let ws_snap = json!({
                                        "type": "workspaces_snapshot",
                                        "workspaces": ws_list,
                                    });
                                    if let Some(frame_txt) = send_sealed_with_key(
                                        &ws_snap,
                                        &active_key_hex,
                                        &mut out_nonce,
                                    ) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }

                                    let guard = state.inner.read().await;
                                                    let mut list: Vec<SessionInfo> =
                                                        guard.sessions.values().cloned().collect();
                                                    list.sort_by(|a, b| {
                                                        b.created_at.cmp(&a.created_at)
                                                    });
                                                    list
                                                };
                                                if let Ok(snap) = serde_json::to_value(
                                                    WsServerMessage::SessionsSnapshot { sessions },
                                                ) {
                                                    if let Some(frame_txt) = send_sealed_with_key(
                                                        &snap,
                                                        &active_key_hex,
                                                        &mut out_nonce,
                                                    ) {
                                                        let _ = writer
                                                            .send(WsMsg::Text(frame_txt.into()))
                                                            .await;
                                                    }
                                                }
                                                let handoff_msg = json!({
                                                    "type": "handoff_completed",
                                                    "source_session_id": sid,
                                                    "new_session_id": new_sess.id,
                                                });
                                                if let Some(frame_txt) = send_sealed_with_key(
                                                    &handoff_msg,
                                                    &active_key_hex,
                                                    &mut out_nonce,
                                                ) {
                                                    let _ = writer
                                                        .send(WsMsg::Text(frame_txt.into()))
                                                        .await;
                                                }
                                            }
                                        }
                                    }
                                }
                                "update_session" => {
                                    if let Some(sid_s) =
                                        cmd_val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            let name = cmd_val
                                                .get("name")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let provider = cmd_val
                                                .get("provider")
                                                .and_then(|v| v.as_str())
                                                .filter(|s| !s.trim().is_empty())
                                                .map(AgentProvider::from_str_loose);
                                            let model = cmd_val
                                                .get("model")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let effort = cmd_val
                                                .get("effort")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            let approval_mode = cmd_val
                                                .get("approval_mode")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_string);
                                            if state
                                                .update_session_fields(
                                                    sid,
                                                    name,
                                                    provider,
                                                    model,
                                                    effort,
                                                    approval_mode,
                                                    None,
                                                )
                                                .await
                                                .is_some()
                                            {
                                                let ws_list = state.list_workspaces().await;
                                    let ws_snap = json!({
                                        "type": "workspaces_snapshot",
                                        "workspaces": ws_list,
                                    });
                                    if let Some(frame_txt) = send_sealed_with_key(
                                        &ws_snap,
                                        &active_key_hex,
                                        &mut out_nonce,
                                    ) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }

                                    let guard = state.inner.read().await;
                                                let mut sessions: Vec<SessionInfo> =
                                                    guard.sessions.values().cloned().collect();
                                                sessions.sort_by(|a, b| {
                                                    b.created_at.cmp(&a.created_at)
                                                });
                                                if let Ok(snap) = serde_json::to_value(
                                                    WsServerMessage::SessionsSnapshot { sessions },
                                                ) {
                                                    if let Some(frame_txt) = send_sealed_with_key(
                                                        &snap,
                                                        &active_key_hex,
                                                        &mut out_nonce,
                                                    ) {
                                                        let _ = writer
                                                            .send(WsMsg::Text(frame_txt.into()))
                                                            .await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                "delete_session" => {
                                    if let Some(sid_s) =
                                        cmd_val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            let _ = state.delete_session_by_id(sid, true).await;
                                            let ws_list = state.list_workspaces().await;
                                    let ws_snap = json!({
                                        "type": "workspaces_snapshot",
                                        "workspaces": ws_list,
                                    });
                                    if let Some(frame_txt) = send_sealed_with_key(
                                        &ws_snap,
                                        &active_key_hex,
                                        &mut out_nonce,
                                    ) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }

                                    let guard = state.inner.read().await;
                                            let mut sessions: Vec<SessionInfo> =
                                                guard.sessions.values().cloned().collect();
                                            sessions
                                                .sort_by(|a, b| b.created_at.cmp(&a.created_at));
                                            if let Ok(snap) = serde_json::to_value(
                                                WsServerMessage::SessionsSnapshot { sessions },
                                            ) {
                                                if let Some(frame_txt) = send_sealed_with_key(
                                                    &snap,
                                                    &active_key_hex,
                                                    &mut out_nonce,
                                                ) {
                                                    let _ = writer
                                                        .send(WsMsg::Text(frame_txt.into()))
                                                        .await;
                                                }
                                            }
                                        }
                                    }
                                }
                                "get_diff" => {
                                    if let Some(sid_s) =
                                        cmd_val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        if let Ok(sid) = Uuid::parse_str(sid_s) {
                                            let wt_opt = {
                                                let guard = state.inner.read().await;
                                                guard
                                                    .sessions
                                                    .get(&sid)
                                                    .map(|s| s.worktree_path.clone())
                                            };
                                            if let Some(wt_str) = wt_opt {
                                                let wt_path = Path::new(&wt_str);
                                                let stats =
                                                    WorktreeManager::compute_diff_stats(wt_path)
                                                        .await
                                                        .unwrap_or_default();
                                                let diff =
                                                    WorktreeManager::get_unified_diff(wt_path)
                                                        .await
                                                        .unwrap_or_default();
                                                let diff_snap = json!({
                                                    "type": "diff_snapshot",
                                                    "session_id": sid,
                                                    "stats": stats,
                                                    "diff": diff,
                                                });
                                                if let Some(frame_txt) = send_sealed_with_key(
                                                    &diff_snap,
                                                    &active_key_hex,
                                                    &mut out_nonce,
                                                ) {
                                                    let _ = writer
                                                        .send(WsMsg::Text(frame_txt.into()))
                                                        .await;
                                                }
                                            }
                                        }
                                    }
                                }
                                "get_attachment" => {
                                    let req_id = cmd_val
                                        .get("request_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let raw_ref = cmd_val
                                        .get("ref")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let tier = cmd_val
                                        .get("tier")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("thumb")
                                        .to_string();
                                    if !raw_ref.is_empty() {
                                        use base64::{Engine as _, engine::general_purpose::STANDARD};
                                        match state.load_attachment_tier(&raw_ref, &tier).await {
                                            Some((bytes, mime_type)) if !bytes.is_empty() => {
                                                // Chunk at 180 KB raw (~240 KB base64 -> < 500 KB encrypted hex frame)
                                                const CHUNK_RAW_BYTES: usize = 180 * 1024;
                                                let slices: Vec<&[u8]> =
                                                    bytes.chunks(CHUNK_RAW_BYTES).collect();
                                                let total_chunks = slices.len();
                                                for (idx, chunk) in slices.into_iter().enumerate() {
                                                    let msg = json!({
                                                        "type": "attachment_chunk",
                                                        "request_id": req_id,
                                                        "ref": raw_ref,
                                                        "tier": tier,
                                                        "mime_type": mime_type,
                                                        "chunk_index": idx,
                                                        "total_chunks": total_chunks,
                                                        "data_base64": STANDARD.encode(chunk),
                                                    });
                                                    if let Some(frame_txt) = send_sealed_with_key(
                                                        &msg,
                                                        &active_key_hex,
                                                        &mut out_nonce,
                                                    ) {
                                                        if writer
                                                            .send(WsMsg::Text(frame_txt.into()))
                                                            .await
                                                            .is_err()
                                                        {
                                                            break;
                                                        }
                                                    }
                                                }
                                            }
                                            _ => {
                                                let msg = json!({
                                                    "type": "attachment_chunk",
                                                    "request_id": req_id,
                                                    "ref": raw_ref,
                                                    "tier": tier,
                                                    "not_found": true,
                                                    "chunk_index": 0,
                                                    "total_chunks": 0,
                                                });
                                                if let Some(frame_txt) = send_sealed_with_key(
                                                    &msg,
                                                    &active_key_hex,
                                                    &mut out_nonce,
                                                ) {
                                                    let _ = writer
                                                        .send(WsMsg::Text(frame_txt.into()))
                                                        .await;
                                                }
                                            }
                                        }
                                    }
                                }
                                "upload_attachment" => {
                                    let upload_id = cmd_val
                                        .get("upload_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let filename =
                                        cmd_val.get("filename").and_then(|v| v.as_str());
                                    let mime_type =
                                        cmd_val.get("mime_type").and_then(|v| v.as_str());
                                    let data_b64 = cmd_val
                                        .get("data_base64")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let resp = match crate::decode_base64_payload(data_b64) {
                                        Ok(bytes) if !bytes.is_empty() => {
                                            match state
                                                .save_attachment_bytes(&bytes, filename, mime_type)
                                                .await
                                            {
                                                Ok((saved_name, dest_path)) => json!({
                                                    "type": "attachment_uploaded",
                                                    "upload_id": upload_id,
                                                    "ok": true,
                                                    "filename": saved_name,
                                                    "path": dest_path.to_string_lossy().to_string(),
                                                    "url": format!("/api/attachments/{}", saved_name),
                                                }),
                                                Err(err) => json!({
                                                    "type": "attachment_uploaded",
                                                    "upload_id": upload_id,
                                                    "ok": false,
                                                    "error": err,
                                                }),
                                            }
                                        }
                                        _ => json!({
                                            "type": "attachment_uploaded",
                                            "upload_id": upload_id,
                                            "ok": false,
                                            "error": "Invalid attachment payload",
                                        }),
                                    };
                                    if let Some(frame_txt) =
                                        send_sealed_with_key(&resp, &active_key_hex, &mut out_nonce)
                                    {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }
                                }
                                "upload_attachment_begin" => {
                                    let upload_id = cmd_val
                                        .get("upload_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let total_chunks = cmd_val
                                        .get("total_chunks")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0) as usize;
                                    if !upload_id.is_empty() && (1..=80).contains(&total_chunks) {
                                        if pending_uploads.len() >= 16 {
                                            pending_uploads.clear();
                                        }
                                        pending_uploads.insert(
                                            upload_id,
                                            PendingE2EEUpload {
                                                filename: cmd_val
                                                    .get("filename")
                                                    .and_then(|v| v.as_str())
                                                    .map(str::to_string),
                                                mime_type: cmd_val
                                                    .get("mime_type")
                                                    .and_then(|v| v.as_str())
                                                    .map(str::to_string),
                                                chunks: vec![None; total_chunks],
                                                total_bytes: 0,
                                            },
                                        );
                                    }
                                }
                                "upload_attachment_chunk" => {
                                    let upload_id = cmd_val
                                        .get("upload_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let idx = cmd_val
                                        .get("chunk_index")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0) as usize;
                                    let data_b64 = cmd_val
                                        .get("data_base64")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    if let Some(entry) = pending_uploads.get_mut(upload_id) {
                                        if idx < entry.chunks.len() {
                                            if let Ok(bytes) =
                                                crate::decode_base64_payload(data_b64)
                                            {
                                                if entry.total_bytes + bytes.len()
                                                    <= 12 * 1024 * 1024
                                                {
                                                    entry.total_bytes += bytes.len();
                                                    entry.chunks[idx] = Some(bytes);
                                                }
                                            }
                                        }
                                    }
                                }
                                "upload_attachment_complete" => {
                                    let upload_id = cmd_val
                                        .get("upload_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let resp = if let Some(entry) =
                                        pending_uploads.remove(&upload_id)
                                    {
                                        if entry.chunks.iter().all(|c| c.is_some()) {
                                            let mut full = Vec::with_capacity(entry.total_bytes);
                                            for part in entry.chunks.into_iter().flatten() {
                                                full.extend_from_slice(&part);
                                            }
                                            match state
                                                .save_attachment_bytes(
                                                    &full,
                                                    entry.filename.as_deref(),
                                                    entry.mime_type.as_deref(),
                                                )
                                                .await
                                            {
                                                Ok((saved_name, dest_path)) => json!({
                                                    "type": "attachment_uploaded",
                                                    "upload_id": upload_id,
                                                    "ok": true,
                                                    "filename": saved_name,
                                                    "path": dest_path.to_string_lossy().to_string(),
                                                    "url": format!("/api/attachments/{}", saved_name),
                                                }),
                                                Err(err) => json!({
                                                    "type": "attachment_uploaded",
                                                    "upload_id": upload_id,
                                                    "ok": false,
                                                    "error": err,
                                                }),
                                            }
                                        } else {
                                            json!({
                                                "type": "attachment_uploaded",
                                                "upload_id": upload_id,
                                                "ok": false,
                                                "error": "Missing attachment chunks",
                                            })
                                        }
                                    } else {
                                        json!({
                                            "type": "attachment_uploaded",
                                            "upload_id": upload_id,
                                            "ok": false,
                                            "error": "Upload session not found",
                                        })
                                    };
                                    if let Some(frame_txt) =
                                        send_sealed_with_key(&resp, &active_key_hex, &mut out_nonce)
                                    {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                BRIDGE_CONNECTED.store(false, Ordering::SeqCst);
            }
            Err(err) => {
                BRIDGE_CONNECTED.store(false, Ordering::SeqCst);
                warn!(
                    "Daemon E2EE bridge connect to {} failed ({}); retrying...",
                    cfg.connect_ws_url, err
                );
            }
        }

        // Wait 2s before reconnecting, or wake immediately if target config changed
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
            _ = cfg_rx.changed() => {}
        }
    }
}
