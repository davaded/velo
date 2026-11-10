import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AgentEvent,
  AgentKind,
  ApprovalMode,
  DEMO_DIFF_FILES,
  DEMO_EVENTS,
  DEMO_REPOS,
  DEMO_SESSIONS,
  SLASH_SKILLS,
  VeloRepo,
  VeloSession,
  normalizeToVeloSession,
} from "./mockData";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Command,
  Copy,
  FileCode2,
  Folder,
  FolderPlus,
  GitBranch,
  Layers,
  PanelLeft,
  Plus,
  QrCode,
  Search,
  Server,
  Settings,
  Sparkles,
  SquarePen,
  Terminal,
  X,
} from "lucide-react";

type VariantId = "a" | "b" | "c";
type DrawerTab = "diff" | "terminal";
type ModalKind =
  | null
  | "new-worktree"
  | "new-repo"
  | "command"
  | "skills"
  | "qr";

export function App() {
  const [daemonUrl] = useState<string>(() => {
    const origin = window.location.origin;
    if (origin.includes(":6767")) return origin;
    return "http://127.0.0.1:6767";
  });

  const [variant, setVariant] = useState<VariantId>("a");
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const [repos, setRepos] = useState<VeloRepo[]>(DEMO_REPOS);
  const [targetRepoIdForNewWt, setTargetRepoIdForNewWt] = useState<string>(DEMO_REPOS[0].id);

  // Core Sessions & Events
  const [sessions, setSessions] = useState<VeloSession[]>(DEMO_SESSIONS);
  const [activeId, setActiveId] = useState<string>(DEMO_SESSIONS[0].id);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[]>>(DEMO_EVENTS);
  const [connected, setConnected] = useState<boolean>(false);

  // On-Demand Right Drawer State
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("diff");
  const [selectedDiffPath, setSelectedDiffPath] = useState<string>(DEMO_DIFF_FILES[0].path);

  // Stream disclosure states
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});

  // Composer State
  const [prompt, setPrompt] = useState<string>("");
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Modals
  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [cmdQuery, setCmdQuery] = useState<string>("");
  const [newTaskName, setNewTaskName] = useState<string>("feat/worktree-orchestrator");
  const [newTaskDesc, setNewTaskDesc] = useState<string>("并行 Agent 调度与状态同步");
  const [newAgentKind, setNewAgentKind] = useState<AgentKind>("claude");
  const [newApproval] = useState<ApprovalMode>("auto_edit");
  const [newRepoPath, setNewRepoPath] = useState<string>("/Users/daiyudai/code/my-service");

  // Terminal State inside Drawer
  const [termLines, setTermLines] = useState<string[]>([
    "$ velo status --worktrees",
    "  ● feat/ws-reconnection      [claude-sonnet-4.5]  +48 -14  RUNNING",
    "  ● fix/worktree-gc-lock      [codex-o3]           +19 -5   WAITING",
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

  const activeRepo = useMemo(
    () => repos.find((r) => r.id === activeSession.repo_id) || repos[0],
    [repos, activeSession.repo_id]
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setActiveModal((m) => (m === "command" ? null : "command"));
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((c) => !c);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
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

    const thinkEv: AgentEvent = {
      id: `th-${Date.now() + 1}`,
      session_id: activeSession.id,
      timestamp: now,
      kind: "thinking",
      content: text.startsWith("/handoff")
        ? "Compacting context window into structured handoff state..."
        : text.startsWith("/advisor")
        ? "Consulting Claude Opus 4.6 for concurrency & lock hierarchy review..."
        : `Analyzing workspace changes in ${activeSession.branch_name}...`,
    };

    const toolEv: AgentEvent = {
      id: `tl-${Date.now() + 2}`,
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
        ? "Context compacted (`64k → 9.2k tokens`). Ready to continue seamlessly."
        : text.startsWith("/advisor")
        ? "Opus 4.6 review complete: lock acquisition order in `velo-worktree` is deadlock-free."
        : `Updated \`crates/velo-protocol/src/lib.rs\` on branch \`${activeSession.branch_name}\` and verified workspace build.`,
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
      // optimistic UI already updated
    }

    setTimeout(() => {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  const handleCreateWorktree = async () => {
    const targetRepo = repos.find((r) => r.id === targetRepoIdForNewWt) || activeRepo;
    const clean = newTaskName.trim() || `feat/task-${sessions.length + 1}`;
    const branch =
      clean.startsWith("feat/") || clean.startsWith("fix/") || clean.startsWith("chore/")
        ? clean
        : `feat/${clean}`;
    const slug = branch.replace(/\//g, "-");
    const newId = `sess-${Date.now().toString().slice(-4)}`;
    const created: VeloSession = {
      id: newId,
      repo_id: targetRepo.id,
      title: newTaskDesc.trim() || branch,
      agent_kind: newAgentKind,
      model:
        newAgentKind === "claude"
          ? "claude-sonnet-4.5"
          : newAgentKind === "codex"
          ? "codex-o3"
          : "gemini-2.5-pro",
      model_short:
        newAgentKind === "claude"
          ? "Claude"
          : newAgentKind === "codex"
          ? "Codex"
          : "Gemini",
      status: "running",
      branch_name: branch,
      worktree_path: `${targetRepo.path}/.velo/worktrees/${slug}`,
      project_path: targetRepo.path,
      approval_mode: newApproval,
      tokens_used: 2400,
      tokens_limit: 200000,
      cost_usd: 0.01,
      files_changed: 1,
      insertions: 14,
      deletions: 2,
      updated_at: "now",
    };

    setSessions((prev) => [created, ...prev]);
    setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
    setEventsBySession((prev) => ({
      ...prev,
      [newId]: [
        {
          id: `init-${Date.now()}`,
          session_id: newId,
          timestamp: new Date().toLocaleTimeString([], { hour12: false }),
          kind: "tool_call",
          tool_name: "GitWorktree",
          tool_args: `git worktree add .velo/worktrees/${slug} -b ${branch}`,
          content: `HEAD is now at 9ef8a30 Checked out isolated branch ${branch}`,
          duration_ms: 34,
        },
        {
          id: `welcome-${Date.now() + 1}`,
          session_id: newId,
          timestamp: new Date().toLocaleTimeString([], { hour12: false }),
          kind: "assistant",
          content: `Checked out isolated worktree \`${branch}\` in **${targetRepo.name}**.`,
        },
      ],
    }));
    setActiveId(newId);
    setActiveModal(null);
  };

  const handleCreateRepo = () => {
    const cleanPath = newRepoPath.trim() || "/Users/daiyudai/code/new-repo";
    const name = cleanPath.split("/").filter(Boolean).pop() || "repo";
    const code = name.slice(0, 2).toUpperCase();
    const id = `repo-${Date.now().toString().slice(-4)}`;
    const newRepo: VeloRepo = {
      id,
      code,
      name,
      path: cleanPath,
      default_branch: "main",
    };
    setRepos((prev) => [...prev, newRepo]);
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
        ? `On branch ${activeSession.branch_name} — ${activeSession.files_changed} files modified (+${activeSession.insertions} -${activeSession.deletions})`
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
      className={`velo-variant-${variant} flex h-screen w-screen overflow-hidden select-none bg-[#111113] text-[#f4f4f5]`}
    >
      {/* =====================================================================
          1. AUTHENTIC CODEX / CLAUDE CODE / PASEO LEFT SIDEBAR
             - Seamless matte surface (#0c0c0e), ZERO boxed cards or heavy lines
             - Top: quiet nav rows (New thread, Automations, Search)
             - Body: Workspaces section -> clean Project rows -> borderless Thread rows
             - Idle rows keep empty leading slot; only active/waiting rows show indicator
             - Bottom: single icon-only footer bar
         ===================================================================== */}
      <aside
        className={`flex shrink-0 flex-col justify-between bg-[#0c0c0e] border-r border-[#1f1f23] transition-all duration-200 overflow-hidden ${
          sidebarOpen ? "w-[252px]" : "w-0 border-r-0"
        }`}
      >
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top Window Bar + Sidebar Toggle */}
          <div className="flex h-[42px] shrink-0 items-center justify-between px-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSidebarOpen(false)}
                title="Hide sidebar (⌘B)"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#71717a] transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              <span className="text-[13px] font-semibold tracking-tight text-[#f4f4f5]">
                Velo
              </span>
            </div>

            <button
              onClick={() => {
                setTargetRepoIdForNewWt(activeRepo.id);
                setActiveModal("new-worktree");
              }}
              title="New thread (⌘N)"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#a1a1aa] transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
            >
              <SquarePen className="h-4 w-4" />
            </button>
          </div>

          {/* Top Navigation Rows (Codex / Claude Code / Paseo SidebarNavRows) */}
          <div className="space-y-0.5 px-2 pb-3">
            <button
              onClick={() => {
                setTargetRepoIdForNewWt(activeRepo.id);
                setActiveModal("new-worktree");
              }}
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-[#a1a1aa] transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
            >
              <Plus className="h-4 w-4 text-[#71717a]" />
              <span>New thread</span>
            </button>
            <button
              onClick={() => setActiveModal("command")}
              className="flex h-[30px] w-full items-center justify-between rounded-md px-2.5 text-[13px] text-[#a1a1aa] transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
            >
              <span className="flex items-center gap-2.5">
                <Search className="h-3.5 w-3.5 text-[#71717a]" />
                <span>Search</span>
              </span>
              <span className="font-mono text-[11px] text-[#52525b]">⌘K</span>
            </button>
            <button
              onClick={() => setActiveModal("skills")}
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-[#a1a1aa] transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
            >
              <Layers className="h-3.5 w-3.5 text-[#71717a]" />
              <span>Automations & Skills</span>
            </button>
          </div>

          {/* Section Header: Workspaces */}
          <div className="flex items-center justify-between px-4 pb-1.5 pt-1">
            <span className="text-[11px] font-medium text-[#71717a]">Workspaces</span>
          </div>

          {/* Scrollable Project -> Thread Hierarchy (Borderless, Clean Rows) */}
          <div className="flex-1 space-y-3 overflow-y-auto px-2 py-1">
            {repos.map((repo) => {
              const repoItems = sessions.filter((s) => s.repo_id === repo.id);
              const isCollapsed = !!collapsedRepos[repo.id];

              return (
                <div key={repo.id} className="space-y-0.5">
                  {/* Project Row */}
                  <div className="group flex h-[28px] items-center justify-between rounded-md px-2 text-[#a1a1aa] transition-colors hover:bg-[#16161a] hover:text-[#f4f4f5]">
                    <button
                      onClick={() =>
                        setCollapsedRepos((prev) => ({
                          ...prev,
                          [repo.id]: !prev[repo.id],
                        }))
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-[#71717a] group-hover:hidden" />
                      {isCollapsed ? (
                        <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-[#71717a] group-hover:block" />
                      ) : (
                        <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 text-[#71717a] group-hover:block" />
                      )}
                      <span className="truncate text-[13px] font-medium text-[#d4d4d8] group-hover:text-[#f4f4f5]">
                        {repo.name}
                      </span>
                    </button>

                    <button
                      onClick={() => {
                        setTargetRepoIdForNewWt(repo.id);
                        setActiveModal("new-worktree");
                      }}
                      title={`New thread in ${repo.name}`}
                      className="flex h-5 w-5 items-center justify-center rounded text-[#71717a] opacity-0 transition-opacity hover:bg-[#222228] hover:text-[#f4f4f5] group-hover:opacity-100"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Thread Rows under Project */}
                  {!isCollapsed && (
                    <div className="space-y-0.5">
                      {repoItems.map((w) => {
                        const isSelected = w.id === activeSession.id;
                        return (
                          <button
                            key={w.id}
                            onClick={() => setActiveId(w.id)}
                            className={`group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                              isSelected
                                ? "bg-[#1f1f25] text-[#f4f4f5]"
                                : "text-[#a1a1aa] hover:bg-[#16161a] hover:text-[#e4e4e7]"
                            }`}
                          >
                            {/* Leading Status Slot (16px wide, reserves space when idle just like Paseo/Codex) */}
                            <div className="mt-[4px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                              {w.status === "running" ? (
                                <span
                                  className="h-2.5 w-2.5 rounded-full border-[1.5px] border-[#34d399] border-t-transparent animate-spin"
                                  title="Running"
                                />
                              ) : w.status === "waiting_approval" ? (
                                <span
                                  className="h-2 w-2 rounded-full bg-[#fbbf24]"
                                  title="Waiting for review"
                                />
                              ) : null}
                            </div>

                            {/* Thread Content Column */}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline justify-between gap-2">
                                <span
                                  className={`truncate text-[13px] leading-snug ${
                                    isSelected ? "font-medium text-[#f4f4f5]" : "font-normal"
                                  }`}
                                >
                                  {w.title}
                                </span>
                                <span className="shrink-0 font-mono text-[11px] text-[#52525b]">
                                  {w.updated_at}
                                </span>
                              </div>

                              {/* Subtle Meta Line: Branch + Diff Stats */}
                              <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[11px] text-[#71717a]">
                                <span className="truncate">{w.branch_name}</span>
                                {(w.insertions > 0 || w.deletions > 0) && (
                                  <span className="flex shrink-0 items-center gap-1 text-[10.5px]">
                                    <span className="text-[#34d399]/80">+{w.insertions}</span>
                                    <span className="text-[#f87171]/80">−{w.deletions}</span>
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom Icon-Only Footer (Paseo / Codex SidebarFooter) */}
        <div className="flex h-[40px] shrink-0 items-center justify-between border-t border-[#18181c] px-2.5 text-[#71717a]">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveModal("new-repo")}
              title="Add project"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
            >
              <FolderPlus className="h-4 w-4" />
            </button>
            <button
              onClick={() => setActiveModal("skills")}
              title={`Usage: ${tokenPercent}% context window`}
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
            >
              <CircleGauge className="h-4 w-4" />
            </button>
            <button
              onClick={() => setActiveModal("qr")}
              title={`Local Daemon (${connected ? "Connected" : "Offline"}) & Mobile Pairing`}
              className="relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
            >
              <Server className="h-4 w-4" />
              <span
                className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                style={{ background: connected ? "#34d399" : "#fbbf24" }}
              />
            </button>
          </div>

          {/* Discrete Style Switcher (A/B/C) + Settings */}
          <div className="flex items-center gap-1">
            <div
              className="flex items-center rounded-md bg-[#141418] p-0.5 text-[10px] font-mono"
              title="Switch Material Variant (A / B / C)"
            >
              {(["a", "b", "c"] as VariantId[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setVariant(v)}
                  className={`rounded px-1.5 py-0.5 uppercase transition-colors ${
                    variant === v
                      ? "bg-[#27272e] text-[#f4f4f5] font-semibold"
                      : "text-[#71717a] hover:text-[#a1a1aa]"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            <button
              onClick={() => setActiveModal("command")}
              title="Settings & Command Palette (⌘K)"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[#18181c] hover:text-[#f4f4f5]"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* =====================================================================
          2. MAIN WORKSPACE AREA (Clean Header + Natural Conversation + Docked Composer)
         ===================================================================== */}
      <div className="flex flex-1 flex-col overflow-hidden bg-[#111113]">
        {/* Clean Minimal Workspace Header (42px) */}
        <header className="flex h-[42px] shrink-0 items-center justify-between border-b border-[#1f1f23] px-4">
          <div className="flex items-center gap-2.5 min-w-0">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                title="Show sidebar (⌘B)"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#71717a] hover:bg-[#1c1c21] hover:text-[#f4f4f5]"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            )}
            <span className="truncate text-[13px] font-medium text-[#f4f4f5]">
              {activeSession.title}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-[#18181c] px-2 py-0.5 font-mono text-[11px] text-[#a1a1aa]">
              <GitBranch className="h-3 w-3 text-[#71717a]" />
              {activeSession.branch_name}
            </span>
          </div>

          {/* Right Header Controls: Diff Stat Trigger & Terminal Toggle */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                if (drawerOpen && drawerTab === "diff") setDrawerOpen(false);
                else {
                  setDrawerTab("diff");
                  setDrawerOpen(true);
                }
              }}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[11.5px] transition-colors ${
                drawerOpen && drawerTab === "diff"
                  ? "bg-[#222228] text-[#f4f4f5]"
                  : "text-[#a1a1aa] hover:bg-[#1a1a1f] hover:text-[#f4f4f5]"
              }`}
            >
              <span className="text-[#34d399]">+{activeSession.insertions}</span>
              <span className="text-[#f87171]">−{activeSession.deletions}</span>
            </button>

            <button
              onClick={() => {
                if (drawerOpen && drawerTab === "terminal") setDrawerOpen(false);
                else {
                  setDrawerTab("terminal");
                  setDrawerOpen(true);
                }
              }}
              title="Toggle Worktree Terminal (⌘J)"
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                drawerOpen && drawerTab === "terminal"
                  ? "bg-[#222228] text-[#f4f4f5]"
                  : "text-[#71717a] hover:bg-[#1a1a1f] hover:text-[#f4f4f5]"
              }`}
            >
              <Terminal className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Body Area: Centered Conversation Stream + On-Demand Right Drawer */}
        <div className="relative flex flex-1 overflow-hidden">
          <main className="flex flex-1 flex-col items-center overflow-hidden">
            {/* Scrollable Stream (Claude Code / Codex / Paseo Natural Proportions) */}
            <div className="w-full flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto flex max-w-[680px] flex-col gap-5">
                {activeEvents.map((ev) => {
                  // 1. User Message: Right-aligned soft bubble, no robotic header
                  if (ev.kind === "user") {
                    return (
                      <div key={ev.id} className="flex justify-end">
                        <div className="max-w-[82%] rounded-[18px] bg-[#1f1f24] px-4 py-2.5 text-[13.5px] leading-relaxed text-[#f4f4f5]">
                          {ev.content}
                        </div>
                      </div>
                    );
                  }

                  // 2. Thinking Trace: Quiet 1-line disclosure
                  if (ev.kind === "thinking") {
                    const isOpen = !!expandedThinking[ev.id];
                    return (
                      <div key={ev.id}>
                        <button
                          onClick={() =>
                            setExpandedThinking((p) => ({ ...p, [ev.id]: !isOpen }))
                          }
                          className="flex items-center gap-1.5 text-left text-[12.5px] text-[#71717a] transition-colors hover:text-[#a1a1aa]"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          <span>Thought for a moment</span>
                        </button>
                        {isOpen && (
                          <div className="mt-2 border-l-2 border-[#232329] pl-3.5 text-[12.5px] leading-relaxed text-[#71717a]">
                            {ev.content}
                          </div>
                        )}
                      </div>
                    );
                  }

                  // 3. Tool Call: Clean inline row with IndentRail
                  if (ev.kind === "tool_call") {
                    const isExpanded = !!expandedTools[ev.id];
                    return (
                      <div key={ev.id} className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => openDiffForFile(ev.tool_args)}
                            className="group inline-flex items-center gap-2 rounded-lg border border-[#222228] bg-[#16161a] px-3 py-1.5 font-mono text-[12px] text-[#d4d4d8] transition-colors hover:border-[#34343d] hover:bg-[#1b1b20]"
                          >
                            <FileCode2 className="h-3.5 w-3.5 text-[#71717a]" />
                            <span className="text-[#71717a]">{ev.tool_name}</span>
                            <span className="text-[#f4f4f5]">{ev.tool_args}</span>
                            <span className="text-[#34d399]">+24</span>
                            <span className="text-[#f87171]">−3</span>
                          </button>

                          <button
                            onClick={() =>
                              setExpandedTools((p) => ({ ...p, [ev.id]: !isExpanded }))
                            }
                            className="text-[11.5px] text-[#52525b] hover:text-[#a1a1aa]"
                          >
                            {isExpanded ? "Hide" : "Preview"}
                          </button>
                        </div>

                        {isExpanded && (
                          <pre className="overflow-x-auto rounded-lg border border-[#1f1f24] bg-[#0c0c0e] p-3 font-mono text-[11.5px] leading-relaxed text-[#a1a1aa]">
                            {ev.content}
                          </pre>
                        )}
                      </div>
                    );
                  }

                  // 4. Assistant Response: Clean left-aligned prose
                  return (
                    <div
                      key={ev.id}
                      className="whitespace-pre-line text-[13.5px] leading-[1.68] text-[#e4e4e7]"
                    >
                      {ev.content}
                    </div>
                  );
                })}
                <div ref={streamEndRef} />
              </div>
            </div>

            {/* ===============================================================
                4. AUTHENTIC COMPOSER DOCK (Rounded Surface + Circular Submit Disc)
               =============================================================== */}
            <div className="w-full px-6 pb-5 pt-1">
              <div className="mx-auto max-w-[680px]">
                {slashFilter !== null && (
                  <div className="mb-2 overflow-hidden rounded-xl border border-[#27272e] bg-[#16161a] p-1.5 shadow-xl">
                    {SLASH_SKILLS.filter((s) =>
                      s.cmd.toLowerCase().includes(slashFilter)
                    ).map((skill) => (
                      <button
                        key={skill.cmd}
                        onClick={() => handleSendPrompt(`${skill.cmd} `)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[12.5px] hover:bg-[#222228]"
                      >
                        <span className="font-mono font-medium text-[#f4f4f5]">
                          {skill.cmd}
                        </span>
                        <span className="text-[12px] text-[#71717a]">{skill.desc}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="rounded-[18px] border border-[#27272e] bg-[#16161a] px-4 pb-2.5 pt-3 shadow-lg transition-colors focus-within:border-[#3f3f46]">
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
                    placeholder={`Prompt ${activeSession.model_short}... (type / for commands)`}
                    className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-[#f4f4f5] placeholder-[#52525b] focus:outline-none"
                  />

                  {/* Composer Bottom Toolbar */}
                  <div className="mt-1.5 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setActiveModal("command")}
                        className="flex items-center gap-1 rounded-full bg-[#202026] px-2.5 py-1 text-[11.5px] font-medium text-[#d4d4d8] transition-colors hover:bg-[#27272f]"
                      >
                        <span>{activeSession.model}</span>
                        <ChevronDown className="h-3 w-3 text-[#71717a]" />
                      </button>

                      <span className="rounded-full px-2.5 py-1 text-[11.5px] text-[#71717a]">
                        {activeSession.approval_mode === "auto_edit"
                          ? "Auto-edit"
                          : "Ask permissions"}
                      </span>

                      <button
                        onClick={() => handleSendPrompt("/handoff")}
                        className="rounded-full px-2 py-1 font-mono text-[11px] text-[#71717a] hover:bg-[#202026] hover:text-[#d4d4d8]"
                      >
                        /handoff
                      </button>
                    </div>

                    {/* Signature Circular Submit Disc (Paseo / Claude Code / Codex) */}
                    <button
                      onClick={() => handleSendPrompt()}
                      disabled={!prompt.trim()}
                      className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${
                        prompt.trim()
                          ? "bg-[#f4f4f5] text-[#09090b] hover:opacity-90 cursor-pointer"
                          : "bg-[#27272e] text-[#52525b] cursor-default"
                      }`}
                    >
                      <ArrowUp className="h-4 w-4 stroke-[2.25]" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </main>

          {/* =================================================================
              5. ON-DEMAND SLIDE-OVER DIFF & TERMINAL DRAWER (Right Side)
             ================================================================= */}
          <aside
            className={`flex flex-col overflow-hidden bg-[#0c0c0e] border-l border-[#1f1f23] transition-all duration-200 ease-out ${
              drawerOpen ? "w-[440px] opacity-100" : "w-0 border-l-0 opacity-0"
            }`}
          >
            <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-[#1f1f23] px-3.5">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setDrawerTab("diff")}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    drawerTab === "diff"
                      ? "bg-[#1f1f25] text-[#f4f4f5]"
                      : "text-[#71717a] hover:text-[#a1a1aa]"
                  }`}
                >
                  Changes ({DEMO_DIFF_FILES.length})
                </button>
                <button
                  onClick={() => setDrawerTab("terminal")}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    drawerTab === "terminal"
                      ? "bg-[#1f1f25] text-[#f4f4f5]"
                      : "text-[#71717a] hover:text-[#a1a1aa]"
                  }`}
                >
                  Terminal
                </button>
              </div>

              <button
                onClick={() => setDrawerOpen(false)}
                title="Close (Esc)"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[#71717a] hover:bg-[#18181c] hover:text-[#f4f4f5]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {drawerTab === "diff" ? (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="flex flex-wrap gap-1 border-b border-[#18181c] p-2.5">
                  {DEMO_DIFF_FILES.map((file) => {
                    const active = file.path === currentDiffFile.path;
                    return (
                      <button
                        key={file.path}
                        onClick={() => setSelectedDiffPath(file.path)}
                        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors ${
                          active
                            ? "bg-[#1f1f25] text-[#f4f4f5]"
                            : "text-[#71717a] hover:bg-[#16161a] hover:text-[#a1a1aa]"
                        }`}
                      >
                        <span>{file.path.split("/").pop()}</span>
                        <span className="text-[#34d399]">+{file.additions}</span>
                        <span className="text-[#f87171]">−{file.deletions}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between border-b border-[#18181c] px-3.5 py-2 font-mono text-[11px] text-[#71717a]">
                  <span className="truncate">{currentDiffFile.path}</span>
                  <button
                    onClick={() =>
                      copyText(
                        currentDiffFile.path,
                        currentDiffFile.hunks.map((h) => h.content).join("\n")
                      )
                    }
                    className="flex items-center gap-1 hover:text-[#f4f4f5]"
                  >
                    {copiedKey === currentDiffFile.path ? (
                      <Check className="h-3 w-3 text-[#34d399]" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </div>

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
                      <div key={idx} className={`flex px-3.5 py-0.5 ${rowClass}`}>
                        <span className="w-8 shrink-0 select-none pr-3 text-right opacity-40">
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
              <div className="flex flex-1 flex-col overflow-hidden p-3.5 font-mono text-[11.5px]">
                <div className="flex-1 space-y-1.5 overflow-y-auto text-[#d4d4d8]">
                  {termLines.map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("$") ? "font-medium text-[#f4f4f5]" : "text-[#71717a]"
                      }
                    >
                      {line}
                    </div>
                  ))}
                </div>
                <form
                  onSubmit={handleRunTermCommand}
                  className="mt-2 flex items-center gap-2 border-t border-[#1f1f23] pt-2.5"
                >
                  <span className="text-[#71717a]">$</span>
                  <input
                    value={termInput}
                    onChange={(e) => setTermInput(e.target.value)}
                    placeholder="Run command in worktree..."
                    className="flex-1 bg-transparent text-[#f4f4f5] placeholder-[#52525b] focus:outline-none"
                  />
                </form>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* =====================================================================
          6. MODALS
         ===================================================================== */}
      {activeModal && (
        <div
          onClick={() => setActiveModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[420px] rounded-xl border border-[#27272e] bg-[#141417] p-5 shadow-2xl"
          >
            {activeModal === "new-worktree" && (
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-[#f4f4f5]">
                    New thread
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[#71717a] hover:text-[#f4f4f5]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-3 text-[12.5px]">
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[#a1a1aa]">
                      Project
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {repos.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => setTargetRepoIdForNewWt(r.id)}
                          className={`truncate rounded-lg border px-2.5 py-1.5 text-[12px] ${
                            targetRepoIdForNewWt === r.id
                              ? "border-[#f4f4f5] bg-[#1f1f25] text-[#f4f4f5]"
                              : "border-[#27272e] text-[#71717a]"
                          }`}
                        >
                          {r.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[#a1a1aa]">
                      Task title
                    </label>
                    <input
                      value={newTaskDesc}
                      onChange={(e) => setNewTaskDesc(e.target.value)}
                      className="w-full rounded-lg border border-[#27272e] bg-[#0c0c0e] px-3 py-2 text-[12.5px] text-[#f4f4f5] focus:border-[#52525b] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[#a1a1aa]">
                      Worktree branch
                    </label>
                    <input
                      value={newTaskName}
                      onChange={(e) => setNewTaskName(e.target.value)}
                      className="w-full rounded-lg border border-[#27272e] bg-[#0c0c0e] px-3 py-2 font-mono text-[12px] text-[#f4f4f5] focus:border-[#52525b] focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      onClick={() => setActiveModal(null)}
                      className="rounded-lg px-3 py-1.5 text-[12.5px] text-[#a1a1aa] hover:bg-[#1f1f25]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateWorktree}
                      className="rounded-lg bg-[#f4f4f5] px-4 py-1.5 text-[12.5px] font-medium text-[#09090b] hover:opacity-90"
                    >
                      Start thread
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeModal === "new-repo" && (
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-[#f4f4f5]">
                    Add project
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[#71717a] hover:text-[#f4f4f5]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-3 text-[12.5px]">
                  <input
                    value={newRepoPath}
                    onChange={(e) => setNewRepoPath(e.target.value)}
                    placeholder="/path/to/git/repo"
                    className="w-full rounded-lg border border-[#27272e] bg-[#0c0c0e] px-3 py-2 font-mono text-[12px] text-[#f4f4f5] focus:outline-none"
                  />
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      onClick={() => setActiveModal(null)}
                      className="rounded-lg px-3 py-1.5 text-[12.5px] text-[#a1a1aa]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateRepo}
                      className="rounded-lg bg-[#f4f4f5] px-4 py-1.5 text-[12.5px] font-medium text-[#09090b]"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeModal === "command" && (
              <div>
                <div className="mb-3 flex items-center gap-2 border-b border-[#222228] pb-2.5">
                  <Search className="h-4 w-4 text-[#71717a]" />
                  <input
                    autoFocus
                    value={cmdQuery}
                    onChange={(e) => setCmdQuery(e.target.value)}
                    placeholder="Type a command or search threads..."
                    className="w-full bg-transparent text-[13px] text-[#f4f4f5] focus:outline-none"
                  />
                </div>
                <div className="space-y-1 text-[12.5px]">
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        setActiveId(s.id);
                        setActiveModal(null);
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-[#1f1f25]"
                    >
                      <span className="truncate text-[#f4f4f5]">{s.title}</span>
                      <span className="font-mono text-[11px] text-[#71717a]">
                        {s.branch_name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(activeModal === "skills" || activeModal === "qr") && (
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-[13.5px] font-semibold text-[#f4f4f5]">
                    {activeModal === "qr" ? "Mobile E2EE Pairing" : "Automations & Skills"}
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[#71717a] hover:text-[#f4f4f5]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {activeModal === "qr" ? (
                  <div className="space-y-2 font-mono text-[11.5px] text-[#a1a1aa]">
                    <p>X25519 + ChaCha20-Poly1305 E2EE Relay:</p>
                    <div className="rounded-lg border border-[#27272e] bg-[#0c0c0e] p-3 text-[#f4f4f5]">
                      velo://pair?daemon=127.0.0.1:6767&fp=9F8B-441A-E2EE
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {SLASH_SKILLS.map((s) => (
                      <button
                        key={s.cmd}
                        onClick={() => {
                          setActiveModal(null);
                          handleSendPrompt(s.cmd);
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-[#1f1f25]"
                      >
                        <span className="font-mono text-[12px] font-medium text-[#f4f4f5]">
                          {s.cmd}
                        </span>
                        <span className="text-[12px] text-[#71717a]">{s.desc}</span>
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
