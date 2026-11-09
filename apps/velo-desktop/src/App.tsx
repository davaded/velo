import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AgentEvent,
  AgentKind,
  ApprovalMode,
  DEMO_DIFF_FILES,
  DEMO_EVENTS,
  DEMO_SESSIONS,
  SLASH_SKILLS,
  VeloSession,
  normalizeToVeloSession,
} from "./mockData";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Copy,
  FileCode2,
  GitBranch,
  Plus,
  QrCode,
  Search,
  Sparkles,
  Terminal,
  Wand2,
  X,
} from "lucide-react";

type VariantId = "a" | "b" | "c";
type DrawerTab = "diff" | "terminal";
type ModalKind = null | "new-worktree" | "command" | "skills" | "qr" | "advisor";

export function App() {
  const [daemonUrl] = useState<string>(() => {
    const origin = window.location.origin;
    if (origin.includes(":6767")) return origin;
    return "http://127.0.0.1:6767";
  });

  // Visual Material Variant (User asked for all 3 versions to compare!)
  const [variant, setVariant] = useState<VariantId>("a");

  // Core Sessions & Events
  const [sessions, setSessions] = useState<VeloSession[]>(DEMO_SESSIONS);
  const [activeId, setActiveId] = useState<string>(DEMO_SESSIONS[0].id);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[]>>(DEMO_EVENTS);
  const [connected, setConnected] = useState<boolean>(false);

  // On-Demand Right Drawer State (Closed by default per User's 1+4 Layout!)
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("diff");
  const [selectedDiffPath, setSelectedDiffPath] = useState<string>(DEMO_DIFF_FILES[0].path);

  // Collapsible states in stream
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});

  // Composer State
  const [prompt, setPrompt] = useState<string>("");
  const [attachedFiles, setAttachedFiles] = useState<string[]>([
    "crates/velo-protocol/src/lib.rs",
    "crates/velo-daemon/src/main.rs",
  ]);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Modals
  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [cmdQuery, setCmdQuery] = useState<string>("");
  const [newTaskName, setNewTaskName] = useState<string>("feat-worktree-orchestrator");
  const [newAgentKind, setNewAgentKind] = useState<AgentKind>("claude");
  const [newApproval] = useState<ApprovalMode>("auto_edit");

  // Terminal State inside Drawer
  const [termLines, setTermLines] = useState<string[]>([
    "$ velo status --worktrees",
    "  ● feat/ws-reconnection      [claude-sonnet-4.5]  +48 -14  RUNNING",
    "  ● fix/worktree-gc-lock      [codex-o3]           +19 -5   RUNNING",
    "  ✓ chore/mcp-bridge-tools    [gemini-2.5-pro]     +112 -8  IDLE",
    "$ cargo test --workspace --quiet",
    "  test result: ok. 18 passed; 0 failed; 0 ignored (0.41s)",
  ]);
  const [termInput, setTermInput] = useState<string>("");

  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) || sessions[0] || DEMO_SESSIONS[0],
    [sessions, activeId]
  );

  const activeEvents = useMemo(
    () => eventsBySession[activeSession.id] || DEMO_EVENTS["sess-1"] || [],
    [eventsBySession, activeSession.id]
  );

  // Connect to live Rust Velo Daemon
  useEffect(() => {
    let alive = true;
    fetch(`${daemonUrl}/api/sessions`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((list: unknown) => {
        if (!alive) return;
        setConnected(true);
        if (Array.isArray(list) && list.length > 0) {
          const normalized = list.map((item, idx) => normalizeToVeloSession(item, idx));
          setSessions((prev) => {
            const existingIds = new Set(normalized.map((s) => s.id));
            return [...normalized, ...prev.filter((d) => !existingIds.has(d.id))];
          });
        }
      })
      .catch(() => {
        if (alive) setConnected(false);
      });
    return () => {
      alive = false;
    };
  }, [daemonUrl]);

  useEffect(() => {
    const wsUrl = `${daemonUrl.replace(/^http/, "ws")}/ws`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (msg) => {
        try {
          const raw = JSON.parse(msg.data) as Record<string, unknown>;
          const content = String(raw.text ?? raw.content ?? raw.line ?? "");
          if (!content) return;
          const ev: AgentEvent = {
            id: `ws-${Date.now()}`,
            session_id: String(raw.session_id ?? activeId),
            timestamp: new Date().toLocaleTimeString([], { hour12: false }),
            kind: "assistant",
            content,
          };
          setEventsBySession((prev) => ({
            ...prev,
            [ev.session_id]: [...(prev[ev.session_id] || []), ev],
          }));
        } catch {
          // ignore
        }
      };
      ws.onclose = () => setConnected(false);
    } catch {
      setConnected(false);
    }
    return () => {
      if (ws) ws.close();
    };
  }, [daemonUrl, activeId]);

  // Keyboard shortcuts: Cmd+K (Command), Cmd+J / Cmd+B (Toggle Right Drawer), Esc (Close)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setActiveModal((m) => (m === "command" ? null : "command"));
      } else if (
        (e.metaKey || e.ctrlKey) &&
        (e.key.toLowerCase() === "j" || e.key.toLowerCase() === "b")
      ) {
        e.preventDefault();
        setDrawerOpen((o) => !o);
      } else if (e.key === "Escape") {
        if (activeModal) setActiveModal(null);
        else if (drawerOpen) setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeModal, drawerOpen]);

  const openDiffForFile = (filePath?: string) => {
    if (filePath) {
      const matched = DEMO_DIFF_FILES.find(
        (f) => filePath.includes(f.path) || f.path.includes(filePath)
      );
      if (matched) setSelectedDiffPath(matched.path);
    }
    setDrawerTab("diff");
    setDrawerOpen(true);
  };

  const openTerminalDrawer = () => {
    setDrawerTab("terminal");
    setDrawerOpen(true);
  };

  const handlePromptChange = (val: string) => {
    setPrompt(val);
    if (val.startsWith("/")) {
      setSlashFilter(val.slice(1).toLowerCase());
    } else {
      setSlashFilter(null);
    }
  };

  const handleSendPrompt = async (customText?: string) => {
    const text = (customText ?? prompt).trim();
    if (!text) return;
    setPrompt("");
    setSlashFilter(null);

    const now = new Date().toLocaleTimeString([], { hour12: false });
    const userEv: AgentEvent = {
      id: `u-${Date.now()}`,
      session_id: activeSession.id,
      timestamp: now,
      kind: "user",
      content: text,
    };

    const thinkId = `th-${Date.now() + 1}`;
    const thinkEv: AgentEvent = {
      id: thinkId,
      session_id: activeSession.id,
      timestamp: now,
      kind: "thinking",
      content: text.startsWith("/handoff")
        ? "Compacting context window into structured architectural handoff summary while preserving modified Rust symbols and active worktree diff..."
        : text.startsWith("/advisor")
        ? "Escalating architecture plan to Senior Reviewer Model (Claude Opus 4.6) to audit race-condition & lock safety..."
        : `Analyzing prompt across ${attachedFiles.length} context files in isolated Git worktree (${activeSession.branch_name})...`,
    };

    const toolId = `tl-${Date.now() + 2}`;
    const toolEv: AgentEvent = {
      id: toolId,
      session_id: activeSession.id,
      timestamp: now,
      kind: "tool_call",
      tool_name: "Edit",
      tool_args: "crates/velo-protocol/src/lib.rs",
      content:
        "@@ -42,6 +42,14 @@\n+pub struct ReconnectPolicy {\n+    pub base_delay_ms: u64,\n+    pub max_delay_ms: u64,\n+    pub jitter_ratio: f32,\n+}",
      duration_ms: 48,
    };

    const replyEv: AgentEvent = {
      id: `as-${Date.now() + 3}`,
      session_id: activeSession.id,
      timestamp: now,
      kind: "assistant",
      content: text.startsWith("/handoff")
        ? "Context compacted (`64k → 9.2k tokens`). Ready to continue seamlessly in a fresh worktree stream without losing architectural state."
        : text.startsWith("/advisor")
        ? "**Opus 4.6 Architect Audit**:\n- Lock hierarchy in `velo-worktree` is deadlock-free.\n- Recommendation: bound `WsFrame` replay ring buffer to `1024` events per worktree session."
        : `Updated \`crates/velo-protocol/src/lib.rs\` in branch \`${activeSession.branch_name}\` and verified workspace compilation. Click the file chip above to inspect the live Diff in the slide-over drawer.`,
    };

    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: [...(prev[activeSession.id] || []), userEv, thinkEv, toolEv, replyEv],
    }));

    try {
      await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: text + "\n" }),
      });
    } catch {
      // local optimistic simulation already updated
    }

    setTimeout(() => {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  const handleCreateWorktree = async () => {
    const clean = newTaskName.trim() || `task-${sessions.length + 1}`;
    const branch = clean.startsWith("feat/") || clean.startsWith("fix/") ? clean : `feat/${clean}`;
    const newId = `sess-${Date.now().toString().slice(-4)}`;
    const created: VeloSession = {
      id: newId,
      title: clean,
      agent_kind: newAgentKind,
      model:
        newAgentKind === "claude"
          ? "claude-sonnet-4.5"
          : newAgentKind === "codex"
          ? "codex-o3"
          : "gemini-2.5-pro",
      status: "running",
      branch_name: branch,
      worktree_path: `/Users/daiyudai/code/velo/.velo/worktrees/${clean}`,
      project_path: "/Users/daiyudai/code/velo",
      approval_mode: newApproval,
      tokens_used: 2400,
      tokens_limit: 200000,
      cost_usd: 0.01,
      files_changed: 1,
      insertions: 14,
      deletions: 2,
      updated_at: "just now",
    };

    setSessions((prev) => [created, ...prev]);
    setEventsBySession((prev) => ({
      ...prev,
      [newId]: [
        {
          id: `init-${Date.now()}`,
          session_id: newId,
          timestamp: new Date().toLocaleTimeString([], { hour12: false }),
          kind: "tool_call",
          tool_name: "GitWorktree",
          tool_args: `git worktree add .velo/worktrees/${clean} -b ${branch}`,
          content: `HEAD is now at 9ef8a30 Checked out isolated branch ${branch}`,
          duration_ms: 34,
        },
        {
          id: `welcome-${Date.now() + 1}`,
          session_id: newId,
          timestamp: new Date().toLocaleTimeString([], { hour12: false }),
          kind: "assistant",
          content: `Isolated Git worktree \`${branch}\` is ready with **${created.model}**. Send a task or click any modified file chip to slide out the Diff & PTY drawer.`,
        },
      ],
    }));
    setActiveId(newId);
    setActiveModal(null);
  };

  const handleRunTermCommand = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = termInput.trim();
    if (!cmd) return;
    setTermInput("");
    setTermLines((prev) => [
      ...prev,
      `$ ${cmd}`,
      cmd.includes("git status")
        ? `On branch ${activeSession.branch_name} — 3 files modified (+${activeSession.insertions} -${activeSession.deletions})`
        : `Executed '${cmd}' in worktree ${activeSession.worktree_path} (exit 0)`,
    ]);
  };

  const copyText = (key: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const currentDiffFile = useMemo(
    () => DEMO_DIFF_FILES.find((f) => f.path === selectedDiffPath) || DEMO_DIFF_FILES[0],
    [selectedDiffPath]
  );

  const tokenPercent = Math.min(
    100,
    Math.round(
      ((activeSession.tokens_used || 36400) / (activeSession.tokens_limit || 200000)) * 100
    )
  );

  return (
    <div
      className={`velo-variant-${variant} flex h-screen w-screen overflow-hidden select-none bg-[#09090b] text-[#fafafa]`}
    >
      {/* =====================================================================
          1. ULTRA-SLIM 48PX LEFT ICON RAIL (Spatial Layout Option 1)
         ===================================================================== */}
      <aside className="v-rail z-30 flex w-[50px] shrink-0 flex-col items-center justify-between py-3">
        <div className="flex flex-col items-center gap-2.5">
          {/* Velo Monochrome Brand Mark */}
          <button
            onClick={() => setActiveModal("command")}
            title="Velo Orchestrator (⌘K)"
            className="v-card group relative flex h-8 w-8 items-center justify-center font-mono text-[13px] font-bold tracking-tighter text-[#fafafa] transition-transform active:scale-95"
          >
            V
            <span
              className="v-dot absolute -right-0.5 -top-0.5"
              style={{ background: connected ? "#34d399" : "#fbbf24" }}
            />
          </button>

          <div className="my-0.5 h-[1px] w-5 bg-[#27272a]" />

          {/* Worktree Agent Session Icons */}
          {sessions.map((s, idx) => {
            const isActive = s.id === activeSession.id;
            const shortCode =
              s.agent_kind === "claude"
                ? `C${idx + 1}`
                : s.agent_kind === "codex"
                ? `CX`
                : `GM`;
            const dotColor =
              s.status === "running"
                ? "#34d399"
                : s.status === "waiting_approval"
                ? "#fbbf24"
                : "#71717a";

            return (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                title={`${s.branch_name} · ${s.model} (+${s.insertions} -${s.deletions})`}
                className={`group relative flex h-8 w-8 items-center justify-center rounded-md font-mono text-[11px] font-semibold transition-all ${
                  isActive
                    ? "bg-[#fafafa] text-[#09090b] shadow-sm"
                    : "bg-[#141417] text-[#a1a1aa] hover:bg-[#1f1f24] hover:text-[#fafafa]"
                }`}
              >
                {/* Left active pill indicator */}
                {isActive && (
                  <span className="absolute -left-[9px] h-4 w-[3px] rounded-r bg-[#fafafa]" />
                )}
                {shortCode}
                {/* Semantic 6px status dot */}
                <span
                  className="v-dot absolute -bottom-0.5 -right-0.5 border border-[#09090b]"
                  style={{ background: dotColor }}
                />
              </button>
            );
          })}

          {/* Create Isolated Worktree Session Button */}
          <button
            onClick={() => setActiveModal("new-worktree")}
            title="New Isolated Git Worktree Session"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-[#27272a] text-[#71717a] transition-colors hover:border-[#52525b] hover:text-[#fafafa]"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Bottom Utility Triggers */}
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={() => setActiveModal("skills")}
            title="Slash Skills (/handoff, /advisor)"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#71717a] transition-colors hover:bg-[#18181c] hover:text-[#fafafa]"
          >
            <Wand2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setActiveModal("qr")}
            title="Mobile E2EE Relay Pairing"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#71717a] transition-colors hover:bg-[#18181c] hover:text-[#fafafa]"
          >
            <QrCode className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setActiveModal("command")}
            title="Command Palette (⌘K)"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#71717a] transition-colors hover:bg-[#18181c] hover:text-[#fafafa]"
          >
            <Command className="h-3.5 w-3.5" />
          </button>
        </div>
      </aside>

      {/* =====================================================================
          2. MAIN WORKSPACE AREA (Top Header + Single-Column Center + Slide-Over Drawer)
         ===================================================================== */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Minimal Monochrome Top Header (44px) */}
        <header className="v-topbar z-20 flex h-[44px] shrink-0 items-center justify-between px-4">
          {/* Left: Worktree & Branch Breadcrumb */}
          <div className="flex items-center gap-2.5 text-[12px]">
            <span className="font-medium text-[#71717a]">velo</span>
            <span className="text-[#3f3f46]">/</span>
            <button
              onClick={() => setActiveModal("command")}
              className="v-chip flex items-center gap-1.5 px-2 py-0.5 font-mono text-[11px] text-[#fafafa]"
            >
              <GitBranch className="h-3 w-3 text-[#a1a1aa]" />
              <span>{activeSession.branch_name}</span>
              <ChevronDown className="h-3 w-3 text-[#71717a]" />
            </button>
            <span className="hidden items-center gap-1.5 font-mono text-[11px] text-[#71717a] md:inline-flex">
              <span
                className="v-dot"
                style={{
                  background: activeSession.status === "running" ? "#34d399" : "#38bdf8",
                }}
              />
              {activeSession.model}
            </span>
          </div>

          {/* Center: LIVE MATERIAL VARIANT SWITCHER (A / B / C for User Comparison!) */}
          <div className="flex items-center gap-1 rounded-lg border border-[#27272a] bg-[#0f0f12] p-0.5">
            <button
              onClick={() => setVariant("a")}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-all ${
                variant === "a"
                  ? "bg-[#fafafa] text-[#09090b] font-semibold"
                  : "text-[#a1a1aa] hover:text-[#fafafa]"
              }`}
            >
              A · 极简锐利 (shadcn/Linear)
            </button>
            <button
              onClick={() => setVariant("b")}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-all ${
                variant === "b"
                  ? "bg-[#fafafa] text-[#09090b] font-semibold"
                  : "text-[#a1a1aa] hover:text-[#fafafa]"
              }`}
            >
              B · 微光毛玻璃 (Beautiful/beUI)
            </button>
            <button
              onClick={() => setVariant("c")}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-all ${
                variant === "c"
                  ? "bg-[#fafafa] text-[#09090b] font-semibold"
                  : "text-[#a1a1aa] hover:text-[#fafafa]"
              }`}
            >
              C · 硬件立体 3D (Rare UI)
            </button>
          </div>

          {/* Right: On-Demand Slide-Over Drawer Triggers */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSendPrompt("/advisor Audit current worktree changes")}
              className="v-chip hidden items-center gap-1 px-2.5 py-1 font-mono text-[11px] text-[#a1a1aa] hover:text-[#fafafa] lg:inline-flex"
            >
              <Sparkles className="h-3 w-3" />
              <span>/advisor</span>
            </button>

            <button
              onClick={() => {
                if (drawerOpen && drawerTab === "diff") {
                  setDrawerOpen(false);
                } else {
                  setDrawerTab("diff");
                  setDrawerOpen(true);
                }
              }}
              className={`v-chip flex items-center gap-1.5 px-2.5 py-1 font-mono text-[11px] ${
                drawerOpen && drawerTab === "diff"
                  ? "border-[#fafafa] text-[#fafafa]"
                  : "text-[#a1a1aa]"
              }`}
            >
              <FileCode2 className="h-3 w-3" />
              <span>Diff</span>
              <span className="text-[#34d399]">+{activeSession.insertions}</span>
              <span className="text-[#f87171]">−{activeSession.deletions}</span>
            </button>

            <button
              onClick={() => {
                if (drawerOpen && drawerTab === "terminal") {
                  setDrawerOpen(false);
                } else {
                  openTerminalDrawer();
                }
              }}
              className={`v-chip flex items-center gap-1.5 px-2.5 py-1 font-mono text-[11px] ${
                drawerOpen && drawerTab === "terminal"
                  ? "border-[#fafafa] text-[#fafafa]"
                  : "text-[#a1a1aa]"
              }`}
            >
              <Terminal className="h-3 w-3" />
              <span>PTY</span>
            </button>
          </div>
        </header>

        {/* Body Area: Centered Single-Column Stream + On-Demand Slide-Over Drawer */}
        <div className="relative flex flex-1 overflow-hidden">
          {/* =================================================================
              3. SINGLE-COLUMN MONOCHROME FOCUS STREAM (Spatial Layout Option 4)
             ================================================================= */}
          <main className="flex flex-1 flex-col items-center overflow-hidden">
            {/* Scrollable Conversation Stream */}
            <div className="w-full flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto flex max-w-[720px] flex-col gap-4">
                {/* Compact Worktree Isolation Banner */}
                <div className="v-card flex items-center justify-between px-3.5 py-2 text-[11px] text-[#a1a1aa]">
                  <div className="flex items-center gap-2 font-mono">
                    <span className="v-dot" style={{ background: "#34d399" }} />
                    <span className="text-[#fafafa]">{activeSession.worktree_path}</span>
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[11px] text-[#71717a]">
                    <span>{activeSession.approval_mode}</span>
                    <span>·</span>
                    <button
                      onClick={() => openDiffForFile()}
                      className="text-[#fafafa] underline decoration-[#3f3f46] underline-offset-4 hover:decoration-[#fafafa]"
                    >
                      {activeSession.files_changed} files changed (点击滑出 Diff 抽屉)
                    </button>
                  </div>
                </div>

                {/* Stream Events */}
                {activeEvents.map((ev) => {
                  if (ev.kind === "user") {
                    return (
                      <div key={ev.id} className="v-card px-4 py-3">
                        <div className="mb-1 flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#71717a]">
                          <span>YOU</span>
                          <span>{ev.timestamp}</span>
                        </div>
                        <div className="text-[13.5px] leading-relaxed text-[#fafafa]">
                          {ev.content}
                        </div>
                      </div>
                    );
                  }

                  if (ev.kind === "thinking") {
                    const isOpen = !!expandedThinking[ev.id];
                    return (
                      <div key={ev.id} className="px-1">
                        <button
                          onClick={() =>
                            setExpandedThinking((p) => ({ ...p, [ev.id]: !isOpen }))
                          }
                          className="flex items-center gap-2 text-left font-mono text-[11.5px] text-[#a1a1aa] hover:text-[#fafafa]"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 text-[#71717a]" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-[#71717a]" />
                          )}
                          <span className="v-shimmer">
                            Thinking · {ev.content.slice(0, 76)}
                            {ev.content.length > 76 ? "..." : ""}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="mt-2 border-l border-[#27272a] pl-4 font-mono text-[11.5px] leading-relaxed text-[#71717a]">
                            {ev.content}
                          </div>
                        )}
                      </div>
                    );
                  }

                  if (ev.kind === "tool_call") {
                    const isExpanded = !!expandedTools[ev.id];
                    return (
                      <div key={ev.id} className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* Clicking the file/tool chip opens the Slide-Over Diff Drawer! */}
                          <button
                            onClick={() => openDiffForFile(ev.tool_args)}
                            className="v-chip group flex items-center gap-2 px-3 py-1.5 font-mono text-[11.5px]"
                          >
                            <span className="v-dot" style={{ background: "#34d399" }} />
                            <span className="font-semibold text-[#fafafa]">
                              {ev.tool_name || "Tool"}
                            </span>
                            <span className="text-[#a1a1aa]">{ev.tool_args}</span>
                            <span className="text-[#34d399]">+24</span>
                            <span className="text-[#f87171]">−3</span>
                            <span className="ml-1 text-[10px] text-[#71717a] group-hover:text-[#fafafa]">
                              [滑出 Diff 抽屉 →]
                            </span>
                          </button>

                          <button
                            onClick={() =>
                              setExpandedTools((p) => ({ ...p, [ev.id]: !isExpanded }))
                            }
                            className="font-mono text-[10.5px] text-[#71717a] hover:text-[#fafafa]"
                          >
                            {isExpanded ? "收起输出" : `${ev.duration_ms || 42}ms · 展开内联`}
                          </button>
                        </div>

                        {isExpanded && (
                          <pre className="v-card overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-[#a1a1aa]">
                            {ev.content}
                          </pre>
                        )}
                      </div>
                    );
                  }

                  // Assistant response
                  return (
                    <div key={ev.id} className="px-1 py-1">
                      <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] text-[#71717a]">
                        <span className="font-semibold text-[#fafafa]">
                          {activeSession.model}
                        </span>
                        <span>·</span>
                        <span>{ev.timestamp}</span>
                      </div>
                      <div className="whitespace-pre-line text-[13.5px] leading-relaxed text-[#e4e4e7]">
                        {ev.content}
                      </div>
                    </div>
                  );
                })}
                <div ref={streamEndRef} />
              </div>
            </div>

            {/* ===============================================================
                4. CENTERED MONOCHROME COMPOSER DOCK
               =============================================================== */}
            <div className="w-full px-6 pb-5 pt-2">
              <div className="mx-auto max-w-[720px]">
                {/* Slash command popup if typing '/' */}
                {slashFilter !== null && (
                  <div className="v-card mb-2 overflow-hidden p-1.5">
                    <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[#71717a]">
                      Velo Native Skills
                    </div>
                    {SLASH_SKILLS.filter((s) =>
                      s.cmd.toLowerCase().includes(slashFilter)
                    ).map((skill) => (
                      <button
                        key={skill.cmd}
                        onClick={() => handleSendPrompt(`${skill.cmd} `)}
                        className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[#18181c]"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-[#fafafa]">
                            {skill.cmd}
                          </span>
                          <span className="text-[#a1a1aa]">{skill.label}</span>
                        </div>
                        <span className="font-mono text-[11px] text-[#71717a]">
                          {skill.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="v-composer p-3 transition-all">
                  {/* Context File Chips */}
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {attachedFiles.map((file) => (
                      <span
                        key={file}
                        onClick={() => openDiffForFile(file)}
                        className="v-chip flex cursor-pointer items-center gap-1.5 px-2 py-0.5 font-mono text-[11px] text-[#a1a1aa] hover:text-[#fafafa]"
                      >
                        <span>@{file.split("/").slice(-2).join("/")}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setAttachedFiles((prev) => prev.filter((f) => f !== file));
                          }}
                          className="text-[#71717a] hover:text-[#fafafa]"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <button
                      onClick={() => handleSendPrompt("/handoff")}
                      className="v-chip px-2 py-0.5 font-mono text-[11px] text-[#71717a] hover:text-[#fafafa]"
                    >
                      /handoff
                    </button>
                    <button
                      onClick={() => handleSendPrompt("/advisor")}
                      className="v-chip px-2 py-0.5 font-mono text-[11px] text-[#71717a] hover:text-[#fafafa]"
                    >
                      /advisor
                    </button>
                  </div>

                  {/* Textarea */}
                  <textarea
                    rows={2}
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendPrompt();
                      }
                    }}
                    placeholder={`向 ${activeSession.model} 发送指令，输入 / 调用技能，点击文件标签滑出右侧 Diff 抽屉...`}
                    className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-[#fafafa] placeholder-[#52525b] focus:outline-none"
                  />

                  {/* Bottom Composer Bar */}
                  <div className="mt-2 flex items-center justify-between border-t border-[#1f1f24] pt-2">
                    <div className="flex items-center gap-3 font-mono text-[11px] text-[#71717a]">
                      <span className="flex items-center gap-1.5 text-[#a1a1aa]">
                        <span className="v-dot" style={{ background: "#34d399" }} />
                        {activeSession.model}
                      </span>
                      <span>·</span>
                      <span>{activeSession.approval_mode}</span>
                      <span>·</span>
                      <span title="Context window usage">
                        {tokenPercent}% ({Math.round(activeSession.tokens_used / 1000)}k / 200k)
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleSendPrompt()}
                        className="v-primary-btn flex items-center gap-1.5 px-3 py-1 text-[11.5px]"
                      >
                        <span>Send</span>
                        <span className="font-mono text-[10px] opacity-70">↵</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>

          {/* =================================================================
              5. ON-DEMAND SLIDE-OVER DIFF & TERMINAL DRAWER (Right Side)
             ================================================================= */}
          <aside
            className={`v-drawer z-20 flex flex-col overflow-hidden transition-all duration-200 ease-out ${
              drawerOpen ? "w-[480px] opacity-100" : "w-0 border-l-0 opacity-0"
            }`}
          >
            {/* Drawer Header */}
            <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-[#222226] px-3.5">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setDrawerTab("diff")}
                  className={`v-chip px-2.5 py-1 font-mono text-[11px] ${
                    drawerTab === "diff"
                      ? "border-[#fafafa] text-[#fafafa]"
                      : "border-transparent text-[#71717a]"
                  }`}
                >
                  Git Diff ({DEMO_DIFF_FILES.length})
                </button>
                <button
                  onClick={() => setDrawerTab("terminal")}
                  className={`v-chip px-2.5 py-1 font-mono text-[11px] ${
                    drawerTab === "terminal"
                      ? "border-[#fafafa] text-[#fafafa]"
                      : "border-transparent text-[#71717a]"
                  }`}
                >
                  Worktree PTY
                </button>
              </div>

              <button
                onClick={() => setDrawerOpen(false)}
                title="Close Drawer (Esc)"
                className="v-chip flex items-center gap-1 px-2 py-1 font-mono text-[11px] text-[#a1a1aa] hover:text-[#fafafa]"
              >
                <span>收起</span>
                <X className="h-3 w-3" />
              </button>
            </div>

            {drawerTab === "diff" ? (
              <div className="flex flex-1 flex-col overflow-hidden">
                {/* Modified File Selector Pills */}
                <div className="flex flex-wrap gap-1.5 border-b border-[#1f1f24] p-2.5">
                  {DEMO_DIFF_FILES.map((file) => {
                    const active = file.path === currentDiffFile.path;
                    return (
                      <button
                        key={file.path}
                        onClick={() => setSelectedDiffPath(file.path)}
                        className={`v-chip flex items-center gap-1.5 px-2.5 py-1 font-mono text-[11px] ${
                          active
                            ? "border-[#fafafa] text-[#fafafa]"
                            : "text-[#71717a] hover:text-[#a1a1aa]"
                        }`}
                      >
                        <span>{file.path.split("/").slice(-2).join("/")}</span>
                        <span className="text-[#34d399]">+{file.additions}</span>
                        <span className="text-[#f87171]">−{file.deletions}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Selected File Diff Header */}
                <div className="flex items-center justify-between border-b border-[#18181c] bg-[#0c0c0e] px-3.5 py-2 font-mono text-[11px]">
                  <span className="truncate text-[#e4e4e7]">{currentDiffFile.path}</span>
                  <button
                    onClick={() =>
                      copyText(
                        currentDiffFile.path,
                        currentDiffFile.hunks.map((h) => h.content).join("\n")
                      )
                    }
                    className="flex items-center gap-1 text-[#71717a] hover:text-[#fafafa]"
                  >
                    {copiedKey === currentDiffFile.path ? (
                      <>
                        <Check className="h-3 w-3 text-[#34d399]" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Copy Patch</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Diff Hunks (Pure Monochrome + Semantic Green/Red Lines Only) */}
                <div className="flex-1 overflow-y-auto py-2 font-mono text-[11.5px] leading-[1.65]">
                  {currentDiffFile.hunks.map((line, idx) => {
                    const rowClass =
                      line.type === "add"
                        ? "v-diff-add"
                        : line.type === "del"
                        ? "v-diff-del"
                        : "text-[#71717a]";
                    const sign =
                      line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
                    return (
                      <div
                        key={idx}
                        className={`flex px-3.5 py-0.5 ${rowClass}`}
                      >
                        <span className="w-8 shrink-0 select-none text-right pr-3 opacity-40">
                          {line.newLine ?? line.oldLine ?? ""}
                        </span>
                        <span className="w-4 shrink-0 select-none">{sign}</span>
                        <span className="whitespace-pre">{line.content}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* Worktree Native PTY Terminal Tab */
              <div className="flex flex-1 flex-col overflow-hidden bg-[#09090b] p-3.5 font-mono text-[11.5px]">
                <div className="mb-2 flex items-center justify-between border-b border-[#18181c] pb-2 text-[11px] text-[#71717a]">
                  <span>zsh · {activeSession.worktree_path}</span>
                  <span className="text-[#34d399]">● PTY Active</span>
                </div>
                <div className="flex-1 space-y-1.5 overflow-y-auto text-[#d4d4d8]">
                  {termLines.map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("$") ? "font-semibold text-[#fafafa]" : "text-[#a1a1aa]"
                      }
                    >
                      {line}
                    </div>
                  ))}
                </div>
                <form
                  onSubmit={handleRunTermCommand}
                  className="mt-2 flex items-center gap-2 border-t border-[#222226] pt-2.5"
                >
                  <span className="text-[#71717a]">$</span>
                  <input
                    value={termInput}
                    onChange={(e) => setTermInput(e.target.value)}
                    placeholder="cargo test / git status..."
                    className="flex-1 bg-transparent text-[#fafafa] placeholder-[#52525b] focus:outline-none"
                  />
                </form>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* =====================================================================
          6. MODALS (New Isolated Worktree / Command Palette / Mobile Relay QR)
         ===================================================================== */}
      {activeModal && (
        <div
          onClick={() => setActiveModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="v-card w-full max-w-[460px] p-5"
          >
            {activeModal === "new-worktree" && (
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-[#fafafa]">
                    New Isolated Git Worktree Session
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[#71717a] hover:text-[#fafafa]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-3 text-[12px]">
                  <div>
                    <label className="mb-1 block font-mono text-[11px] text-[#a1a1aa]">
                      Branch / Worktree Name
                    </label>
                    <input
                      value={newTaskName}
                      onChange={(e) => setNewTaskName(e.target.value)}
                      className="v-card w-full px-3 py-2 font-mono text-[12px] text-[#fafafa] focus:outline-none"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(["claude", "codex", "gemini"] as AgentKind[]).map((k) => (
                      <button
                        key={k}
                        onClick={() => setNewAgentKind(k)}
                        className={`v-chip py-2 font-mono text-[11.5px] uppercase ${
                          newAgentKind === k ? "border-[#fafafa] text-[#fafafa]" : "text-[#71717a]"
                        }`}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      onClick={() => setActiveModal(null)}
                      className="v-chip px-3 py-1.5 text-[12px] text-[#a1a1aa]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateWorktree}
                      className="v-primary-btn px-4 py-1.5 text-[12px]"
                    >
                      Create Worktree
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeModal === "command" && (
              <div>
                <div className="mb-3 flex items-center gap-2 border-b border-[#27272a] pb-2.5">
                  <Search className="h-4 w-4 text-[#71717a]" />
                  <input
                    autoFocus
                    value={cmdQuery}
                    onChange={(e) => setCmdQuery(e.target.value)}
                    placeholder="Switch worktree, toggle material A/B/C, open Diff drawer..."
                    className="w-full bg-transparent text-[13px] text-[#fafafa] focus:outline-none"
                  />
                </div>
                <div className="space-y-1 text-[12px]">
                  <button
                    onClick={() => {
                      setVariant("a");
                      setActiveModal(null);
                    }}
                    className="flex w-full items-center justify-between rounded px-2.5 py-2 hover:bg-[#18181c]"
                  >
                    <span>Switch Material → Version A (极简锐利 shadcn/Linear)</span>
                    <span className="font-mono text-[10px] text-[#71717a]">Variant A</span>
                  </button>
                  <button
                    onClick={() => {
                      setVariant("b");
                      setActiveModal(null);
                    }}
                    className="flex w-full items-center justify-between rounded px-2.5 py-2 hover:bg-[#18181c]"
                  >
                    <span>Switch Material → Version B (微光毛玻璃 Beautiful/beUI)</span>
                    <span className="font-mono text-[10px] text-[#71717a]">Variant B</span>
                  </button>
                  <button
                    onClick={() => {
                      setVariant("c");
                      setActiveModal(null);
                    }}
                    className="flex w-full items-center justify-between rounded px-2.5 py-2 hover:bg-[#18181c]"
                  >
                    <span>Switch Material → Version C (硬件立体 3D Rare UI)</span>
                    <span className="font-mono text-[10px] text-[#71717a]">Variant C</span>
                  </button>
                  <button
                    onClick={() => {
                      setDrawerOpen((o) => !o);
                      setActiveModal(null);
                    }}
                    className="flex w-full items-center justify-between rounded px-2.5 py-2 hover:bg-[#18181c]"
                  >
                    <span>Toggle On-Demand Diff / PTY Drawer</span>
                    <span className="font-mono text-[10px] text-[#71717a]">⌘J</span>
                  </button>
                </div>
              </div>
            )}

            {(activeModal === "skills" || activeModal === "qr" || activeModal === "advisor") && (
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-mono text-[13px] font-semibold uppercase text-[#fafafa]">
                    {activeModal === "qr" ? "Mobile E2EE Relay Pairing" : "Velo Slash Skills"}
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[#71717a] hover:text-[#fafafa]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {activeModal === "qr" ? (
                  <div className="space-y-2 font-mono text-[11.5px] text-[#a1a1aa]">
                    <p>End-to-End Encrypted X25519 + ChaCha20-Poly1305 Tunnel:</p>
                    <div className="v-card p-3 text-[#fafafa]">
                      velo://pair?daemon=127.0.0.1:6767&fp=9F8B-441A-E2EE
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {SLASH_SKILLS.map((s) => (
                      <button
                        key={s.cmd}
                        onClick={() => {
                          setActiveModal(null);
                          handleSendPrompt(s.cmd);
                        }}
                        className="flex w-full items-center justify-between rounded px-3 py-2 text-left hover:bg-[#18181c]"
                      >
                        <span className="font-mono text-[12px] font-semibold text-[#fafafa]">
                          {s.cmd}
                        </span>
                        <span className="text-[11.5px] text-[#a1a1aa]">{s.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
export default App;
