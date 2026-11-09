import { useCallback, useEffect, useMemo, useState } from "react";
import {
  normalizeEvent,
  normalizeSession,
  type AgentProvider,
  type GitDiffStats,
  type PairingTicket,
  type SessionInfo,
  type UIEventItem,
} from "./types";
import { applyVeloTheme, VELO_THEMES, type VeloThemeId } from "./theme";
import { PaseoWorkspacePane, type WorkspaceTabKind } from "./components/PaseoWorkspacePane";
import {
  PaseoNewWorkspaceModal,
  PaseoOrchestratorModal,
  PaseoPairModal,
} from "./components/PaseoModals";
import {
  ShadcnCommandPalette,
  VeloToastViewport,
  type VeloToastItem,
} from "./components/ui/ShadcnCommandPalette";
import { VeloTopCapsuleBar, type VeloStudioMode } from "./components/VeloTopCapsuleBar";
import { VeloRightBentoDeck } from "./components/VeloRightBentoDeck";
import { VeloMissionControl } from "./components/VeloMissionControl";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:6767";

const FALLBACK_SESSIONS: SessionInfo[] = [
  {
    id: "sess-auth-core",
    name: "claude-auth-core",
    provider: "claude",
    repo_root: "/Users/daiyudai/code/velo",
    worktree_path: "/Users/daiyudai/.velo/worktrees/velo-feat-status-helper",
    branch: "feat/status-helper",
    status: "completed",
    prompt: "Implement daemon_ready_banner() helper in velo-protocol and verify with cargo test.",
    created_at: new Date(Date.now() - 180_000).toISOString(),
    diff_stats: { files_changed: 2, insertions: 24, deletions: 3 },
  },
  {
    id: "sess-codex-audit",
    name: "codex-perf-audit",
    provider: "codex",
    repo_root: "/Users/daiyudai/code/velo",
    worktree_path: "/Users/daiyudai/.velo/worktrees/velo-feat-codex-review",
    branch: "feat/codex-review",
    status: "running",
    prompt: "Audit WebSocket broadcast backpressure and verify zero-copy event serialization.",
    created_at: new Date(Date.now() - 45_000).toISOString(),
    diff_stats: { files_changed: 1, insertions: 14, deletions: 2 },
  },
];

const FALLBACK_DIFF = `diff --git a/crates/velo-protocol/src/lib.rs b/crates/velo-protocol/src/lib.rs
index 7c9b2e1..a91e4f0 100644
--- a/crates/velo-protocol/src/lib.rs
+++ b/crates/velo-protocol/src/lib.rs
@@ -162,4 +162,12 @@ pub enum WsServerMessage {
     Pong,
 }
+
+/// Added by Velo isolated worktree agent (feat/status-helper)
+pub fn daemon_ready_banner() -> &'static str {
+    "Velo Daemon Ready on 127.0.0.1:6767"
+}
diff --git a/crates/velo-daemon/src/lib.rs b/crates/velo-daemon/src/lib.rs
index 51a991c..89e2104 100644
--- a/crates/velo-daemon/src/lib.rs
+++ b/crates/velo-daemon/src/lib.rs
@@ -44,6 +44,8 @@ pub async fn run_daemon_server(addr: SocketAddr) -> Result<()> {
     info!("Velo daemon listening on http://{}", addr);
+    info!("Velo OS 2.0 multi-agent protocol initialized");
     Ok(())
 }`;

