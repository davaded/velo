use anyhow::{Context, Result};
use chrono::Utc;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, info};
use uuid::Uuid;
use velo_protocol::{AgentEvent, AgentProvider, SessionStatus};

pub mod acp;
pub mod codex_app_server;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRuntimeInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
}

/// Discovers local Node/fnm/nvm/Homebrew/Cargo binary directories so macOS `.app` bundles
/// can invoke `claude`, `codex`, `agy`, `opencode`, and `node` without manual PATH configuration.
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

        // 3. Common user bin paths (including xAI Grok CLI ~/.grok/bin and Cursor CLI ~/.cursor/bin)
        for rel in [
            ".local/bin",
            ".grok/bin",
            ".cursor/bin",
            ".cargo/bin",
            ".bun/bin",
            "bin",
        ] {
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
    let candidates: &[&str] = if name == "cursor-agent" || name == "cursor" {
        &["cursor-agent", "agent"]
    } else {
        std::slice::from_ref(&name)
    };
    for cand_name in candidates {
        for dir in path_str.split(':') {
            if dir.is_empty() {
                continue;
            }
            let candidate = Path::new(dir).join(cand_name);
            if candidate.is_file() {
                return Some(candidate);
            }
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
        ("agy", "Google Antigravity CLI (agy)"),
        ("grok", "xAI Grok CLI (grok)"),
        ("cursor-agent", "Cursor Agent CLI"),
        ("opencode", "OpenCode (ACP)"),
        ("copilot", "GitHub Copilot CLI"),
        ("qwen", "Qwen Code (ACP)"),
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
        Self::spawn_agent_turn(
            session_id,
            provider,
            prompt,
            worktree_path,
            use_pty,
            model,
            effort,
            None,
            event_tx,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_agent_turn(
        session_id: Uuid,
        provider: AgentProvider,
        prompt: String,
        worktree_path: PathBuf,
        use_pty: bool,
        model: Option<String>,
        effort: Option<String>,
        resume_session_id: Option<String>,
        event_tx: broadcast::Sender<AgentEvent>,
    ) -> Result<AgentHandle> {
        Self::spawn_agent_turn_with_images(
            session_id,
            provider,
            prompt,
            worktree_path,
            use_pty,
            model,
            effort,
            resume_session_id,
            Vec::new(),
            event_tx,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_agent_turn_with_images(
        session_id: Uuid,
        provider: AgentProvider,
        prompt: String,
        worktree_path: PathBuf,
        use_pty: bool,
        model: Option<String>,
        effort: Option<String>,
        resume_session_id: Option<String>,
        images: Vec<String>,
        event_tx: broadcast::Sender<AgentEvent>,
    ) -> Result<AgentHandle> {
        Self::spawn_agent_turn_configured(
            session_id,
            provider,
            prompt,
            worktree_path,
            use_pty,
            model,
            effort,
            resume_session_id,
            images,
            "auto_edit".to_string(),
            None,
            event_tx,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_agent_turn_configured(
        session_id: Uuid,
        provider: AgentProvider,
        prompt: String,
        worktree_path: PathBuf,
        use_pty: bool,
        model: Option<String>,
        effort: Option<String>,
        resume_session_id: Option<String>,
        images: Vec<String>,
        approval_mode: String,
        daemon_http_base: Option<String>,
        event_tx: broadcast::Sender<AgentEvent>,
    ) -> Result<AgentHandle> {
        if let AgentProvider::Acp(ref spec) = provider {
            return acp::spawn_acp_agent(
                session_id,
                spec,
                prompt,
                worktree_path,
                resume_session_id,
                images,
                daemon_http_base,
                event_tx,
            )
            .await;
        }
        if use_pty {
            Self::spawn_pty_agent(session_id, provider, prompt, worktree_path, event_tx).await
        } else if matches!(provider, AgentProvider::Codex) {
            codex_app_server::spawn_codex_app_server(
                session_id,
                prompt,
                worktree_path,
                model,
                effort,
                resume_session_id,
                images,
                approval_mode,
                daemon_http_base,
                event_tx,
            )
            .await
        } else {
            Self::spawn_structured_agent(
                session_id,
                provider,
                prompt,
                worktree_path,
                model,
                effort,
                resume_session_id,
                images,
                approval_mode,
                daemon_http_base,
                event_tx,
            )
            .await
        }
    }

    /// Channel A: Spawns agent subprocess with structured JSON stream parsing (e.g. Claude Code `stream-json`).
    #[allow(clippy::too_many_arguments)]
    async fn spawn_structured_agent(
        session_id: Uuid,
        provider: AgentProvider,
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
        let mut cmd = Self::build_tokio_command(
            session_id,
            &provider,
            &prompt,
            &worktree_path,
            model.as_deref(),
            effort.as_deref(),
            resume_session_id.as_deref(),
            &images,
            &approval_mode,
            daemon_http_base.as_deref(),
        );
        cmd.current_dir(&worktree_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0);

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

        // Parse stdout lines (Claude stream-json, Codex --json, Grok, Cursor, Antigravity)
        let tx_out = event_tx.clone();
        let provider_clone = provider.clone();
        let stdout_task = tokio::spawn(async move {
            let mut reader = TokioBufReader::new(stdout).lines();
            let mut saw_message_delta = false;
            while let Ok(Some(line)) = reader.next_line().await {
                let parsed = parse_agent_stdout_line(session_id, &provider_clone, &line);
                for ev in &parsed {
                    if matches!(ev, AgentEvent::MessageDelta { .. }) {
                        saw_message_delta = true;
                    }
                }
                for ev in parsed {
                    let _ = tx_out.send(ev);
                }
                // Fallback for Cursor CLI if all assistant chunks carried `timestamp_ms` and final text only appeared in `result.result`
                if matches!(provider_clone, AgentProvider::Cursor) && !saw_message_delta {
                    let t = line.trim();
                    if t.starts_with('{') && t.ends_with('}') {
                        if let Ok(json) = serde_json::from_str::<Value>(t) {
                            if json.get("type").and_then(|v| v.as_str()) == Some("result")
                                && !json.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false)
                            {
                                if let Some(res_txt) = json
                                    .get("result")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.trim().is_empty())
                                {
                                    saw_message_delta = true;
                                    let _ = tx_out.send(AgentEvent::MessageDelta {
                                        session_id,
                                        text: res_txt.to_string(),
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        });

        // Parse stderr lines (ignore benign stdin notice from codex; surface fatal CLI / auth errors)
        let tx_err = event_tx.clone();
        let stderr_task = tokio::spawn(async move {
            let mut reader = TokioBufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if !trimmed.is_empty() && !trimmed.contains("Reading additional input from stdin") {
                    let _ = tx_err.send(AgentEvent::PtyOutput {
                        session_id,
                        line: format!("[stderr] {}", line),
                        timestamp: Utc::now(),
                    });
                    if trimmed.starts_with("Error:")
                        || trimmed.starts_with("error:")
                        || trimmed.starts_with("Fatal:")
                    {
                        let _ = tx_err.send(AgentEvent::Error {
                            session_id,
                            error: trimmed.to_string(),
                            timestamp: Utc::now(),
                        });
                    }
                }
            }
        });

        // Supervise process exit or manual stop
        let tx_status = event_tx.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = &mut kill_rx => {
                    info!("Stopping agent session {} (pid={:?})", session_id, pid);
                    stdout_task.abort();
                    stderr_task.abort();
                    #[cfg(unix)]
                    if let Some(p) = pid {
                        let _ = Command::new("kill")
                            .args(["-9", &format!("-{}", p)])
                            .status()
                            .await;
                    }
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

    #[allow(clippy::too_many_arguments)]
    fn build_tokio_command(
        session_id: Uuid,
        provider: &AgentProvider,
        prompt: &str,
        _cwd: &Path,
        model: Option<&str>,
        effort: Option<&str>,
        resume_session_id: Option<&str>,
        images: &[String],
        approval_mode: &str,
        daemon_http_base: Option<&str>,
    ) -> Command {
        let aug_path = discover_augmented_path();
        let mut cmd = match provider {
            AgentProvider::Claude => {
                let bin = resolve_cli_binary("claude").unwrap_or_else(|| PathBuf::from("claude"));
                let mut c = Command::new(bin);
                if let Some(tok) = discover_claude_oauth_token() {
                    c.env("CLAUDE_CODE_OAUTH_TOKEN", tok);
                }
                if let Some(rid) = resume_session_id.filter(|s| !s.trim().is_empty()) {
                    c.args(["--resume", rid]);
                }
                let effective_prompt = if images.is_empty() {
                    prompt.to_string()
                } else {
                    format!(
                        "{}\n\n[Attached local image(s) — inspect directly with Read tool: {}]",
                        prompt,
                        images.join(", ")
                    )
                };
                let perm_mode = if approval_mode == "bypass" {
                    "bypassPermissions"
                } else {
                    "acceptEdits"
                };
                c.args([
                    "-p",
                    &effective_prompt,
                    "--output-format",
                    "stream-json",
                    "--include-partial-messages",
                    "--verbose",
                    "--permission-mode",
                    perm_mode,
                ]);
                if let Some(base) = daemon_http_base.filter(|b| !b.trim().is_empty()) {
                    let clean_base = base.trim_end_matches('/');
                    let mcp_cfg = json!({
                        "mcpServers": {
                            "velo": {
                                "type": "http",
                                "url": format!("{}/mcp?session_id={}", clean_base, session_id)
                            }
                        }
                    })
                    .to_string();
                    c.args(["--mcp-config", &mcp_cfg]);

                    if approval_mode == "ask_before_edit" {
                        let hook_cmd = format!(
                            "curl -sS --max-time 600 -X POST \"{}/api/sessions/{}/hooks/pre-tool-use\" -H \"Content-Type: application/json\" --data-binary @- || true",
                            clean_base, session_id
                        );
                        let settings_json = json!({
                            "hooks": {
                                "PreToolUse": [
                                    {
                                        "matcher": "Bash|Edit|Write|MultiEdit",
                                        "hooks": [
                                            {
                                                "type": "command",
                                                "command": hook_cmd
                                            }
                                        ]
                                    }
                                ]
                            }
                        })
                        .to_string();
                        c.args(["--settings", &settings_json]);
                    }
                }
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
                let sandbox = if approval_mode == "bypass" {
                    "danger-full-access"
                } else {
                    "workspace-write"
                };
                let mcp_toml = if let Some(base) = daemon_http_base.filter(|b| !b.trim().is_empty())
                {
                    format!(
                        "mcp_servers={{velo={{url=\"{}/mcp?session_id={}\"}}}}",
                        base.trim_end_matches('/'),
                        session_id
                    )
                } else {
                    "mcp_servers={}".to_string()
                };
                let effective_prompt = if approval_mode == "ask_before_edit"
                    && daemon_http_base.is_some()
                {
                    format!(
                        "{}\n\n[Permission policy: Before editing files or running mutating shell commands, call MCP tool `velo_request_approval` to obtain user confirmation.]",
                        prompt
                    )
                } else {
                    prompt.to_string()
                };
                if let Some(rid) = resume_session_id.filter(|s| !s.trim().is_empty()) {
                    c.args([
                        "exec",
                        "resume",
                        "--json",
                        "--skip-git-repo-check",
                        "-c",
                        &mcp_toml,
                        "-c",
                        &format!("sandbox_mode=\"{}\"", sandbox),
                        "-c",
                        "model_reasoning_summary=\"detailed\"",
                        "-c",
                        "hide_agent_reasoning=false",
                    ]);
                    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                        c.args(["-m", m]);
                    }
                    if let Some(eff) = effort.filter(|s| !s.trim().is_empty()) {
                        c.args(["-c", &format!("model_reasoning_effort=\"{}\"", eff)]);
                    }
                    for img in images {
                        if !img.trim().is_empty() {
                            c.args(["-i", img.trim()]);
                        }
                    }
                    c.arg(rid);
                    c.arg(&effective_prompt);
                } else {
                    c.args([
                        "exec",
                        "--json",
                        "-s",
                        sandbox,
                        "--skip-git-repo-check",
                        "-c",
                        &mcp_toml,
                        "-c",
                        "model_reasoning_summary=\"detailed\"",
                        "-c",
                        "hide_agent_reasoning=false",
                    ]);
                    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                        c.args(["-m", m]);
                    }
                    if let Some(eff) = effort.filter(|s| !s.trim().is_empty()) {
                        c.args(["-c", &format!("model_reasoning_effort=\"{}\"", eff)]);
                    }
                    for img in images {
                        if !img.trim().is_empty() {
                            c.args(["-i", img.trim()]);
                        }
                    }
                    c.arg(&effective_prompt);
                }
                c
            }
            AgentProvider::Grok => {
                let bin = resolve_cli_binary("grok").unwrap_or_else(|| PathBuf::from("grok"));
                let mut c = Command::new(bin);
                if let Some(rid) = resume_session_id.filter(|s| !s.trim().is_empty()) {
                    c.arg(format!("--resume={}", rid.trim()));
                }
                let effective_prompt = if images.is_empty() {
                    prompt.to_string()
                } else {
                    format!(
                        "{}\n\n[Attached local image(s) — inspect directly with Read tool: {}]",
                        prompt,
                        images.join(", ")
                    )
                };
                c.args([
                    "-p",
                    &effective_prompt,
                    "--output-format",
                    "streaming-messages-json",
                    "--include-partial-messages",
                ]);
                if let Some(m) = model.filter(|s| {
                    let t = s.trim();
                    !t.is_empty() && t != "grok" && t != "grok-default"
                }) {
                    c.args(["-m", m]);
                }
                if let Some(eff) = effort.filter(|s| !s.trim().is_empty()) {
                    let mapped_eff = match eff.trim() {
                        "low" => "low",
                        "medium" => "medium",
                        "xhigh" | "ultra" | "max" => "xhigh",
                        _ => "high",
                    };
                    c.args(["--effort", mapped_eff]);
                }
                if approval_mode == "auto_edit" || approval_mode == "bypass" {
                    c.arg("--always-approve");
                } else {
                    c.args(["--permission-mode", "acceptEdits"]);
                }
                c
            }
            AgentProvider::Cursor => {
                let bin = resolve_cli_binary("cursor-agent")
                    .unwrap_or_else(|| PathBuf::from("cursor-agent"));
                let mut c = Command::new(bin);
                if let Some(rid) = resume_session_id.filter(|s| !s.trim().is_empty()) {
                    c.args(["--resume", rid.trim()]);
                }
                let effective_prompt = if images.is_empty() {
                    prompt.to_string()
                } else {
                    format!(
                        "{}\n\n[Attached local image(s) — inspect directly: {}]",
                        prompt,
                        images.join(", ")
                    )
                };
                c.args([
                    "-p",
                    &effective_prompt,
                    "--output-format",
                    "stream-json",
                    "--stream-partial-output",
                    "--trust",
                    "--approve-mcps",
                ]);
                if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                    let raw_m = m.trim().strip_prefix("cursor:").unwrap_or(m.trim());
                    if !raw_m.is_empty()
                        && raw_m != "auto"
                        && raw_m != "default"
                        && raw_m != "cursor"
                    {
                        c.args(["--model", raw_m]);
                    }
                }
                if approval_mode == "auto_edit" || approval_mode == "bypass" {
                    c.arg("--force");
                } else {
                    c.arg("--auto-review");
                }
                c
            }
            AgentProvider::OpenCode => {
                let bin =
                    resolve_cli_binary("opencode").unwrap_or_else(|| PathBuf::from("opencode"));
                let mut c = Command::new(bin);
                c.args(["run", "--format", "json"]);
                if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                    c.args(["-m", m]);
                }
                if let Some(rid) = resume_session_id.filter(|s| !s.trim().is_empty()) {
                    c.args(["--session", rid]);
                }
                c.arg(prompt);
                c
            }
            AgentProvider::Antigravity => {
                let bin = resolve_cli_binary("agy").unwrap_or_else(|| PathBuf::from("agy"));
                let mut c = Command::new(bin);
                if let Some(rid) = resume_session_id.filter(|s| !s.trim().is_empty()) {
                    c.args(["--conversation", rid]);
                }
                let effective_prompt = if images.is_empty() {
                    prompt.to_string()
                } else {
                    format!(
                        "{}\n\n[Attached local image(s) — inspect directly with view_file: {}]",
                        prompt,
                        images.join(", ")
                    )
                };
                c.args(["-p", &effective_prompt, "--output-format", "stream-json"]);
                if let Some(m) = model.filter(|s| {
                    let t = s.trim();
                    !t.is_empty() && t != "agy" && t != "agy-default" && t != "acp-gemini-cli"
                }) {
                    c.args(["--model", m]);
                }
                if let Some(eff) = effort.filter(|s| !s.trim().is_empty()) {
                    let mapped_eff = match eff.trim() {
                        "low" => "low",
                        "medium" => "medium",
                        _ => "high",
                    };
                    c.args(["--effort", mapped_eff]);
                }
                if approval_mode == "auto_edit" || approval_mode == "bypass" {
                    c.arg("--dangerously-skip-permissions");
                } else {
                    c.args(["--mode", "accept-edits"]);
                }
                c
            }
            AgentProvider::Copilot => {
                let bin =
                    resolve_cli_binary("copilot").unwrap_or_else(|| PathBuf::from("copilot"));
                let mut c = Command::new(bin);
                c.args(["-p", prompt]);
                c
            }
            AgentProvider::Qwen => {
                let bin = resolve_cli_binary("qwen").unwrap_or_else(|| PathBuf::from("qwen"));
                let mut c = Command::new(bin);
                c.args(["-p", prompt, "--output-format", "stream-json"]);
                if approval_mode == "auto_edit" || approval_mode == "bypass" {
                    c.arg("--yolo");
                }
                c
            }
            AgentProvider::Acp(cmd_str) | AgentProvider::Custom(cmd_str) => {
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
            AgentProvider::Grok => {
                let bin = resolve_cli_binary("grok")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "grok".to_string());
                let mut c = CommandBuilder::new(bin);
                if !prompt.trim().is_empty() {
                    c.arg(prompt);
                }
                c
            }
            AgentProvider::Cursor => {
                let bin = resolve_cli_binary("cursor-agent")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "cursor-agent".to_string());
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
            AgentProvider::Antigravity => {
                let bin = resolve_cli_binary("agy")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "agy".to_string());
                let mut c = CommandBuilder::new(bin);
                if !prompt.trim().is_empty() {
                    c.args(["-i", prompt]);
                }
                c
            }
            AgentProvider::Copilot => {
                let bin = resolve_cli_binary("copilot")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "copilot".to_string());
                let mut c = CommandBuilder::new(bin);
                if !prompt.trim().is_empty() {
                    c.args(["-p", prompt]);
                }
                c
            }
            AgentProvider::Qwen => {
                let bin = resolve_cli_binary("qwen")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "qwen".to_string());
                let mut c = CommandBuilder::new(bin);
                if !prompt.trim().is_empty() {
                    c.args(["-p", prompt]);
                }
                c
            }
            AgentProvider::Acp(raw) | AgentProvider::Custom(raw) => {
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

/// Normalizes Cursor CLI `tool_call` payloads (`{"name":...,"arguments":...}` OR typed objects like `{"shellToolCall":{"args":...,"result":...}}`).
fn extract_cursor_tool_call(tc_opt: Option<&Value>) -> (String, Value, Option<String>, bool) {
    let Some(tc) = tc_opt else {
        return ("Tool".to_string(), json!({}), None, false);
    };
    if let Some(name) = tc.get("name").and_then(|v| v.as_str()) {
        let args = tc
            .get("arguments")
            .or_else(|| tc.get("args"))
            .or_else(|| tc.get("input"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        return (name.to_string(), args, None, false);
    }
    if let Some(obj) = tc.as_object() {
        if let Some((raw_key, inner)) = obj.iter().next() {
            let kl = raw_key.to_lowercase();
            let friendly = if kl.contains("shell") || kl.contains("bash") || kl.contains("command")
            {
                "Bash"
            } else if kl.contains("read") {
                "Read"
            } else if kl.contains("edit") || kl.contains("write") || kl.contains("delete") {
                "Edit"
            } else if kl.contains("grep")
                || kl.contains("search")
                || kl.contains("glob")
                || kl.contains("ls")
            {
                "Search"
            } else {
                raw_key.as_str()
            };
            let args = inner
                .get("args")
                .or_else(|| inner.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let mut emb_out = None;
            let mut emb_err = false;
            if let Some(res) = inner.get("result") {
                emb_err = res.get("error").is_some() || res.get("rejected").is_some();
                emb_out = Some(match res {
                    Value::String(s) => s.clone(),
                    other => other
                        .pointer("/success/stdout")
                        .or_else(|| other.pointer("/success/content"))
                        .or_else(|| other.pointer("/error/message"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| other.to_string()),
                });
            }
            return (friendly.to_string(), args, emb_out, emb_err);
        }
    }
    ("Tool".to_string(), json!({}), None, false)
}

/// Parses a single stdout line from Claude Code (`stream-json`), OpenAI Codex (`--json`), Google Antigravity (`agy --output-format stream-json`), or other agents into `AgentEvent`s.
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
            // Google Antigravity CLI (`agy --output-format stream-json`) uses top-level `"event": "init" | "step_update" | "result"`.
            if json.get("type").is_none() {
                if let Some(agy_ev) = json.get("event").and_then(|v| v.as_str()) {
                    let mut events = Vec::new();
                    match agy_ev {
                        "init" => {
                            if let Some(cid) = json
                                .get("conversation_id")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.trim().is_empty())
                            {
                                events.push(AgentEvent::ProviderSessionBound {
                                    session_id,
                                    provider_session_id: cid.trim().to_string(),
                                    timestamp: Utc::now(),
                                });
                            }
                            events.push(AgentEvent::ThinkingChunk {
                                session_id,
                                delta: String::new(),
                                replace: false,
                                timestamp: Utc::now(),
                            });
                            return events;
                        }
                        "step_update" => {
                            if let Some(su) = json.get("step_update") {
                                if let Some(cid) = su
                                    .get("conversation_id")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.trim().is_empty())
                                {
                                    events.push(AgentEvent::ProviderSessionBound {
                                        session_id,
                                        provider_session_id: cid.trim().to_string(),
                                        timestamp: Utc::now(),
                                    });
                                }
                                let state = su.get("state").and_then(|v| v.as_str()).unwrap_or("");
                                let step_type =
                                    su.get("step_type").and_then(|v| v.as_str()).unwrap_or("");
                                let step_idx =
                                    su.get("step_index").and_then(|v| v.as_u64()).unwrap_or(0);

                                match step_type {
                                    "user_input" => {}
                                    "tool" => {
                                        let tool_id = format!("agy-step-{}", step_idx);
                                        let tool_name = su
                                            .get("tool_name")
                                            .or_else(|| su.pointer("/tool_info/name"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("tool")
                                            .to_string();
                                        let params = su
                                            .pointer("/tool_info/parameters")
                                            .cloned()
                                            .unwrap_or_else(|| json!({}));

                                        if state == "ACTIVE" {
                                            events.push(AgentEvent::ToolCallRequested {
                                                session_id,
                                                tool_id,
                                                tool_name,
                                                arguments: params,
                                                timestamp: Utc::now(),
                                            });
                                        } else if state == "DONE" {
                                            let out = su
                                                .pointer("/tool_info/output")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("(completed)")
                                                .to_string();
                                            events.push(AgentEvent::ToolCallCompleted {
                                                session_id,
                                                tool_id,
                                                output: out,
                                                is_error: false,
                                                timestamp: Utc::now(),
                                            });
                                        } else if state == "ERROR" {
                                            let err_msg = su
                                                .pointer("/tool_info/error/message")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("Tool execution failed")
                                                .to_string();
                                            events.push(AgentEvent::ToolCallCompleted {
                                                session_id,
                                                tool_id,
                                                output: err_msg,
                                                is_error: true,
                                                timestamp: Utc::now(),
                                            });
                                        }
                                    }
                                    "agent_response" | "thinking" => {
                                        if let Some(th) = su
                                            .get("thinking_delta")
                                            .or_else(|| su.get("thinking"))
                                            .and_then(|v| v.as_str())
                                            .filter(|s| !s.is_empty())
                                        {
                                            if state == "DONE" && su.get("thinking").is_some() {
                                                events.push(AgentEvent::ThinkingDelta {
                                                    session_id,
                                                    text: th.to_string(),
                                                    timestamp: Utc::now(),
                                                });
                                            } else {
                                                events.push(AgentEvent::ThinkingChunk {
                                                    session_id,
                                                    delta: th.to_string(),
                                                    replace: false,
                                                    timestamp: Utc::now(),
                                                });
                                            }
                                        }

                                        let text_delta =
                                            su.get("text_delta").and_then(|v| v.as_str());
                                        if let Some(td) = text_delta.filter(|s| !s.is_empty()) {
                                            events.push(AgentEvent::MessageChunk {
                                                session_id,
                                                delta: td.to_string(),
                                                replace: false,
                                                timestamp: Utc::now(),
                                            });
                                        } else if state == "DONE" && text_delta.is_none() {
                                            let think_toks = su
                                                .pointer("/usage/thinking_tokens")
                                                .and_then(|v| v.as_u64())
                                                .unwrap_or(0);
                                            if think_toks > 0 {
                                                events.push(AgentEvent::ThinkingDelta {
                                                    session_id,
                                                    text: format!(
                                                        "**Reasoning completed ({} thinking tokens)**",
                                                        think_toks
                                                    ),
                                                    timestamp: Utc::now(),
                                                });
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            return events;
                        }
                        "result" => {
                            if let Some(res) = json.get("result") {
                                if let Some(cid) = res
                                    .get("conversation_id")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.trim().is_empty())
                                {
                                    events.push(AgentEvent::ProviderSessionBound {
                                        session_id,
                                        provider_session_id: cid.trim().to_string(),
                                        timestamp: Utc::now(),
                                    });
                                }
                                if let Some(usage) = res.get("usage") {
                                    let in_tok = usage
                                        .get("input_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0)
                                        + usage
                                            .get("cache_read_tokens")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0);
                                    let out_tok = usage
                                        .get("output_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0);
                                    let total_tok = usage
                                        .get("total_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(in_tok + out_tok);
                                    if total_tok > 0 {
                                        events.push(AgentEvent::UsageUpdated {
                                            session_id,
                                            input_tokens: in_tok,
                                            output_tokens: out_tok,
                                            total_tokens: total_tok,
                                            cost_usd: 0.0,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                }
                                let status =
                                    res.get("status").and_then(|v| v.as_str()).unwrap_or("");
                                if status == "SUCCESS" {
                                    if let Some(resp) = res
                                        .get("response")
                                        .and_then(|v| v.as_str())
                                        .filter(|s| !s.trim().is_empty())
                                    {
                                        events.push(AgentEvent::MessageDelta {
                                            session_id,
                                            text: resp.to_string(),
                                            timestamp: Utc::now(),
                                        });
                                    }
                                } else if let Some(err_str) = res
                                    .get("error")
                                    .or_else(|| res.get("message"))
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.trim().is_empty())
                                {
                                    events.push(AgentEvent::Error {
                                        session_id,
                                        error: err_str.to_string(),
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                            return events;
                        }
                        _ => {
                            return events;
                        }
                    }
                }
            }

            let mut events = Vec::new();
            let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match msg_type {
                "system" | "turn.started" | "turn.completed" => {
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        if !sid.trim().is_empty() {
                            events.push(AgentEvent::ProviderSessionBound {
                                session_id,
                                provider_session_id: sid.trim().to_string(),
                                timestamp: Utc::now(),
                            });
                        }
                    }
                    if msg_type == "system"
                        && json.get("subtype").and_then(|v| v.as_str()) == Some("init")
                        && matches!(provider, AgentProvider::Grok | AgentProvider::Cursor)
                    {
                        events.push(AgentEvent::ThinkingChunk {
                            session_id,
                            delta: String::new(),
                            replace: false,
                            timestamp: Utc::now(),
                        });
                    }
                    if msg_type == "turn.completed" {
                        if let Some(usage) = json.get("usage") {
                            let input_tokens = usage
                                .get("input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let output_tokens = usage
                                .get("output_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let total_tokens = input_tokens.saturating_add(output_tokens);
                            if total_tokens > 0 {
                                let cost_usd = (input_tokens as f64 * 0.000_0025)
                                    + (output_tokens as f64 * 0.000_01);
                                events.push(AgentEvent::UsageUpdated {
                                    session_id,
                                    input_tokens,
                                    output_tokens,
                                    total_tokens,
                                    cost_usd,
                                    timestamp: Utc::now(),
                                });
                            }
                        }
                    }
                    return events;
                }
                // Claude Code `--include-partial-messages` token-by-token streaming (thinking + tool start + text)
                "stream_event" => {
                    if let Some(ev) = json.get("event") {
                        let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match ev_type {
                            "content_block_start" => {
                                if let Some(cb) = ev.get("content_block") {
                                    let cb_type =
                                        cb.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    if cb_type == "tool_use" {
                                        let tool_id = cb
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("tool")
                                            .to_string();
                                        let tool_name = cb
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("Tool")
                                            .to_string();
                                        let arguments = cb
                                            .get("input")
                                            .cloned()
                                            .unwrap_or_else(|| json!({}));
                                        events.push(AgentEvent::ToolCallRequested {
                                            session_id,
                                            tool_id,
                                            tool_name,
                                            arguments,
                                            timestamp: Utc::now(),
                                        });
                                    } else if cb_type == "thinking" {
                                        let initial = cb
                                            .get("thinking")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        events.push(AgentEvent::ThinkingChunk {
                                            session_id,
                                            delta: initial.to_string(),
                                            replace: false,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                }
                            }
                            "content_block_delta" => {
                                if let Some(delta) = ev.get("delta") {
                                    let delta_type =
                                        delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    if delta_type == "text_delta" {
                                        if let Some(t) = delta.get("text").and_then(|v| v.as_str())
                                        {
                                            if !t.is_empty() {
                                                events.push(AgentEvent::MessageChunk {
                                                    session_id,
                                                    delta: t.to_string(),
                                                    replace: false,
                                                    timestamp: Utc::now(),
                                                });
                                            }
                                        }
                                    } else if delta_type == "thinking_delta" {
                                        if let Some(th) =
                                            delta.get("thinking").and_then(|v| v.as_str())
                                        {
                                            if !th.is_empty() {
                                                events.push(AgentEvent::ThinkingChunk {
                                                    session_id,
                                                    delta: th.to_string(),
                                                    replace: false,
                                                    timestamp: Utc::now(),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    return events;
                }
                // 1. Claude Code / Grok CLI (`streaming-messages-json`) / Cursor CLI (`stream-json`) assistant events
                "assistant" => {
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        if !sid.trim().is_empty() {
                            events.push(AgentEvent::ProviderSessionBound {
                                session_id,
                                provider_session_id: sid.trim().to_string(),
                                timestamp: Utc::now(),
                            });
                        }
                    }
                    if let Some(usage) = json.pointer("/message/usage") {
                        let in_tok = usage
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0)
                            + usage
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0)
                            + usage
                                .get("cache_creation_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                        let out_tok = usage
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        if in_tok + out_tok > 0 {
                            events.push(AgentEvent::UsageUpdated {
                                session_id,
                                input_tokens: in_tok,
                                output_tokens: out_tok,
                                total_tokens: in_tok + out_tok,
                                cost_usd: 0.0,
                                timestamp: Utc::now(),
                            });
                        }
                    }
                    let is_cursor_partial = matches!(provider, AgentProvider::Cursor)
                        && (json.get("timestamp_ms").is_some()
                            || json.get("subtype").and_then(|v| v.as_str()) == Some("delta"));
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
                                        if is_cursor_partial {
                                            if !text.is_empty() {
                                                events.push(AgentEvent::MessageChunk {
                                                    session_id,
                                                    delta: text.to_string(),
                                                    replace: false,
                                                    timestamp: Utc::now(),
                                                });
                                            }
                                        } else {
                                            events.push(AgentEvent::MessageDelta {
                                                session_id,
                                                text: text.to_string(),
                                                timestamp: Utc::now(),
                                            });
                                        }
                                    }
                                }
                                "thinking" => {
                                    if let Some(thinking) =
                                        item.get("thinking").and_then(|v| v.as_str())
                                    {
                                        if is_cursor_partial {
                                            events.push(AgentEvent::ThinkingChunk {
                                                session_id,
                                                delta: thinking.to_string(),
                                                replace: false,
                                                timestamp: Utc::now(),
                                            });
                                        } else {
                                            events.push(AgentEvent::ThinkingDelta {
                                                session_id,
                                                text: thinking.to_string(),
                                                timestamp: Utc::now(),
                                            });
                                        }
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
                // Cursor CLI (`stream-json`) thinking & tool_call events + Grok CLI (`streaming-json`) thought/end
                "thinking" | "thought" => {
                    let subtype = json.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                    let txt = json
                        .get("text")
                        .or_else(|| json.get("delta"))
                        .or_else(|| json.get("data"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if subtype == "completed" {
                        if !txt.trim().is_empty() {
                            events.push(AgentEvent::ThinkingDelta {
                                session_id,
                                text: txt.to_string(),
                                timestamp: Utc::now(),
                            });
                        }
                    } else {
                        events.push(AgentEvent::ThinkingChunk {
                            session_id,
                            delta: txt.to_string(),
                            replace: false,
                            timestamp: Utc::now(),
                        });
                    }
                    return events;
                }
                "tool_call" => {
                    let subtype = json
                        .get("subtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or("started");
                    let call_id = json
                        .get("call_id")
                        .or_else(|| json.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("cursor-tool")
                        .to_string();
                    let (tool_name, arguments, embedded_out, embedded_err) =
                        extract_cursor_tool_call(json.get("tool_call"));
                    if subtype == "completed" {
                        let (out_str, is_err) = if let Some(top_res) = json.get("result") {
                            let is_e = json
                                .get("is_error")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                                || top_res.get("error").is_some()
                                || top_res.get("rejected").is_some();
                            let s = match top_res {
                                Value::String(st) => st.clone(),
                                other => other
                                    .pointer("/success/stdout")
                                    .or_else(|| other.pointer("/success/content"))
                                    .or_else(|| other.get("output"))
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                                    .unwrap_or_else(|| other.to_string()),
                            };
                            (s, is_e)
                        } else if let Some(emb) = embedded_out {
                            (emb, embedded_err)
                        } else {
                            ("(completed)".to_string(), false)
                        };
                        events.push(AgentEvent::ToolCallCompleted {
                            session_id,
                            tool_id: call_id,
                            output: out_str,
                            is_error: is_err,
                            timestamp: Utc::now(),
                        });
                    } else {
                        events.push(AgentEvent::ToolCallRequested {
                            session_id,
                            tool_id: call_id,
                            tool_name,
                            arguments,
                            timestamp: Utc::now(),
                        });
                    }
                    return events;
                }
                "end" => {
                    if let Some(sid) = json
                        .get("sessionId")
                        .or_else(|| json.get("session_id"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                    {
                        events.push(AgentEvent::ProviderSessionBound {
                            session_id,
                            provider_session_id: sid.trim().to_string(),
                            timestamp: Utc::now(),
                        });
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
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        if !sid.trim().is_empty() {
                            events.push(AgentEvent::ProviderSessionBound {
                                session_id,
                                provider_session_id: sid.trim().to_string(),
                                timestamp: Utc::now(),
                            });
                        }
                    }
                    let cost_usd = json
                        .get("total_cost_usd")
                        .or_else(|| json.get("cost_usd"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    if let Some(usage) = json.get("usage") {
                        let in_tok = usage
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0)
                            + usage
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0)
                            + usage
                                .get("cache_creation_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                        let out_tok = usage
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        if in_tok + out_tok > 0 || cost_usd > 0.0 {
                            events.push(AgentEvent::UsageUpdated {
                                session_id,
                                input_tokens: in_tok,
                                output_tokens: out_tok,
                                total_tokens: in_tok + out_tok,
                                cost_usd,
                                timestamp: Utc::now(),
                            });
                        }
                    }
                    let is_err = json
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                        || json.get("subtype").and_then(|v| v.as_str())
                            == Some("error_during_execution");
                    if is_err {
                        if let Some(result_text) = json
                            .get("result")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.trim().is_empty())
                        {
                            events.push(AgentEvent::Error {
                                session_id,
                                error: result_text.to_string(),
                                timestamp: Utc::now(),
                            });
                        } else if let Some(errs) = json.get("errors").and_then(|v| v.as_array()) {
                            let joined: Vec<String> = errs
                                .iter()
                                .filter_map(|e| e.as_str().map(str::to_string))
                                .collect();
                            if !joined.is_empty() {
                                events.push(AgentEvent::Error {
                                    session_id,
                                    error: joined.join("; "),
                                    timestamp: Utc::now(),
                                });
                            }
                        }
                    }
                    return events;
                }
                // 2. OpenAI Codex `--json` JSONL events (live `item.started` / `item.updated` / `item.completed`)
                "item.completed" | "item.started" | "item.updated" => {
                    if let Some(item) = json.get("item") {
                        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match item_type {
                            "reasoning" => {
                                let mut extracted = String::new();
                                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                    if !text.trim().is_empty() {
                                        extracted = format!("{}\n", text.trim());
                                    }
                                } else if let Some(summary_arr) =
                                    item.get("summary").and_then(|v| v.as_array())
                                {
                                    for s in summary_arr {
                                        if let Some(t) = s.get("text").and_then(|v| v.as_str()) {
                                            if !t.trim().is_empty() {
                                                extracted.push_str(t.trim());
                                                extracted.push('\n');
                                            }
                                        }
                                    }
                                }
                                if msg_type == "item.started" {
                                    // Immediately surface live Thinking shimmer badge when Codex begins reasoning
                                    events.push(AgentEvent::ThinkingChunk {
                                        session_id,
                                        delta: extracted,
                                        replace: true,
                                        timestamp: Utc::now(),
                                    });
                                } else if !extracted.is_empty() {
                                    if msg_type == "item.updated" {
                                        events.push(AgentEvent::ThinkingChunk {
                                            session_id,
                                            delta: extracted,
                                            replace: true,
                                            timestamp: Utc::now(),
                                        });
                                    } else {
                                        events.push(AgentEvent::ThinkingDelta {
                                            session_id,
                                            text: extracted,
                                            timestamp: Utc::now(),
                                        });
                                    }
                                }
                            }
                            "agent_message" => {
                                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                    if !text.trim().is_empty() {
                                        if msg_type == "item.completed" {
                                            events.push(AgentEvent::MessageDelta {
                                                session_id,
                                                text: text.to_string(),
                                                timestamp: Utc::now(),
                                            });
                                        } else if msg_type == "item.updated" {
                                            events.push(AgentEvent::MessageChunk {
                                                session_id,
                                                delta: text.to_string(),
                                                replace: true,
                                                timestamp: Utc::now(),
                                            });
                                        }
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
                            "mcp_tool_call" => {
                                let tool_id = item
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("mcp")
                                    .to_string();
                                let tool_label = item
                                    .get("tool")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("mcp_tool");
                                let server = item
                                    .get("server")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("mcp");
                                let args = item
                                    .get("arguments")
                                    .cloned()
                                    .unwrap_or_else(|| serde_json::json!({}));
                                if msg_type == "item.started" {
                                    events.push(AgentEvent::ToolCallRequested {
                                        session_id,
                                        tool_id,
                                        tool_name: format!("MCP · {}:{}", server, tool_label),
                                        arguments: args,
                                        timestamp: Utc::now(),
                                    });
                                } else if msg_type == "item.completed" {
                                    let err_val = item.get("error").filter(|v| !v.is_null());
                                    let is_error = err_val.is_some();
                                    let output = if let Some(e) = err_val {
                                        e.to_string()
                                    } else if let Some(res) = item.get("result") {
                                        if let Some(s) = res.as_str() {
                                            s.to_string()
                                        } else {
                                            res.to_string()
                                        }
                                    } else {
                                        "(completed)".to_string()
                                    };
                                    events.push(AgentEvent::ToolCallCompleted {
                                        session_id,
                                        tool_id,
                                        output,
                                        is_error,
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                            "web_search" => {
                                let tool_id = item
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("search")
                                    .to_string();
                                let query = item
                                    .get("query")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if msg_type == "item.started" {
                                    events.push(AgentEvent::ToolCallRequested {
                                        session_id,
                                        tool_id,
                                        tool_name: "Search".to_string(),
                                        arguments: serde_json::json!({ "query": query }),
                                        timestamp: Utc::now(),
                                    });
                                } else if msg_type == "item.completed" {
                                    events.push(AgentEvent::ToolCallCompleted {
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
                "thread.started" | "init" | "step_start" => {
                    if let Some(tid) = json
                        .get("thread_id")
                        .or_else(|| json.get("session_id"))
                        .or_else(|| json.get("sessionID"))
                        .and_then(|v| v.as_str())
                    {
                        if !tid.trim().is_empty() {
                            events.push(AgentEvent::ProviderSessionBound {
                                session_id,
                                provider_session_id: tid.trim().to_string(),
                                timestamp: Utc::now(),
                            });
                        }
                    }
                    return events;
                }
                // OpenCode (`--format json`) text/tool events
                "text" | "message" => {
                    if let Some(sid) = json.get("sessionID").and_then(|v| v.as_str()) {
                        events.push(AgentEvent::ProviderSessionBound {
                            session_id,
                            provider_session_id: sid.to_string(),
                            timestamp: Utc::now(),
                        });
                    }
                    let role = json.get("role").and_then(|v| v.as_str()).unwrap_or("assistant");
                    if role == "assistant" {
                        if let Some(t) = json
                            .pointer("/part/text")
                            .or_else(|| json.get("content"))
                            .and_then(|v| v.as_str())
                        {
                            if !t.is_empty() {
                                if json.get("delta").and_then(|v| v.as_bool()).unwrap_or(false) {
                                    events.push(AgentEvent::MessageChunk {
                                        session_id,
                                        delta: t.to_string(),
                                        replace: false,
                                        timestamp: Utc::now(),
                                    });
                                } else {
                                    events.push(AgentEvent::MessageDelta {
                                        session_id,
                                        text: t.to_string(),
                                        timestamp: Utc::now(),
                                    });
                                }
                            }
                        }
                    }
                    return events;
                }
                _ => {
                    debug!("Unhandled JSON event from {}: {}", provider, msg_type);
                    return events;
                }
            }
        }
    }

    if matches!(provider, AgentProvider::Antigravity) && trimmed.starts_with("jetski:") {
        return vec![AgentEvent::Error {
            session_id,
            error: trimmed.to_string(),
            timestamp: Utc::now(),
        }];
    }

    vec![AgentEvent::MessageDelta {
        session_id,
        text: line.to_string(),
        timestamp: Utc::now(),
    }]
}

/// Persistent interactive PTY shell bound to an isolated Git worktree (for the right-hand Terminal drawer).
pub struct InteractiveShellHandle {
    pub pid: Option<u32>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    scrollback: Arc<Mutex<String>>,
    kill_tx: Option<oneshot::Sender<()>>,
}

impl InteractiveShellHandle {
    pub fn write_input(&self, data: &str) -> Result<()> {
        if let Ok(mut guard) = self.writer.lock() {
            guard.write_all(data.as_bytes())?;
            guard.flush()?;
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if let Ok(guard) = self.master.lock() {
            let _ = guard.resize(PtySize {
                rows: rows.max(10),
                cols: cols.max(40),
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        Ok(())
    }

    pub fn scrollback(&self) -> String {
        self.scrollback
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.kill_tx.take() {
            let _ = tx.send(());
        }
    }
}

pub fn spawn_interactive_shell(
    session_id: Uuid,
    worktree_path: PathBuf,
    cols: u16,
    rows: u16,
    event_tx: broadcast::Sender<AgentEvent>,
) -> Result<InteractiveShellHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(16),
            cols: cols.max(60),
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("Failed to open interactive terminal PTY")?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-i");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PATH", discover_augmented_path());
    if worktree_path.is_dir() {
        cmd.cwd(&worktree_path);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .with_context(|| format!("Failed to spawn interactive shell `{}`", shell))?;

    let pid = child.process_id();
    let mut killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .context("Failed to clone shell PTY reader")?;
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .context("Failed to take shell PTY writer")?,
    ));
    let master = Arc::new(Mutex::new(pair.master));
    let scrollback = Arc::new(Mutex::new(String::new()));
    let scrollback_reader = Arc::clone(&scrollback);

    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Ok(mut sb) = scrollback_reader.lock() {
                        sb.push_str(&chunk);
                        if sb.len() > 65_536 {
                            let drain_to = sb.len() - 49_152;
                            let safe_idx = sb
                                .char_indices()
                                .find(|(i, _)| *i >= drain_to)
                                .map(|(i, _)| i)
                                .unwrap_or(0);
                            sb.drain(..safe_idx);
                        }
                    }
                    let _ = event_tx.send(AgentEvent::TerminalOutput {
                        session_id,
                        data: chunk,
                        timestamp: Utc::now(),
                    });
                }
            }
        }
    });

    let mut wait_handle = tokio::task::spawn_blocking(move || child.wait());
    tokio::spawn(async move {
        tokio::select! {
            _ = &mut kill_rx => {
                let _ = killer.kill();
            }
            _ = &mut wait_handle => {}
        }
    });

    Ok(InteractiveShellHandle {
        pid,
        master,
        writer,
        scrollback,
        kill_tx: Some(kill_rx_guard_noop(kill_tx)),
    })
}

#[inline]
fn kill_rx_guard_noop(tx: oneshot::Sender<()>) -> oneshot::Sender<()> {
    tx
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

    #[test]
    fn test_parse_claude_partial_stream_events() {
        let sid = Uuid::new_v4();
        let th = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Inspecting handlers..."}}}"#;
        let tl = r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_99","name":"Read","input":{}}}}"#;
        let tx = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done!"}}}"#;

        let ev_th = parse_agent_stdout_line(sid, &AgentProvider::Claude, th);
        assert!(matches!(
            ev_th.first(),
            Some(AgentEvent::ThinkingChunk { replace: false, .. })
        ));

        let ev_tl = parse_agent_stdout_line(sid, &AgentProvider::Claude, tl);
        assert!(matches!(
            ev_tl.first(),
            Some(AgentEvent::ToolCallRequested { tool_name, .. }) if tool_name == "Read"
        ));

        let ev_tx = parse_agent_stdout_line(sid, &AgentProvider::Claude, tx);
        assert!(matches!(
            ev_tx.first(),
            Some(AgentEvent::MessageChunk { replace: false, .. })
        ));
    }

    #[test]
    fn test_parse_codex_live_lifecycle_events() {
        let sid = Uuid::new_v4();
        let r_start = r#"{"type":"item.started","item":{"id":"item_0","type":"reasoning","text":""}}"#;
        let r_upd = r#"{"type":"item.updated","item":{"id":"item_0","type":"reasoning","text":"**Checking git status**"}}"#;
        let mcp_start = r#"{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"velo","tool":"velo_list_sessions","arguments":{}}}"#;
        let msg_upd = r#"{"type":"item.updated","item":{"id":"item_2","type":"agent_message","text":"Working on"}}"#;
        let msg_done = r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Working on it now."}}"#;

        assert!(matches!(
            parse_agent_stdout_line(sid, &AgentProvider::Codex, r_start).first(),
            Some(AgentEvent::ThinkingChunk { replace: true, .. })
        ));
        assert!(matches!(
            parse_agent_stdout_line(sid, &AgentProvider::Codex, r_upd).first(),
            Some(AgentEvent::ThinkingChunk { replace: true, .. })
        ));
        assert!(matches!(
            parse_agent_stdout_line(sid, &AgentProvider::Codex, mcp_start).first(),
            Some(AgentEvent::ToolCallRequested { .. })
        ));
        assert!(matches!(
            parse_agent_stdout_line(sid, &AgentProvider::Codex, msg_upd).first(),
            Some(AgentEvent::MessageChunk { replace: true, .. })
        ));
        assert!(matches!(
            parse_agent_stdout_line(sid, &AgentProvider::Codex, msg_done).first(),
            Some(AgentEvent::MessageDelta { .. })
        ));
    }

    #[test]
    fn test_parse_antigravity_agy_stream_json_events() {
        let sid = Uuid::new_v4();
        let init_line = r#"{"event":"init","conversation_id":"4f4a7797-aeea-40fe-952c-e2a6643fa38a","init":{"cwd":"/Users/daiyudai/code/velo","permission_mode":"always-proceed"}}"#;
        let think_done = r#"{"event":"step_update","step_update":{"conversation_id":"4f4a7797-aeea-40fe-952c-e2a6643fa38a","step_index":1,"state":"DONE","step_type":"agent_response","usage":{"thinking_tokens":228,"total_tokens":8468}}}"#;
        let tool_active = r#"{"event":"step_update","step_update":{"conversation_id":"4f4a7797-aeea-40fe-952c-e2a6643fa38a","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"}}}}"#;
        let tool_done = r#"{"event":"step_update","step_update":{"conversation_id":"4f4a7797-aeea-40fe-952c-e2a6643fa38a","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"},"output":"Cargo.toml\n"}}}"#;
        let text_chunk = r#"{"event":"step_update","step_update":{"conversation_id":"4f4a7797-aeea-40fe-952c-e2a6643fa38a","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"6"}}"#;
        let result_line = r#"{"event":"result","result":{"conversation_id":"4f4a7797-aeea-40fe-952c-e2a6643fa38a","status":"SUCCESS","response":"6\n","usage":{"input_tokens":100,"output_tokens":10,"cache_read_tokens":50,"total_tokens":160}}}"#;

        let ev_init = parse_agent_stdout_line(sid, &AgentProvider::Antigravity, init_line);
        assert!(ev_init
            .iter()
            .any(|e| matches!(e, AgentEvent::ProviderSessionBound { provider_session_id, .. } if provider_session_id == "4f4a7797-aeea-40fe-952c-e2a6643fa38a")));
        assert!(ev_init
            .iter()
            .any(|e| matches!(e, AgentEvent::ThinkingChunk { .. })));

        let ev_think = parse_agent_stdout_line(sid, &AgentProvider::Antigravity, think_done);
        assert!(ev_think
            .iter()
            .any(|e| matches!(e, AgentEvent::ThinkingDelta { .. })));

        let ev_t_act = parse_agent_stdout_line(sid, &AgentProvider::Antigravity, tool_active);
        assert!(ev_t_act
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCallRequested { tool_id, tool_name, .. } if tool_id == "agy-step-2" && tool_name == "run_command")));

        let ev_t_done = parse_agent_stdout_line(sid, &AgentProvider::Antigravity, tool_done);
        assert!(ev_t_done
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCallCompleted { tool_id, is_error: false, .. } if tool_id == "agy-step-2")));

        let ev_chunk = parse_agent_stdout_line(sid, &AgentProvider::Antigravity, text_chunk);
        assert!(ev_chunk
            .iter()
            .any(|e| matches!(e, AgentEvent::MessageChunk { delta, .. } if delta == "6")));

        let ev_res = parse_agent_stdout_line(sid, &AgentProvider::Antigravity, result_line);
        assert!(ev_res
            .iter()
            .any(|e| matches!(e, AgentEvent::UsageUpdated { total_tokens: 160, .. })));
        assert!(ev_res
            .iter()
            .any(|e| matches!(e, AgentEvent::MessageDelta { text, .. } if text == "6\n")));
    }

    #[test]
    fn test_parse_grok_cli_stream_events() {
        let sid = Uuid::new_v4();
        let init_line = r#"{"type":"system","subtype":"init","session_id":"grok-sess-42","uuid":"00000000-0000-0000-0000-000000000001"}"#;
        let partial_text = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Grok 4.7 ready"}}}"#;
        let err_result = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"","errors":["Not signed in. Run 'grok login' to authenticate"]}"#;

        let ev_init = parse_agent_stdout_line(sid, &AgentProvider::Grok, init_line);
        assert!(ev_init.iter().any(|e| matches!(
            e,
            AgentEvent::ProviderSessionBound { provider_session_id, .. } if provider_session_id == "grok-sess-42"
        )));
        assert!(ev_init
            .iter()
            .any(|e| matches!(e, AgentEvent::ThinkingChunk { .. })));

        let ev_chunk = parse_agent_stdout_line(sid, &AgentProvider::Grok, partial_text);
        assert!(ev_chunk.iter().any(|e| matches!(
            e,
            AgentEvent::MessageChunk { delta, replace: false, .. } if delta == "Grok 4.7 ready"
        )));

        let ev_err = parse_agent_stdout_line(sid, &AgentProvider::Grok, err_result);
        assert!(ev_err.iter().any(|e| matches!(
            e,
            AgentEvent::Error { error, .. } if error.contains("grok login")
        )));
    }

    #[test]
    fn test_parse_cursor_cli_stream_events() {
        let sid = Uuid::new_v4();
        let sys_line = r#"{"type":"system","subtype":"init","session_id":"cursor-chat-99","model":"claude-sonnet-4-6"}"#;
        let think_line = r#"{"type":"thinking","subtype":"delta","text":"Inspecting repo..."}"#;
        let tool_start = r#"{"type":"tool_call","subtype":"started","call_id":"call_1","tool_call":{"shellToolCall":{"args":{"command":"cargo check"}}}}"#;
        let tool_done = r#"{"type":"tool_call","subtype":"completed","call_id":"call_1","tool_call":{"shellToolCall":{"args":{"command":"cargo check"},"result":{"success":{"stdout":"Finished dev profile"}}}}}"#;
        let partial_asst = r#"{"type":"assistant","timestamp_ms":1794400000123,"message":{"role":"assistant","content":[{"type":"text","text":"All checks "}]}}"#;
        let final_asst = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"All checks passed."}]}}"#;

        let ev_sys = parse_agent_stdout_line(sid, &AgentProvider::Cursor, sys_line);
        assert!(ev_sys.iter().any(|e| matches!(
            e,
            AgentEvent::ProviderSessionBound { provider_session_id, .. } if provider_session_id == "cursor-chat-99"
        )));

        let ev_th = parse_agent_stdout_line(sid, &AgentProvider::Cursor, think_line);
        assert!(ev_th.iter().any(|e| matches!(
            e,
            AgentEvent::ThinkingChunk { delta, .. } if delta == "Inspecting repo..."
        )));

        let ev_ts = parse_agent_stdout_line(sid, &AgentProvider::Cursor, tool_start);
        assert!(ev_ts.iter().any(|e| matches!(
            e,
            AgentEvent::ToolCallRequested { tool_id, tool_name, .. } if tool_id == "call_1" && tool_name == "Bash"
        )));

        let ev_td = parse_agent_stdout_line(sid, &AgentProvider::Cursor, tool_done);
        assert!(ev_td.iter().any(|e| matches!(
            e,
            AgentEvent::ToolCallCompleted { tool_id, output, is_error: false, .. } if tool_id == "call_1" && output.contains("Finished dev profile")
        )));

        let ev_part = parse_agent_stdout_line(sid, &AgentProvider::Cursor, partial_asst);
        assert!(ev_part.iter().any(|e| matches!(
            e,
            AgentEvent::MessageChunk { delta, replace: false, .. } if delta == "All checks "
        )));

        let ev_fin = parse_agent_stdout_line(sid, &AgentProvider::Cursor, final_asst);
        assert!(ev_fin.iter().any(|e| matches!(
            e,
            AgentEvent::MessageDelta { text, .. } if text == "All checks passed."
        )));
    }
}
