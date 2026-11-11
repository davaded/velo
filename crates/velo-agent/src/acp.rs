use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, warn};
use uuid::Uuid;
use velo_protocol::{AgentEvent, SessionStatus};

use crate::{AgentHandle, discover_augmented_path, resolve_cli_binary};

/// Spawns an ACP (Agent Client Protocol) JSON-RPC 2.0 over stdio agent subprocess.
/// Supports `initialize` -> `session/new` / `session/load` -> `session/prompt`,
/// streaming `session/update` notifications, `fs/*` workspace callbacks,
/// and bidirectional `session/request_permission` routed through `velo-daemon`.
#[allow(clippy::too_many_arguments)]
pub async fn spawn_acp_agent(
    session_id: Uuid,
    acp_command_spec: &str,
    prompt: String,
    worktree_path: PathBuf,
    resume_session_id: Option<String>,
    images: Vec<String>,
    daemon_http_base: Option<String>,
    event_tx: broadcast::Sender<AgentEvent>,
) -> Result<AgentHandle> {
    let aug_path = discover_augmented_path();
    let parts: Vec<&str> = acp_command_spec.split_whitespace().collect();
    let (bin_raw, extra_args) = parts
        .split_first()
        .map(|(b, rest)| (*b, rest.to_vec()))
        .unwrap_or(("opencode", vec!["acp"]));

    let bin_path = resolve_cli_binary(bin_raw).unwrap_or_else(|| PathBuf::from(bin_raw));
    let mut cmd = Command::new(bin_path);
    for arg in extra_args {
        cmd.arg(arg);
    }
    cmd.env("PATH", &aug_path)
        .current_dir(&worktree_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .with_context(|| format!("Failed to spawn ACP agent `{}`", acp_command_spec))?;
    let pid = child.id();
    let mut stdin = child.stdin.take().context("ACP child missing stdin")?;
    let stdout = child.stdout.take().context("ACP child missing stdout")?;
    let stderr = child.stderr.take().context("ACP child missing stderr")?;

    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();
    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

    let _ = event_tx.send(AgentEvent::StatusChanged {
        session_id,
        status: SessionStatus::Running,
        message: Some(format!(
            "ACP agent `{}` started (PID {:?})",
            acp_command_spec, pid
        )),
        timestamp: Utc::now(),
    });

    // Forward stderr diagnostics
    let tx_err = event_tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let t = line.trim();
            if !t.is_empty() {
                debug!("[acp:{}] stderr: {}", session_id, t);
                if t.to_lowercase().contains("error:") || t.to_lowercase().contains("fatal:") {
                    let _ = tx_err.send(AgentEvent::Error {
                        session_id,
                        error: t.to_string(),
                        timestamp: Utc::now(),
                    });
                }
            }
        }
    });

    let wt_clone = worktree_path.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();

        // Helper to write a JSON-RPC line to ACP stdin
        async fn send_rpc(stdin: &mut tokio::process::ChildStdin, payload: &Value) -> Result<()> {
            let mut line = serde_json::to_string(payload)?;
            line.push('\n');
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
            Ok(())
        }

        // 1. ACP `initialize`
        let init_req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": { "name": "velo", "version": "0.1.0" },
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": true
                }
            }
        });
        if let Err(err) = send_rpc(&mut stdin, &init_req).await {
            let _ = event_tx.send(AgentEvent::Error {
                session_id,
                error: format!("ACP initialize write failed: {}", err),
                timestamp: Utc::now(),
            });
            return;
        }

        let mut acp_session_id: Option<String> = resume_session_id.clone();
        let mut prompt_dispatched = false;
        let mut accumulated_text = String::new();

        let mcp_servers = if let Some(base) = &daemon_http_base {
            json!([{
                "name": "velo",
                "type": "http",
                "url": format!("{}/mcp?session_id={}", base.trim_end_matches('/'), session_id)
            }])
        } else {
            json!([])
        };

        loop {
            tokio::select! {
                _ = &mut kill_rx => {
                    let _ = child.kill().await;
                    let _ = event_tx.send(AgentEvent::StatusChanged {
                        session_id,
                        status: SessionStatus::Stopped,
                        message: Some("ACP agent stopped by user".to_string()),
                        timestamp: Utc::now(),
                    });
                    return;
                }
                Some(extra_in) = input_rx.recv() => {
                    let _ = stdin.write_all(extra_in.as_bytes()).await;
                    let _ = stdin.flush().await;
                }
                line_res = reader.next_line() => {
                    let line = match line_res {
                        Ok(Some(l)) => l,
                        _ => break,
                    };
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                        let _ = event_tx.send(AgentEvent::MessageDelta {
                            session_id,
                            text: trimmed.to_string(),
                            timestamp: Utc::now(),
                        });
                        continue;
                    };

                    // Response to `initialize` (id == 1)
                    if msg.get("id") == Some(&json!(1)) && msg.get("result").is_some() {
                        let req_msg = if let Some(existing) = &acp_session_id {
                            json!({
                                "jsonrpc": "2.0",
                                "id": 2,
                                "method": "session/load",
                                "params": {
                                    "sessionId": existing,
                                    "cwd": wt_clone.to_string_lossy(),
                                    "mcpServers": mcp_servers
                                }
                            })
                        } else {
                            json!({
                                "jsonrpc": "2.0",
                                "id": 2,
                                "method": "session/new",
                                "params": {
                                    "cwd": wt_clone.to_string_lossy(),
                                    "mcpServers": mcp_servers
                                }
                            })
                        };
                        let _ = send_rpc(&mut stdin, &req_msg).await;
                        continue;
                    }

                    // Response to `session/new` or `session/load` (id == 2)
                    if msg.get("id") == Some(&json!(2)) && !prompt_dispatched {
                        if let Some(sid_str) = msg
                            .pointer("/result/sessionId")
                            .and_then(|v| v.as_str())
                        {
                            acp_session_id = Some(sid_str.to_string());
                            let _ = event_tx.send(AgentEvent::ProviderSessionBound {
                                session_id,
                                provider_session_id: sid_str.to_string(),
                                timestamp: Utc::now(),
                            });
                        }
                        let sid_val = acp_session_id
                            .clone()
                            .unwrap_or_else(|| session_id.to_string());
                        let mut blocks = vec![json!({ "type": "text", "text": prompt })];
                        for img in &images {
                            blocks.push(json!({
                                "type": "text",
                                "text": format!("[Attached image path: {}]", img)
                            }));
                        }
                        let prompt_req = json!({
                            "jsonrpc": "2.0",
                            "id": 3,
                            "method": "session/prompt",
                            "params": {
                                "sessionId": sid_val,
                                "prompt": blocks
                            }
                        });
                        prompt_dispatched = true;
                        let _ = send_rpc(&mut stdin, &prompt_req).await;
                        continue;
                    }

                    // Response to `session/prompt` (id == 3) -> turn complete!
                    if msg.get("id") == Some(&json!(3)) {
                        if !accumulated_text.trim().is_empty() {
                            let _ = event_tx.send(AgentEvent::MessageDelta {
                                session_id,
                                text: accumulated_text.clone(),
                                timestamp: Utc::now(),
                            });
                        }
                        if let Some(err_msg) = msg.pointer("/error/message").and_then(|v| v.as_str()) {
                            let _ = event_tx.send(AgentEvent::Error {
                                session_id,
                                error: err_msg.to_string(),
                                timestamp: Utc::now(),
                            });
                            let _ = event_tx.send(AgentEvent::StatusChanged {
                                session_id,
                                status: SessionStatus::Failed,
                                message: Some(err_msg.to_string()),
                                timestamp: Utc::now(),
                            });
                        } else {
                            let _ = event_tx.send(AgentEvent::StatusChanged {
                                session_id,
                                status: SessionStatus::Completed,
                                message: Some("ACP turn completed".to_string()),
                                timestamp: Utc::now(),
                            });
                        }
                        let _ = child.kill().await;
                        return;
                    }

                    // Handle ACP notifications & server->client RPCs
                    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                    match method {
                        "session/update" => {
                            if let Some(upd) = msg.pointer("/params/update") {
                                handle_acp_session_update(
                                    session_id,
                                    upd,
                                    &mut accumulated_text,
                                    &event_tx,
                                );
                            }
                        }
                        "session/request_permission" => {
                            let rpc_id = msg.get("id").cloned().unwrap_or(Value::Null);
                            let tool_title = msg
                                .pointer("/params/toolCall/title")
                                .or_else(|| msg.pointer("/params/toolCall/kind"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("ACP Tool");
                            let raw_cmd = msg
                                .pointer("/params/toolCall/rawInput")
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| tool_title.to_string());
                            let options = msg
                                .pointer("/params/options")
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();

                            let allowed = request_daemon_approval(
                                daemon_http_base.as_deref(),
                                session_id,
                                tool_title,
                                &raw_cmd,
                            )
                            .await;

                            let chosen_opt = options
                                .iter()
                                .find(|o| {
                                    let kind = o.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                                    if allowed {
                                        kind.contains("allow")
                                    } else {
                                        kind.contains("reject") || kind.contains("deny")
                                    }
                                })
                                .and_then(|o| o.get("optionId").and_then(|v| v.as_str()))
                                .unwrap_or(if allowed { "allow" } else { "reject" });

                            let reply = json!({
                                "jsonrpc": "2.0",
                                "id": rpc_id,
                                "result": {
                                    "outcome": {
                                        "outcome": "selected",
                                        "optionId": chosen_opt
                                    }
                                }
                            });
                            let _ = send_rpc(&mut stdin, &reply).await;
                        }
                        "fs/read_text_file" => {
                            let rpc_id = msg.get("id").cloned().unwrap_or(Value::Null);
                            let path_str = msg
                                .pointer("/params/path")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let resolved = resolve_in_worktree(&wt_clone, path_str);
                            let reply = match tokio::fs::read_to_string(&resolved).await {
                                Ok(content) => json!({
                                    "jsonrpc": "2.0",
                                    "id": rpc_id,
                                    "result": { "content": content }
                                }),
                                Err(err) => json!({
                                    "jsonrpc": "2.0",
                                    "id": rpc_id,
                                    "error": { "code": -32001, "message": err.to_string() }
                                }),
                            };
                            let _ = send_rpc(&mut stdin, &reply).await;
                        }
                        "fs/write_text_file" => {
                            let rpc_id = msg.get("id").cloned().unwrap_or(Value::Null);
                            let path_str = msg
                                .pointer("/params/path")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let content = msg
                                .pointer("/params/content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let resolved = resolve_in_worktree(&wt_clone, path_str);
                            if let Some(parent) = resolved.parent() {
                                let _ = tokio::fs::create_dir_all(parent).await;
                            }
                            let reply = match tokio::fs::write(&resolved, content).await {
                                Ok(()) => json!({
                                    "jsonrpc": "2.0",
                                    "id": rpc_id,
                                    "result": null
                                }),
                                Err(err) => json!({
                                    "jsonrpc": "2.0",
                                    "id": rpc_id,
                                    "error": { "code": -32002, "message": err.to_string() }
                                }),
                            };
                            let _ = send_rpc(&mut stdin, &reply).await;
                        }
                        _ => {}
                    }
                }
            }
        }

        let status = child.wait().await;
        let ok = status.map(|s| s.success()).unwrap_or(false);
        if ok && !accumulated_text.trim().is_empty() {
            let _ = event_tx.send(AgentEvent::MessageDelta {
                session_id,
                text: accumulated_text,
                timestamp: Utc::now(),
            });
        }
        let _ = event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: if ok {
                SessionStatus::Completed
            } else {
                SessionStatus::Failed
            },
            message: Some("ACP process exited".to_string()),
            timestamp: Utc::now(),
        });
    });

    Ok(AgentHandle {
        session_id,
        pid,
        input_tx,
        kill_tx: Some(kill_tx),
    })
}