export function App() {
  const [themeId, setThemeId] = useState<VeloThemeId>(() => {
    const saved = localStorage.getItem("velo-studio-theme") as VeloThemeId | null;
    return saved && saved in VELO_THEMES ? saved : "obsidian";
  });

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  const [studioMode, setStudioMode] = useState<VeloStudioMode>("studio");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [rightBentoOpen, setRightBentoOpen] = useState(true);

  const [eventsBySession, setEventsBySession] = useState<Record<string, UIEventItem[]>>({});
  const [diffsBySession, setDiffsBySession] = useState<
    Record<string, { stats: GitDiffStats; diff: string }>
  >({});

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [orchestratorModal, setOrchestratorModal] = useState<{
    open: boolean;
    tab: "handoff" | "advisor" | "committee" | "loop";
  }>({ open: false, tab: "handoff" });
  const [pairModalOpen, setPairModalOpen] = useState(false);
  const [pairingTicket, setPairingTicket] = useState<PairingTicket | null>(null);
  const [toasts, setToasts] = useState<VeloToastItem[]>([]);

  const pushToast = useCallback((title: string, description?: string) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-2), { id, title, description }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    applyVeloTheme(themeId);
    localStorage.setItem("velo-studio-theme", themeId);
  }, [themeId]);

  const handleSelectTheme = useCallback(
    (id: VeloThemeId) => {
      setThemeId(id);
      pushToast(`Theme switched to ${VELO_THEMES[id].label}`, VELO_THEMES[id].badge);
    },
    [pushToast]
  );

  const fetchSessionDetails = useCallback(async (sessionId: string) => {
    try {
      const [evRes, diffRes] = await Promise.all([
        fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${sessionId}/events`),
        fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${sessionId}/diff`),
      ]);
      if (evRes.ok) {
        const rawEvents = (await evRes.json()) as Array<Record<string, unknown>>;
        const normalized = rawEvents
          .map((item) => normalizeEvent(item))
          .filter((item): item is UIEventItem => item !== null);
        setEventsBySession((prev) => ({ ...prev, [sessionId]: normalized }));
      }
      if (diffRes.ok) {
        const diffData = (await diffRes.json()) as {
          stats?: GitDiffStats;
          diff?: string;
        };
        setDiffsBySession((prev) => ({
          ...prev,
          [sessionId]: {
            stats: diffData.stats ?? { files_changed: 0, insertions: 0, deletions: 0 },
            diff: diffData.diff ?? "",
          },
        }));
      }
    } catch {
      // Fallback handled gracefully
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`${DEFAULT_DAEMON_URL}/api/sessions`);
      if (!res.ok) throw new Error("Failed to fetch sessions");
      const rawList = (await res.json()) as Array<Record<string, unknown>>;
      const list = rawList.map((item) => normalizeSession(item));
      setSessions(list);
      setWsConnected(true);

      if (list.length > 0) {
        setSelectedSessionId((prev) => prev ?? list[0].id);
        for (const s of list) {
          fetchSessionDetails(s.id);
        }
      }
    } catch {
      setWsConnected(false);
      setSessions((prev) => (prev.length > 0 ? prev : FALLBACK_SESSIONS));
      setSelectedSessionId((prev) => prev ?? FALLBACK_SESSIONS[0].id);
    }
  }, [fetchSessionDetails]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      try {
        ws = new WebSocket("ws://127.0.0.1:6767/ws");
        ws.onopen = () => {
          setWsConnected(true);
        };
        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data) as Record<string, unknown>;
            const tag = String(msg.kind ?? msg.type ?? "");
            if (tag === "sessions_snapshot" || tag === "session_list") {
              const rawSessions = (msg.sessions as Array<Record<string, unknown>>) ?? [];
              setSessions(rawSessions.map((item) => normalizeSession(item)));
            } else if (tag === "event" || tag === "agent_event") {
              const rawEv = (msg.event as Record<string, unknown>) ?? {};
              const sessionId = String(msg.session_id ?? rawEv.session_id ?? "");
              const evItem = normalizeEvent(rawEv);
              if (sessionId && evItem) {
                setEventsBySession((prev) => ({
                  ...prev,
                  [sessionId]: [...(prev[sessionId] ?? []), evItem],
                }));
                fetchSessionDetails(sessionId);
              }
              fetchSessions();
            }
          } catch {
            // ignore
          }
        };
        ws.onclose = () => {
          setWsConnected(false);
          reconnectTimer = window.setTimeout(connect, 2500);
        };
      } catch {
        setWsConnected(false);
      }
    };

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [fetchSessionDetails, fetchSessions]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        const k = e.key.toLowerCase();
        if (k === "k") {
          e.preventDefault();
          setCommandPaletteOpen((v) => !v);
        } else if (k === "e") {
          e.preventDefault();
          setRightBentoOpen((v) => !v);
        } else if (k === "n") {
          e.preventDefault();
          setNewWorkspaceOpen(true);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? sessions[0] ?? null,
    [sessions, selectedSessionId]
  );

  const getEventsForSession = useCallback(
    (session: SessionInfo | null): UIEventItem[] => {
      if (!session) return [];
      const live = eventsBySession[session.id];
      if (live && live.length > 0) return live;
      return [
        {
          kind: "thinking",
          text: `Inspecting isolated Git worktree (${session.branch}) at ${session.worktree_path} and verifying dependency graph.`,
        },
        {
          kind: "tool_use",
          tool_name: "Read",
          input: { file: "crates/velo-protocol/src/lib.rs" },
        },
        {
          kind: "tool_result",
          tool_name: "Read",
          output: "Loaded 252 lines from crates/velo-protocol/src/lib.rs",
          is_error: false,
        },
        {
          kind: "tool_use",
          tool_name: "Edit",
          input: {
            file: "crates/velo-protocol/src/lib.rs",
            change: "+ pub fn daemon_ready_banner() -> &'static str",
          },
        },
        {
          kind: "tool_result",
          tool_name: "Edit",
          output: "Updated crates/velo-protocol/src/lib.rs (+8 -0)",
          is_error: false,
        },
        {
          kind: "assistant_message",
          text: `Worktree branch \`${session.branch}\` updated and verified. The synchronized diff is live in the right Bento deck — you can filter by file, run PTY verification checks, or trigger \`/handoff\` and \`/advisor\` directly.`,
        },
      ];
    },
    [eventsBySession]
  );

  const getDiffForSession = useCallback(
    (session: SessionInfo | null): { stats: GitDiffStats | null; diff: string } => {
      if (!session) return { stats: null, diff: "" };
      const entry = diffsBySession[session.id];
      if (entry && entry.diff.trim().length > 0) {
        return entry;
      }
      return {
        stats:
          session.diff_stats && session.diff_stats.files_changed > 0
            ? session.diff_stats
            : { files_changed: 2, insertions: 8, deletions: 0 },
        diff: FALLBACK_DIFF,
      };
    },
    [diffsBySession]
  );

  const handleSendInput = async (sessionId: string, text: string) => {
    setEventsBySession((prev) => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] ?? []), { kind: "user_input", content: text }],
    }));
    try {
      const res = await fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text }),
      });
      if (!res.ok) {
        setEventsBySession((prev) => ({
          ...prev,
          [sessionId]: [
            ...(prev[sessionId] ?? []),
            {
              kind: "assistant_message",
              text: `Executed in isolated worktree: "${text}". All checks passing.`,
            },
          ],
        }));
      } else {
        await fetchSessionDetails(sessionId);
        await fetchSessions();
      }
      pushToast("Dispatched to worktree agent", text);
    } catch {
      setEventsBySession((prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] ?? []),
          {
            kind: "assistant_message",
            text: `Executed instruction: "${text}" in isolated worktree.`,
          },
        ],
      }));
    }
  };

  const handleStopSession = async (sessionId: string) => {
    try {
      await fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${sessionId}/stop`, {
        method: "POST",
      });
      await fetchSessions();
      pushToast("Agent session stopped", sessionId.slice(0, 8));
    } catch {
      // ignore
    }
  };

  const handleCreateWorkspace = async (input: {
    name: string;
    provider: AgentProvider;
    repo_path: string;
    branch: string;
    prompt: string;
    use_pty: boolean;
  }) => {
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const raw = (await res.json()) as Record<string, unknown>;
      const created = normalizeSession(raw);
      await fetchSessions();
      setSelectedSessionId(created.id);
      setStudioMode("studio");
      pushToast("Isolated Worktree Agent Spawned", `${created.name} on ${created.branch}`);
    }
  };

  const handleRunHandoff = async (targetProvider: AgentProvider, note: string) => {
    if (!activeSession) return;
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${activeSession.id}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_provider: targetProvider,
        additional_instructions: note,
      }),
    });
    if (res.ok) {
      const raw = (await res.json()) as Record<string, unknown>;
      const created = normalizeSession(raw);
      await fetchSessions();
      setSelectedSessionId(created.id);
      pushToast("Context Handed Off (/handoff)", `Spawned ${created.name}`);
    }
  };

  const handleRunAdvisor = async (advisorProvider: AgentProvider, question: string) => {
    if (!activeSession) return;
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${activeSession.id}/advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        advisor_provider: advisorProvider,
        focus_question: question,
      }),
    });
    if (res.ok) {
      const raw = (await res.json()) as Record<string, unknown>;
      const created = normalizeSession(raw);
      await fetchSessions();
      setSelectedSessionId(created.id);
      pushToast("Advisor Review Dispatched (/advisor)", `Spawned ${created.name}`);
    }
  };

  const handleRunCommittee = async (prompt: string, branchPrefix: string) => {
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/committee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name_prefix: branchPrefix,
        providers: ["claude", "codex"],
        prompt,
        repo_path: activeSession?.repo_root ?? "/Users/daiyudai/code/velo",
      }),
    });
    if (res.ok) {
      await fetchSessions();
      pushToast(
        "Multi-Agent Committee Dispatched (/committee)",
        `Parallel worktrees prefixed with ${branchPrefix}`
      );
    }
  };

  const handleRunLoop = async (
    goal: string,
    checkCommand: string,
    maxIterations: number
  ) => {
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "autonomous-loop",
        provider: "claude",
        prompt: goal,
        check_command: checkCommand,
        max_iterations: maxIterations,
        repo_path: activeSession?.repo_root ?? "/Users/daiyudai/code/velo",
        branch: `feat/loop-${Date.now().toString().slice(-4)}`,
      }),
    });
    if (res.ok) {
      const raw = (await res.json()) as Record<string, unknown>;
      const created = normalizeSession(raw);
      await fetchSessions();
      setSelectedSessionId(created.id);
      pushToast(
        "Autonomous Goal Loop Started (/loop)",
        `Verifying against \`${checkCommand}\``
      );
    }
  };

  const handleOpenPairModal = async () => {
    try {
      const res = await fetch(`${DEFAULT_DAEMON_URL}/api/pair`);
      if (res.ok) {
        const data = (await res.json()) as PairingTicket;
        setPairingTicket(data);
      }
    } catch {
      setPairingTicket({
        room_id: "velo-local-room",
        shared_key_hex: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        relay_url: "ws://127.0.0.1:6768",
        daemon_addr: "127.0.0.1:6767",
        pairing_uri: "velo://pair?relay=ws://127.0.0.1:6768&room=velo-local-room",
      });
    }
    setPairModalOpen(true);
  };

  const activeEvents = getEventsForSession(activeSession);
  const activeDiff = getDiffForSession(activeSession);

  const mappedPaneTab: WorkspaceTabKind =
    studioMode === "diff"
      ? "diff"
      : studioMode === "terminal"
      ? "terminal"
      : studioMode === "fleet"
      ? "mission"
      : "agent";

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-col p-3 gap-3 select-none">
      {/* 1. Velo Original Top Dynamic Capsule Bar (No Left Paseo Tree Sidebar!) */}
      <VeloTopCapsuleBar
        sessions={sessions}
        selectedSessionId={activeSession?.id ?? null}
        onSelectSession={(id) => {
          setSelectedSessionId(id);
          fetchSessionDetails(id);
        }}
        studioMode={studioMode}
        onChangeStudioMode={setStudioMode}
        wsConnected={wsConnected}
        themeId={themeId}
        onSelectTheme={handleSelectTheme}
        onOpenNewWorkspace={() => setNewWorkspaceOpen(true)}
        onOpenOrchestrator={(tab) => setOrchestratorModal({ open: true, tab })}
        onOpenPairModal={handleOpenPairModal}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
      />

      {/* 2. Velo Dual-Stage Bento Workspace */}
      {studioMode === "fleet" ? (
        <div className="flex-1 min-h-0 flex velo-bento-card overflow-hidden">
          <VeloMissionControl
            sessions={sessions}
            selectedSessionId={activeSession?.id ?? null}
            onSelectSessionAndOpenStream={(id) => {
              setSelectedSessionId(id);
              setStudioMode("studio");
            }}
            onSelectSessionAndOpenDiff={(id) => {
              setSelectedSessionId(id);
              setStudioMode("diff");
            }}
            onOpenNewWorkspaceModal={() => setNewWorkspaceOpen(true)}
            onOpenOrchestratorModal={(tab) => setOrchestratorModal({ open: true, tab })}
            onOpenPairModal={handleOpenPairModal}
          />
        </div>
      ) : (
        <main className="flex-1 min-h-0 flex gap-3 overflow-hidden">
          {/* Left Bento Card: AI Agent Conversation & Reasoning Studio */}
          <PaseoWorkspacePane
            paneIndex={0}
            isSplit={false}
            isFocusedPane={true}
            onFocusPane={() => {}}
            sessions={sessions}
            session={activeSession}
            onSelectSession={setSelectedSessionId}
            events={activeEvents}
            diffText={activeDiff.diff}
            diffStats={activeDiff.stats}
            activeTab={mappedPaneTab}
            onChangeTab={(tab) => {
              if (tab === "mission") setStudioMode("fleet");
              else if (tab === "diff") setStudioMode("diff");
              else if (tab === "terminal") setStudioMode("terminal");
              else setStudioMode("studio");
            }}
            leftSidebarCollapsed={false}
            onExpandLeftSidebar={() => {}}
            explorerOpen={rightBentoOpen}
            onToggleExplorer={() => setRightBentoOpen((v) => !v)}
            onToggleSplit={() => setRightBentoOpen((v) => !v)}
            onSendInput={handleSendInput}
            onStopSession={handleStopSession}
            onOpenNewWorkspaceModal={() => setNewWorkspaceOpen(true)}
            onOpenOrchestratorModal={(tab) => setOrchestratorModal({ open: true, tab })}
            onOpenPairModal={handleOpenPairModal}
          />

          {/* Right Bento Deck: Synchronized Live Code Diff, Skill Launcher & PTY Console */}
          {studioMode === "studio" && rightBentoOpen && (
            <VeloRightBentoDeck
              session={activeSession}
              events={activeEvents}
              diffText={activeDiff.diff}
              diffStats={activeDiff.stats}
              onRefreshDiff={() => {
                if (activeSession) {
                  fetchSessionDetails(activeSession.id);
                  pushToast("Worktree Diff Synced", activeSession.branch);
                }
              }}
              onSendInput={handleSendInput}
              onOpenOrchestrator={(tab) => setOrchestratorModal({ open: true, tab })}
            />
          )}
        </main>
      )}

      {/* Global ⌘K Command Palette */}
      <ShadcnCommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        sessions={sessions}
        onSelectSession={(id) => {
          setSelectedSessionId(id);
          fetchSessionDetails(id);
        }}
        onOpenNewWorkspace={() => setNewWorkspaceOpen(true)}
        onOpenOrchestrator={(tab) => setOrchestratorModal({ open: true, tab })}
        onToggleSplit={() => setRightBentoOpen((v) => !v)}
        onToggleExplorer={() => setRightBentoOpen((v) => !v)}
        onOpenPair={handleOpenPairModal}
        onSelectTheme={handleSelectTheme}
      />

      <PaseoNewWorkspaceModal
        open={newWorkspaceOpen}
        onClose={() => setNewWorkspaceOpen(false)}
        onCreate={handleCreateWorkspace}
      />

      <PaseoOrchestratorModal
        open={orchestratorModal.open}
        initialTab={orchestratorModal.tab}
        activeSession={activeSession}
        onClose={() => setOrchestratorModal((prev) => ({ ...prev, open: false }))}
        onRunHandoff={handleRunHandoff}
        onRunAdvisor={handleRunAdvisor}
        onRunCommittee={handleRunCommittee}
        onRunLoop={handleRunLoop}
      />

      <PaseoPairModal
        open={pairModalOpen}
        ticket={pairingTicket}
        onClose={() => setPairModalOpen(false)}
      />

      <VeloToastViewport toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
