import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRightLeft,
  Brain,
  CheckCircle2,
  Code2,
  Cpu,
  FileDiff,
  FolderGit2,
  GitBranch,
  Layers,
  Play,
  Plus,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { useVeloDaemon } from "./hooks/useVeloDaemon";
import {
  AgentEvent,
  AgentProvider,
  SessionDiffResponse,
  SessionStatus,
  formatProvider,
} from "./types/velo";

type ActiveTab = "stream" | "diff" | "terminal";

export default function App() {
  const {
    connected,
    sessions,
    eventsBySession,
    fetchSessionEvents,
    fetchSessionDiff,
    createSession,
    stopSession,
    sendInput,
    handoffSession,
  } = useVeloDaemon();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("stream");
  const [showNewModal, setShowNewModal] = useState(false);
  const [showHandoffModal, setShowHandoffModal] = useState(false);

  // New session form state
  const [providerInput, setProviderInput] = useState<string>("claude");
  const [customCmdInput, setCustomCmdInput] = useState<string>("");
  const [repoPathInput, setRepoPathInput] = useState<string>("/Users/daiyudai/code/velo");
  const [branchInput, setBranchInput] = useState<string>("");
  const [sessionNameInput, setSessionNameInput] = useState<string>("");
  const [promptInput, setPromptInput] = useState<string>("");
  const [usePtyInput, setUsePtyInput] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Handoff modal state
  const [handoffTarget, setHandoffTarget] = useState<string>("codex");
  const [handoffInstructions, setHandoffInstructions] = useState<string>(
    "Review the changes made so far, complete the remaining implementation, and run tests."
  );

  // Live follow-up input
  const [stdinText, setStdinText] = useState<string>("");

  // Diff viewer state
  const [diffData, setDiffData] = useState<SessionDiffResponse | null>(null);
  const [loadingDiff, setLoadingDiff] = useState<boolean>(false);

  const streamEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedId && sessions.length > 0) {
      setSelectedId(sessions[0].id);
    }
  }, [sessions, selectedId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) || null,
    [sessions, selectedId]
  );

  const activeEvents = useMemo(
    () => (selectedId ? eventsBySession[selectedId] || [] : []),
    [eventsBySession, selectedId]
  );

  useEffect(() => {
    if (selectedId) {
      fetchSessionEvents(selectedId);
    }
  }, [selectedId, fetchSessionEvents]);

  useEffect(() => {
    if (selectedId && activeTab === "diff") {
      setLoadingDiff(true);
      fetchSessionDiff(selectedId).then((res) => {
        setDiffData(res);
        setLoadingDiff(false);
      });
    }
  }, [selectedId, activeTab, fetchSessionDiff, activeSession?.diff_stats]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeEvents.length]);

  async function handleCreateSession(e: React.FormEvent) {
    e.preventDefault();
    if (!promptInput.trim() && !usePtyInput) return;
    setSubmitting(true);
    setErrorBanner(null);

    const provider: AgentProvider =
      providerInput === "custom"
        ? { custom: customCmdInput.trim() || "sh" }
        : (providerInput as AgentProvider);

    try {
      const created = await createSession({
        name: sessionNameInput.trim() || undefined,
        provider,
        prompt: promptInput,
        repo_path: repoPathInput.trim() || "/Users/daiyudai/code/velo",
        branch: branchInput.trim() || undefined,
        use_pty: usePtyInput,
      });
      setSelectedId(created.id);
      setShowNewModal(false);
      setPromptInput("");
      setBranchInput("");
      setSessionNameInput("");
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleHandoff(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSession) return;
    setSubmitting(true);
    setErrorBanner(null);
    try {
      const target: AgentProvider = handoffTarget as AgentProvider;
      const nextSession = await handoffSession(
        activeSession.id,
        target,
        handoffInstructions
      );
      setSelectedId(nextSession.id);
      setShowHandoffModal(false);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendStdin(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSession || !stdinText.trim()) return;
    const payload = stdinText;
    setStdinText("");
    await sendInput(activeSession.id, payload);
  }

  async function refreshDiff() {
    if (!activeSession) return;
    setLoadingDiff(true);
    const d = await fetchSessionDiff(activeSession.id);
    setDiffData(d);
    setLoadingDiff(false);
  }

  return (
    <div className="flex h-screen w-screen bg-zinc-950 text-zinc-100 font-sans">
      {/* Left Sidebar: Worktree & Session Fleet */}
      <aside className="w-80 flex-shrink-0 border-r border-zinc-800/80 bg-zinc-900/50 flex flex-col">
        {/* Brand Header */}
        <div className="h-14 px-4 border-b border-zinc-800/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <span className="font-semibold tracking-tight text-sm text-zinc-100">
                VELO
              </span>
              <span className="ml-2 text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                Rust + Tauri
              </span>
            </div>
          </div>

          <div
            className="flex items-center gap-1.5 text-xs"
            title={
              connected
                ? "Connected to velo-daemon (127.0.0.1:6767)"
                : "Daemon offline — run `velo up`"
            }
          >
            <span
              className={`w-2 h-2 rounded-full ${
                connected
                  ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]"
                  : "bg-rose-500"
              }`}
            />
            <span className="text-[11px] font-mono text-zinc-400">
              {connected ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
        </div>

        {/* New Session CTA */}
        <div className="p-3 border-b border-zinc-800/60">
          <button
            onClick={() => setShowNewModal(true)}
            className="w-full py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-medium text-xs flex items-center justify-center gap-2 shadow-sm transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            New Worktree Agent
          </button>
        </div>

        {/* Session List */}
        <div className="flex-1 overflow-y-auto divide-y divide-zinc-800/40">
          {sessions.length === 0 ? (
            <div className="p-6 text-center text-zinc-500 text-xs space-y-2">
              <Layers className="w-6 h-6 mx-auto text-zinc-600" />
              <p>No active worktree sessions.</p>
              <p className="text-[11px] text-zinc-600">
                Click "New Worktree Agent" or run{" "}
                <code className="text-zinc-400">velo run</code> in terminal.
              </p>
            </div>
          ) : (
            sessions.map((s) => {
              const isSelected = s.id === selectedId;
              return (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full text-left p-3.5 transition flex flex-col gap-1.5 cursor-pointer ${
                    isSelected
                      ? "bg-indigo-950/30 border-l-2 border-l-indigo-500"
                      : "hover:bg-zinc-900/80"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusDot status={s.status} />
                      <span className="font-medium text-xs text-zinc-100 truncate">
                        {s.name}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/90 text-zinc-300 border border-zinc-700/50">
                      {formatProvider(s.provider)}
                    </span>
                  </div>

                  <p className="text-[11px] text-zinc-400 line-clamp-1">
                    {s.prompt || "(Interactive PTY Session)"}
                  </p>

                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 pt-0.5">
                    <span className="flex items-center gap-1 truncate max-w-[150px]">
                      <GitBranch className="w-3 h-3 text-zinc-500 shrink-0" />
                      {s.branch}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-zinc-400">
                        {s.diff_stats.files_changed}f
                      </span>
                      <span className="text-emerald-400">
                        +{s.diff_stats.insertions}
                      </span>
                      <span className="text-rose-400">
                        -{s.diff_stats.deletions}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer Info */}
        <div className="p-2.5 border-t border-zinc-800/80 text-[11px] text-zinc-500 flex items-center justify-between font-mono">
          <span>Daemon: 127.0.0.1:6767</span>
          <span>{sessions.length} worktrees</span>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-zinc-950">
        {errorBanner && (
          <div className="bg-rose-950/80 border-b border-rose-800 px-4 py-2 text-xs text-rose-200 flex items-center justify-between">
            <span>{errorBanner}</span>
            <button
              onClick={() => setErrorBanner(null)}
              className="text-rose-400 hover:text-rose-200 font-mono"
            >
              DISMISS
            </button>
          </div>
        )}

        {!activeSession ? (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 p-8">
            <Cpu className="w-10 h-10 text-zinc-700 mb-3" />
            <h2 className="text-sm font-medium text-zinc-300">
              Select or Launch a Parallel Agent Workspace
            </h2>
            <p className="text-xs text-zinc-500 mt-1 max-w-md text-center">
              Every Velo task runs inside an isolated Git worktree so Claude
              Code, Codex, and OpenCode can build features in parallel without
              stepping on each other.
            </p>
          </div>
        ) : (
          <>
            {/* Top Session Header */}
            <header className="h-14 px-5 border-b border-zinc-800/80 flex items-center justify-between gap-4 bg-zinc-900/30">
              <div className="flex items-center gap-3 min-w-0">
                <StatusBadge status={activeSession.status} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="text-sm font-semibold text-zinc-100 truncate">
                      {activeSession.name}
                    </h1>
                    <span className="text-[11px] font-mono text-zinc-500">
                      #{activeSession.id.slice(0, 8)}
                    </span>
                    {activeSession.pid && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                        PID {activeSession.pid}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-zinc-400 font-mono truncate">
                    <span className="flex items-center gap-1 text-indigo-400">
                      <GitBranch className="w-3 h-3" />
                      {activeSession.branch}
                    </span>
                    <span className="flex items-center gap-1 truncate text-zinc-500">
                      <FolderGit2 className="w-3 h-3 shrink-0" />
                      {activeSession.worktree_path}
                    </span>
                  </div>
                </div>
              </div>

              {/* Session Controls */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setShowHandoffModal(true)}
                  className="px-2.5 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium flex items-center gap-1.5 border border-zinc-700/60 transition cursor-pointer"
                  title="Hand off this Git worktree & progress to another coding agent"
                >
                  <ArrowRightLeft className="w-3.5 h-3.5 text-indigo-400" />
                  Handoff
                </button>

                {activeSession.status === "running" && (
                  <button
                    onClick={() => stopSession(activeSession.id)}
                    className="px-2.5 py-1.5 rounded-md bg-rose-950/60 hover:bg-rose-900/70 text-rose-300 border border-rose-800/60 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    Stop
                  </button>
                )}
              </div>
            </header>

            {/* View Switcher Tabs */}
            <div className="px-5 border-b border-zinc-800/80 bg-zinc-900/20 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <TabButton
                  active={activeTab === "stream"}
                  onClick={() => setActiveTab("stream")}
                  icon={<Activity className="w-3.5 h-3.5" />}
                  label="Structured Stream"
                  badge={activeEvents.length}
                />
                <TabButton
                  active={activeTab === "diff"}
                  onClick={() => setActiveTab("diff")}
                  icon={<FileDiff className="w-3.5 h-3.5" />}
                  label="Worktree Diff"
                  badge={`${activeSession.diff_stats.files_changed} files`}
                />
                <TabButton
                  active={activeTab === "terminal"}
                  onClick={() => setActiveTab("terminal")}
                  icon={<Terminal className="w-3.5 h-3.5" />}
                  label="Raw PTY / Logs"
                />
              </div>

              {activeTab === "diff" && (
                <button
                  onClick={refreshDiff}
                  className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 py-1 px-2 rounded hover:bg-zinc-800/60 cursor-pointer"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${loadingDiff ? "animate-spin" : ""}`}
                  />
                  Refresh Diff
                </button>
              )}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto p-5">
              {activeTab === "stream" && (
                <div className="max-w-4xl mx-auto space-y-3">
                  {/* Initial Task Card */}
                  <div className="p-3.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
                    <div className="text-[11px] font-mono uppercase text-indigo-400 mb-1 flex items-center justify-between">
                      <span>Task Prompt ({formatProvider(activeSession.provider)})</span>
                      <span className="text-zinc-500">
                        {new Date(activeSession.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
                      {activeSession.prompt}
                    </p>
                  </div>

                  {/* Event Stream Cards */}
                  {activeEvents.map((ev, idx) => (
                    <EventCard key={idx} event={ev} />
                  ))}
                  <div ref={streamEndRef} />
                </div>
              )}

              {activeTab === "diff" && (
                <div className="max-w-5xl mx-auto space-y-4">
                  {/* Modified Files Summary */}
                  <div className="p-3.5 rounded-lg bg-zinc-900/70 border border-zinc-800 flex items-center justify-between">
                    <div className="flex items-center gap-3 text-xs">
                      <Code2 className="w-4 h-4 text-indigo-400" />
                      <span className="font-medium text-zinc-200">
                        {activeSession.diff_stats.files_changed} modified files in{" "}
                        <code className="text-indigo-300 font-mono">
                          {activeSession.branch}
                        </code>
                      </span>
                    </div>
                    <div className="flex items-center gap-3 font-mono text-xs">
                      <span className="text-emerald-400">
                        +{activeSession.diff_stats.insertions} insertions
                      </span>
                      <span className="text-rose-400">
                        -{activeSession.diff_stats.deletions} deletions
                      </span>
                    </div>
                  </div>

                  {activeSession.diff_stats.modified_files.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {activeSession.diff_stats.modified_files.map((file) => (
                        <span
                          key={file}
                          className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300"
                        >
                          {file}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Unified Diff Renderer */}
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden font-mono text-xs">
                    {!diffData?.diff?.trim() ? (
                      <div className="p-8 text-center text-zinc-500">
                        No uncommitted changes detected against HEAD in this worktree.
                      </div>
                    ) : (
                      <div className="overflow-x-auto p-3 space-y-0.5">
                        {diffData.diff.split("\n").map((line, i) => {
                          let cls = "text-zinc-400";
                          if (line.startsWith("+") && !line.startsWith("+++")) {
                            cls = "bg-emerald-950/40 text-emerald-300";
                          } else if (
                            line.startsWith("-") &&
                            !line.startsWith("---")
                          ) {
                            cls = "bg-rose-950/40 text-rose-300";
                          } else if (line.startsWith("@@")) {
                            cls = "text-indigo-400 bg-indigo-950/20";
                          } else if (line.startsWith("diff --git")) {
                            cls =
                              "text-zinc-200 font-semibold border-t border-zinc-800 pt-2 mt-2";
                          }
                          return (
                            <div key={i} className={`px-2 py-0.5 whitespace-pre ${cls}`}>
                              {line || " "}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === "terminal" && (
                <div className="max-w-5xl mx-auto rounded-lg bg-black border border-zinc-800 p-4 font-mono text-xs space-y-1 min-h-[420px]">
                  {activeEvents.map((ev, i) => {
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
                    if (ev.type === "error") {
                      return (
                        <div key={i} className="text-rose-400 whitespace-pre-wrap">
                          [ERROR] {ev.error}
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              )}
            </div>

            {/* Bottom Interactive Input Bar */}
            <form
              onSubmit={handleSendStdin}
              className="p-3 border-t border-zinc-800/80 bg-zinc-900/40 flex items-center gap-2"
            >
              <input
                type="text"
                value={stdinText}
                onChange={(e) => setStdinText(e.target.value)}
                placeholder={
                  activeSession.status === "running"
                    ? "Send stdin / follow-up input to running agent..."
                    : "Session is not currently running"
                }
                disabled={activeSession.status !== "running"}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50 font-mono"
              />
              <button
                type="submit"
                disabled={activeSession.status !== "running" || !stdinText.trim()}
                className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                Send
              </button>
            </form>
          </>
        )}
      </main>

      {/* Modal: Create New Parallel Worktree Session */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Play className="w-4 h-4 text-indigo-400" />
                Launch Parallel Worktree Agent
              </h3>
              <button
                onClick={() => setShowNewModal(false)}
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                ESC
              </button>
            </div>

            <form onSubmit={handleCreateSession} className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-400 mb-1">Agent Provider</label>
                  <select
                    value={providerInput}
                    onChange={(e) => setProviderInput(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="claude">Claude Code (stream-json)</option>
                    <option value="codex">OpenAI Codex</option>
                    <option value="opencode">OpenCode</option>
                    <option value="custom">Custom CLI Command</option>
                  </select>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    Git Branch (auto-created)
                  </label>
                  <input
                    type="text"
                    value={branchInput}
                    onChange={(e) => setBranchInput(e.target.value)}
                    placeholder="e.g. feat/jwt-auth"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {providerInput === "custom" && (
                <div>
                  <label className="block text-zinc-400 mb-1">
                    Custom CLI Command
                  </label>
                  <input
                    type="text"
                    value={customCmdInput}
                    onChange={(e) => setCustomCmdInput(e.target.value)}
                    placeholder="e.g. aider --yes-always"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-400 mb-1">Repository Path</label>
                  <input
                    type="text"
                    value={repoPathInput}
                    onChange={(e) => setRepoPathInput(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 mb-1">
                    Session Name (optional)
                  </label>
                  <input
                    type="text"
                    value={sessionNameInput}
                    onChange={(e) => setSessionNameInput(e.target.value)}
                    placeholder="e.g. auth-refactor"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">Task Prompt</label>
                <textarea
                  rows={4}
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value)}
                  placeholder="Describe the feature, bugfix, or refactor to execute inside this isolated Git worktree..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <label className="flex items-center gap-2 text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={usePtyInput}
                  onChange={(e) => setUsePtyInput(e.target.checked)}
                  className="rounded border-zinc-700"
                />
                <span>
                  Spawn inside interactive pseudo-terminal (<code>portable-pty</code>)
                </span>
              </label>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer"
                >
                  {submitting ? "Provisioning Worktree..." : "Launch Agent"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Cross-Agent Handoff */}
      {showHandoffModal && activeSession && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <ArrowRightLeft className="w-4 h-4 text-indigo-400" />
                Handoff Worktree to Another Agent
              </h3>
              <button
                onClick={() => setShowHandoffModal(false)}
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                ESC
              </button>
            </div>

            <form onSubmit={handleHandoff} className="p-5 space-y-4 text-xs">
              <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-[11px] text-zinc-400 space-y-1">
                <div>Source: {activeSession.name}</div>
                <div>Branch: {activeSession.branch}</div>
                <div>Worktree: {activeSession.worktree_path}</div>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">Target Agent</label>
                <select
                  value={handoffTarget}
                  onChange={(e) => setHandoffTarget(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
                >
                  <option value="codex">OpenAI Codex</option>
                  <option value="claude">Claude Code</option>
                  <option value="opencode">OpenCode</option>
                </select>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">
                  Handoff Instructions
                </label>
                <textarea
                  rows={3}
                  value={handoffInstructions}
                  onChange={(e) => setHandoffInstructions(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-zinc-100"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowHandoffModal(false)}
                  className="px-3.5 py-2 rounded-lg bg-zinc-800 text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer"
                >
                  {submitting ? "Handing Off..." : "Execute Handoff"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: SessionStatus }) {
  switch (status) {
    case "running":
    case "starting":
      return (
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
      );
    case "waiting_for_permission":
      return <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />;
    case "completed":
      return <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />;
    case "failed":
      return <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />;
    default:
      return <span className="w-2 h-2 rounded-full bg-zinc-500 shrink-0" />;
  }
}

function StatusBadge({ status }: { status: SessionStatus }) {
  const styles: Record<SessionStatus, string> = {
    starting: "bg-emerald-950/60 text-emerald-300 border-emerald-800/60",
    running: "bg-emerald-950/60 text-emerald-300 border-emerald-800/60",
    waiting_for_permission: "bg-amber-950/60 text-amber-300 border-amber-800/60",
    completed: "bg-sky-950/60 text-sky-300 border-sky-800/60",
    failed: "bg-rose-950/60 text-rose-300 border-rose-800/60",
    stopped: "bg-zinc-800 text-zinc-400 border-zinc-700",
  };
  return (
    <span
      className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded border ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: string | number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-2.5 text-xs font-medium flex items-center gap-2 border-b-2 transition cursor-pointer ${
        active
          ? "border-indigo-500 text-indigo-300"
          : "border-transparent text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {icon}
      <span>{label}</span>
      {badge !== undefined && (
        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400">
          {badge}
        </span>
      )}
    </button>
  );
}

function EventCard({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "thinking_delta":
      return (
        <div className="p-3 rounded-lg bg-zinc-900/40 border border-zinc-800/70 text-xs text-zinc-400 flex items-start gap-2.5">
          <Brain className="w-4 h-4 text-amber-400/80 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-mono uppercase text-amber-400/80 mb-0.5">
              Reasoning Trace
            </div>
            <p className="whitespace-pre-wrap leading-relaxed">{event.text}</p>
          </div>
        </div>
      );

    case "message_delta":
      return (
        <div className="p-3.5 rounded-lg bg-zinc-900/80 border border-zinc-800 text-xs text-zinc-100 whitespace-pre-wrap leading-relaxed">
          {event.text}
        </div>
      );

    case "tool_call_requested":
      return (
        <div className="p-3 rounded-lg bg-indigo-950/20 border border-indigo-900/50 text-xs flex items-start gap-2.5">
          <Wrench className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 font-mono">
            <div className="text-[11px] text-indigo-300 font-semibold">
              Tool Call: {event.tool_name}{" "}
              <span className="text-zinc-500 font-normal">({event.tool_id})</span>
            </div>
            <pre className="mt-1 text-[11px] text-zinc-400 overflow-x-auto bg-zinc-950/70 p-2 rounded border border-zinc-800/80">
              {JSON.stringify(event.arguments, null, 2)}
            </pre>
          </div>
        </div>
      );

    case "tool_call_completed":
      return (
        <div
          className={`p-3 rounded-lg border text-xs flex items-start gap-2.5 font-mono ${
            event.is_error
              ? "bg-rose-950/20 border-rose-900/50 text-rose-200"
              : "bg-emerald-950/15 border-emerald-900/40 text-zinc-300"
          }`}
        >
          {event.is_error ? (
            <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-zinc-400 mb-1">
              Tool Output ({event.tool_id})
            </div>
            <pre className="text-[11px] whitespace-pre-wrap max-h-48 overflow-y-auto bg-zinc-950/70 p-2 rounded">
              {event.output}
            </pre>
          </div>
        </div>
      );

    case "status_changed":
      return (
        <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-500 py-1">
          <span className="h-px flex-1 bg-zinc-800/80" />
          <span>
            Status → <strong className="text-zinc-300">{event.status}</strong>{" "}
            {event.message ? `(${event.message})` : ""}
          </span>
          <span className="h-px flex-1 bg-zinc-800/80" />
        </div>
      );

    case "error":
      return (
        <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800 text-xs text-rose-200 font-mono">
          ❗ {event.error}
        </div>
      );

    case "pty_output":
      return (
        <div className="px-3 py-1 rounded bg-black/60 border border-zinc-900 font-mono text-[11px] text-zinc-300 whitespace-pre-wrap">
          {event.line}
        </div>
      );

    default:
      return null;
  }
}
