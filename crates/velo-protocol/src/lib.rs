use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

pub const DEFAULT_DAEMON_PORT: u16 = 6767;
pub const DEFAULT_DAEMON_HOST: &str = "127.0.0.1";

/// Supported coding agent providers wrapped natively or via ACP by Velo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Claude,
    Codex,
    Grok,
    Cursor,
    OpenCode,
    #[serde(rename = "agy")]
    Antigravity,
    Copilot,
    Qwen,
    Acp(String),
    Custom(String),
}

impl<'de> Deserialize<'de> for AgentProvider {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Plain(String),
            Tagged(std::collections::HashMap<String, String>),
        }

        match Repr::deserialize(deserializer)? {
            Repr::Plain(s) => Ok(Self::from_str_loose(&s)),
            Repr::Tagged(map) => {
                if let Some(cmd) = map.get("acp") {
                    Ok(Self::Acp(cmd.clone()))
                } else if let Some(cmd) = map.get("custom") {
                    Ok(Self::Custom(cmd.clone()))
                } else {
                    Err(serde::de::Error::custom(
                        "expected AgentProvider string or {acp|custom: string}",
                    ))
                }
            }
        }
    }
}

impl AgentProvider {
    pub fn from_str_loose(s: &str) -> Self {
        let trimmed = s.trim();
        let lower = trimmed.to_lowercase();
        if let Some(rest) = trimmed.strip_prefix("acp:").or_else(|| trimmed.strip_prefix("ACP:")) {
            return Self::Acp(rest.trim().to_string());
        }
        match lower.as_str() {
            "claude" | "claude-code" => Self::Claude,
            "codex" | "openai" => Self::Codex,
            "grok" | "grok-cli" | "xai" => Self::Grok,
            "cursor" | "cursor-agent" | "cursor-cli" => Self::Cursor,
            "opencode" | "open-code" => Self::OpenCode,
            "agy" | "antigravity" | "antigravity-cli" | "gemini" | "gemini-cli" => {
                Self::Antigravity
            }
            "copilot" | "github-copilot" | "gh-copilot" => Self::Copilot,
            "qwen" | "qwen-code" => Self::Qwen,
            _ => Self::Custom(trimmed.to_string()),
        }
    }

    pub fn binary_name(&self) -> &str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
            Self::Cursor => "cursor-agent",
            Self::OpenCode => "opencode",
            Self::Antigravity => "agy",
            Self::Copilot => "copilot",
            Self::Qwen => "qwen",
            Self::Acp(cmd) => cmd.split_whitespace().next().unwrap_or(cmd.as_str()),
            Self::Custom(cmd) => cmd.split_whitespace().next().unwrap_or(cmd.as_str()),
        }
    }
}

impl fmt::Display for AgentProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Claude => write!(f, "claude"),
            Self::Codex => write!(f, "codex"),
            Self::Grok => write!(f, "grok"),
            Self::Cursor => write!(f, "cursor"),
            Self::OpenCode => write!(f, "opencode"),
            Self::Antigravity => write!(f, "agy"),
            Self::Copilot => write!(f, "copilot"),
            Self::Qwen => write!(f, "qwen"),
            Self::Acp(name) => write!(f, "acp:{}", name),
            Self::Custom(name) => write!(f, "custom({})", name),
        }
    }
}

pub fn default_approval_mode() -> String {
    "auto_edit".to_string()
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
    #[serde(default)]
    pub tokens_used: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub context_window: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default = "default_approval_mode")]
    pub approval_mode: String,
    #[serde(default)]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub queued_prompts: Vec<QueuedPromptItem>,
    #[serde(default)]
    pub archived: bool,
}

/// Normalized subscription rate-limit window (e.g., 5h rolling window or 7d weekly window).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitWindowDto {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_in_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_text: Option<String>,
    pub status: String, // "healthy" | "warning" | "exhausted"
    pub source: String, // "provider_api" | "provider_header" | "wallet"
}

