import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompare,
  Network,
  PanelRightClose,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { GitDiffStats, SessionInfo } from "../types";
import { providerDisplayName } from "./PaseoLeftSidebar";

export interface ParsedDiffFile {
  path: string;
  fileName: string;
  dirPath: string;
  status: "M" | "A" | "D";
  insertions: number;
  deletions: number;
  lines: Array<{
    type: "add" | "del" | "hunk" | "ctx";
    oldLine: number | null;
    newLine: number | null;
    content: string;
  }>;
}

export function parseUnifiedDiffToFiles(rawDiff: string): ParsedDiffFile[] {
  if (!rawDiff || !rawDiff.trim()) return [];
  const files: ParsedDiffFile[] = [];
  const chunks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const rawLines = chunk.split("\n");
    const header = rawLines[0] || "";
    const match = header.match(/a\/(.+?)\s+b\/(.+)$/);
    const path = match ? match[2].trim() : header.trim() || "modified-file";
    const parts = path.split("/");
    const fileName = parts.pop() || path;
    const dirPath = parts.join("/");

    let status: "M" | "A" | "D" = "M";
    if (chunk.includes("new file mode")) status = "A";
    else if (chunk.includes("deleted file mode")) status = "D";

    let insertions = 0;
    let deletions = 0;
    let oldLine = 1;
    let newLine = 1;
    const lines: ParsedDiffFile["lines"] = [];

    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode")
      ) {
        continue;
      }
      if (line.startsWith("@@")) {
        const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          oldLine = parseInt(hunkMatch[1], 10);
          newLine = parseInt(hunkMatch[2], 10);
        }
        lines.push({
          type: "hunk",
          oldLine: null,
          newLine: null,
          content: line,
        });
      } else if (line.startsWith("+")) {
        insertions++;
        lines.push({
          type: "add",
          oldLine: null,
          newLine: newLine++,
          content: line.slice(1),
        });
      } else if (line.startsWith("-")) {
        deletions++;
        lines.push({
          type: "del",
          oldLine: oldLine++,
          newLine: null,
          content: line.slice(1),
        });
      } else if (line.startsWith(" ") || line === "") {
        lines.push({
          type: "ctx",
          oldLine: oldLine++,
          newLine: newLine++,
          content: line.startsWith(" ") ? line.slice(1) : line,
        });
      }
    }

    files.push({
      path,
      fileName,
      dirPath,
      status,
      insertions,
      deletions,
      lines,
    });
  }

  return files;
}

interface PaseoExplorerSidebarProps {
  session: SessionInfo | null;
  diffText: string;
  diffStats: GitDiffStats | null;
  onRefreshDiff: () => void;
  onOpenDiffTab: (filePath?: string) => void;
  onCloseExplorer: () => void;
}

