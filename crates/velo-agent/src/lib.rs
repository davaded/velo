use anyhow::{Context, Result};
use chrono::Utc;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as TokioBufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, info};
use uuid::Uuid;
use velo_protocol::{AgentEvent, AgentProvider, SessionStatus};

/// Handle to control an active agent process (send input or stop).
pub struct AgentHandle {
    pub session_id: Uuid,
    pub pid: Option<u32>,
    input_tx: mpsc::UnboundedSender<String>,
    kill_tx: Option<oneshot::Sender<()>>,
}

impl AgentHandle {
    pub fn send_input(&self, data: String) -> Result<()> {
        self.input_tx
            .send(data)
            .map_err(|_| anyhow::anyhow!("Agent input channel closed"))
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.kill_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Spawns and supervises coding agents in either Structured Stream mode or Interactive PTY mode.
pub struct AgentSpawner;

impl AgentSpawner {
    pub async fn spawn_agent(
        session_id: Uuid,
        provider: AgentProvider,
        prompt: String,
        worktree_path: PathBuf,
        use_pty: bool,
        event_tx: broadcast::Sender<AgentEvent>,
    ) -> Result<AgentHandle> {
        if use_pty {
            Self::spawn_pty_agent(session_id, provider, prompt, worktree_path, event_tx).await
        } else {
            Self::spawn_structured_agent(session_id, provider, prompt, worktree_path, event_tx)
                .await
        }
    }

    /// Channel A: Spawns agent subprocess with structured JSON stream parsing (e.g. Claude Code `stream-json`).
    async fn spawn_structured_agent(
        session_id: Uuid,
        provider: AgentProvider,
        prompt: String,
        worktree_path: PathBuf,
        event_tx: broadcast::Sender<AgentEvent>,
    ) -> Result<AgentHandle> {
        let mut cmd = Self::build_tokio_command(&provider, &prompt, &worktree_path);
        cmd.current_dir(&worktree_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                let msg = format!(
                    "Failed to spawn `{}` ({}). Ensure the CLI is installed in PATH.",
                    provider.binary_name(),
                    err
                );
                let _ = event_tx.send(AgentEvent::Error {
                    session_id,
                    error: msg.clone(),
                    timestamp: Utc::now(),
                });
                let _ = event_tx.send(AgentEvent::StatusChanged {
                    session_id,
                    status: SessionStatus::Failed,
                    message: Some(msg.clone()),
                    timestamp: Utc::now(),
                });
                anyhow::bail!(msg);
            }
        };

        let pid = child.id();
        info!(
            "Spawned structured agent {} (session={}, pid={:?}) in {}",
            provider,
            session_id,
            pid,
            worktree_path.display()
        );

        let _ = event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: SessionStatus::Running,
            message: Some(format!("Agent `{}` started (PID {:?})", provider, pid)),
            timestamp: Utc::now(),
        });

        let stdout = child.stdout.take().context("Failed to capture stdout")?;
        let stderr = child.stderr.take().context("Failed to capture stderr")?;
        let mut stdin = child.stdin.take().context("Failed to capture stdin")?;

        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

