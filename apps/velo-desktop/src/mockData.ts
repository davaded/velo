export type AgentKind = "claude" | "codex" | "gemini";
export type ApprovalMode = "auto_edit" | "ask_before_edit" | "full_auto";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "ultra" | "max";

export interface ModelOption {
  id: string;
  label: string;
  shortLabel: string;
  family: "Anthropic" | "OpenAI" | "Google";
  runtimeId: "claude" | "codex" | "gemini";
  agentKind: AgentKind;
  desc: string;
  isDefault?: boolean;
}

export const MODEL_CATALOG: ModelOption[] = [
  // Anthropic / Claude Code (v2.1.317 local models)
  {
    id: "claude-fable-5-2",
    label: "Claude Fable 5.2",
    shortLabel: "Fable 5.2",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "Fable 5.2 · Most capable for your hardest and longest-running coding tasks",
    isDefault: true,
  },
  {
    id: "claude-fable-5-1[1m]",
    label: "Claude Fable 5.1 (1M)",
    shortLabel: "Fable 5.1",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "Fable 5.1 · 1M context window for large codebase tasks",
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    shortLabel: "Opus 5.5",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "Deep architectural reasoning & multi-file autonomous coding (Ultrathink)",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    shortLabel: "Sonnet 5",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "Fast, balanced everyday coding and agentic tool execution",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    shortLabel: "Opus 4.8",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "Previous-gen flagship Opus with Fast Mode support",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    shortLabel: "Sonnet 4.6",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "High-efficiency coding with adaptive effort",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    shortLabel: "Haiku 4.5",
    family: "Anthropic",
    runtimeId: "claude",
    agentKind: "claude",
    desc: "Ultra-low latency for quick edits and lightweight lookups",
  },
  // OpenAI / Codex CLI (~/.codex/config.toml & ~/.codex/codex-models.json)
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1-Sol",
    shortLabel: "GPT-6.1-Sol",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "Default in ~/.codex/config.toml · Latest workhorse model for coding and everyday work.",
    isDefault: true,
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    shortLabel: "GPT-6 Sol",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "OpenAI GPT-6 Sol coding model",
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    shortLabel: "GPT-6 Luna",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "OpenAI GPT-6 Luna coding model",
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    shortLabel: "GPT-6 Astra",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "OpenAI GPT-6 Astra coding model",
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    shortLabel: "GPT-5.6 Sol",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "OpenAI GPT-5.6 Sol coding model",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    shortLabel: "GPT-5.6 Luna",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "OpenAI GPT-5.6 Luna coding model",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    shortLabel: "GPT-5.6 Terra",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "OpenAI GPT-5.6 Terra coding model",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    shortLabel: "GPT-5.5",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "OpenAI GPT-5.5 coding model",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    shortLabel: "GPT-5.4 Mini",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "Fast, lightweight GPT-5.4 Mini coding model",
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    shortLabel: "Codex Spark",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "Specialized ultra-fast Codex Spark model",
  },
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    shortLabel: "Grok 4.6",
    family: "OpenAI",
    runtimeId: "codex",
    agentKind: "codex",
    desc: "Grok 4.6 coding and reasoning model via Codex CLI",
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
];

export const DEMO_SESSIONS: VeloSession[] = [
  {
    id: "sess-default",
    repo_id: "repo-velo",
    title: "New thread",
    agent_kind: "claude",
    model: "claude-fable-5-2",
    model_short: "Claude Fable 5.2",
    effort: "high",
    status: "idle",
    branch_name: "main",
    worktree_path: "/Users/daiyudai/code/velo",
    project_path: "/Users/daiyudai/code/velo",
    approval_mode: "auto_edit",
    tokens_used: 0,
    tokens_limit: 200000,
    cost_usd: 0,
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    updated_at: "ready",
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
    desc: "调用高阶推理模型 (Claude Fable 5.2 / GPT-6.1-Sol) 审计当前 Worktree Diff",
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
    r.model ?? (agentKind === "codex" ? "gpt-6.1-sol" : "claude-fable-5-2")
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
