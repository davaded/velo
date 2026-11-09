import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  Palette,
  PanelLeftClose,
  Plus,
  QrCode,
  Search,
  Sparkles,
  Terminal,
  Workflow,
} from "lucide-react";
import type { AgentProvider, SessionInfo } from "../types";
import { PASEO_THEMES, type PaseoThemeId } from "../theme";

interface PaseoLeftSidebarProps {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  wsConnected: boolean;
  themeId: PaseoThemeId;
  onSelectTheme: (id: PaseoThemeId) => void;
  onOpenNewWorkspaceModal: () => void;
  onOpenOrchestratorModal: (tab: "handoff" | "advisor" | "committee" | "loop") => void;
  onOpenPairModal: () => void;
  onCollapseSidebar: () => void;
}

export function providerDisplayName(provider: AgentProvider): string {
  switch (provider) {
    case "claude_code":
      return "Claude";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "gemini":
      return "Gemini";
    case "custom_pty":
      return "Shell";
    default:
      return provider;
  }
}

function formatRelativeShort(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 45) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

export const PaseoLeftSidebar: React.FC<PaseoLeftSidebarProps> = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  wsConnected,
  themeId,
  onSelectTheme,
  onOpenNewWorkspaceModal,
  onOpenOrchestratorModal,
  onOpenPairModal,
  onCollapseSidebar,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [groupMode, setGroupMode] = useState<"project" | "status">("project");
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [showThemeMenu, setShowThemeMenu] = useState(false);

  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.worktree_branch.toLowerCase().includes(q) ||
        s.project_path.toLowerCase().includes(q) ||
        s.provider.toLowerCase().includes(q)
    );
  }, [sessions, searchQuery]);

  const projectGroups = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const s of filteredSessions) {
      const repoName = s.project_path.split("/").filter(Boolean).pop() || "workspace";
      const list = map.get(repoName) ?? [];
      list.push(s);
      map.set(repoName, list);
    }
    return Array.from(map.entries());
  }, [filteredSessions]);

  const statusGroups = useMemo(() => {
    const active = filteredSessions.filter((s) => s.status === "running" || s.status === "starting");
    const idle = filteredSessions.filter((s) => s.status === "idle");
    const done = filteredSessions.filter((s) => s.status === "completed" || s.status === "failed");
    return [
      { key: "active", label: "Active", items: active },
      { key: "idle", label: "Ready", items: idle },
      { key: "done", label: "Completed", items: done },
    ].filter((g) => g.items.length > 0);
  }, [filteredSessions]);

  const toggleProject = (repo: string) => {
    setCollapsedProjects((prev) => ({ ...prev, [repo]: !prev[repo] }));
  };

  const renderStatusIndicator = (status: SessionInfo["status"]) => {
    if (status === "running" || status === "starting") {
      return <span className="paseo-status-ring shrink-0" title="Agent Running" />;
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
        title={`Status: ${status}`}
      />
    );
  };

  const renderWorkspaceRow = (session: SessionInfo, index: number) => {
    const selected = session.id === selectedSessionId;
    const hasDiff =
      session.diff_stats &&
      (session.diff_stats.insertions > 0 || session.diff_stats.deletions > 0);

    return (
      <button
        key={session.id}
        onClick={() => onSelectSession(session.id)}
        className="w-full text-left group relative flex flex-col gap-0.5 px-2.5 py-1.5 rounded-[6px] transition-colors cursor-pointer"
        style={{
          backgroundColor: selected ? "var(--surface-2)" : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.backgroundColor = "var(--surface-1)";
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        {/* Primary Row: Status Indicator + Title + Diff Stats */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-3.5 flex items-center justify-center shrink-0">
              {renderStatusIndicator(session.status)}
            </div>
            <span
              className="text-[12.5px] font-medium truncate"
              style={{
                color: selected ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              {session.name}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {hasDiff ? (
              <span className="font-mono-code text-[10.5px] flex items-center gap-1">
                <span style={{ color: "var(--status-success)" }}>
                  +{session.diff_stats!.insertions}
                </span>
                <span style={{ color: "var(--status-danger)" }}>
                  −{session.diff_stats!.deletions}
                </span>
              </span>
            ) : index < 9 ? (
              <span
                className="font-mono-code text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ color: "var(--fg-extra-muted)" }}
              >
                ⌘{index + 1}
              </span>
            ) : null}
          </div>
        </div>

        {/* Secondary Meta Row: Branch + Provider + Relative Time */}
        <div className="flex items-center justify-between gap-1.5 pl-[22px] min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <GitBranch
              className="w-2.5 h-2.5 shrink-0"
              style={{ color: "var(--fg-extra-muted)" }}
            />
            <span
              className="font-mono-code text-[11px] truncate"
              style={{ color: "var(--fg-extra-muted)" }}
            >
              {session.worktree_branch}
            </span>
            <span style={{ color: "var(--surface-4)" }}>·</span>
            <span
              className="text-[10.5px] shrink-0"
              style={{
                color:
                  session.provider === "claude_code"
                    ? "var(--accent-bright)"
                    : "var(--fg-extra-muted)",
              }}
            >
              {providerDisplayName(session.provider)}
            </span>
          </div>

          <span
            className="font-mono-code text-[10px] shrink-0"
            style={{ color: "var(--fg-extra-muted)" }}
          >
            {formatRelativeShort(session.created_at)}
          </span>
        </div>
      </button>
    );
  };

  return (
    <aside
      className="w-[260px] shrink-0 h-full flex flex-col border-r select-none"
      style={{
        backgroundColor: "var(--surface-sidebar)",
        borderColor: "var(--border-subtle)",
      }}
    >
      {/* Top Sidebar Header (38px height, matches WorkspaceDesktopTabsRow) */}
      <div
        className="h-[38px] px-2.5 flex items-center justify-between border-b shrink-0"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onCollapseSidebar}
            title="Collapse Sidebar (⌘B)"
            className="w-6 h-6 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--fg-muted)" }}
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="w-[6px] h-[6px] rounded-full shrink-0"
              style={{
                backgroundColor: wsConnected ? "var(--dot-success)" : "var(--dot-danger)",
              }}
            />
            <span className="text-[12px] font-semibold tracking-tight truncate">
              Velo
            </span>
            <span
              className="font-mono-code text-[10px] px-1.5 py-0.2 rounded"
              style={{
                backgroundColor: "var(--surface-2)",
                color: "var(--fg-muted)",
              }}
            >
              local
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => onOpenOrchestratorModal("committee")}
            title="Multi-Agent Workflows (Handoff / Advisor / Committee / Loop)"
            className="w-6 h-6 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--accent-bright)" }}
          >
            <Workflow className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onOpenNewWorkspaceModal}
            title="New Workspace Agent (⌘N)"
            className="w-6 h-6 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--fg)" }}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filter & Group Mode Sub-bar */}
      <div className="px-2.5 pt-2 pb-1.5 flex flex-col gap-1.5 shrink-0">
        <div
          className="flex items-center gap-1.5 px-2 h-[26px] rounded-[6px] border"
          style={{
            backgroundColor: "var(--surface-1)",
            borderColor: "var(--border-subtle)",
          }}
        >
          <Search className="w-3 h-3 shrink-0" style={{ color: "var(--fg-extra-muted)" }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter workspaces..."
            className="w-full bg-transparent text-[11.5px] focus:outline-none"
            style={{ color: "var(--fg)" }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-[10px] cursor-pointer"
              style={{ color: "var(--fg-extra-muted)" }}
            >
              Esc
            </button>
          )}
        </div>

        {/* Section Header + Group Mode Switcher */}
        <div className="flex items-center justify-between px-1 pt-0.5">
          <span
            className="text-[10.5px] font-medium uppercase tracking-wider"
            style={{ color: "var(--fg-extra-muted)" }}
          >
            Workspaces ({filteredSessions.length})
          </span>
          <div className="flex items-center gap-1 text-[10.5px]">
            <button
              onClick={() => setGroupMode("project")}
              className="px-1.5 py-0.5 rounded cursor-pointer transition-colors"
              style={{
                backgroundColor: groupMode === "project" ? "var(--surface-2)" : "transparent",
                color: groupMode === "project" ? "var(--fg)" : "var(--fg-extra-muted)",
              }}
            >
              Project
            </button>
            <button
              onClick={() => setGroupMode("status")}
              className="px-1.5 py-0.5 rounded cursor-pointer transition-colors"
              style={{
                backgroundColor: groupMode === "status" ? "var(--surface-2)" : "transparent",
                color: groupMode === "status" ? "var(--fg)" : "var(--fg-extra-muted)",
              }}
            >
              Status
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable Workspace List */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1 space-y-2">
        {groupMode === "project" ? (
          projectGroups.map(([repoName, items]) => {
            const isCollapsed = !!collapsedProjects[repoName];
            return (
              <div key={repoName} className="space-y-0.5">
                {/* Project Header Row */}
                <div className="group flex items-center justify-between px-2 py-1 rounded-[5px] hover:bg-[var(--surface-1)]">
                  <button
                    onClick={() => toggleProject(repoName)}
                    className="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer"
                  >
                    {isCollapsed ? (
                      <ChevronRight
                        className="w-3 h-3 shrink-0"
                        style={{ color: "var(--fg-extra-muted)" }}
                      />
                    ) : (
                      <ChevronDown
                        className="w-3 h-3 shrink-0"
                        style={{ color: "var(--fg-extra-muted)" }}
                      />
                    )}
                    <FolderGit2
                      className="w-3.5 h-3.5 shrink-0"
                      style={{ color: "var(--accent-bright)" }}
                    />
                    <span
                      className="text-[12px] font-semibold truncate"
                      style={{ color: "var(--fg)" }}
                    >
                      {repoName}
                    </span>
                    <span
                      className="font-mono-code text-[10px]"
                      style={{ color: "var(--fg-extra-muted)" }}
                    >
                      {items.length}
                    </span>
                  </button>

                  <button
                    onClick={onOpenNewWorkspaceModal}
                    title={`New worktree in ${repoName}`}
                    className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--surface-2)] transition-opacity cursor-pointer"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>

                {/* Indented Workspace Rows */}
                {!isCollapsed && (
                  <div className="space-y-0.5">
                    {items.map((session, idx) => renderWorkspaceRow(session, idx))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          statusGroups.map((group) => (
            <div key={group.key} className="space-y-0.5">
              <div className="px-2 py-1 flex items-center justify-between">
                <span
                  className="text-[11px] font-medium"
                  style={{ color: "var(--fg-muted)" }}
                >
                  {group.label}
                </span>
                <span
                  className="font-mono-code text-[10px]"
                  style={{ color: "var(--fg-extra-muted)" }}
                >
                  {group.items.length}
                </span>
              </div>
              {group.items.map((session, idx) => renderWorkspaceRow(session, idx))}
            </div>
          ))
        )}

        {filteredSessions.length === 0 && (
          <div className="px-3 py-8 text-center space-y-2">
            <Terminal
              className="w-5 h-5 mx-auto"
              style={{ color: "var(--fg-extra-muted)" }}
            />
            <p className="text-[11.5px]" style={{ color: "var(--fg-muted)" }}>
              No matching workspaces
            </p>
            <button
              onClick={onOpenNewWorkspaceModal}
              className="px-2.5 py-1 rounded-[6px] text-[11.5px] font-medium cursor-pointer"
              style={{
                backgroundColor: "var(--accent)",
                color: "#ffffff",
              }}
            >
              + New Workspace
            </button>
          </div>
        )}
      </div>

      {/* Bottom Paseo Footer Bar (Theme Switcher, Mobile Pair QR, MCP Status) */}
      <div
        className="h-[38px] px-2.5 border-t flex items-center justify-between relative shrink-0"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="font-mono-code text-[10.5px] truncate"
            style={{ color: "var(--fg-extra-muted)" }}
          >
            127.0.0.1:6767
          </span>
          <span style={{ color: "var(--surface-4)" }}>·</span>
          <span
            className="font-mono-code text-[10px]"
            style={{ color: "var(--accent-bright)" }}
            title="MCP JSON-RPC 2.0 Server Active at /mcp"
          >
            MCP
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Orchestrator quick button */}
          <button
            onClick={() => onOpenOrchestratorModal("handoff")}
            title="Agent Orchestration (/handoff, /advisor, /committee, /loop)"
            className="h-6 px-1.5 rounded-[5px] flex items-center gap-1 text-[11px] transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--fg-muted)" }}
          >
            <Sparkles className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
          </button>

          {/* E2EE Mobile Pair QR */}
          <button
            onClick={onOpenPairModal}
            title="Pair Mobile App (E2EE Relay QR)"
            className="h-6 px-1.5 rounded-[5px] flex items-center gap-1 text-[11px] transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--fg-muted)" }}
          >
            <QrCode className="w-3 h-3" />
          </button>

          {/* Paseo Built-in Theme Switcher */}
          <button
            onClick={() => setShowThemeMenu((v) => !v)}
            title="Switch Paseo Theme"
            className="h-6 px-2 rounded-[5px] flex items-center gap-1 text-[11px] transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{
              backgroundColor: showThemeMenu ? "var(--surface-2)" : "transparent",
              color: "var(--fg-muted)",
            }}
          >
            <Palette className="w-3 h-3" />
            <span className="text-[10.5px]">{PASEO_THEMES[themeId].label}</span>
          </button>
        </div>

        {/* Theme Popover Menu */}
        {showThemeMenu && (
          <div
            className="absolute bottom-[44px] right-2 w-[196px] rounded-[8px] border p-1 shadow-2xl z-50"
            style={{
              backgroundColor: "var(--surface-2)",
              borderColor: "var(--border-accent)",
            }}
          >
            <div
              className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--fg-extra-muted)" }}
            >
              Paseo Themes
            </div>
            {(Object.keys(PASEO_THEMES) as PaseoThemeId[]).map((id) => {
              const spec = PASEO_THEMES[id];
              const active = id === themeId;
              return (
                <button
                  key={id}
                  onClick={() => {
                    onSelectTheme(id);
                    setShowThemeMenu(false);
                  }}
                  className="w-full px-2 py-1.5 rounded-[5px] flex items-center justify-between text-left text-[11.5px] transition-colors cursor-pointer hover:bg-[var(--surface-1)]"
                  style={{
                    backgroundColor: active ? "var(--surface-1)" : "transparent",
                    color: active ? "var(--fg)" : "var(--fg-muted)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full border"
                      style={{
                        backgroundColor: spec.colors.surface0,
                        borderColor: spec.colors.accentBright,
                      }}
                    />
                    <span>{spec.label}</span>
                  </div>
                  {active && (
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: "var(--accent-bright)" }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
};
