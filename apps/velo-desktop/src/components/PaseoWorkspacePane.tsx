import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  ArrowUp,
  Bot,
  CheckCircle2,
  Columns2,
  Cpu,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCompare,
  LayoutGrid,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  Play,
  ShieldAlert,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { GitDiffStats, SessionInfo, UIEventItem } from "../types";
import { providerDisplayName } from "./PaseoLeftSidebar";
import { parseUnifiedDiffToFiles } from "./PaseoExplorerSidebar";
import {
  BeautifulApprovalCard,
  BeautifulContextMeter,
  BeautifulThinkingBlock,
  BeautifulToolCallCard,
} from "./ui/BeautifulAgentPrimitives";
import { VeloMissionControl } from "./VeloMissionControl";

export type WorkspaceTabKind = "agent" | "mission" | "diff" | "terminal";

interface PaseoWorkspacePaneProps {
  paneIndex: number;
  isSplit: boolean;
  isFocusedPane: boolean;
  onFocusPane: () => void;
  sessions: SessionInfo[];
  session: SessionInfo | null;
  onSelectSession: (id: string) => void;
  events: UIEventItem[];
  diffText: string;
  diffStats: GitDiffStats | null;
  activeTab: WorkspaceTabKind;
  onChangeTab: (tab: WorkspaceTabKind) => void;
  leftSidebarCollapsed: boolean;
  onExpandLeftSidebar: () => void;
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  onToggleSplit: () => void;
  onSendInput: (sessionId: string, text: string) => Promise<void>;
  onStopSession: (sessionId: string) => Promise<void>;
  onOpenNewWorkspaceModal: () => void;
  onOpenOrchestratorModal: (tab: "handoff" | "advisor" | "committee" | "loop") => void;
  onOpenPairModal: () => void;
}

const SLASH_COMMANDS = [
  {
    cmd: "/handoff",
    label: "Handoff Context to New Agent",
    desc: "Transfer conversation & git diff summary to Claude / Codex / OpenCode",
    modal: "handoff" as const,
  },
  {
    cmd: "/advisor",
    label: "Ask Second-Opinion Advisor",
    desc: "Spawn an advisor agent to critique or review current changes",
    modal: "advisor" as const,
  },
  {
    cmd: "/committee",
    label: "Run Multi-Agent Committee",
    desc: "Parallel fan-out across multiple providers in isolated worktrees",
    modal: "committee" as const,
  },
  {
    cmd: "/loop",
    label: "Start Autonomous Goal Loop",
    desc: "Iterative verification loop against an acceptance check command",
    modal: "loop" as const,
  },
];

