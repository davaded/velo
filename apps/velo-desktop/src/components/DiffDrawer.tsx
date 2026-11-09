import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  GitBranch,
  RefreshCw,
  X,
} from "lucide-react";
import { SessionDiffResponse, SessionInfo } from "../types/velo";
import { ParsedFileDiff, parseUnifiedDiff } from "../utils/diffParser";

interface DiffDrawerProps {
  session: SessionInfo | null;
  diffData: SessionDiffResponse | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

export function DiffDrawer({
  session,
  diffData,
  loading,
  onRefresh,
  onClose,
}: DiffDrawerProps) {
  const [selectedFileFilter, setSelectedFileFilter] = useState<string | null>(
    null
  );
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>(
    {}
  );

  const parsedFiles = useMemo<ParsedFileDiff[]>(() => {
    return parseUnifiedDiff(diffData?.diff || "");
  }, [diffData?.diff]);

  const visibleFiles = useMemo(() => {
    if (!selectedFileFilter) return parsedFiles;
    return parsedFiles.filter((f) => f.filePath === selectedFileFilter);
  }, [parsedFiles, selectedFileFilter]);

  function toggleCollapse(path: string) {
    setCollapsedFiles((prev) => ({ ...prev, [path]: !prev[path] }));
  }

  if (!session) return null;

  return (
    <aside className="w-[460px] xl:w-[540px] shrink-0 border-l border-zinc-800/80 bg-zinc-950/95 flex flex-col h-full select-text">
      {/* Drawer Header */}
      <div className="h-12 px-4 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-900/40">
        <div className="flex items-center gap-2 min-w-0">
          <FileDiff className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="text-xs font-semibold text-zinc-100 truncate">
            Worktree Diff Inspector
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 flex items-center gap-1">
            <GitBranch className="w-2.5 h-2.5" />
            {session.branch}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/70 transition cursor-pointer"
            title="Refresh Git Diff"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin text-indigo-400" : ""}`}
            />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/70 transition cursor-pointer"
            title="Close Diff Drawer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Summary & File Tree Navigation Bar */}
      <div className="p-3 border-b border-zinc-800/80 bg-zinc-900/20 space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-400">
            <strong className="text-zinc-100 font-semibold">
              {parsedFiles.length}
            </strong>{" "}
            changed files in worktree
          </span>
          <div className="flex items-center gap-2.5 font-mono text-[11px]">
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
              +{session.diff_stats.insertions}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20">
              -{session.diff_stats.deletions}
            </span>
          </div>
        </div>

        {parsedFiles.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <button
              onClick={() => setSelectedFileFilter(null)}
              className={`px-2 py-1 rounded text-[11px] font-mono shrink-0 border transition cursor-pointer ${
                selectedFileFilter === null
                  ? "bg-indigo-600/20 text-indigo-200 border-indigo-500/40"
                  : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200"
              }`}
            >
              All ({parsedFiles.length})
            </button>
            {parsedFiles.map((f) => {
              const shortName = f.filePath.split("/").pop() || f.filePath;
              const active = selectedFileFilter === f.filePath;
              return (
                <button
                  key={f.filePath}
                  onClick={() =>
                    setSelectedFileFilter(active ? null : f.filePath)
                  }
                  title={f.filePath}
                  className={`px-2 py-1 rounded text-[11px] font-mono shrink-0 border flex items-center gap-1.5 transition cursor-pointer ${
                    active
                      ? "bg-indigo-600/20 text-indigo-200 border-indigo-500/40"
                      : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200"
                  }`}
                >
                  <FileCode2 className="w-3 h-3 text-zinc-500" />
                  <span>{shortName}</span>
                  <span className="text-emerald-400">+{f.additions}</span>
                  {f.deletions > 0 && (
                    <span className="text-rose-400">-{f.deletions}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Per-File Diff Cards with Dual Line Numbers */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {visibleFiles.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-zinc-500">
            <FileDiff className="w-8 h-8 text-zinc-700 mb-2" />
            <p className="text-xs font-medium text-zinc-400">
              Working tree is clean
            </p>
            <p className="text-[11px] text-zinc-600 mt-1">
              As the agent edits files inside{" "}
              <code className="text-zinc-400">{session.branch}</code>, live
              unified diffs with line numbers will appear here automatically.
            </p>
          </div>
        ) : (
          visibleFiles.map((file) => {
            const isCollapsed = !!collapsedFiles[file.filePath];
            return (
              <div
                key={file.filePath}
                className="rounded-lg border border-zinc-800/90 bg-zinc-900/30 overflow-hidden shadow-xs"
              >
                {/* File Header */}
                <button
                  onClick={() => toggleCollapse(file.filePath)}
                  className="w-full px-3 py-2 bg-zinc-900/90 border-b border-zinc-800/80 flex items-center justify-between gap-2 text-left hover:bg-zinc-900 transition cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0 font-mono text-[11px]">
                    {isCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    )}
                    <FileCode2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <span className="text-zinc-200 truncate font-medium">
                      {file.filePath}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 font-mono text-[11px] shrink-0">
                    <span className="text-emerald-400">+{file.additions}</span>
                    <span className="text-rose-400">-{file.deletions}</span>
                  </div>
                </button>

                {/* Diff Lines Table */}
                {!isCollapsed && (
                  <div className="overflow-x-auto bg-zinc-950 font-mono text-[11px] leading-5">
                    <table className="w-full border-collapse">
                      <tbody>
                        {file.lines.map((line, idx) => {
                          if (line.type === "hunk") {
                            return (
                              <tr
                                key={idx}
                                className="bg-indigo-950/25 text-indigo-300/90 border-y border-indigo-500/15"
                              >
                                <td
                                  colSpan={2}
                                  className="w-16 px-2 py-0.5 text-right select-none text-[10px] text-indigo-400/70 bg-indigo-950/40"
                                >
                                  ⋯
                                </td>
                                <td className="px-3 py-0.5 whitespace-pre">
                                  {line.content}
                                </td>
                              </tr>
                            );
                          }

                          const rowBg =
                            line.type === "add"
                              ? "bg-emerald-950/30 text-emerald-200"
                              : line.type === "del"
                              ? "bg-rose-950/30 text-rose-200"
                              : "text-zinc-400 hover:bg-zinc-900/40";

                          const gutterBg =
                            line.type === "add"
                              ? "bg-emerald-950/50 text-emerald-500/80"
                              : line.type === "del"
                              ? "bg-rose-950/50 text-rose-500/80"
                              : "bg-zinc-900/40 text-zinc-600";

                          const prefixChar =
                            line.type === "add"
                              ? "+"
                              : line.type === "del"
                              ? "-"
                              : " ";

                          return (
                            <tr key={idx} className={rowBg}>
                              <td
                                className={`w-8 px-1.5 text-right select-none border-r border-zinc-800/50 ${gutterBg}`}
                              >
                                {line.oldNumber ?? ""}
                              </td>
                              <td
                                className={`w-8 px-1.5 text-right select-none border-r border-zinc-800/50 ${gutterBg}`}
                              >
                                {line.newNumber ?? ""}
                              </td>
                              <td className="px-2.5 whitespace-pre">
                                <span className="select-none opacity-60 mr-2">
                                  {prefixChar}
                                </span>
                                {line.content}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
