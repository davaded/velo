export type AgentProvider =
  | "claude_code"
  | "codex"
  | "opencode"
  | "gemini"
  | "custom_pty";

export type SessionStatus =
  | "starting"
  | "running"
  | "idle"
  | "completed"
  | "failed";

export interface GitDiffStats {
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  provider: AgentProvider;
  project_path: string;
  worktree_path: string;
  worktree_branch: string;
  status: SessionStatus;
  prompt: string;
  created_at: string;
  diff_stats: GitDiffStats | null;
}

export type AgentEvent =
  | { kind: "user_input"; content: string }
  | { kind: "assistant_message"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; tool_name: string; input: unknown }
  | { kind: "tool_result"; tool_name: string; output: string; is_error: boolean }
  | { kind: "pty_data"; data: string }
  | { kind: "status_changed"; status: SessionStatus; exit_code?: number | null };

export interface PairingResponse {
  ticket: {
    relay_url: string;
    room_id: string;
    shared_key_hex: string;
    daemon_name: string;
  };
  uri: string;
  qr_ascii: string;
}

export type WsServerMessage =
  | { type: "session_list"; sessions: SessionInfo[] }
  | { type: "session_updated"; session: SessionInfo }
  | { type: "agent_event"; session_id: string; event: AgentEvent }
  | { type: "error"; message: string };
