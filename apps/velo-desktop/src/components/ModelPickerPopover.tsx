import React, { useEffect, useMemo, useState } from "react";
import { Check, Copy, Search, Settings, Terminal, X } from "lucide-react";
import type { ModelOption } from "../mockData";
import { EngineBrandGlyph } from "./ui/EngineBrandIcon";
import { VeloKbd } from "./ui/VeloMotionPrimitives";

const ENGINE_SETUP_HINTS: Partial<Record<EngineTabKey, { cmd: string; note: string }>> = {
  claude: { cmd: "claude login", note: "安装 Claude Code CLI 并登录账号" },
  codex: { cmd: "codex login", note: "安装 OpenAI Codex CLI 并完成登录" },
  agy: { cmd: "agy auth login", note: "安装 Antigravity CLI (agy) 并登录" },
  cursor: { cmd: "cursor-agent login", note: "安装 Cursor Agent CLI 并登录" },
  grok: { cmd: "grok --version", note: "配置 Grok CLI 与 XAI_API_KEY" },
};

export interface RuntimeAvailability {
  id: string;
  name: string;
  available: boolean;
  version?: string | null;
}

export type EngineTabKey = "claude" | "codex" | "agy" | "cursor" | "grok" | "acp";

export interface EngineTabMeta {
  key: EngineTabKey;
  shortLabel: string;
  fullLabel: string;
  runtimeId: string;
  dotColor: string;
}

export const ENGINE_TABS: EngineTabMeta[] = [
  {
    key: "claude",
    shortLabel: "Claude",
    fullLabel: "Anthropic · Claude Code",
    runtimeId: "claude",
    dotColor: "#e08759",
  },
  {
    key: "codex",
    shortLabel: "Codex",
    fullLabel: "OpenAI · Codex",
    runtimeId: "codex",
    dotColor: "#34d399",
  },
  {
    key: "agy",
    shortLabel: "AGY",
    fullLabel: "Google · Antigravity (agy)",
    runtimeId: "agy",
    dotColor: "#60a5fa",
  },
  {
    key: "cursor",
    shortLabel: "Cursor",
    fullLabel: "Cursor · Agent CLI",
    runtimeId: "cursor-agent",
    dotColor: "#a78bfa",
  },
  {
    key: "grok",
    shortLabel: "Grok",
    fullLabel: "xAI · Grok CLI",
    runtimeId: "grok",
    dotColor: "#f472b6",
  },
  {
    key: "acp",
    shortLabel: "ACP",
    fullLabel: "ACP · Stdio Agents",
    runtimeId: "acp",
    dotColor: "#94a3b8",
  },
];

export function getEngineTabForAgentKind(agentKind: string): EngineTabKey {
  const k = (agentKind || "").toLowerCase();
  if (k === "claude") return "claude";
  if (k === "codex") return "codex";
  if (k === "agy" || k.includes("antigravity")) return "agy";
  if (k === "cursor" || k.includes("cursor")) return "cursor";
  if (k === "grok") return "grok";
  return "acp";
}

export function getEngineTabForModel(m: ModelOption): EngineTabKey {
  if (String(m.family).startsWith("ACP")) return "acp";
  return getEngineTabForAgentKind(m.agentKind);
}

export function isModelAvailable(
  m: ModelOption,
  runtimes: RuntimeAvailability[]
): boolean {
  if (String(m.family).startsWith("ACP")) return true;
  const rt = runtimes.find((r) => r.id === m.runtimeId);
  if (rt) return rt.available;
  return m.installed !== false;
}

