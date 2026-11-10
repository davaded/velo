export type AgentKind = "claude" | "codex" | "gemini";
export type ApprovalMode = "auto_edit" | "ask_before_edit" | "full_auto";
export type EffortLevel = "low" | "medium" | "high" | "max";

export interface ModelOption {
  id: string;
  label: string;
  shortLabel: string;
  family: "Anthropic" | "OpenAI" | "Google";
  runtimeId: "claude" | "codex" | "gemini";
  agentKind: AgentKind;
  desc: string;
}

export const MODEL_CATALOG: ModelOption[] = [
  {
    id: "claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    shortLabel: "Claude Sonnet 4.5",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "主力编码模型，兼顾速度与代码质量",
  },
  {
    id: "claude-opus-4.5",
    label: "Claude Opus 4.5",
    shortLabel: "Claude Opus 4.5",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "深度架构设计与复杂跨模块重构",
  },
  {
    id: "claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    shortLabel: "Claude Haiku 4.5",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "超快响应，适合轻量修改与快速问答",
  },
  {
    id: "o3",
    label: "o3",
    shortLabel: "o3",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "高强推理模型，适合疑难 Bug 与算法攻坚",
  },
  {
    id: "o4-mini",
    label: "o4-mini",
    shortLabel: "o4-mini",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "极速高性价比编码与自动化测试生成",
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    shortLabel: "GPT-4.1",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "通用全栈开发与稳健指令遵循",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    shortLabel: "Gemini 2.5 Pro",
    family: "Google",
    runtimeId: "gemini",
    agentKind: "gemini",
    desc: "百万长上下文全库分析",
  },
];

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
  effort?: EffortLevel;
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
    model_short: "Claude Sonnet 4.5",
    effort: "medium",
    status: "idle",
    branch_name: "feat/ws-reconnection",
    worktree_path: "/Users/daiyudai/code/velo",
    project_path: "/Users/daiyudai/code/velo",
    approval_mode: "auto_edit",
    tokens_used: 12400,
    tokens_limit: 200000,
    cost_usd: 0.04,
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    updated_at: "just now",
  },
  {
    id: "sess-2",
    repo_id: "repo-velo",
    title: "修复并发 Worktree 锁竞争",
    agent_kind: "codex",
    model: "o3",
    model_short: "o3",
    effort: "high",
    status: "idle",
    branch_name: "fix/worktree-gc-lock",
    worktree_path: "/Users/daiyudai/code/velo",
    project_path: "/Users/daiyudai/code/velo",
    approval_mode: "auto_edit",
    tokens_used: 8200,
    tokens_limit: 200000,
    cost_usd: 0.03,
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    updated_at: "2m ago",
  },
  {
    id: "sess-4",
    repo_id: "repo-nexus",
    title: "零拷贝 Tokio IPC 帧调度",
    agent_kind: "claude",
    model: "claude-opus-4.5",
    model_short: "Claude Opus 4.5",
    effort: "high",
    status: "idle",
    branch_name: "perf/zero-copy-ipc",
    worktree_path: "/Users/daiyudai/code/nexus-engine",
    project_path: "/Users/daiyudai/code/nexus-engine",
    approval_mode: "auto_edit",
    tokens_used: 14200,
    tokens_limit: 200000,
    cost_usd: 0.08,
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    updated_at: "10m ago",
  },
  {
    id: "sess-5",
    repo_id: "repo-uikit",
    title: "自适应系统主题变量导出",
    agent_kind: "codex",
    model: "o4-mini",
    model_short: "o4-mini",
    effort: "medium",
    status: "idle",
    branch_name: "feat/theme-tokens",
    worktree_path: "/Users/daiyudai/code/design-tokens",
    project_path: "/Users/daiyudai/code/design-tokens",
    approval_mode: "auto_edit",
    tokens_used: 6900,
    tokens_limit: 200000,
    cost_usd: 0.02,
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    updated_at: "14m ago",
  },
];

export const DEMO_EVENTS: Record<string, AgentEvent[]> = {};

export const DEMO_DIFF_FILES: DiffFileItem[] = [];

export const SLASH_SKILLS: SlashSkillItem[] = [
  {
    cmd: "/handoff",
    label: "Context Handoff",
    desc: "将当前长对话无损压缩为结构化架构摘要并迁移至新 Worktree",
  },
  {
    cmd: "/advisor",
    label: "Architect Advisor",
    desc: "调用高阶推理模型 (Claude Opus 4.5 / o3) 审计当前 Worktree Diff",
  },
  {
    cmd: "/committee",
    label: "Dual-Model Committee Race",
    desc: "同时派发两个模型在独立 Git Worktree 分支并发实现同一需求",
  },
  {
    cmd: "/loop",
    label: "TDD Verification Loop",
    desc: "持续运行模型并自动执行验收测试命令直到全部通过",
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
  const modelId = String(
    r.model ?? (agentKind === "codex" ? "o3" : agentKind === "gemini" ? "gemini-2.5-pro" : "claude-sonnet-4.5")
  );
  const foundModel = MODEL_CATALOG.find((m) => m.id === modelId);
  const rawStatus = String(r.status ?? "idle");
  const status: VeloSession["status"] =
    rawStatus === "running" || rawStatus === "starting"
      ? "running"
      : rawStatus === "waiting_for_permission"
      ? "waiting_approval"
      : "idle";
  return {
    id: String(r.id ?? `daemon-${idx}`),
    repo_id: String(r.repo_id ?? "repo-velo"),
    title: String(r.title ?? r.prompt ?? r.name ?? branch),
    agent_kind: agentKind,
    model: modelId,
    model_short:
      foundModel?.shortLabel ??
      (agentKind === "codex" ? "o3" : agentKind === "gemini" ? "Gemini 2.5 Pro" : "Claude Sonnet 4.5"),
    effort: "medium",
    status,
    branch_name: branch,
    worktree_path: String(r.worktree_path ?? `/Users/daiyudai/code/velo`),
    project_path: String(r.project_path ?? r.repo_root ?? "/Users/daiyudai/code/velo"),
    approval_mode: "auto_edit",
    tokens_used: Number(r.tokens_used ?? 0),
    tokens_limit: Number(r.tokens_limit ?? 200000),
    cost_usd: Number(r.cost_usd ?? 0),
    files_changed: Number(r.files_changed ?? diff.files_changed ?? 0),
    insertions: Number(r.insertions ?? diff.insertions ?? 0),
    deletions: Number(r.deletions ?? diff.deletions ?? 0),
    updated_at: status === "running" ? "running" : "ready",
  };
}
