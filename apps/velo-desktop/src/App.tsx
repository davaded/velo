import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Columns2,
  Command,
  Cpu,
  FileDiff,
  FolderGit2,
  GitBranch,
  Grid2x2,
  Maximize2,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { DiffDrawer } from "./components/DiffDrawer";
import { PairingModal } from "./components/PairingModal";
import { SessionPane, StatusPulse } from "./components/SessionPane";
import { useVeloDaemon } from "./hooks/useVeloDaemon";
import {
  AgentProvider,
  SessionDiffResponse,
  SessionInfo,
  formatProvider,
  providerBadgeColor,
} from "./types/velo";

type LaunchMode = "single" | "committee" | "loop";

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
    advisorSession,
    createCommittee,
    createLoopSession,
  } = useVeloDaemon();

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [paneLayout, setPaneLayout] = useState<1 | 2 | 4>(1);
  const [showDiffDrawer, setShowDiffDrawer] = useState<boolean>(true);
  const [showCommandPalette, setShowCommandPalette] = useState<boolean>(false);
  const [showPairingModal, setShowPairingModal] = useState<boolean>(false);

  // Launch modal state
  const [launchModalMode, setLaunchModalMode] = useState<LaunchMode | null>(
    null
  );
  const [providerInput, setProviderInput] = useState<string>("claude");
  const [customCmdInput, setCustomCmdInput] = useState<string>("");
  const [committeeChecks, setCommitteeChecks] = useState<Record<string, boolean>>({
    claude: true,
    codex: true,
    opencode: false,
  });
  const [repoPathInput, setRepoPathInput] = useState<string>(
    "/Users/daiyudai/code/velo"
  );
  const [branchInput, setBranchInput] = useState<string>("");
  const [sessionNameInput, setSessionNameInput] = useState<string>("");
  const [promptInput, setPromptInput] = useState<string>("");
  const [checkCommandInput, setCheckCommandInput] =
    useState<string>("cargo test --offline");
  const [maxIterationsInput, setMaxIterationsInput] = useState<number>(3);
  const [usePtyInput, setUsePtyInput] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Handoff modal state
  const [handoffTargetSession, setHandoffTargetSession] =
    useState<SessionInfo | null>(null);
  const [handoffProvider, setHandoffProvider] = useState<string>("codex");
  const [handoffInstructions, setHandoffInstructions] = useState<string>(
    "Review the changes made so far in this worktree, complete the implementation, and verify tests."
  );

  // Diff drawer data for focused session
  const [diffData, setDiffData] = useState<SessionDiffResponse | null>(null);
  const [loadingDiff, setLoadingDiff] = useState<boolean>(false);

  // Auto-select first session
  useEffect(() => {
    if (!focusedId && sessions.length > 0) {
      setFocusedId(sessions[0].id);
    }
  }, [sessions, focusedId]);

  const focusedSession = useMemo(
    () => sessions.find((s) => s.id === focusedId) || sessions[0] || null,
    [sessions, focusedId]
  );

  // Determine which sessions are visible in the Multi-Pane Canvas (1x / 2x / 4x)
  const visibleSessions = useMemo<SessionInfo[]>(() => {
    if (sessions.length === 0) return [];
    if (paneLayout === 1) {
      return focusedSession ? [focusedSession] : [sessions[0]];
    }
    const list: SessionInfo[] = [];
    if (focusedSession) list.push(focusedSession);
    for (const s of sessions) {
      if (list.length >= paneLayout) break;
      if (!list.some((x) => x.id === s.id)) {
        list.push(s);
      }
    }
    return list;
  }, [sessions, focusedSession, paneLayout]);

  // Fetch events for all visible panes
  useEffect(() => {
    for (const s of visibleSessions) {
      fetchSessionEvents(s.id);
    }
  }, [visibleSessions, fetchSessionEvents]);

  // Fetch diff for focused session
  useEffect(() => {
    if (focusedSession && showDiffDrawer) {
      setLoadingDiff(true);
      fetchSessionDiff(focusedSession.id).then((res) => {
        setDiffData(res);
        setLoadingDiff(false);
      });
    }
  }, [
    focusedSession?.id,
    focusedSession?.diff_stats.files_changed,
    focusedSession?.diff_stats.insertions,
    showDiffDrawer,
    fetchSessionDiff,
  ]);

  // Group sessions by repository name for Left Explorer Tree
  const sessionsByRepo = useMemo(() => {
    const groups: Record<string, SessionInfo[]> = {};
    for (const s of sessions) {
      const repoName = s.repo_root.split("/").filter(Boolean).pop() || s.repo_root;
      if (!groups[repoName]) groups[repoName] = [];
      groups[repoName].push(s);
    }
    return groups;
  }, [sessions]);

  // Global keyboard shortcuts (⌘K, ⌘N, ⌘D, ⌘1, ⌘2, ⌘4)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "k") {
          e.preventDefault();
          setShowCommandPalette((v) => !v);
        } else if (e.key.toLowerCase() === "n") {
          e.preventDefault();
          setLaunchModalMode("single");
        } else if (e.key.toLowerCase() === "d") {
          e.preventDefault();
          setShowDiffDrawer((v) => !v);
        } else if (e.key === "1") {
          e.preventDefault();
          setPaneLayout(1);
        } else if (e.key === "2") {
          e.preventDefault();
          setPaneLayout(2);
        } else if (e.key === "4") {
          e.preventDefault();
          setPaneLayout(4);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleLaunchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!launchModalMode) return;
    setSubmitting(true);
    setErrorBanner(null);

    try {
      const provider: AgentProvider =
        providerInput === "custom"
          ? { custom: customCmdInput.trim() || "sh" }
          : (providerInput as AgentProvider);

      if (launchModalMode === "single") {
        const created = await createSession({
          name: sessionNameInput.trim() || undefined,
          provider,
          prompt: promptInput,
          repo_path: repoPathInput.trim() || "/Users/daiyudai/code/velo",
          branch: branchInput.trim() || undefined,
          use_pty: usePtyInput,
        });
        setFocusedId(created.id);
      } else if (launchModalMode === "committee") {
        const selectedProviders = (
          Object.keys(committeeChecks) as Array<"claude" | "codex" | "opencode">
        ).filter((k) => committeeChecks[k]);
        const spawned = await createCommittee(
          selectedProviders,
          promptInput,
          repoPathInput.trim() || "/Users/daiyudai/code/velo",
          sessionNameInput.trim() || undefined
        );
        if (spawned.length > 0) {
          setFocusedId(spawned[0].id);
          setPaneLayout(spawned.length >= 3 ? 4 : 2);
        }
      } else if (launchModalMode === "loop") {
        const created = await createLoopSession({
          name: sessionNameInput.trim() || undefined,
          provider,
          prompt: promptInput,
          check_command: checkCommandInput.trim() || "cargo test",
          max_iterations: maxIterationsInput,
          repo_path: repoPathInput.trim() || "/Users/daiyudai/code/velo",
          branch: branchInput.trim() || undefined,
        });
        setFocusedId(created.id);
      }

      setLaunchModalMode(null);
      setPromptInput("");
      setBranchInput("");
      setSessionNameInput("");
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleQuickAdvisor(session: SessionInfo) {
    setErrorBanner(null);
    const defaultAdvisor: AgentProvider =
      session.provider === "claude" ? "codex" : "claude";
    try {
      const created = await advisorSession(session.id, defaultAdvisor);
      setFocusedId(created.id);
      if (paneLayout === 1) setPaneLayout(2);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleExecuteHandoff(e: React.FormEvent) {
    e.preventDefault();
    if (!handoffTargetSession) return;
    setSubmitting(true);
    setErrorBanner(null);
    try {
      const next = await handoffSession(
        handoffTargetSession.id,
        handoffProvider as AgentProvider,
        handoffInstructions
      );
      setFocusedId(next.id);
      setHandoffTargetSession(null);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshDiff() {
    if (!focusedSession) return;
    setLoadingDiff(true);
    const d = await fetchSessionDiff(focusedSession.id);
    setDiffData(d);
    setLoadingDiff(false);
  }

  const runningCount = sessions.filter((s) => s.status === "running").length;

  return (
    <div className="flex flex-col h-screen w-screen bg-[#09090b] text-zinc-100 overflow-hidden select-none">
      {/* Top Global IDE Bar */}
      <header className="h-12 px-4 border-b border-zinc-800/80 bg-zinc-950/90 flex items-center justify-between gap-4 shrink-0">
        {/* Left: Brand & Daemon Status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-sm">
              <Zap className="w-4 h-4 fill-current" />
            </div>
            <span className="font-bold tracking-tight text-sm text-zinc-100">
              VELO
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
              v0.1 · Rust Control Plane
            </span>
          </div>

          <div className="h-4 w-px bg-zinc-800" />

          {/* Command Palette Trigger */}
          <button
            onClick={() => setShowCommandPalette(true)}
            className="px-2.5 py-1 rounded-lg bg-zinc-900/90 hover:bg-zinc-800/90 border border-zinc-800 text-xs text-zinc-400 flex items-center gap-3 transition cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Search className="w-3.5 h-3.5 text-zinc-500" />
              <span>Search or run command...</span>
            </span>
            <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-950 text-zinc-400 border border-zinc-800">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Center: Multi-Pane Layout Switcher (1x / 2x / 4x) */}
        <div className="flex items-center gap-1 bg-zinc-900/80 p-1 rounded-lg border border-zinc-800/90">
          <button
            onClick={() => setPaneLayout(1)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
              paneLayout === 1
                ? "bg-zinc-800 text-zinc-100 shadow-2xs"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Single Focus (⌘1)"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>1x Focus</span>
          </button>
          <button
            onClick={() => setPaneLayout(2)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
              paneLayout === 2
                ? "bg-zinc-800 text-zinc-100 shadow-2xs"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Side-by-Side Split (⌘2)"
          >
            <Columns2 className="w-3.5 h-3.5" />
            <span>2x Split</span>
          </button>
          <button
            onClick={() => setPaneLayout(4)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
              paneLayout === 4
                ? "bg-zinc-800 text-zinc-100 shadow-2xs"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="2x2 Fleet Grid (⌘4)"
          >
            <Grid2x2 className="w-3.5 h-3.5" />
            <span>4x Grid</span>
          </button>
        </div>

        {/* Right: Quick Orchestration Actions & Diff Toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLaunchModalMode("committee")}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition cursor-pointer"
            title="Dispatch Multi-Agent Committee in parallel worktrees"
          >
            <Users className="w-3.5 h-3.5 text-amber-400" />
            <span>Committee</span>
          </button>

          <button
            onClick={() => setLaunchModalMode("loop")}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition cursor-pointer"
            title="Start Test-Driven Self-Healing Loop"
          >
            <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
            <span>Loop</span>
          </button>

          <button
            onClick={() => setShowPairingModal(true)}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition cursor-pointer"
            title="Mobile & Remote E2EE Pairing QR"
          >
            <QrCode className="w-3.5 h-3.5 text-indigo-400" />
            <span>Pair</span>
          </button>

          <button
            onClick={() => setShowDiffDrawer((v) => !v)}
            className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
              showDiffDrawer
                ? "bg-indigo-600/20 border-indigo-500/40 text-indigo-200"
                : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
            title="Toggle Git Worktree Diff Inspector (⌘D)"
          >
            <FileDiff className="w-3.5 h-3.5" />
            <span>Diff Drawer</span>
          </button>
        </div>
      </header>

      {/* Error Toast */}
      {errorBanner && (
        <div className="bg-rose-950/90 border-b border-rose-800 px-4 py-2 text-xs text-rose-200 flex items-center justify-between shrink-0">
          <span>{errorBanner}</span>
          <button
            onClick={() => setErrorBanner(null)}
            className="text-rose-300 hover:text-white font-mono cursor-pointer"
          >
            DISMISS
          </button>
        </div>
      )}

      {/* Main 3-Column IDE Body */}
      <div className="flex-1 flex min-h-0 min-w-0">
        {/* Column 1: Project & Worktree Tree Explorer */}
        <aside className="w-72 shrink-0 border-r border-zinc-800/80 bg-zinc-950/60 flex flex-col">
          {/* Primary Launch Button */}
          <div className="p-3 border-b border-zinc-800/60">
            <button
              onClick={() => setLaunchModalMode("single")}
              className="w-full py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-medium text-xs flex items-center justify-between shadow-sm transition cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <Plus className="w-4 h-4" />
                <span>New Worktree Agent</span>
              </span>
              <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-700/80 text-indigo-100">
                ⌘N
              </kbd>
            </button>
          </div>

          {/* Repository -> Worktree Tree */}
          <div className="flex-1 overflow-y-auto p-2 space-y-4">
            {Object.keys(sessionsByRepo).length === 0 ? (
              <div className="p-6 text-center text-zinc-500 text-xs space-y-2">
                <Cpu className="w-7 h-7 mx-auto text-zinc-700" />
                <p className="font-medium text-zinc-400">No Active Worktrees</p>
                <p className="text-[11px] text-zinc-600">
                  Press <kbd className="text-zinc-400">⌘N</kbd> to spin up an
                  isolated Git worktree agent.
                </p>
              </div>
            ) : (
              Object.entries(sessionsByRepo).map(([repoName, repoSessions]) => (
                <div key={repoName} className="space-y-1">
                  <div className="px-2 py-1 flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-zinc-500">
                    <span className="flex items-center gap-1.5 truncate">
                      <FolderGit2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      <span className="font-semibold text-zinc-300">
                        {repoName}
                      </span>
                    </span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-900 text-zinc-500">
                      {repoSessions.length}
                    </span>
                  </div>

                  <div className="space-y-1">
                    {repoSessions.map((s) => {
                      const isFocused = s.id === focusedSession?.id;
                      const isInSplit = visibleSessions.some(
                        (v) => v.id === s.id
                      );
                      return (
                        <button
                          key={s.id}
                          onClick={() => setFocusedId(s.id)}
                          className={`w-full text-left px-2.5 py-2.5 rounded-xl border transition flex flex-col gap-1.5 cursor-pointer ${
                            isFocused
                              ? "bg-indigo-950/35 border-indigo-500/45 shadow-2xs"
                              : isInSplit
                              ? "bg-zinc-900/70 border-zinc-800"
                              : "bg-transparent border-transparent hover:bg-zinc-900/50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <StatusPulse status={s.status} />
                              <span className="font-medium text-xs text-zinc-100 truncate">
                                {s.name}
                              </span>
                            </div>
                            <span
                              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${providerBadgeColor(
                                s.provider
                              )}`}
                            >
                              {formatProvider(s.provider)}
                            </span>
                          </div>

                          <div className="text-[11px] text-zinc-400 truncate pl-4">
                            {s.prompt || "(Interactive PTY)"}
                          </div>

                          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 pl-4 pt-0.5">
                            <span className="flex items-center gap-1 truncate max-w-[125px] text-zinc-400">
                              <GitBranch className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                              {s.branch}
                            </span>
                            <span className="flex items-center gap-1.5">
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
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Left Column Bottom Telemetry Bar */}
          <div className="h-9 px-3 border-t border-zinc-800/80 bg-zinc-950 flex items-center justify-between text-[11px] font-mono text-zinc-500">
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  connected
                    ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                    : "bg-rose-500"
                }`}
              />
              <span>{connected ? "DAEMON READY" : "OFFLINE"}</span>
            </div>
            <span>
              {runningCount} running / {sessions.length} total
            </span>
          </div>
        </aside>

        {/* Column 2: Multi-Pane Agent Canvas (1x / 2x / 4x) */}
        <main className="flex-1 min-w-0 min-h-0 bg-[#0c0c0f] p-3 flex flex-col">
          {visibleSessions.length === 0 ? (
            <div className="flex-1 rounded-2xl border border-dashed border-zinc-800/80 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-4">
                <Sparkles className="w-6 h-6" />
              </div>
              <h2 className="text-base font-semibold text-zinc-100">
                Velo Parallel Agent Control Plane
              </h2>
              <p className="text-xs text-zinc-400 max-w-md mt-1.5 leading-relaxed">
                Orchestrate Claude Code, OpenAI Codex, and OpenCode side-by-side
                in isolated Git worktrees with real-time diff inspection and
                cross-agent handoffs.
              </p>
              <div className="flex items-center gap-3 mt-5">
                <button
                  onClick={() => setLaunchModalMode("single")}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  Launch Worktree Agent
                </button>
                <button
                  onClick={() => setLaunchModalMode("committee")}
                  className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 text-xs font-medium flex items-center gap-2 cursor-pointer"
                >
                  <Users className="w-4 h-4 text-amber-400" />
                  Dispatch Committee
                </button>
              </div>
            </div>
          ) : (
            <div
              className={`flex-1 min-h-0 grid gap-3 ${
                visibleSessions.length === 1
                  ? "grid-cols-1 grid-rows-1"
                  : visibleSessions.length === 2
                  ? "grid-cols-1 lg:grid-cols-2 grid-rows-1"
                  : "grid-cols-1 lg:grid-cols-2 grid-rows-2"
              }`}
            >
              {visibleSessions.map((session) => (
                <SessionPane
                  key={session.id}
                  session={session}
                  events={eventsBySession[session.id] || []}
                  isFocused={session.id === focusedSession?.id}
                  compact={visibleSessions.length >= 4}
                  onFocus={() => setFocusedId(session.id)}
                  onOpenDiff={() => setShowDiffDrawer(true)}
                  onHandoff={(s) => setHandoffTargetSession(s)}
                  onAdvisor={handleQuickAdvisor}
                  onStop={stopSession}
                  onSendInput={sendInput}
                />
              ))}
            </div>
          )}
        </main>

        {/* Column 3: Collapsible Git Diff & File Tree Inspector Drawer */}
        {showDiffDrawer && focusedSession && (
          <DiffDrawer
            session={focusedSession}
            diffData={diffData}
            loading={loadingDiff}
            onRefresh={refreshDiff}
            onClose={() => setShowDiffDrawer(false)}
          />
        )}
      </div>

      {/* Unified Launch Modal (Single Agent / Multi-Agent Committee / Self-Healing Loop) */}
      {launchModalMode && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden">
            {/* Mode Switcher Header */}
            <div className="px-5 pt-4 pb-3 border-b border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
                <button
                  type="button"
                  onClick={() => setLaunchModalMode("single")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                    launchModalMode === "single"
                      ? "bg-indigo-600 text-white"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Single Agent</span>
                </button>
                <button
                  type="button"
                  onClick={() => setLaunchModalMode("committee")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                    launchModalMode === "committee"
                      ? "bg-indigo-600 text-white"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>Committee</span>
                </button>
                <button
                  type="button"
                  onClick={() => setLaunchModalMode("loop")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                    launchModalMode === "loop"
                      ? "bg-indigo-600 text-white"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Test Loop</span>
                </button>
              </div>

              <button
                onClick={() => setLaunchModalMode(null)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleLaunchSubmit} className="p-5 space-y-4 text-xs">
              {launchModalMode === "committee" ? (
                <div>
                  <label className="block text-zinc-400 mb-2">
                    Select Committee Agents (each runs in its own isolated Git worktree)
                  </label>
                  <div className="grid grid-cols-3 gap-2.5">
                    {(["claude", "codex", "opencode"] as const).map((ag) => (
                      <label
                        key={ag}
                        className={`p-3 rounded-xl border flex items-center gap-2 cursor-pointer transition ${
                          committeeChecks[ag]
                            ? "bg-indigo-950/40 border-indigo-500/50 text-zinc-100"
                            : "bg-zinc-950 border-zinc-800 text-zinc-400"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={committeeChecks[ag]}
                          onChange={(e) =>
                            setCommitteeChecks((prev) => ({
                              ...prev,
                              [ag]: e.target.checked,
                            }))
                          }
                        />
                        <span className="font-mono uppercase">{ag}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      Agent Provider
                    </label>
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
                      Git Branch (isolated worktree)
                    </label>
                    <input
                      type="text"
                      value={branchInput}
                      onChange={(e) => setBranchInput(e.target.value)}
                      placeholder="e.g. feat/auth-middleware"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 font-mono focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              )}

              {providerInput === "custom" && launchModalMode !== "committee" && (
                <div>
                  <label className="block text-zinc-400 mb-1">
                    Custom CLI Command
                  </label>
                  <input
                    type="text"
                    value={customCmdInput}
                    onChange={(e) => setCustomCmdInput(e.target.value)}
                    placeholder="e.g. /tmp/velo_demo_agent.sh #"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              )}

              {launchModalMode === "loop" && (
                <div className="grid grid-cols-3 gap-3 p-3 rounded-xl bg-emerald-950/15 border border-emerald-500/25">
                  <div className="col-span-2">
                    <label className="block text-emerald-300 mb-1">
                      Acceptance Check Command
                    </label>
                    <input
                      type="text"
                      value={checkCommandInput}
                      onChange={(e) => setCheckCommandInput(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-100 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-emerald-300 mb-1">
                      Max Iterations
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={maxIterationsInput}
                      onChange={(e) =>
                        setMaxIterationsInput(Number(e.target.value))
                      }
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-100 font-mono"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-400 mb-1">
                    Repository Root
                  </label>
                  <input
                    type="text"
                    value={repoPathInput}
                    onChange={(e) => setRepoPathInput(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 mb-1">
                    Session / Group Name
                  </label>
                  <input
                    type="text"
                    value={sessionNameInput}
                    onChange={(e) => setSessionNameInput(e.target.value)}
                    placeholder="Optional label"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">
                  Task Instructions / Prompt
                </label>
                <textarea
                  rows={4}
                  required={!usePtyInput}
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value)}
                  placeholder="Describe what the agent(s) should build, fix, or analyze inside the isolated Git worktree..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {launchModalMode === "single" && (
                <label className="flex items-center gap-2 text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={usePtyInput}
                    onChange={(e) => setUsePtyInput(e.target.checked)}
                  />
                  <span>
                    Run in interactive pseudo-terminal (<code>portable-pty</code>)
                  </span>
                </label>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setLaunchModalMode(null)}
                  className="px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer"
                >
                  {submitting
                    ? "Provisioning Worktree..."
                    : launchModalMode === "committee"
                    ? "Dispatch Committee"
                    : launchModalMode === "loop"
                    ? "Start Self-Healing Loop"
                    : "Launch Worktree Agent"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cross-Agent Handoff Modal */}
      {handoffTargetSession && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <ArrowRightLeft className="w-4 h-4 text-indigo-400" />
                Handoff Worktree to Peer Agent
              </h3>
              <button
                onClick={() => setHandoffTargetSession(null)}
                className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleExecuteHandoff} className="p-5 space-y-4 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-[11px] text-zinc-400 space-y-1">
                <div>From Session: {handoffTargetSession.name}</div>
                <div>Shared Branch: {handoffTargetSession.branch}</div>
                <div>Worktree: {handoffTargetSession.worktree_path}</div>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">Target Agent</label>
                <select
                  value={handoffProvider}
                  onChange={(e) => setHandoffProvider(e.target.value)}
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
                  onClick={() => setHandoffTargetSession(null)}
                  className="px-3.5 py-2 rounded-xl bg-zinc-800 text-zinc-300 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer"
                >
                  {submitting ? "Handing Off..." : "Execute Handoff"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Global Command Palette (⌘K) */}
      {showCommandPalette && (
        <CommandPalette
          sessions={sessions}
          onClose={() => setShowCommandPalette(false)}
          onSelectSession={(id) => setFocusedId(id)}
          onOpenLaunchModal={(mode) => setLaunchModalMode(mode)}
          onSetLayout={(l) => setPaneLayout(l)}
          onToggleDiffDrawer={() => setShowDiffDrawer((v) => !v)}
          onOpenPairing={() => setShowPairingModal(true)}
        />
      )}

      {/* Mobile & Remote E2EE Pairing QR Modal */}
      {showPairingModal && (
        <PairingModal
          daemonUrl="http://127.0.0.1:6767"
          onClose={() => setShowPairingModal(false)}
        />
      )}
    </div>
  );
}