export const PaseoWorkspacePane: React.FC<PaseoWorkspacePaneProps> = ({
  paneIndex,
  isSplit,
  isFocusedPane,
  onFocusPane,
  sessions,
  session,
  onSelectSession,
  events,
  diffText,
  diffStats,
  activeTab,
  onChangeTab,
  leftSidebarCollapsed,
  onExpandLeftSidebar,
  explorerOpen,
  onToggleExplorer,
  onToggleSplit,
  onSendInput,
  onStopSession,
  onOpenNewWorkspaceModal,
  onOpenOrchestratorModal,
  onOpenPairModal,
}) => {
  const [composerText, setComposerText] = useState("");
  const [execMode, setExecMode] = useState<"auto" | "plan" | "supervised">("auto");
  const [showDemoApproval, setShowDemoApproval] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([
    "crates/velo-protocol/src/lib.rs",
  ]);
  const [sending, setSending] = useState(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const parsedDiffFiles = useMemo(() => parseUnifiedDiffToFiles(diffText), [diffText]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, session?.id]);

  const showSlashPopover = composerText.startsWith("/") && composerText.length <= 14;
  const matchingSlashCommands = useMemo(() => {
    if (!showSlashPopover) return [];
    const q = composerText.toLowerCase();
    return SLASH_COMMANDS.filter((s) => s.cmd.startsWith(q));
  }, [showSlashPopover, composerText]);

  const handleComposerSubmit = async () => {
    if (!session || !composerText.trim() || sending) return;
    const trimmed = composerText.trim();

    const slashMatch = SLASH_COMMANDS.find(
      (s) => trimmed === s.cmd || trimmed.startsWith(`${s.cmd} `)
    );
    if (slashMatch) {
      setComposerText("");
      onOpenOrchestratorModal(slashMatch.modal);
      return;
    }

    setSending(true);
    try {
      await onSendInput(session.id, trimmed);
      setComposerText("");
    } finally {
      setSending(false);
    }
  };

  const renderStatusDot = (status?: SessionInfo["status"]) => {
    if (status === "running" || status === "starting") {
      return <span className="paseo-status-ring shrink-0" />;
    }
    const color =
      status === "completed"
        ? "var(--dot-success)"
        : status === "failed"
        ? "var(--dot-danger)"
        : "var(--dot-warning)";
    return (
      <span
        className="w-[7px] h-[7px] rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
    );
  };

  const repoDisplayName = useMemo(() => {
    const root = session?.repo_root || "/Users/daiyudai/code/velo";
    return root.split("/").filter(Boolean).pop() || "velo";
  }, [session?.repo_root]);

  const estimatedContextTokens = useMemo(() => {
    const base = 24000;
    const extra = events.length * 1850 + composerText.length * 4;
    return base + extra;
  }, [events.length, composerText.length]);

  return (
    <section
      onClick={onFocusPane}
      className="flex-1 min-w-0 h-full flex flex-col overflow-hidden velo-island velo-stage-aurora"
    >
      {/* 1. Top Segmented Mode Bar (beUI Morphing Dock + shadcn Tabs) */}
      <header
        className="h-[44px] px-3 flex items-center justify-between border-b gap-2 shrink-0"
        style={{
          backgroundColor: "rgba(16, 19, 18, 0.65)",
          borderColor: "var(--border-subtle)",
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto">
          {leftSidebarCollapsed && paneIndex === 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onExpandLeftSidebar();
              }}
              title="Expand Sidebar (⌘B)"
              className="w-7 h-7 rounded-[7px] flex items-center justify-center mr-1 hover:bg-[var(--surface-2)] cursor-pointer"
              style={{ color: "var(--fg-muted)" }}
            >
              <PanelLeftOpen className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Segmented Pill Track */}
          <div
            className="p-0.5 rounded-[9px] border flex items-center gap-0.5"
            style={{
              backgroundColor: "var(--surface-sidebar)",
              borderColor: "var(--border-subtle)",
            }}
          >
            {/* Tab 1: Agent Studio */}
            <button
              onClick={() => onChangeTab("agent")}
              className={`h-[28px] px-3 rounded-[7px] flex items-center gap-2 text-[12px] font-medium transition-all cursor-pointer shrink-0 max-w-[190px] ${
                activeTab === "agent" ? "rare-specular-pill" : ""
              }`}
              style={{
                backgroundColor: activeTab === "agent" ? "var(--surface-2)" : "transparent",
                color: activeTab === "agent" ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              {renderStatusDot(session?.status)}
              <span className="truncate">{session?.name ?? "Agent Studio"}</span>
            </button>

            {/* Tab 2: Mission Control (Multi-Agent Fleet Deck) */}
            <button
              onClick={() => onChangeTab("mission")}
              className={`h-[28px] px-3 rounded-[7px] flex items-center gap-1.5 text-[12px] font-medium transition-all cursor-pointer shrink-0 ${
                activeTab === "mission" ? "rare-specular-pill" : ""
              }`}
              style={{
                backgroundColor: activeTab === "mission" ? "var(--surface-2)" : "transparent",
                color: activeTab === "mission" ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <LayoutGrid className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />
              <span>Mission Control</span>
              <span
                className="font-mono-code text-[10px] px-1.5 rounded-full"
                style={{
                  backgroundColor: "var(--surface-3)",
                  color: "var(--fg)",
                }}
              >
                {sessions.length}
              </span>
            </button>

            {/* Tab 3: Diff Studio */}
            <button
              onClick={() => onChangeTab("diff")}
              className={`h-[28px] px-3 rounded-[7px] flex items-center gap-1.5 text-[12px] font-medium transition-all cursor-pointer shrink-0 ${
                activeTab === "diff" ? "rare-specular-pill" : ""
              }`}
              style={{
                backgroundColor: activeTab === "diff" ? "var(--surface-2)" : "transparent",
                color: activeTab === "diff" ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <GitCompare className="w-3.5 h-3.5" />
              <span>Diff Studio</span>
              {(diffStats?.files_changed ?? parsedDiffFiles.length) > 0 && (
                <span
                  className="font-mono-code text-[10px] px-1.5 rounded-full"
                  style={{
                    backgroundColor: "rgba(52, 211, 153, 0.16)",
                    color: "var(--status-success)",
                  }}
                >
                  {diffStats?.files_changed ?? parsedDiffFiles.length}
                </span>
              )}
            </button>

            {/* Tab 4: Terminal Matrix */}
            <button
              onClick={() => onChangeTab("terminal")}
              className={`h-[28px] px-3 rounded-[7px] flex items-center gap-1.5 text-[12px] font-medium transition-all cursor-pointer shrink-0 ${
                activeTab === "terminal" ? "rare-specular-pill" : ""
              }`}
              style={{
                backgroundColor: activeTab === "terminal" ? "var(--surface-2)" : "transparent",
                color: activeTab === "terminal" ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>Terminal</span>
            </button>
          </div>
        </div>

        {/* Right Action Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => onOpenOrchestratorModal("handoff")}
            title="Handoff session to another agent (/handoff)"
            className="h-[27px] px-2.5 rounded-[7px] border flex items-center gap-1.5 text-[11px] font-medium transition-colors cursor-pointer hover:bg-[var(--surface-2)] rare-specular-pill"
            style={{
              backgroundColor: "var(--surface-1)",
              borderColor: "var(--border-subtle)",
              color: "var(--fg-muted)",
            }}
          >
            <ArrowRightLeft className="w-3 h-3" />
            <span className="hidden sm:inline">Handoff</span>
          </button>

          <button
            onClick={() => onOpenOrchestratorModal("advisor")}
            title="Ask Second-Opinion Advisor (/advisor)"
            className="h-[27px] px-2.5 rounded-[7px] border flex items-center gap-1.5 text-[11px] font-medium transition-colors cursor-pointer hover:bg-[var(--surface-2)] rare-specular-pill"
            style={{
              backgroundColor: "var(--surface-1)",
              borderColor: "var(--border-subtle)",
              color: "var(--accent-bright)",
            }}
          >
            <Sparkles className="w-3 h-3" />
            <span className="hidden sm:inline">Advisor</span>
          </button>

          <div
            className="w-[1px] h-4 mx-0.5"
            style={{ backgroundColor: "var(--border-subtle)" }}
          />

          <button
            onClick={onToggleSplit}
            title={isSplit ? "Close Split Pane" : "Split Workspace Vertically (⌘\\)"}
            className="w-7 h-7 rounded-[7px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{
              backgroundColor: isSplit ? "var(--surface-2)" : "transparent",
              color: isSplit ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            {isSplit && paneIndex === 1 ? (
              <X className="w-3.5 h-3.5" />
            ) : (
              <Columns2 className="w-3.5 h-3.5" />
            )}
          </button>

          {(!isSplit || paneIndex === 1) && (
            <button
              onClick={onToggleExplorer}
              title="Toggle Right Inspector Dock (⌘E)"
              className="w-7 h-7 rounded-[7px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
              style={{
                backgroundColor: explorerOpen ? "var(--surface-2)" : "transparent",
                color: explorerOpen ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <PanelRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </header>

      {/* 2. Workspace Telemetry Ribbon */}
      {session && activeTab !== "mission" && (
        <div
          className="h-[32px] px-4 border-b flex items-center justify-between text-[11px] shrink-0"
          style={{
            backgroundColor: "rgba(19, 23, 22, 0.5)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg-extra-muted)",
          }}
        >
          <div className="flex items-center gap-2 min-w-0 truncate">
            <span
              className="flex items-center gap-1 font-medium"
              style={{ color: "var(--fg-muted)" }}
            >
              <FolderGit2 className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
              {repoDisplayName}
            </span>
            <span>/</span>
            <span
              className="font-mono-code flex items-center gap-1 px-1.5 py-0.5 rounded"
              style={{ backgroundColor: "var(--surface-1)", color: "var(--fg)" }}
            >
              <GitBranch className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
              {session.branch}
            </span>
            <span className="hidden md:inline">·</span>
            <span
              className="hidden md:inline font-mono-code truncate"
              title={session.worktree_path}
            >
              {session.worktree_path}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowDemoApproval((v) => !v)}
              className="font-mono-code text-[10.5px] px-2 py-0.5 rounded border flex items-center gap-1 cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
              style={{
                borderColor: "var(--border-subtle)",
                color: showDemoApproval ? "var(--status-warning)" : "var(--fg-muted)",
              }}
              title="Preview Beautiful UI Human-in-the-Loop Approval Gate"
            >
              <ShieldAlert className="w-3 h-3" />
              <span>Approval Gate</span>
            </button>

            {diffStats && (diffStats.insertions > 0 || diffStats.deletions > 0) && (
              <button
                onClick={() => onChangeTab("diff")}
                className="font-mono-code text-[11px] flex items-center gap-1 px-2 py-0.5 rounded border hover:bg-[var(--surface-1)] cursor-pointer"
                style={{ borderColor: "var(--border-subtle)" }}
              >
                <span style={{ color: "var(--status-success)" }}>
                  +{diffStats.insertions}
                </span>
                <span style={{ color: "var(--status-danger)" }}>
                  −{diffStats.deletions}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 3. Tab 1: Agent Studio (Beautiful UI Stream + Connected Stepper + Specular Composer) */}
      {activeTab === "agent" && (
        <div className="flex-1 flex flex-col min-h-0 relative t-blur-swap">
          <div className="flex-1 overflow-y-auto px-5 pt-5 pb-6 selectable-text">
            <div className="max-w-[780px] mx-auto space-y-4">
              {/* User Initial Task Card */}
              {session && (
                <div className="flex justify-end">
                  <div
                    className="max-w-[85%] rounded-[14px] px-4 py-3 text-[13px] leading-relaxed border rare-specular-surface"
                    style={{
                      backgroundColor: "var(--surface-2)",
                      borderColor: "var(--border-accent)",
                      color: "var(--fg)",
                    }}
                  >
                    <div
                      className="text-[10px] font-mono-code uppercase tracking-wider mb-1 flex items-center justify-between gap-3"
                      style={{ color: "var(--fg-extra-muted)" }}
                    >
                      <span>Task Specification</span>
                      <span style={{ color: "var(--accent-bright)" }}>{session.branch}</span>
                    </div>
                    {session.prompt}
                  </div>
                </div>
              )}

              {/* Agent Turn Header */}
              {session && (
                <div className="flex items-center justify-between pt-2">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-6 h-6 rounded-[7px] flex items-center justify-center border rare-specular-pill"
                      style={{
                        backgroundColor: "var(--surface-2)",
                        borderColor: "var(--border-accent)",
                        color: "var(--accent-bright)",
                      }}
                    >
                      <Bot className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[12.5px] font-semibold">
                      {providerDisplayName(session.provider)} Agent
                    </span>
                    <span
                      className="font-mono-code text-[10.5px] px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor: "var(--surface-1)",
                        color: "var(--fg-muted)",
                      }}
                    >
                      {events.length} steps
                    </span>
                  </div>
                </div>
              )}

              {/* Optional Human-in-the-Loop Approval Gate Card (Beautiful UI) */}
              {showDemoApproval && (
                <BeautifulApprovalCard
                  toolName="bash_exec"
                  commandPreview="cargo test --workspace --offline && git status -sb"
                  onApprove={() => setShowDemoApproval(false)}
                  onDeny={() => setShowDemoApproval(false)}
                />
              )}

              {/* Stream Events inside Connected Timeline */}
              <div className="paseo-indent-rail space-y-2.5">
                {events.map((ev, idx) => {
                  if (ev.kind === "tool_use") {
                    const nextEv = events[idx + 1];
                    const pairedOutput =
                      nextEv && nextEv.kind === "tool_result" ? nextEv.output : undefined;
                    const pairedError =
                      nextEv && nextEv.kind === "tool_result" ? nextEv.is_error : false;

                    return (
                      <BeautifulToolCallCard
                        key={idx}
                        toolName={ev.tool_name}
                        input={ev.input}
                        output={pairedOutput}
                        isError={pairedError}
                        onOpenDiffTab={() => onChangeTab("diff")}
                      />
                    );
                  }

                  if (ev.kind === "tool_result") {
                    const prevEv = idx > 0 ? events[idx - 1] : null;
                    if (prevEv && prevEv.kind === "tool_use") {
                      return null;
                    }
                    return (
                      <BeautifulToolCallCard
                        key={idx}
                        toolName={ev.tool_name}
                        input={{}}
                        output={ev.output}
                        isError={ev.is_error}
                        onOpenDiffTab={() => onChangeTab("diff")}
                      />
                    );
                  }

                  if (ev.kind === "thinking") {
                    return (
                      <BeautifulThinkingBlock
                        key={idx}
                        text={ev.text}
                        isStreaming={
                          session?.status === "running" && idx === events.length - 1
                        }
                      />
                    );
                  }

                  if (ev.kind === "user_input") {
                    return (
                      <div key={idx} className="flex justify-end pt-2 t-blur-swap">
                        <div
                          className="max-w-[85%] rounded-[12px] px-3.5 py-2 text-[13px] leading-relaxed border rare-specular-pill"
                          style={{
                            backgroundColor: "var(--surface-2)",
                            borderColor: "var(--border-accent)",
                            color: "var(--fg)",
                          }}
                        >
                          {ev.content}
                        </div>
                      </div>
                    );
                  }

                  if (ev.kind === "assistant_message") {
                    return (
                      <div key={idx} className="space-y-3 pt-1.5 t-blur-swap">
                        <div
                          className="text-[13.5px] leading-[1.7] whitespace-pre-wrap"
                          style={{ color: "var(--fg)" }}
                        >
                          {ev.text}
                        </div>

                        {/* Beautiful UI Artifact & Diff Verification Card */}
                        {parsedDiffFiles.length > 0 && idx === events.length - 1 && (
                          <div
                            className="rounded-[10px] border p-3 flex items-center justify-between gap-3 rare-specular-pill"
                            style={{
                              backgroundColor: "var(--surface-1)",
                              borderColor: "var(--border-accent)",
                            }}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <CheckCircle2
                                className="w-4 h-4 shrink-0"
                                style={{ color: "var(--status-success)" }}
                              />
                              <div className="min-w-0">
                                <div className="text-[12px] font-semibold truncate">
                                  Worktree Verification Passed ({parsedDiffFiles.length} files modified)
                                </div>
                                <div
                                  className="text-[11px] font-mono-code truncate"
                                  style={{ color: "var(--fg-muted)" }}
                                >
                                  {parsedDiffFiles.map((f) => f.fileName).join(", ")}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => onOpenOrchestratorModal("advisor")}
                                className="h-[26px] px-2.5 rounded-[6px] border text-[11px] font-medium cursor-pointer hover:bg-[var(--surface-2)]"
                                style={{
                                  borderColor: "var(--border-accent)",
                                  color: "var(--accent-bright)",
                                }}
                              >
                                Ask Advisor
                              </button>
                              <button
                                onClick={() => onChangeTab("diff")}
                                className="h-[26px] px-2.5 rounded-[6px] text-[11px] font-semibold cursor-pointer rare-3d-button"
                                style={{
                                  backgroundColor: "var(--accent)",
                                  color: "#ffffff",
                                }}
                              >
                                Review Diff →
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }

                  if (ev.kind === "pty_data") {
                    return (
                      <pre
                        key={idx}
                        className="font-mono-code text-[11.5px] px-3 py-2 rounded-[6px] border overflow-x-auto whitespace-pre-wrap"
                        style={{
                          backgroundColor: "var(--surface-sidebar)",
                          borderColor: "var(--border-subtle)",
                          color: "var(--fg-muted)",
                        }}
                      >
                        {ev.data}
                      </pre>
                    );
                  }

                  return null;
                })}
              </div>
              <div ref={streamEndRef} />
            </div>
          </div>

          {/* 4. Floating Multi-Layer Specular Composer (Beautiful UI + beUI + Rare UI) */}
          <div className="px-5 pb-4 pt-1 shrink-0">
            <div className="max-w-[780px] mx-auto relative">
              {matchingSlashCommands.length > 0 && (
                <div
                  className="absolute bottom-full left-0 mb-2 w-full max-w-[440px] rounded-[11px] border p-1.5 z-30 rare-specular-surface t-modal-scale"
                  style={{
                    backgroundColor: "var(--surface-2)",
                    borderColor: "var(--border-accent)",
                  }}
                >
                  <div
                    className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    Multi-Agent Slash Skills
                  </div>
                  {matchingSlashCommands.map((item) => (
                    <button
                      key={item.cmd}
                      onClick={() => {
                        setComposerText("");
                        onOpenOrchestratorModal(item.modal);
                      }}
                      className="w-full px-2.5 py-1.5 rounded-[6px] flex items-center justify-between text-left hover:bg-[var(--surface-1)] transition-colors cursor-pointer"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className="font-mono-code text-[12px] font-semibold"
                            style={{ color: "var(--accent-bright)" }}
                          >
                            {item.cmd}
                          </span>
                          <span
                            className="text-[12px] font-medium"
                            style={{ color: "var(--fg)" }}
                          >
                            {item.label}
                          </span>
                        </div>
                        <p
                          className="text-[11px]"
                          style={{ color: "var(--fg-extra-muted)" }}
                        >
                          {item.desc}
                        </p>
                      </div>
                      <kbd className="rare-keycap">↵</kbd>
                    </button>
                  ))}
                </div>
              )}

              <div
                className="rounded-[14px] border overflow-hidden transition-all rare-specular-surface"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: isFocusedPane
                    ? "var(--border-accent)"
                    : "var(--border-subtle)",
                }}
              >
                {/* Top Context Attachment Rail */}
                <div
                  className="px-3 py-1.5 border-b flex items-center gap-1.5 flex-wrap"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.14)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  {session && (
                    <span
                      className="h-[20px] px-2 rounded-[5px] font-mono-code text-[10.5px] flex items-center gap-1 border"
                      style={{
                        backgroundColor: "var(--surface-1)",
                        borderColor: "var(--border-subtle)",
                        color: "var(--accent-bright)",
                      }}
                    >
                      <GitBranch className="w-2.5 h-2.5" />
                      {session.branch}
                    </span>
                  )}

                  {attachedFiles.map((file) => (
                    <span
                      key={file}
                      className="h-[20px] px-2 rounded-[5px] font-mono-code text-[10.5px] flex items-center gap-1 border"
                      style={{
                        backgroundColor: "var(--surface-1)",
                        borderColor: "var(--border-subtle)",
                        color: "var(--fg-muted)",
                      }}
                    >
                      <FileCode2 className="w-2.5 h-2.5" />
                      <span>@{file.split("/").pop()}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachedFiles((prev) => prev.filter((f) => f !== file))
                        }
                        className="hover:text-white cursor-pointer"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}

                  <button
                    type="button"
                    onClick={() => {
                      const next =
                        attachedFiles.length % 2 === 0
                          ? "crates/velo-daemon/src/lib.rs"
                          : "crates/velo-worktree/src/lib.rs";
                      if (!attachedFiles.includes(next)) {
                        setAttachedFiles((prev) => [...prev, next]);
                      }
                    }}
                    className="h-[20px] px-2 rounded-[5px] text-[10.5px] flex items-center gap-1 hover:bg-[var(--surface-1)] cursor-pointer transition-colors"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    <Paperclip className="w-2.5 h-2.5" />
                    <span>+ Context</span>
                  </button>
                </div>

                {/* Main Prompt Textarea */}
                <textarea
                  rows={2}
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleComposerSubmit();
                    }
                  }}
                  placeholder={
                    session
                      ? `Instruct ${session.name}, or type / for multi-agent orchestration (/handoff, /advisor, /committee, /loop)...`
                      : "Select or spawn a worktree agent..."
                  }
                  className="w-full bg-transparent px-3.5 pt-2.5 pb-1.5 text-[13px] resize-none focus:outline-none"
                  style={{ color: "var(--fg)" }}
                />

                {/* Bottom Composer Control Deck */}
                <div className="px-3 pb-2.5 pt-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className="h-[24px] px-2.5 rounded-full text-[11px] font-medium flex items-center gap-1.5 border rare-specular-pill"
                      style={{
                        backgroundColor: "var(--surface-1)",
                        borderColor: "var(--border-subtle)",
                        color: "var(--fg)",
                      }}
                    >
                      <Bot
                        className="w-3 h-3"
                        style={{ color: "var(--accent-bright)" }}
                      />
                      {session ? providerDisplayName(session.provider) : "Claude"}
                    </span>

                    {/* Execution Mode Pill Switcher */}
                    <div
                      className="h-[24px] p-0.5 rounded-full border flex items-center text-[10.5px]"
                      style={{
                        backgroundColor: "var(--surface-1)",
                        borderColor: "var(--border-subtle)",
                      }}
                    >
                      {(["auto", "plan", "supervised"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setExecMode(m)}
                          className="px-2 h-full rounded-full capitalize cursor-pointer transition-colors"
                          style={{
                            backgroundColor:
                              execMode === m ? "var(--surface-3)" : "transparent",
                            color: execMode === m ? "var(--fg)" : "var(--fg-extra-muted)",
                          }}
                        >
                          {m}
                        </button>
                      ))}
                    </div>

                    <BeautifulContextMeter usedTokens={estimatedContextTokens} />

                    <button
                      type="button"
                      onClick={() => setComposerText("/")}
                      className="h-[24px] px-2 rounded-full text-[11px] font-mono-code flex items-center gap-1 border hover:bg-[var(--surface-1)] transition-colors cursor-pointer"
                      style={{
                        backgroundColor: "transparent",
                        borderColor: "var(--border-subtle)",
                        color: "var(--accent-bright)",
                      }}
                    >
                      /skills
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    {session?.status === "running" && !composerText.trim() ? (
                      <button
                        type="button"
                        onClick={() => onStopSession(session.id)}
                        title="Stop Agent"
                        className="w-[30px] h-[30px] rounded-full flex items-center justify-center cursor-pointer rare-3d-button"
                        style={{
                          backgroundColor: "var(--destructive)",
                          color: "#ffffff",
                        }}
                      >
                        <Square className="w-3 h-3 fill-current" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!composerText.trim() || sending}
                        onClick={handleComposerSubmit}
                        title="Send Message (Enter)"
                        className="w-[30px] h-[30px] rounded-full flex items-center justify-center cursor-pointer disabled:opacity-35 rare-3d-button"
                        style={{
                          backgroundColor: composerText.trim()
                            ? "var(--accent)"
                            : "var(--surface-3)",
                          color: "#ffffff",
                        }}
                      >
                        <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Velo Mission Control (Multi-Agent Topology & Fleet Board) */}
      {activeTab === "mission" && (
        <VeloMissionControl
          sessions={sessions}
          selectedSessionId={session?.id ?? null}
          onSelectSessionAndOpenStream={(id) => {
            onSelectSession(id);
            onChangeTab("agent");
          }}
          onSelectSessionAndOpenDiff={(id) => {
            onSelectSession(id);
            onChangeTab("diff");
          }}
          onOpenNewWorkspaceModal={onOpenNewWorkspaceModal}
          onOpenOrchestratorModal={onOpenOrchestratorModal}
          onOpenPairModal={onOpenPairModal}
        />
      )}

      {/* Tab 3: Diff Studio */}
      {activeTab === "diff" && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4 selectable-text t-blur-swap">
          <div className="max-w-[960px] mx-auto space-y-4">
            <div
              className="flex items-center justify-between px-4 py-3 rounded-[10px] border rare-specular-pill"
              style={{
                backgroundColor: "var(--surface-1)",
                borderColor: "var(--border-accent)",
              }}
            >
              <div className="flex items-center gap-2.5">
                <GitCompare
                  className="w-4 h-4"
                  style={{ color: "var(--accent-bright)" }}
                />
                <span className="text-[13px] font-semibold">
                  Isolated Worktree Diff Studio ({session?.branch})
                </span>
              </div>
              <div className="font-mono-code text-[12px] flex items-center gap-3">
                <span style={{ color: "var(--fg-muted)" }}>
                  {diffStats?.files_changed ?? parsedDiffFiles.length} files
                </span>
                <span style={{ color: "var(--status-success)" }}>
                  +{diffStats?.insertions ?? 0}
                </span>
                <span style={{ color: "var(--status-danger)" }}>
                  −{diffStats?.deletions ?? 0}
                </span>
                <button
                  onClick={() => onOpenOrchestratorModal("advisor")}
                  className="h-[25px] px-2.5 rounded-[6px] text-[11px] font-sans font-medium cursor-pointer rare-3d-button"
                  style={{ backgroundColor: "var(--accent)", color: "#ffffff" }}
                >
                  Ask Advisor on Diff
                </button>
              </div>
            </div>

            {parsedDiffFiles.map((file) => (
              <div
                key={file.path}
                className="rounded-[10px] border overflow-hidden rare-specular-surface"
                style={{
                  backgroundColor: "var(--surface-sidebar)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div
                  className="px-4 py-2.5 border-b flex items-center justify-between font-mono-code text-[12px]"
                  style={{
                    backgroundColor: "var(--surface-1)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <FileCode2
                      className="w-3.5 h-3.5"
                      style={{ color: "var(--accent-bright)" }}
                    />
                    <span style={{ color: "var(--fg)" }}>{file.path}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span style={{ color: "var(--status-success)" }}>
                      +{file.insertions}
                    </span>
                    <span style={{ color: "var(--status-danger)" }}>
                      −{file.deletions}
                    </span>
                  </div>
                </div>

                <div className="font-mono-code text-[11.5px] overflow-x-auto">
                  {file.lines.map((ln, i) => {
                    const bg =
                      ln.type === "add"
                        ? "rgba(52, 211, 153, 0.12)"
                        : ln.type === "del"
                        ? "rgba(248, 113, 113, 0.12)"
                        : ln.type === "hunk"
                        ? "rgba(56, 189, 248, 0.10)"
                        : "transparent";
                    const fg =
                      ln.type === "add"
                        ? "var(--status-success)"
                        : ln.type === "del"
                        ? "var(--status-danger)"
                        : ln.type === "hunk"
                        ? "var(--dot-running)"
                        : "var(--fg-muted)";

                    return (
                      <div
                        key={i}
                        className="px-3 py-0.5 flex items-center whitespace-pre"
                        style={{ backgroundColor: bg, color: fg }}
                      >
                        <span
                          className="w-8 text-right pr-2 select-none opacity-45 shrink-0"
                          style={{ color: "var(--fg-extra-muted)" }}
                        >
                          {ln.oldLine ?? ""}
                        </span>
                        <span
                          className="w-8 text-right pr-3 select-none opacity-45 shrink-0"
                          style={{ color: "var(--fg-extra-muted)" }}
                        >
                          {ln.newLine ?? ""}
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

      {/* Tab 4: Terminal Matrix (Interactive PTY + Verification Runner) */}
      {activeTab === "terminal" && (
        <div className="flex-1 flex flex-col min-h-0 p-5 gap-3 t-blur-swap">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--fg-muted)" }}>
              <Cpu className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
              <span>Quick Worktree Verification Commands:</span>
            </div>
            <div className="flex items-center gap-2">
              {[
                "cargo test --workspace --offline",
                "git status -sb",
                "git diff --stat",
              ].map((cmd) => (
                <button
                  key={cmd}
                  onClick={() => session && onSendInput(session.id, cmd)}
                  className="h-[26px] px-2.5 rounded-[6px] border font-mono-code text-[11px] flex items-center gap-1.5 cursor-pointer hover:bg-[var(--surface-2)] rare-specular-pill"
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
          </div>

          <div
            className="flex-1 rounded-[10px] border p-4 font-mono-code text-[12px] overflow-y-auto selectable-text space-y-1.5 rare-specular-surface"
            style={{
              backgroundColor: "var(--surface-sidebar)",
              borderColor: "var(--border-subtle)",
              color: "var(--fg-muted)",
            }}
          >
            <div style={{ color: "var(--accent-bright)" }}>
              # Velo Native PTY Bridge — {session?.worktree_path}
            </div>
            <div style={{ color: "var(--fg-extra-muted)" }}>
              $ git status -sb → ## {session?.branch}
            </div>
            {events.map((ev, idx) => {
              if (ev.kind === "pty_data") {
                return (
                  <pre key={idx} className="whitespace-pre-wrap" style={{ color: "var(--fg)" }}>
                    {ev.data}
                  </pre>
                );
              }
              if (ev.kind === "tool_use") {
                return (
                  <div key={idx} style={{ color: "var(--dot-running)" }}>
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
    </section>
  );
};
