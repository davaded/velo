import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  CheckCircle2,
  Columns2,
  GitBranch,
  Layers,
  Palette,
  PanelRight,
  Plus,
  QrCode,
  Repeat,
  Search,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import type { SessionInfo } from "../../types";
import { PASEO_THEMES, type PaseoThemeId } from "../../theme";

export interface VeloToastItem {
  id: string;
  title: string;
  description?: string;
  tone?: "success" | "info" | "warning";
}

/**
 * beUI (beui.dev) + shadcn/ui Sonner-Style Stacked Animated Toast Viewport
 */
export const VeloToastViewport: React.FC<{
  toasts: VeloToastItem[];
  onDismiss: (id: string) => void;
}> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[320px] pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto rounded-[10px] border px-3.5 py-2.5 flex items-start justify-between gap-2.5 rare-specular-surface t-toast-enter"
          style={{
            backgroundColor: "var(--surface-2)",
            borderColor: "var(--border-accent)",
          }}
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <CheckCircle2
              className="w-4 h-4 shrink-0 mt-0.5"
              style={{ color: "var(--accent-bright)" }}
            />
            <div className="min-w-0">
              <div
                className="text-[12px] font-semibold truncate"
                style={{ color: "var(--fg)" }}
              >
                {toast.title}
              </div>
              {toast.description && (
                <div
                  className="text-[11px] truncate mt-0.5"
                  style={{ color: "var(--fg-muted)" }}
                >
                  {toast.description}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="p-0.5 rounded hover:bg-[var(--surface-3)] cursor-pointer shrink-0"
            style={{ color: "var(--fg-extra-muted)" }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
};

interface CommandAction {
  id: string;
  group: "Workspaces" | "Multi-Agent Skills" | "Window & Tools" | "Themes";
  label: string;
  subtitle?: string;
  shortcut?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

/**
 * shadcn/ui (ui.shadcn.com) — Global ⌘K Command Palette Dialog
 */
export const ShadcnCommandPalette: React.FC<{
  open: boolean;
  onClose: () => void;
  sessions: SessionInfo[];
  onSelectSession: (id: string) => void;
  onOpenNewWorkspace: () => void;
  onOpenOrchestrator: (tab: "handoff" | "advisor" | "committee" | "loop") => void;
  onToggleSplit: () => void;
  onToggleExplorer: () => void;
  onOpenPair: () => void;
  onSelectTheme: (id: PaseoThemeId) => void;
}> = ({
  open,
  onClose,
  sessions,
  onSelectSession,
  onOpenNewWorkspace,
  onOpenOrchestrator,
  onToggleSplit,
  onToggleExplorer,
  onOpenPair,
  onSelectTheme,
}) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const actions = useMemo<CommandAction[]>(() => {
    const list: CommandAction[] = [];

    for (const s of sessions) {
      list.push({
        id: `sess-${s.id}`,
        group: "Workspaces",
        label: s.name,
        subtitle: `${s.branch} · +${s.diff_stats?.insertions ?? 0} −${
          s.diff_stats?.deletions ?? 0
        }`,
        icon: <GitBranch className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />,
        onSelect: () => {
          onSelectSession(s.id);
          onClose();
        },
      });
    }

    list.push(
      {
        id: "skill-handoff",
        group: "Multi-Agent Skills",
        label: "Handoff Context to Another Agent",
        subtitle: "Transfer worktree & conversation state (/handoff)",
        shortcut: "/handoff",
        icon: <ArrowRightLeft className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />,
        onSelect: () => {
          onClose();
          onOpenOrchestrator("handoff");
        },
      },
      {
        id: "skill-advisor",
        group: "Multi-Agent Skills",
        label: "Ask Second-Opinion Advisor",
        subtitle: "Spawn independent code review agent (/advisor)",
        shortcut: "/advisor",
        icon: <Sparkles className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />,
        onSelect: () => {
          onClose();
          onOpenOrchestrator("advisor");
        },
      },
      {
        id: "skill-committee",
        group: "Multi-Agent Skills",
        label: "Dispatch Multi-Agent Committee",
        subtitle: "Parallel Claude + Codex in isolated worktrees (/committee)",
        shortcut: "/committee",
        icon: <Layers className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />,
        onSelect: () => {
          onClose();
          onOpenOrchestrator("committee");
        },
      },
      {
        id: "skill-loop",
        group: "Multi-Agent Skills",
        label: "Start Autonomous Self-Healing Loop",
        subtitle: "Run agent + acceptance check iteratively (/loop)",
        shortcut: "/loop",
        icon: <Repeat className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />,
        onSelect: () => {
          onClose();
          onOpenOrchestrator("loop");
        },
      },
      {
        id: "act-new",
        group: "Window & Tools",
        label: "New Isolated Worktree Agent",
        subtitle: "Create a new Git worktree and spawn an agent",
        shortcut: "⌘N",
        icon: <Plus className="w-3.5 h-3.5" />,
        onSelect: () => {
          onClose();
          onOpenNewWorkspace();
        },
      },
      {
        id: "act-split",
        group: "Window & Tools",
        label: "Toggle Side-by-Side Split Workspace",
        subtitle: "Compare two agents or agent + diff side by side",
        shortcut: "⌘\\",
        icon: <Columns2 className="w-3.5 h-3.5" />,
        onSelect: () => {
          onToggleSplit();
          onClose();
        },
      },
      {
        id: "act-explorer",
        group: "Window & Tools",
        label: "Toggle Right Changes & Files Dock",
        shortcut: "⌘E",
        icon: <PanelRight className="w-3.5 h-3.5" />,
        onSelect: () => {
          onToggleExplorer();
          onClose();
        },
      },
      {
        id: "act-pair",
        group: "Window & Tools",
        label: "Pair Mobile Device via E2EE QR Relay",
        shortcut: "QR",
        icon: <QrCode className="w-3.5 h-3.5" />,
        onSelect: () => {
          onClose();
          onOpenPair();
        },
      }
    );

    for (const id of Object.keys(PASEO_THEMES) as PaseoThemeId[]) {
      const spec = PASEO_THEMES[id];
      list.push({
        id: `theme-${id}`,
        group: "Themes",
        label: `Theme: ${spec.label}`,
        subtitle: spec.badge,
        icon: <Palette className="w-3.5 h-3.5" />,
        onSelect: () => {
          onSelectTheme(id);
          onClose();
        },
      });
    }

    return list;
  }, [
    sessions,
    onSelectSession,
    onClose,
    onOpenOrchestrator,
    onOpenNewWorkspace,
    onToggleSplit,
    onToggleExplorer,
    onOpenPair,
    onSelectTheme,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.subtitle && a.subtitle.toLowerCase().includes(q)) ||
        a.group.toLowerCase().includes(q)
    );
  }, [actions, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(
          (prev) => (prev - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length)
        );
      } else if (e.key === "Enter" && filtered[selectedIndex]) {
        e.preventDefault();
        filtered[selectedIndex].onSelect();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, filtered, selectedIndex, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[13vh] bg-black/60 backdrop-blur-[3px] p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[540px] rounded-[12px] border overflow-hidden rare-specular-surface t-modal-scale"
        style={{
          backgroundColor: "var(--surface-1)",
          borderColor: "var(--border-accent)",
        }}
      >
        {/* Search Input Header */}
        <div
          className="h-[46px] px-3.5 border-b flex items-center gap-2.5"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <Search className="w-4 h-4 shrink-0" style={{ color: "var(--accent-bright)" }} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, workspace, or skill (/handoff, /committee, theme)..."
            className="w-full bg-transparent text-[13px] focus:outline-none"
            style={{ color: "var(--fg)" }}
          />
          <kbd className="rare-keycap">ESC</kbd>
        </div>

        {/* Grouped Command List */}
        <div className="max-h-[360px] overflow-y-auto p-1.5 space-y-1">
          {filtered.length === 0 ? (
            <div
              className="py-8 text-center text-[12px]"
              style={{ color: "var(--fg-extra-muted)" }}
            >
              No matching commands found.
            </div>
          ) : (
            filtered.map((item, idx) => {
              const active = idx === selectedIndex;
              const prevGroup = idx > 0 ? filtered[idx - 1].group : null;
              const showGroupHeader = item.group !== prevGroup;

              return (
                <React.Fragment key={item.id}>
                  {showGroupHeader && (
                    <div
                      className="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: "var(--fg-extra-muted)" }}
                    >
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={item.onSelect}
                    className="w-full px-2.5 py-2 rounded-[7px] flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                    style={{
                      backgroundColor: active ? "var(--surface-2)" : "transparent",
                      color: active ? "var(--fg)" : "var(--fg-muted)",
                    }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="w-6 h-6 rounded-[6px] flex items-center justify-center shrink-0"
                        style={{
                          backgroundColor: active ? "var(--surface-3)" : "var(--surface-0)",
                        }}
                      >
                        {item.icon}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium truncate">
                          {item.label}
                        </div>
                        {item.subtitle && (
                          <div
                            className="text-[11px] truncate"
                            style={{ color: "var(--fg-extra-muted)" }}
                          >
                            {item.subtitle}
                          </div>
                        )}
                      </div>
                    </div>

                    {item.shortcut && <kbd className="rare-keycap">{item.shortcut}</kbd>}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>

        {/* Footer Hints */}
        <div
          className="h-[32px] px-3.5 border-t flex items-center justify-between text-[11px]"
          style={{
            backgroundColor: "var(--surface-sidebar)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg-extra-muted)",
          }}
        >
          <div className="flex items-center gap-2">
            <Terminal className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
            <span>Velo Command Center</span>
          </div>
          <div className="flex items-center gap-2">
            <span>Navigate</span>
            <kbd className="rare-keycap">↑↓</kbd>
            <span>Select</span>
            <kbd className="rare-keycap">↵</kbd>
          </div>
        </div>
      </div>
    </div>
  );
};
