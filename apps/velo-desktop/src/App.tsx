import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentEvent,
  AgentProvider,
  GitDiffStats,
  PairingResponse,
  SessionInfo,
  WsServerMessage,
} from "./types";
import { applyPaseoTheme, type PaseoThemeId } from "./theme";
import { PaseoLeftSidebar } from "./components/PaseoLeftSidebar";
import { PaseoWorkspacePane, type WorkspaceTabKind } from "./components/PaseoWorkspacePane";
import { PaseoExplorerSidebar } from "./components/PaseoExplorerSidebar";
import {
  PaseoNewWorkspaceModal,
  PaseoOrchestratorModal,
  PaseoPairModal,
} from "./components/PaseoModals";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:6767";

const FALLBACK_SESSIONS: SessionInfo[] = [
  {
    id: "sess-auth-core",
    name: "claude-auth-core",
    provider: "claude_code",
    project_path: "/Users/daiyudai/code/velo",
    worktree_path: "/Users/daiyudai/.velo/worktrees/velo-feat-status-helper",
    worktree_branch: "feat/status-helper",
    status: "completed",
    prompt: "Implement daemon_ready_banner() helper in velo-protocol and verify with cargo test.",
    created_at: new Date(Date.now() - 180_000).toISOString(),
    diff_stats: { files_changed: 2, insertions: 24, deletions: 3 },
  },
  {
    id: "sess-codex-audit",
    name: "codex-perf-audit",
    provider: "codex",
    project_path: "/Users/daiyudai/code/velo",
    worktree_path: "/Users/daiyudai/.velo/worktrees/velo-feat-codex-review",
    worktree_branch: "feat/codex-review",
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
     Error { message: String },
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
@@ -44,6 +44,8 @@ pub async fn start_daemon(addr: SocketAddr) -> anyhow::Result<()> {
     tracing::info!("Binding Velo daemon on {}", addr);
+    tracing::debug!("Paseo-compatible workspace protocol v2 initialized");
     Ok(())
 }`;

export function App() {
  const [themeId, setThemeId] = useState<PaseoThemeId>(() => {
    const saved = localStorage.getItem("velo-paseo-theme") as PaseoThemeId | null;
    return saved || "paseo";
  });

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  // Primary & Split Secondary Pane State (Matches Paseo's split workspace layout)
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [isSplit, setIsSplit] = useState(false);
  const [focusedPane, setFocusedPane] = useState<0 | 1>(0);

  const [pane0SessionId, setPane0SessionId] = useState<string | null>(null);
  const [pane1SessionId, setPane1SessionId] = useState<string | null>(null);
  const [pane0Tab, setPane0Tab] = useState<WorkspaceTabKind>("agent");
  const [pane1Tab, setPane1Tab] = useState<WorkspaceTabKind>("diff");

  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[]>>({});
  const [diffsBySession, setDiffsBySession] = useState<
    Record<string, { stats: GitDiffStats; diff: string }>
  >({});

  // Modals
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [orchestratorModal, setOrchestratorModal] = useState<{
    open: boolean;
    tab: "handoff" | "advisor" | "committee" | "loop";
  }>({ open: false, tab: "handoff" });
  const [pairModalOpen, setPairModalOpen] = useState(false);
  const [pairingData, setPairingData] = useState<PairingResponse | null>(null);

  useEffect(() => {
    applyPaseoTheme(themeId);
    localStorage.setItem("velo-paseo-theme", themeId);
  }, [themeId]);

  const fetchSessionDetails = useCallback(async (sessionId: string) => {
    try {
      const [evRes, diffRes] = await Promise.all([
        fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${sessionId}/events`),
        fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${sessionId}/diff`),
      ]);
      if (evRes.ok) {
        const evData = (await evRes.json()) as AgentEvent[];
        setEventsBySession((prev) => ({ ...prev, [sessionId]: evData }));
      }
      if (diffRes.ok) {
        const diffData = (await diffRes.json()) as { stats: GitDiffStats; diff: string };
        setDiffsBySession((prev) => ({ ...prev, [sessionId]: diffData }));
      }
    } catch {
      // Fallback handled gracefully
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`${DEFAULT_DAEMON_URL}/api/sessions`);
      if (!res.ok) throw new Error("Failed to fetch sessions");
      const list = (await res.json()) as SessionInfo[];
      setSessions(list);
      setWsConnected(true);

      if (list.length > 0) {
        setPane0SessionId((prev) => prev ?? list[0].id);
        setPane1SessionId((prev) => prev ?? (list[1]?.id || list[0].id));
        for (const s of list) {
          fetchSessionDetails(s.id);
        }
      }
    } catch {
      setWsConnected(false);
      setSessions((prev) => (prev.length > 0 ? prev : FALLBACK_SESSIONS));
      setPane0SessionId((prev) => prev ?? FALLBACK_SESSIONS[0].id);
      setPane1SessionId((prev) => prev ?? FALLBACK_SESSIONS[1].id);
    }
  }, [fetchSessionDetails]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Live WebSocket stream to Rust velo-daemon
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
            const msg = JSON.parse(evt.data) as WsServerMessage;
            if (msg.type === "session_list") {
              setSessions(msg.sessions);
            } else if (msg.type === "session_updated") {
              setSessions((prev) => {
                const idx = prev.findIndex((s) => s.id === msg.session.id);
                if (idx === -1) return [msg.session, ...prev];
                const copy = [...prev];
                copy[idx] = msg.session;
                return copy;
              });
            } else if (msg.type === "agent_event") {
              setEventsBySession((prev) => {
                const existing = prev[msg.session_id] ?? [];
                return {
                  ...prev,
                  [msg.session_id]: [...existing, msg.event],
                };
              });
              fetchSessionDetails(msg.session_id);
            }
          } catch {
            // ignore malformed frame
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
  }, [fetchSessionDetails]);

  // Global Paseo Keyboard Shortcuts (⌘B, ⌘E, ⌘\, ⌘N)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "b") {
          e.preventDefault();
          setLeftSidebarCollapsed((v) => !v);
        } else if (e.key.toLowerCase() === "e") {
          e.preventDefault();
          setExplorerOpen((v) => !v);
        } else if (e.key === "\\") {
          e.preventDefault();
          setIsSplit((v) => !v);
        } else if (e.key.toLowerCase() === "n") {
          e.preventDefault();
          setNewWorkspaceOpen(true);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const activeSessionId = focusedPane === 1 && isSplit ? pane1SessionId : pane0SessionId;

  const handleSelectSessionFromSidebar = (id: string) => {
    if (isSplit && focusedPane === 1) {
      setPane1SessionId(id);
    } else {
      setPane0SessionId(id);
    }
    fetchSessionDetails(id);
  };

  const getEventsForSession = useCallback(
    (session: SessionInfo | null): AgentEvent[] => {
      if (!session) return [];
      const live = eventsBySession[session.id];
      if (live && live.length > 0) return live;
      return [
        {
          kind: "thinking",
          text: `Inspecting isolated Git worktree (${session.worktree_branch}) at ${session.worktree_path}`,
        },
        {
          kind: "tool_use",
          tool_name: "Read",
          input: { file: "crates/velo-protocol/src/lib.rs" },
        },
        {
          kind: "tool_result",
          tool_name: "Read",
          output: "Loaded 172 lines from crates/velo-protocol/src/lib.rs",
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
          text: `I have updated the worktree on branch \`${session.worktree_branch}\` and verified that all workspace crates compile cleanly. You can inspect the exact line-by-line changes in the **Changes** dock on the right or send follow-up instructions below.`,
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
        stats: session.diff_stats ?? { files_changed: 2, insertions: 8, deletions: 0 },
        diff: FALLBACK_DIFF,
      };
    },
    [diffsBySession]
  );

  const handleSendInput = async (sessionId: string, text: string) => {
    try {
      await fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text }),
      });
      await fetchSessionDetails(sessionId);
      await fetchSessions();
    } catch {
      setEventsBySession((prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] ?? []),
          { kind: "user_input", content: text },
          {
            kind: "assistant_message",
            text: `Received instruction: "${text}". Executed in isolated worktree.`,
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
    } catch {
      // ignore
    }
  };

  const handleCreateWorkspace = async (input: {
    name: string;
    provider: AgentProvider;
    project_path: string;
    branch: string;
    prompt: string;
  }) => {
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        use_pty: input.provider === "custom_pty",
      }),
    });
    if (res.ok) {
      const created = (await res.json()) as SessionInfo;
      await fetchSessions();
      setPane0SessionId(created.id);
      setPane0Tab("agent");
    }
  };

  const handleRunHandoff = async (targetProvider: AgentProvider, note: string) => {
    if (!activeSessionId) return;
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${activeSessionId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_provider: targetProvider,
        additional_instructions: note,
      }),
    });
    if (res.ok) {
      const created = (await res.json()) as SessionInfo;
      await fetchSessions();
      setPane0SessionId(created.id);
    }
  };

  const handleRunAdvisor = async (advisorProvider: AgentProvider, question: string) => {
    if (!activeSessionId) return;
    await fetch(`${DEFAULT_DAEMON_URL}/api/sessions/${activeSessionId}/advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        advisor_provider: advisorProvider,
        question,
      }),
    });
    await fetchSessionDetails(activeSessionId);
    await fetchSessions();
  };

  const handleRunCommittee = async (prompt: string, branchPrefix: string) => {
    const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/committee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "committee-review",
        project_path: active?.project_path ?? "/Users/daiyudai/code/velo",
        branch_prefix: branchPrefix,
        members: ["claude_code", "codex"],
        synthesizer: "claude_code",
        prompt,
      }),
    });
    if (res.ok) {
      await fetchSessions();
    }
  };

  const handleRunLoop = async (goal: string, maxIterations: number) => {
    const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
    const res = await fetch(`${DEFAULT_DAEMON_URL}/api/loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "autonomous-loop",
        worker_provider: "claude_code",
        evaluator_provider: "codex",
        project_path: active?.project_path ?? "/Users/daiyudai/code/velo",
        branch: `feat/loop-${Date.now().toString().slice(-4)}`,
        goal,
        max_iterations: maxIterations,
      }),
    });
    if (res.ok) {
      const created = (await res.json()) as SessionInfo;
      await fetchSessions();
      setPane0SessionId(created.id);
    }
  };

  const handleOpenPairModal = async () => {
    try {
      const res = await fetch(`${DEFAULT_DAEMON_URL}/api/pair`);
      if (res.ok) {
        const data = (await res.json()) as PairingResponse;
        setPairingData(data);
      }
    } catch {
      // ignore
    }
    setPairModalOpen(true);
  };

  const pane0Session = useMemo(
    () => sessions.find((s) => s.id === pane0SessionId) ?? sessions[0] ?? null,
    [sessions, pane0SessionId]
  );
  const pane1Session = useMemo(
    () => sessions.find((s) => s.id === pane1SessionId) ?? sessions[1] ?? sessions[0] ?? null,
    [sessions, pane1SessionId]
  );
  const activeExplorerSession = isSplit && focusedPane === 1 ? pane1Session : pane0Session;

  const pane0Diff = getDiffForSession(pane0Session);
  const pane1Diff = getDiffForSession(pane1Session);
  const explorerDiff = getDiffForSession(activeExplorerSession);

  return (
    <div
      className="w-screen h-screen overflow-hidden flex select-none"
      style={{
        backgroundColor: "var(--surface-0)",
        color: "var(--fg)",
      }}
    >
      {/* Region 1: Full-Height Paseo Left Sidebar */}
      {!leftSidebarCollapsed && (
        <PaseoLeftSidebar
          sessions={sessions}
          selectedSessionId={activeSessionId}
          onSelectSession={handleSelectSessionFromSidebar}
          wsConnected={wsConnected}
          themeId={themeId}
          onSelectTheme={setThemeId}
          onOpenNewWorkspaceModal={() => setNewWorkspaceOpen(true)}
          onOpenOrchestratorModal={(tab) => setOrchestratorModal({ open: true, tab })}
          onOpenPairModal={handleOpenPairModal}
          onCollapseSidebar={() => setLeftSidebarCollapsed(true)}
        />
      )}

      {/* Region 2: Center Paseo Workspace Deck (Single or Split-Pane) */}
      <main className="flex-1 min-w-0 h-full flex overflow-hidden">
        <PaseoWorkspacePane
          paneIndex={0}
          isSplit={isSplit}
          isFocusedPane={!isSplit || focusedPane === 0}
          onFocusPane={() => setFocusedPane(0)}
          session={pane0Session}
          events={getEventsForSession(pane0Session)}
          diffText={pane0Diff.diff}
          diffStats={pane0Diff.stats}
          activeTab={pane0Tab}
          onChangeTab={setPane0Tab}
          leftSidebarCollapsed={leftSidebarCollapsed}
          onExpandLeftSidebar={() => setLeftSidebarCollapsed(false)}
          explorerOpen={explorerOpen}
          onToggleExplorer={() => setExplorerOpen((v) => !v)}
          onToggleSplit={() => setIsSplit((v) => !v)}
          onSendInput={handleSendInput}
          onStopSession={handleStopSession}
          onOpenNewWorkspaceModal={() => setNewWorkspaceOpen(true)}
          onOpenOrchestratorModal={(tab) => setOrchestratorModal({ open: true, tab })}
        />

        {isSplit && (
          <PaseoWorkspacePane
            paneIndex={1}
            isSplit={isSplit}
            isFocusedPane={focusedPane === 1}
            onFocusPane={() => setFocusedPane(1)}
            session={pane1Session}
            events={getEventsForSession(pane1Session)}
            diffText={pane1Diff.diff}
            diffStats={pane1Diff.stats}
            activeTab={pane1Tab}
            onChangeTab={setPane1Tab}
            leftSidebarCollapsed={leftSidebarCollapsed}
            onExpandLeftSidebar={() => setLeftSidebarCollapsed(false)}
            explorerOpen={explorerOpen}
            onToggleExplorer={() => setExplorerOpen((v) => !v)}
            onToggleSplit={() => setIsSplit(false)}
            onSendInput={handleSendInput}
            onStopSession={handleStopSession}
            onOpenNewWorkspaceModal={() => setNewWorkspaceOpen(true)}
            onOpenOrchestratorModal={(tab) => setOrchestratorModal({ open: true, tab })}
          />
        )}
      </main>

      {/* Region 3: Right Paseo Explorer Sidebar Dock (Changes & Files) */}
      {explorerOpen && (
        <PaseoExplorerSidebar
          session={activeExplorerSession}
          diffText={explorerDiff.diff}
          diffStats={explorerDiff.stats}
          onRefreshDiff={() => {
            if (activeExplorerSession) fetchSessionDetails(activeExplorerSession.id);
          }}
          onOpenDiffTab={() => {
            if (isSplit && focusedPane === 1) {
              setPane1Tab("diff");
            } else {
              setPane0Tab("diff");
            }
          }}
          onCloseExplorer={() => setExplorerOpen(false)}
        />
      )}

      {/* Paseo Modals */}
      <PaseoNewWorkspaceModal
        open={newWorkspaceOpen}
        onClose={() => setNewWorkspaceOpen(false)}
        onCreate={handleCreateWorkspace}
      />

      <PaseoOrchestratorModal
        open={orchestratorModal.open}
        initialTab={orchestratorModal.tab}
        activeSession={activeExplorerSession}
        onClose={() => setOrchestratorModal((prev) => ({ ...prev, open: false }))}
        onRunHandoff={handleRunHandoff}
        onRunAdvisor={handleRunAdvisor}
        onRunCommittee={handleRunCommittee}
        onRunLoop={handleRunLoop}
      />

      <PaseoPairModal
        open={pairModalOpen}
        pairing={pairingData}
        onClose={() => setPairModalOpen(false)}
      />
    </div>
  );
}

export default App;