fn resolve_in_worktree(worktree: &Path, path_str: &str) -> PathBuf {
    let p = Path::new(path_str);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        worktree.join(p)
    }
}

fn handle_acp_session_update(
    session_id: Uuid,
    upd: &Value,
    accumulated_text: &mut String,
    event_tx: &broadcast::Sender<AgentEvent>,
) {
    let kind = upd
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match kind {
        "agent_thought_chunk" => {
            if let Some(text) = upd.pointer("/content/text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    let _ = event_tx.send(AgentEvent::ThinkingDelta {
                        session_id,
                        text: text.to_string(),
                        timestamp: Utc::now(),
                    });
                }
            }
        }
        "agent_message_chunk" => {
            if let Some(delta) = upd.pointer("/content/text").and_then(|v| v.as_str()) {
                if !delta.is_empty() {
                    accumulated_text.push_str(delta);
                    let _ = event_tx.send(AgentEvent::MessageChunk {
                        session_id,
                        delta: delta.to_string(),
                        timestamp: Utc::now(),
                    });
                }
            }
        }
        "tool_call" => {
            let tool_id = upd
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("acp-tool")
                .to_string();
            let title = upd
                .get("title")
                .or_else(|| upd.get("kind"))
                .and_then(|v| v.as_str())
                .unwrap_or("Tool")
                .to_string();
            let args = upd.get("rawInput").cloned().unwrap_or_else(|| json!({}));
            let _ = event_tx.send(AgentEvent::ToolCallRequested {
                session_id,
                tool_id,
                tool_name: title,
                arguments: args,
                timestamp: Utc::now(),
            });
        }
        "tool_call_update" => {
            let status = upd.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if status == "completed" || status == "failed" {
                let tool_id = upd
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("acp-tool")
                    .to_string();
                let output = upd
                    .get("rawOutput")
                    .map(|v| {
                        if let Some(s) = v.as_str() {
                            s.to_string()
                        } else {
                            v.to_string()
                        }
                    })
                    .unwrap_or_default();
                let _ = event_tx.send(AgentEvent::ToolCallCompleted {
                    session_id,
                    tool_id,
                    output,
                    is_error: status == "failed",
                    timestamp: Utc::now(),
                });
            }
        }
        _ => {}
    }
}

