use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, info};
use uuid::Uuid;
use velo_protocol::{AgentEvent, SessionStatus};

use crate::{
    AgentHandle, acp::request_daemon_approval, apply_proxy_env_tokio, discover_augmented_path,
    is_cli_auth_error_text, resolve_cli_binary,
};

/// Spawns `codex app-server` over JSON-RPC 2.0 stdio (the native protocol used by Codex Desktop & Paseo).
/// Streams real-time token-by-token `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`,
/// live tool execution events, bidirectional approval callbacks, and instant `turn/completed` finalization.
#[allow(clippy::too_many_arguments)]
pub async fn spawn_codex_app_server(
    session_id: Uuid,
    prompt: String,
    worktree_path: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    resume_session_id: Option<String>,
    images: Vec<String>,
    approval_mode: String,
    daemon_http_base: Option<String>,
    event_tx: broadcast::Sender<AgentEvent>,
) -> Result<AgentHandle> {
    let aug_path = discover_augmented_path();
    let bin_path = resolve_cli_binary("codex").unwrap_or_else(|| PathBuf::from("codex"));
    let mut cmd = Command::new(&bin_path);
    cmd.arg("app-server");

    if let Some(base) = daemon_http_base.as_deref().filter(|b| !b.trim().is_empty()) {
        let mcp_toml = format!(
            "mcp_servers={{velo={{url=\"{}/mcp?session_id={}\"}}}}",
            base.trim_end_matches('/'),
            session_id
        );
        cmd.args(["-c", &mcp_toml]);
    }

    cmd.env("PATH", &aug_path)
        .current_dir(&worktree_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_proxy_env_tokio(&mut cmd);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .context("Failed to spawn `codex app-server`. Ensure Codex CLI is installed.")?;
    let pid = child.id();
    info!(
        "Spawned codex app-server (session={}, pid={:?}) in {}",
        session_id,
        pid,
        worktree_path.display()
    );

    let mut stdin = child
        .stdin
        .take()
        .context("codex app-server missing stdin")?;
    let stdout = child
        .stdout
        .take()
        .context("codex app-server missing stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("codex app-server missing stderr")?;

    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();
    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
    let alive_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let loop_alive = std::sync::Arc::clone(&alive_flag);

    let _ = event_tx.send(AgentEvent::StatusChanged {
        session_id,
        status: SessionStatus::Running,
        message: Some(format!("Agent `codex` started (PID {:?})", pid)),
        timestamp: Utc::now(),
    });

    // Drain stderr cleanly for debug logging and surface any Codex auth failures immediately
    let tx_stderr = event_tx.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut sent_auth = false;
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                debug!("[codex-app-server:{}] stderr: {}", session_id, trimmed);
                if !sent_auth && is_cli_auth_error_text(trimmed) {
                    sent_auth = true;
                    let _ = tx_stderr.send(AgentEvent::Error {
                        session_id,
                        error: format!(
                            "[AUTH_REQUIRED|codex|codex login|] OpenAI Codex CLI 需要重新登录认证：{}",
                            trimmed
                        ),
                        timestamp: Utc::now(),
                    });
                }
            }
        }
    });

    let cwd_str = worktree_path.to_string_lossy().to_string();
    let approval_policy = if approval_mode == "ask_before_edit" {
        "untrusted"
    } else {
        "never"
    };
    let sandbox_mode = if approval_mode == "bypass" {
        "danger-full-access"
    } else {
        "workspace-write"
    };
    let clean_model = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let normalized_effort = match effort.as_deref().map(str::trim).unwrap_or("medium") {
        "max" => "xhigh".to_string(),
        "low" | "medium" | "high" | "xhigh" => {
            effort.as_deref().unwrap_or("medium").trim().to_string()
        }
        _ => "medium".to_string(),
    };

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();

        async fn send_rpc(stdin: &mut tokio::process::ChildStdin, payload: &Value) -> Result<()> {
            let mut line = serde_json::to_string(payload)?;
            line.push('\n');
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
            Ok(())
        }

        async fn terminate_process_group(pid: Option<u32>, child: &mut tokio::process::Child) {
            #[cfg(unix)]
            if let Some(p) = pid {
                let _ = Command::new("kill")
                    .args(["-9", &format!("-{}", p)])
                    .status()
                    .await;
            }
            let _ = child.kill().await;
        }

        // 1. JSON-RPC `initialize`
        let init_req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "velo",
                    "title": "Velo",
                    "version": "0.1.0"
                },
                "capabilities": null
            }
        });
        if let Err(err) = send_rpc(&mut stdin, &init_req).await {
            let _ = event_tx.send(AgentEvent::Error {
                session_id,
                error: format!("Codex app-server initialize failed: {}", err),
                timestamp: Utc::now(),
            });
            let _ = event_tx.send(AgentEvent::StatusChanged {
                session_id,
                status: SessionStatus::Failed,
                message: Some(err.to_string()),
                timestamp: Utc::now(),
            });
            stderr_task.abort();
            terminate_process_group(pid, &mut child).await;
            return;
        }

        let mut accumulated_reasoning = String::new();
        let mut accumulated_message = String::new();
        let mut emitted_final_message = false;

        let build_turn_start = |rpc_id: i64,
                                thread_id: &str,
                                turn_prompt: &str,
                                turn_imgs: &[String],
                                turn_model: Option<&str>,
                                turn_eff: &str|
         -> Value {
            let mut input_items = vec![json!({
                "type": "text",
                "text": turn_prompt,
                "text_elements": []
            })];
            for img in turn_imgs {
                let trimmed = img.trim();
                if !trimmed.is_empty() {
                    input_items.push(json!({
                        "type": "localImage",
                        "path": trimmed
                    }));
                }
            }
            let mut params = json!({
                "threadId": thread_id,
                "input": input_items,
                "cwd": cwd_str,
                "approvalPolicy": approval_policy,
                "effort": turn_eff,
                "summary": "detailed"
            });
            if let Some(m) = turn_model.filter(|s| !s.trim().is_empty()) {
                params["model"] = json!(m);
            }
            json!({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "method": "turn/start",
                "params": params
            })
        };

        let build_thread_start = || -> Value {
            let mut params = json!({
                "cwd": cwd_str,
                "approvalPolicy": approval_policy,
                "sandbox": sandbox_mode
            });
            if let Some(ref m) = clean_model {
                params["model"] = json!(m);
            }
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "thread/start",
                "params": params
            })
        };

        let mut saw_turn_activity = false;
        let mut bound_thread_id: Option<String> = None;
        let mut turn_rpc_seq: i64 = 4;
        let mut is_idle_warm = false;
        let mut last_thread_total: Option<(u64, u64, u64)> = None;
        let mut last_step_snapshot: Option<(u64, u64, u64)> = None;

        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(900)), if is_idle_warm => {
                    debug!("Reaping idle warm codex app-server session {}", session_id);
                    stderr_task.abort();
                    terminate_process_group(pid, &mut child).await;
                    return;
                }
                _ = &mut kill_rx => {
                    info!("Stopping codex app-server session {} (pid={:?})", session_id, pid);
                    stderr_task.abort();
                    terminate_process_group(pid, &mut child).await;
                    let _ = event_tx.send(AgentEvent::StatusChanged {
                        session_id,
                        status: SessionStatus::Stopped,
                        message: Some("Session stopped by user".to_string()),
                        timestamp: Utc::now(),
                    });
                    return;
                }
                Some(extra_in) = input_rx.recv() => {
                    if let Ok(warm_cmd) = serde_json::from_str::<Value>(extra_in.trim()) {
                        if warm_cmd.get("__velo_warm_turn").and_then(|v| v.as_bool()) == Some(true) {
                            if let Some(ref tid) = bound_thread_id {
                                let w_prompt = warm_cmd.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                                let w_imgs: Vec<String> = warm_cmd
                                    .get("images")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                                    .unwrap_or_default();
                                let w_model = warm_cmd
                                    .get("model")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.is_empty())
                                    .or(clean_model.as_deref());
                                let w_eff = warm_cmd
                                    .get("effort")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or(&normalized_effort);
                                is_idle_warm = false;
                                accumulated_reasoning.clear();
                                accumulated_message.clear();
                                emitted_final_message = false;
                                turn_rpc_seq += 1;
                                let _ = event_tx.send(AgentEvent::StatusChanged {
                                    session_id,
                                    status: SessionStatus::Running,
                                    message: Some("Agent `codex` hot turn resumed (0ms)".to_string()),
                                    timestamp: Utc::now(),
                                });
                                let req_val = build_turn_start(
                                    turn_rpc_seq,
                                    tid,
                                    w_prompt,
                                    &w_imgs,
                                    w_model,
                                    w_eff,
                                );
                                let _ = send_rpc(&mut stdin, &req_val).await;
                            }
                            continue;
                        }
                    }
                    let _ = stdin.write_all(extra_in.as_bytes()).await;
                    let _ = stdin.flush().await;
                }
                line_res = reader.next_line() => {
                    let line = match line_res {
                        Ok(Some(l)) => l,
                        _ => break,
                    };
                    let trimmed = line.trim();
                    if !trimmed.starts_with('{') {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };

                    // A. Responses to our client requests (id = 1, 2, 3, 4)
                    if let Some(id_num) = msg.get("id").and_then(|v| v.as_i64()) {
                        if msg.get("method").is_none() {
                            match id_num {
                                1 => {
                                    // `initialize` succeeded -> send `initialized` + `thread/resume` or `thread/start`
                                    let _ = send_rpc(&mut stdin, &json!({
                                        "jsonrpc": "2.0",
                                        "method": "initialized"
                                    })).await;

                                    if let Some(tid) = resume_session_id
                                        .as_deref()
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                    {
                                        let mut params = json!({
                                            "threadId": tid,
                                            "cwd": cwd_str,
                                            "approvalPolicy": approval_policy,
                                            "sandbox": sandbox_mode,
                                            "excludeTurns": true
                                        });
                                        if let Some(ref m) = clean_model {
                                            params["model"] = json!(m);
                                        }
                                        let _ = send_rpc(&mut stdin, &json!({
                                            "jsonrpc": "2.0",
                                            "id": 2,
                                            "method": "thread/resume",
                                            "params": params
                                        })).await;
                                    } else {
                                        let _ = send_rpc(&mut stdin, &build_thread_start()).await;
                                    }
                                }
                                2 => {
                                    // `thread/resume` response -> fallback to `thread/start` if stale
                                    if msg.get("error").is_some() {
                                        let _ = send_rpc(&mut stdin, &build_thread_start()).await;
                                    } else if let Some(tid) = msg
                                        .pointer("/result/thread/id")
                                        .and_then(|v| v.as_str())
                                    {
                                        bound_thread_id = Some(tid.to_string());
                                        let _ = event_tx.send(AgentEvent::ProviderSessionBound {
                                            session_id,
                                            provider_session_id: tid.to_string(),
                                            timestamp: Utc::now(),
                                        });
                                        let _ = send_rpc(
                                            &mut stdin,
                                            &build_turn_start(
                                                turn_rpc_seq,
                                                tid,
                                                &prompt,
                                                &images,
                                                clean_model.as_deref(),
                                                &normalized_effort,
                                            ),
                                        )
                                        .await;
                                    }
                                }
                                3 => {
                                    // `thread/start` response
                                    if let Some(err_msg) = msg
                                        .pointer("/error/message")
                                        .and_then(|v| v.as_str())
                                    {
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
                                        stderr_task.abort();
                                        terminate_process_group(pid, &mut child).await;
                                        return;
                                    }
                                    if let Some(tid) = msg
                                        .pointer("/result/thread/id")
                                        .and_then(|v| v.as_str())
                                    {
                                        bound_thread_id = Some(tid.to_string());
                                        let _ = event_tx.send(AgentEvent::ProviderSessionBound {
                                            session_id,
                                            provider_session_id: tid.to_string(),
                                            timestamp: Utc::now(),
                                        });
                                        let _ = send_rpc(
                                            &mut stdin,
                                            &build_turn_start(
                                                turn_rpc_seq,
                                                tid,
                                                &prompt,
                                                &images,
                                                clean_model.as_deref(),
                                                &normalized_effort,
                                            ),
                                        )
                                        .await;
                                    }
                                }
                                id_n if id_n >= 4 => {
                                    // `turn/start` response error check
                                    if let Some(err_msg) = msg
                                        .pointer("/error/message")
                                        .and_then(|v| v.as_str())
                                    {
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
                                        stderr_task.abort();
                                        terminate_process_group(pid, &mut child).await;
                                        return;
                                    }
                                }
                                _ => {}
                            }
                            continue;
                        }
                    }

                    // B. Server notifications & Server->Client requests
                    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                    match method {
                        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                            saw_turn_activity = true;
                            if let Some(delta) = msg.pointer("/params/delta").and_then(|v| v.as_str()) {
                                if !delta.is_empty() {
                                    accumulated_reasoning.push_str(delta);
                                    let _ = event_tx.send(AgentEvent::ThinkingChunk {
                                        session_id,
                                        delta: delta.to_string(),
                                        replace: false,
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                        }
                        "item/reasoning/summaryPartAdded" => {
                            saw_turn_activity = true;
                            if !accumulated_reasoning.is_empty() && !accumulated_reasoning.ends_with('\n') {
                                accumulated_reasoning.push('\n');
                                let _ = event_tx.send(AgentEvent::ThinkingChunk {
                                    session_id,
                                    delta: "\n".to_string(),
                                    replace: false,
                                    timestamp: Utc::now(),
                                });
                            }
                        }
                        "item/agentMessage/delta" => {
                            saw_turn_activity = true;
                            if let Some(delta) = msg.pointer("/params/delta").and_then(|v| v.as_str()) {
                                if !delta.is_empty() {
                                    accumulated_message.push_str(delta);
                                    let _ = event_tx.send(AgentEvent::MessageChunk {
                                        session_id,
                                        delta: delta.to_string(),
                                        replace: false,
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                        }
                        "item/started" => {
                            saw_turn_activity = true;
                            if let Some(item) = msg.pointer("/params/item") {
                                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                match item_type {
                                    "reasoning" => {
                                        accumulated_reasoning.clear();
                                        let _ = event_tx.send(AgentEvent::ThinkingChunk {
                                            session_id,
                                            delta: String::new(),
                                            replace: false,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    "agentMessage" => {
                                        accumulated_message.clear();
                                        emitted_final_message = false;
                                    }
                                    "commandExecution" => {
                                        let tool_id = item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("cmd")
                                            .to_string();
                                        let cmd_str = item
                                            .get("command")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let _ = event_tx.send(AgentEvent::ToolCallRequested {
                                            session_id,
                                            tool_id,
                                            tool_name: "Bash".to_string(),
                                            arguments: json!({ "command": cmd_str }),
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    "fileChange" => {
                                        let tool_id = item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("edit")
                                            .to_string();
                                        let changes = item
                                            .get("changes")
                                            .cloned()
                                            .unwrap_or_else(|| json!([]));
                                        let first_path = changes
                                            .as_array()
                                            .and_then(|arr| arr.first())
                                            .and_then(|c| c.get("path"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let _ = event_tx.send(AgentEvent::ToolCallRequested {
                                            session_id,
                                            tool_id,
                                            tool_name: "Edit".to_string(),
                                            arguments: if first_path.is_empty() {
                                                json!({ "changes": changes })
                                            } else {
                                                json!({ "file_path": first_path, "changes": changes })
                                            },
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    "mcpToolCall" => {
                                        let tool_id = item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("mcp")
                                            .to_string();
                                        let server = item
                                            .get("server")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("mcp");
                                        let tool = item
                                            .get("tool")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("tool");
                                        let arguments = item
                                            .get("arguments")
                                            .cloned()
                                            .unwrap_or_else(|| json!({}));
                                        let _ = event_tx.send(AgentEvent::ToolCallRequested {
                                            session_id,
                                            tool_id,
                                            tool_name: format!("MCP · {}:{}", server, tool),
                                            arguments,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    "webSearch" => {
                                        let tool_id = item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("search")
                                            .to_string();
                                        let query = item
                                            .get("query")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let _ = event_tx.send(AgentEvent::ToolCallRequested {
                                            session_id,
                                            tool_id,
                                            tool_name: "Search".to_string(),
                                            arguments: json!({ "query": query }),
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "item/completed" => {
                            saw_turn_activity = true;
                            if let Some(item) = msg.pointer("/params/item") {
                                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                match item_type {
                                    "reasoning" => {
                                        let mut final_thought = String::new();
                                        if let Some(arr) = item.get("summary").and_then(|v| v.as_array()) {
                                            for s in arr {
                                                if let Some(t) = s.as_str() {
                                                    if !t.trim().is_empty() {
                                                        if !final_thought.is_empty() {
                                                            final_thought.push('\n');
                                                        }
                                                        final_thought.push_str(t.trim());
                                                    }
                                                }
                                            }
                                        }
                                        if final_thought.is_empty() {
                                            final_thought = accumulated_reasoning.trim().to_string();
                                        }
                                        accumulated_reasoning.clear();
                                        if !final_thought.is_empty() {
                                            let _ = event_tx.send(AgentEvent::ThinkingDelta {
                                                session_id,
                                                text: final_thought,
                                                timestamp: Utc::now(),
                                            });
                                        }
                                    }
                                    "agentMessage" => {
                                        let text = item
                                            .get("text")
                                            .and_then(|v| v.as_str())
                                            .filter(|s| !s.trim().is_empty())
                                            .map(str::to_string)
                                            .unwrap_or_else(|| std::mem::take(&mut accumulated_message));
                                        accumulated_message.clear();
                                        if !text.trim().is_empty() {
                                            emitted_final_message = true;
                                            let _ = event_tx.send(AgentEvent::MessageDelta {
                                                session_id,
                                                text,
                                                timestamp: Utc::now(),
                                            });
                                        }
                                    }
                                    "commandExecution" => {
                                        let tool_id = item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("cmd")
                                            .to_string();
                                        let out = item
                                            .get("aggregatedOutput")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let exit_code = item
                                            .get("exitCode")
                                            .and_then(|v| v.as_i64())
                                            .unwrap_or(0);
                                        let _ = event_tx.send(AgentEvent::ToolCallCompleted {
                                            session_id,
                                            tool_id,
                                            output: if out.is_empty() {
                                                format!("(exit code {})", exit_code)
                                            } else {
                                                out.to_string()
                                            },
                                            is_error: exit_code != 0,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    "fileChange" => {
                                        let tool_id = item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("edit")
                                            .to_string();
                                        let status = item
                                            .get("status")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("completed");
                                        let _ = event_tx.send(AgentEvent::ToolCallCompleted {
                                            session_id,
                                            tool_id,
                                            output: "Applied file changes".to_string(),
                                            is_error: status == "failed",
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    "mcpToolCall" => {
                                        let tool_id = item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("mcp")
                                            .to_string();
                                        let err_val = item.get("error").filter(|v| !v.is_null());
                                        let is_error = err_val.is_some();
                                        let output = if let Some(e) = err_val {
                                            e.to_string()
                                        } else if let Some(res) = item.get("result") {
                                            res.as_str()
                                                .map(str::to_string)
                                                .unwrap_or_else(|| res.to_string())
                                        } else {
                                            "(completed)".to_string()
                                        };
                                        let _ = event_tx.send(AgentEvent::ToolCallCompleted {
                                            session_id,
                                            tool_id,
                                            output,
                                            is_error,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    "webSearch" => {
                                        let tool_id = item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("search")
                                            .to_string();
                                        let query = item
                                            .get("query")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let _ = event_tx.send(AgentEvent::ToolCallCompleted {
                                            session_id,
                                            tool_id,
                                            output: if query.is_empty() {
                                                "Web search completed".to_string()
                                            } else {
                                                format!("Searched: {}", query)
                                            },
                                            is_error: false,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "thread/tokenUsage/updated" => {
                            let parse_usage_triple = |u: &Value| -> (u64, u64, u64) {
                                let inp = u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                let cache = u
                                    .get("cachedInputTokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0);
                                let out =
                                    u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                (inp, cache, out)
                            };
                            let total_opt = msg
                                .pointer("/params/tokenUsage/total")
                                .map(parse_usage_triple);
                            let last_opt = msg
                                .pointer("/params/tokenUsage/last")
                                .map(parse_usage_triple);

                            if !saw_turn_activity {
                                // Capture baseline thread totals from `thread/resume` echo so the upcoming turn emits exact deltas
                                if let Some(tot) = total_opt {
                                    last_thread_total = Some(tot);
                                }
                                if let Some(lst) = last_opt {
                                    last_step_snapshot = Some(lst);
                                }
                                continue;
                            }

                            let ctx_win = msg
                                .pointer("/params/tokenUsage/modelContextWindow")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(200_000);

                            let delta_triple: Option<(u64, u64, u64)> = if let Some(tot) = total_opt
                            {
                                let prev = last_thread_total;
                                last_thread_total = Some(tot);
                                if let Some(p) = prev {
                                    let d_in = tot.0.saturating_sub(p.0);
                                    let d_cache = tot.1.saturating_sub(p.1);
                                    let d_out = tot.2.saturating_sub(p.2);
                                    if d_in == 0 && d_cache == 0 && d_out == 0 {
                                        None
                                    } else {
                                        Some((d_in, d_cache, d_out))
                                    }
                                } else if let Some(lst) = last_opt {
                                    last_step_snapshot = Some(lst);
                                    if lst.0 == 0 && lst.2 == 0 { None } else { Some(lst) }
                                } else if tot.0 == 0 && tot.2 == 0 {
                                    None
                                } else {
                                    Some(tot)
                                }
                            } else if let Some(lst) = last_opt {
                                if last_step_snapshot == Some(lst) || (lst.0 == 0 && lst.2 == 0) {
                                    None
                                } else {
                                    last_step_snapshot = Some(lst);
                                    Some(lst)
                                }
                            } else {
                                None
                            };

                            if let Some((input_tokens, cache_read_tokens, output_tokens)) =
                                delta_triple
                            {
                                let total_tokens = input_tokens.saturating_add(output_tokens);
                                if total_tokens > 0 {
                                    let _ = event_tx.send(AgentEvent::UsageUpdated {
                                        session_id,
                                        input_tokens,
                                        output_tokens,
                                        total_tokens,
                                        cache_read_tokens,
                                        cache_write_tokens: 0,
                                        context_window: ctx_win,
                                        // Delegate cost computation to velo-daemon's model-aware pricing engine
                                        cost_usd: 0.0,
                                        output_tps: 0.0,
                                        is_turn_total: false,
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                        }
                        "item/commandExecution/requestApproval"
                        | "item/fileChange/requestApproval"
                        | "execCommandApproval"
                        | "applyPatchApproval" => {
                            let rpc_id = msg.get("id").cloned().unwrap_or(Value::Null);
                            let allowed = if approval_mode == "ask_before_edit" {
                                let tool_label = if method.contains("fileChange")
                                    || method.contains("Patch")
                                {
                                    "Edit"
                                } else {
                                    "Bash"
                                };
                                let preview = msg
                                    .pointer("/params/command")
                                    .or_else(|| msg.pointer("/params/reason"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(tool_label);
                                request_daemon_approval(
                                    daemon_http_base.as_deref(),
                                    session_id,
                                    tool_label,
                                    preview,
                                )
                                .await
                            } else {
                                true
                            };
                            let decision = if allowed { "accept" } else { "decline" };
                            let _ = send_rpc(
                                &mut stdin,
                                &json!({
                                    "jsonrpc": "2.0",
                                    "id": rpc_id,
                                    "result": { "decision": decision }
                                }),
                            )
                            .await;
                        }
                        "turn/completed" => {
                            if !emitted_final_message && !accumulated_message.trim().is_empty() {
                                let _ = event_tx.send(AgentEvent::MessageDelta {
                                    session_id,
                                    text: std::mem::take(&mut accumulated_message),
                                    timestamp: Utc::now(),
                                });
                            }
                            let turn_status = msg
                                .pointer("/params/turn/status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("completed");
                            if turn_status == "failed" {
                                let err_msg = msg
                                    .pointer("/params/turn/error/message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Codex turn failed");
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
                                // Emit Completed IMMEDIATELY on `turn/completed` so the UI never hangs
                                // waiting for process exit teardown.
                                let _ = event_tx.send(AgentEvent::StatusChanged {
                                    session_id,
                                    status: SessionStatus::Completed,
                                    message: Some("Agent finished successfully".to_string()),
                                    timestamp: Utc::now(),
                                });
                            }
                            // Keep codex app-server warm in background for instant 0ms follow-up turns!
                            accumulated_reasoning.clear();
                            accumulated_message.clear();
                            emitted_final_message = false;
                            is_idle_warm = true;
                        }
                        _ => {}
                    }
                }
            }
        }

        // Fallback if process exited before `turn/completed`
        loop_alive.store(false, std::sync::atomic::Ordering::SeqCst);
        stderr_task.abort();
        let exit_ok = child.wait().await.map(|s| s.success()).unwrap_or(false);
        if !emitted_final_message && !accumulated_message.trim().is_empty() {
            let _ = event_tx.send(AgentEvent::MessageDelta {
                session_id,
                text: accumulated_message,
                timestamp: Utc::now(),
            });
        }
        let _ = event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: if exit_ok {
                SessionStatus::Completed
            } else {
                SessionStatus::Failed
            },
            message: Some("Codex app-server exited".to_string()),
            timestamp: Utc::now(),
        });
    });

    Ok(AgentHandle {
        session_id,
        pid,
        input_tx,
        kill_tx: Some(kill_tx),
        alive: alive_flag,
        warm_tx: None,
    })
}
