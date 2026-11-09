import React from "react";
import {
  Activity,
  ArrowRightLeft,
  Bot,
  CheckCircle2,
  Cpu,
  FolderGit2,
  GitBranch,
  GitCompare,
  Layers,
  Plus,
  QrCode,
  Repeat,
  ShieldCheck,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react";
import type { SessionInfo } from "../types";
import { providerDisplayName } from "./PaseoLeftSidebar";
import { RareSpotlightCard } from "./ui/RareSpotlightCard";

interface VeloMissionControlProps {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  onSelectSessionAndOpenStream: (id: string) => void;
  onSelectSessionAndOpenDiff: (id: string) => void;
  onOpenNewWorkspaceModal: () => void;
  onOpenOrchestratorModal: (tab: "handoff" | "advisor" | "committee" | "loop") => void;
  onOpenPairModal: () => void;
}

export const VeloMissionControl: React.FC<VeloMissionControlProps> = ({
  sessions,
  selectedSessionId,
  onSelectSessionAndOpenStream,
  onSelectSessionAndOpenDiff,
  onOpenNewWorkspaceModal,
  onOpenOrchestratorModal,
  onOpenPairModal,
}) => {
  const totalInsertions = sessions.reduce(
    (acc, s) => acc + (s.diff_stats?.insertions ?? 0),
    0
  );
  const totalDeletions = sessions.reduce(
    (acc, s) => acc + (s.diff_stats?.deletions ?? 0),
    0
  );
  const runningCount = sessions.filter(
    (s) => s.status === "running" || s.status === "starting"
  ).length;

  return (
    <div className="flex-1 overflow-y-auto p-5 velo-dot-matrix t-blur-swap selectable-text">
      <div className="max-w-[1040px] mx-auto space-y-6">
        {/* 1. Hero Command Banner */}
        <div
          className="rounded-[14px] border p-5 relative overflow-hidden rare-specular-surface"
          style={{
            backgroundColor: "var(--surface-1)",
            borderColor: "var(--border-accent)",
            backgroundImage:
              "radial-gradient(80% 180px at 15% 0%, var(--accent-glow), transparent 100%)",
          }}
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full text-[11px] font-mono-code border rare-specular-pill"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: "var(--border-accent)",
                  color: "var(--accent-bright)",
                }}
              >
                <Zap className="w-3 h-3" />
                <span>VELO MISSION CONTROL · RUST + TAURI NATIVE ENGINE</span>
              </div>
              <h1 className="text-[19px] font-bold tracking-tight" style={{ color: "var(--fg)" }}>
                Parallel Worktree & Multi-Agent Orchestration Deck
              </h1>
              <p className="text-[12.5px]" style={{ color: "var(--fg-muted)" }}>
                Every coding agent runs in an isolated Git worktree with zero branch collisions,
                live NDJSON/PTY streaming, and cross-agent skills.
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                onClick={() => onOpenOrchestratorModal("committee")}
                className="h-[34px] px-3.5 rounded-[8px] border text-[12px] font-medium flex items-center gap-2 cursor-pointer hover:bg-[var(--surface-2)] transition-colors rare-specular-pill"
                style={{
                  backgroundColor: "var(--surface-0)",
                  borderColor: "var(--border-accent)",
                  color: "var(--fg)",
                }}
              >
                <Layers className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />
                <span>Dispatch Committee</span>
              </button>

              <button
                onClick={onOpenNewWorkspaceModal}
                className="h-[34px] px-4 rounded-[8px] text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer rare-3d-button"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "#ffffff",
                }}
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>Spawn Worktree Agent</span>
              </button>
            </div>
          </div>

          {/* 4-Metric Telemetry Strip (beUI Bento Metrics) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
            <div
              className="rounded-[10px] border p-3 rare-specular-pill"
              style={{
                backgroundColor: "var(--surface-0)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--fg-muted)" }}>
                <span>Isolated Worktrees</span>
                <FolderGit2 className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-[20px] font-bold font-mono-code">{sessions.length}</span>
                <span className="text-[11px] font-mono-code" style={{ color: "var(--status-success)" }}>
                  {runningCount} active
                </span>
              </div>
            </div>

            <div
              className="rounded-[10px] border p-3 rare-specular-pill"
              style={{
                backgroundColor: "var(--surface-0)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--fg-muted)" }}>
                <span>Cumulative Diff Delta</span>
                <GitCompare className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />
              </div>
              <div className="mt-1 flex items-baseline gap-2 font-mono-code">
                <span className="text-[18px] font-bold" style={{ color: "var(--status-success)" }}>
                  +{totalInsertions}
                </span>
                <span className="text-[18px] font-bold" style={{ color: "var(--status-danger)" }}>
                  −{totalDeletions}
                </span>
              </div>
            </div>

            <div
              className="rounded-[10px] border p-3 rare-specular-pill"
              style={{
                backgroundColor: "var(--surface-0)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--fg-muted)" }}>
                <span>Built-in MCP Server</span>
                <Cpu className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-[14px] font-bold font-mono-code" style={{ color: "var(--fg)" }}>
                  JSON-RPC 2.0
                </span>
                <span className="text-[10.5px] font-mono-code" style={{ color: "var(--accent-bright)" }}>
                  POST /mcp
                </span>
              </div>
            </div>

            <div
              onClick={onOpenPairModal}
              className="rounded-[10px] border p-3 rare-specular-pill cursor-pointer hover:brightness-110 transition-all"
              style={{
                backgroundColor: "var(--surface-0)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--fg-muted)" }}>
                <span>Mobile E2EE Relay</span>
                <QrCode className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4" style={{ color: "var(--status-success)" }} />
                <span className="text-[12.5px] font-semibold">Pair via QR →</span>
              </div>
            </div>
          </div>
        </div>

        {/* 2. Active Worktree Fleet Grid */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
              <h2 className="text-[14px] font-semibold">Active Worktree Agent Fleet</h2>
            </div>
            <span className="text-[11.5px]" style={{ color: "var(--fg-extra-muted)" }}>
              Click any card to open its live stream or trigger cross-agent handoff
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {sessions.map((s) => {
              const isSelected = s.id === selectedSessionId;
              const isRunning = s.status === "running" || s.status === "starting";

              return (
                <div
                  key={s.id}
                  className="rounded-[12px] border p-4 flex flex-col justify-between gap-3.5 transition-all rare-specular-surface"
                  style={{
                    backgroundColor: isSelected ? "var(--surface-2)" : "var(--surface-1)",
                    borderColor: isSelected ? "var(--accent)" : "var(--border-accent)",
                  }}
                >
                  <div className="space-y-2.5">
                    {/* Top Row: Status + Name + Provider Badge */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {isRunning ? (
                          <span className="paseo-status-ring shrink-0" />
                        ) : (
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{
                              backgroundColor:
                                s.status === "completed"
                                  ? "var(--dot-success)"
                                  : "var(--dot-warning)",
                            }}
                          />
                        )}
                        <span className="text-[14px] font-semibold truncate">{s.name}</span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className="font-mono-code text-[10.5px] px-2 py-0.5 rounded-full border"
                          style={{
                            backgroundColor: "var(--surface-0)",
                            borderColor: "var(--border-subtle)",
                            color: "var(--accent-bright)",
                          }}
                        >
                          {providerDisplayName(s.provider)}
                        </span>
                        <span
                          className="font-mono-code text-[10px] px-2 py-0.5 rounded-full uppercase"
                          style={{
                            backgroundColor: isRunning
                              ? "rgba(56, 189, 248, 0.14)"
                              : "rgba(16, 185, 129, 0.14)",
                            color: isRunning ? "var(--dot-running)" : "var(--status-success)",
                          }}
                        >
                          {s.status}
                        </span>
                      </div>
                    </div>

                    {/* Branch & Worktree Path Pill */}
                    <div className="flex items-center gap-2 font-mono-code text-[11px]" style={{ color: "var(--fg-muted)" }}>
                      <span
                        className="px-2 py-0.5 rounded flex items-center gap-1"
                        style={{ backgroundColor: "var(--surface-0)", color: "var(--fg)" }}
                      >
                        <GitBranch className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
                        {s.branch}
                      </span>
                      <span className="truncate" style={{ color: "var(--fg-extra-muted)" }}>
                        {s.worktree_path}
                      </span>
                    </div>

                    {/* Prompt Preview */}
                    <p
                      className="text-[12px] line-clamp-2 leading-relaxed"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      {s.prompt}
                    </p>

                    {/* 4-Step Pipeline Progress Bar (Beautiful UI Pipeline) */}
                    <div className="pt-1 grid grid-cols-4 gap-1.5">
                      {["Worktree Sync", "Context Load", "Tool Edits", "Diff Verified"].map(
                        (step, idx) => {
                          const done = !isRunning || idx < 3;
                          return (
                            <div key={step} className="space-y-1">
                              <div
                                className="h-1 rounded-full"
                                style={{
                                  backgroundColor: done
                                    ? "var(--accent)"
                                    : "var(--surface-3)",
                                }}
                              />
                              <div
                                className="text-[9.5px] font-mono-code truncate"
                                style={{
                                  color: done ? "var(--fg-muted)" : "var(--fg-extra-muted)",
                                }}
                              >
                                {step}
                              </div>
                            </div>
                          );
                        }
                      )}
                    </div>
                  </div>

                  {/* Card Footer: Diff Stats + Quick Action Buttons */}
                  <div
                    className="pt-2.5 border-t flex items-center justify-between gap-2"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <div className="font-mono-code text-[11px] flex items-center gap-2">
                      <span style={{ color: "var(--fg-extra-muted)" }}>
                        {s.diff_stats?.files_changed ?? 0} files
                      </span>
                      <span style={{ color: "var(--status-success)" }}>
                        +{s.diff_stats?.insertions ?? 0}
                      </span>
                      <span style={{ color: "var(--status-danger)" }}>
                        −{s.diff_stats?.deletions ?? 0}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onSelectSessionAndOpenDiff(s.id)}
                        className="h-[26px] px-2.5 rounded-[6px] border text-[11px] font-medium cursor-pointer hover:bg-[var(--surface-0)] transition-colors"
                        style={{
                          borderColor: "var(--border-accent)",
                          color: "var(--fg-muted)",
                        }}
                      >
                        Diff
                      </button>
                      <button
                        onClick={() => onSelectSessionAndOpenStream(s.id)}
                        className="h-[26px] px-3 rounded-[6px] text-[11px] font-semibold cursor-pointer rare-3d-button"
                        style={{
                          backgroundColor: "var(--accent)",
                          color: "#ffffff",
                        }}
                      >
                        Open Agent →
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 3. Multi-Agent Orchestration Skills Matrix (Rare UI Spotlight Cards) */}
        <div className="space-y-3 pb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
            <h2 className="text-[14px] font-semibold">
              Multi-Agent Collaboration Skills (Native Rust Orchestrator)
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <RareSpotlightCard
              onClick={() => onOpenOrchestratorModal("handoff")}
              shortcut="/handoff"
              badge="Relay"
              title={
                <>
                  <ArrowRightLeft className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
                  <span>Agent Handoff</span>
                </>
              }
              subtitle="Pass isolated worktree, git diff, and history from Claude to Codex seamlessly."
            />

            <RareSpotlightCard
              onClick={() => onOpenOrchestratorModal("advisor")}
              shortcut="/advisor"
              badge="Critique"
              title={
                <>
                  <Sparkles className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
                  <span>Second-Opinion Advisor</span>
                </>
              }
              subtitle="Spawn a read-only senior reviewer agent to audit current worktree diffs."
            />

            <RareSpotlightCard
              onClick={() => onOpenOrchestratorModal("committee")}
              shortcut="/committee"
              badge="Fan-Out"
              title={
                <>
                  <Layers className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
                  <span>Agent Committee</span>
                </>
              }
              subtitle="Dispatch the same prompt across multiple providers in parallel worktrees."
            />

            <RareSpotlightCard
              onClick={() => onOpenOrchestratorModal("loop")}
              shortcut="/loop"
              badge="Self-Heal"
              title={
                <>
                  <Repeat className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
                  <span>Autonomous Loop</span>
                </>
              }
              subtitle="Run agent + cargo test iteratively until the verification check passes."
            />
          </div>
        </div>
      </div>
    </div>
  );
};
