import React, { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Folder,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import type { VeloRepo } from "../mockData";

export interface AutomationRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: "cron" | "once" | "github_webhook" | "generic_webhook" | string;
  cron_expr?: string | null;
  schedule_text?: string | null;
  run_at?: string | null;
  webhook_secret?: string | null;
  github_events?: string[];
  repo_path: string;
  branch_prefix: string;
  provider: string;
  model?: string | null;
  prompt_template: string;
  last_run_at?: string | null;
  last_session_id?: string | null;
  run_count: number;
}

export interface ParsedScheduleDto {
  ok: boolean;
  trigger_type: "cron" | "once" | string;
  cron_expr?: string | null;
  run_at?: string | null;
  schedule_text: string;
  next_run_label?: string | null;
  task_prompt: string;
  suggested_name: string;
  hint?: string | null;
}

interface AutomationsModalProps {
  daemonUrl: string;
  defaultRepoPath: string;
  defaultProvider?: string;
  repos?: VeloRepo[];
  onClose: () => void;
  onJumpToSession: (sessionId: string) => void;
  onCountChange?: (enabledCount: number) => void;
}

const QUICK_CHIPS = [
  { label: "每天 09:00", prefix: "每天早上9点 " },
  { label: "工作日 09:00", prefix: "每个工作日早上9点 " },
  { label: "每周五 18:00", prefix: "每周五下午6点 " },
  { label: "每 2 小时", prefix: "每2小时 " },
  { label: "30 分钟后", prefix: "30分钟后 " },
  { label: "明天 10:00", prefix: "明天上午10点 " },
];

const PROVIDER_OPTIONS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "OpenAI Codex" },
  { id: "agy", label: "Antigravity (agy)" },
  { id: "cursor", label: "Cursor Agent" },
];

