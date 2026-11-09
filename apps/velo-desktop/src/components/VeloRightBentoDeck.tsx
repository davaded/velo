import React, { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  FileCode2,
  GitBranch,
  GitCompare,
  Layers,
  Network,
  Play,
  RefreshCw,
  Repeat,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { GitDiffStats, SessionInfo, UIEventItem } from "../types";
import { parseUnifiedDiffToFiles } from "./PaseoExplorerSidebar";
import { providerDisplayName } from "./PaseoLeftSidebar";

interface VeloRightBentoDeckProps {
  session: SessionInfo | null;
  events: UIEventItem[];
  diffText: string;
  diffStats: GitDiffStats | null;
  onRefreshDiff: () => void;
  onSendInput: (sessionId: string, text: string) => Promise<void>;
  onOpenOrchestrator: (tab: "handoff" | "advisor" | "committee" | "loop") => void;
}

export const VeloRightBentoDeck: React.FC<VeloRightBentoDeckProps> = ({
  session,
  events,
  diffText,
  diffStats,
  onRefreshDiff,
  onSendInput,
  onOpenOrchestrator,
}) => {
  const [activePanel, setActivePanel] = useState<"diff" | "pty" | "dag">("diff");
  const [selectedFileFilter, setSelectedFileFilter] = useState<string>("all");

  const parsedFiles = useMemo(() => parseUnifiedDiffToFiles(diffText), [diffText]);
  const visibleFiles = useMemo(() => {
    if (selectedFileFilter === "all") return parsedFiles;
    return parsedFiles.filter((f) => f.path === selectedFileFilter);
  }, [parsedFiles, selectedFileFilter]);

  return (
    <aside className="w-[44%] min-w-[380px] max-w-[580px] h-full flex flex-col gap-3 shrink-0 select-none">
      {/* Top Bento Card: Worktree Sandbox & 1-Click Multi-Agent Skill Launcher */}
      <div className="velo-bento-card p-3.5 space-y-3 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-6 h-6 rounded-[7px] flex items-center justify-center shrink-0"
              style={{
                backgroundColor: "var(--surface-2)",
                color: "var(--accent-bright)",
              }}
            >
              <GitBranch className="w-3.5 h-3.5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono-code text-[12px] font-bold truncate">
                  {session?.branch ?? "main"}
                </span>
                <span
                  className="font-mono-code text-[9.5px] px-1.5 py-0.2 rounded-full"
                  style={{
                    backgroundColor: "rgba(16, 185, 129, 0.14)",
                    color: "var(--status-success)",
                  }}
                >
                  Isolated Worktree
                </span>
              </div>
              <div
                className="font-mono-code text-[10px] truncate"
                style={{ color: "var(--fg-extra-muted)" }}
                title={session?.worktree_path}
              >
                {session?.worktree_path ?? "~/.velo/worktrees"}
              </div>
            </div>
          </div>

          <button
            onClick={onRefreshDiff}
            title="Sync Worktree Diff"
            className="w-7 h-7 rounded-[8px] border flex items-center justify-center cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
            style={{
              backgroundColor: "var(--surface-1)",
              borderColor: "var(--border-subtle)",
              color: "var(--fg-muted)",
            }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 4 Tactile Multi-Agent Skill Buttons */}
        <div className="grid grid-cols-4 gap-1.5">
          {[
            {
              id: "handoff" as const,
              label: "Handoff",
              cmd: "/handoff",
              icon: ArrowRightLeft,
            },
            {
              id: "advisor" as const,
              label: "Advisor",
              cmd: "/advisor",
              icon: Sparkles,
            },
            {
              id: "committee" as const,
              label: "Committee",
              cmd: "/committee",
              icon: Layers,
            },
            {
              id: "loop" as const,
              label: "Goal Loop",
              cmd: "/loop",
              icon: Repeat,
            },
          ].map((sk) => {
            const Icon = sk.icon;
            return (
              <button
                key={sk.id}
                onClick={() => onOpenOrchestrator(sk.id)}
                className="p-2 rounded-[10px] border text-left transition-all cursor-pointer hover:bg-[var(--surface-2)] rare-specular-pill group"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <Icon
                    className="w-3.5 h-3.5 transition-transform group-hover:scale-110"
                    style={{ color: "var(--accent-bright)" }}
                  />
                  <span
                    className="font-mono-code text-[9px]"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    {sk.cmd}
                  </span>
                </div>
                <div className="text-[11px] font-semibold truncate">{sk.label}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Bottom Bento Card: Live Synchronized Code Diff, PTY Console & DAG */}
      <div className="velo-bento-card flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Card Header with Segmented Switcher */}
        <div
          className="h-[44px] px-3.5 border-b flex items-center justify-between gap-2 shrink-0"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <div
            className="p-0.5 rounded-[9px] border flex items-center gap-0.5"
            style={{
              backgroundColor: "var(--surface-1)",
              borderColor: "var(--border-subtle)",
            }}
          >
            <button
              onClick={() => setActivePanel("diff")}
              className="h-[26px] px-2.5 rounded-[7px] flex items-center gap-1.5 text-[11px] font-semibold transition-all cursor-pointer"
              style={{
                backgroundColor: activePanel === "diff" ? "var(--surface-2)" : "transparent",
                color: activePanel === "diff" ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <GitCompare className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
              <span>Live Diff</span>
              <span className="font-mono-code text-[10px] flex items-center gap-0.5">
                <span style={{ color: "var(--status-success)" }}>
                  +{diffStats?.insertions ?? 0}
                </span>
                <span style={{ color: "var(--status-danger)" }}>
                  −{diffStats?.deletions ?? 0}
                </span>
              </span>
            </button>

            <button
              onClick={() => setActivePanel("pty")}
              className="h-[26px] px-2.5 rounded-[7px] flex items-center gap-1.5 text-[11px] font-semibold transition-all cursor-pointer"
              style={{
                backgroundColor: activePanel === "pty" ? "var(--surface-2)" : "transparent",
                color: activePanel === "pty" ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <Terminal className="w-3 h-3" />
              <span>PTY Console</span>
            </button>

            <button
              onClick={() => setActivePanel("dag")}
              className="h-[26px] px-2.5 rounded-[7px] flex items-center gap-1.5 text-[11px] font-semibold transition-all cursor-pointer"
              style={{
                backgroundColor: activePanel === "dag" ? "var(--surface-2)" : "transparent",
                color: activePanel === "dag" ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <Network className="w-3 h-3" />
              <span>Agent DAG</span>
            </button>
          </div>

          <span
            className="font-mono-code text-[10.5px]"
            style={{ color: "var(--fg-extra-muted)" }}
          >
            {parsedFiles.length} files changed
          </span>
        </div>

        {/* Panel 1: Live Code Diff with File Filter Chips */}
        {activePanel === "diff" && (
          <div className="flex-1 min-h-0 flex flex-col t-blur-swap">
            {/* Horizontal File Filter Pills */}
            <div
              className="px-3 py-2 border-b flex items-center gap-1.5 overflow-x-auto shrink-0"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <button
                onClick={() => setSelectedFileFilter("all")}
                className="h-[22px] px-2 rounded-full font-mono-code text-[10.5px] cursor-pointer shrink-0 transition-colors"
                style={{
                  backgroundColor:
                    selectedFileFilter === "all" ? "var(--accent)" : "var(--surface-1)",
                  color: selectedFileFilter === "all" ? "#ffffff" : "var(--fg-muted)",
                }}
              >
                All ({parsedFiles.length})
              </button>
              {parsedFiles.map((f) => {
                const active = selectedFileFilter === f.path;
                return (
                  <button
                    key={f.path}
                    onClick={() => setSelectedFileFilter(f.path)}
                    className="h-[22px] px-2.5 rounded-full font-mono-code text-[10.5px] flex items-center gap-1 cursor-pointer shrink-0 transition-colors"
                    style={{
                      backgroundColor: active ? "var(--accent)" : "var(--surface-1)",
                      color: active ? "#ffffff" : "var(--fg-muted)",
                    }}
                  >
                    <span>{f.fileName}</span>
                    <span
                      style={{
                        color: active ? "#ffffff" : "var(--status-success)",
                      }}
                    >
                      +{f.insertions}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Unified Diff Scroll Viewport */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3 selectable-text">
              {visibleFiles.map((file) => (
                <div
                  key={file.path}
                  className="rounded-[10px] border overflow-hidden"
                  style={{
                    backgroundColor: "var(--surface-1)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div
                    className="px-3 py-1.5 border-b flex items-center justify-between font-mono-code text-[11px]"
                    style={{
                      backgroundColor: "var(--surface-2)",
                      borderColor: "var(--border-subtle)",
                    }}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <FileCode2
                        className="w-3.5 h-3.5 shrink-0"
                        style={{ color: "var(--accent-bright)" }}
                      />
                      <span className="truncate" style={{ color: "var(--fg)" }}>
                        {file.path}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span style={{ color: "var(--status-success)" }}>
                        +{file.insertions}
                      </span>
                      <span style={{ color: "var(--status-danger)" }}>
                        −{file.deletions}
                      </span>
                    </div>
                  </div>

                  <div className="font-mono-code text-[11px] overflow-x-auto py-1">
                    {file.lines.map((ln, idx) => {
                      const bg =
                        ln.type === "add"
                          ? "rgba(16, 185, 129, 0.14)"
                          : ln.type === "del"
                          ? "rgba(244, 63, 94, 0.14)"
                          : ln.type === "hunk"
                          ? "rgba(99, 102, 241, 0.12)"
                          : "transparent";
                      const fg =
                        ln.type === "add"
                          ? "var(--status-success)"
                          : ln.type === "del"
                          ? "var(--status-danger)"
                          : ln.type === "hunk"
                          ? "var(--accent-bright)"
                          : "var(--fg-muted)";
                      return (
                        <div
                          key={idx}
                          className="px-2.5 py-0.5 flex items-center whitespace-pre"
                          style={{ backgroundColor: bg, color: fg }}
                        >
                          <span
                            className="w-6 text-right pr-2 select-none opacity-45 shrink-0"
                            style={{ color: "var(--fg-extra-muted)" }}
                          >
                            {ln.newLine ?? ln.oldLine ?? ""}
                          </span>
                          <span>
                            {ln.type === "add"
                              ? "+"
                              : ln.type === "del"
                              ? "-"
                              : ln.type === "hunk"
                              ? ""
                              : " "}
                            {ln.content}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Panel 2: Live PTY Console */}
        {activePanel === "pty" && (
          <div className="flex-1 min-h-0 flex flex-col p-3 gap-2.5 t-blur-swap">
            <div className="flex items-center gap-1.5 flex-wrap">
              {["cargo test --offline", "git status -sb", "git diff --stat"].map((cmd) => (
                <button
                  key={cmd}
                  onClick={() => session && onSendInput(session.id, cmd)}
                  className="h-[24px] px-2.5 rounded-[6px] border font-mono-code text-[10.5px] flex items-center gap-1 cursor-pointer hover:bg-[var(--surface-2)]"
                  style={{
                    backgroundColor: "var(--surface-1)",
                    borderColor: "var(--border-subtle)",
                    color: "var(--accent-bright)",
                  }}
                >
                  <Play className="w-2.5 h-2.5 fill-current" />
                  <span>{cmd}</span>
                </button>
              ))}
            </div>

            <div
              className="flex-1 rounded-[10px] border p-3 font-mono-code text-[11.5px] overflow-y-auto space-y-1.5 selectable-text"
              style={{
                backgroundColor: "var(--canvas-bg)",
                borderColor: "var(--border-subtle)",
                color: "var(--fg-muted)",
              }}
            >
              <div style={{ color: "var(--accent-bright)" }}>
                # Velo PTY Stream — {session?.worktree_path}
              </div>
              {events.map((ev, idx) => {
                if (ev.kind === "tool_use") {
                  return (
                    <div key={idx} style={{ color: "var(--secondary)" }}>
                      ❯ [{ev.tool_name}] {JSON.stringify(ev.input)}
                    </div>
                  );
                }
                if (ev.kind === "tool_result") {
                  return (
                    <div key={idx} style={{ color: "var(--status-success)" }}>
                      ✔ {ev.output}
                    </div>
                  );
                }
                if (ev.kind === "user_input") {
                  return (
                    <div key={idx} style={{ color: "var(--fg)" }}>
                      $ {ev.content}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        )}

        {/* Panel 3: Multi-Agent Topology DAG */}
        {activePanel === "dag" && (
          <div className="flex-1 overflow-y-auto p-4 space-y-3 velo-dot-matrix t-blur-swap">
            <div className="paseo-indent-rail space-y-3">
              <div
                className="rounded-[10px] border p-3 space-y-1 rare-specular-pill"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--accent)",
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-bold">{session?.name}</span>
                  <span
                    className="font-mono-code text-[10px] px-2 py-0.5 rounded-full"
                    style={{
                      backgroundColor: "var(--surface-2)",
                      color: "var(--accent-bright)",
                    }}
                  >
                    {session ? providerDisplayName(session.provider) : "Claude"} · Primary
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                  Writing to isolated Git worktree `{session?.branch}`
                </p>
              </div>

              <div
                className="rounded-[10px] border p-3 space-y-1"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold">Advisor Critic Node</span>
                  <span
                    className="font-mono-code text-[10px]"
                    style={{ color: "var(--secondary)" }}
                  >
                    /advisor · Codex
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                  Audits unified git diff for concurrency & edge-case regressions
                </p>
              </div>

              <div
                className="rounded-[10px] border p-3 space-y-1"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold">Self-Heal Loop Gate</span>
                  <span
                    className="font-mono-code text-[10px] flex items-center gap-1"
                    style={{ color: "var(--status-success)" }}
                  >
                    <ShieldCheck className="w-3 h-3" />
                    cargo test
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                  Automatically re-prompts worker if test suite exits non-zero
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