async fn request_daemon_approval(
    daemon_http_base: Option<&str>,
    session_id: Uuid,
    tool_name: &str,
    command_preview: &str,
) -> bool {
    let Some(base) = daemon_http_base else {
        return true;
    };
    let url = format!(
        "{}/api/sessions/{}/hooks/pre-tool-use",
        base.trim_end_matches('/'),
        session_id
    );
    let body = json!({
        "tool_name": tool_name,
        "tool_input": { "command": command_preview }
    })
    .to_string();

    let out = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "600",
            "-X",
            "POST",
            &url,
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            &body,
        ])
        .output()
        .await;

    match out {
        Ok(res) if res.status.success() => {
            let s = String::from_utf8_lossy(&res.stdout);
            if let Ok(val) = serde_json::from_str::<Value>(&s) {
                let decision = val
                    .pointer("/hookSpecificOutput/permissionDecision")
                    .and_then(|v| v.as_str())
                    .unwrap_or("allow");
                decision != "deny"
            } else {
                true
            }
        }
        Err(err) => {
            warn!("ACP daemon approval fallback allow due to error: {}", err);
            true
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_acp_jsonrpc_stdio_lifecycle() -> Result<()> {
        let temp_dir = std::env::temp_dir().join(format!("velo-acp-test-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await?;
        let mock_script = temp_dir.join("mock_acp.py");
        tokio::fs::write(
            &mock_script,
            r#"import sys, json
for line in sys.stdin:
    req = json.loads(line)
    rid = req.get("id")
    m = req.get("method")
    if m == "initialize":
        print(json.dumps({"jsonrpc":"2.0","id":rid,"result":{"protocolVersion":1}}), flush=True)
    elif m == "session/new":
        print(json.dumps({"jsonrpc":"2.0","id":rid,"result":{"sessionId":"acp-sess-99"}}), flush=True)
    elif m == "session/prompt":
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-sess-99","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Analyzing via ACP..."}}}}), flush=True)
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-sess-99","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello from ACP!"}}}}), flush=True)
        print(json.dumps({"jsonrpc":"2.0","id":rid,"result":{"stopReason":"end_turn"}}), flush=True)
        break
"#,
        )
        .await?;

        let (tx, mut rx) = broadcast::channel(64);
        let sid = Uuid::new_v4();
        let spec = format!("python3 {}", mock_script.display());
        let _handle = spawn_acp_agent(
            sid,
            &spec,
            "Test ACP".to_string(),
            temp_dir.clone(),
            None,
            vec![],
            None,
            tx,
        )
        .await?;

        let mut got_bound = false;
        let mut got_thought = false;
        let mut got_message = false;
        while let Ok(ev) = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
            let Ok(ev) = ev else { break };
            match ev {
                AgentEvent::ProviderSessionBound { provider_session_id, .. } => {
                    assert_eq!(provider_session_id, "acp-sess-99");
                    got_bound = true;
                }
                AgentEvent::ThinkingDelta { text, .. } if text.contains("Analyzing via ACP") => {
                    got_thought = true;
                }
                AgentEvent::MessageDelta { text, .. } if text.contains("Hello from ACP!") => {
                    got_message = true;
                }
                AgentEvent::StatusChanged {
                    status: SessionStatus::Completed,
                    ..
                } => break,
                _ => {}
            }
        }
        assert!(got_bound && got_thought && got_message);
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        Ok(())
    }
}