function formatRuleScheduleBadge(rule: AutomationRuleDto): string {
  if (rule.schedule_text && rule.schedule_text.trim()) {
    return rule.schedule_text;
  }
  if (rule.trigger_type === "github_webhook") return "GitHub Webhook";
  if (rule.trigger_type === "generic_webhook") return "Webhook 触发";
  if (rule.trigger_type === "once" && rule.run_at) {
    try {
      const d = new Date(rule.run_at);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes()
      ).padStart(2, "0")} · 单次`;
    } catch {
      return "单次定时";
    }
  }
  return rule.cron_expr ? `定时 · ${rule.cron_expr}` : "定时任务";
}

function shortRepoName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

export const AutomationsModal: React.FC<AutomationsModalProps> = ({
  daemonUrl,
  defaultRepoPath,
  defaultProvider = "claude",
  repos = [],
  onClose,
  onJumpToSession,
  onCountChange,
}) => {
  const [rules, setRules] = useState<AutomationRuleDto[]>([]);
  const [naturalText, setNaturalText] = useState("");
  const [parsed, setParsed] = useState<ParsedScheduleDto | null>(null);
  const [parsing, setParsing] = useState(false);
  const [provider, setProvider] = useState(defaultProvider || "claude");
  const [repoPath, setRepoPath] = useState(defaultRepoPath);
  const [creating, setCreating] = useState(false);

  // Collapsed Advanced Cron / Webhook section
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advType, setAdvType] = useState<"cron" | "github_webhook" | "generic_webhook">(
    "github_webhook"
  );
  const [advName, setAdvName] = useState("");
  const [advCron, setAdvCron] = useState("0 9 * * 1-5");
  const [advSecret, setAdvSecret] = useState("");
  const [advPrompt, setAdvPrompt] = useState("");

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch(`${daemonUrl}/api/automations`);
      if (res.ok) {
        const d = (await res.json()) as { automations?: AutomationRuleDto[] };
        const list = d.automations || [];
        setRules(list);
        onCountChange?.(list.filter((r) => r.enabled).length);
      }
    } catch {
      // ignore
    }
  }, [daemonUrl, onCountChange]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  // Live natural-language schedule parsing via daemon local-time parser
  useEffect(() => {
    const trimmed = naturalText.trim();
    if (!trimmed) {
      setParsed(null);
      setParsing(false);
      return;
    }
    let cancelled = false;
    setParsing(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${daemonUrl}/api/automations/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
        });
        if (!cancelled && res.ok) {
          const data = (await res.json()) as ParsedScheduleDto;
          setParsed(data);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setParsing(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [naturalText, daemonUrl]);

  const handleNaturalCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = naturalText.trim();
    if (!trimmed || !parsed?.ok || creating) return;
    const taskBody = (parsed.task_prompt || trimmed).trim();
    if (!taskBody) return;
    setCreating(true);
    try {
      await fetch(`${daemonUrl}/api/automations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: parsed.suggested_name || "定时任务",
          enabled: true,
          trigger_type: parsed.trigger_type,
          cron_expr: parsed.cron_expr || null,
          run_at: parsed.run_at || null,
          schedule_text: parsed.schedule_text,
          natural_input: trimmed,
          repo_path: repoPath.trim() || defaultRepoPath,
          branch_prefix: "auto/hub",
          provider,
          prompt_template: taskBody,
        }),
      });
      setNaturalText("");
      setParsed(null);
      await loadRules();
    } finally {
      setCreating(false);
    }
  };

  const handleAdvancedCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!advPrompt.trim() || creating) return;
    setCreating(true);
    try {
      await fetch(`${daemonUrl}/api/automations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:
            advName.trim() ||
            (advType === "cron" ? "自定义 Cron 任务" : "Webhook 自动触发"),
          enabled: true,
          trigger_type: advType,
          cron_expr: advType === "cron" ? advCron.trim() : null,
          webhook_secret: advType !== "cron" ? advSecret.trim() || null : null,
          github_events:
            advType === "github_webhook"
              ? ["issues", "issue_comment", "pull_request", "check_run"]
              : [],
          repo_path: repoPath.trim() || defaultRepoPath,
          branch_prefix: "auto/hub",
          provider,
          prompt_template: advPrompt.trim(),
        }),
      });
      setAdvName("");
      setAdvPrompt("");
      setAdvancedOpen(false);
      await loadRules();
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (rule: AutomationRuleDto) => {
    await fetch(`${daemonUrl}/api/automations/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    await loadRules();
  };

  const handleDelete = async (id: string) => {
    await fetch(`${daemonUrl}/api/automations/${id}`, { method: "DELETE" });
    await loadRules();
  };

  const handleRunNow = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`${daemonUrl}/api/automations/${id}/trigger`, {
        method: "POST",
      });
      if (res.ok) {
        const d = (await res.json()) as { session?: { id?: string } };
        await loadRules();
        if (d.session?.id) {
          onJumpToSession(d.session.id);
          onClose();
        }
      }
    } finally {
      setBusyId(null);
    }
  };

  const copyWebhookUrl = (rule: AutomationRuleDto) => {
    const endpoint =
      rule.trigger_type === "github_webhook"
        ? `${daemonUrl}/api/webhooks/github/${rule.id}`
        : `${daemonUrl}/api/webhooks/trigger/${rule.id}`;
    void navigator.clipboard.writeText(endpoint);
    setCopiedId(rule.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const applyChip = (prefix: string) => {
    setNaturalText((cur) => {
      const trimmed = cur.trim();
      if (!trimmed) return prefix;
      // If user already started with a chip prefix, swap the time prefix cleanly
      for (const c of QUICK_CHIPS) {
        if (trimmed.startsWith(c.prefix.trim())) {
          return prefix + trimmed.slice(c.prefix.trim().length).trimStart();
        }
      }
      return `${prefix}${trimmed}`;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-canvas)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#a78bfa]/15 text-[#a78bfa]">
              <CalendarClock className="h-4 w-4" />
            </div>
            <div>
              <div className="text-[13.5px] font-semibold text-[var(--v-fg-primary)]">
                定时任务
              </div>
              <div className="text-[11px] text-[var(--v-fg-muted)]">
                直接用白话定时间（本机时区），也可以在对话里输入 <code className="font-mono text-[var(--v-fg-body)]">/schedule</code> 创建
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {/* 1. Conversational Natural-Language Schedule Creator */}
          <form
            onSubmit={handleNaturalCreate}
            className="space-y-3 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] p-3.5"
          >
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--v-fg-body)]">
              <Sparkles className="h-3.5 w-3.5 text-[#a78bfa]" />
              <span>用一句话安排定时任务</span>
            </div>

            <textarea
              rows={2}
              value={naturalText}
              onChange={(e) => setNaturalText(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleNaturalCreate(e);
                }
              }}
              placeholder="例如：每天早上9点跑一遍单测并修掉报错 / 每周五下午6点汇总本周提交 / 30分钟后检查构建"
              className="w-full resize-none rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-3 py-2 text-[13px] leading-relaxed text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] outline-none focus:border-[var(--v-border-strong)]"
            />

            {/* Quick Time Chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              {QUICK_CHIPS.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  onClick={() => applyChip(chip.prefix)}
                  className="rounded-full border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2.5 py-0.5 text-[11px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                >
                  {chip.label}
                </button>
              ))}
            </div>

            {/* Live Parsed Preview Pill */}
            {naturalText.trim() && (
              <div
                className={`rounded-lg border px-3 py-2 text-[12px] ${
                  parsed?.ok
                    ? "border-[#34d399]/30 bg-[#34d399]/[0.07] text-[var(--v-fg-primary)]"
                    : "border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] text-[var(--v-fg-muted)]"
                }`}
              >
                {parsing && !parsed ? (
                  <span className="text-[11.5px] text-[var(--v-fg-muted)]">正在理解时间…</span>
                ) : parsed?.ok ? (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-md bg-[#34d399]/18 px-2 py-0.5 text-[11.5px] font-semibold text-[#10b981] dark:text-[#34d399]">
                        <Clock className="h-3 w-3" />
                        {parsed.schedule_text}
                      </span>
                      {parsed.next_run_label && (
                        <span className="text-[11px] text-[var(--v-fg-muted)]">
                          下次执行：{parsed.next_run_label}
                        </span>
                      )}
                    </div>
                    {parsed.task_prompt ? (
                      <div className="text-[11.5px] text-[var(--v-fg-secondary)]">
                        任务内容：<span className="text-[var(--v-fg-primary)]">{parsed.task_prompt}</span>
                      </div>
                    ) : (
                      <div className="text-[11px] text-amber-500">
                        时间已识别，继续写上要执行的具体任务即可创建
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[11.5px]">
                    {parsed?.hint || "加上具体时间（如「每天9点」「工作日18:30」「30分钟后」）即可自动识别"}
                  </div>
                )}
              </div>
            )}

            {/* Target Workspace + Engine + Submit */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2 py-1 text-[11.5px] text-[var(--v-fg-body)]">
                  <Folder className="h-3 w-3 text-[var(--v-fg-muted)]" />
                  {repos.length > 0 ? (
                    <select
                      value={repoPath}
                      onChange={(e) => setRepoPath(e.target.value)}
                      className="max-w-[160px] bg-transparent text-[11.5px] text-[var(--v-fg-primary)] outline-none"
                    >
                      {repos.map((r) => (
                        <option key={r.id} value={r.path}>
                          {r.name}
                        </option>
                      ))}
                      {!repos.some((r) => r.path === repoPath) && repoPath && (
                        <option value={repoPath}>{shortRepoName(repoPath)}</option>
                      )}
                    </select>
                  ) : (
                    <span className="max-w-[150px] truncate">{shortRepoName(repoPath)}</span>
                  )}
                </div>

                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2 py-1 text-[11.5px] text-[var(--v-fg-primary)] outline-none"
                >
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={creating || !parsed?.ok || !parsed.task_prompt.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--v-btn-bg)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--v-btn-fg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{creating ? "创建中…" : "确认启用"}</span>
              </button>
            </div>
          </form>

          {/* 2. Existing Scheduled Tasks */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5 text-[11px] font-medium text-[var(--v-fg-muted)]">
              <span>已安排的任务 ({rules.length})</span>
              {rules.some((r) => r.enabled) && (
                <span className="text-[#34d399]">
                  {rules.filter((r) => r.enabled).length} 个生效中
                </span>
              )}
            </div>

            {rules.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--v-border-subtle)] py-7 text-center text-[12px] text-[var(--v-fg-muted)]">
                还没有定时任务，在上面用白话写一句就能自动按时执行
              </div>
            ) : (
              rules.map((r) => (
                <div
                  key={r.id}
                  className={`flex items-center justify-between gap-3 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-3.5 py-2.5 text-[12px] transition-opacity ${
                    r.enabled ? "" : "opacity-60"
                  }`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.enabled}
                        onClick={() => handleToggle(r)}
                        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                          r.enabled ? "bg-[#34d399]" : "bg-[var(--v-bg-active)]"
                        }`}
                      >
                        <span
                          className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                            r.enabled ? "translate-x-3.5" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                      <span className="truncate font-medium text-[var(--v-fg-primary)]">
                        {r.name}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-md bg-[var(--v-bg-active)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--v-fg-secondary)]">
                        <Clock className="h-2.5 w-2.5 text-[var(--v-fg-muted)]" />
                        {formatRuleScheduleBadge(r)}
                      </span>
                      {r.run_count > 0 && (
                        <span className="font-mono text-[10px] text-[var(--v-fg-muted)]">
                          已运行 {r.run_count} 次
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11.5px] text-[var(--v-fg-muted)]">
                      {shortRepoName(r.repo_path)} · {r.prompt_template}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {(r.trigger_type === "github_webhook" ||
                      r.trigger_type === "generic_webhook") && (
                      <button
                        type="button"
                        onClick={() => copyWebhookUrl(r)}
                        className="inline-flex items-center gap-1 rounded-md border border-[var(--v-border-subtle)] px-2 py-1 text-[10.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                        title="复制 Webhook 回调地址"
                      >
                        {copiedId === r.id ? (
                          <Check className="h-3 w-3 text-[#34d399]" />
                        ) : (
                          <Webhook className="h-3 w-3" />
                        )}
                        <span>URL</span>
                      </button>
                    )}
                    {r.last_session_id && (
                      <button
                        type="button"
                        onClick={() => {
                          onJumpToSession(r.last_session_id!);
                          onClose();
                        }}
                        className="rounded-md border border-[var(--v-border-subtle)] px-2 py-1 text-[10.5px] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                      >
                        上次结果
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRunNow(r.id)}
                      disabled={busyId === r.id}
                      className="inline-flex items-center gap-1 rounded-md bg-[var(--v-bg-active)] px-2.5 py-1 text-[10.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] disabled:opacity-40 cursor-pointer"
                    >
                      <Play className="h-2.5 w-2.5" />
                      <span>{busyId === r.id ? "启动中" : "立即运行"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(r.id)}
                      className="rounded-md p-1.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[#f87171] cursor-pointer"
                      title="删除任务"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 3. Collapsed Advanced Section (Webhook / Manual Cron) */}
          <div className="border-t border-[var(--v-border-subtle)] pt-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex items-center gap-1.5 text-[11.5px] text-[var(--v-fg-muted)] transition-colors hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              {advancedOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <span>高级：Webhook 触发或手动 Cron 表达式</span>
            </button>

            {advancedOpen && (
              <form
                onSubmit={handleAdvancedCreate}
                className="mt-2.5 space-y-2.5 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] p-3 text-[12px]"
              >
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10.5px] text-[var(--v-fg-muted)]">触发方式</label>
                    <select
                      value={advType}
                      onChange={(e) =>
                        setAdvType(
                          e.target.value as "cron" | "github_webhook" | "generic_webhook"
                        )
                      }
                      className="mt-0.5 w-full rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2.5 py-1.5 text-[var(--v-fg-primary)] outline-none"
                    >
                      <option value="github_webhook">GitHub Webhook (HMAC)</option>
                      <option value="generic_webhook">通用 JSON Webhook</option>
                      <option value="cron">手动 5 段 Cron（本地时间）</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10.5px] text-[var(--v-fg-muted)]">任务名称</label>
                    <input
                      value={advName}
                      onChange={(e) => setAdvName(e.target.value)}
                      placeholder="如：GitHub Issue 自动排查"
                      className="mt-0.5 w-full rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2.5 py-1.5 text-[var(--v-fg-primary)] outline-none"
                    />
                  </div>
                </div>

                {advType === "cron" ? (
                  <div>
                    <label className="text-[10.5px] text-[var(--v-fg-muted)]">
                      5 段 Cron 表达式（本机时区：分 时 日 月 周）
                    </label>
                    <input
                      value={advCron}
                      onChange={(e) => setAdvCron(e.target.value)}
                      placeholder="0 9 * * 1-5"
                      className="mt-0.5 w-full rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2.5 py-1.5 font-mono text-[var(--v-fg-primary)] outline-none"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="text-[10.5px] text-[var(--v-fg-muted)]">
                      Webhook HMAC Secret（可选）
                    </label>
                    <input
                      value={advSecret}
                      onChange={(e) => setAdvSecret(e.target.value)}
                      placeholder="whsec_..."
                      className="mt-0.5 w-full rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2.5 py-1.5 font-mono text-[var(--v-fg-primary)] outline-none"
                    />
                  </div>
                )}

                <div>
                  <label className="text-[10.5px] text-[var(--v-fg-muted)]">
                    执行指令（Webhook 支持 `{"{{title}}"}` / `{"{{body}}"}` / `{"{{url}}"}`）
                  </label>
                  <textarea
                    rows={2}
                    value={advPrompt}
                    onChange={(e) => setAdvPrompt(e.target.value)}
                    placeholder="收到事件后要执行的任务描述…"
                    className="mt-0.5 w-full rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2.5 py-1.5 text-[var(--v-fg-primary)] outline-none"
                  />
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={creating || !advPrompt.trim()}
                    className="inline-flex items-center gap-1 rounded-lg bg-[var(--v-btn-bg)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90 disabled:opacity-40 cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>添加高级规则</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
