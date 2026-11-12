use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    env,
    net::SocketAddr,
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use tracing_subscriber::EnvFilter;
use velo_protocol::{
    AdvisorSessionRequest, AgentEvent, AgentProvider, CommitteeRequest, CreateSessionRequest,
    DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT, HandoffSessionRequest, LoopSessionRequest,
    SessionInfo, WsServerMessage,
};
use velo_relay::{DEFAULT_RELAY_PORT, PairingTicket};

#[derive(Parser, Debug)]
#[command(
    name = "velo",
    version,
    about = "Velo: Blazing-fast Rust control plane for parallel AI coding agents & Git worktrees"
)]
struct Cli {
    /// Daemon host:port
    #[arg(long, env = "VELO_ADDR", default_value_t = format!("{}:{}", DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT))]
    addr: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Start the Velo background daemon (and embedded Web UI on port 6767)
    Up {
        /// Run in foreground instead of detaching
        #[arg(short, long)]
        foreground: bool,
    },

    /// Check daemon health and active workspace summary
    Status,

    /// Dispatch a coding agent task inside an isolated Git worktree
    Run {
        /// Task prompt for the coding agent
        prompt: String,

        /// Coding agent provider (`claude`, `codex`, `opencode`, or custom command)
        #[arg(short, long, default_value = "claude")]
        agent: String,

        /// Git branch name to create/checkout in the isolated worktree
        #[arg(short, long)]
        branch: Option<String>,

        /// Target repository directory (defaults to current working directory)
        #[arg(short, long)]
        repo: Option<PathBuf>,

        /// Optional human-friendly session name
        #[arg(short, long)]
        name: Option<String>,

        /// Spawn inside a full interactive pseudo-terminal (PTY)
        #[arg(long)]
        pty: bool,
    },

    /// List all orchestrated agent sessions and their Git worktree states
    #[command(visible_alias = "ls", visible_alias = "list")]
    Ps,

    /// View structured event logs for a session (accepts full UUID or prefix)
    Logs {
        /// Session ID or prefix
        session: String,

        /// Stream live events in real time
        #[arg(short, long)]
        follow: bool,
    },

    /// Inspect live Git diff and modified file stats for a session's worktree
    Diff {
        /// Session ID or prefix
        session: String,
    },

    /// Stop a running agent session
    Stop {
        /// Session ID or prefix
        session: String,
    },

    /// Hand off an existing session's worktree and progress to another coding agent
    Handoff {
        /// Source session ID or prefix
        session: String,

        /// Target agent provider (`codex`, `claude`, `opencode`, etc.)
        #[arg(long)]
        to: String,

        /// Additional handoff instructions for the target agent
        #[arg(short, long)]
        instructions: Option<String>,
    },

    /// Spin up an independent secondary agent to review a session's diff & provide a second opinion
    Advisor {
        /// Target session ID or prefix to review
        session: String,

        /// Advisor agent provider (`codex`, `claude`, `opencode`)
        #[arg(short, long, default_value = "codex")]
        agent: String,

        /// Specific question or review focus for the advisor
        #[arg(short, long)]
        question: Option<String>,
    },

    /// Dispatch multiple contrasting agents in parallel isolated worktrees to solve a task
    Committee {
        /// Problem statement or task prompt for the committee
        prompt: String,

        /// Comma-separated list of agent providers (e.g. `claude,codex,opencode`)
        #[arg(short, long, default_value = "claude,codex")]
        agents: String,

        /// Target repository directory
        #[arg(short, long)]
        repo: Option<PathBuf>,

        /// Optional committee name prefix
        #[arg(short, long)]
        name: Option<String>,
    },

