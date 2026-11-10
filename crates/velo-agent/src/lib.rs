use anyhow::{Context, Result};
use chrono::Utc;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, info};
use uuid::Uuid;
use velo_protocol::{AgentEvent, AgentProvider, SessionStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRuntimeInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
}

/// Discovers local Node/fnm/nvm/Homebrew/Cargo binary directories so macOS `.app` bundles
/// can invoke `claude`, `codex`, `gemini`, `opencode`, and `node` without manual PATH configuration.
pub fn discover_augmented_path() -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // 1. fnm node installations (~/.local/share/fnm/node-versions/*/installation/bin)
        let fnm_bases = [
            home.join(".local/share/fnm/node-versions"),
            home.join("Library/Application Support/fnm/node-versions"),
        ];
        for base in &fnm_bases {
            if let Ok(entries) = std::fs::read_dir(base) {
                let mut versions: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .collect();
                versions.sort();
                versions.reverse();
                for v in versions {
                    let bin = v.join("installation/bin");
                    if bin.is_dir() {
                        dirs.push(bin);
                    }
                }
            }
        }

        // 2. nvm node installations (~/.nvm/versions/node/*/bin)
        let nvm_base = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_base) {
            let mut versions: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .collect();
            versions.sort();
            versions.reverse();
            for v in versions {
                let bin = v.join("bin");
                if bin.is_dir() {
                    dirs.push(bin);
                }
            }
        }

        // 3. Common user bin paths
        for rel in [".local/bin", ".cargo/bin", ".bun/bin", "bin"] {
            let p = home.join(rel);
            if p.is_dir() {
                dirs.push(p);
            }
        }
    }

    for sys in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        let p = PathBuf::from(sys);
        if p.is_dir() {
            dirs.push(p);
        }
    }

    if let Ok(existing) = std::env::var("PATH") {
        for part in existing.split(':') {
            if !part.is_empty() {
                let p = PathBuf::from(part);
                if !dirs.contains(&p) {
                    dirs.push(p);
                }
            }
        }
    }

    dirs.iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(":")
}

pub fn resolve_cli_binary(name: &str) -> Option<PathBuf> {
    if name == "claude" {
        if let Some(home) = dirs::home_dir() {
            let cc_base = home.join("Library/Application Support/Claude/claude-code");
            if let Ok(versions) = std::fs::read_dir(&cc_base) {
                let mut ver_dirs: Vec<PathBuf> = versions
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .collect();
                ver_dirs.sort();
                ver_dirs.reverse();
                for vdir in ver_dirs {
                    if let Ok(hashes) = std::fs::read_dir(&vdir) {
                        for h in hashes.flatten() {
                            let bin = h.path().join("claude.app/Contents/MacOS/claude");
                            if bin.is_file() {
                                return Some(bin);
                            }
                        }
                    }
                }
            }
        }
    }

    let path_str = discover_augmented_path();
    for dir in path_str.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Discovers active `CLAUDE_CODE_OAUTH_TOKEN` from the user's running Claude Desktop / Claude Code session
/// when `claude` is invoked outside the Claude Desktop process tree.
fn discover_claude_oauth_token() -> Option<String> {
    if let Ok(tok) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        if !tok.trim().is_empty() {
            return Some(tok);
        }
    }
    let out = std::process::Command::new("sh")
        .args([
            "-c",
            "for p in $(pgrep -f 'claude.app/Contents/MacOS/claude' 2>/dev/null); do ps eww -p $p 2>/dev/null | tr ' ' '\\n' | grep '^CLAUDE_CODE_OAUTH_TOKEN=' | head -n 1 | cut -d= -f2-; done | head -n 1",
        ])
        .output()
        .ok()?;
    let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !tok.is_empty() {
        Some(tok)
    } else {
        None
    }
}