export const PaseoExplorerSidebar: React.FC<PaseoExplorerSidebarProps> = ({
  session,
  diffText,
  diffStats,
  onRefreshDiff,
  onOpenDiffTab,
  onCloseExplorer,
}) => {
  const [activeTab, setActiveTab] = useState<"changes" | "files" | "topology">("changes");
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  const parsedFiles = useMemo(() => parseUnifiedDiffToFiles(diffText), [diffText]);

  const worktreeTreeEntries = useMemo(() => {
    const baseEntries = [
      { path: "Cargo.toml", kind: "file" as const, note: "workspace" },
      { path: ".worktreeinclude", kind: "file" as const, note: "synced" },
      { path: "crates/velo-protocol/src/lib.rs", kind: "file" as const },
      { path: "crates/velo-worktree/src/lib.rs", kind: "file" as const },
      { path: "crates/velo-agent/src/lib.rs", kind: "file" as const },
      { path: "crates/velo-daemon/src/lib.rs", kind: "file" as const },
      { path: "crates/velo-relay/src/lib.rs", kind: "file" as const },
      { path: "crates/velo-cli/src/main.rs", kind: "file" as const },
      { path: "apps/velo-desktop/src/App.tsx", kind: "file" as const },
    ];
    for (const f of parsedFiles) {
      if (!baseEntries.some((b) => b.path === f.path)) {
        baseEntries.unshift({ path: f.path, kind: "file", note: "modified" });
      }
    }
    return baseEntries;
  }, [parsedFiles]);

  return (
    <aside className="w-[310px] shrink-0 h-full flex flex-col select-none velo-sidebar-island overflow-hidden">
      {/* Top Segmented Explorer Header (44px height) */}
      <div
        className="h-[44px] px-2.5 flex items-center justify-between border-b shrink-0"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <div
          className="p-0.5 rounded-[8px] border flex items-center gap-0.5"
          style={{
            backgroundColor: "var(--surface-0)",
            borderColor: "var(--border-subtle)",
          }}
        >
          <button
            onClick={() => setActiveTab("changes")}
            className="h-[26px] px-2 rounded-[6px] flex items-center gap-1.5 text-[11px] font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: activeTab === "changes" ? "var(--surface-2)" : "transparent",
              color: activeTab === "changes" ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            <GitCompare className="w-3 h-3" />
            <span>Changes</span>
            {parsedFiles.length > 0 && (
              <span
                className="font-mono-code text-[9.5px] px-1.5 rounded-full"
                style={{
                  backgroundColor: "var(--surface-3)",
                  color: "var(--fg)",
                }}
              >
                {parsedFiles.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab("files")}
            className="h-[26px] px-2 rounded-[6px] flex items-center gap-1.5 text-[11px] font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: activeTab === "files" ? "var(--surface-2)" : "transparent",
              color: activeTab === "files" ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            <Folder className="w-3 h-3" />
            <span>Files</span>
          </button>

          <button
            onClick={() => setActiveTab("topology")}
            className="h-[26px] px-2 rounded-[6px] flex items-center gap-1.5 text-[11px] font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: activeTab === "topology" ? "var(--surface-2)" : "transparent",
              color: activeTab === "topology" ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            <Network className="w-3 h-3" />
            <span>DAG</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onRefreshDiff}
            title="Refresh Git Worktree Status"
            className="w-6 h-6 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--fg-muted)" }}
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            onClick={onCloseExplorer}
            title="Close Inspector Dock (⌘E)"
            className="w-6 h-6 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
            style={{ color: "var(--fg-muted)" }}
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tab 1: Changes Tree */}
      {activeTab === "changes" && (
        <div className="flex-1 flex flex-col min-h-0 t-blur-swap">
          <div
            className="px-3 py-2 border-b flex items-center justify-between text-[11.5px] shrink-0"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <div className="flex items-center gap-2">
              <span style={{ color: "var(--fg-muted)" }}>
                {diffStats?.files_changed ?? parsedFiles.length} modified
              </span>
              <span className="font-mono-code flex items-center gap-1 text-[11px]">
                <span style={{ color: "var(--status-success)" }}>
                  +{diffStats?.insertions ?? 0}
                </span>
                <span style={{ color: "var(--status-danger)" }}>
                  −{diffStats?.deletions ?? 0}
                </span>
              </span>
            </div>

            <button
              onClick={() => onOpenDiffTab()}
              className="flex items-center gap-1 text-[11px] hover:underline cursor-pointer"
              style={{ color: "var(--accent-bright)" }}
            >
              <span>Diff Studio</span>
              <ExternalLink className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {parsedFiles.length === 0 ? (
              <div className="px-3 py-10 text-center space-y-1.5">
                <p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
                  Working tree clean
                </p>
                <p className="text-[11px]" style={{ color: "var(--fg-extra-muted)" }}>
                  No uncommitted changes in{" "}
                  <span className="font-mono-code">{session?.branch ?? "worktree"}</span>
                </p>
              </div>
            ) : (
              parsedFiles.map((file) => {
                const isExpanded = expandedFile === file.path;
                const statusColor =
                  file.status === "A"
                    ? "var(--status-success)"
                    : file.status === "D"
                    ? "var(--status-danger)"
                    : "var(--status-warning)";

                return (
                  <div
                    key={file.path}
                    className="rounded-[8px] overflow-hidden border transition-colors"
                    style={{
                      backgroundColor: isExpanded ? "var(--surface-1)" : "var(--surface-0)",
                      borderColor: isExpanded ? "var(--border-accent)" : "var(--border-subtle)",
                    }}
                  >
                    <div className="flex items-center justify-between px-2.5 py-2 hover:bg-[var(--surface-1)] gap-1.5">
                      <button
                        onClick={() =>
                          setExpandedFile((prev) => (prev === file.path ? null : file.path))
                        }
                        className="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer"
                      >
                        {isExpanded ? (
                          <ChevronDown
                            className="w-3 h-3 shrink-0"
                            style={{ color: "var(--fg-extra-muted)" }}
                          />
                        ) : (
                          <ChevronRight
                            className="w-3 h-3 shrink-0"
                            style={{ color: "var(--fg-extra-muted)" }}
                          />
                        )}
                        <span
                          className="font-mono-code text-[10px] font-bold w-4 h-4 rounded flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: "var(--surface-2)",
                            color: statusColor,
                          }}
                        >
                          {file.status}
                        </span>
                        <span
                          className="text-[12px] font-medium truncate"
                          style={{ color: "var(--fg)" }}
                        >
                          {file.fileName}
                        </span>
                      </button>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="font-mono-code text-[10.5px] flex items-center gap-1">
                          <span style={{ color: "var(--status-success)" }}>
                            +{file.insertions}
                          </span>
                          <span style={{ color: "var(--status-danger)" }}>
                            −{file.deletions}
                          </span>
                        </span>
                        <button
                          onClick={() => onOpenDiffTab(file.path)}
                          title="Open in Diff Studio"
                          className="p-0.5 rounded hover:bg-[var(--surface-2)] cursor-pointer"
                          style={{ color: "var(--fg-extra-muted)" }}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    <div className={`t-grid-collapse ${isExpanded ? "t-expanded" : ""}`}>
                      <div className="t-grid-collapse-inner">
                        <div
                          className="border-t font-mono-code text-[10.5px] overflow-x-auto max-h-[220px] overflow-y-auto selectable-text"
                          style={{
                            backgroundColor: "var(--surface-0)",
                            borderColor: "var(--border-subtle)",
                          }}
                        >
                          {file.lines.slice(0, 60).map((ln, idx) => {
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
                                key={idx}
                                className="px-2 py-0.5 whitespace-pre flex items-center gap-2"
                                style={{ backgroundColor: bg, color: fg }}
                              >
                                <span
                                  className="w-6 text-right shrink-0 select-none opacity-50"
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
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Files Tree */}
      {activeTab === "files" && (
        <div className="flex-1 flex flex-col min-h-0 t-blur-swap">
          <div
            className="px-3 py-2 border-b flex items-center gap-1.5 text-[11px] font-mono-code truncate shrink-0"
            style={{
              borderColor: "var(--border-subtle)",
              color: "var(--fg-extra-muted)",
            }}
            title={session?.worktree_path}
          >
            <FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--accent-bright)" }} />
            <span className="truncate">{session?.worktree_path ?? "~/.velo/worktrees"}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
            {worktreeTreeEntries.map((item) => {
              const modified = parsedFiles.find((f) => f.path === item.path);
              return (
                <button
                  key={item.path}
                  onClick={() => onOpenDiffTab(item.path)}
                  className="w-full px-2.5 py-1.5 rounded-[6px] flex items-center justify-between gap-2 text-left hover:bg-[var(--surface-1)] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <FileCode2
                      className="w-3.5 h-3.5 shrink-0"
                      style={{
                        color: modified ? "var(--status-warning)" : "var(--fg-extra-muted)",
                      }}
                    />
                    <span
                      className="font-mono-code text-[11.5px] truncate"
                      style={{ color: modified ? "var(--fg)" : "var(--fg-muted)" }}
                    >
                      {item.path}
                    </span>
                  </div>
                  {modified ? (
                    <span
                      className="font-mono-code text-[10px] font-bold shrink-0"
                      style={{ color: "var(--status-warning)" }}
                    >
                      {modified.status}
                    </span>
                  ) : item.note ? (
                    <span
                      className="font-mono-code text-[10px] px-1.5 rounded shrink-0"
                      style={{
                        backgroundColor: "var(--surface-2)",
                        color: "var(--fg-extra-muted)",
                      }}
                    >
                      {item.note}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab 3: Multi-Agent Orchestration DAG & Worktree Isolation Telemetry */}
      {activeTab === "topology" && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3 t-blur-swap">
          <div
            className="rounded-[9px] border p-3 space-y-2 rare-specular-pill"
            style={{
              backgroundColor: "var(--surface-0)",
              borderColor: "var(--border-accent)",
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--accent-bright)" }}>
                Worktree Isolation Sandbox
              </span>
              <ShieldCheck className="w-3.5 h-3.5" style={{ color: "var(--status-success)" }} />
            </div>
            <div className="font-mono-code text-[11px] space-y-1" style={{ color: "var(--fg-muted)" }}>
              <div className="flex items-center gap-1.5">
                <GitBranch className="w-3 h-3" style={{ color: "var(--accent-bright)" }} />
                <span style={{ color: "var(--fg)" }}>{session?.branch}</span>
              </div>
              <div className="truncate text-[10.5px]" style={{ color: "var(--fg-extra-muted)" }}>
                {session?.worktree_path}
              </div>
            </div>
          </div>

          {/* Visual DAG Lineage */}
          <div className="space-y-2">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider px-1" style={{ color: "var(--fg-extra-muted)" }}>
              Agent Orchestration Lineage
            </div>

            <div className="paseo-indent-rail space-y-2.5">
              <div
                className="rounded-[8px] border p-2.5 space-y-1"
                style={{
                  backgroundColor: "var(--surface-1)",
                  borderColor: "var(--accent)",
                }}
              >
                <div className="flex items-center justify-between text-[11.5px] font-semibold">
                  <span>{session?.name ?? "Primary Agent"}</span>
                  <span className="font-mono-code text-[10px]" style={{ color: "var(--accent-bright)" }}>
                    {session ? providerDisplayName(session.provider) : "Claude"}
                  </span>
                </div>
                <p className="text-[10.5px]" style={{ color: "var(--fg-muted)" }}>
                  Active writer in isolated worktree
                </p>
              </div>

              <div
                className="rounded-[8px] border p-2.5 space-y-1"
                style={{
                  backgroundColor: "var(--surface-0)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between text-[11.5px] font-medium">
                  <span>/advisor Peer Reviewer</span>
                  <span className="font-mono-code text-[10px]" style={{ color: "var(--fg-extra-muted)" }}>
                    Codex
                  </span>
                </div>
                <p className="text-[10.5px]" style={{ color: "var(--fg-extra-muted)" }}>
                  Read-only diff critique & concurrency audit
                </p>
              </div>

              <div
                className="rounded-[8px] border p-2.5 space-y-1"
                style={{
                  backgroundColor: "var(--surface-0)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between text-[11.5px] font-medium">
                  <span>/loop Verification Gate</span>
                  <span className="font-mono-code text-[10px]" style={{ color: "var(--status-success)" }}>
                    cargo test
                  </span>
                </div>
                <p className="text-[10.5px]" style={{ color: "var(--fg-extra-muted)" }}>
                  Automated self-healing check command
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