export function pickFeaturedModelsForEngine(
  models: ModelOption[],
  engine: EngineTabKey,
  maxCount = 5
): ModelOption[] {
  const inEngine = models.filter((m) => getEngineTabForModel(m) === engine);
  if (inEngine.length <= maxCount) return inEngine;

  const picked: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (m?: ModelOption) => {
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      picked.push(m);
    }
  };

  // Always include default model(s) first
  for (const m of inEngine) {
    if (m.isDefault) add(m);
  }

  if (engine === "cursor") {
    const priorityPatterns = [
      /^cursor:auto$/i,
      /^cursor:composer/i,
      /claude.*opus/i,
      /claude.*sonnet/i,
      /gpt-5|gpt-6/i,
      /gemini/i,
    ];
    for (const pat of priorityPatterns) {
      if (picked.length >= maxCount) break;
      add(inEngine.find((m) => !seen.has(m.id) && pat.test(m.id)));
    }
  } else if (engine === "agy") {
    const priorityPatterns = [/neon/i, /carbon/i, /opus/i, /sonnet/i, /flash/i];
    for (const pat of priorityPatterns) {
      if (picked.length >= maxCount) break;
      add(inEngine.find((m) => !seen.has(m.id) && pat.test(m.id)));
    }
  }

  for (const m of inEngine) {
    if (picked.length >= maxCount) break;
    add(m);
  }
  return picked;
}

