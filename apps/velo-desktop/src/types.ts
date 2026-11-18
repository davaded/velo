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
  | "stopped"
  | "idle";

export interface GitDiffStats {
  files_changed: number;
  insertions: number;
  deletions: number;
  modified_files?: string[];
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
  pid?: number | null;
  diff_stats: GitDiffStats;
  created_at: string;
  updated_at?: string;
  parent_session_id?: string | null;
}

export type UIEventItem =
  | { kind: "user_input"; content: string }
  | { kind: "assistant_message"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; tool_name: string; input: unknown }
  | { kind: "tool_result"; tool_name: string; output: string; is_error: boolean }
  | { kind: "pty_data"; data: string }
  | { kind: "status_changed"; status: string; message?: string | null };

export interface PairingTicket {
  room_id: string;
  shared_key_hex: string;
  relay_url: string;
  daemon_addr: string;
  pairing_uri: string;
}

export function normalizeSession(raw: Record<string, unknown>): SessionInfo {
  const repoRoot =
    (typeof raw.repo_root === "string" && raw.repo_root) ||
    (typeof raw.project_path === "string" && raw.project_path) ||
    "~/workspace";

  const branch =
    (typeof raw.branch === "string" && raw.branch) ||
    (typeof raw.worktree_branch === "string" && raw.worktree_branch) ||
    "main";

  const worktreePath =
    (typeof raw.worktree_path === "string" && raw.worktree_path) || repoRoot;

  const rawDiff = (raw.diff_stats as Record<string, unknown> | undefined) ?? {};
  const diffStats: GitDiffStats = {
    files_changed: Number(rawDiff.files_changed ?? 0),
    insertions: Number(rawDiff.insertions ?? 0),
    deletions: Number(rawDiff.deletions ?? 0),
    modified_files: Array.isArray(rawDiff.modified_files)
      ? (rawDiff.modified_files as string[])
      : [],
  };

  let provider: AgentProvider = "claude";
  if (raw.provider === "claude" || raw.provider === "claude_code") {
    provider = "claude";
  } else if (raw.provider === "codex") {
    provider = "codex";
  } else if (raw.provider === "opencode") {
    provider = "opencode";
  } else if (typeof raw.provider === "object" && raw.provider !== null) {
    provider = raw.provider as { custom: string };
  }

  return {
    id: String(raw.id ?? "session-default"),
    name: String(raw.name ?? "workspace-agent"),
    provider,
    prompt: String(raw.prompt ?? ""),
    repo_root: repoRoot,
    worktree_path: worktreePath,
    branch,
    status: (raw.status as SessionStatus) || "completed",
    pid: typeof raw.pid === "number" ? raw.pid : null,
    diff_stats: diffStats,
    created_at:
      typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
    updated_at:
      typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
    parent_session_id:
      typeof raw.parent_session_id === "string" ? raw.parent_session_id : null,
  };
}

export function normalizeEvent(raw: Record<string, unknown>): UIEventItem | null {
  const tag = String(raw.type ?? raw.kind ?? "");
  switch (tag) {
    case "user_input":
      return { kind: "user_input", content: String(raw.content ?? raw.text ?? "") };
    case "assistant_message":
    case "message_delta":
      return { kind: "assistant_message", text: String(raw.text ?? "") };
    case "thinking":
    case "thinking_delta":
      return { kind: "thinking", text: String(raw.text ?? "") };
    case "tool_use":
    case "tool_call_requested":
      return {
        kind: "tool_use",
        tool_name: String(raw.tool_name ?? "tool"),
        input: raw.arguments ?? raw.input ?? {},
      };
    case "tool_result":
    case "tool_call_completed":
      return {
        kind: "tool_result",
        tool_name: String(raw.tool_name ?? raw.tool_id ?? "tool"),
        output: String(raw.output ?? ""),
        is_error: Boolean(raw.is_error),
      };
    case "pty_data":
    case "pty_output":
      return {
        kind: "pty_data",
        data: String(raw.line ?? raw.data ?? ""),
      };
    case "status_changed":
      return {
        kind: "status_changed",
        status: String(raw.status ?? "completed"),
        message: typeof raw.message === "string" ? raw.message : null,
      };
    case "error":
      return {
        kind: "tool_result",
        tool_name: "error",
        output: String(raw.error ?? "Agent error"),
        is_error: true,
      };
    default:
      return null;
  }
}

export function renderAsciiQrForUri(uri: string): string {
  const bytes = Array.from(uri).map((c) => c.charCodeAt(0));
  const size = 15;
  const lines: string[] = [];
  lines.push("┌────────────────────────────────┐");
  for (let r = 0; r < size; r++) {
    let row = "│ ";
    for (let c = 0; c < size; c++) {
      const isFinder =
        (r < 3 && c < 3) ||
        (r < 3 && c >= size - 3) ||
        (r >= size - 3 && c < 3);
      if (isFinder) {
        row += "██";
      } else {
        const idx = (r * size + c) % Math.max(1, bytes.length);
        const bit = ((bytes[idx] >> ((r + c) % 8)) & 1) === 1;
        row += bit ? "██" : "  ";
      }
    }
    row += " │";
    lines.push(row);
  }
  lines.push("└────────────────────────────────┘");
  return lines.join("\n");
}