        // Forward stdin writer
        tokio::spawn(async move {
            while let Some(line) = input_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if !line.ends_with('\n') {
                    let _ = stdin.write_all(b"\n").await;
                }
                let _ = stdin.flush().await;
            }
        });

        // Parse stdout lines (Claude stream-json or plain text fallback)
        let tx_out = event_tx.clone();
        let provider_clone = provider.clone();
        tokio::spawn(async move {
            let mut reader = TokioBufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                for ev in parse_agent_stdout_line(session_id, &provider_clone, &line) {
                    let _ = tx_out.send(ev);
                }
            }
        });

        // Parse stderr lines
        let tx_err = event_tx.clone();
        tokio::spawn(async move {
            let mut reader = TokioBufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    let _ = tx_err.send(AgentEvent::PtyOutput {
                        session_id,
                        line: format!("[stderr] {}", line),
                        timestamp: Utc::now(),
                    });
                }
            }
        });

        // Supervise process exit or manual stop
        let tx_status = event_tx.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = &mut kill_rx => {
                    info!("Stopping agent session {}", session_id);
                    let _ = child.kill().await;
                    let _ = tx_status.send(AgentEvent::StatusChanged {
                        session_id,
                        status: SessionStatus::Stopped,
                        message: Some("Session stopped by user".to_string()),
                        timestamp: Utc::now(),
                    });
                }
                status_res = child.wait() => {
                    match status_res {
                        Ok(exit) if exit.success() => {
                            let _ = tx_status.send(AgentEvent::StatusChanged {
                                session_id,
                                status: SessionStatus::Completed,
                                message: Some("Agent finished successfully".to_string()),
                                timestamp: Utc::now(),
                            });
                        }
                        Ok(exit) => {
                            let _ = tx_status.send(AgentEvent::StatusChanged {
                                session_id,
                                status: SessionStatus::Failed,
                                message: Some(format!("Agent exited with status {}", exit)),
                                timestamp: Utc::now(),
                            });
                        }
                        Err(err) => {
                            let _ = tx_status.send(AgentEvent::StatusChanged {
                                session_id,
                                status: SessionStatus::Failed,
                                message: Some(format!("Agent wait error: {}", err)),
                                timestamp: Utc::now(),
                            });
                        }
                    }
                }
            }
        });

        Ok(AgentHandle {
            session_id,
            pid,
            input_tx,
            kill_tx: Some(kill_tx),
        })
    }

    /// Channel B: Spawns agent inside a real pseudo-terminal (`portable-pty`) for full TUI compatibility.
    async fn spawn_pty_agent(
        session_id: Uuid,
        provider: AgentProvider,
        prompt: String,
        worktree_path: PathBuf,
        event_tx: broadcast::Sender<AgentEvent>,
    ) -> Result<AgentHandle> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 36,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to open PTY")?;

        let cmd = Self::build_pty_command(&provider, &prompt, &worktree_path);
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("Failed to spawn PTY command for {}", provider))?;

        let pid = child.process_id();
        let mut child_killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .context("Failed to clone PTY reader")?;
        let writer = Arc::new(Mutex::new(
            pair.master
                .take_writer()
                .context("Failed to take PTY writer")?,
        ));

        let _ = event_tx.send(AgentEvent::StatusChanged {
            session_id,
            status: SessionStatus::Running,
            message: Some(format!("PTY Agent `{}` started (PID {:?})", provider, pid)),
            timestamp: Utc::now(),
        });

        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

        // Forward input into PTY master writer
        let writer_clone = Arc::clone(&writer);
        tokio::spawn(async move {
            while let Some(data) = input_rx.recv().await {
                if let Ok(mut guard) = writer_clone.lock() {
                    let _ = guard.write_all(data.as_bytes());
                    if !data.ends_with('\n') {
                        let _ = guard.write_all(b"\n");
                    }
                    let _ = guard.flush();
                }
            }
        });

        // Read PTY lines on a blocking thread
        let tx_pty = event_tx.clone();
        tokio::task::spawn_blocking(move || {
            let mut buf_reader = BufReader::new(reader);
            let mut line = String::new();
            while let Ok(bytes) = buf_reader.read_line(&mut line) {
                if bytes == 0 {
                    break;
                }
                let clean = line.trim_end_matches(&['\r', '\n'][..]).to_string();
                let _ = tx_pty.send(AgentEvent::PtyOutput {
                    session_id,
                    line: clean,
                    timestamp: Utc::now(),
                });
                line.clear();
            }
        });

        // Supervise PTY child lifecycle
        let tx_status = event_tx.clone();
        let mut wait_handle = tokio::task::spawn_blocking(move || child.wait());
        tokio::spawn(async move {
            tokio::select! {
                _ = &mut kill_rx => {
                    let _ = child_killer.kill();
                    let _ = tx_status.send(AgentEvent::StatusChanged {
                        session_id,
                        status: SessionStatus::Stopped,
                        message: Some("PTY Session stopped by user".to_string()),
                        timestamp: Utc::now(),
                    });
                }
                res = &mut wait_handle => {
                    match res {
                        Ok(Ok(status)) if status.success() => {
                            let _ = tx_status.send(AgentEvent::StatusChanged {
                                session_id,
                                status: SessionStatus::Completed,
                                message: Some("PTY Agent finished successfully".to_string()),
                                timestamp: Utc::now(),
                            });
                        }
                        Ok(Ok(status)) => {
                            let _ = tx_status.send(AgentEvent::StatusChanged {
                                session_id,
                                status: SessionStatus::Failed,
                                message: Some(format!("PTY Agent exited: {:?}", status)),
                                timestamp: Utc::now(),
                            });
                        }
                        _ => {
                            let _ = tx_status.send(AgentEvent::StatusChanged {
                                session_id,
                                status: SessionStatus::Failed,
                                message: Some("PTY Agent wait failed".to_string()),
                                timestamp: Utc::now(),
                            });
                        }
                    }
                }
            }
        });

        Ok(AgentHandle {
            session_id,
            pid,
            input_tx,
            kill_tx: Some(kill_tx),
        })
    }

    fn build_tokio_command(provider: &AgentProvider, prompt: &str, _cwd: &Path) -> Command {
        match provider {
            AgentProvider::Claude => {
                let mut c = Command::new("claude");
                c.args([
                    "-p",
                    prompt,
                    "--output-format",
                    "stream-json",
                    "--verbose",
                ]);
                c
            }
            AgentProvider::Codex => {
                let mut c = Command::new("codex");
                c.args(["exec", prompt]);
                c
            }
            AgentProvider::OpenCode => {
                let mut c = Command::new("opencode");
                c.args(["run", prompt]);
                c
            }
            AgentProvider::Custom(cmd_str) => {
                let mut c = Command::new("sh");
                let full_cmd = if prompt.trim().is_empty() {
                    cmd_str.clone()
                } else {
                    format!("{} {}", cmd_str, shell_escape(prompt))
                };
                c.args(["-c", &full_cmd]);
                c
            }
        }
    }

    fn build_pty_command(
        provider: &AgentProvider,
        prompt: &str,
        cwd: &Path,
    ) -> CommandBuilder {
        let mut cmd = match provider {
            AgentProvider::Claude => {
                let mut c = CommandBuilder::new("claude");
                if !prompt.trim().is_empty() {
                    c.arg(prompt);
                }
                c
            }
            AgentProvider::Codex => {
                let mut c = CommandBuilder::new("codex");
                if !prompt.trim().is_empty() {
                    c.arg(prompt);
                }
                c
            }
            AgentProvider::OpenCode => {
                let mut c = CommandBuilder::new("opencode");
                if !prompt.trim().is_empty() {
                    c.args(["run", prompt]);
                }
                c
            }
            AgentProvider::Custom(raw) => {
                let mut c = CommandBuilder::new("sh");
                let full = if prompt.trim().is_empty() {
                    raw.clone()
                } else {
                    format!("{} {}", raw, shell_escape(prompt))
                };
                c.args(["-c", &full]);
                c
            }
        };
        cmd.cwd(cwd);
        cmd
    }
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Parses a single stdout line from Claude Code (`stream-json`) or other agents into `AgentEvent`s.
pub fn parse_agent_stdout_line(
    session_id: Uuid,
    provider: &AgentProvider,
    line: &str,
) -> Vec<AgentEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        if let Ok(json) = serde_json::from_str::<Value>(trimmed) {
            let mut events = Vec::new();
            let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match msg_type {
                "assistant" => {
                    if let Some(content_arr) = json
                        .pointer("/message/content")
                        .and_then(|v| v.as_array())
                    {
                        for item in content_arr {
                            let block_type =
                                item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            match block_type {
                                "text" => {
                                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                        events.push(AgentEvent::MessageDelta {
                                            session_id,
                                            text: text.to_string(),
                                            timestamp: Utc::now(),
                                        });
                                    }
                                }
                                "thinking" => {
                                    if let Some(thinking) =
                                        item.get("thinking").and_then(|v| v.as_str())
                                    {
                                        events.push(AgentEvent::ThinkingDelta {
                                            session_id,
                                            text: thinking.to_string(),
                                            timestamp: Utc::now(),
                                        });
                                    }
                                }
                                "tool_use" => {
                                    let tool_id = item
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("tool")
                                        .to_string();
                                    let tool_name = item
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown")
                                        .to_string();
                                    let arguments =
                                        item.get("input").cloned().unwrap_or(Value::Null);
                                    events.push(AgentEvent::ToolCallRequested {
                                        session_id,
                                        tool_id,
                                        tool_name,
                                        arguments,
                                        timestamp: Utc::now(),
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                }
                "user" | "tool_result" => {
                    if let Some(content_arr) = json
                        .pointer("/message/content")
                        .and_then(|v| v.as_array())
                    {
                        for item in content_arr {
                            if item.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                                let tool_id = item
                                    .get("tool_use_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("tool")
                                    .to_string();
                                let is_error = item
                                    .get("is_error")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                let output = item
                                    .get("content")
                                    .map(|v| match v {
                                        Value::String(s) => s.clone(),
                                        other => other.to_string(),
                                    })
                                    .unwrap_or_default();
                                events.push(AgentEvent::ToolCallCompleted {
                                    session_id,
                                    tool_id,
                                    output,
                                    is_error,
                                    timestamp: Utc::now(),
                                });
                            }
                        }
                    }
                }
                "result" => {
                    if let Some(result_text) = json.get("result").and_then(|v| v.as_str()) {
                        if !result_text.is_empty() {
                            events.push(AgentEvent::MessageDelta {
                                session_id,
                                text: result_text.to_string(),
                                timestamp: Utc::now(),
                            });
                        }
                    }
                }
                _ => {
                    debug!("Unhandled JSON event from {}: {}", provider, msg_type);
                }
            }

            if !events.is_empty() {
                return events;
            }
        }
    }

    vec![AgentEvent::MessageDelta {
        session_id,
        text: line.to_string(),
        timestamp: Utc::now(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_claude_stream_json_line() {
        let sid = Uuid::new_v4();
        let raw = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Analyzing auth flow"},{"type":"text","text":"Implementing JWT middleware"},{"type":"tool_use","id":"toolu_01","name":"Edit","input":{"file_path":"src/auth.rs"}}]}}"#;
        let events = parse_agent_stdout_line(sid, &AgentProvider::Claude, raw);
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], AgentEvent::ThinkingDelta { .. }));
        assert!(matches!(events[1], AgentEvent::MessageDelta { .. }));
        assert!(matches!(events[2], AgentEvent::ToolCallRequested { .. }));
    }
}