interface ModelPickerPopoverProps {
  modelCatalog: ModelOption[];
  runtimes: RuntimeAvailability[];
  activeAgentKind: string;
  activeModelId: string;
  isSessionBound: boolean;
  customAcpCmd: string;
  onChangeCustomAcpCmd: (v: string) => void;
  onBindCustomAcp: () => void;
  onSelectModel: (m: ModelOption, isCrossEngineHandoff: boolean) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

export const ModelPickerPopover: React.FC<ModelPickerPopoverProps> = ({
  modelCatalog,
  runtimes,
  activeAgentKind,
  activeModelId,
  isSessionBound,
  customAcpCmd,
  onChangeCustomAcpCmd,
  onBindCustomAcp,
  onSelectModel,
  onOpenSettings,
  onClose,
}) => {
  const currentTab = getEngineTabForAgentKind(activeAgentKind);
  const [selectedTab, setSelectedTab] = useState<EngineTabKey>(currentTab);
  const [query, setQuery] = useState<string>("");
  const [copiedCmd, setCopiedCmd] = useState<boolean>(false);
  const [highlightIdx, setHighlightIdx] = useState<number>(0);

  const countsByTab = useMemo(() => {
    const counts: Record<EngineTabKey, number> = {
      claude: 0,
      codex: 0,
      agy: 0,
      cursor: 0,
      grok: 0,
      acp: 0,
    };
    for (const m of modelCatalog) {
      counts[getEngineTabForModel(m)] += 1;
    }
    return counts;
  }, [modelCatalog]);

  const tabAvailable = (tab: EngineTabMeta): boolean => {
    if (tab.key === "acp") return true;
    const rt = runtimes.find((r) => r.id === tab.runtimeId);
    if (rt) return rt.available;
    return modelCatalog.some(
      (m) => getEngineTabForModel(m) === tab.key && m.installed !== false
    );
  };

  const trimmedQuery = query.trim().toLowerCase();

  const visibleModels = useMemo(() => {
    if (trimmedQuery) {
      return modelCatalog
        .filter((m) => {
          const hay = `${m.label} ${m.shortLabel} ${m.id} ${m.family} ${m.desc}`.toLowerCase();
          return hay.includes(trimmedQuery);
        })
        .slice(0, 80);
    }
    return modelCatalog.filter((m) => getEngineTabForModel(m) === selectedTab);
  }, [modelCatalog, selectedTab, trimmedQuery]);

  useEffect(() => {
    const curIdx = visibleModels.findIndex((m) => m.id === activeModelId);
    setHighlightIdx(curIdx >= 0 ? curIdx : 0);
  }, [selectedTab, trimmedQuery, visibleModels.length, activeModelId]);

  const activeTabMeta = ENGINE_TABS.find((t) => t.key === selectedTab) || ENGINE_TABS[0];
  const tabIsCrossEngine = isSessionBound && selectedTab !== currentTab;

  return (
    <>
      {/* Transparent click-away backdrop */}
      <div
        className="fixed inset-0 z-20"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        onClick={(e) => e.stopPropagation()}
        className="v-glass-popover v-popover-in absolute bottom-9 left-0 z-30 w-[436px] max-w-[calc(100vw-28px)] rounded-2xl p-2"
      >
        {/* 1. Search Input (searches across ALL 330+ models instantly with ↑↓ / Enter) */}
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/80 px-2.5 py-1.5 transition-colors focus-within:border-[var(--v-border-strong)]">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
              }
              if (visibleModels.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightIdx((i) => (i + 1) % visibleModels.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightIdx((i) => (i - 1 + visibleModels.length) % visibleModels.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const target = visibleModels[Math.min(highlightIdx, visibleModels.length - 1)];
                if (target && isModelAvailable(target, runtimes)) {
                  const isHandoff = isSessionBound && target.agentKind !== activeAgentKind;
                  onSelectModel(target, isHandoff);
                }
              }
            }}
            placeholder={`搜索全部 ${modelCatalog.length} 个模型（opus / gpt / gemini / kimi）…`}
            className="w-full bg-transparent text-[12px] text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="v-press text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <VeloKbd>Esc</VeloKbd>
          )}
        </div>

        {/* 2. Engine Category Tabs */}
        {!trimmedQuery && (
          <div className="mb-2 flex items-center gap-1 overflow-x-auto pb-0.5">
            {ENGINE_TABS.map((tab) => {
              const count = countsByTab[tab.key];
              if (count === 0) return null;
              const isSelected = selectedTab === tab.key;
              const avail = tabAvailable(tab);
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setSelectedTab(tab.key)}
                  className={`v-press flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-medium cursor-pointer ${
                    isSelected
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] ring-1 ring-[var(--v-border-strong)] shadow-2xs"
                      : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-body)]"
                  }`}
                >
                  <EngineBrandGlyph
                    engine={tab.key}
                    size={12}
                    colored={isSelected && avail}
                    className={`shrink-0 ${avail ? "" : "opacity-40"}`}
                  />
                  <span>{tab.shortLabel}</span>
                  <span className="font-mono text-[9.5px] opacity-60 tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 3. Contextual Mode Banner */}
        <div className="mb-1.5 flex items-center justify-between px-2 py-0.5 text-[10.5px]">
          <span className="font-semibold text-[var(--v-fg-body)]">
            {trimmedQuery
              ? `全引擎搜索结果 (${visibleModels.length})`
              : activeTabMeta.fullLabel}
          </span>
          <span
            className={`font-mono text-[10px] ${
              !isSessionBound
                ? "text-[#34d399]"
                : tabIsCrossEngine
                ? "text-[#a78bfa]"
                : "text-[#34d399]"
            }`}
          >
            {!isSessionBound
              ? "新会话 · 直接指定模型"
              : trimmedQuery
              ? "同引擎切换 / 跨引擎接力"
              : tabIsCrossEngine
              ? "↗ 跨引擎携上下文新建"
              : "当前引擎 · 直接切换"}
          </span>
        </div>

        {/* 3.5 Actionable CLI Login / Install Hint when selected engine is unavailable */}
        {!trimmedQuery && !tabAvailable(activeTabMeta) && ENGINE_SETUP_HINTS[activeTabMeta.key] && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-2.5 py-2 text-[11px]">
            <div className="min-w-0">
              <div className="font-medium text-amber-700 dark:text-amber-300">
                本机未检测到可用 {activeTabMeta.shortLabel} CLI
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[var(--v-fg-muted)]">
                <Terminal className="h-3 w-3 shrink-0" />
                <code className="truncate font-mono text-[var(--v-fg-body)]">
                  {ENGINE_SETUP_HINTS[activeTabMeta.key]!.cmd}
                </code>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  const cmd = ENGINE_SETUP_HINTS[activeTabMeta.key]!.cmd;
                  navigator.clipboard?.writeText(cmd).catch(() => {});
                  setCopiedCmd(true);
                  window.setTimeout(() => setCopiedCmd(false), 1600);
                }}
                className="flex items-center gap-1 rounded-md border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2 py-1 text-[10.5px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
              >
                {copiedCmd ? <Check className="h-3 w-3 text-[#34d399]" /> : <Copy className="h-3 w-3" />}
                <span>{copiedCmd ? "已复制" : "复制命令"}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
                className="rounded-md bg-[var(--v-bg-active)] px-2 py-1 text-[10.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
              >
                设置检测
              </button>
            </div>
          </div>
        )}

        {/* 4. Scrollable Model List */}
        <div className="max-h-[290px] space-y-0.5 overflow-y-auto pr-0.5">
          {visibleModels.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-[var(--v-fg-muted)]">
              未找到匹配「{query}」的模型
            </div>
          ) : (
            visibleModels.map((m, idx) => {
              const isCurrent = activeModelId === m.id;
              const isHighlighted = idx === highlightIdx;
              const isAcpFamily = String(m.family).startsWith("ACP");
              const canSelect = isModelAvailable(m, runtimes);
              const isCrossEngineHandoff =
                isSessionBound && m.agentKind !== activeAgentKind;
              const tabInfo = ENGINE_TABS.find(
                (t) => t.key === getEngineTabForModel(m)
              );

              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={!canSelect}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => onSelectModel(m, isCrossEngineHandoff)}
                  className={`v-press relative flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] ${
                    isCurrent
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                      : isHighlighted && canSelect
                      ? "bg-[var(--v-bg-hover)] text-[var(--v-fg-primary)] cursor-pointer"
                      : canSelect
                      ? "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                      : "cursor-not-allowed text-[var(--v-fg-muted)] opacity-45"
                  }`}
                >
                  {isHighlighted && canSelect && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-[var(--accent-bright)]"
                    />
                  )}
                  <div className="min-w-0 pr-2">
                    <div className="flex items-center gap-1.5 font-medium">
                      {trimmedQuery && tabInfo && (
                        <span
                          className="rounded px-1 py-0.2 font-mono text-[9.5px] font-semibold"
                          style={{
                            color: tabInfo.dotColor,
                            backgroundColor: `${tabInfo.dotColor}20`,
                          }}
                        >
                          {tabInfo.shortLabel}
                        </span>
                      )}
                      <span className="truncate">{m.label}</span>
                      {m.isDefault && (
                        <span className="shrink-0 rounded bg-[var(--v-bg-active)] px-1.5 py-0.2 font-mono text-[9.5px] text-[var(--v-fg-muted)]">
                          default
                        </span>
                      )}
                      {!canSelect && !isAcpFamily && (
                        <span className="shrink-0 rounded bg-[var(--v-bg-hover)] px-1.5 py-0.2 font-mono text-[9.5px] text-[var(--v-fg-faint)]">
                          未安装 CLI
                        </span>
                      )}
                    </div>
                    {m.desc && (
                      <div className="truncate text-[10.5px] text-[var(--v-fg-muted)]">
                        {m.desc}
                      </div>
                    )}
                  </div>
                  {isCurrent ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[#34d399]" />
                  ) : isCrossEngineHandoff && canSelect ? (
                    <span className="shrink-0 font-mono text-[10px] text-[#A78BFA]">
                      ↗ 接力
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        {/* 5. Custom ACP Command Quick-Bind */}
        {selectedTab === "acp" && !trimmedQuery && (
          <div className="mt-2 border-t border-[var(--v-border-subtle)] px-1 pt-2">
            <div className="mb-1 text-[10px] font-medium text-[var(--v-fg-muted)]">
              Custom ACP Stdio Agent (JSON-RPC 2.0)
            </div>
            <div className="flex items-center gap-1">
              <input
                value={customAcpCmd}
                onChange={(e) => onChangeCustomAcpCmd(e.target.value)}
                placeholder="e.g. opencode acp or goose acp"
                className="flex-1 rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2 py-1 font-mono text-[11px] text-[var(--v-fg-primary)] focus:outline-none"
              />
              <button
                type="button"
                onClick={onBindCustomAcp}
                className="v-press rounded-md bg-[var(--v-bg-active)] px-2.5 py-1 text-[11px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
              >
                Bind
              </button>
            </div>
          </div>
        )}

        {/* 6. Footer Settings Shortcut + Keyboard Hints */}
        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-[var(--v-border-subtle)] pt-1.5">
          <button
            type="button"
            onClick={onOpenSettings}
            className="v-press flex items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <Settings className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
            <span>管理引擎与 Hooks…</span>
          </button>
          <div className="flex items-center gap-1.5 pr-1 text-[10px] text-[var(--v-fg-faint)]">
            <span className="inline-flex items-center gap-0.5">
              <VeloKbd>↑↓</VeloKbd> 选择
            </span>
            <span className="inline-flex items-center gap-0.5">
              <VeloKbd>↵</VeloKbd> 切换
            </span>
          </div>
        </div>
      </div>
    </>
  );
};

interface InlineModelSelectorGridProps {
  modelCatalog: ModelOption[];
  runtimes: RuntimeAvailability[];
  selectedModelId: string;
  onSelectModelId: (modelId: string) => void;
}

export const InlineModelSelectorGrid: React.FC<InlineModelSelectorGridProps> = ({
  modelCatalog,
  runtimes,
  selectedModelId,
  onSelectModelId,
}) => {
  const currentOpt = modelCatalog.find((m) => m.id === selectedModelId);
  const [tab, setTab] = useState<EngineTabKey>(
    currentOpt ? getEngineTabForModel(currentOpt) : "claude"
  );
  const [q, setQ] = useState<string>("");

  const filtered = useMemo(() => {
    const clean = q.trim().toLowerCase();
    if (clean) {
      return modelCatalog
        .filter((m) =>
          `${m.label} ${m.id} ${m.family}`.toLowerCase().includes(clean)
        )
        .slice(0, 40);
    }
    return modelCatalog.filter((m) => getEngineTabForModel(m) === tab);
  }, [modelCatalog, tab, q]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {ENGINE_TABS.filter((t) =>
            modelCatalog.some((m) => getEngineTabForModel(m) === t.key)
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                setQ("");
              }}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                !q && tab === t.key
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] ring-1 ring-[var(--v-border-strong)]"
                  : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)]"
              }`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: t.dotColor }}
              />
              <span>{t.shortLabel}</span>
            </button>
          ))}
        </div>
        <div className="flex w-[124px] shrink-0 items-center gap-1 rounded-md border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] px-2 py-1">
          <Search className="h-3 w-3 text-[var(--v-fg-muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛选模型…"
            className="w-full bg-transparent text-[11px] text-[var(--v-fg-primary)] focus:outline-none"
          />
        </div>
      </div>

      <div className="grid max-h-[156px] grid-cols-2 gap-1.5 overflow-y-auto pr-1">
        {filtered.map((m) => {
          const avail = isModelAvailable(m, runtimes);
          const isSel = selectedModelId === m.id;
          return (
            <button
              key={m.id}
              type="button"
              disabled={!avail}
              onClick={() => onSelectModelId(m.id)}
              className={`flex items-center justify-between gap-1 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                isSel
                  ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                  : avail
                  ? "border-[var(--v-border-strong)] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                  : "cursor-not-allowed border-[var(--v-border-subtle)] text-[var(--v-fg-faint)] opacity-45"
              }`}
            >
              <span className="truncate">{m.label}</span>
              {isSel && <Check className="h-3 w-3 shrink-0 text-[#34d399]" />}
            </button>
          );
        })}
      </div>
    </div>
  );
};