    /// Run an agent in a test-driven self-healing loop until an acceptance command passes
    Loop {
        /// Task prompt for the coding agent
        prompt: String,

        /// Shell command that must exit 0 to pass acceptance (e.g. `cargo test` or `pnpm test`)
        #[arg(short, long)]
        check: String,

        /// Coding agent provider (`claude`, `codex`, `opencode`)
        #[arg(short, long, default_value = "claude")]
        agent: String,

        /// Maximum self-healing iterations
        #[arg(short, long, default_value_t = 3)]
        max_iterations: u32,

        /// Target repository directory
        #[arg(short, long)]
        repo: Option<PathBuf>,

        /// Optional Git branch name
        #[arg(short, long)]
        branch: Option<String>,
    },

    /// Start Velo's stdio MCP (Model Context Protocol) server for Claude Code / Cursor / Codex
    Mcp,

    /// Generate an E2EE pairing ticket & terminal QR code for mobile/remote control
    Pair {
        /// Relay WebSocket URL
        #[arg(long, default_value_t = format!("ws://127.0.0.1:{}", DEFAULT_RELAY_PORT))]
        relay: String,
    },

    /// Run the self-hosted Velo E2EE WebSocket relay server
    Relay {
        /// Listen address for the relay server
        #[arg(long, default_value_t = format!("0.0.0.0:{}", DEFAULT_RELAY_PORT))]
        listen: String,
    },

