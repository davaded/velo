export type AgentKind =
  | "claude"
  | "codex"
  | "agy"
  | "grok"
  | "cursor"
  | "opencode"
  | "copilot"
  | "qwen"
  | string;
export type ApprovalMode = "auto_edit" | "ask_before_edit" | "bypass";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "ultra" | "max";

export interface ModelOption {
  id: string;
  label: string;
  shortLabel: string;
  family: "Anthropic" | "OpenAI" | "Google Antigravity" | "xAI Grok" | "Cursor" | string;
  runtimeId:
    | "claude"
    | "codex"
    | "agy"
    | "grok"
    | "cursor-agent"
    | "opencode"
    | "copilot"
    | "qwen"
    | string;
  agentKind: AgentKind;
  desc: string;
  installed?: boolean;
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
  // Google Antigravity CLI (`agy` — curl -fsSL https://antigravity.google/cli/install.sh | bash)
  {
    id: "gemini-4-carbon-high",
    label: "Gemini 4 Carbon (High)",
    shortLabel: "Gemini 4 Carbon High",
    family: "Google Antigravity",
    runtimeId: "agy",
    agentKind: "agy",
    desc: "Google Antigravity CLI (`agy`) · Gemini 4 Carbon flagship coding & reasoning",
    isDefault: true,
  },
  {
    id: "gemini-4-carbon-medium",
    label: "Gemini 4 Carbon (Medium)",
    shortLabel: "Gemini 4 Carbon",
    family: "Google Antigravity",
    runtimeId: "agy",
    agentKind: "agy",
    desc: "Google Antigravity CLI (`agy`) · Balanced speed and reasoning depth",
  },
  {
    id: "gemini-4-argon-high",
    label: "Gemini 4 Argon (High)",
    shortLabel: "Gemini 4 Argon High",
    family: "Google Antigravity",
    runtimeId: "agy",
    agentKind: "agy",
    desc: "Google Antigravity CLI (`agy`) · Gemini 4 Argon high-effort reasoning",
  },
  {
    id: "gemini-3.8-flash-high",
    label: "Gemini 3.8 Flash (High)",
    shortLabel: "Gemini 3.8 Flash",
    family: "Google Antigravity",
    runtimeId: "agy",
    agentKind: "agy",
    desc: "Google Antigravity CLI (`agy`) · Low-latency Flash agentic execution",
  },
  {
    id: "gpt-oss-120b-medium",
    label: "GPT-OSS 120B (Medium)",
    shortLabel: "GPT-OSS 120B",
    family: "Google Antigravity",
    runtimeId: "agy",
    agentKind: "agy",
    desc: "Google Antigravity CLI (`agy`) · Open-weight 120B coding model",
  },
  // xAI Grok CLI (`grok` — ~/.grok/bin/grok & ~/.grok/models_cache.json)
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    shortLabel: "Grok 4.6",
    family: "xAI Grok",
    runtimeId: "grok",
    agentKind: "grok",
    desc: "Default in ~/.grok/config.toml · Balanced frontier coding & tool execution",
    isDefault: true,
  },
  {
    id: "grok-4.7",
    label: "Grok 4.7",
    shortLabel: "Grok 4.7",
    family: "xAI Grok",
    runtimeId: "grok",
    agentKind: "grok",
    desc: "SpaceXAI's latest frontier model (`grok -p --output-format streaming-messages-json`)",
  },
  {
    id: "grok-4.7-build-fast",
    label: "Grok 4.7 Fast",
    shortLabel: "Grok 4.7 Fast",
    family: "xAI Grok",
    runtimeId: "grok",
    agentKind: "grok",
    desc: "Fast low-latency Grok 4.7 coding variant",
  },
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    shortLabel: "Grok 4.5",
    family: "xAI Grok",
    runtimeId: "grok",
    agentKind: "grok",
    desc: "Efficient secondary & subagent Grok model",
  },
  // Cursor Agent CLI (`cursor-agent` / `agent` — ~/.local/bin/cursor-agent)
  {
    id: "cursor:auto",
    label: "Cursor Auto",
    shortLabel: "Cursor Auto",
    family: "Cursor",
    runtimeId: "cursor-agent",
    agentKind: "cursor",
    desc: "Cursor Agent CLI auto-router (`cursor-agent -p --output-format stream-json`)",
    isDefault: true,
  },
  {
    id: "cursor:composer",
    label: "Cursor Composer",
    shortLabel: "Cursor Composer",
    family: "Cursor",
    runtimeId: "cursor-agent",
    agentKind: "cursor",
    desc: "Cursor native multi-file fast coding model (`--model composer`)",
  },
  {
    id: "cursor:claude-sonnet-4-6",
    label: "Cursor · Claude Sonnet 4.6",
    shortLabel: "Cursor Sonnet 4.6",
    family: "Cursor",
    runtimeId: "cursor-agent",
    agentKind: "cursor",
    desc: "Claude Sonnet 4.6 routed via Cursor Agent CLI",
  },
  {
    id: "cursor:claude-opus-4-8",
    label: "Cursor · Claude Opus 4.8",
    shortLabel: "Cursor Opus 4.8",
    family: "Cursor",
    runtimeId: "cursor-agent",
    agentKind: "cursor",
    desc: "Claude Opus 4.8 routed via Cursor Agent CLI",
  },
  {
    id: "cursor:gpt-5",
    label: "Cursor · GPT-5",
    shortLabel: "Cursor GPT-5",
    family: "Cursor",
    runtimeId: "cursor-agent",
    agentKind: "cursor",
    desc: "OpenAI GPT-5 routed via Cursor Agent CLI",
  },
  // ACP (Agent Client Protocol) & Multi-Provider Ecosystem
  {
    id: "acp-opencode",
    label: "OpenCode (ACP)",
    shortLabel: "OpenCode",
    family: "ACP · OpenCode",
    runtimeId: "opencode",
    agentKind: "acp:opencode acp",
    desc: "Agent Client Protocol JSON-RPC stdio integration for OpenCode",
  },
  {
    id: "acp-copilot",
    label: "GitHub Copilot CLI",
    shortLabel: "Copilot",
    family: "ACP · GitHub",
    runtimeId: "copilot",
    agentKind: "copilot",
    desc: "GitHub Copilot coding agent CLI adapter",
  },
  {
    id: "acp-qwen-code",
    label: "Qwen Code (ACP)",
    shortLabel: "Qwen Code",
    family: "ACP · Qwen",
    runtimeId: "qwen",
    agentKind: "acp:qwen --acp",
    desc: "Agent Client Protocol JSON-RPC stdio integration for Qwen Code",
  },
];