/// A follow-up user prompt queued on the server to run automatically when the active turn completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedPromptItem {
    pub id: String,
    pub input: String,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Recognized `SKILL.md` path. The visible `input` stays short; the daemon reads this file for the model.
    #[serde(default)]
    pub skill_path: Option<String>,
    pub created_at: DateTime<Utc>,
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
        #[serde(default)]
        images: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_msg_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_session_id: Option<Uuid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_label: Option<String>,
        timestamp: DateTime<Utc>,
    },
    ProviderSessionBound {
        session_id: Uuid,
        provider_session_id: String,
        timestamp: DateTime<Utc>,
    },
    ThinkingChunk {
        session_id: Uuid,
        delta: String,
        #[serde(default)]
        replace: bool,
        timestamp: DateTime<Utc>,
    },
    ThinkingDelta {
        session_id: Uuid,
        text: String,
        timestamp: DateTime<Utc>,
    },
    MessageChunk {
        session_id: Uuid,
        delta: String,
        #[serde(default)]
        replace: bool,
        timestamp: DateTime<Utc>,
    },
    MessageDelta {
        session_id: Uuid,
        text: String,
        timestamp: DateTime<Utc>,
    },
    UsageUpdated {
        session_id: Uuid,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
        #[serde(default)]
        cache_read_tokens: u64,
        #[serde(default)]
        cache_write_tokens: u64,
        #[serde(default)]
        context_window: u64,
        cost_usd: f64,
        #[serde(default)]
        output_tps: f64,
        #[serde(default)]
        is_turn_total: bool,
        timestamp: DateTime<Utc>,
    },
    RateLimitsUpdated {
        session_id: Uuid,
        provider: String,
        windows: Vec<RateLimitWindowDto>,
        timestamp: DateTime<Utc>,
    },
    TerminalOutput {
        session_id: Uuid,
        data: String,
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
    PermissionResolved {
        session_id: Uuid,
        request_id: String,
        decision: String,
        timestamp: DateTime<Utc>,
    },
    UserQuestionRequested {
        session_id: Uuid,
        question_id: String,
        question: String,
        #[serde(default)]
        options: Vec<String>,
        #[serde(default)]
        allow_multiple: bool,
        timestamp: DateTime<Utc>,
    },
    UserQuestionAnswered {
        session_id: Uuid,
        question_id: String,
        answers: Vec<String>,
        timestamp: DateTime<Utc>,
    },
    BrowserCommand {
        session_id: Uuid,
        action: String,
        url: Option<String>,
        selector: Option<String>,
        script: Option<String>,
        timestamp: DateTime<Utc>,
    },
    SetupHookOutput {
        session_id: Uuid,
        command: String,
        output: String,
        exit_code: i32,
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
    MeshInvocationUpdated {
        session_id: Uuid,
        invocation: MeshInvocationInfo,
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
            | Self::ThinkingChunk { session_id, .. }
            | Self::ThinkingDelta { session_id, .. }
            | Self::MessageChunk { session_id, .. }
            | Self::MessageDelta { session_id, .. }
            | Self::UsageUpdated { session_id, .. }
            | Self::RateLimitsUpdated { session_id, .. }
            | Self::TerminalOutput { session_id, .. }
            | Self::ToolCallRequested { session_id, .. }
            | Self::ToolCallCompleted { session_id, .. }
            | Self::PermissionRequested { session_id, .. }
            | Self::PermissionResolved { session_id, .. }
            | Self::UserQuestionRequested { session_id, .. }
            | Self::UserQuestionAnswered { session_id, .. }
            | Self::BrowserCommand { session_id, .. }
            | Self::SetupHookOutput { session_id, .. }
            | Self::PtyOutput { session_id, .. }
            | Self::DiffUpdated { session_id, .. }
            | Self::MeshInvocationUpdated { session_id, .. }
            | Self::Error { session_id, .. } => *session_id,
        }
    }
}

/// Cross-folder / cross-session Mesh permission policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshPermissionPolicy {
    SmartApproval,
    WorkspaceAuto,
    AlwaysAsk,
}

