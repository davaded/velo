use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMsg};
use tracing::{info, warn};
use uuid::Uuid;
use velo_protocol::{
    AgentProvider, CreateSessionRequest, SessionInfo, SessionInputRequest, WsServerMessage,
};
use velo_relay::{
    DEFAULT_RELAY_PORT, EncryptedRelayFrame, PairingTicket, build_encrypted_frame, open_payload,
    run_relay_server,
};
use velo_worktree::WorktreeManager;

use crate::DaemonState;

static EMBEDDED_RELAY_STARTED: AtomicBool = AtomicBool::new(false);

pub async fn ensure_local_relay_running() {
    if EMBEDDED_RELAY_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let addr: SocketAddr = ([0, 0, 0, 0], DEFAULT_RELAY_PORT).into();
        tokio::spawn(async move {
            if let Err(err) = run_relay_server(addr).await {
                warn!("Embedded velo-relay bind note (may already be running): {}", err);
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    }
}

/// Spawns a background E2EE bridge connecting `velo-daemon` to `velo-relay` for `ticket`.
pub fn spawn_daemon_e2ee_bridge(state: DaemonState, ticket: PairingTicket) {
    let daemon_host = ticket
        .daemon_addr
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split(':')
        .next()
        .unwrap_or("127.0.0.1");
    let is_embedded_local = ticket.relay_url.contains(&format!(":{DEFAULT_RELAY_PORT}"))
        && (ticket.relay_url.contains("127.0.0.1")
            || ticket.relay_url.contains("localhost")
            || (!daemon_host.is_empty() && ticket.relay_url.contains(daemon_host)));
    let connect_base = if is_embedded_local {
        format!("ws://127.0.0.1:{}/room/{}", DEFAULT_RELAY_PORT, ticket.room_id)
    } else {
        format!("{}/room/{}", ticket.relay_url.trim_end_matches('/'), ticket.room_id)
    };
    let key_hex = ticket.shared_key_hex.clone();

    tokio::spawn(async move {
        let Ok((ws_stream, _)) = connect_async(&connect_base).await else {
            warn!("Daemon E2EE bridge could not connect to {}", connect_base);
            return;
        };
        info!(
            "Daemon E2EE Relay Bridge active on room {} (ChaCha20-Poly1305)",
            ticket.room_id
        );

        let (mut writer, mut reader) = ws_stream.split();
        let mut event_rx = state.event_tx.subscribe();
        let mut out_nonce: u64 = 1;

        // Helper to seal and send a JSON value
        let send_sealed = |val: &Value, nonce: &mut u64| -> Option<String> {
            let bytes = serde_json::to_vec(val).ok()?;
            let frame = build_encrypted_frame("daemon", &key_hex, *nonce, &bytes);
            *nonce += 1;
            serde_json::to_string(&frame).ok()
        };

        // Send initial encrypted snapshot
        {
            let guard = state.inner.read().await;
            let mut sessions: Vec<SessionInfo> = guard.sessions.values().cloned().collect();
            sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            let snap = serde_json::to_value(WsServerMessage::SessionsSnapshot { sessions })
                .unwrap_or_else(|_| json!({}));
            if let Some(frame_txt) = send_sealed(&snap, &mut out_nonce) {
                let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
            }
        }

        loop {
            tokio::select! {
                Ok(ev) = event_rx.recv() => {
                    if let Ok(val) = serde_json::to_value(WsServerMessage::Event { event: ev }) {
                        if let Some(frame_txt) = send_sealed(&val, &mut out_nonce) {
                            if writer.send(WsMsg::Text(frame_txt.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                Some(Ok(msg)) = reader.next() => {
                    let WsMsg::Text(raw_txt) = msg else { continue };
                    let Ok(frame) = serde_json::from_str::<EncryptedRelayFrame>(&raw_txt) else {
                        continue;
                    };
                    if frame.sender_id == "daemon" {
                        continue;
                    }
                    let Some(pt_bytes) = open_payload(&key_hex, frame.nonce, &frame.ciphertext_hex) else {
                        warn!("Rejected unauthenticated/tampered E2EE frame on room {}", ticket.room_id);
                        continue;
                    };
                    let Ok(cmd_val) = serde_json::from_slice::<Value>(&pt_bytes) else {
                        continue;
                    };
                    let cmd = cmd_val.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                    match cmd {
                        "sync" => {
                            let guard = state.inner.read().await;
                            let mut sessions: Vec<SessionInfo> = guard.sessions.values().cloned().collect();
                            sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                            let top_ids: Vec<Uuid> = sessions.iter().take(5).map(|s| s.id).collect();
                            if let Ok(snap) = serde_json::to_value(WsServerMessage::SessionsSnapshot { sessions }) {
                                if let Some(frame_txt) = send_sealed(&snap, &mut out_nonce) {
                                    let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                }
                            }
                            for sid in top_ids {
                                if let Some(evs) = guard.event_history.get(&sid) {
                                    let ev_snap = json!({
                                        "type": "events_snapshot",
                                        "session_id": sid,
                                        "events": evs,
                                    });
                                    if let Some(frame_txt) = send_sealed(&ev_snap, &mut out_nonce) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }
                                }
                            }
                        }
                        "get_events" => {
                            if let Some(sid_s) = cmd_val.get("session_id").and_then(|v| v.as_str()) {
                                if let Ok(sid) = Uuid::parse_str(sid_s) {
                                    let guard = state.inner.read().await;
                                    let evs = guard.event_history.get(&sid).cloned().unwrap_or_default();
                                    let ev_snap = json!({
                                        "type": "events_snapshot",
                                        "session_id": sid,
                                        "events": evs,
                                    });
                                    if let Some(frame_txt) = send_sealed(&ev_snap, &mut out_nonce) {
                                        let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                    }
                                }
                            }
                        }
                        "resolve_approval" => {
                            let req_id = cmd_val.get("request_id").and_then(|v| v.as_str()).unwrap_or("");
                            let decision = cmd_val.get("decision").and_then(|v| v.as_str()).unwrap_or("approve");
                            if let Some(sid_s) = cmd_val.get("session_id").and_then(|v| v.as_str()) {
                                if let Ok(sid) = Uuid::parse_str(sid_s) {
                                    state.resolve_permission(sid, req_id, decision).await;
                                }
                            }
                        }
                        "answer_question" => {
                            let q_id = cmd_val.get("question_id").and_then(|v| v.as_str()).unwrap_or("");
                            let answers: Vec<String> = cmd_val
                                .get("answers")
                                .and_then(|v| v.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                        .collect()
                                })
                                .unwrap_or_default();
                            if let Some(sid_s) = cmd_val.get("session_id").and_then(|v| v.as_str()) {
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
                                    let _ = state
                                        .dispatch_session_input(
                                            sid,
                                            SessionInputRequest {
                                                input: inp.to_string(),
                                                model,
                                                effort,
                                                provider,
                                                reset_thread: false,
                                                truncate_to_user_turn: None,
                                                images: Vec::new(),
                                                approval_mode,
                                            },
                                        )
                                        .await;
                                }
                            }
                        }
                        "stop_session" => {
                            if let Some(sid_s) = cmd_val.get("session_id").and_then(|v| v.as_str()) {
                                if let Ok(sid) = Uuid::parse_str(sid_s) {
                                    state.stop_session_by_id(sid).await;
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
                            if !prompt.is_empty() {
                                let fallback_repo = {
                                    let guard = state.inner.read().await;
                                    guard
                                        .sessions
                                        .values()
                                        .next()
                                        .map(|s| s.repo_root.clone())
                                        .unwrap_or_else(|| "/Users/daiyudai/code/velo".to_string())
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
                                    images: Vec::new(),
                                    approval_mode: cmd_val
                                        .get("approval_mode")
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string),
                                    setup_command: None,
                                };
                                if state.create_session(req).await.is_ok() {
                                    let guard = state.inner.read().await;
                                    let mut sessions: Vec<SessionInfo> =
                                        guard.sessions.values().cloned().collect();
                                    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                                    if let Ok(snap) = serde_json::to_value(
                                        WsServerMessage::SessionsSnapshot { sessions },
                                    ) {
                                        if let Some(frame_txt) = send_sealed(&snap, &mut out_nonce) {
                                            let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
                                        }
                                    }
                                }
                            }
                        }
                        "get_diff" => {
                            if let Some(sid_s) = cmd_val.get("session_id").and_then(|v| v.as_str()) {
                                if let Ok(sid) = Uuid::parse_str(sid_s) {
                                    let wt_opt = {
                                        let guard = state.inner.read().await;
                                        guard.sessions.get(&sid).map(|s| s.worktree_path.clone())
                                    };
                                    if let Some(wt_str) = wt_opt {
                                        let wt_path = Path::new(&wt_str);
                                        let stats = WorktreeManager::compute_diff_stats(wt_path)
                                            .await
                                            .unwrap_or_default();
                                        let diff = WorktreeManager::get_unified_diff(wt_path)
                                            .await
                                            .unwrap_or_default();
                                        let diff_snap = json!({
                                            "type": "diff_snapshot",
                                            "session_id": sid,
                                            "stats": stats,
                                            "diff": diff,
                                        });
                                        if let Some(frame_txt) =
                                            send_sealed(&diff_snap, &mut out_nonce)
                                        {
                                            let _ =
                                                writer.send(WsMsg::Text(frame_txt.into())).await;
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                else => break,
            }
        }
    });
}
