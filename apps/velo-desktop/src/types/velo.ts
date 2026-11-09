export type AgentProvider =
  | "claude"
  | "codex"
  | "opencode"
  | { custom: string };

export type SessionStatus =
  | "starting"
  | "running"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "stopped";

export interface GitDiffStats {
  files_changed: number;
  insertions: number;
  deletions: number;
  modified_files: string[];
}

export interface SessionInfo {
  id: string;
  name: string;
  provider: AgentProvider;
  prompt: string;
  repo_root: string;
  worktree_path: string;
  branch: string;
  status: SessionStatus;
  pid: number | null;
  diff_stats: GitDiffStats;
  created_at: string;
  updated_at: string;
  parent_session_id: string | null;
}

export type AgentEvent =
  | {
      type: "status_changed";
      session_id: string;
      status: SessionStatus;
      message: string | null;
      timestamp: string;
    }
  | {
      type: "thinking_delta";
      session_id: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "message_delta";
      session_id: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "tool_call_requested";
      session_id: string;
      tool_id: string;
      tool_name: string;
      arguments: Record<string, unknown> | unknown;
      timestamp: string;
    }
  | {
      type: "tool_call_completed";
      session_id: string;
      tool_id: string;
      output: string;
      is_error: boolean;
      timestamp: string;
    }
  | {
      type: "permission_requested";
      session_id: string;
      request_id: string;
      tool_name: string;
      description: string;
      command_preview: string | null;
      timestamp: string;
    }
  | {
      type: "pty_output";
      session_id: string;
      line: string;
      timestamp: string;
    }
  | {
      type: "diff_updated";
      session_id: string;
      stats: GitDiffStats;
      timestamp: string;
    }
  | {
      type: "error";
      session_id: string;
      error: string;
      timestamp: string;
    };

export type WsServerMessage =
  | { kind: "event"; event: AgentEvent }
  | { kind: "sessions_snapshot"; sessions: SessionInfo[] }
  | { kind: "pong" };

export interface CreateSessionPayload {
  name?: string;
  provider: AgentProvider;
  prompt: string;
  repo_path: string;
  branch?: string;
  use_pty: boolean;
}

export interface SessionDiffResponse {
  session_id: string;
  stats: GitDiffStats;
  diff: string;
}

export interface PairingTicket {
  room_id: string;
  shared_key_hex: string;
  relay_url: string;
  daemon_addr: string;
  pairing_uri: string;
}

export function formatProvider(p: AgentProvider): string {
  if (typeof p === "string") {
    return p;
  }
  const cmd = p.custom;
  if (cmd.length > 14) {
    return `cmd:${cmd.slice(0, 12)}…`;
  }
  return `cmd:${cmd}`;
}

export function providerBadgeColor(p: AgentProvider): string {
  if (p === "claude") {
    return "bg-amber-500/10 text-amber-300 border-amber-500/25";
  }
  if (p === "codex") {
    return "bg-emerald-500/10 text-emerald-300 border-emerald-500/25";
  }
  if (p === "opencode") {
    return "bg-sky-500/10 text-sky-300 border-sky-500/25";
  }
  return "bg-purple-500/10 text-purple-300 border-purple-500/25";
}