export interface VeloRepo {
  id: string;
  code: string;
  name: string;
  path: string;
  default_branch: string;
}

export interface QueuedPromptDto {
  id: string;
  input: string;
  images?: string[];
  model?: string | null;
  effort?: string | null;
  created_at?: string;
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
  preview_url?: string | null;
  queued_prompts?: QueuedPromptDto[];
  tokens_used: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
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
  images?: string[];
  is_streaming_chunk?: boolean;
  tool_name?: string;
  tool_args?: string;
  tool_input?: unknown;
  tool_output?: string;
  tool_is_error?: boolean;
  started_at_ms?: number;
  duration_ms?: number;
  completed_at?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cost_usd?: number;
  tps?: number;
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
    path: "~/velo",
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
    effort: "medium",
    status: "idle",
    branch_name: "main",
    worktree_path: "~/velo",
    project_path: "~/velo",
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
  {
    cmd: "/automations",
    label: "Velo Hub Automations",
    desc: "管理 Cron 定时任务与 GitHub / 通用 Webhook 自动工作流",
  },
  {
    cmd: "/pr",
    label: "GitHub Pull Request",
    desc: "打开右侧 PR 面板查看 CI 状态、一键创建或合并 PR",
  },
  {
    cmd: "/browser",
    label: "Workspace Browser Preview",
    desc: "打开内置浏览器预览面板并允许 Agent 检查 DOM 与运行态",
  },
  {
    cmd: "/analytics",
    label: "Usage & Billing Analytics",
    desc: "查看各引擎真实费率账单、Prompt 缓存命中率、tok/s 统计与锁屏盲推送设置",
  },
  {
    cmd: "/search",
    label: "Global Transcript Search",
    desc: "跨全部工作区与历史会话全文检索 Prompt 与 AI 回复",
  },
];