impl Default for MeshPermissionPolicy {
    fn default() -> Self {
        Self::SmartApproval
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshSettings {
    #[serde(default)]
    pub policy: MeshPermissionPolicy,
    #[serde(default = "default_mesh_max_depth")]
    pub max_depth: u32,
    #[serde(default = "default_mesh_max_room_hops")]
    pub max_room_hops: u32,
}

pub fn default_mesh_max_depth() -> u32 {
    3
}

pub fn default_mesh_max_room_hops() -> u32 {
    12
}

impl Default for MeshSettings {
    fn default() -> Self {
        Self {
            policy: MeshPermissionPolicy::SmartApproval,
            max_depth: default_mesh_max_depth(),
            max_room_hops: default_mesh_max_room_hops(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshInvocationKind {
    Read,
    Ask,
    Spawn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshInvocationStatus {
    PendingApproval,
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

/// Persisted and live-streamed record of a cross-session / cross-folder Mesh invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshInvocationInfo {
    pub id: String,
    pub caller_session_id: Uuid,
    pub caller_session_name: String,
    pub caller_provider: String,
    pub caller_repo_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callee_session_id: Option<Uuid>,
    pub callee_session_name: String,
    pub callee_provider: String,
    pub callee_repo_root: String,
    pub root_invocation_id: String,
    pub depth: u32,
    #[serde(default)]
    pub call_chain: Vec<Uuid>,
    pub kind: MeshInvocationKind,
    pub prompt: String,
    pub status: MeshInvocationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_stats: Option<GitDiffStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

/// Structured `@` reference attached to a prompt from Mac / iOS composer (Mode A).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshContextRef {
    /// `"session"` | `"workspace"` | `"room"`
    pub kind: String,
    pub target_id: String,
    #[serde(default)]
    pub label: Option<String>,
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
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub approval_mode: Option<String>,
    #[serde(default)]
    pub setup_command: Option<String>,
    #[serde(default)]
    pub use_worktree: bool,
    #[serde(default)]
    pub client_msg_id: Option<String>,
}

/// Request payload to hand off an existing session's worktree & context to another agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffSessionRequest {
    pub target_provider: AgentProvider,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
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
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub approval_mode: Option<String>,
    /// Execution mode when session is busy: `"queue"` (enqueue for next turn), `"steer"` (interrupt & run immediately), or `None`.
    #[serde(default)]
    pub mode: Option<String>,
    /// Path of a `SKILL.md` to follow for this turn. Stored user text stays `input`.
    #[serde(default)]
    pub skill_path: Option<String>,
    /// Client-generated optimistic message correlation ID for deterministic deduplication.
    #[serde(default)]
    pub client_msg_id: Option<String>,
    /// Optional Mode-A `@` context references (sessions / workspaces / rooms) to inject compact summaries for.
    #[serde(default)]
    pub context_refs: Vec<MeshContextRef>,
    /// Internal origin marker when this input was dispatched by another session via Velo Mesh.
    #[serde(default)]
    pub source_session_id: Option<Uuid>,
    #[serde(default)]
    pub source_label: Option<String>,
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
        #[serde(default)]
        always: bool,
    },
    AnswerQuestion {
        session_id: Uuid,
        question_id: String,
        answers: Vec<String>,
    },
    Ping,
}

/// Daemon-to-client WebSocket message envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WsServerMessage {
    Event {
        event: AgentEvent,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seq: Option<i64>,
    },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_provider_serde_plain_and_tagged_roundtrip() {
        let p1: AgentProvider = serde_json::from_str("\"claude\"").unwrap();
        assert_eq!(p1, AgentProvider::Claude);

        let p2: AgentProvider = serde_json::from_str("\"acp:opencode acp\"").unwrap();
        assert_eq!(p2, AgentProvider::Acp("opencode acp".to_string()));

        let serialized = serde_json::to_string(&p2).unwrap();
        let roundtripped: AgentProvider = serde_json::from_str(&serialized).unwrap();
        assert_eq!(roundtripped, p2);

        let p3: AgentProvider = serde_json::from_str("\"agy\"").unwrap();
        assert_eq!(p3, AgentProvider::Antigravity);
        assert_eq!(serde_json::to_string(&p3).unwrap(), "\"agy\"");

        // Legacy persisted sessions with `"gemini"` cleanly map to `AgentProvider::Antigravity`
        let p_legacy: AgentProvider = serde_json::from_str("\"gemini\"").unwrap();
        assert_eq!(p_legacy, AgentProvider::Antigravity);

        let p_grok: AgentProvider = serde_json::from_str("\"grok\"").unwrap();
        assert_eq!(p_grok, AgentProvider::Grok);
        assert_eq!(serde_json::to_string(&p_grok).unwrap(), "\"grok\"");

        let p_cursor: AgentProvider = serde_json::from_str("\"cursor-agent\"").unwrap();
        assert_eq!(p_cursor, AgentProvider::Cursor);
        assert_eq!(serde_json::to_string(&p_cursor).unwrap(), "\"cursor\"");
    }
}