    /// Manage macOS background LaunchAgent (`com.velo.daemon`) for always-on boot autostart
    Service {
        /// Action: `install` | `uninstall` | `status` | `restart`
        #[arg(default_value = "status")]
        action: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let addr = &cli.addr;

    match cli.command {
        Commands::Up { foreground } => {
            if foreground {
                let sock_addr: SocketAddr = addr
                    .parse()
                    .with_context(|| format!("Invalid socket address: {}", addr))?;
                velo_daemon::run_daemon_server(sock_addr).await?;
            } else {
                ensure_daemon_running(addr).await?;
                println!("⚡ Velo daemon & Web UI running at http://{}", addr);
            }
        }
        Commands::Status => match http_get_json::<Value>(addr, "/api/health").await {
            Ok(health) => {
                let sessions: Vec<SessionInfo> =
                    http_get_json(addr, "/api/sessions").await.unwrap_or_default();
                let running = sessions
                    .iter()
                    .filter(|s| s.status == velo_protocol::SessionStatus::Running)
                    .count();
                println!("⚡ Velo Daemon: ONLINE (http://{})", addr);
                println!(
                    "   Version:     {}",
                    health
                        .get("version")
                        .and_then(|v| v.as_str())
                        .unwrap_or("0.1.0")
                );
                println!(
                    "   Sessions:    {} total ({} running)",
                    sessions.len(),
                    running
                );
            }
            Err(_) => {
                println!("⚪ Velo Daemon: OFFLINE (run `velo up` to start)");
            }
        },
        Commands::Run {
            prompt,
            agent,
            branch,
            repo,
            name,
            pty,
        } => {
            ensure_daemon_running(addr).await?;
            let repo_dir = match repo {
                Some(p) => p,
                None => env::current_dir().context("Failed to get current directory")?,
            };
            let abs_repo = repo_dir.canonicalize().unwrap_or(repo_dir);

            let req = CreateSessionRequest {
                name,
                provider: AgentProvider::from_str_loose(&agent),
                prompt,
                repo_path: abs_repo.to_string_lossy().to_string(),
                branch,
                use_pty: pty,
                parent_session_id: None,
                model: None,
                effort: None,
                images: Vec::new(),
                approval_mode: None,
                setup_command: None,
            };

            let session: SessionInfo = http_post_json(addr, "/api/sessions", &req).await?;
            println!("🚀 Spawned Velo Session [{}]", &session.id.to_string()[..8]);
            println!("   Name:      {}", session.name);
            println!("   Agent:     {} (PID: {:?})", session.provider, session.pid);
            println!("   Branch:    {}", session.branch);
            println!("   Worktree:  {}", session.worktree_path);
            println!(
                "   Logs:      velo logs {} --follow",
                &session.id.to_string()[..8]
            );
        }
        Commands::Ps => {
            ensure_daemon_running(addr).await?;
            let sessions: Vec<SessionInfo> = http_get_json(addr, "/api/sessions").await?;
            if sessions.is_empty() {
                println!(
                    "No sessions found. Start one with: velo run --agent claude \"your task\""
                );
                return Ok(());
            }

            println!(
                "{:<10} {:<18} {:<12} {:<20} {:<12} {:<14} {}",
                "ID", "NAME", "AGENT", "BRANCH", "STATUS", "DIFF", "WORKTREE"
            );
            println!("{}", "-".repeat(105));
            for s in sessions {
                let short_id = &s.id.to_string()[..8];
                let diff_badge = format!(
                    "{}f +{} -{}",
                    s.diff_stats.files_changed, s.diff_stats.insertions, s.diff_stats.deletions
                );
                println!(
                    "{:<10} {:<18} {:<12} {:<20} {:<12} {:<14} {}",
                    short_id,
                    truncate(&s.name, 17),
                    truncate(&s.provider.to_string(), 11),
                    truncate(&s.branch, 19),
                    s.status.to_string(),
                    diff_badge,
                    s.worktree_path
                );
            }
        }
        Commands::Logs { session, follow } => {
            ensure_daemon_running(addr).await?;
            let target = resolve_session(addr, &session).await?;
            let events: Vec<AgentEvent> =
                http_get_json(addr, &format!("/api/sessions/{}/events", target.id)).await?;

            println!(
                "=== Session {} ({}) | Branch: {} | Status: {} ===",
                &target.id.to_string()[..8],
                target.provider,
                target.branch,
                target.status
            );
            for ev in &events {
                print_agent_event(ev);
            }

            if follow {
                let ws_url = format!("ws://{}/ws", addr);
                let (mut ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
                    .await
                    .context("Failed to connect to daemon WebSocket")?;

                while let Some(Ok(msg)) = ws_stream.next().await {
                    if let tokio_tungstenite::tungstenite::Message::Text(txt) = msg {
                        if let Ok(WsServerMessage::Event { event }) =
                            serde_json::from_str::<WsServerMessage>(&txt)
                        {
                            if event.session_id() == target.id {
                                print_agent_event(&event);
                                if let AgentEvent::StatusChanged { status, .. } = event {
                                    if matches!(
                                        status,
                                        velo_protocol::SessionStatus::Completed
                                            | velo_protocol::SessionStatus::Failed
                                            | velo_protocol::SessionStatus::Stopped
                                    ) {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        Commands::Diff { session } => {
            ensure_daemon_running(addr).await?;
            let target = resolve_session(addr, &session).await?;
            let resp: Value =
                http_get_json(addr, &format!("/api/sessions/{}/diff", target.id)).await?;

            println!(
                "=== Worktree Diff for {} (branch `{}`) ===",
                &target.id.to_string()[..8],
                target.branch
            );
            if let Some(diff_str) = resp.get("diff").and_then(|v| v.as_str()) {
                if diff_str.trim().is_empty() {
                    println!("(No uncommitted changes in worktree)");
                } else {
                    println!("{}", diff_str);
                }
            }
        }
        Commands::Stop { session } => {
            ensure_daemon_running(addr).await?;
            let target = resolve_session(addr, &session).await?;
            let _: Value = http_post_json(
                addr,
                &format!("/api/sessions/{}/stop", target.id),
                &serde_json::json!({}),
            )
            .await?;
            println!(
                "🛑 Stopped session {} ({})",
                &target.id.to_string()[..8],
                target.name
            );
        }
        Commands::Handoff {
            session,
            to,
            instructions,
        } => {
            ensure_daemon_running(addr).await?;
            let target = resolve_session(addr, &session).await?;
            let req = HandoffSessionRequest {
                target_provider: AgentProvider::from_str_loose(&to),
                additional_instructions: instructions,
            };
            let new_session: SessionInfo = http_post_json(
                addr,
                &format!("/api/sessions/{}/handoff", target.id),
                &req,
            )
            .await?;
            println!(
                "🤝 Handed off session [{}] -> [{}] ({})",
                &target.id.to_string()[..8],
                &new_session.id.to_string()[..8],
                new_session.provider
            );
            println!("   Shared Branch:   {}", new_session.branch);
            println!("   Shared Worktree: {}", new_session.worktree_path);
        }
        Commands::Advisor {
            session,
            agent,
            question,
        } => {
            ensure_daemon_running(addr).await?;
            let target = resolve_session(addr, &session).await?;
            let req = AdvisorSessionRequest {
                advisor_provider: AgentProvider::from_str_loose(&agent),
                focus_question: question,
            };
            let advisor_session: SessionInfo = http_post_json(
                addr,
                &format!("/api/sessions/{}/advisor", target.id),
                &req,
            )
            .await?;
            println!(
                "🧠 Spawned Advisor Session [{}] ({}) reviewing [{}]",
                &advisor_session.id.to_string()[..8],
                advisor_session.provider,
                &target.id.to_string()[..8]
            );
            println!(
                "   Logs: velo logs {} --follow",
                &advisor_session.id.to_string()[..8]
            );
        }
        Commands::Committee {
            prompt,
            agents,
            repo,
            name,
        } => {
            ensure_daemon_running(addr).await?;
            let repo_dir = match repo {
                Some(p) => p,
                None => env::current_dir().context("Failed to get current directory")?,
            };
            let abs_repo = repo_dir.canonicalize().unwrap_or(repo_dir);
            let providers: Vec<AgentProvider> = agents
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .map(AgentProvider::from_str_loose)
                .collect();

            let req = CommitteeRequest {
                name_prefix: name,
                providers,
                prompt,
                repo_path: abs_repo.to_string_lossy().to_string(),
            };
            let resp: Value = http_post_json(addr, "/api/committee", &req).await?;
            println!(
                "🏛️  Dispatched Agent Committee `{}`:",
                resp.get("committee").and_then(|v| v.as_str()).unwrap_or("")
            );
            if let Some(arr) = resp.get("sessions").and_then(|v| v.as_array()) {
                for item in arr {
                    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let prov = item.get("provider").and_then(|v| v.as_str()).unwrap_or("custom");
                    let br = item.get("branch").and_then(|v| v.as_str()).unwrap_or("");
                    println!("   • [{}] {:<10} branch: {}", &id[..8.min(id.len())], prov, br);
                }
            }
        }
        Commands::Loop {
            prompt,
            check,
            agent,
            max_iterations,
            repo,
            branch,
        } => {
            ensure_daemon_running(addr).await?;
            let repo_dir = match repo {
                Some(p) => p,
                None => env::current_dir().context("Failed to get current directory")?,
            };
            let abs_repo = repo_dir.canonicalize().unwrap_or(repo_dir);

            let req = LoopSessionRequest {
                name: None,
                provider: AgentProvider::from_str_loose(&agent),
                prompt,
                check_command: check.clone(),
                max_iterations,
                repo_path: abs_repo.to_string_lossy().to_string(),
                branch,
            };
            let session: SessionInfo = http_post_json(addr, "/api/loop", &req).await?;
            println!(
                "🔄 Started Self-Healing Loop [{}] (max {} iterations)",
                &session.id.to_string()[..8],
                max_iterations
            );
            println!("   Agent:    {}", session.provider);
            println!("   Check:    `{}`", check);
            println!("   Worktree: {}", session.worktree_path);
            println!(
                "   Logs:     velo logs {} --follow",
                &session.id.to_string()[..8]
            );
        }
        Commands::Mcp => {
            ensure_daemon_running(addr).await?;
            let stdin = tokio::io::stdin();
            let mut stdout = tokio::io::stdout();
            let mut lines = BufReader::new(stdin).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(req_val) = serde_json::from_str::<Value>(&line) {
                    if let Ok(resp_val) = http_post_json::<Value, Value>(addr, "/mcp", &req_val).await {
                        let out_line = format!("{}\n", serde_json::to_string(&resp_val)?);
                        let _ = stdout.write_all(out_line.as_bytes()).await;
                        let _ = stdout.flush().await;
                    }
                }
            }
        }
        Commands::Pair { relay } => {
            ensure_daemon_running(addr).await?;
            let path = if relay.contains("127.0.0.1:6768") {
                "/api/pair".to_string()
            } else {
                format!("/api/pair?relay={}", relay)
            };
            if let Ok(dto) = http_get_json::<Value>(addr, &path).await {
                let pairing_uri = dto
                    .get("pairing_uri")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let relay_url = dto.get("relay_url").and_then(|v| v.as_str()).unwrap_or(&relay);
                let room_id = dto.get("room_id").and_then(|v| v.as_str()).unwrap_or("");
                let key_hex = dto
                    .get("shared_key_hex")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                println!("🔐 Velo Zero-Trust Blind E2EE Pairing (X25519 + ChaCha20-Poly1305)");
                println!("{}", velo_relay::render_qr_unicode(pairing_uri));
                println!("   Relay Edge:   {}", relay_url);
                println!("   Pairing URI:  {}", pairing_uri);
                println!("   Relay Room:   {}", room_id);
                if key_hex.len() >= 16 {
                    println!("   Shared Key:   {}… (256-bit)", &key_hex[..16]);
                }
            } else {
                let ticket = PairingTicket::generate(&relay, addr);
                println!("🔐 Velo End-to-End Encrypted (E2EE) Mobile/Remote Pairing");
                println!("{}", ticket.render_terminal_qr());
                println!("   Pairing URI:  {}", ticket.pairing_uri);
                println!("   Relay Room:   {}", ticket.room_id);
                println!("   Shared Key:   {}… (256-bit)", &ticket.shared_key_hex[..16]);
            }
        }
        Commands::Relay { listen } => {
            let sock_addr: SocketAddr = listen
                .parse()
                .with_context(|| format!("Invalid relay listen address: {}", listen))?;
            println!("🛰️  Starting Velo E2EE Relay Server on ws://{}", sock_addr);
            velo_relay::run_relay_server(sock_addr).await?;
        }
        Commands::Service { action } => match action.trim().to_lowercase().as_str() {
            "install" | "enable" => {
                let plist_path = velo_daemon::service::stage_launch_agent_files(None)?;
                velo_daemon::service::bootstrap_and_kickstart_sync(&plist_path)?;
                tokio::time::sleep(Duration::from_millis(700)).await;
                let st = velo_daemon::service::get_service_status().await;
                println!("✅ Velo macOS LaunchAgent installed & running!");
                println!("   Label:     {}", st.label);
                println!("   Plist:     {}", st.plist_path);
                println!("   Binary:    {}", st.installed_binary_path);
                println!("   Loaded:    {} (PID: {:?})", st.launchd_loaded, st.launchd_pid);
                println!("   Logs:      {}", st.log_dir);
            }
            "uninstall" | "disable" | "remove" => {
                velo_daemon::service::bootout_and_remove_plist_sync(true)?;
                println!("🛑 Velo macOS LaunchAgent uninstalled ({})", velo_daemon::service::LAUNCH_AGENT_LABEL);
            }
            "restart" => {
                velo_daemon::service::restart_launchd_service_sync()?;
                tokio::time::sleep(Duration::from_millis(600)).await;
                let st = velo_daemon::service::get_service_status().await;
                println!("🔄 Velo macOS LaunchAgent restarted (PID: {:?})", st.launchd_pid);
            }
            _ => {
                let st = velo_daemon::service::get_service_status().await;
                let live_sleep_guard = http_get_json::<Value>(addr, "/api/system/service")
                    .await
                    .ok()
                    .and_then(|v| v.get("caffeinate_active").and_then(|b| b.as_bool()))
                    .unwrap_or(st.caffeinate_active);
                println!("⚙️  Velo macOS LaunchAgent ({})", st.label);
                println!("   Installed:          {}", st.plist_installed);
                println!("   Launchd Loaded:     {} (PID: {:?})", st.launchd_loaded, st.launchd_pid);
                println!("   Prevent Idle Sleep: {} (active: {})", st.prevent_idle_sleep, live_sleep_guard);
                println!("   Plist Path:         {}", st.plist_path);
                println!("   Daemon Binary:      {}", st.installed_binary_path);
                println!("   Logs Directory:     {}", st.log_dir);
            }
        },
    }

    Ok(())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let taken: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", taken)
    }
}

fn print_agent_event(ev: &AgentEvent) {
    match ev {
        AgentEvent::StatusChanged {
            status, message, ..
        } => {
            println!(
                "[status -> {}] {}",
                status,
                message.as_deref().unwrap_or("")
            );
        }
        AgentEvent::UserMessage { text, images, .. } => {
            if images.is_empty() {
                println!("👤 {}", text);
            } else {
                println!("👤 {} [{} image(s)]", text, images.len());
            }
        }
        AgentEvent::ProviderSessionBound {
            provider_session_id,
            ..
        } => {
            println!("🔗 [thread bound] {}", provider_session_id);
        }
        AgentEvent::ThinkingChunk { delta, .. } => {
            print!("{}", delta);
        }
        AgentEvent::ThinkingDelta { text, .. } => {
            println!("💭 {}", text);
        }
        AgentEvent::MessageChunk { delta, .. } => {
            print!("{}", delta);
        }
        AgentEvent::MessageDelta { text, .. } => {
            println!("{}", text);
        }
        AgentEvent::UsageUpdated {
            total_tokens,
            cost_usd,
            ..
        } => {
            if *cost_usd > 0.0 {
                println!("📈 [usage] {} tokens (${:.4})", total_tokens, cost_usd);
            } else {
                println!("📈 [usage] {} tokens", total_tokens);
            }
        }
        AgentEvent::TerminalOutput { data, .. } => {
            print!("{}", data);
        }
        AgentEvent::ToolCallRequested {
            tool_name,
            arguments,
            ..
        } => {
            println!("🔧 [tool: {}] {}", tool_name, arguments);
        }
        AgentEvent::ToolCallCompleted {
            tool_id,
            output,
            is_error,
            ..
        } => {
            let prefix = if *is_error { "❌" } else { "✅" };
            println!(
                "{} [tool_result: {}] {}",
                prefix,
                tool_id,
                truncate(output, 160)
            );
        }
        AgentEvent::PermissionRequested {
            tool_name,
            description,
            ..
        } => {
            println!("⚠️  [permission requested: {}] {}", tool_name, description);
        }
        AgentEvent::PermissionResolved { decision, .. } => {
            println!("🛡️  [permission {}]", decision);
        }
        AgentEvent::UserQuestionRequested { question, .. } => {
            println!("❓ [question] {}", question);
        }
        AgentEvent::UserQuestionAnswered { answers, .. } => {
            println!("💬 [answered] {}", answers.join(", "));
        }
        AgentEvent::BrowserCommand { action, url, .. } => {
            println!("🌐 [browser:{}] {}", action, url.as_deref().unwrap_or(""));
        }
        AgentEvent::SetupHookOutput {
            command, exit_code, ..
        } => {
            println!("⚙️  [setup hook] `{}` (exit {})", command, exit_code);
        }
        AgentEvent::PtyOutput { line, .. } => {
            println!("{}", line);
        }
        AgentEvent::DiffUpdated { stats, .. } => {
            println!(
                "📊 [diff updated] {} files (+{} -{})",
                stats.files_changed, stats.insertions, stats.deletions
            );
        }
        AgentEvent::Error { error, .. } => {
            eprintln!("❗ [error] {}", error);
        }
    }
}

async fn resolve_session(addr: &str, id_or_prefix: &str) -> Result<SessionInfo> {
    let sessions: Vec<SessionInfo> = http_get_json(addr, "/api/sessions").await?;
    let needle = id_or_prefix.to_lowercase();
    for s in sessions {
        if s.id.to_string().to_lowercase().starts_with(&needle)
            || s.name.to_lowercase() == needle
        {
            return Ok(s);
        }
    }
    bail!("No session matching `{}` found", id_or_prefix)
}

async fn ensure_daemon_running(addr: &str) -> Result<()> {
    if http_get_json::<Value>(addr, "/api/health").await.is_ok() {
        return Ok(());
    }

    let current_exe = env::current_exe().context("Failed to locate current velo executable")?;
    let log_dir = velo_worktree::default_velo_home();
    tokio::fs::create_dir_all(&log_dir).await?;
    let log_file = std::fs::File::create(log_dir.join("daemon.log"))?;
    let err_file = log_file.try_clone()?;

    StdCommand::new(current_exe)
        .args(["--addr", addr, "up", "--foreground"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(err_file))
        .spawn()
        .context("Failed to spawn background velo daemon")?;

    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if http_get_json::<Value>(addr, "/api/health").await.is_ok() {
            return Ok(());
        }
    }

    bail!("Timed out waiting for velo daemon to start on {}", addr)
}

async fn http_get_json<T: DeserializeOwned>(addr: &str, path: &str) -> Result<T> {
    let raw = raw_http_request(addr, "GET", path, None).await?;
    serde_json::from_str(&raw).with_context(|| format!("Invalid JSON response from GET {}", path))
}

async fn http_post_json<B: serde::Serialize, T: DeserializeOwned>(
    addr: &str,
    path: &str,
    body: &B,
) -> Result<T> {
    let payload = serde_json::to_string(body)?;
    let raw = raw_http_request(addr, "POST", path, Some(&payload)).await?;
    serde_json::from_str(&raw).with_context(|| format!("Invalid JSON response from POST {}", path))
}

async fn raw_http_request(
    addr: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<String> {
    let mut stream = TcpStream::connect(addr)
        .await
        .with_context(|| format!("Could not connect to daemon at {}", addr))?;

    let req_str = match body {
        Some(b) => format!(
            "{} {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            method,
            path,
            addr,
            b.len(),
            b
        ),
        None => format!(
            "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            method, path, addr
        ),
    };

    stream.write_all(req_str.as_bytes()).await?;
    let mut resp_bytes = Vec::new();
    stream.read_to_end(&mut resp_bytes).await?;

    let resp_str = String::from_utf8_lossy(&resp_bytes);
    let (headers, body_part) = resp_str
        .split_once("\r\n\r\n")
        .context("Malformed HTTP response")?;

    let status_line = headers.lines().next().unwrap_or("");
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);

    let decoded_body = if headers.to_lowercase().contains("transfer-encoding: chunked") {
        decode_chunked(body_part)
    } else {
        body_part.to_string()
    };

    if status_code >= 400 {
        bail!("Daemon returned HTTP {}: {}", status_code, decoded_body);
    }

    Ok(decoded_body)
}

fn decode_chunked(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while let Some((len_hex, after_len)) = rest.split_once("\r\n") {
        let Ok(chunk_len) = usize::from_str_radix(len_hex.trim(), 16) else {
            break;
        };
        if chunk_len == 0 {
            break;
        }
        if after_len.len() >= chunk_len {
            out.push_str(&after_len[..chunk_len]);
            rest = &after_len[chunk_len..];
            if rest.starts_with("\r\n") {
                rest = &rest[2..];
            }
        } else {
            out.push_str(after_len);
            break;
        }
    }
    out
}
