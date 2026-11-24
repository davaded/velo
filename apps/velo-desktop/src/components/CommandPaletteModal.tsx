import React, { useEffect, useMemo, useState } from "react";
import {
  FileDiff,
  GitBranch,
  Globe,
  Moon,
  Plus,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import { EngineBrandGlyph } from "./ui/EngineBrandIcon";
import { VeloKbd } from "./ui/VeloMotionPrimitives";

export interface CommandPaletteSessionItem {
  id: string;
  title: string;
  branch_name: string;
  agent_kind: string;
  status: string;
  archived?: boolean;
}

export interface CommandPaletteAction {
  id: string;
  label: string;
  subtitle?: string;
  shortcut?: string[];
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
}

interface CommandPaletteModalProps {
  sessions: CommandPaletteSessionItem[];
  activeSessionId: string;
  resolvedTheme: "light" | "dark";
  onSelectSession: (id: string) => void;
  onNewThread: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenDrawerTab: (tab: "diff" | "pr" | "browser" | "terminal") => void;
  onOpenModelPicker: () => void;
  onOpenQrPair: () => void;
  onClose: () => void;
}

type PaletteEntry =
  | {
      kind: "action";
      key: string;
      action: CommandPaletteAction;
    }
  | {
      kind: "session";
      key: string;
      session: CommandPaletteSessionItem;
    };

export const CommandPaletteModal: React.FC<CommandPaletteModalProps> = ({
  sessions,
  activeSessionId,
  resolvedTheme,
  onSelectSession,
  onNewThread,
  onToggleTheme,
  onOpenSettings,
  onOpenDrawerTab,
  onOpenModelPicker,
  onOpenQrPair,
  onClose,
}) => {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  const actions = useMemo<CommandPaletteAction[]>(
    () => [
      {
        id: "new-thread",
        label: "新建隔离 Worktree 会话",
        subtitle: "开启新任务分支或 Committee 竞速",
        icon: Plus,
        run: () => {
          onClose();
          onNewThread();
        },
      },
      {
        id: "switch-model",
        label: "切换引擎或模型",
        subtitle: "Claude · Codex · AGY · Cursor · Grok · ACP",
        icon: Sparkles,
        run: () => {
          onClose();
          onOpenModelPicker();
        },
      },
      {
        id: "open-diff",
        label: "打开代码变更 Diff 抽屉",
        subtitle: "审查修改、Commit 与 Merge",
        icon: FileDiff,
        run: () => {
          onClose();
          onOpenDrawerTab("diff");
        },
      },
      {
        id: "open-terminal",
        label: "打开集成终端",
        subtitle: "在当前 Worktree 路径执行命令",
        icon: Terminal,
        run: () => {
          onClose();
          onOpenDrawerTab("terminal");
        },
      },
      {
        id: "open-preview",
        label: "打开浏览器实时预览",
        subtitle: "查看本地 Dev Server",
        icon: Globe,
        run: () => {
          onClose();
          onOpenDrawerTab("browser");
        },
      },
      {
        id: "toggle-theme",
        label: resolvedTheme === "dark" ? "切换到浅色模式 (Light)" : "切换到深色模式 (Dark)",
        subtitle: "即时切换外观主题",
        icon: resolvedTheme === "dark" ? Sun : Moon,
        run: () => {
          onToggleTheme();
          onClose();
        },
      },
      {
        id: "open-settings",
        label: "打开设置中心",
        subtitle: "外观、材质、CLI 引擎、Hooks 与快捷键",
        shortcut: ["⌘", ","],
        icon: Settings,
        run: () => {
          onClose();
          onOpenSettings();
        },
      },
      {
        id: "open-qr",
        label: "手机端扫码配对 (Velo Mobile)",
        subtitle: "端到端加密远程控制本机 Agent",
        icon: Smartphone,
        run: () => {
          onClose();
          onOpenQrPair();
        },
      },
    ],
    [
      resolvedTheme,
      onClose,
      onNewThread,
      onOpenModelPicker,
      onOpenDrawerTab,
      onToggleTheme,
      onOpenSettings,
      onOpenQrPair,
    ]
  );

  const q = query.trim().toLowerCase();

  const { filteredActions, filteredSessions, entries } = useMemo(() => {
    const fa = actions.filter(
      (a) =>
        !q ||
        a.label.toLowerCase().includes(q) ||
        (a.subtitle || "").toLowerCase().includes(q) ||
        a.id.includes(q)
    );
    const fs = sessions
      .filter(
        (s) =>
          !q ||
          s.title.toLowerCase().includes(q) ||
          s.branch_name.toLowerCase().includes(q) ||
          s.agent_kind.toLowerCase().includes(q)
      )
      .slice(0, 14);

    const list: PaletteEntry[] = [
      ...fa.map((action) => ({ kind: "action" as const, key: `act-${action.id}`, action })),
      ...fs.map((session) => ({ kind: "session" as const, key: `ses-${session.id}`, session })),
    ];
    return { filteredActions: fa, filteredSessions: fs, entries: list };
  }, [actions, sessions, q]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [q]);

  const executeEntry = (entry?: PaletteEntry) => {
    if (!entry) return;
    if (entry.kind === "action") {
      entry.action.run();
    } else {
      onSelectSession(entry.session.id);
      onClose();
    }
  };

  const clampedIdx = entries.length > 0 ? Math.min(selectedIdx, entries.length - 1) : 0;

  return (
    <div
      onClick={onClose}
      className="v-modal-backdrop-in fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[13vh] backdrop-blur-xs"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="v-glass-modal v-modal-in w-full max-w-[560px] overflow-hidden rounded-2xl"
      >
        {/* Top Search Input */}
        <div className="flex items-center gap-2.5 border-b border-[var(--v-border-subtle)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--v-fg-muted)]" />
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
              if (entries.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIdx((i) => (i + 1) % entries.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIdx((i) => (i - 1 + entries.length) % entries.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                executeEntry(entries[clampedIdx]);
              }
            }}
            placeholder="搜索会话、切换模型、打开设置或执行快捷命令…"
            className="w-full bg-transparent text-[13.5px] text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:outline-none"
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

        {/* Results */}
        <div className="max-h-[360px] overflow-y-auto p-2">
          {entries.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-[var(--v-fg-muted)]">
              未找到匹配「{query}」的命令或会话
            </div>
          ) : (
            <>
              {filteredActions.length > 0 && (
                <div className="mb-2">
                  <div className="px-2.5 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--v-fg-faint)]">
                    快捷动作
                  </div>
                  <div className="space-y-0.5">
                    {filteredActions.map((act, idx) => {
                      const Icon = act.icon;
                      const active = idx === clampedIdx;
                      return (
                        <button
                          key={act.id}
                          type="button"
                          onMouseEnter={() => setSelectedIdx(idx)}
                          onClick={() => act.run()}
                          className={`v-press relative flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left cursor-pointer ${
                            active
                              ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                              : "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)]"
                          }`}
                        >
                          {active && (
                            <span
                              aria-hidden="true"
                              className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--accent-bright)]"
                            />
                          )}
                          <div className="flex min-w-0 items-center gap-2.5">
                            <Icon
                              className={`h-3.5 w-3.5 shrink-0 ${
                                active
                                  ? "text-[var(--accent-bright)]"
                                  : "text-[var(--v-fg-muted)]"
                              }`}
                            />
                            <div className="min-w-0">
                              <div className="truncate text-[12.5px] font-medium">
                                {act.label}
                              </div>
                              {act.subtitle && (
                                <div className="truncate text-[11px] text-[var(--v-fg-muted)]">
                                  {act.subtitle}
                                </div>
                              )}
                            </div>
                          </div>
                          {act.shortcut && (
                            <div className="flex shrink-0 items-center gap-1">
                              {act.shortcut.map((k) => (
                                <VeloKbd key={k}>{k}</VeloKbd>
                              ))}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {filteredSessions.length > 0 && (
                <div>
                  <div className="px-2.5 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--v-fg-faint)]">
                    会话线程 ({filteredSessions.length})
                  </div>
                  <div className="space-y-0.5">
                    {filteredSessions.map((s, sIdx) => {
                      const flatIdx = filteredActions.length + sIdx;
                      const active = flatIdx === clampedIdx;
                      const isCurrent = s.id === activeSessionId;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onMouseEnter={() => setSelectedIdx(flatIdx)}
                          onClick={() => {
                            onSelectSession(s.id);
                            onClose();
                          }}
                          className={`v-press relative flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left cursor-pointer ${
                            active
                              ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                              : "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)]"
                          }`}
                        >
                          {active && (
                            <span
                              aria-hidden="true"
                              className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--accent-bright)]"
                            />
                          )}
                          <div className="flex min-w-0 items-center gap-2.5">
                            <EngineBrandGlyph
                              engine={s.agent_kind}
                              size={13}
                              colored={active || isCurrent}
                              className="shrink-0"
                            />
                            <span className="truncate text-[12.5px] font-medium">
                              {s.title}
                            </span>
                            {isCurrent && (
                              <span className="shrink-0 rounded-full bg-[#34d399]/15 px-1.5 py-0.5 font-mono text-[9.5px] text-[#34d399]">
                                当前
                              </span>
                            )}
                          </div>
                          <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                            <GitBranch className="h-3 w-3 opacity-65" />
                            <span className="max-w-[140px] truncate">{s.branch_name}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Hints */}
        <div className="flex items-center justify-between border-t border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/55 px-4 py-2 text-[10.5px] text-[var(--v-fg-muted)]">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <VeloKbd>↑↓</VeloKbd> 导航
            </span>
            <span className="inline-flex items-center gap-1">
              <VeloKbd>↵</VeloKbd> 执行
            </span>
            <span className="inline-flex items-center gap-1">
              <VeloKbd>Esc</VeloKbd> 关闭
            </span>
          </div>
          <span className="font-mono text-[10px] text-[var(--v-fg-faint)]">
            Velo Command
          </span>
        </div>
      </div>
    </div>
  );
};
