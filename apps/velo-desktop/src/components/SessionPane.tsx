import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FolderGit2,
  GitBranch,
  Loader2,
  Send,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  AgentEvent,
  SessionInfo,
  SessionStatus,
  formatProvider,
  providerBadgeColor,
} from "../types/velo";
import { TimelineItem, aggregateEventsToTimeline } from "../utils/eventAggregator";

interface SessionPaneProps {
  session: SessionInfo;
  events: AgentEvent[];
  isFocused: boolean;
  compact: boolean;
  onFocus: () => void;
  onOpenDiff: () => void;
  onHandoff: (session: SessionInfo) => void;
  onAdvisor: (session: SessionInfo) => void;
  onStop: (sessionId: string) => void;
  onSendInput: (sessionId: string, input: string) => void;
}

export function SessionPane({
  session,
  events,
  isFocused,
  compact,
  onFocus,
  onOpenDiff,
  onHandoff,
  onAdvisor,
  onStop,
  onSendInput,
}: SessionPaneProps) {
  const [viewMode, setViewMode] = useState<"timeline" | "pty">("timeline");
  const [inputText, setInputText] = useState("");
  const [copiedPath, setCopiedPath] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const timeline = useMemo(() => aggregateEventsToTimeline(events), [events]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendInput(session.id, inputText);
    setInputText("");
  }

  function copyWorktreePath(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(session.worktree_path);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 1500);
  }

  return (
    <section
      onClick={onFocus}
      className={`flex flex-col min-w-0 min-h-0 h-full rounded-xl border transition-all overflow-hidden bg-zinc-950/90 ${
        isFocused
          ? "border-indigo-500/50 shadow-[0_0_24px_-6px_rgba(99,102,241,0.22)]"
          : "border-zinc-800/80 hover:border-zinc-700/80"
      }`}
    >
      {/* Pane Top Bar */}
      <header className="h-11 px-3.5 border-b border-zinc-800/80 bg-zinc-900/50 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <StatusPulse status={session.status} />
          <span className="font-semibold text-xs text-zinc-100 truncate">
            {session.name}
          </span>
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${providerBadgeColor(
              session.provider
            )}`}
          >
            {formatProvider(session.provider)}
          </span>
          <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 truncate max-w-[160px]">
            <GitBranch className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
            {session.branch}
          </span>
        </div>

        {/* Action Toolbar */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFocus();
              onOpenDiff();
            }}
            className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[10px] font-mono flex items-center gap-1.5 transition cursor-pointer"
            title="Inspect Git Worktree Diff"
          >
            <FileDiff className="w-3 h-3 text-indigo-400" />
            <span className="text-zinc-300">{session.diff_stats.files_changed}f</span>
            <span className="text-emerald-400">+{session.diff_stats.insertions}</span>
            <span className="text-rose-400">-{session.diff_stats.deletions}</span>
          </button>

          {!compact && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAdvisor(session);
                }}
                className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-[11px] flex items-center gap-1 transition cursor-pointer"
                title="Summon an independent Advisor Agent (e.g. Codex) to review this worktree"
              >
                <Sparkles className="w-3 h-3 text-amber-400" />
                <span>Advisor</span>
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onHandoff(session);
                }}
                className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-[11px] flex items-center gap-1 transition cursor-pointer"
                title="Hand off this worktree & branch to another coding agent"
              >
                <ArrowRightLeft className="w-3 h-3 text-indigo-400" />
                <span>Handoff</span>
              </button>
            </>
          )}

          <button
            onClick={(e) => {
              e.stopPropagation();
              setViewMode(viewMode === "timeline" ? "pty" : "timeline");
            }}
            className={`p-1.5 rounded-md border text-[10px] font-mono transition cursor-pointer ${
              viewMode === "pty"
                ? "bg-indigo-600/20 border-indigo-500/40 text-indigo-300"
                : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
            title="Toggle Structured Timeline vs Raw PTY Terminal"
          >
            <Terminal className="w-3.5 h-3.5" />
          </button>

          {session.status === "running" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onStop(session.id);
              }}
              className="p-1.5 rounded-md bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/60 text-rose-300 transition cursor-pointer"
              title="Stop Agent Process"
            >
              <Square className="w-3 h-3 fill-current" />
            </button>
          )}
        </div>
      </header>

      {/* Subheader: Isolated Worktree Path Bar */}
      <div className="px-3.5 py-1.5 border-b border-zinc-900 bg-zinc-950/60 flex items-center justify-between text-[10px] font-mono text-zinc-500 shrink-0">
        <div className="flex items-center gap-1.5 truncate">
          <FolderGit2 className="w-3 h-3 text-zinc-600 shrink-0" />
          <span className="truncate">{session.worktree_path}</span>
        </div>
        <button
          onClick={copyWorktreePath}
          className="text-zinc-500 hover:text-zinc-300 flex items-center gap-1 shrink-0 ml-2 cursor-pointer"
        >
          <Copy className="w-2.5 h-2.5" />
          <span>{copiedPath ? "Copied" : "Copy Path"}</span>
        </button>
      </div>

      {/* Main Scrollable Stream Body */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
        {viewMode === "timeline" ? (
          <>
            {/* User Task Prompt Bubble */}
            <div className="p-3 rounded-xl bg-gradient-to-br from-indigo-950/35 to-zinc-900/80 border border-indigo-500/20">
              <div className="flex items-center justify-between text-[10px] font-mono text-indigo-300/80 mb-1">
                <span>MISSION PROMPT</span>
                <span>{new Date(session.created_at).toLocaleTimeString()}</span>
              </div>
              <p className="text-xs text-zinc-100 whitespace-pre-wrap leading-relaxed">
                {session.prompt || "(Interactive PTY Session)"}
              </p>
            </div>

            {/* Aggregated Timeline Items */}
            {timeline.map((item) => (
              <TimelineCard key={item.id} item={item} />
            ))}
          </>
        ) : (
          <div className="rounded-lg bg-black border border-zinc-800/90 p-3 font-mono text-[11px] leading-5 min-h-full space-y-0.5">
            {events.length === 0 ? (
              <div className="text-zinc-600">Waiting for terminal output...</div>
            ) : (
              events.map((ev, i) => {
                if (ev.type === "pty_output") {
                  return (
                    <div key={i} className="text-zinc-200 whitespace-pre-wrap">
                      {ev.line}
                    </div>
                  );
                }
                if (ev.type === "message_delta") {
                  return (
                    <div key={i} className="text-emerald-300 whitespace-pre-wrap">
                      {ev.text}
                    </div>
                  );
                }
                if (ev.type === "tool_call_requested") {
                  return (
                    <div key={i} className="text-indigo-400">
                      $ tool:{ev.tool_name} {JSON.stringify(ev.arguments)}
                    </div>
                  );
                }
                if (ev.type === "error") {
                  return (
                    <div key={i} className="text-rose-400">
                      [ERROR] {ev.error}
                    </div>
                  );
                }
                return null;
              })
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Bottom Interactive Input Bar */}
      <form
        onSubmit={handleSubmit}
        className="p-2.5 border-t border-zinc-800/80 bg-zinc-900/40 flex items-center gap-2 shrink-0"
      >
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={
            session.status === "running"
              ? "Send follow-up prompt or stdin to agent..."
              : `Session ${session.status} — launch Handoff or Advisor above to continue`
          }
          disabled={session.status !== "running"}
          className="flex-1 bg-zinc-950 border border-zinc-800/90 rounded-lg px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500/70 disabled:opacity-50 font-mono"
        />
        <button
          type="submit"
          disabled={session.status !== "running" || !inputText.trim()}
          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-35 text-white text-xs font-medium flex items-center gap-1 transition cursor-pointer"
        >
          <Send className="w-3 h-3" />
          <span>Send</span>
        </button>
      </form>
    </section>
  );
}

function TimelineCard({ item }: { item: TimelineItem }) {
  const [expanded, setExpanded] = useState(true);

  switch (item.kind) {
    case "reasoning":
      return (
        <div className="rounded-lg border border-amber-500/20 bg-amber-950/10 overflow-hidden">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full px-3 py-1.5 flex items-center justify-between text-left text-[11px] font-mono text-amber-300/90 hover:bg-amber-950/20 transition cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Brain className="w-3.5 h-3.5 text-amber-400" />
              <span>Reasoning Trace</span>
            </span>
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-amber-400/70" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-amber-400/70" />
            )}
          </button>
          {expanded && (
            <div className="px-3 pb-2.5 pt-1 text-xs text-zinc-300/90 whitespace-pre-wrap leading-relaxed border-t border-amber-500/10">
              {item.text}
            </div>
          )}
        </div>
      );

    case "tool":
      return (
        <div
          className={`rounded-lg border overflow-hidden text-xs font-mono ${
            item.isError
              ? "border-rose-500/30 bg-rose-950/10"
              : "border-zinc-800/90 bg-zinc-900/50"
          }`}
        >
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-zinc-900/80 transition cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {!item.completed ? (
                <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
              ) : item.isError ? (
                <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              )}
              <Wrench className="w-3 h-3 text-indigo-400 shrink-0" />
              <span className="text-zinc-200 font-semibold truncate">
                {item.toolName}
              </span>
              <span className="text-[10px] text-zinc-500 truncate">
                {JSON.stringify(item.arguments)}
              </span>
            </div>
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            )}
          </button>

          {expanded && (
            <div className="p-2.5 border-t border-zinc-800/80 bg-zinc-950/80 space-y-2 text-[11px]">
              <div>
                <div className="text-[10px] text-zinc-500 uppercase mb-1">
                  Arguments
                </div>
                <pre className="text-zinc-300 overflow-x-auto bg-zinc-900/70 p-2 rounded border border-zinc-800/60">
                  {JSON.stringify(item.arguments, null, 2)}
                </pre>
              </div>
              {item.output !== null && (
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase mb-1">
                    Output
                  </div>
                  <pre
                    className={`whitespace-pre-wrap max-h-44 overflow-y-auto p-2 rounded border ${
                      item.isError
                        ? "bg-rose-950/30 border-rose-900/50 text-rose-200"
                        : "bg-zinc-900/70 border-zinc-800/60 text-emerald-300/90"
                    }`}
                  >
                    {item.output}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      );

    case "message":
      return (
        <div className="p-3.5 rounded-xl bg-zinc-900/70 border border-zinc-800/90 text-xs text-zinc-100 whitespace-pre-wrap leading-relaxed shadow-2xs">
          {item.text}
        </div>
      );

    case "status":
      return (
        <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 py-0.5">
          <span className="h-px flex-1 bg-zinc-800/60" />
          <span>
            {item.status.toUpperCase()}
            {item.message ? ` · ${item.message}` : ""}
          </span>
          <span className="h-px flex-1 bg-zinc-800/60" />
        </div>
      );

    case "error":
      return (
        <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800/80 text-xs text-rose-200 font-mono">
          ❗ {item.error}
        </div>
      );
  }
}

export function StatusPulse({ status }: { status: SessionStatus }) {
  switch (status) {
    case "running":
    case "starting":
      return (
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
        </span>
      );
    case "waiting_for_permission":
      return <span className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />;
    case "completed":
      return <span className="w-2.5 h-2.5 rounded-full bg-sky-400 shrink-0" />;
    case "failed":
      return <span className="w-2.5 h-2.5 rounded-full bg-rose-500 shrink-0" />;
    default:
      return <span className="w-2.5 h-2.5 rounded-full bg-zinc-600 shrink-0" />;
  }
}
