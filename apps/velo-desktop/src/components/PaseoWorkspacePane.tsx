import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Columns2,
  Cpu,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCompare,
  Layers,
  PanelLeftOpen,
  PanelRight,
  Plus,
  Repeat,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { AgentEvent, GitDiffStats, SessionInfo } from "../types";
import { providerDisplayName } from "./PaseoLeftSidebar";
import { parseUnifiedDiffToFiles } from "./PaseoExplorerSidebar";

export type WorkspaceTabKind = "agent" | "diff" | "terminal" | "new_tab";

interface PaseoWorkspacePaneProps {
  paneIndex: number;
  isSplit: boolean;
  isFocusedPane: boolean;
  onFocusPane: () => void;
  session: SessionInfo | null;
  events: AgentEvent[];
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
    desc: "Parallel fan-out across multiple providers + synthesizer judge",
    modal: "committee" as const,
  },
  {
    cmd: "/loop",
    label: "Start Autonomous Goal Loop",
    desc: "Worker + evaluator iterative verification loop until goal passes",
    modal: "loop" as const,
  },
];

export const PaseoWorkspacePane: React.FC<PaseoWorkspacePaneProps> = ({
  paneIndex,
  isSplit,
  isFocusedPane,
  onFocusPane,
  session,
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
}) => {
  const [composerText, setComposerText] = useState("");
  const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>({});
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

    // Check if user typed a slash orchestration command
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

  const toggleItemExpanded = (idx: number) => {
    setExpandedItems((prev) => ({ ...prev, [idx]: !prev[idx] }));
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
        className="w-[6px] h-[6px] rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
    );
  };

  return (
    <section
      onClick={onFocusPane}
      className="flex-1 min-w-0 h-full flex flex-col overflow-hidden"
      style={{
        backgroundColor: "var(--surface-0)",
        borderLeft: paneIndex > 0 ? "1px solid var(--border-subtle)" : undefined,
      }}
    >
      {/* 1. Paseo WorkspaceDesktopTabsRow (38px height) */}
      <header
        className="h-[38px] px-2 flex items-center justify-between border-b gap-2 shrink-0"
        style={{
          backgroundColor: "var(--surface-sidebar)",
          borderColor: "var(--border-subtle)",
        }}
      >
        {/* Left: Expand Sidebar (if collapsed) + Browser-Style Tabs */}
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
          {leftSidebarCollapsed && paneIndex === 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onExpandLeftSidebar();
              }}
              title="Expand Sidebar (⌘B)"
              className="w-6 h-6 rounded-[5px] flex items-center justify-center mr-1 hover:bg-[var(--surface-2)] cursor-pointer"
              style={{ color: "var(--fg-muted)" }}
            >
              <PanelLeftOpen className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Tab 1: Active Agent Tab */}
          <button
            onClick={() => onChangeTab("agent")}
            className="h-[27px] px-2.5 rounded-[6px] flex items-center gap-2 text-[12px] font-medium transition-colors cursor-pointer shrink-0 max-w-[190px]"
            style={{
              backgroundColor: activeTab === "agent" ? "var(--surface-2)" : "transparent",
              color: activeTab === "agent" ? "var(--fg)" : "var(--fg-muted)",
              border:
                activeTab === "agent"
                  ? "1px solid var(--border-accent)"
                  : "1px solid transparent",
            }}
          >
            {renderStatusDot(session?.status)}
            <span className="truncate">{session?.name ?? "Agent"}</span>
          </button>

          {/* Tab 2: Working Diff Tab */}
          <button
            onClick={() => onChangeTab("diff")}
            className="h-[27px] px-2.5 rounded-[6px] flex items-center gap-1.5 text-[12px] font-medium transition-colors cursor-pointer shrink-0"
            style={{
              backgroundColor: activeTab === "diff" ? "var(--surface-2)" : "transparent",
              color: activeTab === "diff" ? "var(--fg)" : "var(--fg-muted)",
              border:
                activeTab === "diff"
                  ? "1px solid var(--border-accent)"
                  : "1px solid transparent",
            }}
          >
            <GitCompare className="w-3.5 h-3.5" />
            <span>Working Diff</span>
            {(diffStats?.files_changed ?? parsedDiffFiles.length) > 0 && (
              <span
                className="font-mono-code text-[10px] px-1.5 rounded-full"
                style={{
                  backgroundColor: "var(--surface-3)",
                  color: "var(--fg)",
                }}
              >
                {diffStats?.files_changed ?? parsedDiffFiles.length}
              </span>
            )}
          </button>

          {/* Tab 3: Terminal (PTY) Tab */}
          <button
            onClick={() => onChangeTab("terminal")}
            className="h-[27px] px-2.5 rounded-[6px] flex items-center gap-1.5 text-[12px] font-medium transition-colors cursor-pointer shrink-0"
            style={{
              backgroundColor: activeTab === "terminal" ? "var(--surface-2)" : "transparent",
              color: activeTab === "terminal" ? "var(--fg)" : "var(--fg-muted)",
              border:
                activeTab === "terminal"
                  ? "1px solid var(--border-accent)"
                  : "1px solid transparent",
            }}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Terminal</span>
          </button>

          {/* Tab 4: "+" NewTabPanel Launcher */}
          <button
            onClick={() => onChangeTab("new_tab")}
            title="New Tab Launcher (⌘T)"
            className="w-[27px] h-[27px] rounded-[6px] flex items-center justify-center transition-colors cursor-pointer shrink-0 hover:bg-[var(--surface-2)]"
            style={{
              backgroundColor: activeTab === "new_tab" ? "var(--surface-2)" : "transparent",
              color: activeTab === "new_tab" ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Right: Quick Handoff/Advisor + Split Pane + Explorer Dock Toggle */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onOpenOrchestratorModal("handoff")}
            title="Handoff session to another agent (/handoff)"
            className="h-[25px] px-2 rounded-[5px] flex items-center gap-1 text-[11px] transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--fg-muted)" }}
          >
            <ArrowRightLeft className="w-3 h-3" />
            <span className="hidden sm:inline">Handoff</span>
          </button>

          <button
            onClick={() => onOpenOrchestratorModal("advisor")}
            title="Ask Second-Opinion Advisor (/advisor)"
            className="h-[25px] px-2 rounded-[5px] flex items-center gap-1 text-[11px] transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--accent-bright)" }}
          >
            <Sparkles className="w-3 h-3" />
            <span className="hidden sm:inline">Advisor</span>
          </button>

          <div
            className="w-[1px] h-3.5 mx-0.5"
            style={{ backgroundColor: "var(--border-subtle)" }}
          />

          <button
            onClick={onToggleSplit}
            title={isSplit ? "Close Split Pane" : "Split Workspace Vertically (⌘\\)"}
            className="w-6 h-6 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
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
              title="Toggle Right Explorer Dock (⌘E)"
              className="w-6 h-6 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
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

      {/* 2. Paseo PaneSubtitle (Compact 1-line workspace facts bar) */}
      {session && (
        <div
          className="h-[29px] px-3.5 border-b flex items-center justify-between text-[11px] shrink-0"
          style={{
            backgroundColor: "var(--surface-0)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg-extra-muted)",
          }}
        >
          <div className="flex items-center gap-2 min-w-0 truncate">
            <span className="flex items-center gap-1 font-medium" style={{ color: "var(--fg-muted)" }}>
              <FolderGit2 className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
              {session.project_path.split("/").filter(Boolean).pop() || "repo"}
            </span>
            <span>/</span>
            <span
              className="font-mono-code flex items-center gap-1"
              style={{ color: "var(--fg)" }}
            >
              <GitBranch className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
              {session.worktree_branch}
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
            {diffStats && (diffStats.insertions > 0 || diffStats.deletions > 0) && (
              <button
                onClick={() => onChangeTab("diff")}
                className="font-mono-code text-[11px] flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--surface-1)] cursor-pointer"
              >
                <span style={{ color: "var(--status-success)" }}>
                  +{diffStats.insertions}
                </span>
                <span style={{ color: "var(--status-danger)" }}>
                  −{diffStats.deletions}
                </span>
              </button>
            )}
            <span
              className="font-mono-code text-[10.5px] px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: "var(--surface-1)",
                color: "var(--fg-muted)",
              }}
            >
              {providerDisplayName(session.provider)}
            </span>
          </div>
        </div>
      )}

      {/* 3. Main Tab Body */}
      {activeTab === "agent" && (
        <div className="flex-1 flex flex-col min-h-0 relative">
          {/* Scrollable Agent Stream Timeline */}
          <div className="flex-1 overflow-y-auto px-4 pt-5 pb-6 selectable-text">
            <div className="max-w-[760px] mx-auto space-y-3.5">
              {/* Initial Task Prompt Bubble (Right-aligned Paseo UserMessage) */}
              {session && (
                <div className="flex justify-end">
                  <div
                    className="max-w-[85%] rounded-[12px] px-3.5 py-2.5 text-[13px] leading-relaxed border"
                    style={{
                      backgroundColor: "var(--surface-2)",
                      borderColor: "var(--border-accent)",
                      color: "var(--fg)",
                    }}
                  >
                    {session.prompt}
                  </div>
                </div>
              )}

              {/* Stream Events: Paseo ExpandableBadges + IndentRail + AssistantMessage */}
              {events.map((ev, idx) => {
                const isExpanded = !!expandedItems[idx];

                if (ev.kind === "user_input") {
                  return (
                    <div key={idx} className="flex justify-end pt-1">
                      <div
                        className="max-w-[85%] rounded-[12px] px-3.5 py-2 text-[13px] leading-relaxed border"
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

                if (ev.kind === "thinking") {
                  return (
                    <div key={idx} className="space-y-1">
                      <button
                        onClick={() => toggleItemExpanded(idx)}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[12px] transition-colors cursor-pointer hover:bg-[var(--surface-1)]"
                        style={{ color: "var(--fg-muted)" }}
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                        <Sparkles
                          className="w-3.5 h-3.5"
                          style={{ color: "var(--accent-bright)" }}
                        />
                        <span className="font-medium">Thought process</span>
                        <span
                          className="truncate max-w-[420px]"
                          style={{ color: "var(--fg-extra-muted)" }}
                        >
                          — {ev.text}
                        </span>
                      </button>

                      {isExpanded && (
                        <div
                          className="paseo-indent-rail ml-2 text-[12.5px] leading-relaxed py-1"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          {ev.text}
                        </div>
                      )}
                    </div>
                  );
                }

                if (ev.kind === "tool_use") {
                  const fileArg =
                    typeof ev.input === "object" && ev.input !== null
                      ? (ev.input as Record<string, unknown>).file ||
                        (ev.input as Record<string, unknown>).path ||
                        (ev.input as Record<string, unknown>).command
                      : null;

                  return (
                    <div key={idx} className="space-y-1">
                      <button
                        onClick={() => toggleItemExpanded(idx)}
                        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-[6px] text-[12px] border transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
                        style={{
                          backgroundColor: "var(--surface-1)",
                          borderColor: "var(--border-subtle)",
                          color: "var(--fg)",
                        }}
                      >
                        {isExpanded ? (
                          <ChevronDown
                            className="w-3.5 h-3.5"
                            style={{ color: "var(--fg-extra-muted)" }}
                          />
                        ) : (
                          <ChevronRight
                            className="w-3.5 h-3.5"
                            style={{ color: "var(--fg-extra-muted)" }}
                          />
                        )}
                        <Wrench
                          className="w-3.5 h-3.5"
                          style={{ color: "var(--accent-bright)" }}
                        />
                        <span className="font-mono-code font-medium text-[11.5px]">
                          {ev.tool_name}
                        </span>
                        {fileArg != null && (
                          <span
                            className="font-mono-code text-[11px] px-1.5 py-0.2 rounded"
                            style={{
                              backgroundColor: "var(--surface-2)",
                              color: "var(--fg-muted)",
                            }}
                          >
                            {String(fileArg)}
                          </span>
                        )}
                      </button>

                      {isExpanded && (
                        <div className="paseo-indent-rail ml-2">
                          <pre
                            className="font-mono-code text-[11.5px] p-2.5 rounded-[6px] border overflow-x-auto"
                            style={{
                              backgroundColor: "var(--surface-1)",
                              borderColor: "var(--border-subtle)",
                              color: "var(--fg-muted)",
                            }}
                          >
                            {JSON.stringify(ev.input, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                }

                if (ev.kind === "tool_result") {
                  return (
                    <div key={idx} className="paseo-indent-rail ml-2">
                      <div
                        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-[6px] text-[11.5px] font-mono-code"
                        style={{
                          backgroundColor: ev.is_error
                            ? "rgba(216, 132, 123, 0.12)"
                            : "var(--surface-1)",
                          color: ev.is_error ? "var(--status-danger)" : "var(--fg-muted)",
                        }}
                      >
                        <CheckCircle2
                          className="w-3.5 h-3.5 shrink-0"
                          style={{
                            color: ev.is_error
                              ? "var(--status-danger)"
                              : "var(--status-success)",
                          }}
                        />
                        <span className="whitespace-pre-wrap">{ev.output}</span>
                      </div>
                    </div>
                  );
                }

                if (ev.kind === "assistant_message") {
                  return (
                    <div key={idx} className="space-y-2 pt-1">
                      <div
                        className="text-[13.5px] leading-[1.68] whitespace-pre-wrap"
                        style={{ color: "var(--fg)" }}
                      >
                        {ev.text}
                      </div>

                      {/* Paseo CompletedTurnFooterRow */}
                      <div
                        className="flex items-center gap-3 text-[11px] pt-0.5 select-none"
                        style={{ color: "var(--fg-extra-muted)" }}
                      >
                        <span>
                          {session ? providerDisplayName(session.provider) : "Agent"}
                        </span>
                        <span>·</span>
                        <button
                          onClick={() => onOpenOrchestratorModal("handoff")}
                          className="hover:underline cursor-pointer"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          Handoff turn
                        </button>
                        <span>·</span>
                        <button
                          onClick={() => onOpenOrchestratorModal("advisor")}
                          className="hover:underline cursor-pointer"
                          style={{ color: "var(--accent-bright)" }}
                        >
                          Ask Advisor
                        </button>
                      </div>
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

                if (ev.kind === "status_changed") {
                  return (
                    <div
                      key={idx}
                      className="flex items-center gap-2 text-[11px] py-1"
                      style={{ color: "var(--fg-extra-muted)" }}
                    >
                      <span className="h-[1px] flex-1 bg-[var(--border-subtle)]" />
                      <span className="font-mono-code">
                        Status → {ev.status}
                        {ev.exit_code != null ? ` (exit ${ev.exit_code})` : ""}
                      </span>
                      <span className="h-[1px] flex-1 bg-[var(--border-subtle)]" />
                    </div>
                  );
                }

                return null;
              })}
              <div ref={streamEndRef} />
            </div>
          </div>

          {/* 4. Paseo Docked Bottom Composer (ComposerDock + MessageInput + AgentControls) */}
          <div className="px-4 pb-3.5 pt-1 shrink-0">
            <div className="max-w-[760px] mx-auto relative">
              {/* Slash Command Autocomplete Popover */}
              {matchingSlashCommands.length > 0 && (
                <div
                  className="absolute bottom-full left-0 mb-2 w-full max-w-[440px] rounded-[10px] border p-1.5 shadow-2xl z-30"
                  style={{
                    backgroundColor: "var(--surface-2)",
                    borderColor: "var(--border-accent)",
                  }}
                >
                  <div
                    className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    Multi-Agent Slash Commands
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
                      <span
                        className="font-mono-code text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor: "var(--surface-3)",
                          color: "var(--fg)",
                        }}
                      >
                        Run
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Rounded Composer Box */}
              <div
                className="rounded-[12px] border transition-colors shadow-lg"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: isFocusedPane
                    ? "var(--border-accent)"
                    : "var(--border-subtle)",
                }}
              >
                {/* TextInput Area */}
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
                      ? `Message ${session.name} or type / for multi-agent commands (/handoff, /advisor, /committee, /loop)...`
                      : "Select or create a workspace..."
                  }
                  className="w-full bg-transparent px-3.5 pt-3 pb-1.5 text-[13px] resize-none focus:outline-none"
                  style={{ color: "var(--fg)" }}
                />

                {/* Bottom Composer Toolbar Rail (AgentControls + Trailing Submit Disc) */}
                <div className="px-2.5 pb-2 pt-1 flex items-center justify-between gap-2">
                  {/* Left AgentControls Pills */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {/* Provider Pill */}
                    <span
                      className="h-[24px] px-2 rounded-full text-[11px] font-medium flex items-center gap-1.5 border"
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

                    {/* Mode Pill */}
                    <span
                      className="h-[24px] px-2 rounded-full text-[11px] flex items-center gap-1 border"
                      style={{
                        backgroundColor: "var(--surface-1)",
                        borderColor: "var(--border-subtle)",
                        color: "var(--fg-muted)",
                      }}
                    >
                      <Cpu className="w-3 h-3" />
                      Auto-Edit
                    </span>

                    {/* Quick Slash Command Trigger Pill */}
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
                      /commands
                    </button>
                  </div>

                  {/* Right Action Disc (Stop Square when running, ArrowUp Disc when ready) */}
                  <div className="flex items-center gap-2">
                    {session?.status === "running" && !composerText.trim() ? (
                      <button
                        type="button"
                        onClick={() => onStopSession(session.id)}
                        title="Stop Agent"
                        className="w-[28px] h-[28px] rounded-full flex items-center justify-center transition-transform active:scale-95 cursor-pointer"
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
                        className="w-[28px] h-[28px] rounded-full flex items-center justify-center transition-all cursor-pointer disabled:opacity-35"
                        style={{
                          backgroundColor: composerText.trim()
                            ? "var(--accent)"
                            : "var(--surface-3)",
                          color: "#ffffff",
                        }}
                      >
                        <ArrowUp className="w-3.5 h-3.5 stroke-[2.5]" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Working Diff Tab View */}
      {activeTab === "diff" && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4 selectable-text">
          <div className="max-w-[960px] mx-auto space-y-4">
            <div
              className="flex items-center justify-between px-3.5 py-2.5 rounded-[8px] border"
              style={{
                backgroundColor: "var(--surface-1)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex items-center gap-2.5">
                <GitCompare
                  className="w-4 h-4"
                  style={{ color: "var(--accent-bright)" }}
                />
                <span className="text-[12.5px] font-semibold">
                  Working Tree Diff ({session?.worktree_branch})
                </span>
              </div>
              <div className="font-mono-code text-[12px] flex items-center gap-2">
                <span style={{ color: "var(--fg-muted)" }}>
                  {diffStats?.files_changed ?? parsedDiffFiles.length} files
                </span>
                <span style={{ color: "var(--status-success)" }}>
                  +{diffStats?.insertions ?? 0}
                </span>
                <span style={{ color: "var(--status-danger)" }}>
                  −{diffStats?.deletions ?? 0}
                </span>
              </div>
            </div>

            {parsedDiffFiles.map((file) => (
              <div
                key={file.path}
                className="rounded-[8px] border overflow-hidden"
                style={{
                  backgroundColor: "var(--surface-sidebar)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div
                  className="px-3.5 py-2 border-b flex items-center justify-between font-mono-code text-[12px]"
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
                        ? "rgba(108, 177, 123, 0.14)"
                        : ln.type === "del"
                        ? "rgba(216, 132, 123, 0.14)"
                        : ln.type === "hunk"
                        ? "rgba(92, 170, 246, 0.10)"
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

      {/* Terminal (PTY) Tab View */}
      {activeTab === "terminal" && (
        <div className="flex-1 flex flex-col min-h-0 p-4">
          <div
            className="flex-1 rounded-[8px] border p-3.5 font-mono-code text-[12px] overflow-y-auto selectable-text space-y-1.5"
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
              $ git status -sb → ## {session?.worktree_branch}
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

      {/* "+" NewTabPanel Launcher (Matches Paseo's packages/app/src/panels/new-tab-panel.tsx) */}
      {activeTab === "new_tab" && (
        <div className="flex-1 overflow-y-auto p-6 flex items-center justify-center">
          <div className="max-w-[540px] w-full space-y-5">
            <div className="space-y-1">
              <h2 className="text-[15px] font-semibold" style={{ color: "var(--fg)" }}>
                Open in Workspace
              </h2>
              <p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
                Launch an agent, multi-agent workflow, or tool tab in{" "}
                <span className="font-mono-code" style={{ color: "var(--accent-bright)" }}>
                  {session?.worktree_branch ?? "current worktree"}
                </span>
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={onOpenNewWorkspaceModal}
                className="p-3 rounded-[8px] border text-left transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12.5px] font-semibold flex items-center gap-1.5">
                    <Bot className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
                    New Isolated Agent
                  </span>
                  <span
                    className="font-mono-code text-[10px]"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    ⌘N
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                  Spawn Claude Code, Codex, or OpenCode in a fresh Git worktree
                </p>
              </button>

              <button
                onClick={() => onOpenOrchestratorModal("handoff")}
                className="p-3 rounded-[8px] border text-left transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12.5px] font-semibold flex items-center gap-1.5">
                    <ArrowRightLeft
                      className="w-4 h-4"
                      style={{ color: "var(--accent-bright)" }}
                    />
                    Handoff Context
                  </span>
                  <span
                    className="font-mono-code text-[10px]"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    /handoff
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                  Hand off current worktree & transcript to another agent provider
                </p>
              </button>

              <button
                onClick={() => onOpenOrchestratorModal("committee")}
                className="p-3 rounded-[8px] border text-left transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12.5px] font-semibold flex items-center gap-1.5">
                    <Layers className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
                    Multi-Agent Committee
                  </span>
                  <span
                    className="font-mono-code text-[10px]"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    /committee
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                  Run parallel review across Claude + Codex + synthesizer judge
                </p>
              </button>

              <button
                onClick={() => onOpenOrchestratorModal("loop")}
                className="p-3 rounded-[8px] border text-left transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12.5px] font-semibold flex items-center gap-1.5">
                    <Repeat className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
                    Autonomous Goal Loop
                  </span>
                  <span
                    className="font-mono-code text-[10px]"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    /loop
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                  Worker + Evaluator iterative verification until goal passes
                </p>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