export function canonicalRepoPath(rawPath: string): string {
  const trimmed = (rawPath || "").trim();
  if (!trimmed) return "~/velo";
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

export function repoIdFromPath(rawPath: string): string {
  const clean = canonicalRepoPath(rawPath);
  if (clean.endsWith("/code/velo") || clean === "~/velo") return "repo-velo";
  if (clean.endsWith("/code/velo-cloud")) return "repo-velo-cloud";
  const slug = clean
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `repo-${slug || "workspace"}`;
}

export function normalizeToVeloSession(raw: unknown, idx = 0): VeloSession {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const diff = (r.diff_stats && typeof r.diff_stats === "object" ? r.diff_stats : {}) as Record<
    string,
    unknown
  >;
  const branch = String(r.branch_name ?? r.branch ?? `feat/worktree-${idx + 1}`);
  let agentKind: AgentKind = "claude";
  if (typeof r.agent_kind === "string" && r.agent_kind.trim()) {
    agentKind = r.agent_kind.trim();
  } else if (typeof r.provider === "string" && r.provider.trim()) {
    agentKind = r.provider.trim();
  } else if (r.provider && typeof r.provider === "object") {
    const provObj = r.provider as Record<string, unknown>;
    if (typeof provObj.acp === "string") {
      agentKind = `acp:${provObj.acp}`;
    }
  }
  const modelId = String(
    r.model ??
      (agentKind === "codex"
        ? "gpt-6.1-sol"
        : agentKind === "grok" || agentKind.includes("grok")
        ? "grok-4.6"
        : agentKind === "cursor" || agentKind.includes("cursor")
        ? "cursor:auto"
        : agentKind === "agy" || agentKind.includes("antigravity") || agentKind.includes("gemini")
        ? "gemini-4-carbon-high"
        : agentKind.includes("opencode")
        ? "acp-opencode"
        : agentKind.includes("copilot")
        ? "acp-copilot"
        : agentKind.includes("qwen")
        ? "acp-qwen-code"
        : "claude-fable-5-2")
  );
  const foundModel = MODEL_CATALOG.find((m) => m.id === modelId);
  const rawStatus = String(r.status ?? "idle");
  const status: VeloSession["status"] =
    rawStatus === "running" || rawStatus === "starting"
      ? "running"
      : rawStatus === "waiting_for_permission" || rawStatus === "waiting_permission"
      ? "waiting_approval"
      : "idle";
  const rawEff = String(r.effort ?? "");
  const effort: EffortLevel =
    rawEff === "low" ||
    rawEff === "medium" ||
    rawEff === "high" ||
    rawEff === "xhigh" ||
    rawEff === "ultra" ||
    rawEff === "max"
      ? rawEff
      : "medium";
  const rawMode = String(r.approval_mode ?? "auto_edit");
  const approvalMode: ApprovalMode =
    rawMode === "ask_before_edit" || rawMode === "bypass" ? rawMode : "auto_edit";
  const projectPath = canonicalRepoPath(
    String(r.project_path ?? r.repo_root ?? "~/velo")
  );
  const worktreePath = canonicalRepoPath(String(r.worktree_path ?? projectPath));
  const resolvedRepoId =
    typeof r.repo_id === "string" && r.repo_id.trim()
      ? r.repo_id.trim()
      : repoIdFromPath(projectPath);

  return {
    id: String(r.id ?? `daemon-${idx}`),
    repo_id: resolvedRepoId,
    title: String(r.title ?? r.name ?? r.prompt ?? branch),
    agent_kind: agentKind,
    model: modelId,
    model_short:
      foundModel?.shortLabel ??
      (agentKind === "codex"
        ? "GPT-6.1-Sol"
        : agentKind === "grok" || agentKind.includes("grok")
        ? "Grok 4.6"
        : agentKind === "cursor" || agentKind.includes("cursor")
        ? "Cursor Auto"
        : agentKind === "agy" || agentKind.includes("antigravity") || agentKind.includes("gemini")
        ? "Gemini 4 Carbon High"
        : agentKind.includes("opencode")
        ? "OpenCode"
        : "Claude Fable 5.2"),
    effort,
    status,
    branch_name: branch,
    worktree_path: worktreePath,
    project_path: projectPath,
    approval_mode: approvalMode,
    preview_url: typeof r.preview_url === "string" ? r.preview_url : null,
    queued_prompts: Array.isArray(r.queued_prompts)
      ? (r.queued_prompts as QueuedPromptDto[])
      : [],
    tokens_used: Number(r.tokens_used ?? 0),
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    cache_read_tokens: Number(r.cache_read_tokens ?? 0),
    tokens_limit: Number(r.context_window || r.tokens_limit || 200000),
    cost_usd: Number(r.cost_usd ?? 0),
    files_changed: Number(r.files_changed ?? diff.files_changed ?? 0),
    insertions: Number(r.insertions ?? diff.insertions ?? 0),
    deletions: Number(r.deletions ?? diff.deletions ?? 0),
    updated_at: status === "running" ? "running" : "ready",
  };
}
