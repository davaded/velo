import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentEvent,
  AgentKind,
  ApprovalMode,
  DEMO_DIFF_FILES,
  DEMO_EVENTS,
  DEMO_REPOS,
  DEMO_SESSIONS,
  DiffFileItem,
  EffortLevel,
  MODEL_CATALOG,
  ModelOption,
  SLASH_SKILLS,
  VeloRepo,
  VeloSession,
  normalizeToVeloSession,
} from "./mockData";
import { parseUnifiedDiff } from "./utils/diffParser";
import {
  BeautifulApprovalCard,
  BeautifulContextMeter,
  BeautifulThinkingBlock,
  BeautifulToolCallCard,
} from "./components/ui/BeautifulAgentPrimitives";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Copy,
  FileCode2,
  Folder,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Layers,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldAlert,
  SquarePen,
  Sun,
  Terminal,
  X,
} from "lucide-react";

type VariantId = "a" | "b" | "c";
type ThemeMode = "system" | "light" | "dark";
type ToneId = "zinc" | "claude" | "paseo";
type DrawerTab = "diff" | "terminal";
type ModalKind =
  | null
  | "new-worktree"
  | "new-repo"
  | "command"
  | "skills"
  | "qr"
  | "settings";

interface PairingTicketDto {
  relay_url: string;
  daemon_addr: string;
  session_token: string;
  public_key_b64: string;
  uri: string;
  qr_svg: string;
}

interface LocalRuntimeDto {
  id: string;
  name: string;
  available: boolean;
  version?: string | null;
  binary_path?: string | null;
}

interface PendingApprovalItem {
  id: string;
  command: string;
  reason: string;
}

const DEFAULT_PENDING_BY_SESSION: Record<string, PendingApprovalItem> = {};

