use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

pub const DEFAULT_DAEMON_PORT: u16 = 6767;
pub const DEFAULT_DAEMON_HOST: &str = "127.0.0.1";

/// Supported coding agent providers wrapped natively by Velo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Claude,
    Codex,
    OpenCode,
    Custom(String),
}

impl AgentProvider {
    pub fn from_str_loose(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "claude" | "claude-code" => Self::Claude,
            "codex" | "openai" => Self::Codex,
            "opencode" | "open-code" => Self::OpenCode,
            other => Self::Custom(other.to_string()),
        }
    }

    pub fn binary_name(&self) -> &str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Custom(cmd) => cmd.as_str(),
        }
    }
}

impl fmt::Display for AgentProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Claude => write!(f, "claude"),
            Self::Codex => write!(f, "codex"),
            Self::OpenCode => write!(f, "opencode"),
            Self::Custom(name) => write!(f, "custom({})", name),
        }
    }
}

/// Lifecycle state of an orchestrated agent session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Starting,
    Running,
    WaitingForPermission,
    Completed,
    Failed,
    Stopped,
}

impl fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::WaitingForPermission => "waiting_permission",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        };
        write!(f, "{}", label)
    }
}

/// Summary statistics for changes inside a session's isolated Git worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitDiffStats {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub modified_files: Vec<String>,
}

/// Metadata for an active or historical Velo agent session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: Uuid,
    pub name: String,
    pub provider: AgentProvider,
    pub prompt: String,
    pub repo_root: String,
    pub worktree_path: String,
    pub branch: String,
    pub status: SessionStatus,
    pub pid: Option<u32>,
    pub diff_stats: GitDiffStats,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub parent_session_id: Option<Uuid>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// Unified event stream emitted by `velo-agent` drivers and broadcasted to connected clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    StatusChanged {
        session_id: Uuid,
        status: SessionStatus,
        message: Option<String>,
        timestamp: DateTime<Utc>,
    },
    UserMessage {
        session_id: Uuid,
        text: String,
        timestamp: DateTime<Utc>,
    },
    ProviderSessionBound {
        session_id: Uuid,
        provider_session_id: String,
        timestamp: DateTime<Utc>,
    },
    ThinkingDelta {
        session_id: Uuid,
        text: String,
        timestamp: DateTime<Utc>,
    },
    MessageDelta {
        session_id: Uuid,
        text: String,
        timestamp: DateTime<Utc>,
    },
    ToolCallRequested {
        session_id: Uuid,
        tool_id: String,
        tool_name: String,
        arguments: serde_json::Value,
        timestamp: DateTime<Utc>,
    },
    ToolCallCompleted {
        session_id: Uuid,
        tool_id: String,
        output: String,
        is_error: bool,
        timestamp: DateTime<Utc>,
    },
    PermissionRequested {
        session_id: Uuid,
        request_id: String,
        tool_name: String,
        description: String,
        command_preview: Option<String>,
        timestamp: DateTime<Utc>,
    },
    PtyOutput {
        session_id: Uuid,
        line: String,
        timestamp: DateTime<Utc>,
    },
    DiffUpdated {
        session_id: Uuid,
        stats: GitDiffStats,
        timestamp: DateTime<Utc>,
    },
    Error {
        session_id: Uuid,
        error: String,
        timestamp: DateTime<Utc>,
    },
}

impl AgentEvent {
    pub fn session_id(&self) -> Uuid {
        match self {
            Self::StatusChanged { session_id, .. }
            | Self::UserMessage { session_id, .. }
            | Self::ProviderSessionBound { session_id, .. }
            | Self::ThinkingDelta { session_id, .. }
            | Self::MessageDelta { session_id, .. }
            | Self::ToolCallRequested { session_id, .. }
            | Self::ToolCallCompleted { session_id, .. }
            | Self::PermissionRequested { session_id, .. }
            | Self::PtyOutput { session_id, .. }
            | Self::DiffUpdated { session_id, .. }
            | Self::Error { session_id, .. } => *session_id,
        }
    }
}

/// Request payload to spin up a new isolated worktree & coding agent session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    pub name: Option<String>,
    pub provider: AgentProvider,
    pub prompt: String,
    pub repo_path: String,
    pub branch: Option<String>,
    pub use_pty: bool,
    pub parent_session_id: Option<Uuid>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// Request payload to hand off an existing session's worktree & context to another agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffSessionRequest {
    pub target_provider: AgentProvider,
    pub additional_instructions: Option<String>,
}

/// Request payload to send interactive input or follow-up prompt to a running session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInputRequest {
    pub input: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub provider: Option<AgentProvider>,
    #[serde(default)]
    pub reset_thread: bool,
    #[serde(default)]
    pub truncate_to_user_turn: Option<usize>,
}

/// Client-to-daemon WebSocket command envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum WsClientMessage {
    Subscribe { session_id: Option<Uuid> },
    SendInput { session_id: Uuid, data: String },
    ApprovePermission {
        session_id: Uuid,
        request_id: String,
        approved: bool,
    },
    Ping,
}

/// Daemon-to-client WebSocket message envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WsServerMessage {
    Event { event: AgentEvent },
    SessionsSnapshot { sessions: Vec<SessionInfo> },
    Pong,
}

/// Request payload for `/velo-advisor`: spin up a secondary agent to review an existing session's worktree & diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisorSessionRequest {
    pub advisor_provider: AgentProvider,
    pub focus_question: Option<String>,
}

/// Request payload for `/velo-committee`: dispatch multiple contrasting agents in parallel isolated worktrees.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitteeRequest {
    pub name_prefix: Option<String>,
    pub providers: Vec<AgentProvider>,
    pub prompt: String,
    pub repo_path: String,
}

/// Request payload for `/velo-loop`: run an agent continuously against an acceptance command (e.g. `cargo test`) until it passes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopSessionRequest {
    pub name: Option<String>,
    pub provider: AgentProvider,
    pub prompt: String,
    pub check_command: String,
    pub max_iterations: u32,
    pub repo_path: String,
    pub branch: Option<String>,
}
