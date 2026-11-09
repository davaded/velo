import React, { useEffect, useMemo, useState } from "react";
import {
  Columns2,
  FileDiff,
  Grid2x2,
  Maximize2,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import { SessionInfo, formatProvider } from "../types/velo";

export interface CommandAction {
  id: string;
  title: string;
  subtitle: string;
  shortcut?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

interface CommandPaletteProps {
  sessions: SessionInfo[];
  onClose: () => void;
  onSelectSession: (id: string) => void;
  onOpenLaunchModal: (mode: "single" | "committee" | "loop") => void;
  onSetLayout: (layout: 1 | 2 | 4) => void;
  onToggleDiffDrawer: () => void;
  onOpenPairing: () => void;
}

export function CommandPalette({
  sessions,
  onClose,
  onSelectSession,
  onOpenLaunchModal,
  onSetLayout,
  onToggleDiffDrawer,
  onOpenPairing,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const actions = useMemo<CommandAction[]>(() => {
    const base: CommandAction[] = [
      {
        id: "new-single",
        title: "Launch New Worktree Agent",
        subtitle: "Provision isolated Git branch & run Claude Code / Codex / OpenCode",
        shortcut: "⌘N",
        icon: <Plus className="w-4 h-4 text-indigo-400" />,
        onSelect: () => {
          onClose();
          onOpenLaunchModal("single");
        },
      },
      {
        id: "new-committee",
        title: "Dispatch Multi-Agent Committee (`/velo-committee`)",
        subtitle: "Fan out a problem to Claude + Codex + OpenCode in parallel worktrees",
        icon: <Users className="w-4 h-4 text-amber-400" />,
        onSelect: () => {
          onClose();
          onOpenLaunchModal("committee");
        },
      },
      {
        id: "new-loop",
        title: "Start Self-Healing Test Loop (`/velo-loop`)",
        subtitle: "Run agent continuously until acceptance test command (`cargo test`) passes",
        icon: <RefreshCw className="w-4 h-4 text-emerald-400" />,
        onSelect: () => {
          onClose();
          onOpenLaunchModal("loop");
        },
      },
      {
        id: "layout-1",
        title: "Workspace Layout: Single Focus (1x)",
        subtitle: "Maximize active agent workspace pane",
        shortcut: "⌘1",
        icon: <Maximize2 className="w-4 h-4 text-zinc-400" />,
        onSelect: () => {
          onSetLayout(1);
          onClose();
        },
      },
      {
        id: "layout-2",
        title: "Workspace Layout: Side-by-Side Split (2x)",
        subtitle: "Compare two parallel worktree agents side by side",
        shortcut: "⌘2",
        icon: <Columns2 className="w-4 h-4 text-zinc-400" />,
        onSelect: () => {
          onSetLayout(2);
          onClose();
        },
      },
      {
        id: "layout-4",
        title: "Workspace Layout: Mission Control Grid (4x)",
        subtitle: "Supervise 4 concurrent coding agents in a 2x2 grid",
        shortcut: "⌘4",
        icon: <Grid2x2 className="w-4 h-4 text-zinc-400" />,
        onSelect: () => {
          onSetLayout(4);
          onClose();
        },
      },
      {
        id: "toggle-diff",
        title: "Toggle Git Worktree Diff Inspector Drawer",
        subtitle: "View file tree and dual-column line number unified diffs",
        shortcut: "⌘D",
        icon: <FileDiff className="w-4 h-4 text-indigo-400" />,
        onSelect: () => {
          onToggleDiffDrawer();
          onClose();
        },
      },
      {
        id: "open-pair",
        title: "Mobile & Remote E2EE Pairing QR (`velo pair`)",
        subtitle: "Connect iOS/Android or remote web browser via encrypted relay",
        icon: <QrCode className="w-4 h-4 text-emerald-400" />,
        onSelect: () => {
          onClose();
          onOpenPairing();
        },
      },
    ];

    const sessionItems: CommandAction[] = sessions.map((s) => ({
      id: `session-${s.id}`,
      title: `Switch to Worktree: ${s.name}`,
      subtitle: `${formatProvider(s.provider)} · branch ${s.branch} (+${s.diff_stats.insertions} -${s.diff_stats.deletions})`,
      icon: <Sparkles className="w-4 h-4 text-sky-400" />,
      onSelect: () => {
        onSelectSession(s.id);
        onClose();
      },
    }));

    const all = [...base, ...sessionItems];
    if (!query.trim()) return all;
    const q = query.toLowerCase();
    return all.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.subtitle.toLowerCase().includes(q)
    );
  }, [
    query,
    sessions,
    onClose,
    onOpenLaunchModal,
    onSetLayout,
    onToggleDiffDrawer,
    onOpenPairing,
    onSelectSession,
  ]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % Math.max(actions.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(
          (i) => (i - 1 + Math.max(actions.length, 1)) % Math.max(actions.length, 1)
        );
      } else if (e.key === "Enter" && actions[selectedIndex]) {
        e.preventDefault();
        actions[selectedIndex].onSelect();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [actions, selectedIndex, onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-start justify-center pt-24 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
          <Search className="w-4 h-4 text-zinc-400" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or jump to a worktree session..."
            className="flex-1 bg-transparent text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
            ESC
          </span>
        </div>

        <div className="max-h-80 overflow-y-auto p-2 space-y-1">
          {actions.map((act, idx) => {
            const active = idx === selectedIndex;
            return (
              <button
                key={act.id}
                onClick={act.onSelect}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`w-full px-3 py-2.5 rounded-xl flex items-center justify-between gap-3 text-left transition cursor-pointer ${
                  active ? "bg-indigo-600/20 border border-indigo-500/30" : "border border-transparent"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center shrink-0">
                    {act.icon}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-100 truncate">
                      {act.title}
                    </div>
                    <div className="text-[11px] text-zinc-400 truncate">
                      {act.subtitle}
                    </div>
                  </div>
                </div>
                {act.shortcut && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0">
                    {act.shortcut}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
