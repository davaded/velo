use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMsg};
use tracing::{info, warn};
use uuid::Uuid;
use velo_protocol::{SessionInfo, SessionInputRequest, WsServerMessage};
use velo_relay::{
    DEFAULT_RELAY_PORT, EncryptedRelayFrame, PairingTicket, build_encrypted_frame, open_payload,
    run_relay_server,
};

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
    let connect_base = if ticket.relay_url.contains(":6768") {
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
                            if let Ok(snap) = serde_json::to_value(WsServerMessage::SessionsSnapshot { sessions }) {
                                if let Some(frame_txt) = send_sealed(&snap, &mut out_nonce) {
                                    let _ = writer.send(WsMsg::Text(frame_txt.into())).await;
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
                                    let _ = state
                                        .dispatch_session_input(
                                            sid,
                                            SessionInputRequest {
                                                input: inp.to_string(),
                                                model: None,
                                                effort: None,
                                                provider: None,
                                                reset_thread: false,
                                                truncate_to_user_turn: None,
                                                images: Vec::new(),
                                                approval_mode: None,
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
                        _ => {}
                    }
                }
                else => break,
            }
        }
    });
}
