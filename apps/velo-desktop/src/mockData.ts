export type AgentKind = "claude" | "codex" | "gemini";
export type ApprovalMode = "auto_edit" | "ask_before_edit" | "full_auto";

export interface VeloRepo {
  id: string;
  code: string;
  name: string;
  path: string;
  default_branch: string;
}

export interface VeloSession {
  id: string;
  repo_id: string;
  title: string;
  agent_kind: AgentKind;
  model: string;
  model_short: string;
  status: "running" | "waiting_approval" | "idle";
  branch_name: string;
  worktree_path: string;
  project_path: string;
  approval_mode: ApprovalMode;
  tokens_used: number;
  tokens_limit: number;
  cost_usd: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  updated_at: string;
}

export interface AgentEvent {
  id: string;
  session_id: string;
  timestamp: string;
  kind: "user" | "thinking" | "tool_call" | "assistant";
  content: string;
  tool_name?: string;
  tool_args?: string;
  duration_ms?: number;
}

export interface DiffHunkLine {
  type: "ctx" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface DiffFileItem {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunkLine[];
}

export interface SlashSkillItem {
  cmd: string;
  label: string;
  desc: string;
}

export const DEMO_REPOS: VeloRepo[] = [
  {
    id: "repo-velo",
    code: "VL",
    name: "velo",
    path: "/Users/daiyudai/code/velo",
    default_branch: "main",
  },
  {
    id: "repo-nexus",
    code: "NX",
    name: "nexus-engine",
    path: "/Users/daiyudai/code/nexus-engine",
    default_branch: "main",
  },
  {
    id: "repo-uikit",
    code: "UI",
    name: "design-tokens",
    path: "/Users/daiyudai/code/design-tokens",
    default_branch: "main",
  },
];

export const DEMO_SESSIONS: VeloSession[] = [
  {
    id: "sess-1",
    repo_id: "repo-velo",
    title: "WebSocket 指数退避与环形缓冲",
    agent_kind: "claude",
    model: "claude-sonnet-4.5",
    model_short: "claude-4.5",
    status: "running",
    branch_name: "feat/ws-reconnection",
    worktree_path: "/Users/daiyudai/code/velo/.velo/worktrees/ws-reconnect",
    project_path: "/Users/daiyudai/code/velo",
    approval_mode: "auto_edit",
    tokens_used: 36400,
    tokens_limit: 200000,
    cost_usd: 0.14,
    files_changed: 3,
    insertions: 48,
    deletions: 14,
    updated_at: "just now",
  },
  {
    id: "sess-2",
    repo_id: "repo-velo",
    title: "修复并发 Worktree 锁竞争",
    agent_kind: "codex",
    model: "codex-o3",
    model_short: "codex-o3",
    status: "waiting_approval",
    branch_name: "fix/worktree-gc-lock",
    worktree_path: "/Users/daiyudai/code/velo/.velo/worktrees/gc-lock",
    project_path: "/Users/daiyudai/code/velo",
    approval_mode: "ask_before_edit",
    tokens_used: 21800,
    tokens_limit: 200000,
    cost_usd: 0.09,
    files_changed: 2,
    insertions: 19,
    deletions: 5,
    updated_at: "1m ago",
  },
  {
    id: "sess-3",
    repo_id: "repo-velo",
    title: "MCP JSON-RPC 工具桥接器",
    agent_kind: "gemini",
    model: "gemini-2.5-pro",
    model_short: "gemini-2.5",
    status: "idle",
    branch_name: "chore/mcp-bridge-tools",
    worktree_path: "/Users/daiyudai/code/velo/.velo/worktrees/mcp-bridge",
    project_path: "/Users/daiyudai/code/velo",
    approval_mode: "auto_edit",
    tokens_used: 52000,
    tokens_limit: 1000000,
    cost_usd: 0.11,
    files_changed: 4,
    insertions: 112,
    deletions: 8,
    updated_at: "6m ago",
  },
  {
    id: "sess-4",
    repo_id: "repo-nexus",
    title: "零拷贝 Tokio IPC 帧调度",
    agent_kind: "claude",
    model: "claude-opus-4.6",
    model_short: "opus-4.6",
    status: "running",
    branch_name: "perf/zero-copy-ipc",
    worktree_path: "/Users/daiyudai/code/nexus-engine/.velo/worktrees/zero-copy",
    project_path: "/Users/daiyudai/code/nexus-engine",
    approval_mode: "auto_edit",
    tokens_used: 41200,
    tokens_limit: 200000,
    cost_usd: 0.28,
    files_changed: 5,
    insertions: 86,
    deletions: 21,
    updated_at: "30s ago",
  },
  {
    id: "sess-5",
    repo_id: "repo-uikit",
    title: "黑白灰 Zinc 变量与主题导出",
    agent_kind: "codex",
    model: "codex-o3",
    model_short: "codex-o3",
    status: "idle",
    branch_name: "feat/monochrome-tokens",
    worktree_path: "/Users/daiyudai/code/design-tokens/.velo/worktrees/mono",
    project_path: "/Users/daiyudai/code/design-tokens",
    approval_mode: "auto_edit",
    tokens_used: 12900,
    tokens_limit: 200000,
    cost_usd: 0.04,
    files_changed: 2,
    insertions: 64,
    deletions: 12,
    updated_at: "14m ago",
  },
];

export const DEMO_EVENTS: Record<string, AgentEvent[]> = {
  "sess-1": [
    {
      id: "ev-1",
      session_id: "sess-1",
      timestamp: "00:12:04",
      kind: "user",
      content:
        "重构 velo-daemon 的 WebSocket 重连与指数退避策略，并确保断线期间的 PTY 增量帧可以从环形缓冲区无损回放。",
    },
    {
      id: "ev-2",
      session_id: "sess-1",
      timestamp: "00:12:05",
      kind: "thinking",
      content:
        "Inspecting crates/velo-protocol/src/lib.rs and crates/velo-daemon/src/main.rs. We need a deterministic ReconnectPolicy struct with jitter_ratio and a bounded ring buffer per session so reconnecting clients resume from last_seq without frame loss.",
    },
    {
      id: "ev-3",
      session_id: "sess-1",
      timestamp: "00:12:07",
      kind: "tool_call",
      tool_name: "Edit",
      tool_args: "crates/velo-protocol/src/lib.rs",
      content:
        "@@ -42,6 +42,14 @@\n+pub struct ReconnectPolicy {\n+    pub base_delay_ms: u64,\n+    pub max_delay_ms: u64,\n+    pub jitter_ratio: f32,\n+}",
      duration_ms: 38,
    },
    {
      id: "ev-4",
      session_id: "sess-1",
      timestamp: "00:12:09",
      kind: "tool_call",
      tool_name: "Edit",
      tool_args: "crates/velo-daemon/src/main.rs",
      content:
        "@@ -118,4 +118,12 @@\n+    let backoff = policy.next_delay(attempt);\n+    tracing::info!(?backoff, attempt, \"ws client re-subscribed with ring replay\");",
      duration_ms: 52,
    },
    {
      id: "ev-5",
      session_id: "sess-1",
      timestamp: "00:12:12",
      kind: "assistant",
      content:
        "已完成 `ReconnectPolicy` 指数退避与 `last_seq` 环形缓冲回放机制（共修改 3 个文件，`+48 −14`）。\n你可以直接点击上方的文件修改胶囊（如 `Edit crates/velo-protocol/src/lib.rs`）或右上角的 `Diff` 按钮，按需滑出右侧的 Git Diff & PTY 抽屉。",
    },
  ],
  "sess-2": [
    {
      id: "ev-201",
      session_id: "sess-2",
      timestamp: "00:09:30",
      kind: "user",
      content: "修复并发创建 Git Worktree 时的 .git/worktrees 锁竞争问题。",
    },
    {
      id: "ev-202",
      session_id: "sess-2",
      timestamp: "00:09:34",
      kind: "tool_call",
      tool_name: "Edit",
      tool_args: "crates/velo-worktree/src/lib.rs",
      content: "+    let _guard = self.repo_lock.lock().await;",
      duration_ms: 41,
    },
    {
      id: "ev-203",
      session_id: "sess-2",
      timestamp: "00:09:38",
      kind: "assistant",
      content: "已为 `WorktreeManager` 增加异步互斥锁并在异常退出时自动清理陈旧 `.lock` 文件。",
    },
  ],
  "sess-3": [
    {
      id: "ev-301",
      session_id: "sess-3",
      timestamp: "00:04:12",
      kind: "assistant",
      content: "MCP JSON-RPC 2.0 桥接器已就绪，支持 `spawn_subagent`、`list_worktrees` 与 `handoff_context`。",
    },
  ],
};

export const DEMO_DIFF_FILES: DiffFileItem[] = [
  {
    path: "crates/velo-protocol/src/lib.rs",
    additions: 24,
    deletions: 3,
    hunks: [
      { type: "ctx", oldLine: 39, newLine: 39, content: "#[derive(Debug, Clone, Serialize, Deserialize)]" },
      { type: "ctx", oldLine: 40, newLine: 40, content: "pub struct WsEnvelope {" },
      { type: "del", oldLine: 41, content: "    pub reconnect_ms: u64," },
      { type: "add", newLine: 41, content: "    pub seq: u64," },
      { type: "add", newLine: 42, content: "    pub policy: ReconnectPolicy," },
      { type: "ctx", oldLine: 42, newLine: 43, content: "}" },
      { type: "add", newLine: 44, content: "" },
      { type: "add", newLine: 45, content: "#[derive(Debug, Clone, Serialize, Deserialize)]" },
      { type: "add", newLine: 46, content: "pub struct ReconnectPolicy {" },
      { type: "add", newLine: 47, content: "    pub base_delay_ms: u64," },
      { type: "add", newLine: 48, content: "    pub max_delay_ms: u64," },
      { type: "add", newLine: 49, content: "    pub jitter_ratio: f32," },
      { type: "add", newLine: 50, content: "}" },
    ],
  },
  {
    path: "crates/velo-daemon/src/main.rs",
    additions: 18,
    deletions: 7,
    hunks: [
      { type: "ctx", oldLine: 114, newLine: 114, content: "async fn handle_ws_client(socket: WebSocket, state: Arc<AppState>) {" },
      { type: "del", oldLine: 115, content: "    let mut rx = state.tx.subscribe();" },
      { type: "add", newLine: 115, content: "    let (replay, mut rx) = state.ring.subscribe_from(last_seq).await;" },
      { type: "add", newLine: 116, content: "    for frame in replay {" },
      { type: "add", newLine: 117, content: "        let _ = socket.send(Message::Text(frame)).await;" },
      { type: "add", newLine: 118, content: "    }" },
      { type: "ctx", oldLine: 116, newLine: 119, content: "}" },
    ],
  },
  {
    path: "crates/velo-worktree/src/lib.rs",
    additions: 6,
    deletions: 4,
    hunks: [
      { type: "ctx", oldLine: 72, newLine: 72, content: "pub async fn create_isolated_worktree(&self, branch: &str) -> Result<PathBuf> {" },
      { type: "add", newLine: 73, content: "    let _guard = self.mutex.lock().await;" },
      { type: "ctx", oldLine: 73, newLine: 74, content: "    self.prune_stale_locks()?;" },
      { type: "ctx", oldLine: 74, newLine: 75, content: "}" },
    ],
  },
];

export const SLASH_SKILLS: SlashSkillItem[] = [
  {
    cmd: "/handoff",
    label: "Context Handoff",
    desc: "将当前长对话无损压缩为结构化架构摘要并迁移至新 Worktree",
  },
  {
    cmd: "/advisor",
    label: "Architect Advisor",
    desc: "调用高阶推理模型 (Opus 4.6 / o3) 审计当前 Worktree Diff 与并发安全性",
  },
  {
    cmd: "/committee",
    label: "Dual-Agent Committee Race",
    desc: "同时派发 Claude Code 与 Codex 在两个独立 Git Worktree 分支并发实现同一需求",
  },
  {
    cmd: "/loop",
    label: "TDD Verification Loop",
    desc: "持续运行 Agent 并自动执行验收测试命令 (cargo test) 直到全部通过",
  },
  {
    cmd: "/worktree-GC",
    label: "Prune Worktrees",
    desc: "清理已合并的孤立 Git Worktree 目录与锁文件",
  },
];

export function normalizeToVeloSession(raw: unknown, idx = 0): VeloSession {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const diff = (r.diff_stats && typeof r.diff_stats === "object" ? r.diff_stats : {}) as Record<
    string,
    unknown
  >;
  const branch = String(r.branch_name ?? r.branch ?? `feat/worktree-${idx + 1}`);
  const agentKind: AgentKind =
    r.agent_kind === "codex" || r.provider === "codex"
      ? "codex"
      : r.agent_kind === "gemini"
      ? "gemini"
      : "claude";
  return {
    id: String(r.id ?? `daemon-${idx}`),
    repo_id: String(r.repo_id ?? "repo-velo"),
    title: String(r.title ?? r.prompt ?? r.name ?? branch),
    agent_kind: agentKind,
    model: String(r.model ?? (agentKind === "codex" ? "codex-o3" : "claude-sonnet-4.5")),
    model_short: agentKind === "codex" ? "codex-o3" : agentKind === "gemini" ? "gemini-2.5" : "claude-4.5",
    status: r.status === "waiting_for_permission" ? "waiting_approval" : "running",
    branch_name: branch,
    worktree_path: String(r.worktree_path ?? `/Users/daiyudai/code/velo/.velo/worktrees/${branch}`),
    project_path: String(r.project_path ?? r.repo_root ?? "/Users/daiyudai/code/velo"),
    approval_mode: "auto_edit",
    tokens_used: Number(r.tokens_used ?? 28400),
    tokens_limit: Number(r.tokens_limit ?? 200000),
    cost_usd: Number(r.cost_usd ?? 0.12),
    files_changed: Number(r.files_changed ?? diff.files_changed ?? 3),
    insertions: Number(r.insertions ?? diff.insertions ?? 32),
    deletions: Number(r.deletions ?? diff.deletions ?? 8),
    updated_at: "live",
  };
}