pub async fn detect_local_runtimes() -> Vec<LocalRuntimeInfo> {
    let aug_path = discover_augmented_path();
    let specs = [
        ("claude", "Claude Code"),
        ("codex", "OpenAI Codex"),
        ("gemini", "Gemini CLI"),
        ("opencode", "OpenCode"),
    ];

    let mut out = Vec::new();
    for (bin, label) in specs {
        let resolved = resolve_cli_binary(bin);
        if let Some(bin_path) = resolved {
            let ver_out = Command::new(&bin_path)
                .arg("--version")
                .env("PATH", &aug_path)
                .output()
                .await;
            let version = match ver_out {
                Ok(o) => {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    let combined = if !s.is_empty() { s } else { e };
                    combined.lines().next().map(|l| l.trim().to_string())
                }
                Err(_) => None,
            };
            out.push(LocalRuntimeInfo {
                id: bin.to_string(),
                name: label.to_string(),
                available: true,
                version,
                binary_path: Some(bin_path.to_string_lossy().to_string()),
            });
        } else {
            out.push(LocalRuntimeInfo {
                id: bin.to_string(),
                name: label.to_string(),
                available: false,
                version: None,
                binary_path: None,
            });
        }
    }
    out
}

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
        Self::spawn_agent_with_options(
            session_id,
            provider,
            prompt,
            worktree_path,
            use_pty,
            None,
            None,
            event_tx,
        )
        .await
    }

    pub async fn spawn_agent_with_options(
        session_id: Uuid,
        provider: AgentProvider,
        prompt: String,
        worktree_path: PathBuf,
        use_pty: bool,
        model: Option<String>,
        effort: Option<String>,
        event_tx: broadcast::Sender<AgentEvent>,
    ) -> Result<AgentHandle> {
        if use_pty {
            Self::spawn_pty_agent(session_id, provider, prompt, worktree_path, event_tx).await
        } else {
            Self::spawn_structured_agent(
                session_id,
                provider,
                prompt,
                worktree_path,
                model,
                effort,
                event_tx,
            )
            .await
        }
    }

    /// Channel A: Spawns agent subprocess with structured JSON stream parsing (e.g. Claude Code `stream-json`).
    async fn spawn_structured_agent(
        session_id: Uuid,
        provider: AgentProvider,
        prompt: String,
        worktree_path: PathBuf,
        model: Option<String>,
        effort: Option<String>,
        event_tx: broadcast::Sender<AgentEvent>,
    ) -> Result<AgentHandle> {
        let mut cmd = Self::build_tokio_command(
            &provider,
            &prompt,
            &worktree_path,
            model.as_deref(),
            effort.as_deref(),
        );
        cmd.current_dir(&worktree_path)
            .stdin(Stdio::null())
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

        let (input_tx, _input_rx) = mpsc::unbounded_channel::<String>();
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

        // Parse stdout lines (Claude stream-json or Codex --json)
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

        // Parse stderr lines (ignore benign stdin notice from codex)
        let tx_err = event_tx.clone();
        tokio::spawn(async move {
            let mut reader = TokioBufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if !trimmed.is_empty() && !trimmed.contains("Reading additional input from stdin") {
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

    fn build_tokio_command(
        provider: &AgentProvider,
        prompt: &str,
        _cwd: &Path,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Command {
        let aug_path = discover_augmented_path();
        let mut cmd = match provider {
            AgentProvider::Claude => {
                let bin = resolve_cli_binary("claude").unwrap_or_else(|| PathBuf::from("claude"));
                let mut c = Command::new(bin);
                if let Some(tok) = discover_claude_oauth_token() {
                    c.env("CLAUDE_CODE_OAUTH_TOKEN", tok);
                }
                c.args([
                    "-p",
                    prompt,
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--permission-mode",
                    "acceptEdits",
                ]);
                if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                    let cli_model = if m.starts_with("claude-fable") {
                        "fable"
                    } else {
                        m
                    };
                    c.args(["--model", cli_model]);
                }
                if let Some(eff) = effort.filter(|s| !s.trim().is_empty()) {
                    c.args(["--effort", eff]);
                }
                c
            }
            AgentProvider::Codex => {
                let bin = resolve_cli_binary("codex").unwrap_or_else(|| PathBuf::from("codex"));
                let mut c = Command::new(bin);
                c.args([
                    "exec",
                    "--json",
                    "-s",
                    "workspace-write",
                    "--skip-git-repo-check",
                ]);
                if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                    c.args(["-m", m]);
                }
                if let Some(eff) = effort.filter(|s| !s.trim().is_empty()) {
                    c.args(["-c", &format!("model_reasoning_effort=\"{}\"", eff)]);
                }
                c.arg(prompt);
                c
            }
            AgentProvider::OpenCode => {
                let bin =
                    resolve_cli_binary("opencode").unwrap_or_else(|| PathBuf::from("opencode"));
                let mut c = Command::new(bin);
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
        };
        cmd.env("PATH", aug_path);
        cmd
    }

    fn build_pty_command(
        provider: &AgentProvider,
        prompt: &str,
        cwd: &Path,
    ) -> CommandBuilder {
        let aug_path = discover_augmented_path();
        let mut cmd = match provider {
            AgentProvider::Claude => {
                let bin = resolve_cli_binary("claude")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "claude".to_string());
                let mut c = CommandBuilder::new(bin);
                if !prompt.trim().is_empty() {
                    c.arg(prompt);
                }
                c
            }
            AgentProvider::Codex => {
                let bin = resolve_cli_binary("codex")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "codex".to_string());
                let mut c = CommandBuilder::new(bin);
                if !prompt.trim().is_empty() {
                    c.arg(prompt);
                }
                c
            }
            AgentProvider::OpenCode => {
                let bin = resolve_cli_binary("opencode")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "opencode".to_string());
                let mut c = CommandBuilder::new(bin);
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
        cmd.env("PATH", aug_path);
        cmd.cwd(cwd);
        cmd
    }
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Parses a single stdout line from Claude Code (`stream-json`), OpenAI Codex (`--json`), or other agents into `AgentEvent`s.
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
                // 0. Session / Turn Initialization -> Immediate Thinking feedback
                "system" => {
                    if json.get("subtype").and_then(|v| v.as_str()) == Some("init") {
                        let model_label = json
                            .get("model")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Claude");
                        events.push(AgentEvent::ThinkingDelta {
                            session_id,
                            text: format!(
                                "Initialized {} runtime • Inspecting workspace context...\n",
                                model_label
                            ),
                            timestamp: Utc::now(),
                        });
                    }
                    return events;
                }
                "turn.started" => {
                    events.push(AgentEvent::ThinkingDelta {
                        session_id,
                        text: "Analyzing prompt and workspace context...\n".to_string(),
                        timestamp: Utc::now(),
                    });
                    return events;
                }
                // 1. Claude Code stream-json events
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
                    return events;
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
                    return events;
                }
                "result" => {
                    let is_err = json
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if is_err {
                        if let Some(result_text) = json.get("result").and_then(|v| v.as_str()) {
                            events.push(AgentEvent::Error {
                                session_id,
                                error: result_text.to_string(),
                                timestamp: Utc::now(),
                            });
                        }
                    }
                    return events;
                }
                // 2. OpenAI Codex `--json` JSONL events
                "item.completed" | "item.started" | "item.updated" => {
                    if let Some(item) = json.get("item") {
                        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match item_type {
                            "reasoning" if msg_type == "item.completed" => {
                                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                    if !text.trim().is_empty() {
                                        events.push(AgentEvent::ThinkingDelta {
                                            session_id,
                                            text: format!("{}\n", text.trim()),
                                            timestamp: Utc::now(),
                                        });
                                    }
                                } else if let Some(summary_arr) =
                                    item.get("summary").and_then(|v| v.as_array())
                                {
                                    let mut combined = String::new();
                                    for s in summary_arr {
                                        if let Some(t) = s.get("text").and_then(|v| v.as_str()) {
                                            if !t.trim().is_empty() {
                                                combined.push_str(t.trim());
                                                combined.push('\n');
                                            }
                                        }
                                    }
                                    if !combined.is_empty() {
                                        events.push(AgentEvent::ThinkingDelta {
                                            session_id,
                                            text: combined,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                }
                            }
                            "agent_message" if msg_type == "item.completed" => {
                                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                    if !text.trim().is_empty() {
                                        events.push(AgentEvent::MessageDelta {
                                            session_id,
                                            text: text.to_string(),
                                            timestamp: Utc::now(),
                                        });
                                    }
                                }
                            }
                            "command_execution" => {
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
                                if msg_type == "item.started" {
                                    events.push(AgentEvent::ToolCallRequested {
                                        session_id,
                                        tool_id,
                                        tool_name: "Bash".to_string(),
                                        arguments: serde_json::json!({ "command": cmd_str }),
                                        timestamp: Utc::now(),
                                    });
                                } else if msg_type == "item.completed" {
                                    let out = item
                                        .get("aggregated_output")
                                        .or_else(|| item.get("output"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let exit_code = item
                                        .get("exit_code")
                                        .and_then(|v| v.as_i64())
                                        .unwrap_or(0);
                                    events.push(AgentEvent::ToolCallCompleted {
                                        session_id,
                                        tool_id,
                                        output: if out.is_empty() {
                                            format!("(exit code {})", exit_code)
                                        } else {
                                            out
                                        },
                                        is_error: exit_code != 0,
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                            "file_change" => {
                                let tool_id = item
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("edit")
                                    .to_string();
                                let changes = item
                                    .get("changes")
                                    .cloned()
                                    .unwrap_or_else(|| serde_json::json!({}));
                                if msg_type == "item.started" {
                                    events.push(AgentEvent::ToolCallRequested {
                                        session_id,
                                        tool_id,
                                        tool_name: "Edit".to_string(),
                                        arguments: changes,
                                        timestamp: Utc::now(),
                                    });
                                } else if msg_type == "item.completed" {
                                    events.push(AgentEvent::ToolCallCompleted {
                                        session_id,
                                        tool_id,
                                        output: "Applied file changes".to_string(),
                                        is_error: false,
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                    return events;
                }
                "error" => {
                    if let Some(msg) = json.get("message").and_then(|v| v.as_str()) {
                        events.push(AgentEvent::Error {
                            session_id,
                            error: msg.to_string(),
                            timestamp: Utc::now(),
                        });
                    }
                    return events;
                }
                "thread.started" | "turn.completed" => {
                    return vec![];
                }
                _ => {
                    debug!("Unhandled JSON event from {}: {}", provider, msg_type);
                    return events;
                }
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