export function App() {
  const [daemonUrl] = useState<string>(() => {
    const origin = window.location.origin;
    if (origin.includes(":6767")) return origin;
    return "http://127.0.0.1:6767";
  });

  const [isMacDesktop] = useState<boolean>(() => {
    const w = window as unknown as Record<string, unknown>;
    return (
      Boolean(w.__TAURI_INTERNALS__) ||
      Boolean(w.__VELO_MACOS_APP__) ||
      window.location.search.includes("desktop=1")
    );
  });

  const [variant, setVariant] = useState<VariantId>("a");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("velo.themeMode");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "system";
  });
  const [tone, setTone] = useState<ToneId>(() => {
    const saved = localStorage.getItem("velo.tone");
    if (saved === "zinc" || saved === "claude" || saved === "paseo") return saved;
    return "zinc";
  });
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true
  );

  // Listen to macOS / OS system color-scheme changes in real time
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "light" | "dark" =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    localStorage.setItem("velo.themeMode", themeMode);
    localStorage.setItem("velo.tone", tone);
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    document.documentElement.setAttribute("data-tone", tone);

    // Sync native macOS NSWindow appearance when running inside Velo.app
    const w = window as unknown as {
      webkit?: { messageHandlers?: { windowTheme?: { postMessage: (m: string) => void } } };
    };
    w.webkit?.messageHandlers?.windowTheme?.postMessage(themeMode);
  }, [themeMode, tone, resolvedTheme]);

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const [repos, setRepos] = useState<VeloRepo[]>(() => {
    try {
      const saved = localStorage.getItem("velo.repos.v2");
      if (saved) {
        const parsed = JSON.parse(saved) as VeloRepo[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return DEMO_REPOS;
  });
  const [targetRepoIdForNewWt, setTargetRepoIdForNewWt] = useState<string>(DEMO_REPOS[0].id);

  // Core Sessions & Events (Persisted across restarts; auto-migrate outdated model IDs)
  const [sessions, setSessions] = useState<VeloSession[]>(() => {
    try {
      const saved = localStorage.getItem("velo.sessions.v2");
      if (saved) {
        const parsed = JSON.parse(saved) as VeloSession[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((s) => {
            const valid = MODEL_CATALOG.find((m) => m.id === s.model);
            if (valid) return s;
            const fallback =
              s.agent_kind === "codex"
                ? MODEL_CATALOG.find((m) => m.id === "gpt-6.1-sol")!
                : MODEL_CATALOG.find((m) => m.id === "claude-fable-5-2")!;
            return {
              ...s,
              model: fallback.id,
              model_short: fallback.shortLabel,
            };
          });
        }
      }
    } catch {
      // ignore
    }
    return DEMO_SESSIONS;
  });
  const [activeId, setActiveId] = useState<string>(() => {
    return localStorage.getItem("velo.activeId.v2") || DEMO_SESSIONS[0].id;
  });
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[]>>(() => {
    try {
      const saved = localStorage.getItem("velo.events.v2");
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, AgentEvent[]>;
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch {
      // ignore
    }
    return DEMO_EVENTS;
  });

  useEffect(() => {
    try {
      localStorage.setItem("velo.repos.v2", JSON.stringify(repos));
    } catch {
      // ignore
    }
  }, [repos]);

  useEffect(() => {
    try {
      localStorage.setItem("velo.sessions.v2", JSON.stringify(sessions));
    } catch {
      // ignore
    }
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem("velo.activeId.v2", activeId);
  }, [activeId]);

  useEffect(() => {
    try {
      localStorage.setItem("velo.events.v2", JSON.stringify(eventsBySession));
    } catch {
      // ignore
    }
  }, [eventsBySession]);

  const [connected, setConnected] = useState<boolean>(false);
  const [runtimes, setRuntimes] = useState<LocalRuntimeDto[]>([
    { id: "claude", name: "Claude Code", available: true, version: "2.1.317 (Claude Code)" },
    { id: "codex", name: "OpenAI Codex", available: true, version: "codex-cli 0.154.0" },
  ]);
  const [modelCatalog, setModelCatalog] = useState<ModelOption[]>(MODEL_CATALOG);
  const [modelPickerOpen, setModelPickerOpen] = useState<boolean>(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState<boolean>(false);

  // Live Diff & Worktree Files per Session
  const [diffsBySession, setDiffsBySession] = useState<Record<string, DiffFileItem[]>>({});
  const [diffLoading, setDiffLoading] = useState<boolean>(false);

  // On-Demand Right Drawer State
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("diff");
  const [selectedDiffPath, setSelectedDiffPath] = useState<string>("");

  // One-click Commit bar inside Changes Drawer
  const [commitBoxOpen, setCommitBoxOpen] = useState<boolean>(false);
  const [commitMsg, setCommitMsg] = useState<string>("feat: checkpoint isolated worktree changes");
  const [gitActionNotice, setGitActionNotice] = useState<string | null>(null);

  // Inline Diff Line Review Comment State
  const [diffCommentIdx, setDiffCommentIdx] = useState<number | null>(null);
  const [diffCommentText, setDiffCommentText] = useState<string>("");

  // Open in External IDE Menu State
  const [openInMenuOpen, setOpenInMenuOpen] = useState<boolean>(false);

  // Phase 3 Dispatch Mode (Single / Committee Race / TDD Loop)
  const [dispatchMode, setDispatchMode] = useState<"single" | "committee" | "loop">("single");
  const [loopCheckCmd, setLoopCheckCmd] = useState<string>("cargo test --workspace --offline");

  // Phase 4 Mobile Remote Controller Mode (?mobile=1 or preview toggle)
  const [mobileMode, setMobileMode] = useState<boolean>(() =>
    window.location.search.includes("mobile=1")
  );

  // Stream disclosure states & Inline User Message Editing state
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>("");

  // Human-in-the-Loop Pending Approvals per Session
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApprovalItem>>(
    DEFAULT_PENDING_BY_SESSION
  );

  // Clean Composer State (Natural language + slash skills; Agent explores worktree autonomously)
  const [prompt, setPrompt] = useState<string>("");
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Modals & E2EE Pairing Ticket
  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [pairTicket, setPairTicket] = useState<PairingTicketDto | null>(null);
  const [cmdQuery, setCmdQuery] = useState<string>("");
  const [newTaskName, setNewTaskName] = useState<string>("feat/new-thread");
  const [newTaskDesc, setNewTaskDesc] = useState<string>("");
  const [newModelId, setNewModelId] = useState<string>("claude-fable-5-2");
  const [newApproval] = useState<ApprovalMode>("auto_edit");
  const [newRepoPath, setNewRepoPath] = useState<string>("/Users/daiyudai/code/velo");

  // Terminal State inside Drawer
  const [termLines, setTermLines] = useState<string[]>([
    "$ velo status --worktrees",
    "  Ready to execute commands inside the active isolated Git worktree.",
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
    () => eventsBySession[activeSession.id] || [],
    [eventsBySession, activeSession.id]
  );

  const activeDiffFiles = useMemo(
    () => diffsBySession[activeSession.id] || [],
    [diffsBySession, activeSession.id]
  );

  // Fetch live sessions and detected local CLI runtimes from Velo Daemon
  const refreshSessions = useCallback(() => {
    fetch(`${daemonUrl}/api/sessions`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((list: unknown) => {
        setConnected(true);
        if (Array.isArray(list)) {
          // Ignore legacy /tmp/velo_demo_agent.sh test sessions
          const realItems = list.filter((raw) => {
            if (!raw || typeof raw !== "object") return false;
            const p = (raw as Record<string, unknown>).provider;
            if (p && typeof p === "object" && "custom" in (p as Record<string, unknown>)) {
              const c = String((p as Record<string, unknown>).custom ?? "");
              if (c.includes("velo_demo_agent")) return false;
            }
            return true;
          });
          const normalized = realItems.map((item, idx) => normalizeToVeloSession(item, idx));
          const runningDaemonIds = new Set(
            normalized.filter((n) => n.status === "running").map((n) => n.id)
          );
          setSessions((prev) => {
            const prevById = new Map(prev.map((s) => [s.id, s]));
            const merged = normalized.map((n) => {
              const existing = prevById.get(n.id);
              if (!existing) return n;
              return {
                ...n,
                title: existing.title || n.title,
                repo_id: existing.repo_id || n.repo_id,
                agent_kind: existing.agent_kind || n.agent_kind,
                model: existing.model || n.model,
                model_short: existing.model_short || n.model_short,
                effort: existing.effort || n.effort,
              };
            });
            const mergedIds = new Set(merged.map((s) => s.id));
            const remainingLocal = prev
              .filter((d) => !mergedIds.has(d.id))
              .map((d) =>
                d.status === "running" && !runningDaemonIds.has(d.id)
                  ? { ...d, status: "idle" as const, updated_at: "now" }
                  : d
              );
            const combined = [...merged, ...remainingLocal];
            return combined.length > 0 ? combined : prev;
          });
        }
      })
      .catch(() => setConnected(false));

    fetch(`${daemonUrl}/api/runtimes`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { runtimes?: LocalRuntimeDto[] }) => {
        if (Array.isArray(data.runtimes) && data.runtimes.length > 0) {
          setRuntimes(data.runtimes);
        }
      })
      .catch(() => {});

    fetch(`${daemonUrl}/api/models`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { models?: ModelOption[] }) => {
        if (Array.isArray(data.models) && data.models.length > 0) {
          setModelCatalog(data.models);
        }
      })
      .catch(() => {});
  }, [daemonUrl]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Fetch live unified git diff whenever activeSession changes
  const refreshSessionDiffAndFiles = useCallback(
    async (sessionId: string) => {
      setDiffLoading(true);
      try {
        const diffRes = await fetch(`${daemonUrl}/api/sessions/${sessionId}/diff`).catch(
          () => null
        );

        if (diffRes && diffRes.ok) {
          const data = (await diffRes.json()) as { diff?: string };
          if (data.diff && data.diff.trim().length > 0) {
            const parsed = parseUnifiedDiff(data.diff);
            if (parsed.length > 0) {
              const converted: DiffFileItem[] = parsed.map((pf) => ({
                path: pf.filePath,
                additions: pf.additions,
                deletions: pf.deletions,
                hunks: pf.lines.map((ln) => ({
                  type: ln.type === "add" ? "add" : ln.type === "del" ? "del" : "ctx",
                  oldLine: ln.oldNumber ?? undefined,
                  newLine: ln.newNumber ?? undefined,
                  content: ln.content,
                })),
              }));
              setDiffsBySession((prev) => ({ ...prev, [sessionId]: converted }));
              setSelectedDiffPath(converted[0].path);
            }
          }
        }
      } finally {
        setDiffLoading(false);
      }
    },
    [daemonUrl]
  );

  useEffect(() => {
    refreshSessionDiffAndFiles(activeSession.id);
  }, [activeSession.id, refreshSessionDiffAndFiles]);

  // Fetch E2EE Pairing Ticket when QR modal opens
  useEffect(() => {
    if (activeModal !== "qr") return;
    fetch(`${daemonUrl}/api/pair`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((ticket: PairingTicketDto) => setPairTicket(ticket))
      .catch(() => {});
  }, [activeModal, daemonUrl]);

  // Subscribe to live WebSocket events from real Claude Code / Codex CLI turns
  useEffect(() => {
    const wsUrl = `${daemonUrl.replace(/^http/, "ws")}/ws`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (msg) => {
        try {
          const raw = JSON.parse(msg.data) as Record<string, unknown>;
          const now = new Date().toLocaleTimeString([], { hour12: false });

          // Handle WsServerMessage::Event { event: AgentEvent }
          const evObj =
            raw.kind === "event" && raw.event && typeof raw.event === "object"
              ? (raw.event as Record<string, unknown>)
              : raw;

          const evType = String(evObj.type ?? "");
          const sid = String(evObj.session_id ?? "");
          if (!sid) return;

          if (evType === "status_changed") {
            const st = String(evObj.status ?? "");
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sid
                  ? {
                      ...s,
                      status:
                        st === "running"
                          ? "running"
                          : st === "waiting_for_permission"
                          ? "waiting_approval"
                          : "idle",
                      updated_at: "just now",
                    }
                  : s
              )
            );
            if (st === "completed") {
              refreshSessionDiffAndFiles(sid);
              fetch(`${daemonUrl}/api/sessions/${sid}/events`)
                .then((r) => (r.ok ? r.json() : Promise.reject()))
                .then((evList: Array<Record<string, unknown>>) => {
                  if (!Array.isArray(evList)) return;
                  const texts = evList
                    .filter((e) => e.type === "message_delta" && typeof e.text === "string")
                    .map((e) => String(e.text).trim())
                    .filter(Boolean);
                  if (texts.length === 0) return;
                  const combined = texts.join("\n");
                  setEventsBySession((prev) => {
                    const list = prev[sid] || [];
                    const hasReply = list.some(
                      (item) => item.kind === "assistant" && item.content.includes(texts[texts.length - 1])
                    );
                    if (hasReply) return prev;
                    return {
                      ...prev,
                      [sid]: [
                        ...list,
                        {
                          id: `as-sync-${Date.now()}`,
                          session_id: sid,
                          timestamp: now,
                          kind: "assistant",
                          content: combined,
                        },
                      ],
                    };
                  });
                })
                .catch(() => {});
            }
            return;
          }

          if (evType === "diff_updated" && evObj.stats && typeof evObj.stats === "object") {
            const st = evObj.stats as Record<string, unknown>;
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sid
                  ? {
                      ...s,
                      files_changed: Number(st.files_changed ?? s.files_changed),
                      insertions: Number(st.insertions ?? s.insertions),
                      deletions: Number(st.deletions ?? s.deletions),
                    }
                  : s
              )
            );
            refreshSessionDiffAndFiles(sid);
            return;
          }

          if (evType === "thinking_delta") {
            const text = String(evObj.text ?? "").trim();
            if (!text) return;
            setEventsBySession((prev) => {
              const list = prev[sid] || [];
              const last = list[list.length - 1];
              if (last && last.kind === "thinking") {
                const updatedLast = { ...last, content: `${last.content}\n${text}` };
                return { ...prev, [sid]: [...list.slice(0, -1), updatedLast] };
              }
              return {
                ...prev,
                [sid]: [
                  ...list,
                  {
                    id: `th-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                    session_id: sid,
                    timestamp: now,
                    kind: "thinking",
                    content: text,
                  },
                ],
              };
            });
            return;
          }

          if (evType === "tool_call_requested") {
            const toolName = String(evObj.tool_name ?? "Tool");
            const argsObj = (
              evObj.arguments && typeof evObj.arguments === "object" ? evObj.arguments : {}
            ) as Record<string, unknown>;
            const argSummary = String(
              argsObj.file_path ??
                argsObj.path ??
                argsObj.command ??
                argsObj.pattern ??
                JSON.stringify(argsObj).slice(0, 80)
            );
            const toolEv: AgentEvent = {
              id: String(evObj.tool_id ?? `tl-${Date.now()}`),
              session_id: sid,
              timestamp: now,
              kind: "tool_call",
              tool_name: toolName,
              tool_args: argSummary,
              tool_input: argsObj,
              tool_output: undefined,
              tool_is_error: false,
              content: JSON.stringify(argsObj, null, 2),
            };
            setEventsBySession((prev) => ({
              ...prev,
              [sid]: [...(prev[sid] || []), toolEv],
            }));
            return;
          }

          if (evType === "tool_call_completed") {
            const toolId = String(evObj.tool_id ?? "");
            const output = String(evObj.output ?? "(completed)");
            const isError = Boolean(evObj.is_error);
            setEventsBySession((prev) => {
              const list = prev[sid] || [];
              let idx = list.findIndex((item) => item.id === toolId);
              if (idx === -1) {
                // Fallback to the latest pending tool_call in this session
                for (let i = list.length - 1; i >= 0; i--) {
                  if (list[i].kind === "tool_call" && list[i].tool_output === undefined) {
                    idx = i;
                    break;
                  }
                }
              }
              if (idx !== -1) {
                const next = [...list];
                next[idx] = {
                  ...next[idx],
                  content: output,
                  tool_output: output,
                  tool_is_error: isError,
                };
                return { ...prev, [sid]: next };
              }
              return prev;
            });
            return;
          }

          if (evType === "message_delta") {
            const text = String(evObj.text ?? "");
            if (!text.trim()) return;
            setEventsBySession((prev) => {
              const list = prev[sid] || [];
              const last = list[list.length - 1];
              if (last && last.kind === "assistant") {
                const updatedLast = {
                  ...last,
                  content: last.content.includes(text)
                    ? last.content
                    : `${last.content}\n${text}`.trim(),
                };
                return { ...prev, [sid]: [...list.slice(0, -1), updatedLast] };
              }
              return {
                ...prev,
                [sid]: [
                  ...list,
                  {
                    id: `as-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                    session_id: sid,
                    timestamp: now,
                    kind: "assistant",
                    content: text,
                  },
                ],
              };
            });
            setTimeout(() => {
              streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
            }, 30);
            return;
          }

          if (evType === "error") {
            const errText = String(evObj.error ?? "Agent execution error");
            setEventsBySession((prev) => ({
              ...prev,
              [sid]: [
                ...(prev[sid] || []),
                {
                  id: `err-${Date.now()}`,
                  session_id: sid,
                  timestamp: now,
                  kind: "assistant",
                  content: `⚠️ ${errText}`,
                },
              ],
            }));
            return;
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => setConnected(false);
    } catch {
      setConnected(false);
    }
    return () => {
      if (ws) ws.close();
    };
  }, [daemonUrl, refreshSessionDiffAndFiles]);

  // Global Shortcuts
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
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setActiveModal((m) => (m === "settings" ? null : "settings"));
      } else if (e.key === "Escape") {
        if (activeModal) setActiveModal(null);
        else if (slashFilter !== null) setSlashFilter(null);
        else if (modelPickerOpen) setModelPickerOpen(false);
        else if (effortPickerOpen) setEffortPickerOpen(false);
        else if (drawerOpen) setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeModal, drawerOpen, slashFilter, modelPickerOpen, effortPickerOpen]);

  const openDiffForFile = (filePath?: string) => {
    if (filePath) {
      const matched = activeDiffFiles.find(
        (f) => filePath.includes(f.path) || f.path.includes(filePath)
      );
      if (matched) setSelectedDiffPath(matched.path);
    }
    setDrawerTab("diff");
    setDrawerOpen(true);
  };

  // Composer input handler with `/` slash skills (Agent explores worktree files autonomously)
  const handlePromptChange = (val: string) => {
    setPrompt(val);
    if (val.startsWith("/")) {
      setSlashFilter(val.slice(1).toLowerCase());
      return;
    }
    setSlashFilter(null);
  };

  const handleSendPrompt = async (customText?: string, overridePriorEvents?: AgentEvent[]) => {
    const rawText = (customText ?? prompt).trim();
    if (!rawText) return;

    const text = rawText;

    setPrompt("");
    setSlashFilter(null);

    const now = new Date().toLocaleTimeString([], { hour12: false });
    const baseEvents = overridePriorEvents ?? (eventsBySession[activeSession.id] || []);
    const userEv: AgentEvent = {
      id: `u-${Date.now()}`,
      session_id: activeSession.id,
      timestamp: now,
      kind: "user",
      content: text,
    };

    const isSlashSpecial =
      rawText.startsWith("/handoff") ||
      rawText.startsWith("/advisor") ||
      rawText.startsWith("/committee") ||
      rawText.startsWith("/loop");

    const modelLabel =
      modelCatalog.find((m) => m.id === activeSession.model)?.label ||
      activeSession.model_short ||
      activeSession.model;

    const initThinkingEv: AgentEvent = {
      id: `th-init-${Date.now()}`,
      session_id: activeSession.id,
      timestamp: now,
      kind: "thinking",
      content: `Routing prompt to ${modelLabel} (${activeSession.effort || "medium"} effort) in ${activeSession.branch_name}...`,
    };

    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: isSlashSpecial
        ? [...baseEvents, userEv]
        : [...baseEvents, userEv, initThinkingEv],
    }));

    // Real Daemon /handoff endpoint
    if (rawText.startsWith("/handoff")) {
      try {
        const res = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/handoff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: rawText.replace("/handoff", "").trim() || null }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            summary_markdown?: string;
            new_session?: Record<string, unknown>;
          };
          const replyEv: AgentEvent = {
            id: `ho-${Date.now()}`,
            session_id: activeSession.id,
            timestamp: now,
            kind: "assistant",
            content:
              data.summary_markdown ||
              "Context compacted (`64k → 9.2k tokens`) and migrated to fresh worktree session.",
          };
          setEventsBySession((prev) => ({
            ...prev,
            [activeSession.id]: [...(prev[activeSession.id] || []), replyEv],
          }));
          refreshSessions();
          return;
        }
      } catch {
        // fallback below
      }
    }

    // Real Daemon /advisor endpoint
    if (rawText.startsWith("/advisor")) {
      try {
        const res = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/advisor`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            focus_question: rawText.replace("/advisor", "").trim() || null,
            advisor_provider: "claude",
          }),
        });
        if (res.ok) {
          refreshSessions();
          return;
        }
      } catch {
        // fallback below
      }
    }

    // Real Daemon /committee endpoint (Claude Code + Codex parallel race in 2 isolated worktrees)
    if (rawText.startsWith("/committee")) {
      const taskGoal =
        rawText.replace("/committee", "").trim() ||
        activeSession.title ||
        "Implement and verify feature in isolated worktree";
      try {
        const res = await fetch(`${daemonUrl}/api/committee`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name_prefix: "race",
            providers: ["claude", "codex"],
            prompt: taskGoal,
            repo_path: activeRepo.path,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { sessions?: unknown[] };
          const replyEv: AgentEvent = {
            id: `cm-${Date.now()}`,
            session_id: activeSession.id,
            timestamp: now,
            kind: "assistant",
            content: `Dispatched **Committee Race** (\`Claude Code\` + \`OpenAI Codex\`) in ${
              data.sessions?.length || 2
            } parallel isolated Git worktrees for: "${taskGoal}". Check the sidebar to compare their diffs side by side.`,
          };
          setEventsBySession((prev) => ({
            ...prev,
            [activeSession.id]: [...(prev[activeSession.id] || []), replyEv],
          }));
          refreshSessions();
          return;
        }
      } catch {
        // fallback below
      }
    }

    // Real Daemon /loop endpoint (Test-driven loop until check_command passes)
    if (rawText.startsWith("/loop")) {
      const taskGoal =
        rawText.replace("/loop", "").trim() ||
        activeSession.title ||
        "Fix failing tests and verify build";
      try {
        const res = await fetch(`${daemonUrl}/api/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `loop-${activeSession.branch_name.split("/").pop()}`,
            provider: activeSession.agent_kind === "codex" ? "codex" : "claude",
            prompt: taskGoal,
            check_command: loopCheckCmd,
            max_iterations: 3,
            repo_path: activeRepo.path,
            branch: `${activeSession.branch_name}-loop`,
          }),
        });
        if (res.ok) {
          const replyEv: AgentEvent = {
            id: `lp-${Date.now()}`,
            session_id: activeSession.id,
            timestamp: now,
            kind: "assistant",
            content: `Started **TDD Verification Loop** (acceptance check: \`${loopCheckCmd}\`, up to 3 iterations).`,
          };
          setEventsBySession((prev) => ({
            ...prev,
            [activeSession.id]: [...(prev[activeSession.id] || []), replyEv],
          }));
          refreshSessions();
          return;
        }
      } catch {
        // fallback below
      }
    }

    // Auto-title "New thread" from the user's first prompt
    const nextTitle =
      activeSession.title === "New thread" || !activeSession.title.trim()
        ? text.replace(/\s+/g, " ").slice(0, 44)
        : activeSession.title;

    // Build multi-turn context if there are prior messages in this thread
    const priorHistory = baseEvents
      .filter((ev) => ev.kind === "user" || ev.kind === "assistant")
      .slice(-6);
    const promptWithContext =
      priorHistory.length > 0
        ? `Previous conversation context in this worktree thread:\n${priorHistory
            .map((ev) => `${ev.kind === "user" ? "User" : "Assistant"}: ${ev.content}`)
            .join("\n\n")}\n\nCurrent User Request:\n${text}`
        : text;

    // Dispatch prompt to real local Claude Code / Codex CLI via Velo Daemon
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id
          ? { ...s, title: nextTitle, status: "running", updated_at: "running" }
          : s
      )
    );

    const providerName = activeSession.agent_kind === "codex" ? "codex" : "claude";

    try {
      // 1. Try sending input to existing daemon session with selected concrete model & effort
      const inputRes = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: promptWithContext,
          model: activeSession.model,
          effort: activeSession.effort || "medium",
          provider: providerName,
        }),
      });

      if (inputRes.ok) {
        setTimeout(() => {
          streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 50);
        return;
      }

      // 2. If activeSession was a local thread not yet on the daemon, promote it to a real daemon session
      const createRes = await fetch(`${daemonUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nextTitle,
          provider: providerName,
          prompt: promptWithContext,
          repo_path: activeRepo.path || "/Users/daiyudai/code/velo",
          branch: activeSession.branch_name,
          use_pty: false,
          model: activeSession.model,
          effort: activeSession.effort || "medium",
        }),
      });

      if (createRes.ok) {
        const rawCreated = await createRes.json();
        const realSess = normalizeToVeloSession(rawCreated, 0);
        realSess.repo_id = activeSession.repo_id;
        realSess.title = nextTitle;
        realSess.agent_kind = activeSession.agent_kind;
        realSess.model = activeSession.model;
        realSess.model_short = activeSession.model_short;
        realSess.effort = activeSession.effort || "medium";

        const oldId = activeSession.id;
        setSessions((prev) => prev.map((s) => (s.id === oldId ? realSess : s)));
        setEventsBySession((prev) => {
          const fromOld = (prev[oldId] || []).map((ev) => ({
            ...ev,
            session_id: realSess.id,
          }));
          const fromNew = prev[realSess.id] || [];
          const mergedList: AgentEvent[] = [];
          for (const item of [...fromOld, ...fromNew]) {
            const last = mergedList[mergedList.length - 1];
            if (last && last.kind === "thinking" && item.kind === "thinking") {
              mergedList[mergedList.length - 1] = {
                ...last,
                content: `${last.content}\n${item.content}`,
              };
            } else {
              mergedList.push(item);
            }
          }
          return {
            ...prev,
            [realSess.id]: mergedList,
          };
        });
        setActiveId(realSess.id);
        return;
      } else {
        const errData = (await createRes.json().catch(() => ({}))) as { error?: string };
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSession.id ? { ...s, status: "idle", updated_at: "now" } : s
          )
        );
        setEventsBySession((prev) => ({
          ...prev,
          [activeSession.id]: [
            ...(prev[activeSession.id] || []),
            {
              id: `err-${Date.now()}`,
              session_id: activeSession.id,
              timestamp: now,
              kind: "assistant",
              content: `⚠️ Failed to start session: ${errData.error || createRes.statusText}`,
            },
          ],
        }));
      }
    } catch {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSession.id ? { ...s, status: "idle", updated_at: "now" } : s
        )
      );
      setEventsBySession((prev) => ({
        ...prev,
        [activeSession.id]: [
          ...(prev[activeSession.id] || []),
          {
            id: `err-${Date.now()}`,
            session_id: activeSession.id,
            timestamp: now,
            kind: "assistant",
            content: "⚠️ Daemon unreachable on 127.0.0.1:6767. Please check Velo daemon status.",
          },
        ],
      }));
    }

    setTimeout(() => {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  // Stop currently running agent turn via POST /api/sessions/{id}/stop
  const handleStopSession = async () => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id ? { ...s, status: "idle", updated_at: "now" } : s
      )
    );
    // Finalize any in-flight tool_call spinner so it doesn't stay spinning after stopping
    setEventsBySession((prev) => {
      const list = prev[activeSession.id] || [];
      const updated = list.map((item) =>
        item.kind === "tool_call" && item.tool_output === undefined
          ? { ...item, tool_output: "(interrupted by user)", content: "(interrupted by user)" }
          : item
      );
      return { ...prev, [activeSession.id]: updated };
    });
    try {
      await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/stop`, {
        method: "POST",
      });
      refreshSessions();
    } catch {
      // ignore if local-only
    }
  };

  // User Message Actions: Click-to-edit & Resend, Retry from turn (Cursor / Claude Desktop / Codex standard)
  const handleStartEditMessage = (ev: AgentEvent) => {
    setEditingEventId(ev.id);
    setEditingText(ev.content);
  };

  const handleSaveAndResendEdit = async (ev: AgentEvent) => {
    const trimmed = editingText.trim();
    if (!trimmed) return;
    setEditingEventId(null);
    setEditingText("");
    if (activeSession.status === "running") {
      await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/stop`, {
        method: "POST",
      }).catch(() => {});
    }
    const currentList = eventsBySession[activeSession.id] || [];
    const idx = currentList.findIndex((item) => item.id === ev.id);
    const truncated = idx >= 0 ? currentList.slice(0, idx) : currentList;
    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: truncated,
    }));
    await handleSendPrompt(trimmed, truncated);
  };

  const handleRetryUserMessage = async (ev: AgentEvent) => {
    if (activeSession.status === "running") {
      await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/stop`, {
        method: "POST",
      }).catch(() => {});
    }
    const currentList = eventsBySession[activeSession.id] || [];
    const idx = currentList.findIndex((item) => item.id === ev.id);
    const truncated = idx >= 0 ? currentList.slice(0, idx) : currentList;
    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: truncated,
    }));
    await handleSendPrompt(ev.content, truncated);
  };

  // Delete / archive a thread from sidebar and daemon
  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const target = sessions.find((s) => s.id === sessionId);
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      if (remaining.length === 0) {
        const fallback: VeloSession = {
          ...DEMO_SESSIONS[0],
          id: `wt-${Date.now()}`,
          repo_id: target?.repo_id || repos[0]?.id || "repo-velo",
        };
        setActiveId(fallback.id);
        return [fallback];
      }
      if (activeSession.id === sessionId) {
        setActiveId(remaining[0].id);
      }
      return remaining;
    });
    setEventsBySession((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    try {
      await fetch(`${daemonUrl}/api/sessions/${sessionId}?cleanup_worktree=false`, {
        method: "DELETE",
      });
    } catch {
      // ignore if local-only
    }
  };

  // Remove a project workspace from sidebar
  const handleRemoveRepo = (repoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (repos.length <= 1) return;
    setRepos((prev) => prev.filter((r) => r.id !== repoId));
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.repo_id !== repoId);
      if (remaining.length > 0 && activeSession.repo_id === repoId) {
        setActiveId(remaining[0].id);
      }
      return remaining.length > 0 ? remaining : DEMO_SESSIONS;
    });
  };

  // Real Worktree Command Execution via POST /api/sessions/{id}/exec
  const executeInWorktree = useCallback(
    async (command: string): Promise<{ stdout: string; stderr: string; exit_code: number }> => {
      try {
        const res = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            stdout: string;
            stderr: string;
            exit_code: number;
          };
          await refreshSessionDiffAndFiles(activeSession.id);
          refreshSessions();
          return data;
        }
      } catch {
        // fallback if session is local demo
      }
      return {
        stdout: `Executed '${command}' in ${activeSession.worktree_path}\nOn branch ${activeSession.branch_name} (+${activeSession.insertions} -${activeSession.deletions})`,
        stderr: "",
        exit_code: 0,
      };
    },
    [daemonUrl, activeSession, refreshSessionDiffAndFiles, refreshSessions]
  );

  // Human-in-the-Loop Permission Approval Actions
  const handleResolveApproval = async (action: "approve" | "always" | "deny") => {
    const pending = pendingApprovals[activeSession.id];
    if (!pending) return;

    setPendingApprovals((prev) => {
      const next = { ...prev };
      delete next[activeSession.id];
      return next;
    });

    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id
          ? {
              ...s,
              status: action === "deny" ? "idle" : "running",
              approval_mode: action === "always" ? "auto_edit" : s.approval_mode,
            }
          : s
      )
    );

    const now = new Date().toLocaleTimeString([], { hour12: false });
    if (action === "deny") {
      setEventsBySession((prev) => ({
        ...prev,
        [activeSession.id]: [
          ...(prev[activeSession.id] || []),
          {
            id: `perm-deny-${Date.now()}`,
            session_id: activeSession.id,
            timestamp: now,
            kind: "assistant",
            content: `Skipped command \`${pending.command}\` per user decision.`,
          },
        ],
      }));
      return;
    }

    const result = await executeInWorktree(pending.command);
    const output = (result.stdout || result.stderr || "Command completed (exit 0)").trim();
    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: [
        ...(prev[activeSession.id] || []),
        {
          id: `perm-tool-${Date.now()}`,
          session_id: activeSession.id,
          timestamp: now,
          kind: "tool_call",
          tool_name: "Bash",
          tool_args: pending.command,
          content: output,
          duration_ms: 64,
        },
        {
          id: `perm-ok-${Date.now() + 1}`,
          session_id: activeSession.id,
          timestamp: now,
          kind: "assistant",
          content: `Approved and executed \`${pending.command}\`${
            action === "always" ? " (Auto-edit enabled for this worktree)" : ""
          }.`,
        },
      ],
    }));
  };

  // Toggle approval mode or simulate permission prompt
  const handleToggleApprovalMode = () => {
    const nextMode: ApprovalMode =
      activeSession.approval_mode === "auto_edit" ? "ask_before_edit" : "auto_edit";
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id
          ? {
              ...s,
              approval_mode: nextMode,
              status: nextMode === "ask_before_edit" ? "waiting_approval" : s.status,
            }
          : s
      )
    );
    if (nextMode === "ask_before_edit" && !pendingApprovals[activeSession.id]) {
      setPendingApprovals((prev) => ({
        ...prev,
        [activeSession.id]: {
          id: `perm-${Date.now()}`,
          command: "cargo check --workspace --all-targets",
          reason: `Verify compilation across isolated worktree ${activeSession.branch_name}`,
        },
      }));
    }
  };

  // Create real isolated Git worktree (Single / Committee Race / TDD Loop)
  const handleCreateWorktree = async () => {
    const targetRepo = repos.find((r) => r.id === targetRepoIdForNewWt) || activeRepo;
    const clean = newTaskName.trim() || `feat/task-${sessions.length + 1}`;
    const branch =
      clean.startsWith("feat/") || clean.startsWith("fix/") || clean.startsWith("chore/")
        ? clean
        : `feat/${clean}`;
    const title = newTaskDesc.trim() || branch;
    const chosenModel = modelCatalog.find((m) => m.id === newModelId) || modelCatalog[0];
    const providerName = chosenModel.runtimeId === "codex" ? "codex" : "claude";

    try {
      if (dispatchMode === "committee") {
        const res = await fetch(`${daemonUrl}/api/committee`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name_prefix: clean.replace(/\//g, "-"),
            providers: ["claude", "codex"],
            prompt: title,
            repo_path: targetRepo.path,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { sessions?: unknown[] };
          if (Array.isArray(data.sessions) && data.sessions.length > 0) {
            const createdList = data.sessions.map((raw, i) => {
              const s = normalizeToVeloSession(raw, i);
              s.repo_id = targetRepo.id;
              return s;
            });
            setSessions((prev) => [...createdList, ...prev]);
            setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
            setActiveId(createdList[0].id);
            setActiveModal(null);
            return;
          }
        }
      } else if (dispatchMode === "loop") {
        const res = await fetch(`${daemonUrl}/api/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: title,
            provider: providerName,
            prompt: title,
            check_command: loopCheckCmd,
            max_iterations: 3,
            repo_path: targetRepo.path,
            branch,
          }),
        });
        if (res.ok) {
          const rawSession = await res.json();
          const created = normalizeToVeloSession(rawSession, 0);
          created.repo_id = targetRepo.id;
          created.title = `[Loop] ${title}`;
          created.agent_kind = chosenModel.agentKind;
          created.model = chosenModel.id;
          created.model_short = chosenModel.shortLabel;
          setSessions((prev) => [created, ...prev]);
          setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
          setActiveId(created.id);
          setActiveModal(null);
          return;
        }
      }

      const res = await fetch(`${daemonUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: title,
          provider: providerName,
          prompt: title,
          repo_path: targetRepo.path,
          branch,
          use_pty: false,
          model: chosenModel.id,
          effort: "medium",
        }),
      });
      if (res.ok) {
        const rawSession = await res.json();
        const created = normalizeToVeloSession(rawSession, 0);
        created.repo_id = targetRepo.id;
        created.title = title;
        created.agent_kind = chosenModel.agentKind;
        created.model = chosenModel.id;
        created.model_short = chosenModel.shortLabel;
        setSessions((prev) => [created, ...prev]);
        setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
        setActiveId(created.id);
        setActiveModal(null);
        return;
      }
    } catch {
      // fallback to local session creation if repo path is not initialized
    }

    const slug = branch.replace(/\//g, "-");
    const newId = `sess-${Date.now().toString().slice(-4)}`;
    const fallbackCreated: VeloSession = {
      id: newId,
      repo_id: targetRepo.id,
      title,
      agent_kind: chosenModel.agentKind,
      model: chosenModel.id,
      model_short: chosenModel.shortLabel,
      effort: "medium",
      status: "idle",
      branch_name: branch,
      worktree_path: `${targetRepo.path}/.velo/worktrees/${slug}`,
      project_path: targetRepo.path,
      approval_mode: newApproval,
      tokens_used: 0,
      tokens_limit: 200000,
      cost_usd: 0,
      files_changed: 0,
      insertions: 0,
      deletions: 0,
      updated_at: "ready",
    };

    setSessions((prev) => [fallbackCreated, ...prev]);
    setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
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

  const handlePickRepoFolder = async () => {
    try {
      const res = await fetch(`${daemonUrl}/api/pick-folder`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { path?: string };
        if (data.path) setNewRepoPath(data.path);
      }
    } catch {
      // ignore if cancelled
    }
  };

  const handleOpenInEditor = async (
    editor: "cursor" | "vscode" | "zed" | "finder" | "terminal"
  ) => {
    setOpenInMenuOpen(false);
    try {
      await fetch(`${daemonUrl}/api/open-editor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: activeSession.worktree_path,
          editor,
        }),
      });
    } catch {
      // ignore
    }
  };

  // Terminal Drawer Command Execution (Real Worktree Shell)
  const handleRunTermCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = termInput.trim();
    if (!cmd) return;
    setTermInput("");
    setTermLines((prev) => [...prev, `$ ${cmd}`]);
    const res = await executeInWorktree(cmd);
    const out = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n");
    setTermLines((prev) => [
      ...prev,
      ...(out ? out.split("\n") : [`(exit ${res.exit_code})`]),
    ]);
  };

  // One-click Commit inside isolated worktree
  const handleCommitWorktree = async () => {
    const msg = commitMsg.trim() || "feat: update worktree";
    const safeMsg = msg.replace(/"/g, '\\"');
    const res = await executeInWorktree(`git add -A && git commit -m "${safeMsg}"`);
    const summary = (res.stdout || res.stderr || "Committed changes in worktree").split("\n")[0];
    setGitActionNotice(summary);
    setCommitBoxOpen(false);
    setTimeout(() => setGitActionNotice(null), 4000);
  };

  // One-click Merge Readiness Check
  const handleMergeWorktree = async () => {
    const res = await executeInWorktree("git status -sb && git log -1 --oneline");
    const summary =
      res.stdout.trim().split("\n").join(" · ") ||
      `Branch ${activeSession.branch_name} ready to merge`;
    setGitActionNotice(`Ready: ${summary}`);
    setTimeout(() => setGitActionNotice(null), 4000);
  };

  const copyText = (key: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const currentDiffFile = useMemo(
    () => activeDiffFiles.find((f) => f.path === selectedDiffPath) || activeDiffFiles[0] || null,
    [activeDiffFiles, selectedDiffPath]
  );

  const tokenPercent = Math.min(
    100,
    Math.round(
      ((activeSession.tokens_used || 0) / (activeSession.tokens_limit || 200000)) * 100
    )
  );

  const activePendingApproval = pendingApprovals[activeSession.id];

  return (
    <div
      data-theme={resolvedTheme}
      data-tone={tone}
      className={`velo-variant-${variant} flex h-screen w-screen overflow-hidden select-none bg-[var(--v-bg-canvas)] text-[var(--v-fg-primary)]`}
    >
      {/* =====================================================================
          1. AUTHENTIC CODEX / CLAUDE CODE / PASEO LEFT SIDEBAR
             - Seamless matte surface (#0c0c0e), ZERO boxed cards or heavy lines
             - Top: quiet nav rows (New thread, Search, Automations)
             - Body: Workspaces section -> clean Project rows -> borderless Thread rows
             - Idle rows keep empty leading slot; only active/waiting rows show indicator
             - Bottom: single icon-only footer bar
         ===================================================================== */}
      <aside
        className={`flex shrink-0 flex-col justify-between bg-[var(--v-bg-sidebar)] border-r border-[var(--v-border-subtle)] transition-all duration-200 overflow-hidden ${
          sidebarOpen ? "w-[252px]" : "w-0 border-r-0"
        }`}
      >
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top Window Bar + Sidebar Toggle (Draggable for macOS Tauri Overlay Titlebar) */}
          <div
            data-tauri-drag-region
            className={`flex h-[42px] shrink-0 items-center justify-between pr-3 ${
              isMacDesktop ? "pl-[78px]" : "pl-3"
            }`}
          >
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSidebarOpen(false)}
                title="Hide sidebar (⌘B)"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              <span className="text-[13px] font-semibold tracking-tight text-[var(--v-fg-primary)]">
                Velo
              </span>
            </div>

            <button
              onClick={() => {
                setTargetRepoIdForNewWt(activeRepo.id);
                setActiveModal("new-worktree");
              }}
              title="New thread (⌘N)"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
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
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <Plus className="h-4 w-4 text-[var(--v-fg-muted)]" />
              <span>New thread</span>
            </button>
            <button
              onClick={() => setActiveModal("command")}
              className="flex h-[30px] w-full items-center justify-between rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <span className="flex items-center gap-2.5">
                <Search className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                <span>Search</span>
              </span>
              <span className="font-mono text-[11px] text-[var(--v-fg-faint)]">⌘K</span>
            </button>
            <button
              onClick={() => setActiveModal("skills")}
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <Layers className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
              <span>Automations & Skills</span>
            </button>
          </div>

          {/* Section Header: Workspaces */}
          <div className="flex items-center justify-between px-4 pb-1.5 pt-1">
            <span className="text-[11px] font-medium text-[var(--v-fg-muted)]">Workspaces</span>
          </div>

          {/* Scrollable Project -> Thread Hierarchy (Borderless, Clean Rows) */}
          <div className="flex-1 space-y-3 overflow-y-auto px-2 py-1">
            {repos.map((repo) => {
              const repoItems = sessions.filter((s) => s.repo_id === repo.id);
              const isCollapsed = !!collapsedRepos[repo.id];

              return (
                <div key={repo.id} className="space-y-0.5">
                  {/* Project Row */}
                  <div className="group flex h-[28px] items-center justify-between rounded-md px-2 text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-surface)] hover:text-[var(--v-fg-primary)]">
                    <button
                      onClick={() =>
                        setCollapsedRepos((prev) => ({
                          ...prev,
                          [repo.id]: !prev[repo.id],
                        }))
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)] group-hover:hidden" />
                      {isCollapsed ? (
                        <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)] group-hover:block" />
                      ) : (
                        <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)] group-hover:block" />
                      )}
                      <span className="truncate text-[13px] font-medium text-[var(--v-fg-body)] group-hover:text-[var(--v-fg-primary)]">
                        {repo.name}
                      </span>
                    </button>

                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => {
                          setTargetRepoIdForNewWt(repo.id);
                          setActiveModal("new-worktree");
                        }}
                        title={`New thread in ${repo.name}`}
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)]"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      {repos.length > 1 && (
                        <button
                          onClick={(e) => handleRemoveRepo(repo.id, e)}
                          title={`Remove ${repo.name} from workspaces`}
                          className="flex h-5 w-5 items-center justify-center rounded text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[#f87171]"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Thread Rows under Project */}
                  {!isCollapsed && (
                    <div className="space-y-0.5">
                      {repoItems.map((w) => {
                        const isSelected = w.id === activeSession.id;
                        const hasPending = !!pendingApprovals[w.id];
                        return (
                          <div
                            key={w.id}
                            onClick={() => setActiveId(w.id)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setActiveId(w.id);
                              }
                            }}
                            className={`group flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                              isSelected
                                ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                                : "text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-surface)] hover:text-[var(--v-fg-body)]"
                            }`}
                          >
                            {/* Leading Status Slot (14px wide, reserves space when idle just like Paseo/Codex) */}
                            <div className="mt-[4px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                              {hasPending || w.status === "waiting_approval" ? (
                                <span
                                  className="h-2 w-2 rounded-full bg-[#fbbf24]"
                                  title="Waiting for permission approval"
                                />
                              ) : w.status === "running" ? (
                                <span
                                  className="h-2.5 w-2.5 rounded-full border-[1.5px] border-[#34d399] border-t-transparent animate-spin"
                                  title="Running"
                                />
                              ) : null}
                            </div>

                            {/* Thread Content Column */}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline justify-between gap-1.5">
                                <span
                                  className={`truncate text-[13px] leading-snug ${
                                    isSelected ? "font-medium text-[var(--v-fg-primary)]" : "font-normal"
                                  }`}
                                >
                                  {w.title}
                                </span>
                                <div className="flex shrink-0 items-center gap-1">
                                  <span className="font-mono text-[11px] text-[var(--v-fg-faint)] group-hover:hidden">
                                    {w.updated_at}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => handleDeleteSession(w.id, e)}
                                    title="Archive / remove thread"
                                    className="hidden h-4 w-4 items-center justify-center rounded text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[#f87171] group-hover:flex"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              </div>

                              {/* Subtle Meta Line: Branch + Diff Stats */}
                              <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[11px] text-[var(--v-fg-muted)]">
                                <span className="truncate">{w.branch_name}</span>
                                {(w.insertions > 0 || w.deletions > 0) && (
                                  <span className="flex shrink-0 items-center gap-1 text-[10.5px]">
                                    <span className="text-[#34d399]/80">+{w.insertions}</span>
                                    <span className="text-[#f87171]/80">−{w.deletions}</span>
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
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
        <div className="flex h-[40px] shrink-0 items-center justify-between border-t border-[var(--v-border-subtle)] px-2.5 text-[var(--v-fg-muted)]">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveModal("new-repo")}
              title="Add project"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <FolderPlus className="h-4 w-4" />
            </button>
            <button
              onClick={() => setActiveModal("skills")}
              title={`Usage: ${tokenPercent}% context window`}
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <CircleGauge className="h-4 w-4" />
            </button>
            <button
              onClick={() => setActiveModal("qr")}
              title={`Local Daemon (${connected ? "Connected" : "Offline"}) & Mobile E2EE Pairing`}
              className="relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <Server className="h-4 w-4" />
              <span
                className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                style={{ background: connected ? "#34d399" : "#fbbf24" }}
              />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <div
              className="flex items-center rounded-md bg-[var(--v-bg-hover)] p-0.5"
              title={`Theme: ${themeMode} (active: ${resolvedTheme})`}
            >
              {(
                [
                  { id: "system", icon: Monitor, tip: "跟随系统 (System)" },
                  { id: "light", icon: Sun, tip: "浅色模式 (Light)" },
                  { id: "dark", icon: Moon, tip: "深色模式 (Dark)" },
                ] as const
              ).map(({ id, icon: Icon, tip }) => (
                <button
                  key={id}
                  onClick={() => setThemeMode(id)}
                  title={tip}
                  className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                    themeMode === id
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>

            <button
              onClick={() => setActiveModal("settings")}
              title="Appearance & Settings (⌘,)"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* =====================================================================
          2. MAIN WORKSPACE AREA (Clean Header + Natural Conversation + Docked Composer)
         ===================================================================== */}
      <div className="flex flex-1 flex-col overflow-hidden bg-[var(--v-bg-canvas)]">
        {/* Clean Minimal Workspace Header (42px) */}
        <header
          data-tauri-drag-region
          className={`flex h-[42px] shrink-0 items-center justify-between border-b border-[var(--v-border-subtle)] pr-4 ${
            isMacDesktop && !sidebarOpen ? "pl-[78px]" : "pl-4"
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                title="Show sidebar (⌘B)"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            )}
            <span className="truncate text-[13px] font-medium text-[var(--v-fg-primary)]">
              {activeSession.title}
            </span>
            <span
              title={activeSession.worktree_path}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--v-bg-hover)] px-2 py-0.5 font-mono text-[11px] text-[var(--v-fg-secondary)]"
            >
              <GitBranch className="h-3 w-3 text-[var(--v-fg-muted)]" />
              {activeSession.branch_name}
            </span>
          </div>

          {/* Right Header Controls: Open in IDE, Diff Stat Trigger & Terminal Toggle */}
          <div className="relative flex items-center gap-1.5">
            {mobileMode && (
              <button
                onClick={() => setMobileMode(false)}
                className="rounded-md bg-[#34d399]/15 px-2 py-1 font-mono text-[11px] font-medium text-[#34d399]"
              >
                Mobile Remote Active · Exit
              </button>
            )}

            <div className="relative">
              <button
                onClick={() => setOpenInMenuOpen((o) => !o)}
                title="Open isolated worktree in external IDE or Finder"
                className="flex items-center gap-1 rounded-md bg-[var(--v-bg-hover)] px-2.5 py-1 text-[11.5px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)]"
              >
                <span>Open in</span>
                <ChevronDown className="h-3 w-3 text-[var(--v-fg-muted)]" />
              </button>

              {openInMenuOpen && (
                <div className="absolute right-0 top-8 z-40 w-[168px] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1 shadow-2xl">
                  {(
                    [
                      { id: "cursor", label: "Cursor" },
                      { id: "vscode", label: "VS Code" },
                      { id: "zed", label: "Zed" },
                      { id: "finder", label: "Reveal in Finder" },
                      { id: "terminal", label: "macOS Terminal" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      onClick={() => handleOpenInEditor(item.id)}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)]"
                    >
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

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
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
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
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <Terminal className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Mobile E2EE Remote Controller Worktree Strip */}
        {mobileMode && (
          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] px-4 py-2">
            {sessions.map((s) => {
              const active = s.id === activeSession.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12px] transition-colors ${
                    active
                      ? "bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                      : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)]"
                  }`}
                >
                  {s.status === "running" && (
                    <span className="h-2 w-2 rounded-full bg-[#34d399]" />
                  )}
                  {s.status === "waiting_approval" && (
                    <span className="h-2 w-2 rounded-full bg-[#fbbf24]" />
                  )}
                  <span className="max-w-[140px] truncate">{s.title}</span>
                  <span className="font-mono text-[10.5px] text-[#34d399]">+{s.insertions}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Body Area: Centered Conversation Stream + On-Demand Right Drawer */}
        <div className="relative flex flex-1 overflow-hidden">
          <main className="flex flex-1 flex-col items-center overflow-hidden">
            {/* Scrollable Stream (Claude Code / Codex / Paseo Natural Proportions) */}
            <div className="w-full flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto flex max-w-[680px] flex-col gap-5">
                {activeEvents.length === 0 && (
                  <div className="my-12 flex flex-col items-start gap-2.5 rounded-2xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] p-5">
                    <div className="flex items-center gap-2 text-[13.5px] font-medium text-[var(--v-fg-primary)]">
                      <GitBranch className="h-4 w-4 text-[var(--v-fg-muted)]" />
                      <span>{activeSession.title}</span>
                    </div>
                    <p className="text-[12.5px] leading-relaxed text-[var(--v-fg-muted)]">
                      当前会话绑定于隔离工作区{" "}
                      <span className="font-mono text-[var(--v-fg-body)]">
                        {activeSession.branch_name}
                      </span>{" "}
                      (
                      <span className="font-mono text-[var(--v-fg-secondary)]">
                        {activeSession.worktree_path}
                      </span>
                      )。直接输入自然语言指令，
                      <span className="font-medium text-[var(--v-fg-body)]">
                        {MODEL_CATALOG.find((m) => m.id === activeSession.model)?.label ||
                          activeSession.model_short}
                      </span>{" "}
                      会自动在当前代码库中检索、读取并修改相关文件，无需手动挂载文件。
                    </p>
                  </div>
                )}

                {(() => {
                  let lastUserIdx = -1;
                  for (let i = activeEvents.length - 1; i >= 0; i--) {
                    if (activeEvents[i].kind === "user") {
                      lastUserIdx = i;
                      break;
                    }
                  }
                  const lastUserEv = lastUserIdx >= 0 ? activeEvents[lastUserIdx] : null;

                  return (
                    <>
                      {activeEvents.map((ev, idx) => {
                        const isLastEvent = idx === activeEvents.length - 1;

                        // 1. User Message: Cursor / Claude Desktop style (click bubble to edit, minimal hover icons only when idle, zero delete button)
                        if (ev.kind === "user") {
                          const isEditing = editingEventId === ev.id;

                          if (isEditing) {
                            return (
                              <div key={ev.id} className="flex justify-end">
                                <div className="w-full max-w-[86%] rounded-[18px] border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-3.5 shadow-lg">
                                  <textarea
                                    rows={3}
                                    autoFocus
                                    value={editingText}
                                    onChange={(e) => setEditingText(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSaveAndResendEdit(ev);
                                      } else if (e.key === "Escape") {
                                        setEditingEventId(null);
                                        setEditingText("");
                                      }
                                    }}
                                    className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-[var(--v-fg-primary)] focus:outline-none"
                                  />
                                  <div className="mt-2 flex items-center justify-between border-t border-[var(--v-border-subtle)] pt-2">
                                    <span className="text-[11px] text-[var(--v-fg-muted)]">
                                      Enter 重新发送 · Esc 取消
                                    </span>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => {
                                          setEditingEventId(null);
                                          setEditingText("");
                                        }}
                                        className="rounded-lg px-2.5 py-1 text-[11.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                                      >
                                        取消
                                      </button>
                                      <button
                                        onClick={() => handleSaveAndResendEdit(ev)}
                                        disabled={!editingText.trim()}
                                        className="rounded-lg bg-[var(--v-btn-bg)] px-3 py-1 text-[11.5px] font-medium text-[var(--v-btn-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
                                      >
                                        重新发送
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <div key={ev.id} className="group flex flex-col items-end gap-1">
                              <div
                                onClick={() => {
                                  if (activeSession.status !== "running") {
                                    handleStartEditMessage(ev);
                                  }
                                }}
                                title={
                                  activeSession.status !== "running"
                                    ? "点击可直接编辑并重新发送"
                                    : undefined
                                }
                                className={`max-w-[82%] whitespace-pre-wrap rounded-[18px] bg-[var(--v-bg-bubble)] px-4 py-2.5 text-[13.5px] leading-relaxed text-[var(--v-fg-primary)] transition-colors ${
                                  activeSession.status !== "running"
                                    ? "cursor-pointer hover:ring-1 hover:ring-[var(--v-border-strong)]"
                                    : ""
                                }`}
                              >
                                {ev.content}
                              </div>
                              {/* Minimal Hover-Only Icon Actions (Hidden during running) */}
                              {activeSession.status !== "running" && (
                                <div className="flex items-center gap-1 pr-1 text-[var(--v-fg-muted)] opacity-0 transition-opacity group-hover:opacity-100">
                                  <button
                                    onClick={() => copyText(ev.id, ev.content)}
                                    title="复制"
                                    className="rounded-md p-1 hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                                  >
                                    {copiedKey === ev.id ? (
                                      <Check className="h-3.5 w-3.5 text-[#34d399]" />
                                    ) : (
                                      <Copy className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                  <button
                                    onClick={() => handleStartEditMessage(ev)}
                                    title="编辑消息"
                                    className="rounded-md p-1 hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                                  >
                                    <SquarePen className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        }

                        // 2. Thinking Trace: Using BeautifulThinkingBlock component
                        if (ev.kind === "thinking") {
                          const isStreamingThinking =
                            activeSession.status === "running" && isLastEvent;
                          return (
                            <BeautifulThinkingBlock
                              key={ev.id}
                              text={ev.content}
                              isStreaming={isStreamingThinking}
                              defaultExpanded={isStreamingThinking}
                            />
                          );
                        }

                        // 3. Tool Call: Using BeautifulToolCallCard component (with live running spinner -> ok badge)
                        if (ev.kind === "tool_call") {
                          const toolInput =
                            ev.tool_input ??
                            (ev.tool_args ? { target: ev.tool_args } : ev.content);
                          const toolOutput =
                            ev.tool_output ??
                            (ev.tool_input === undefined ? ev.content : undefined);
                          return (
                            <BeautifulToolCallCard
                              key={ev.id}
                              toolName={ev.tool_name || "Tool"}
                              input={toolInput}
                              output={toolOutput}
                              isError={ev.tool_is_error}
                              onOpenDiffTab={() => openDiffForFile(ev.tool_args)}
                            />
                          );
                        }

                        // 4. Assistant Response: Clean left-aligned prose + hover Copy & Retry + Worktree Diff Summary Card
                        return (
                          <div key={ev.id} className="group flex flex-col items-start gap-2">
                            <div className="whitespace-pre-line text-[13.5px] leading-[1.68] text-[var(--v-fg-body)]">
                              {ev.content}
                            </div>

                            {/* Worktree Verification & Diff Card when files were modified */}
                            {isLastEvent && activeDiffFiles.length > 0 && (
                              <div className="mt-1 flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3.5 py-2.5">
                                <div className="flex min-w-0 items-center gap-2.5">
                                  <FileCode2 className="h-4 w-4 shrink-0 text-[#34d399]" />
                                  <div className="min-w-0">
                                    <div className="truncate text-[12px] font-medium text-[var(--v-fg-primary)]">
                                      Worktree Changes Ready ({activeDiffFiles.length} files modified)
                                    </div>
                                    <div className="truncate font-mono text-[11px] text-[var(--v-fg-muted)]">
                                      {activeDiffFiles.map((f) => f.path.split("/").pop()).join(", ")}
                                    </div>
                                  </div>
                                </div>
                                <button
                                  onClick={() => openDiffForFile()}
                                  className="shrink-0 rounded-lg bg-[var(--v-bg-active)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)]"
                                >
                                  Review Diff →
                                </button>
                              </div>
                            )}

                            {/* Hover-only Copy & Regenerate on Assistant Reply */}
                            {activeSession.status !== "running" && (
                              <div className="flex items-center gap-1 text-[var(--v-fg-muted)] opacity-0 transition-opacity group-hover:opacity-100">
                                <button
                                  onClick={() => copyText(ev.id, ev.content)}
                                  title="复制回复"
                                  className="rounded-md p-1 hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                                >
                                  {copiedKey === ev.id ? (
                                    <Check className="h-3.5 w-3.5 text-[#34d399]" />
                                  ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                  )}
                                </button>
                                {lastUserEv && (
                                  <button
                                    onClick={() => handleRetryUserMessage(lastUserEv)}
                                    title="重新生成回复"
                                    className="rounded-md p-1 hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                                  >
                                    <RefreshCw className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Live Inline Reasoning Indicator when running after a user message or completed tool call */}
                      {activeSession.status === "running" &&
                        activeEvents[activeEvents.length - 1]?.kind !== "thinking" && (
                          <BeautifulThinkingBlock
                            text={`正在使用 ${
                              modelCatalog.find((m) => m.id === activeSession.model)?.label ||
                              activeSession.model_short
                            } 思考并规划下一步操作...`}
                            isStreaming={true}
                            defaultExpanded={false}
                          />
                        )}

                      {/* Interrupted / Stopped Inline Bar (Only shown when stopped before final assistant reply) */}
                      {activeSession.status !== "running" &&
                        activeEvents.length > 0 &&
                        activeEvents[activeEvents.length - 1]?.kind !== "assistant" &&
                        lastUserEv && (
                          <div className="flex items-center justify-between rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-3.5 py-2 text-[12px] text-[var(--v-fg-muted)]">
                            <span>已手动停止当前执行 · 点击上方消息可直接修改重发</span>
                            <button
                              onClick={() => handleRetryUserMessage(lastUserEv)}
                              className="flex items-center gap-1.5 rounded-lg bg-[var(--v-bg-active)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)]"
                            >
                              <RefreshCw className="h-3 w-3" />
                              <span>重试</span>
                            </button>
                          </div>
                        )}
                    </>
                  );
                })()}
                <div ref={streamEndRef} />
              </div>
            </div>

            {/* ===============================================================
                4. AUTHENTIC PASEO / CODEX / CLAUDE CODE COMPOSER DOCK
                   - Pure natural language input (zero manual @file clutter)
                   - Direct Model Picker (Claude Fable 5.2, Opus 5.5, GPT-6.1-Sol...)
                   - Effort Picker (Low / Medium / High / Max) + Permission Mode
               =============================================================== */}
            <div className="w-full px-6 pb-5 pt-1">
              <div className="mx-auto max-w-[680px]">
                {/* Human-in-the-Loop Permission Approval Card using BeautifulApprovalCard */}
                {activePendingApproval && (
                  <BeautifulApprovalCard
                    toolName="Bash"
                    commandPreview={activePendingApproval.command}
                    onApprove={() => handleResolveApproval("approve")}
                    onDeny={() => handleResolveApproval("deny")}
                  />
                )}

                {/* Slash Command Popover */}
                {slashFilter !== null && (
                  <div className="mb-2 overflow-hidden rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1.5 shadow-xl">
                    {SLASH_SKILLS.filter((s) =>
                      s.cmd.toLowerCase().includes(slashFilter)
                    ).map((skill) => (
                      <button
                        key={skill.cmd}
                        onClick={() => handleSendPrompt(`${skill.cmd} `)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--v-bg-active)]"
                      >
                        <span className="font-mono font-medium text-[var(--v-fg-primary)]">
                          {skill.cmd}
                        </span>
                        <span className="text-[12px] text-[var(--v-fg-muted)]">{skill.desc}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="rounded-[18px] border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-4 pb-2.5 pt-3 shadow-lg transition-colors focus-within:border-[var(--v-fg-muted)]">
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
                    placeholder={`Ask ${
                      modelCatalog.find((m) => m.id === activeSession.model)?.label ||
                      activeSession.model_short
                    } anything... (/ for commands)`}
                    className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:outline-none"
                  />

                  {/* Composer Bottom Toolbar: Concrete Model Picker + Effort + Permission Mode */}
                  <div className="relative mt-1.5 flex items-center justify-between">
                    {/* 1. Concrete Model Picker Popover (Grouped by Model Family, dynamically synced from ~/.claude.json & ~/.codex/codex-models.json) */}
                    {modelPickerOpen && (
                      <div className="absolute bottom-9 left-0 z-30 w-[340px] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1.5 shadow-2xl">
                        <div className="max-h-[340px] overflow-y-auto pr-0.5">
                          {(["Anthropic", "OpenAI", "Google"] as const).map((family) => {
                            const familyModels = modelCatalog.filter((m) => m.family === family);
                            if (familyModels.length === 0) return null;
                            const runtimeId = familyModels[0].runtimeId;
                            const rt = runtimes.find((r) => r.id === runtimeId);
                            const isConnected = rt ? rt.available : runtimeId !== "gemini";
                            return (
                              <div key={family} className="mb-1.5 last:mb-0">
                                <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-medium text-[var(--v-fg-muted)]">
                                  <span>
                                    {family === "Anthropic"
                                      ? "Anthropic (Claude Code)"
                                      : family === "OpenAI"
                                      ? "OpenAI / Codex (~/.codex)"
                                      : family}
                                  </span>
                                  <span className="font-mono text-[10px]">
                                    {isConnected ? "Connected" : "Not configured"}
                                  </span>
                                </div>
                                {familyModels.map((m) => {
                                  const isCurrent = activeSession.model === m.id;
                                  return (
                                    <button
                                      key={m.id}
                                      disabled={!isConnected}
                                      onClick={() => {
                                        setSessions((prev) =>
                                          prev.map((s) =>
                                            s.id === activeSession.id
                                              ? {
                                                  ...s,
                                                  agent_kind: m.agentKind,
                                                  model: m.id,
                                                  model_short: m.shortLabel,
                                                }
                                              : s
                                          )
                                        );
                                        setModelPickerOpen(false);
                                      }}
                                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                                        isCurrent
                                          ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                                          : isConnected
                                          ? "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)]"
                                          : "cursor-not-allowed text-[var(--v-fg-muted)] opacity-40"
                                      }`}
                                    >
                                      <div className="min-w-0 pr-2">
                                        <div className="flex items-center gap-1.5 font-medium">
                                          <span>{m.label}</span>
                                          {m.isDefault && (
                                            <span className="rounded bg-[var(--v-bg-active)] px-1.5 py-0.2 font-mono text-[9.5px] text-[var(--v-fg-muted)]">
                                              default
                                            </span>
                                          )}
                                        </div>
                                        <div className="truncate text-[10.5px] text-[var(--v-fg-muted)]">
                                          {m.desc}
                                        </div>
                                      </div>
                                      {isCurrent && (
                                        <Check className="h-3.5 w-3.5 shrink-0 text-[#34d399]" />
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>

                        <div className="mt-1 border-t border-[var(--v-border-subtle)] pt-1">
                          <button
                            onClick={() => {
                              setModelPickerOpen(false);
                              setActiveModal("settings");
                            }}
                            className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                          >
                            <span>Manage CLI & Provider Connections...</span>
                            <Settings className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 2. Reasoning Effort Popover */}
                    {effortPickerOpen && (
                      <div className="absolute bottom-9 left-[165px] z-30 w-[160px] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1.5 shadow-2xl">
                        <div className="px-2.5 py-1 text-[10.5px] font-medium text-[var(--v-fg-muted)]">
                          Reasoning Effort
                        </div>
                        {(activeSession.agent_kind === "codex"
                          ? ([
                              { id: "low", label: "Low" },
                              { id: "medium", label: "Medium" },
                              { id: "high", label: "High" },
                              { id: "xhigh", label: "xHigh" },
                              { id: "ultra", label: "Ultra" },
                              { id: "max", label: "Max" },
                            ] as { id: EffortLevel; label: string }[])
                          : ([
                              { id: "low", label: "Low" },
                              { id: "medium", label: "Medium" },
                              { id: "high", label: "High" },
                              { id: "max", label: "Max" },
                            ] as { id: EffortLevel; label: string }[])
                        ).map((eff) => {
                          const currentEff = activeSession.effort || "high";
                          const active = currentEff === eff.id;
                          return (
                            <button
                              key={eff.id}
                              onClick={() => {
                                setSessions((prev) =>
                                  prev.map((s) =>
                                    s.id === activeSession.id ? { ...s, effort: eff.id } : s
                                  )
                                );
                                setEffortPickerOpen(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] ${
                                active
                                  ? "bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                                  : "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)]"
                              }`}
                            >
                              <span>{eff.label}</span>
                              {active && <Check className="h-3.5 w-3.5 text-[#34d399]" />}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex items-center gap-1.5">
                      {/* Pill 1: Concrete Model Name */}
                      <button
                        onClick={() => {
                          setEffortPickerOpen(false);
                          setModelPickerOpen((o) => !o);
                        }}
                        className="flex items-center gap-1.5 rounded-full bg-[var(--v-bg-active)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--v-fg-body)] transition-colors hover:bg-[var(--v-bg-hover)]"
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" />
                        <span>
                          {modelCatalog.find((m) => m.id === activeSession.model)?.label ||
                            activeSession.model_short ||
                            activeSession.model}
                        </span>
                        <ChevronDown className="h-3 w-3 text-[var(--v-fg-muted)]" />
                      </button>

                      {/* Pill 2: Reasoning Effort */}
                      <button
                        onClick={() => {
                          setModelPickerOpen(false);
                          setEffortPickerOpen((o) => !o);
                        }}
                        title="Reasoning Effort (--effort)"
                        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] capitalize text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-body)]"
                      >
                        <span>{activeSession.effort || "medium"}</span>
                        <ChevronDown className="h-3 w-3 opacity-60" />
                      </button>

                      {/* Pill 3: Worktree Permission Mode */}
                      <button
                        onClick={handleToggleApprovalMode}
                        title="Click to toggle Auto-edit / Ask permissions"
                        className="rounded-full px-2.5 py-1 text-[11.5px] text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-body)]"
                      >
                        {activeSession.approval_mode === "auto_edit"
                          ? "Auto-edit"
                          : "Ask permissions"}
                      </button>
                    </div>

                    {/* Right Controls: BeautifulContextMeter + Signature Circular Submit / Stop Disc */}
                    <div className="flex items-center gap-2">
                      <BeautifulContextMeter
                        usedTokens={activeSession.tokens_used || 14200}
                        maxTokens={activeSession.tokens_limit || 200000}
                      />
                      {activeSession.status === "running" ? (
                        <button
                          onClick={handleStopSession}
                          title="停止当前执行 (Stop)"
                          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-[var(--v-btn-bg)] text-[var(--v-btn-fg)] transition-all hover:opacity-90"
                        >
                          <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleSendPrompt()}
                          disabled={!prompt.trim()}
                          className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${
                            prompt.trim()
                              ? "bg-[var(--v-btn-bg)] text-[var(--v-btn-fg)] hover:opacity-90 cursor-pointer"
                              : "bg-[var(--v-bg-active)] text-[var(--v-fg-faint)] cursor-default"
                          }`}
                        >
                          <ArrowUp className="h-4 w-4 stroke-[2.25]" />
                        </button>
                      )}
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
            className={`flex flex-col overflow-hidden bg-[var(--v-bg-sidebar)] border-l border-[var(--v-border-subtle)] transition-all duration-200 ease-out ${
              drawerOpen ? "w-[460px] opacity-100" : "w-0 border-l-0 opacity-0"
            }`}
          >
            <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-[var(--v-border-subtle)] px-3.5">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setDrawerTab("diff")}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    drawerTab === "diff"
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-secondary)]"
                  }`}
                >
                  Changes ({activeDiffFiles.length})
                </button>
                <button
                  onClick={() => setDrawerTab("terminal")}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    drawerTab === "terminal"
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-secondary)]"
                  }`}
                >
                  Terminal
                </button>
              </div>

              {/* One-Click Git Worktree Actions + Close */}
              <div className="flex items-center gap-1">
                {drawerTab === "diff" && (
                  <>
                    <button
                      onClick={() => refreshSessionDiffAndFiles(activeSession.id)}
                      title="Refresh live git diff from worktree"
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${diffLoading ? "animate-spin" : ""}`}
                      />
                    </button>
                    <button
                      onClick={() => setCommitBoxOpen((v) => !v)}
                      title="Commit changes in isolated worktree"
                      className="flex items-center gap-1 rounded-md bg-[var(--v-bg-hover)] px-2 py-1 text-[11px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)]"
                    >
                      <GitCommitHorizontal className="h-3.5 w-3.5 text-[#34d399]" />
                      <span>Commit</span>
                    </button>
                    <button
                      onClick={handleMergeWorktree}
                      title="Check branch readiness for merge"
                      className="flex items-center gap-1 rounded-md bg-[var(--v-bg-hover)] px-2 py-1 text-[11px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)]"
                    >
                      <GitMerge className="h-3.5 w-3.5 text-[var(--v-fg-secondary)]" />
                      <span>Merge</span>
                    </button>
                  </>
                )}
                <button
                  onClick={() => setDrawerOpen(false)}
                  title="Close (Esc)"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {gitActionNotice && (
              <div className="border-b border-[var(--v-border-subtle)] bg-[#141d19] px-3.5 py-1.5 font-mono text-[11px] text-[#34d399]">
                {gitActionNotice}
              </div>
            )}

            {commitBoxOpen && drawerTab === "diff" && (
              <div className="flex items-center gap-1.5 border-b border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-3 py-2">
                <input
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="Commit message..."
                  className="flex-1 rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1 font-mono text-[11.5px] text-[var(--v-fg-primary)] focus:outline-none"
                />
                <button
                  onClick={handleCommitWorktree}
                  className="rounded-md bg-[var(--v-btn-bg)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--v-btn-fg)]"
                >
                  Commit
                </button>
              </div>
            )}

            {drawerTab === "diff" ? (
              !currentDiffFile ? (
                <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-[12.5px] text-[var(--v-fg-muted)]">
                  <p>当前 Worktree 暂无未提交的代码改动</p>
                  <p className="mt-1 font-mono text-[11px] text-[var(--v-fg-faint)]">
                    {activeSession.branch_name}
                  </p>
                </div>
              ) : (
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div className="flex flex-wrap gap-1 border-b border-[var(--v-border-subtle)] p-2.5">
                    {activeDiffFiles.map((file) => {
                      const active = file.path === currentDiffFile.path;
                      return (
                        <button
                          key={file.path}
                          onClick={() => setSelectedDiffPath(file.path)}
                          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors ${
                            active
                              ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                              : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-surface)] hover:text-[var(--v-fg-secondary)]"
                          }`}
                        >
                          <span>{file.path.split("/").pop()}</span>
                          <span className="text-[#34d399]">+{file.additions}</span>
                          <span className="text-[#f87171]">−{file.deletions}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-3.5 py-2 font-mono text-[11px] text-[var(--v-fg-muted)]">
                    <span className="truncate">{currentDiffFile.path}</span>
                    <button
                      onClick={() =>
                        copyText(
                          currentDiffFile.path,
                          currentDiffFile.hunks.map((h) => h.content).join("\n")
                        )
                      }
                      className="flex items-center gap-1 hover:text-[var(--v-fg-primary)]"
                    >
                      {copiedKey === currentDiffFile.path ? (
                        <Check className="h-3 w-3 text-[#34d399]" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>

                  {/* Dual-Line-Number Unified Diff Viewer (Click any line to add inline review comment for Agent) */}
                  <div className="flex-1 overflow-y-auto py-2 font-mono text-[11.5px] leading-[1.65]">
                    {currentDiffFile.hunks.map((line, idx) => {
                      const isHunkHeader = line.content.startsWith("@@");
                      const rowClass = isHunkHeader
                        ? "v-diff-hunk"
                        : line.type === "add"
                        ? "v-diff-add"
                        : line.type === "del"
                        ? "v-diff-del"
                        : "text-[var(--v-fg-muted)]";
                      const sign = isHunkHeader
                        ? ""
                        : line.type === "add"
                        ? "+"
                        : line.type === "del"
                        ? "-"
                        : " ";
                      const lineNum = line.newLine ?? line.oldLine ?? idx + 1;
                      const isCommenting = diffCommentIdx === idx;
                      return (
                        <div key={idx}>
                          <div
                            onClick={() => {
                              if (!isHunkHeader) {
                                setDiffCommentIdx(isCommenting ? null : idx);
                                setDiffCommentText("");
                              }
                            }}
                            title={
                              isHunkHeader
                                ? undefined
                                : "Click line to send inline review comment to Agent"
                            }
                            className={`group flex cursor-pointer items-center px-3 py-0.5 hover:brightness-110 ${rowClass}`}
                          >
                            <span className="w-7 shrink-0 select-none pr-1.5 text-right opacity-35">
                              {line.oldLine ?? ""}
                            </span>
                            <span className="w-7 shrink-0 select-none pr-2 text-right opacity-35">
                              {line.newLine ?? ""}
                            </span>
                            <span className="w-4 shrink-0 select-none">
                              {!isHunkHeader ? (
                                <span className="group-hover:hidden">{sign}</span>
                              ) : (
                                sign
                              )}
                              {!isHunkHeader && (
                                <span className="hidden text-[#38bdf8] group-hover:inline">+</span>
                              )}
                            </span>
                            <span className="whitespace-pre">{line.content}</span>
                          </div>

                          {isCommenting && (
                            <div className="mx-3 my-1.5 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-2.5 font-sans shadow-lg">
                              <div className="mb-1.5 flex items-center justify-between text-[11px] text-[var(--v-fg-muted)]">
                                <span className="font-mono">
                                  Review {currentDiffFile.path}:L{lineNum}
                                </span>
                                <button
                                  onClick={() => setDiffCommentIdx(null)}
                                  className="hover:text-[var(--v-fg-primary)]"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <input
                                  autoFocus
                                  value={diffCommentText}
                                  onChange={(e) => setDiffCommentText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && diffCommentText.trim()) {
                                      const reviewPrompt = `In \`${currentDiffFile.path}\` at line ${lineNum} (\`${line.content.trim()}\`), please make this change: ${diffCommentText.trim()}`;
                                      setDiffCommentIdx(null);
                                      setDiffCommentText("");
                                      handleSendPrompt(reviewPrompt);
                                    }
                                  }}
                                  placeholder="Ask Agent to change this line..."
                                  className="flex-1 rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                                />
                                <button
                                  onClick={() => {
                                    if (!diffCommentText.trim()) return;
                                    const reviewPrompt = `In \`${currentDiffFile.path}\` at line ${lineNum} (\`${line.content.trim()}\`), please make this change: ${diffCommentText.trim()}`;
                                    setDiffCommentIdx(null);
                                    setDiffCommentText("");
                                    handleSendPrompt(reviewPrompt);
                                  }}
                                  className="rounded-md bg-[var(--v-btn-bg)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--v-btn-fg)]"
                                >
                                  Ask Agent
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )
            ) : (
              <div className="flex flex-1 flex-col overflow-hidden p-3.5 font-mono text-[11.5px]">
                <div className="mb-2 flex items-center justify-between text-[10.5px] text-[var(--v-fg-faint)]">
                  <span className="truncate">{activeSession.worktree_path}</span>
                  <span>{activeSession.branch_name}</span>
                </div>
                <div className="flex-1 space-y-1.5 overflow-y-auto text-[var(--v-fg-body)]">
                  {termLines.map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("$") ? "font-medium text-[var(--v-fg-primary)]" : "text-[var(--v-fg-muted)]"
                      }
                    >
                      {line}
                    </div>
                  ))}
                </div>
                <form
                  onSubmit={handleRunTermCommand}
                  className="mt-2 flex items-center gap-2 border-t border-[var(--v-border-subtle)] pt-2.5"
                >
                  <span className="text-[var(--v-fg-muted)]">$</span>
                  <input
                    value={termInput}
                    onChange={(e) => setTermInput(e.target.value)}
                    placeholder="Run real git / cargo command in worktree..."
                    className="flex-1 bg-transparent text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:outline-none"
                  />
                </form>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* =====================================================================
          6. MODALS (New Thread, New Repo, Command Palette, Pairing QR, Settings)
         ===================================================================== */}
      {activeModal && (
        <div
          onClick={() => setActiveModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[480px] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-5 shadow-2xl"
          >
            {activeModal === "new-worktree" && (
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                    New isolated worktree thread
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-3 text-[12.5px]">
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                      Project
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {repos.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => setTargetRepoIdForNewWt(r.id)}
                          className={`truncate rounded-lg border px-2.5 py-1.5 text-[12px] ${
                            targetRepoIdForNewWt === r.id
                              ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                              : "border-[var(--v-border-strong)] text-[var(--v-fg-muted)]"
                          }`}
                        >
                          {r.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                      Orchestration Mode
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          { id: "single", label: "Single Model" },
                          { id: "committee", label: "Committee Race" },
                          { id: "loop", label: "TDD Auto-Loop" },
                        ] as const
                      ).map((m) => (
                        <button
                          key={m.id}
                          onClick={() => setDispatchMode(m.id)}
                          className={`rounded-lg border px-2 py-1.5 text-[11.5px] ${
                            dispatchMode === m.id
                              ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                              : "border-[var(--v-border-strong)] text-[var(--v-fg-muted)]"
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {dispatchMode !== "committee" && (
                    <div>
                      <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                        Model
                      </label>
                      <div className="max-h-[180px] overflow-y-auto grid grid-cols-2 gap-1.5 pr-1">
                        {modelCatalog.filter((m) => m.family !== "Google").map((m) => (
                          <button
                            key={m.id}
                            onClick={() => setNewModelId(m.id)}
                            className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-[12px] ${
                              newModelId === m.id
                                ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                                : "border-[var(--v-border-strong)] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)]"
                            }`}
                          >
                            <span className="truncate">{m.label}</span>
                            <span className="font-mono text-[10px] opacity-60">{m.family}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {dispatchMode === "loop" && (
                    <div>
                      <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                        Acceptance Test Command (Auto-reruns until exit 0)
                      </label>
                      <input
                        value={loopCheckCmd}
                        onChange={(e) => setLoopCheckCmd(e.target.value)}
                        className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                      />
                    </div>
                  )}
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                      Task title / initial prompt
                    </label>
                    <input
                      value={newTaskDesc}
                      onChange={(e) => setNewTaskDesc(e.target.value)}
                      className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 text-[12.5px] text-[var(--v-fg-primary)] focus:border-[var(--v-fg-muted)] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                      Git Worktree branch
                    </label>
                    <input
                      value={newTaskName}
                      onChange={(e) => setNewTaskName(e.target.value)}
                      className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[12px] text-[var(--v-fg-primary)] focus:border-[var(--v-fg-muted)] focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      onClick={() => setActiveModal(null)}
                      className="rounded-lg px-3 py-1.5 text-[12.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-active)]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateWorktree}
                      className="rounded-lg bg-[var(--v-btn-bg)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90"
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
                  <h3 className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                    Add project
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-3 text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <input
                      value={newRepoPath}
                      onChange={(e) => setNewRepoPath(e.target.value)}
                      placeholder="/path/to/git/repo"
                      className="flex-1 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                    />
                    <button
                      onClick={handlePickRepoFolder}
                      className="shrink-0 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-active)] px-3 py-2 text-[12px] text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)]"
                    >
                      Browse Finder...
                    </button>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      onClick={() => setActiveModal(null)}
                      className="rounded-lg px-3 py-1.5 text-[12.5px] text-[var(--v-fg-secondary)]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateRepo}
                      className="rounded-lg bg-[var(--v-btn-bg)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--v-btn-fg)]"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeModal === "command" && (
              <div>
                <div className="mb-3 flex items-center gap-2 border-b border-[var(--v-border-subtle)] pb-2.5">
                  <Search className="h-4 w-4 text-[var(--v-fg-muted)]" />
                  <input
                    autoFocus
                    value={cmdQuery}
                    onChange={(e) => setCmdQuery(e.target.value)}
                    placeholder="Search threads or run action..."
                    className="w-full bg-transparent text-[13px] text-[var(--v-fg-primary)] focus:outline-none"
                  />
                </div>
                <div className="max-h-[280px] space-y-1 overflow-y-auto text-[12.5px]">
                  {sessions
                    .filter(
                      (s) =>
                        s.title.toLowerCase().includes(cmdQuery.toLowerCase()) ||
                        s.branch_name.toLowerCase().includes(cmdQuery.toLowerCase())
                    )
                    .map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setActiveId(s.id);
                          setActiveModal(null);
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-[var(--v-bg-active)]"
                      >
                        <span className="truncate text-[var(--v-fg-primary)]">{s.title}</span>
                        <span className="font-mono text-[11px] text-[var(--v-fg-muted)]">
                          {s.branch_name}
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            )}

            {activeModal === "settings" && (
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                    Settings · 模型服务连接与外观设置
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="max-h-[75vh] space-y-5 overflow-y-auto pr-1 text-[12.5px]">
                  {/* Section 1: CLI & Model Providers (Paseo / Conductor Style) */}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <label className="text-[11.5px] font-medium text-[var(--v-fg-secondary)]">
                        CLI & Model Providers (本地订阅 CLI 接入 — 解锁对应模型池)
                      </label>
                      <button
                        onClick={refreshSessions}
                        className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                      >
                        <RefreshCw className="h-3 w-3" />
                        <span>Re-scan</span>
                      </button>
                    </div>

                    <div className="space-y-2">
                      {runtimes.map((rt) => {
                        const unlockedModels = modelCatalog
                          .filter((m) => m.runtimeId === rt.id)
                          .map((m) => m.label);
                        return (
                          <div
                            key={rt.id}
                            className="rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3.5 py-2.5"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 font-medium text-[var(--v-fg-primary)]">
                                <span
                                  className="h-2 w-2 rounded-full"
                                  style={{
                                    background: rt.available ? "#34d399" : "#71717a",
                                  }}
                                />
                                <span>{rt.name}</span>
                              </div>
                              <span
                                className={`rounded-full px-2 py-0.5 font-mono text-[10.5px] ${
                                  rt.available
                                    ? "bg-[#34d399]/15 text-[#34d399]"
                                    : "bg-[var(--v-bg-active)] text-[var(--v-fg-muted)]"
                                }`}
                              >
                                {rt.available ? "Connected" : "Not installed"}
                              </span>
                            </div>
                            <div className="mt-1 truncate font-mono text-[11px] text-[var(--v-fg-muted)]">
                              {rt.version || "CLI binary not detected in PATH"}
                              {rt.binary_path ? ` · ${rt.binary_path}` : ""}
                            </div>
                            {unlockedModels.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {unlockedModels.map((mLabel) => (
                                  <span
                                    key={mLabel}
                                    className="rounded-md bg-[var(--v-bg-surface)] px-2 py-0.5 text-[10.5px] text-[var(--v-fg-secondary)]"
                                  >
                                    {mLabel}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Section 2: Appearance & Theme */}
                  <div className="border-t border-[var(--v-border-subtle)] pt-4">
                    <div className="mb-1.5 flex items-center justify-between">
                      <label className="text-[11.5px] text-[var(--v-fg-secondary)]">
                        主题模式 (Theme Mode)
                      </label>
                      <span className="font-mono text-[11px] text-[var(--v-fg-muted)]">
                        当前生效: {resolvedTheme === "dark" ? "深色 (Dark)" : "浅色 (Light)"}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          { id: "system", label: "跟随系统 (System)", icon: Monitor },
                          { id: "light", label: "浅色 (Light)", icon: Sun },
                          { id: "dark", label: "深色 (Dark)", icon: Moon },
                        ] as const
                      ).map(({ id, label, icon: Icon }) => (
                        <button
                          key={id}
                          onClick={() => setThemeMode(id)}
                          className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-[12px] transition-colors ${
                            themeMode === id
                              ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                              : "border-[var(--v-border-strong)] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)]"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[11.5px] text-[var(--v-fg-secondary)]">
                      色彩基调 (Color Tone — 同时适配深浅色)
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          { id: "zinc", label: "Carbon Zinc" },
                          { id: "claude", label: "Claude Warm" },
                          { id: "paseo", label: "Paseo Forest" },
                        ] as { id: ToneId; label: string }[]
                      ).map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setTone(t.id)}
                          className={`rounded-lg border px-3 py-2 text-center text-[12px] transition-colors ${
                            tone === t.id
                              ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                              : "border-[var(--v-border-strong)] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)]"
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[11.5px] text-[var(--v-fg-secondary)]">
                      表面材质 (Surface Material)
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          { id: "a", label: "A · Sharp Matte" },
                          { id: "b", label: "B · Frosted Glass" },
                          { id: "c", label: "C · Tactile 3D" },
                        ] as { id: VariantId; label: string }[]
                      ).map((v) => (
                        <button
                          key={v.id}
                          onClick={() => setVariant(v.id)}
                          className={`rounded-lg border px-2.5 py-2 text-center text-[11.5px] transition-colors ${
                            variant === v.id
                              ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                              : "border-[var(--v-border-strong)] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)]"
                          }`}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {(activeModal === "skills" || activeModal === "qr") && (
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-[13.5px] font-semibold text-[var(--v-fg-primary)]">
                    {activeModal === "qr" ? "Mobile E2EE Pairing" : "Automations & Skills"}
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {activeModal === "qr" ? (
                  <div className="space-y-3 font-mono text-[11.5px] text-[var(--v-fg-secondary)]">
                    <p>X25519 + ChaCha20-Poly1305 E2EE Relay:</p>
                    {pairTicket?.qr_svg && (
                      <div
                        className="mx-auto flex h-44 w-44 items-center justify-center rounded-xl bg-white p-2"
                        dangerouslySetInnerHTML={{ __html: pairTicket.qr_svg }}
                      />
                    )}
                    <div className="break-all rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] p-3 text-[var(--v-fg-primary)]">
                      {pairTicket?.uri ||
                        "velo://pair?daemon=127.0.0.1:6767&fp=9F8B-441A-E2EE"}
                    </div>
                    <div className="flex items-center justify-between pt-1 font-sans">
                      <span className="text-[11.5px] text-[var(--v-fg-muted)]">
                        Scan on iOS/Android over LAN Wi-Fi
                      </span>
                      <button
                        onClick={() => {
                          setMobileMode(true);
                          setSidebarOpen(false);
                          setActiveModal(null);
                        }}
                        className="rounded-lg bg-[var(--v-btn-bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--v-btn-fg)]"
                      >
                        Preview Mobile Remote UI
                      </button>
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
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-[var(--v-bg-active)]"
                      >
                        <span className="font-mono text-[12px] font-medium text-[var(--v-fg-primary)]">
                          {s.cmd}
                        </span>
                        <span className="text-[12px] text-[var(--v-fg-muted)]">{s.desc}</span>
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
