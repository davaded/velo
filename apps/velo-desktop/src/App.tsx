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
  AgentStatusPhase,
  BeautifulApprovalCard,
  BeautifulContextMeter,
  BeautifulQuestionCard,
  BeautifulThinkingBlock,
  BeautifulToolCallCard,
  PaseoMarkdown,
  PaseoToolCallGroup,
  PaseoToolGroupItem,
  PaseoTurnFooter,
  PaseoTurnTelemetry,
  resolvePaseoToolPresentation,
} from "./components/ui/BeautifulAgentPrimitives";
import { XtermTerminalDrawer, TerminalChunkPacket } from "./components/XtermTerminalDrawer";
import { PullRequestDrawer } from "./components/PullRequestDrawer";
import { BrowserPreviewDrawer } from "./components/BrowserPreviewDrawer";
import { AutomationsModal } from "./components/AutomationsModal";
import { e2eeOpenFrame, e2eeSealJson } from "./utils/e2eeRelayClient";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
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
  GitPullRequest,
  Globe,
  ImagePlus,
  Layers,
  Lock,
  MessageSquarePlus,
  Mic,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings,
  Smartphone,
  Square,
  SquarePen,
  Sun,
  Terminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

type VariantId = "a" | "b" | "c";
type ThemeMode = "system" | "light" | "dark";
type ToneId = "zinc" | "claude" | "paseo";
type DrawerTab = "diff" | "pr" | "browser" | "terminal";
type ModalKind =
  | null
  | "new-worktree"
  | "new-repo"
  | "command"
  | "skills"
  | "qr"
  | "settings"
  | "automations";

interface E2EEBridgeStatusDto {
  bridge_connected: boolean;
  ratchet_active: boolean;
  peers_seen: number;
  last_peer_seen_at?: string | null;
  tunnel: {
    status: string;
    public_wss_url?: string | null;
    detail?: string | null;
  };
}

interface PairingTicketDto {
  lan_ip?: string;
  lan_uri?: string;
  lan_qr_svg?: string;
  tailscale_ip?: string | null;
  tailscale_uri?: string | null;
  tailscale_qr_svg?: string | null;
  room_id?: string;
  shared_key_hex?: string;
  daemon_pubkey_hex?: string;
  custom_relay_url?: string | null;
  pairing_uri?: string;
  relay_url: string;
  daemon_addr: string;
  uri: string;
  qr_svg: string;
  web_qr_svg?: string;
  e2ee_status?: E2EEBridgeStatusDto;
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
  toolName: string;
  command: string;
  reason: string;
}

interface PendingQuestionItem {
  id: string;
  question: string;
  options: string[];
  allowMultiple: boolean;
}

interface DraftDiffReviewComment {
  id: string;
  filePath: string;
  lineNum: number;
  codeContent: string;
  comment: string;
}

interface PendingAttachmentItem {
  filename: string;
  path: string;
  url: string;
}

const DEFAULT_PENDING_BY_SESSION: Record<string, PendingApprovalItem> = {};

function reconstructEventsFromHistory(
  sid: string,
  rawList: Array<Record<string, unknown>>
): AgentEvent[] {
  const reconstructed: AgentEvent[] = [];
  let activeHistUserIdx = -1;
  let activeHistStartMs = 0;
  let lastStepMs = 0;
  for (let i = 0; i < rawList.length; i++) {
    const ev = rawList[i];
    const evType = String(ev.type ?? "");
    const tsRaw = typeof ev.timestamp === "string" ? new Date(ev.timestamp) : new Date();
    const tsMs = Number.isNaN(tsRaw.getTime()) ? 0 : tsRaw.getTime();
    const ts = Number.isNaN(tsRaw.getTime())
      ? new Date().toLocaleTimeString([], { hour12: false })
      : tsRaw.toLocaleTimeString([], { hour12: false });

    if (evType === "user_message") {
      const text = String(ev.text ?? "").trim();
      const imgs = Array.isArray(ev.images) ? ev.images.map(String).filter(Boolean) : [];
      if (text || imgs.length > 0) {
        reconstructed.push({
          id: `u-hist-${i}`,
          session_id: sid,
          timestamp: ts,
          kind: "user",
          content: text,
          images: imgs.length > 0 ? imgs : undefined,
        });
        activeHistUserIdx = reconstructed.length - 1;
        activeHistStartMs = tsMs;
        lastStepMs = tsMs;
      }
    } else if (evType === "status_changed") {
      const st = String(ev.status ?? "");
      if (st === "running") {
        if (activeHistStartMs === 0 && tsMs > 0) {
          activeHistStartMs = tsMs;
        }
        if (lastStepMs === 0 && tsMs > 0) {
          lastStepMs = tsMs;
        }
      } else if (
        (st === "completed" || st === "failed" || st === "stopped") &&
        activeHistUserIdx >= 0
      ) {
        const dur =
          activeHistStartMs > 0 && tsMs >= activeHistStartMs
            ? Math.max(500, tsMs - activeHistStartMs)
            : undefined;
        reconstructed[activeHistUserIdx] = {
          ...reconstructed[activeHistUserIdx],
          duration_ms: dur,
          completed_at: ts,
        };
      }
    } else if (evType === "thinking_delta") {
      const text = String(ev.text ?? "").trim();
      if (!text) continue;
      const stepDeltaMs =
        lastStepMs > 0 && tsMs >= lastStepMs ? Math.max(500, tsMs - lastStepMs) : undefined;
      if (tsMs > 0) {
        lastStepMs = tsMs;
      }
      const last = reconstructed[reconstructed.length - 1];
      if (last && last.kind === "thinking") {
        if (!last.content.includes(text)) {
          last.content = `${last.content}\n${text}`;
        }
        if (stepDeltaMs !== undefined) {
          last.duration_ms = Math.max(500, (last.duration_ms || 0) + stepDeltaMs);
        }
      } else {
        reconstructed.push({
          id: `th-hist-${i}`,
          session_id: sid,
          timestamp: ts,
          kind: "thinking",
          content: text,
          duration_ms: stepDeltaMs,
        });
      }
    } else if (evType === "tool_call_requested") {
      if (lastStepMs === 0 && tsMs > 0) {
        lastStepMs = tsMs;
      }
      const toolId = String(ev.tool_id ?? `tl-hist-${i}`);
      const toolName = String(ev.tool_name ?? "Tool");
      const argsObj = (
        ev.arguments && typeof ev.arguments === "object" ? ev.arguments : {}
      ) as Record<string, unknown>;
      const argSummary = String(
        argsObj.file_path ??
          argsObj.path ??
          argsObj.command ??
          argsObj.pattern ??
          argsObj.query ??
          (Object.keys(argsObj).length > 0 ? JSON.stringify(argsObj).slice(0, 80) : "")
      );
      const existingIdx = reconstructed.findIndex(
        (item) => item.kind === "tool_call" && item.id === toolId
      );
      if (existingIdx !== -1) {
        reconstructed[existingIdx] = {
          ...reconstructed[existingIdx],
          tool_name: toolName,
          tool_args: argSummary || reconstructed[existingIdx].tool_args,
          tool_input:
            Object.keys(argsObj).length > 0 ? argsObj : reconstructed[existingIdx].tool_input,
        };
      } else {
        reconstructed.push({
          id: toolId,
          session_id: sid,
          timestamp: ts,
          kind: "tool_call",
          tool_name: toolName,
          tool_args: argSummary,
          tool_input: argsObj,
          tool_output: undefined,
          tool_is_error: false,
          content: JSON.stringify(argsObj, null, 2),
        });
      }
    } else if (evType === "tool_call_completed") {
      if (tsMs > 0) {
        lastStepMs = tsMs;
      }
      const toolId = String(ev.tool_id ?? "");
      const output = String(ev.output ?? "(completed)");
      const isError = Boolean(ev.is_error);
      let idx = reconstructed.findIndex(
        (item) => item.kind === "tool_call" && item.id === toolId
      );
      if (idx === -1) {
        for (let j = reconstructed.length - 1; j >= 0; j--) {
          if (reconstructed[j].kind === "tool_call" && reconstructed[j].tool_output === undefined) {
            idx = j;
            break;
          }
        }
      }
      if (idx !== -1) {
        reconstructed[idx] = {
          ...reconstructed[idx],
          tool_output: output,
          tool_is_error: isError,
          content: output,
        };
      }
    } else if (evType === "setup_hook_output") {
      if (tsMs > 0) {
        lastStepMs = tsMs;
      }
      const cmd = String(ev.command ?? ".velo/setup.sh");
      const out = String(ev.output ?? "(exit 0)");
      const code = Number(ev.exit_code ?? 0);
      reconstructed.push({
        id: `hook-hist-${i}`,
        session_id: sid,
        timestamp: ts,
        kind: "tool_call",
        tool_name: "Worktree Setup Hook",
        tool_args: cmd,
        tool_input: { command: cmd },
        tool_output: out,
        tool_is_error: code !== 0,
        content: out,
      });
    } else if (evType === "message_delta") {
      const text = String(ev.text ?? "");
      if (!text.trim() || text.startsWith("[stderr]")) continue;
      if (tsMs > 0) {
        lastStepMs = tsMs;
      }
      reconstructed.push({
        id: `as-hist-${i}`,
        session_id: sid,
        timestamp: ts,
        kind: "assistant",
        content: text,
      });
    } else if (evType === "error") {
      const errText = String(ev.error ?? "Agent execution error");
      reconstructed.push({
        id: `err-hist-${i}`,
        session_id: sid,
        timestamp: ts,
        kind: "assistant",
        content: `⚠️ ${errText}`,
      });
    }
  }
  return reconstructed;
}

export function App() {
  const [daemonUrl] = useState<string>(() => {
    const sp = new URLSearchParams(window.location.search);
    const explicitDaemon = sp.get("daemon");
    if (explicitDaemon && explicitDaemon.startsWith("http")) {
      return explicitDaemon.replace(/\/$/, "");
    }
    const origin = window.location.origin;
    if (
      (origin.startsWith("http://") || origin.startsWith("https://")) &&
      !origin.includes(":5173")
    ) {
      return origin;
    }
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

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      if (window.location.search.includes("mobile=1") || window.innerWidth < 768) {
        return false;
      }
    }
    return true;
  });
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const [repos, setRepos] = useState<VeloRepo[]>(() => {
    try {
      const saved =
        localStorage.getItem("velo.repos.v3") || localStorage.getItem("velo.repos.v2");
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
      const saved = localStorage.getItem("velo.sessions.v3");
      if (saved) {
        const parsed = JSON.parse(saved) as VeloSession[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((s) => {
            const valid = MODEL_CATALOG.find((m) => m.id === s.model);
            if (valid || String(s.agent_kind || "").startsWith("acp:")) return s;
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
    return localStorage.getItem("velo.activeId.v3") || DEMO_SESSIONS[0].id;
  });
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[]>>(() => {
    try {
      const saved = localStorage.getItem("velo.events.v4");
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
      localStorage.setItem("velo.repos.v3", JSON.stringify(repos));
    } catch {
      // ignore
    }
  }, [repos]);

  useEffect(() => {
    try {
      localStorage.setItem("velo.sessions.v3", JSON.stringify(sessions));
    } catch {
      // ignore
    }
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem("velo.activeId.v3", activeId);
  }, [activeId]);

  useEffect(() => {
    try {
      localStorage.setItem("velo.events.v4", JSON.stringify(eventsBySession));
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

  // Inline Diff Line Review Comment State (Single + Batch Multi-Comment Dispatch)
  const [diffCommentIdx, setDiffCommentIdx] = useState<number | null>(null);
  const [diffCommentText, setDiffCommentText] = useState<string>("");
  const [draftDiffComments, setDraftDiffComments] = useState<DraftDiffReviewComment[]>([]);

  // Open in External IDE Menu State
  const [openInMenuOpen, setOpenInMenuOpen] = useState<boolean>(false);

  // Phase 3 Dispatch Mode (Single / Committee Race / TDD Loop)
  const [dispatchMode, setDispatchMode] = useState<"single" | "committee" | "loop">("single");
  const [loopCheckCmd, setLoopCheckCmd] = useState<string>("cargo test --workspace --offline");

  // Phase 4 Mobile Remote Controller & True E2EE Relay (?mobile=1&relay=...&room=...&key=...)
  const [mobileMode, setMobileMode] = useState<boolean>(
    () =>
      window.location.search.includes("mobile=1") ||
      (typeof window !== "undefined" && window.innerWidth < 768)
  );
  const [e2eeRelayConfig] = useState<{
    relayUrl: string;
    roomId: string;
    sharedKeyHex: string;
  } | null>(() => {
    const sp = new URLSearchParams(window.location.search);
    const relayUrl = sp.get("relay");
    const roomId = sp.get("room");
    const sharedKeyHex = sp.get("key");
    if (relayUrl && roomId && sharedKeyHex) {
      return { relayUrl, roomId, sharedKeyHex };
    }
    return null;
  });
  const [e2eeConnected, setE2eeConnected] = useState<boolean>(false);
  const directWsConnectedRef = useRef<boolean>(false);
  const initialDaemonSyncedRef = useRef<boolean>(false);
  const e2eeWsRef = useRef<WebSocket | null>(null);
  const e2eeNonceRef = useRef<number>(Date.now() * 100);
  const [pairModeTab, setPairModeTab] = useState<"lan" | "e2ee">("e2ee");
  const [e2eeQrTarget, setE2eeQrTarget] = useState<"app" | "web">("app");
  const [rotatingRelayKey, setRotatingRelayKey] = useState<boolean>(false);
  const [customRelayInput, setCustomRelayInput] = useState<string>("");

  // Stream disclosure states & Inline User Message Editing state
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>("");

  // Human-in-the-Loop Pending Approvals & Bidirectional User Questions per Session
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApprovalItem>>(
    DEFAULT_PENDING_BY_SESSION
  );
  const [pendingQuestions, setPendingQuestions] = useState<Record<string, PendingQuestionItem>>({});

  // Clean Composer State (Natural language + slash skills + multimodal image attachments + voice STT)
  const [prompt, setPrompt] = useState<string>("");
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentItem[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState<boolean>(false);
  const [composerDragOver, setComposerDragOver] = useState<boolean>(false);
  const [isDictating, setIsDictating] = useState<boolean>(false);
  const speechRecRef = useRef<{ stop: () => void } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState<string>("");

  // Modals, Repo Worktree Setup Hooks, Custom ACP Runtime, & E2EE Pairing Ticket
  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [pairTicket, setPairTicket] = useState<PairingTicketDto | null>(null);
  const [cmdQuery, setCmdQuery] = useState<string>("");
  const [newTaskName, setNewTaskName] = useState<string>("feat/new-thread");
  const [newTaskDesc, setNewTaskDesc] = useState<string>("");
  const [newModelId, setNewModelId] = useState<string>("claude-fable-5-2");
  const [newApproval, setNewApproval] = useState<ApprovalMode>("auto_edit");
  const [newSetupCommand, setNewSetupCommand] = useState<string>("");
  const [repoHooks, setRepoHooks] = useState<Record<string, string>>({});
  const [hookEditCmd, setHookEditCmd] = useState<string>("");
  const [customAcpCmd, setCustomAcpCmd] = useState<string>("");
  const [newRepoPath, setNewRepoPath] = useState<string>("/Users/daiyudai/code/velo");

  // Full-Color xterm.js PTY Stream Packet & Turn Timing State
  const [latestTerminalChunk, setLatestTerminalChunk] = useState<TerminalChunkPacket | null>(null);
  const termSeqRef = useRef<number>(0);
  const turnStartMsRef = useRef<Record<string, number>>({});
  const stepStartMsRef = useRef<Record<string, number>>({});
  const [turnTimingBySession, setTurnTimingBySession] = useState<
    Record<
      string,
      {
        startedAtMs: number;
        ttftMs?: number;
        durationMs?: number;
        completedAtLabel?: string;
        bootStage?: "provisioning" | "spawned" | "bound";
        agentPid?: number;
        providerThreadShort?: string;
      }
    >
  >({});

  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const isPinnedToBottomRef = useRef<boolean>(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState<boolean>(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const scrollChatToBottom = useCallback((smooth = false) => {
    if (smooth) {
      isPinnedToBottomRef.current = true;
      setShowJumpToBottom(false);
      requestAnimationFrame(() => {
        const el = chatScrollRef.current;
        if (el) {
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        } else {
          streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      });
      return;
    }
    if (!isPinnedToBottomRef.current) return;
    requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, []);

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
          if (normalized.length > 0) {
            // Auto-register any project paths from the Mac daemon so mobile browsers see all workspaces
            setRepos((prevRepos) => {
              const knownPaths = new Set(prevRepos.map((r) => r.path));
              const extra: VeloRepo[] = [];
              for (const s of normalized) {
                if (s.project_path && !knownPaths.has(s.project_path)) {
                  knownPaths.add(s.project_path);
                  const folder =
                    s.project_path.split("/").filter(Boolean).pop() || "workspace";
                  extra.push({
                    id: `repo-${folder.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
                    code: folder.slice(0, 2).toUpperCase(),
                    name: folder,
                    path: s.project_path,
                    default_branch: "main",
                  });
                }
              }
              return extra.length > 0 ? [...prevRepos, ...extra] : prevRepos;
            });

            // On a fresh mobile/browser open where activeId is still the empty placeholder, jump straight to the latest active thread
            if (!initialDaemonSyncedRef.current) {
              initialDaemonSyncedRef.current = true;
              setActiveId((curId) =>
                curId === "sess-default" || !curId ? normalized[0].id : curId
              );
            }
          }
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
              .filter(
                (d) =>
                  !mergedIds.has(d.id) &&
                  !(normalized.length > 0 && d.id === "sess-default" && d.title === "New thread") &&
                  (d.id.startsWith("sess-") || d.id.startsWith("wt-"))
              )
              .map((d) =>
                d.status === "running" && !runningDaemonIds.has(d.id)
                  ? { ...d, status: "idle" as const, updated_at: "now" }
                  : d
              );
            const combined = [...merged, ...remainingLocal];
            return combined.length > 0 ? combined : DEMO_SESSIONS;
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

    fetch(`${daemonUrl}/api/hooks`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { hooks?: Record<string, string> }) => {
        if (data.hooks && typeof data.hooks === "object") {
          setRepoHooks(data.hooks);
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
              setSelectedDiffPath((prev) =>
                converted.some((c) => c.path === prev) ? prev : converted[0].path
              );
            } else {
              setDiffsBySession((prev) => ({ ...prev, [sessionId]: [] }));
            }
          } else {
            setDiffsBySession((prev) => ({ ...prev, [sessionId]: [] }));
          }
        }
      } finally {
        setDiffLoading(false);
      }
    },
    [daemonUrl]
  );

  useEffect(() => {
    isPinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
    refreshSessionDiffAndFiles(activeSession.id);
    requestAnimationFrame(() => {
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    });
  }, [activeSession.id, refreshSessionDiffAndFiles]);

  // Load persisted event history from ~/.velo/events/<session-id>.json on startup or session switch
  useEffect(() => {
    const sid = activeSession.id;
    if (!sid || sid.startsWith("sess-") || sid.startsWith("wt-")) return;
    if (eventsBySession[sid] && eventsBySession[sid].length > 0) return;

    fetch(`${daemonUrl}/api/sessions/${sid}/events`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((rawList: Array<Record<string, unknown>>) => {
        if (!Array.isArray(rawList) || rawList.length === 0) return;
        const reconstructed = reconstructEventsFromHistory(sid, rawList);
        if (reconstructed.length > 0) {
          setEventsBySession((prev) =>
            prev[sid] && prev[sid].length > 0 ? prev : { ...prev, [sid]: reconstructed }
          );
        }
      })
      .catch(() => {
        if (e2eeRelayConfig && e2eeWsRef.current && e2eeWsRef.current.readyState === WebSocket.OPEN) {
          const sealed = e2eeSealJson(
            e2eeRelayConfig.sharedKeyHex,
            "mobile-web",
            e2eeNonceRef.current++,
            { cmd: "get_events", session_id: sid }
          );
          e2eeWsRef.current.send(sealed);
        }
      });
  }, [activeSession.id, daemonUrl, e2eeRelayConfig, eventsBySession]);

  const fetchPairTicket = useCallback(
    (relayOverride?: string) => {
      const qs =
        relayOverride && relayOverride.trim()
          ? `?relay=${encodeURIComponent(relayOverride.trim())}`
          : "";
      fetch(`${daemonUrl}/api/pair${qs}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((ticket: PairingTicketDto) => {
          setPairTicket(ticket);
          if (typeof ticket.custom_relay_url === "string") {
            setCustomRelayInput(ticket.custom_relay_url);
          }
        })
        .catch(() => {});
    },
    [daemonUrl]
  );

  const handleRotateRelayKey = useCallback(async () => {
    setRotatingRelayKey(true);
    try {
      const res = await fetch(`${daemonUrl}/api/relay/rotate`, { method: "POST" });
      if (res.ok) {
        fetchPairTicket();
      }
    } catch {
      // ignore
    } finally {
      setRotatingRelayKey(false);
    }
  }, [daemonUrl, fetchPairTicket]);

  // Fetch Pairing Ticket & poll live E2EE bridge/tunnel status while QR modal is open
  useEffect(() => {
    if (activeModal !== "qr") return;
    fetchPairTicket();
    const timer = window.setInterval(() => {
      fetch(`${daemonUrl}/api/relay/status`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((st: E2EEBridgeStatusDto) => {
          setPairTicket((prev) => {
            if (!prev) return prev;
            const prevReady = prev.e2ee_status?.tunnel?.public_wss_url;
            const nextReady = st?.tunnel?.public_wss_url;
            if (!prevReady && nextReady && !prev.custom_relay_url) {
              fetchPairTicket();
            }
            return { ...prev, e2ee_status: st };
          });
        })
        .catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeModal, daemonUrl, fetchPairTicket]);

  // Shared event dispatcher for both direct Daemon `/ws` and E2EE `velo-relay` (`ChaCha20-Poly1305`)
  const processServerPayload = useCallback(
    (raw: Record<string, unknown>) => {
      if (raw.type === "models_snapshot" && Array.isArray(raw.models)) {
        setModelCatalog(raw.models as ModelOption[]);
        return;
      }
      if (raw.kind === "sessions_snapshot" && Array.isArray(raw.sessions)) {
        const normalized = raw.sessions.map((item, idx) => normalizeToVeloSession(item, idx));
        if (normalized.length > 0) {
          setSessions(normalized);
          if (!initialDaemonSyncedRef.current) {
            initialDaemonSyncedRef.current = true;
            setActiveId((curId) =>
              curId === "sess-default" || !curId ? normalized[0].id : curId
            );
          }
        }
        return;
      }

      if (
        raw.type === "events_snapshot" &&
        typeof raw.session_id === "string" &&
        Array.isArray(raw.events)
      ) {
        const snapSid = raw.session_id;
        const reconstructed = reconstructEventsFromHistory(
          snapSid,
          raw.events as Array<Record<string, unknown>>
        );
        if (reconstructed.length > 0) {
          setEventsBySession((prev) =>
            prev[snapSid] && prev[snapSid].length > 0 ? prev : { ...prev, [snapSid]: reconstructed }
          );
        }
        return;
      }

      const now = new Date().toLocaleTimeString([], { hour12: false });
      const evObj =
        raw.kind === "event" && raw.event && typeof raw.event === "object"
          ? (raw.event as Record<string, unknown>)
          : raw;

      const evType = String(evObj.type ?? "");
      const sid = String(evObj.session_id ?? "");
      if (!sid) return;

      if (evType === "user_message") {
        const text = String(evObj.text ?? "").trim();
        const imgs = Array.isArray(evObj.images) ? evObj.images.map(String).filter(Boolean) : [];
        if (!text && imgs.length === 0) return;
        setEventsBySession((prev) => {
          const list = prev[sid] || [];
          // Deduplicate against optimistic user bubble already appended locally
          const alreadyRendered = list
            .slice(-3)
            .some((item) => item.kind === "user" && item.content.trim() === text);
          if (alreadyRendered) return prev;
          return {
            ...prev,
            [sid]: [
              ...list,
              {
                id: `u-ws-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                session_id: sid,
                timestamp: now,
                kind: "user",
                content: text,
                images: imgs.length > 0 ? imgs : undefined,
              },
            ],
          };
        });
        scrollChatToBottom(true);
        return;
      }

      if (evType === "permission_requested") {
        const reqId = String(evObj.request_id ?? `perm-${Date.now()}`);
        const toolName = String(evObj.tool_name ?? "Bash");
        const cmdPreview = String(evObj.command_preview ?? evObj.description ?? toolName);
        const reason = String(evObj.description ?? "");
        setPendingApprovals((prev) => ({
          ...prev,
          [sid]: {
            id: reqId,
            toolName,
            command: cmdPreview,
            reason,
          },
        }));
        setSessions((prev) =>
          prev.map((s) => (s.id === sid ? { ...s, status: "waiting_approval" } : s))
        );
        scrollChatToBottom(true);
        return;
      }

      if (evType === "permission_resolved") {
        setPendingApprovals((prev) => {
          const next = { ...prev };
          delete next[sid];
          return next;
        });
        return;
      }

      if (evType === "user_question_requested") {
        const qId = String(evObj.question_id ?? `q-${Date.now()}`);
        const question = String(evObj.question ?? "Please select an option:");
        const options = Array.isArray(evObj.options) ? evObj.options.map(String) : [];
        const allowMultiple = Boolean(evObj.allow_multiple);
        setPendingQuestions((prev) => ({
          ...prev,
          [sid]: {
            id: qId,
            question,
            options,
            allowMultiple,
          },
        }));
        scrollChatToBottom(true);
        return;
      }

      if (evType === "user_question_answered") {
        setPendingQuestions((prev) => {
          const next = { ...prev };
          delete next[sid];
          return next;
        });
        return;
      }

      if (evType === "browser_command") {
        const url = typeof evObj.url === "string" ? evObj.url : null;
        if (url) {
          setSessions((prev) =>
            prev.map((s) => (s.id === sid ? { ...s, preview_url: url } : s))
          );
          setDrawerTab("browser");
          setDrawerOpen(true);
        }
        return;
      }

      if (evType === "setup_hook_output") {
        const cmd = String(evObj.command ?? ".velo/setup.sh");
        const out = String(evObj.output ?? "(exit 0)");
        const code = Number(evObj.exit_code ?? 0);
        setEventsBySession((prev) => ({
          ...prev,
          [sid]: [
            ...(prev[sid] || []),
            {
              id: `hook-${Date.now()}`,
              session_id: sid,
              timestamp: now,
              kind: "tool_call",
              tool_name: "Worktree Setup Hook",
              tool_args: cmd,
              tool_input: { command: cmd },
              tool_output: out,
              tool_is_error: code !== 0,
              content: out,
            },
          ],
        }));
        return;
      }

      if (evType === "provider_session_bound") {
        const providerThread = String(evObj.provider_session_id ?? "").trim();
        setTurnTimingBySession((prev) => {
          const cur = prev[sid] || { startedAtMs: Date.now() };
          return {
            ...prev,
            [sid]: {
              ...cur,
              bootStage: "bound",
              providerThreadShort: providerThread ? providerThread.slice(0, 8) : undefined,
            },
          };
        });
        return;
      }

      // Record Time-To-First-Token (TTFT) on the earliest reasoning / tool / text packet in the turn
      if (
        evType === "thinking_chunk" ||
        evType === "thinking_delta" ||
        evType === "tool_call_requested" ||
        evType === "message_chunk" ||
        evType === "message_delta"
      ) {
        setTurnTimingBySession((prev) => {
          const cur = prev[sid];
          if (!cur || cur.ttftMs !== undefined) return prev;
          return {
            ...prev,
            [sid]: {
              ...cur,
              ttftMs: Math.max(80, Date.now() - cur.startedAtMs),
            },
          };
        });
      }

      if (evType === "status_changed") {
        const st = String(evObj.status ?? "");
        const statusMsg = String(evObj.message ?? "");
        if (st === "running") {
          const pidMatch = statusMsg.match(/PID\s+(?:Some\()?(\d+)/i);
          const parsedPid = pidMatch ? Number(pidMatch[1]) : undefined;
          if (!turnStartMsRef.current[sid]) {
            turnStartMsRef.current[sid] = Date.now();
          }
          if (!stepStartMsRef.current[sid]) {
            stepStartMsRef.current[sid] = turnStartMsRef.current[sid];
          }
          setTurnTimingBySession((prev) => {
            const cur = prev[sid];
            return {
              ...prev,
              [sid]: {
                startedAtMs: cur?.startedAtMs || turnStartMsRef.current[sid] || Date.now(),
                ttftMs: cur?.ttftMs,
                bootStage: cur?.bootStage === "bound" ? "bound" : "spawned",
                agentPid: parsedPid ?? cur?.agentPid,
                providerThreadShort: cur?.providerThreadShort,
              },
            };
          });
        } else if (st === "completed" || st === "failed" || st === "stopped") {
          const nowDoneMs = Date.now();
          const startedAtMs = turnStartMsRef.current[sid] || nowDoneMs - 1000;
          const stepOriginMs = stepStartMsRef.current[sid] || startedAtMs;
          delete turnStartMsRef.current[sid];
          delete stepStartMsRef.current[sid];
          const computedDur = Math.max(500, nowDoneMs - startedAtMs);
          setTurnTimingBySession((prev) => {
            const cur = prev[sid];
            const sMs = cur?.startedAtMs || startedAtMs;
            return {
              ...prev,
              [sid]: {
                ...cur,
                startedAtMs: sMs,
                durationMs: Math.max(500, nowDoneMs - sMs),
                completedAtLabel: now,
              },
            };
          });
          // Finalize active streaming chunks & stamp per-turn duration onto the turn's user message
          setEventsBySession((prev) => {
            const list = prev[sid];
            if (!list || list.length === 0) return prev;
            let lastUserIdx = -1;
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i].kind === "user") {
                lastUserIdx = i;
                break;
              }
            }
            return {
              ...prev,
              [sid]: list.map((item, idx) => {
                if (idx === lastUserIdx) {
                  return {
                    ...item,
                    duration_ms: computedDur,
                    completed_at: now,
                  };
                }
                if (item.is_streaming_chunk) {
                  const finalizedDur =
                    item.kind === "thinking"
                      ? item.duration_ms ??
                        Math.max(500, nowDoneMs - (item.started_at_ms || stepOriginMs))
                      : item.duration_ms;
                  return {
                    ...item,
                    is_streaming_chunk: false,
                    duration_ms: finalizedDur,
                  };
                }
                return item;
              }),
            };
          });
        }
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  status:
                    st === "running"
                      ? "running"
                      : st === "waiting_for_permission" || st === "waiting_permission"
                      ? "waiting_approval"
                      : "idle",
                  updated_at: "just now",
                }
              : s
          )
        );
        if (st === "completed") {
          refreshSessionDiffAndFiles(sid);
          // Fallback sync ONLY if WebSocket missed the final assistant message in this turn
          fetch(`${daemonUrl}/api/sessions/${sid}/events`)
            .then((r) => (r.ok ? r.json() : Promise.reject()))
            .then((evList: Array<Record<string, unknown>>) => {
              if (!Array.isArray(evList)) return;
              let lastRunStart = 0;
              for (let i = evList.length - 1; i >= 0; i--) {
                if (evList[i].type === "status_changed" && evList[i].status === "running") {
                  lastRunStart = i;
                  break;
                }
              }
              const latestTurnEvents = evList.slice(lastRunStart);
              const texts = latestTurnEvents
                .filter((e) => e.type === "message_delta" && typeof e.text === "string")
                .map((e) => String(e.text).trim())
                .filter(Boolean);
              if (texts.length === 0) return;

              setEventsBySession((prev) => {
                const list = prev[sid] || [];
                let lastUserIdx = -1;
                for (let i = list.length - 1; i >= 0; i--) {
                  if (list[i].kind === "user") {
                    lastUserIdx = i;
                    break;
                  }
                }
                const hasAssistantInTurn = list
                  .slice(lastUserIdx + 1)
                  .some((item) => item.kind === "assistant" && item.content.trim().length > 0);
                if (hasAssistantInTurn) return prev;

                const lastText = texts[texts.length - 1];
                return {
                  ...prev,
                  [sid]: [
                    ...list,
                    {
                      id: `as-sync-${Date.now()}`,
                      session_id: sid,
                      timestamp: now,
                      kind: "assistant",
                      content: lastText,
                      is_streaming_chunk: false,
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

      if (evType === "thinking_chunk") {
        const delta = String(evObj.delta ?? "");
        const replace = Boolean(evObj.replace);
        const originMs =
          stepStartMsRef.current[sid] || turnStartMsRef.current[sid] || Date.now();
        setEventsBySession((prev) => {
          const list = prev[sid] || [];
          const last = list[list.length - 1];
          if (last && last.kind === "thinking") {
            const nextContent = replace
              ? delta || last.content
              : `${last.content}${delta}`;
            return {
              ...prev,
              [sid]: [
                ...list.slice(0, -1),
                {
                  ...last,
                  content: nextContent,
                  started_at_ms: last.started_at_ms || originMs,
                  is_streaming_chunk: true,
                },
              ],
            };
          }
          return {
            ...prev,
            [sid]: [
              ...list,
              {
                id: `th-stream-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                session_id: sid,
                timestamp: now,
                kind: "thinking",
                content: delta,
                started_at_ms: originMs,
                is_streaming_chunk: true,
              },
            ],
          };
        });
        scrollChatToBottom(false);
        return;
      }

      if (evType === "thinking_delta") {
        const text = String(evObj.text ?? "").trim();
        if (!text) return;
        const nowMs = Date.now();
        const originMs =
          stepStartMsRef.current[sid] || turnStartMsRef.current[sid] || nowMs;
        stepStartMsRef.current[sid] = nowMs;
        setEventsBySession((prev) => {
          const list = prev[sid] || [];
          const last = list[list.length - 1];
          // Strictly chronological: update trailing thinking block or push at tail (never jump above earlier tools/messages)
          if (last && last.kind === "thinking") {
            const nextContent = last.is_streaming_chunk
              ? text
              : last.content.trim() === text || last.content.endsWith(text)
              ? last.content
              : `${last.content}\n${text}`.trim();
            const startRef = last.started_at_ms || originMs;
            const computedThinkDur = Math.max(
              500,
              last.is_streaming_chunk
                ? nowMs - startRef
                : (last.duration_ms || 0) + Math.max(0, nowMs - originMs)
            );
            return {
              ...prev,
              [sid]: [
                ...list.slice(0, -1),
                {
                  ...last,
                  content: nextContent,
                  started_at_ms: startRef,
                  duration_ms: computedThinkDur,
                  is_streaming_chunk: false,
                },
              ],
            };
          }
          const computedThinkDur = Math.max(500, nowMs - originMs);
          return {
            ...prev,
            [sid]: [
              ...list,
              {
                id: `th-${nowMs}-${Math.random().toString(36).slice(2, 5)}`,
                session_id: sid,
                timestamp: now,
                kind: "thinking",
                content: text,
                started_at_ms: originMs,
                duration_ms: computedThinkDur,
                is_streaming_chunk: false,
              },
            ],
          };
        });
        scrollChatToBottom(false);
        return;
      }

      if (evType === "tool_call_requested") {
        const toolId = String(evObj.tool_id ?? `tl-${Date.now()}`);
        const toolName = String(evObj.tool_name ?? "Tool");
        const argsObj = (
          evObj.arguments && typeof evObj.arguments === "object" ? evObj.arguments : {}
        ) as Record<string, unknown>;
        const argSummary = String(
          argsObj.file_path ??
            argsObj.path ??
            argsObj.command ??
            argsObj.pattern ??
            argsObj.query ??
            (Object.keys(argsObj).length > 0 ? JSON.stringify(argsObj).slice(0, 80) : "")
        );
        const nowReqMs = Date.now();
        const originMs =
          stepStartMsRef.current[sid] || turnStartMsRef.current[sid] || nowReqMs;
        setEventsBySession((prev) => {
          const rawList = prev[sid] || [];
          // Finalize any preceding streaming block cleanly before running tool
          const list = rawList.map((item, idx) =>
            idx === rawList.length - 1 && item.is_streaming_chunk
              ? {
                  ...item,
                  is_streaming_chunk: false,
                  duration_ms:
                    item.kind === "thinking"
                      ? item.duration_ms ??
                        Math.max(500, nowReqMs - (item.started_at_ms || originMs))
                      : item.duration_ms,
                }
              : item
          );
          const existingIdx = list.findIndex(
            (item) => item.kind === "tool_call" && item.id === toolId
          );
          if (existingIdx !== -1) {
            const next = [...list];
            next[existingIdx] = {
              ...next[existingIdx],
              tool_name: toolName,
              tool_args: argSummary || next[existingIdx].tool_args,
              tool_input:
                Object.keys(argsObj).length > 0 ? argsObj : next[existingIdx].tool_input,
              content:
                next[existingIdx].tool_output !== undefined
                  ? next[existingIdx].content
                  : JSON.stringify(argsObj, null, 2),
            };
            return { ...prev, [sid]: next };
          }
          const toolEv: AgentEvent = {
            id: toolId,
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
          return {
            ...prev,
            [sid]: [...list, toolEv],
          };
        });
        scrollChatToBottom(false);
        return;
      }

      if (evType === "tool_call_completed") {
        stepStartMsRef.current[sid] = Date.now();
        const toolId = String(evObj.tool_id ?? "");
        const output = String(evObj.output ?? "(completed)");
        const isError = Boolean(evObj.is_error);
        setEventsBySession((prev) => {
          const list = prev[sid] || [];
          let idx = list.findIndex((item) => item.id === toolId);
          if (idx === -1) {
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
        scrollChatToBottom(false);
        return;
      }

      if (evType === "usage_updated") {
        const totalTok = Number(evObj.total_tokens ?? 0);
        const costDelta = Number(evObj.cost_usd ?? 0);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  tokens_used: totalTok > 0 ? totalTok : s.tokens_used,
                  cost_usd: costDelta > 0 ? (s.cost_usd || 0) + costDelta : s.cost_usd,
                }
              : s
          )
        );
        return;
      }

      if (evType === "terminal_output") {
        const chunk = String(evObj.data ?? "");
        if (!chunk) return;
        termSeqRef.current += 1;
        setLatestTerminalChunk({
          seq: termSeqRef.current,
          sessionId: sid,
          data: chunk,
        });
        return;
      }

      if (evType === "message_chunk") {
        const delta = String(evObj.delta ?? "");
        const replace = Boolean(evObj.replace);
        if (!delta) return;
        const nowChunkMs = Date.now();
        const originMs =
          stepStartMsRef.current[sid] || turnStartMsRef.current[sid] || nowChunkMs;
        setEventsBySession((prev) => {
          const list = prev[sid] || [];
          const last = list[list.length - 1];
          if (last && last.kind === "assistant" && last.is_streaming_chunk) {
            const updatedLast: AgentEvent = {
              ...last,
              content: replace ? delta : `${last.content}${delta}`,
            };
            return { ...prev, [sid]: [...list.slice(0, -1), updatedLast] };
          }
          const cleanedPrev =
            last && last.kind === "thinking" && last.is_streaming_chunk
              ? [
                  ...list.slice(0, -1),
                  {
                    ...last,
                    is_streaming_chunk: false,
                    duration_ms:
                      last.duration_ms ??
                      Math.max(500, nowChunkMs - (last.started_at_ms || originMs)),
                  },
                ]
              : list;
          return {
            ...prev,
            [sid]: [
              ...cleanedPrev,
              {
                id: `as-stream-${nowChunkMs}-${Math.random().toString(36).slice(2, 5)}`,
                session_id: sid,
                timestamp: now,
                kind: "assistant",
                content: delta,
                is_streaming_chunk: true,
              },
            ],
          };
        });
        scrollChatToBottom(false);
        return;
      }

      if (evType === "message_delta") {
        const text = String(evObj.text ?? "");
        if (!text.trim()) return;
        const nowMsgMs = Date.now();
        const originMs =
          stepStartMsRef.current[sid] || turnStartMsRef.current[sid] || nowMsgMs;
        stepStartMsRef.current[sid] = nowMsgMs;
        setEventsBySession((prev) => {
          const list = prev[sid] || [];
          // Search current post-tool / post-user segment for a streaming assistant block
          let targetIdx = -1;
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].kind === "user" || list[i].kind === "tool_call") break;
            if (list[i].kind === "assistant") {
              targetIdx = i;
              break;
            }
          }
          if (targetIdx !== -1) {
            const existing = list[targetIdx];
            const nextContent = existing.is_streaming_chunk
              ? text
              : existing.content.trim() === text.trim()
              ? existing.content
              : text.startsWith(existing.content)
              ? text
              : `${existing.content}\n\n${text}`.trim();
            const next = [...list];
            next[targetIdx] = {
              ...existing,
              content: nextContent,
              is_streaming_chunk: false,
            };
            return { ...prev, [sid]: next };
          }
          const last = list[list.length - 1];
          const cleanedPrev =
            last && last.kind === "thinking" && last.is_streaming_chunk
              ? [
                  ...list.slice(0, -1),
                  {
                    ...last,
                    is_streaming_chunk: false,
                    duration_ms:
                      last.duration_ms ??
                      Math.max(500, nowMsgMs - (last.started_at_ms || originMs)),
                  },
                ]
              : list;
          return {
            ...prev,
            [sid]: [
              ...cleanedPrev,
              {
                id: `as-${nowMsgMs}-${Math.random().toString(36).slice(2, 5)}`,
                session_id: sid,
                timestamp: now,
                kind: "assistant",
                content: text,
                is_streaming_chunk: false,
              },
            ],
          };
        });
        scrollChatToBottom(false);
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
        scrollChatToBottom(false);
      }
    },
    [daemonUrl, refreshSessionDiffAndFiles, scrollChatToBottom]
  );

  // Subscribe to live WebSocket events from real Claude Code / Codex / ACP turns
  useEffect(() => {
    const wsUrl = `${daemonUrl.replace(/^http/, "ws")}/ws`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        directWsConnectedRef.current = true;
        setConnected(true);
      };
      ws.onmessage = (msg) => {
        try {
          const raw = JSON.parse(msg.data) as Record<string, unknown>;
          processServerPayload(raw);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        directWsConnectedRef.current = false;
        setConnected(Boolean(e2eeWsRef.current && e2eeWsRef.current.readyState === WebSocket.OPEN));
      };
    } catch {
      directWsConnectedRef.current = false;
      setConnected(false);
    }
    return () => {
      directWsConnectedRef.current = false;
      if (ws) ws.close();
    };
  }, [daemonUrl, processServerPayload]);

  // Connect to True E2EE Remote Relay (`ChaCha20-Poly1305`) when `?relay=...&room=...&key=...` is present
  useEffect(() => {
    if (!e2eeRelayConfig) return;
    const roomWsUrl = `${e2eeRelayConfig.relayUrl.replace(/\/$/, "")}/room/${e2eeRelayConfig.roomId}`;
    let rws: WebSocket | null = null;
    try {
      rws = new WebSocket(roomWsUrl);
      e2eeWsRef.current = rws;
      rws.onopen = () => {
        setE2eeConnected(true);
        setConnected(true);
        const syncFrame = e2eeSealJson(
          e2eeRelayConfig.sharedKeyHex,
          "mobile-web",
          e2eeNonceRef.current++,
          { cmd: "sync" }
        );
        rws?.send(syncFrame);
      };
      rws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        // Avoid double-appending streaming chunks when direct LAN `/ws` is already open
        if (directWsConnectedRef.current) return;
        const opened = e2eeOpenFrame(e2eeRelayConfig.sharedKeyHex, ev.data);
        if (!opened || opened.senderId === "mobile-web") return;
        processServerPayload(opened.message);
      };
      rws.onclose = () => {
        setE2eeConnected(false);
        e2eeWsRef.current = null;
      };
    } catch {
      setE2eeConnected(false);
    }
    return () => {
      if (rws) rws.close();
      e2eeWsRef.current = null;
    };
  }, [e2eeRelayConfig, processServerPayload]);

  const sendE2eeCommand = useCallback(
    (payload: Record<string, unknown>): boolean => {
      if (!e2eeRelayConfig || !e2eeWsRef.current || e2eeWsRef.current.readyState !== WebSocket.OPEN) {
        return false;
      }
      const sealed = e2eeSealJson(
        e2eeRelayConfig.sharedKeyHex,
        "mobile-web",
        e2eeNonceRef.current++,
        payload
      );
      e2eeWsRef.current.send(sealed);
      return true;
    },
    [e2eeRelayConfig]
  );

  // Frictionless 1-click "New thread" (Paseo / Codex / Claude Desktop feel):
  // Immediately switches to a clean idle thread and focuses the Composer without modal friction
  const handleQuickNewThread = useCallback(
    (targetRepoOverride?: VeloRepo) => {
      const targetRepo = targetRepoOverride || activeRepo;
      const existingEmpty = sessions.find(
        (s) =>
          s.repo_id === targetRepo.id &&
          s.title === "New thread" &&
          s.status === "idle" &&
          (eventsBySession[s.id]?.length ?? 0) === 0
      );
      if (existingEmpty) {
        setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
        setActiveId(existingEmpty.id);
        setActiveModal(null);
        setTimeout(() => composerTextareaRef.current?.focus(), 20);
        return;
      }

      const shortRand = Math.random().toString(36).slice(2, 6);
      const branch = `feat/thread-${shortRand}`;
      const newId = `wt-${Date.now()}`;
      const freshSession: VeloSession = {
        id: newId,
        repo_id: targetRepo.id,
        title: "New thread",
        agent_kind: activeSession.agent_kind || "claude",
        model: activeSession.model || "claude-fable-5-2",
        model_short: activeSession.model_short || "Fable 5.2",
        effort: activeSession.effort || "medium",
        status: "idle",
        branch_name: branch,
        worktree_path: `${targetRepo.path}/.velo/worktrees/feat-thread-${shortRand}`,
        project_path: targetRepo.path,
        approval_mode: activeSession.approval_mode || "auto_edit",
        tokens_used: 0,
        tokens_limit: 200000,
        cost_usd: 0,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        updated_at: "now",
      };
      setSessions((prev) => [freshSession, ...prev]);
      setEventsBySession((prev) => ({ ...prev, [newId]: [] }));
      setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
      setActiveId(newId);
      setActiveModal(null);
      setTimeout(() => composerTextareaRef.current?.focus(), 20);
    },
    [activeRepo, activeSession, eventsBySession, sessions]
  );

  const stopSessionRef = useRef<() => void>(() => {});

  // Global Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleQuickNewThread();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        if (
          activeSession.status === "running" ||
          activeSession.status === "waiting_approval"
        ) {
          e.preventDefault();
          stopSessionRef.current();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
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
  }, [
    activeModal,
    activeSession.status,
    drawerOpen,
    slashFilter,
    modelPickerOpen,
    effortPickerOpen,
    handleQuickNewThread,
  ]);

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

  const resolveAttachmentUrl = useCallback(
    (imgRef: string): string => {
      if (!imgRef) return "";
      if (imgRef.startsWith("http://") || imgRef.startsWith("https://") || imgRef.startsWith("data:")) {
        return imgRef;
      }
      if (imgRef.startsWith("/api/attachments/")) {
        return `${daemonUrl}${imgRef}`;
      }
      const basename = imgRef.split("/").pop() || imgRef;
      return `${daemonUrl}/api/attachments/${basename}`;
    },
    [daemonUrl]
  );

  const handleUploadImageFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      setUploadingAttachment(true);
      try {
        for (const file of files) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("read failed"));
            reader.readAsDataURL(file);
          });
          const res = await fetch(`${daemonUrl}/api/attachments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: file.name || "pasted-image.png",
              mime_type: file.type || "image/png",
              data_base64: dataUrl,
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              filename: string;
              path: string;
              url: string;
            };
            setPendingAttachments((prev) => [
              ...prev,
              {
                filename: data.filename,
                path: data.path,
                url: `${daemonUrl}${data.url}`,
              },
            ]);
          }
        }
      } catch {
        // ignore upload failure
      } finally {
        setUploadingAttachment(false);
      }
    },
    [daemonUrl]
  );

  const handleSendPrompt = async (
    customText?: string,
    overridePriorEvents?: AgentEvent[],
    truncateToUserTurn?: number,
    overrideImages?: string[]
  ) => {
    const attachedPaths =
      overrideImages !== undefined ? overrideImages : pendingAttachments.map((a) => a.path);
    const rawTyped = (customText ?? prompt).trim();
    if (!rawTyped && attachedPaths.length === 0) return;

    const rawText = rawTyped || "Please inspect the attached image(s).";
    const text = rawText;

    setPrompt("");
    setSlashFilter(null);
    if (overrideImages === undefined) {
      setPendingAttachments([]);
    }

    if (rawText.toLowerCase() === "/automations") {
      setActiveModal("automations");
      return;
    }
    if (rawText.toLowerCase() === "/pr") {
      setDrawerTab("pr");
      setDrawerOpen(true);
      return;
    }
    if (rawText.toLowerCase() === "/browser") {
      setDrawerTab("browser");
      setDrawerOpen(true);
      return;
    }

    const now = new Date().toLocaleTimeString([], { hour12: false });
    const baseEvents = overridePriorEvents ?? (eventsBySession[activeSession.id] || []);
    const userEv: AgentEvent = {
      id: `u-${Date.now()}`,
      session_id: activeSession.id,
      timestamp: now,
      kind: "user",
      content: text,
      images: attachedPaths.length > 0 ? attachedPaths : undefined,
    };

    const startedAtMs = Date.now();
    turnStartMsRef.current[activeSession.id] = startedAtMs;
    stepStartMsRef.current[activeSession.id] = startedAtMs;
    setTurnTimingBySession((prev) => ({
      ...prev,
      [activeSession.id]: {
        startedAtMs,
        bootStage: "provisioning",
      },
    }));

    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: [...baseEvents, userEv],
    }));
    scrollChatToBottom(true);

    // Real Daemon /worktree-GC endpoint (Prune orphaned Git worktrees & stale locks)
    if (rawText.toLowerCase().startsWith("/worktree-gc")) {
      try {
        const res = await fetch(`${daemonUrl}/api/worktrees/prune`, { method: "POST" });
        if (res.ok) {
          const data = (await res.json()) as {
            pruned_count?: number;
            pruned_paths?: string[];
          };
          const count = data.pruned_count ?? 0;
          const details =
            data.pruned_paths && data.pruned_paths.length > 0
              ? `\n\n${data.pruned_paths.map((p) => `- \`${p}\``).join("\n")}`
              : "";
          const replyEv: AgentEvent = {
            id: `gc-${Date.now()}`,
            session_id: activeSession.id,
            timestamp: now,
            kind: "assistant",
            content:
              count > 0
                ? `Pruned **${count}** orphaned Git worktree(s) and cleaned repository worktree locks:${details}`
                : "All isolated Git worktrees under `~/.velo/worktrees` are clean — 0 orphaned directories found.",
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

    const providerName = activeSession.agent_kind || "claude";

    try {
      // 1. Send clean user input to existing daemon session (uses native `codex exec resume` / `claude --resume` or ACP session/load)
      const inputRes = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          model: activeSession.model,
          effort: activeSession.effort || "medium",
          provider: providerName,
          approval_mode: activeSession.approval_mode,
          truncate_to_user_turn: truncateToUserTurn,
          reset_thread: truncateToUserTurn !== undefined,
          images: attachedPaths,
        }),
      });

      if (inputRes.ok) {
        scrollChatToBottom(true);
        return;
      }

      // 2. If activeSession was a local thread not yet on the daemon, promote it to a real daemon session
      const createRes = await fetch(`${daemonUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nextTitle,
          provider: providerName,
          prompt: priorHistory.length > 0 ? promptWithContext : text,
          repo_path: activeRepo.path || "/Users/daiyudai/code/velo",
          branch: activeSession.branch_name,
          use_pty: false,
          model: activeSession.model,
          effort: activeSession.effort || "medium",
          approval_mode: activeSession.approval_mode,
          images: attachedPaths,
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
        turnStartMsRef.current[realSess.id] =
          turnStartMsRef.current[oldId] || startedAtMs;
        delete turnStartMsRef.current[oldId];
        setSessions((prev) => prev.map((s) => (s.id === oldId ? realSess : s)));
        setTurnTimingBySession((prev) => {
          const oldTiming = prev[oldId] || { startedAtMs };
          return {
            ...prev,
            [realSess.id]: oldTiming,
          };
        });
        setEventsBySession((prev) => {
          const fromOld = (prev[oldId] || []).map((ev) => ({
            ...ev,
            session_id: realSess.id,
          }));
          const fromNew = prev[realSess.id] || [];
          const mergedList: AgentEvent[] = [];
          for (const item of [...fromOld, ...fromNew]) {
            if (
              item.kind === "user" &&
              mergedList.some(
                (existing) =>
                  existing.kind === "user" &&
                  existing.content.trim() === item.content.trim()
              )
            ) {
              continue;
            }
            const last = mergedList[mergedList.length - 1];
            if (last && last.kind === "thinking" && item.kind === "thinking") {
              mergedList[mergedList.length - 1] = {
                ...last,
                content: `${last.content}\n${item.content}`.trim(),
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
        scrollChatToBottom(true);
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
      if (
        sendE2eeCommand({
          cmd: "send_input",
          session_id: activeSession.id,
          input: text,
          model: activeSession.model,
          effort: activeSession.effort || "medium",
          approval_mode: activeSession.approval_mode,
        })
      ) {
        return;
      }
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
            content: `⚠️ 无法连接到 Velo 守护进程 (${daemonUrl})，请确认电脑端 Velo 正在运行且处于同一网络或已连接 E2EE 中继。`,
          },
        ],
      }));
    }

    setTimeout(() => {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  // Stop currently running agent turn via POST /api/sessions/{id}/stop (or E2EE Relay)
  const handleStopSession = useCallback(async () => {
    const sid = activeSession.id;
    const stopNow = new Date().toLocaleTimeString([], { hour12: false });
    setTurnTimingBySession((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      return {
        ...prev,
        [sid]: {
          ...cur,
          durationMs: Math.max(300, Date.now() - cur.startedAtMs),
          completedAtLabel: stopNow,
        },
      };
    });
    setSessions((prev) =>
      prev.map((s) => (s.id === sid ? { ...s, status: "idle", updated_at: "now" } : s))
    );
    setEventsBySession((prev) => {
      const list = prev[sid] || [];
      const updated = list.map((item) => {
        if (item.kind === "tool_call" && item.tool_output === undefined) {
          return {
            ...item,
            tool_output: "(interrupted by user)",
            content: "(interrupted by user)",
            is_streaming_chunk: false,
          };
        }
        if (item.is_streaming_chunk) {
          return { ...item, is_streaming_chunk: false };
        }
        return item;
      });
      return { ...prev, [sid]: updated };
    });
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${sid}/stop`, {
        method: "POST",
      });
      if (!res.ok) {
        sendE2eeCommand({ cmd: "stop_session", session_id: sid });
      }
      refreshSessions();
    } catch {
      sendE2eeCommand({ cmd: "stop_session", session_id: sid });
    }
  }, [activeSession.id, daemonUrl, refreshSessions, sendE2eeCommand]);
  stopSessionRef.current = () => {
    void handleStopSession();
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
    const userTurnIdx = truncated.filter((item) => item.kind === "user").length;
    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: truncated,
    }));
    await handleSendPrompt(trimmed, truncated, userTurnIdx, ev.images || []);
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
    const userTurnIdx = truncated.filter((item) => item.kind === "user").length;
    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: truncated,
    }));
    await handleSendPrompt(ev.content, truncated, userTurnIdx, ev.images || []);
  };

  // Paseo Rewind Flow (packages/app/src/components/rewind/rewind-menu.tsx):
  // Rewinds conversation to before this user message and restores its text into the bottom Composer input
  const handleRewindUserMessage = async (ev: AgentEvent) => {
    if (activeSession.status === "running") {
      await handleStopSession();
    }
    const currentList = eventsBySession[activeSession.id] || [];
    const idx = currentList.findIndex((item) => item.id === ev.id);
    const truncated = idx >= 0 ? currentList.slice(0, idx) : currentList;
    const userTurnIdx = truncated.filter((item) => item.kind === "user").length;
    setEventsBySession((prev) => ({
      ...prev,
      [activeSession.id]: truncated,
    }));
    fetch(`${daemonUrl}/api/sessions/${activeSession.id}/rewind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ truncate_to_user_turn: userTurnIdx }),
    }).catch(() => {});
    setPrompt(ev.content);
    if (ev.images && ev.images.length > 0) {
      setPendingAttachments(
        ev.images.map((p) => ({
          filename: p.split("/").pop() || "image.png",
          path: p,
          url: resolveAttachmentUrl(p),
        }))
      );
    }
    setTimeout(() => {
      composerTextareaRef.current?.focus();
    }, 30);
  };

  // Delete / archive a thread from sidebar, daemon state, events history & isolated Git worktree
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
      await fetch(`${daemonUrl}/api/sessions/${sessionId}?cleanup_worktree=true`, {
        method: "DELETE",
      });
    } catch {
      // ignore if local-only
    }
  };

  // Rename session title inline and persist via PATCH /api/sessions/{id}
  const handleCommitRenameSession = async (sessionId: string) => {
    const clean = renamingTitle.trim();
    setRenamingSessionId(null);
    if (!clean) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, title: clean } : s))
    );
    try {
      await fetch(`${daemonUrl}/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clean }),
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

  // Real Bidirectional Permission Approval Resolution (`PreToolUse` / `velo_request_approval` / ACP)
  const handleResolveApproval = async (action: "approve" | "always" | "deny") => {
    const sid = activeSession.id;
    const pending = pendingApprovals[sid];
    if (!pending) return;

    setPendingApprovals((prev) => {
      const next = { ...prev };
      delete next[sid];
      return next;
    });

    setSessions((prev) =>
      prev.map((s) =>
        s.id === sid
          ? {
              ...s,
              status: "running",
              approval_mode: action === "always" ? "auto_edit" : s.approval_mode,
            }
          : s
      )
    );

    try {
      const res = await fetch(
        `${daemonUrl}/api/sessions/${sid}/approvals/${encodeURIComponent(pending.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: action }),
        }
      );
      if (!res.ok) {
        sendE2eeCommand({
          cmd: "resolve_approval",
          session_id: sid,
          request_id: pending.id,
          decision: action,
        });
      }
    } catch {
      sendE2eeCommand({
        cmd: "resolve_approval",
        session_id: sid,
        request_id: pending.id,
        decision: action,
      });
    }
  };

  // Real Bidirectional `AskUserQuestion` Resolution (`velo_ask_user`)
  const handleAnswerQuestion = async (answers: string[]) => {
    const sid = activeSession.id;
    const pendingQ = pendingQuestions[sid];
    if (!pendingQ) return;

    setPendingQuestions((prev) => {
      const next = { ...prev };
      delete next[sid];
      return next;
    });

    try {
      const res = await fetch(
        `${daemonUrl}/api/sessions/${sid}/questions/${encodeURIComponent(pendingQ.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        }
      );
      if (!res.ok) {
        sendE2eeCommand({
          cmd: "answer_question",
          session_id: sid,
          question_id: pendingQ.id,
          answers,
        });
      }
    } catch {
      sendE2eeCommand({
        cmd: "answer_question",
        session_id: sid,
        question_id: pendingQ.id,
        answers,
      });
    }
  };

  // Cycle Session Approval Mode (`auto_edit` -> `ask_before_edit` -> `bypass`)
  const handleToggleApprovalMode = () => {
    const nextMode: ApprovalMode =
      activeSession.approval_mode === "auto_edit"
        ? "ask_before_edit"
        : activeSession.approval_mode === "ask_before_edit"
        ? "bypass"
        : "auto_edit";
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSession.id ? { ...s, approval_mode: nextMode } : s))
    );
    fetch(`${daemonUrl}/api/sessions/${activeSession.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approval_mode: nextMode }),
    }).catch(() => {});
  };

  // Hands-Free Voice Dictation Input (Web Speech API + MediaRecorder `/api/transcribe` fallback)
  const handleToggleVoiceDictation = async () => {
    if (isDictating) {
      setIsDictating(false);
      speechRecRef.current?.stop();
      speechRecRef.current = null;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    const w = window as unknown as {
      SpeechRecognition?: new () => {
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null;
        onerror: (() => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
      };
      webkitSpeechRecognition?: new () => {
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null;
        onerror: (() => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
      };
    };

    const SpeechCtor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (SpeechCtor) {
      try {
        const rec = new SpeechCtor();
        rec.lang = navigator.language || "zh-CN";
        rec.continuous = true;
        rec.interimResults = false;
        rec.onresult = (ev) => {
          let finalChunk = "";
          for (let i = 0; i < ev.results.length; i++) {
            const resItem = ev.results[i];
            if (resItem.isFinal !== false && resItem[0]?.transcript) {
              finalChunk = resItem[0].transcript;
            }
          }
          if (finalChunk.trim()) {
            setPrompt((prev) => (prev ? `${prev} ${finalChunk.trim()}` : finalChunk.trim()));
          }
        };
        rec.onerror = () => setIsDictating(false);
        rec.onend = () => setIsDictating(false);
        speechRecRef.current = rec;
        setIsDictating(true);
        rec.start();
        return;
      } catch {
        // fallback to MediaRecorder below
      }
    }

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks: BlobPart[] = [];
        const mr = new MediaRecorder(stream);
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
          const b64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result || ""));
            reader.readAsDataURL(blob);
          });
          const res = await fetch(`${daemonUrl}/api/transcribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audio_base64: b64,
              mime_type: blob.type || "audio/webm",
              language: "zh",
            }),
          });
          if (res.ok) {
            const d = (await res.json()) as { ok?: boolean; text?: string };
            if (d.ok && d.text?.trim()) {
              setPrompt((prev) => (prev ? `${prev} ${d.text!.trim()}` : d.text!.trim()));
            }
          }
          setIsDictating(false);
        };
        mediaRecorderRef.current = mr;
        setIsDictating(true);
        mr.start();
      } catch {
        setIsDictating(false);
      }
    }
  };

  const handleSaveRepoHook = async (repoPath: string, cmd: string) => {
    setRepoHooks((prev) => ({ ...prev, [repoPath]: cmd }));
    await fetch(`${daemonUrl}/api/hooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_path: repoPath, setup_command: cmd }),
    }).catch(() => {});
  };

  const handleDispatchBatchDiffComments = async () => {
    if (draftDiffComments.length === 0) return;
    const formatted = [
      `Please address the following ${draftDiffComments.length} inline code review comment(s) in this worktree:`,
      ...draftDiffComments.map(
        (c, i) =>
          `${i + 1}. \`${c.filePath}:L${c.lineNum}\` (\`${c.codeContent}\`)\n   - Review request: ${c.comment}`
      ),
    ].join("\n\n");
    setDraftDiffComments([]);
    await handleSendPrompt(formatted);
  };

  // Create real isolated Git worktree (Single / Committee Race / TDD Loop)
  const handleCreateWorktree = async () => {
    const targetRepo = repos.find((r) => r.id === targetRepoIdForNewWt) || activeRepo;
    const clean = newTaskName.trim() || `feat/task-${sessions.length + 1}`;
    const branch =
      clean.startsWith("feat/") || clean.startsWith("fix/") || clean.startsWith("chore/")
        ? clean
        : `feat/${clean}`;
    const rawPrompt = newTaskDesc.trim();
    if (dispatchMode !== "single" && !rawPrompt) {
      return;
    }
    const displayTitle = rawPrompt ? rawPrompt.slice(0, 44) : "New thread";
    const chosenModel = modelCatalog.find((m) => m.id === newModelId) || modelCatalog[0];
    const providerName = chosenModel.agentKind || "claude";
    const setupCmd = newSetupCommand.trim() || undefined;

    if (setupCmd) {
      void handleSaveRepoHook(targetRepo.path, setupCmd);
    }

    try {
      if (dispatchMode === "committee") {
        const res = await fetch(`${daemonUrl}/api/committee`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name_prefix: clean.replace(/\//g, "-"),
            providers: ["claude", "codex"],
            prompt: rawPrompt,
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
            setNewTaskDesc("");
            setActiveModal(null);
            return;
          }
        }
      } else if (dispatchMode === "loop") {
        const res = await fetch(`${daemonUrl}/api/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: displayTitle,
            provider: providerName,
            prompt: rawPrompt,
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
          created.title = `[Loop] ${displayTitle}`;
          created.agent_kind = chosenModel.agentKind;
          created.model = chosenModel.id;
          created.model_short = chosenModel.shortLabel;
          setSessions((prev) => [created, ...prev]);
          setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
          setActiveId(created.id);
          setNewTaskDesc("");
          setActiveModal(null);
          return;
        }
      }

      const res = await fetch(`${daemonUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: displayTitle,
          provider: providerName,
          prompt: rawPrompt,
          repo_path: targetRepo.path,
          branch,
          use_pty: false,
          model: chosenModel.id,
          effort: "medium",
          approval_mode: newApproval,
          setup_command: setupCmd,
        }),
      });
      if (res.ok) {
        const rawSession = await res.json();
        const created = normalizeToVeloSession(rawSession, 0);
        created.repo_id = targetRepo.id;
        created.title = displayTitle;
        created.agent_kind = chosenModel.agentKind;
        created.model = chosenModel.id;
        created.model_short = chosenModel.shortLabel;
        if (!rawPrompt) {
          created.status = "idle";
          created.updated_at = "now";
        }
        setSessions((prev) => [created, ...prev]);
        setCollapsedRepos((prev) => ({ ...prev, [targetRepo.id]: false }));
        setActiveId(created.id);
        setNewTaskDesc("");
        setActiveModal(null);
        setTimeout(() => composerTextareaRef.current?.focus(), 30);
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
      title: displayTitle,
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

  // One-click Commit inside isolated worktree via POST /api/sessions/{id}/git/commit
  const handleCommitWorktree = async () => {
    const msg = commitMsg.trim() || "feat: update worktree";
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/git/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, push: false }),
      });
      if (res.ok) {
        const data = (await res.json()) as { stdout?: string; stderr?: string };
        const summary =
          (data.stdout || data.stderr || `Committed: ${msg}`).trim().split("\n")[0] ||
          `Committed: ${msg}`;
        setGitActionNotice(summary);
        setCommitBoxOpen(false);
        await refreshSessionDiffAndFiles(activeSession.id);
        refreshSessions();
        setTimeout(() => setGitActionNotice(null), 4000);
        return;
      }
    } catch {
      // fallback below
    }
    const safeMsg = msg.replace(/"/g, '\\"');
    const res = await executeInWorktree(`git add -A && git commit -m "${safeMsg}"`);
    const summary = (res.stdout || res.stderr || "Committed changes in worktree").split("\n")[0];
    setGitActionNotice(summary);
    setCommitBoxOpen(false);
    setTimeout(() => setGitActionNotice(null), 4000);
  };

  // One-click Discard single file or all changes in worktree via POST /api/sessions/{id}/git/discard
  const handleDiscardFile = async (filePath?: string, discardAll = false) => {
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/git/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: filePath, all: discardAll }),
      });
      if (res.ok) {
        setGitActionNotice(
          discardAll
            ? "Discarded all uncommitted worktree changes"
            : `Discarded changes in ${filePath?.split("/").pop() || "file"}`
        );
        await refreshSessionDiffAndFiles(activeSession.id);
        refreshSessions();
        setTimeout(() => setGitActionNotice(null), 3500);
      }
    } catch {
      // ignore
    }
  };

  // One-click Merge Worktree Branch into Main Repo via POST /api/sessions/{id}/git/merge
  const handleMergeWorktree = async () => {
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/git/merge`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        ok?: boolean;
        branch?: string;
        stdout?: string;
        stderr?: string;
      };
      if (res.ok && data.ok) {
        const summary =
          (data.stdout || "").trim().split("\n")[0] ||
          `Merged ${data.branch || activeSession.branch_name} into main`;
        setGitActionNotice(`✅ ${summary}`);
        await refreshSessionDiffAndFiles(activeSession.id);
        refreshSessions();
        setTimeout(() => setGitActionNotice(null), 4500);
        return;
      }
    } catch {
      // fallback below
    }
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
  const activePendingQuestion = pendingQuestions[activeSession.id];

  return (
    <div
      data-theme={resolvedTheme}
      data-tone={tone}
      className={`velo-variant-${variant} flex h-[100dvh] w-screen overflow-hidden select-none bg-[var(--v-bg-canvas)] text-[var(--v-fg-primary)] pt-[env(safe-area-inset-top)]`}
    >
      {/* Mobile Sidebar Backdrop (<768px) */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-[1px] md:hidden"
        />
      )}

      {/* =====================================================================
          1. AUTHENTIC CODEX / CLAUDE CODE / PASEO LEFT SIDEBAR
             - Seamless matte surface (#0c0c0e), ZERO boxed cards or heavy lines
             - Top: quiet nav rows (New thread, Search, Velo Hub Automations, Skills)
             - Body: Workspaces section -> clean Project rows -> borderless Thread rows
             - Idle rows keep empty leading slot; only active/waiting rows show indicator
             - Bottom: single icon-only footer bar
         ===================================================================== */}
      <aside
        className={`flex shrink-0 flex-col justify-between bg-[var(--v-bg-sidebar)] border-r border-[var(--v-border-subtle)] transition-all duration-200 overflow-hidden ${
          sidebarOpen
            ? "w-[252px] max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-2xl"
            : "w-0 border-r-0"
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
              onClick={() => handleQuickNewThread()}
              title="New thread (⌘N)"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <SquarePen className="h-4 w-4" />
            </button>
          </div>

          {/* Top Navigation Rows (Codex / Claude Code / Paseo SidebarNavRows) */}
          <div className="space-y-0.5 px-2 pb-3">
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleQuickNewThread()}
                className="flex h-[30px] flex-1 items-center justify-between rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              >
                <span className="flex items-center gap-2.5">
                  <Plus className="h-4 w-4 text-[var(--v-fg-muted)]" />
                  <span>New thread</span>
                </span>
                <span className="font-mono text-[11px] text-[var(--v-fg-faint)]">⌘N</span>
              </button>
              <button
                onClick={() => {
                  setTargetRepoIdForNewWt(activeRepo.id);
                  setNewSetupCommand(repoHooks[activeRepo.path] || "");
                  setActiveModal("new-worktree");
                }}
                title="Advanced Worktree / Committee Race / TDD Auto-Loop"
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
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
              onClick={() => setActiveModal("automations")}
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <CalendarClock className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
              <span>Cron &amp; Webhooks</span>
            </button>
            <button
              onClick={() => setActiveModal("skills")}
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <Layers className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
              <span>Skills &amp; Commands</span>
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
                        onClick={() => handleQuickNewThread(repo)}
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
                        const hasPending = !!pendingApprovals[w.id] || !!pendingQuestions[w.id];
                        return (
                          <div
                            key={w.id}
                            onClick={() => {
                              setActiveId(w.id);
                              if (typeof window !== "undefined" && window.innerWidth < 768) {
                                setSidebarOpen(false);
                              }
                            }}
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
                                  title="Waiting for permission approval or user answer"
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
                                {renamingSessionId === w.id ? (
                                  <input
                                    autoFocus
                                    value={renamingTitle}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setRenamingTitle(e.target.value)}
                                    onBlur={() => handleCommitRenameSession(w.id)}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === "Enter") {
                                        handleCommitRenameSession(w.id);
                                      } else if (e.key === "Escape") {
                                        setRenamingSessionId(null);
                                      }
                                    }}
                                    className="w-full rounded border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-1.5 py-0.5 text-[12.5px] text-[var(--v-fg-primary)] focus:outline-none"
                                  />
                                ) : (
                                  <span
                                    onDoubleClick={(e) => {
                                      e.stopPropagation();
                                      setRenamingSessionId(w.id);
                                      setRenamingTitle(w.title);
                                    }}
                                    title="Double-click to rename thread"
                                    className={`truncate text-[13px] leading-snug ${
                                      isSelected
                                        ? "font-medium text-[var(--v-fg-primary)]"
                                        : "font-normal"
                                    }`}
                                  >
                                    {w.title}
                                  </span>
                                )}
                                <div className="flex shrink-0 items-center gap-1">
                                  <span className="font-mono text-[11px] text-[var(--v-fg-faint)] group-hover:hidden">
                                    {w.updated_at}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRenamingSessionId(w.id);
                                      setRenamingTitle(w.title);
                                    }}
                                    title="Rename thread"
                                    className="hidden h-4 w-4 items-center justify-center rounded text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] group-hover:flex"
                                  >
                                    <SquarePen className="h-2.5 w-2.5" />
                                  </button>
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
              onClick={() => setActiveModal("automations")}
              title="Velo Hub: Cron Schedules & GitHub Webhooks"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <CalendarClock className="h-4 w-4" />
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
              title={`手机扫码连接 (${connected ? "守护进程在线" : "离线"})`}
              className="relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
            >
              <Smartphone className="h-4 w-4" />
              <span
                className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                style={{ background: connected || e2eeConnected ? "#34d399" : "#fbbf24" }}
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
              onClick={() => {
                setHookEditCmd(repoHooks[activeRepo.path] || "");
                setActiveModal("settings");
              }}
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
              className="hidden sm:inline-flex items-center gap-1 rounded-md bg-[var(--v-bg-hover)] px-2 py-0.5 font-mono text-[11px] text-[var(--v-fg-secondary)]"
            >
              <GitBranch className="h-3 w-3 text-[var(--v-fg-muted)]" />
              {activeSession.branch_name}
            </span>
          </div>

          {/* Right Header Controls: E2EE Badge, Open in IDE, Diff, PR, Preview & xterm Terminal */}
          <div className="relative flex items-center gap-1.5">
            {e2eeConnected && (
              <span
                title="End-to-End Encrypted Relay Active (X25519 + ChaCha20-Poly1305)"
                className="inline-flex items-center gap-1 rounded-md bg-[#34d399]/15 px-2 py-1 font-mono text-[10.5px] font-medium text-[#34d399]"
              >
                <Lock className="h-3 w-3" />
                <span className="hidden sm:inline">E2EE ChaCha20</span>
              </span>
            )}

            {mobileMode && !e2eeRelayConfig && (
              <button
                onClick={() => setMobileMode(false)}
                className="rounded-md bg-[#34d399]/15 px-2 py-1 font-mono text-[11px] font-medium text-[#34d399]"
              >
                Mobile Preview · Exit
              </button>
            )}

            <div className="relative hidden sm:block">
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
              title="Worktree Changes & Inline Code Review"
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
                if (drawerOpen && drawerTab === "pr") setDrawerOpen(false);
                else {
                  setDrawerTab("pr");
                  setDrawerOpen(true);
                }
              }}
              title="GitHub Pull Request Lifecycle & CI Checks"
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                drawerOpen && drawerTab === "pr"
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <GitPullRequest className="h-4 w-4" />
            </button>

            <button
              onClick={() => {
                if (drawerOpen && drawerTab === "browser") setDrawerOpen(false);
                else {
                  setDrawerTab("browser");
                  setDrawerOpen(true);
                }
              }}
              title="Live Browser Preview & Agent DOM Inspection"
              className={`relative flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                drawerOpen && drawerTab === "browser"
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <Globe className="h-4 w-4" />
              {activeSession.preview_url && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#34d399]" />
              )}
            </button>

            <button
              onClick={() => {
                if (drawerOpen && drawerTab === "terminal") setDrawerOpen(false);
                else {
                  setDrawerTab("terminal");
                  setDrawerOpen(true);
                }
              }}
              title="Toggle Full-Color xterm.js Terminal (⌘J)"
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                drawerOpen && drawerTab === "terminal"
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <Terminal className="h-4 w-4" />
            </button>

            {!mobileMode && (
              <button
                onClick={() => setActiveModal("qr")}
                title="手机扫码连接 (Mobile Remote)"
                className="flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">手机端</span>
              </button>
            )}
          </div>
        </header>

        {/* Mobile Remote Controller Session & Worktree Strip */}
        {mobileMode && (
          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] px-3 py-1.5">
            <button
              type="button"
              onClick={() => handleQuickNewThread()}
              className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--v-fg-primary)] active:scale-[0.98]"
            >
              <Plus className="h-3 w-3" />
              <span>新建</span>
            </button>
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
                  {(s.insertions > 0 || s.deletions > 0) && (
                    <span className="font-mono text-[10.5px] text-[#34d399]">+{s.insertions}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Body Area: Centered Conversation Stream + On-Demand Right Drawer */}
        <div className="relative flex flex-1 overflow-hidden">
          <main className="relative flex flex-1 flex-col items-center overflow-hidden">
            {/* Scrollable Stream (Authentic Paseo Stream Layout) */}
            <div
              ref={chatScrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
                isPinnedToBottomRef.current = nearBottom;
                setShowJumpToBottom(!nearBottom);
              }}
              className="w-full flex-1 overflow-y-auto px-3.5 py-4 sm:px-6 sm:py-6"
              data-testid="agent-chat-scroll"
            >
              <div className="mx-auto flex max-w-[680px] flex-col gap-1.5">
                {activeEvents.length === 0 && (
                  <div className="my-20 flex flex-col items-center justify-center gap-3 text-center select-none">
                    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-3 py-1 text-[12px] text-[var(--v-fg-secondary)]">
                      <GitBranch className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span className="font-medium text-[var(--v-fg-primary)]">
                        {activeRepo.name}
                      </span>
                      <span className="text-[var(--v-fg-faint)]">/</span>
                      <span className="font-mono text-[11.5px]">{activeSession.branch_name}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setTargetRepoIdForNewWt(activeRepo.id);
                        setNewSetupCommand(repoHooks[activeRepo.path] || "");
                        setActiveModal("new-worktree");
                      }}
                      className="text-[11.5px] text-[var(--v-fg-muted)] transition-colors hover:text-[var(--v-fg-primary)] cursor-pointer"
                    >
                      Configure isolated branch · Committee race · TDD loop →
                    </button>
                  </div>
                )}

                {(() => {
                  // Group flat chronological events into clean Paseo Conversation Turns
                  interface ConversationTurn {
                    key: string;
                    userEv: AgentEvent | null;
                    items: AgentEvent[];
                  }
                  const turns: ConversationTurn[] = [];
                  for (const ev of activeEvents) {
                    if (ev.kind === "user") {
                      turns.push({ key: ev.id, userEv: ev, items: [] });
                    } else if (turns.length === 0) {
                      turns.push({ key: `turn-init-${ev.id}`, userEv: null, items: [ev] });
                    } else {
                      turns[turns.length - 1].items.push(ev);
                    }
                  }

                  const activeTurnTiming = turnTimingBySession[activeSession.id];
                  const isSessionRunning =
                    activeSession.status === "running" ||
                    activeSession.status === "waiting_approval";

                  const waitingLabel = activePendingApproval
                    ? `Waiting for approval (${activePendingApproval.toolName || "Tool"})`
                    : activePendingQuestion
                    ? "Waiting for your answer"
                    : undefined;

                  return (
                    <>
                      {turns.map((turn, turnIdx) => {
                        const isLatestTurn = turnIdx === turns.length - 1;
                        const isTurnRunning = isLatestTurn && isSessionRunning;
                        const lastTurnItem = turn.items[turn.items.length - 1];
                        const lastTurnAssistant = [...turn.items]
                          .reverse()
                          .find((e) => e.kind === "assistant");

                        let turnPhase: AgentStatusPhase = "working";
                        let turnStatusLabel: string | undefined = "Working…";
                        if (isTurnRunning) {
                          if (waitingLabel) {
                            turnPhase = "waiting";
                            turnStatusLabel = waitingLabel;
                          } else if (!lastTurnItem) {
                            turnPhase = "thinking";
                            turnStatusLabel = undefined;
                          } else if (
                            lastTurnItem.kind === "thinking" &&
                            lastTurnItem.is_streaming_chunk
                          ) {
                            turnPhase = "working";
                            turnStatusLabel = "Working…";
                          } else if (
                            lastTurnItem.kind === "tool_call" &&
                            lastTurnItem.tool_output === undefined
                          ) {
                            const activeToolInput =
                              lastTurnItem.tool_input ??
                              (lastTurnItem.tool_args
                                ? { target: lastTurnItem.tool_args }
                                : lastTurnItem.content);
                            const pres = resolvePaseoToolPresentation(
                              lastTurnItem.tool_name || "Tool",
                              activeToolInput,
                              lastTurnItem.tool_output
                            );
                            turnPhase = "tool";
                            turnStatusLabel = `Working · ${pres.workingVerb}…`;
                          } else if (
                            lastTurnItem.kind === "assistant" &&
                            lastTurnItem.is_streaming_chunk
                          ) {
                            turnPhase = "writing";
                            turnStatusLabel = "Writing…";
                          } else {
                            turnPhase = "working";
                            turnStatusLabel = "Working…";
                          }
                        }

                        return (
                          <div key={turn.key} className="flex flex-col gap-1.5 pb-3">
                            {/* 1. User Message (Right-aligned Paseo Bubble + Hover Trailing Actions) */}
                            {turn.userEv &&
                              (() => {
                                const ev = turn.userEv;
                                const isEditing = editingEventId === ev.id;
                                if (isEditing) {
                                  return (
                                    <div className="mt-2 mb-1 flex justify-end">
                                      <div className="w-full max-w-[86%] rounded-2xl rounded-tr-[4px] border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-3.5 shadow-lg">
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
                                  <div
                                    data-testid="user-message"
                                    className="group mt-2 mb-0.5 flex flex-col items-end"
                                  >
                                    <div
                                      onClick={() => {
                                        if (!isSessionRunning) {
                                          handleStartEditMessage(ev);
                                        }
                                      }}
                                      title={!isSessionRunning ? "点击可编辑并重新发送" : undefined}
                                      className={`max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-tr-[4px] bg-[var(--v-bg-bubble)] px-4 py-2.5 text-[13.5px] leading-[1.48] text-[var(--v-fg-primary)] transition-colors ${
                                        !isSessionRunning
                                          ? "cursor-pointer hover:brightness-105"
                                          : ""
                                      }`}
                                    >
                                      {ev.images && ev.images.length > 0 && (
                                        <div className="mb-2 flex flex-wrap gap-2">
                                          {ev.images.map((imgRef, imgIdx) => (
                                            <img
                                              key={`${imgRef}-${imgIdx}`}
                                              src={resolveAttachmentUrl(imgRef)}
                                              alt="Attached screenshot"
                                              className="max-h-[180px] max-w-[260px] rounded-xl border border-[var(--v-border-subtle)] object-cover"
                                            />
                                          ))}
                                        </div>
                                      )}
                                      {ev.content}
                                    </div>
                                    <div
                                      data-testid="user-message-trailing-row"
                                      className="mt-1 flex h-5 items-center justify-end gap-1.5 text-[var(--v-fg-muted)] opacity-0 transition-opacity group-hover:opacity-100"
                                    >
                                      <span className="mr-0.5 text-[12px] tabular-nums select-none">
                                        {ev.timestamp}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => handleRewindUserMessage(ev)}
                                        title="回退到此消息并恢复到输入框"
                                        className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                                      >
                                        <Undo2 className="h-3.5 w-3.5" />
                                      </button>
                                      {!isSessionRunning && (
                                        <button
                                          type="button"
                                          onClick={() => handleStartEditMessage(ev)}
                                          title="行内编辑并重发"
                                          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                                        >
                                          <SquarePen className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => copyText(ev.id, ev.content)}
                                        title="复制消息"
                                        className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                                      >
                                        {copiedKey === ev.id ? (
                                          <Check className="h-3.5 w-3.5 text-[#34d399]" />
                                        ) : (
                                          <Copy className="h-3.5 w-3.5" />
                                        )}
                                      </button>
                                    </div>
                                  </div>
                                );
                              })()}

                            {/* 2. Chronological Agent Turn Items (Thinking -> Tools -> Markdown Reply) */}
                            {turn.items.map((ev, idx) => {
                              const isLastTurnItem = idx === turn.items.length - 1;

                              if (ev.kind === "thinking") {
                                const isStreamingThinking = Boolean(
                                  ev.is_streaming_chunk && isTurnRunning && isLastTurnItem
                                );
                                return (
                                  <BeautifulThinkingBlock
                                    key={ev.id}
                                    text={ev.content}
                                    isStreaming={isStreamingThinking}
                                    startedAtMs={
                                      ev.started_at_ms ??
                                      (isLatestTurn ? activeTurnTiming?.startedAtMs : undefined)
                                    }
                                    durationMs={ev.duration_ms}
                                    defaultExpanded={false}
                                  />
                                );
                              }

                              if (ev.kind === "tool_call") {
                                if (idx > 0 && turn.items[idx - 1].kind === "tool_call") {
                                  return null;
                                }
                                let endIdx = idx;
                                while (
                                  endIdx + 1 < turn.items.length &&
                                  turn.items[endIdx + 1].kind === "tool_call"
                                ) {
                                  endIdx++;
                                }
                                if (endIdx > idx) {
                                  const groupItems: PaseoToolGroupItem[] = turn.items
                                    .slice(idx, endIdx + 1)
                                    .map((tev) => ({
                                      id: tev.id,
                                      toolName: tev.tool_name || "Tool",
                                      input:
                                        tev.tool_input ??
                                        (tev.tool_args ? { target: tev.tool_args } : tev.content),
                                      output:
                                        tev.tool_output ??
                                        (tev.tool_input === undefined ? tev.content : undefined),
                                      isError: tev.tool_is_error,
                                      fileArg: tev.tool_args,
                                    }));
                                  return (
                                    <PaseoToolCallGroup
                                      key={ev.id}
                                      items={groupItems}
                                      onOpenDiffForFile={openDiffForFile}
                                    />
                                  );
                                }

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

                              return (
                                <div
                                  key={ev.id}
                                  data-testid="assistant-message"
                                  className="flex flex-col items-start gap-2.5 py-1.5"
                                >
                                  <PaseoMarkdown
                                    content={ev.content}
                                    isStreaming={Boolean(
                                      ev.is_streaming_chunk && isTurnRunning && isLastTurnItem
                                    )}
                                  />

                                  {isLatestTurn &&
                                    isLastTurnItem &&
                                    !isTurnRunning &&
                                    activeDiffFiles.length > 0 && (
                                      <div className="mt-1 flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3.5 py-2.5">
                                        <div className="flex min-w-0 items-center gap-2.5">
                                          <FileCode2 className="h-4 w-4 shrink-0 text-[#34d399]" />
                                          <div className="min-w-0">
                                            <div className="truncate text-[12px] font-medium text-[var(--v-fg-primary)]">
                                              Worktree Changes Ready ({activeDiffFiles.length} files modified)
                                            </div>
                                            <div className="truncate font-mono text-[11px] text-[var(--v-fg-muted)]">
                                              {activeDiffFiles
                                                .map((f) => f.path.split("/").pop())
                                                .join(", ")}
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
                                </div>
                              );
                            })}

                            {/* 3. Vercel AI Elements + Prompt-Kit Per-Turn Status Footer:
                               - Running: Orbital / Sparkle Status + TextShimmer (`Thinking for Xs…` / `Working · <tool>…` / `Working…` / `Writing…`)
                               - Completed: Copy + Retry + "Worked for Xs" (swaps to timestamp on hover) */}
                            <PaseoTurnFooter
                              isRunning={isTurnRunning}
                              phase={turnPhase}
                              statusLabel={turnStatusLabel}
                              waitingLabel={isTurnRunning ? waitingLabel : undefined}
                              startedAtMs={isLatestTurn ? activeTurnTiming?.startedAtMs : undefined}
                              durationMs={
                                turn.userEv?.duration_ms ??
                                (isLatestTurn ? activeTurnTiming?.durationMs : undefined)
                              }
                              completedAtLabel={
                                turn.userEv?.completed_at ??
                                (isLatestTurn ? activeTurnTiming?.completedAtLabel : undefined) ??
                                lastTurnItem?.timestamp
                              }
                              assistantContent={lastTurnAssistant?.content}
                              telemetry={
                                isLatestTurn
                                  ? {
                                      insertions: activeSession.insertions,
                                      deletions: activeSession.deletions,
                                    }
                                  : undefined
                              }
                              onOpenDiff={() => openDiffForFile()}
                              onRetry={
                                turn.userEv && !isSessionRunning
                                  ? () => handleRetryUserMessage(turn.userEv!)
                                  : undefined
                              }
                            />
                          </div>
                        );
                      })}
                    </>
                  );
                })()}
                <div ref={streamEndRef} />
              </div>
            </div>

            {/* Floating "Jump to Latest Output" Pill when user scrolls up */}
            {showJumpToBottom && activeEvents.length > 0 && (
              <div className="pointer-events-none z-20 -mt-9 mb-1 flex w-full justify-center">
                <button
                  type="button"
                  onClick={() => scrollChatToBottom(true)}
                  className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3 py-1 text-[11.5px] font-medium text-[var(--v-fg-primary)] shadow-lg transition-transform hover:scale-[1.02] cursor-pointer"
                >
                  <ArrowDown className="h-3.5 w-3.5 text-[#34d399]" />
                  <span>
                    {activeSession.status === "running" ? "回到最新实时输出" : "回到底部"}
                  </span>
                </button>
              </div>
            )}

            {/* ===============================================================
                4. AUTHENTIC PASEO / CODEX / CLAUDE CODE COMPOSER DOCK
                   - Pure natural language input (zero manual @file clutter)
                   - Direct Model Picker (Claude Fable 5.2, Opus 5.5, GPT-6.1-Sol...)
                   - Effort Picker (Low / Medium / High / Max) + Permission Mode
               =============================================================== */}
            <div className="w-full px-3 sm:px-6 pb-[max(0.85rem,env(safe-area-inset-bottom))] sm:pb-5 pt-1">
              <div className="mx-auto max-w-[680px]">
                {/* Live Bidirectional Permission Approval Card (`PreToolUse` / `velo_request_approval` / ACP) */}
                {activePendingApproval && (
                  <BeautifulApprovalCard
                    key={activePendingApproval.id}
                    toolName={activePendingApproval.toolName || "Bash"}
                    commandPreview={activePendingApproval.command}
                    reason={activePendingApproval.reason}
                    onApprove={() => handleResolveApproval("approve")}
                    onAlwaysAllow={() => handleResolveApproval("always")}
                    onDeny={() => handleResolveApproval("deny")}
                  />
                )}

                {/* Live Bidirectional `AskUserQuestion` Card (`velo_ask_user`) */}
                {activePendingQuestion && (
                  <BeautifulQuestionCard
                    key={activePendingQuestion.id}
                    question={activePendingQuestion.question}
                    options={activePendingQuestion.options}
                    allowMultiple={activePendingQuestion.allowMultiple}
                    onSubmit={handleAnswerQuestion}
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

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setComposerDragOver(true);
                  }}
                  onDragLeave={() => setComposerDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setComposerDragOver(false);
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                      handleUploadImageFiles(e.dataTransfer.files);
                    }
                  }}
                  className={`rounded-[18px] border bg-[var(--v-bg-surface)] px-4 pb-2.5 pt-3 shadow-lg transition-colors focus-within:border-[var(--v-fg-muted)] ${
                    composerDragOver
                      ? "border-[#34d399] ring-1 ring-[#34d399]/40"
                      : "border-[var(--v-border-strong)]"
                  }`}
                >
                  {/* Hidden file input for ImagePlus picker */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleUploadImageFiles(e.target.files);
                        e.target.value = "";
                      }
                    }}
                  />

                  {/* Pending Multimodal Image Attachments Strip */}
                  {(pendingAttachments.length > 0 || uploadingAttachment) && (
                    <div className="mb-2.5 flex flex-wrap items-center gap-2">
                      {pendingAttachments.map((att, attIdx) => (
                        <div
                          key={`${att.filename}-${attIdx}`}
                          className="group/att relative overflow-hidden rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)]"
                        >
                          <img
                            src={att.url}
                            alt={att.filename}
                            className="h-14 w-14 object-cover"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setPendingAttachments((prev) =>
                                prev.filter((_, i) => i !== attIdx)
                              )
                            }
                            title="Remove attachment"
                            className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/75 text-white opacity-0 transition-opacity group-hover/att:opacity-100 cursor-pointer"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      ))}
                      {uploadingAttachment && (
                        <div className="flex h-14 items-center rounded-xl border border-dashed border-[var(--v-border-strong)] px-3 font-mono text-[11px] text-[var(--v-fg-muted)]">
                          Uploading image…
                        </div>
                      )}
                    </div>
                  )}

                  <textarea
                    ref={composerTextareaRef}
                    rows={2}
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    onPaste={(e) => {
                      const items = e.clipboardData?.items;
                      if (!items) return;
                      const imgFiles: File[] = [];
                      for (let i = 0; i < items.length; i++) {
                        if (items[i].type.startsWith("image/")) {
                          const file = items[i].getAsFile();
                          if (file) imgFiles.push(file);
                        }
                      }
                      if (imgFiles.length > 0) {
                        e.preventDefault();
                        handleUploadImageFiles(imgFiles);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendPrompt();
                      }
                    }}
                    placeholder={`Ask ${
                      modelCatalog.find((m) => m.id === activeSession.model)?.label ||
                      activeSession.model_short
                    } anything... (/ for commands, ⌘V paste screenshot, or click mic to dictate)`}
                    className="w-full resize-none bg-transparent text-[13.5px] max-md:text-[16px] leading-relaxed text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:outline-none"
                  />

                  {/* Composer Bottom Toolbar: Concrete Model Picker (Claude / Codex / ACP) + Effort + Permission Mode + Voice */}
                  <div className="relative mt-1.5 flex flex-wrap items-center justify-between gap-2">
                    {/* 1. Concrete Model & ACP Provider Picker Popover */}
                    {modelPickerOpen && (
                      <div className="absolute bottom-9 left-0 z-30 w-[348px] max-w-[calc(100vw-32px)] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1.5 shadow-2xl">
                        <div className="max-h-[340px] overflow-y-auto pr-0.5">
                          {Array.from(new Set(modelCatalog.map((m) => m.family))).map((family) => {
                            const familyModels = modelCatalog.filter((m) => m.family === family);
                            if (familyModels.length === 0) return null;
                            const runtimeId = familyModels[0].runtimeId;
                            const rt = runtimes.find((r) => r.id === runtimeId);
                            const isAcpFamily = String(family).startsWith("ACP");
                            const isConnected = rt
                              ? rt.available
                              : familyModels[0].installed !== false;
                            return (
                              <div key={family} className="mb-1.5 last:mb-0">
                                <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-medium text-[var(--v-fg-muted)]">
                                  <span>
                                    {family === "Anthropic"
                                      ? "Anthropic (Claude Code)"
                                      : family === "OpenAI"
                                      ? "OpenAI / Codex (~/.codex)"
                                      : family === "Google Antigravity"
                                      ? "Google Antigravity CLI (agy)"
                                      : family}
                                  </span>
                                  <span className="font-mono text-[10px]">
                                    {isConnected
                                      ? "Connected"
                                      : isAcpFamily
                                      ? "ACP JSON-RPC"
                                      : "Not configured"}
                                  </span>
                                </div>
                                {familyModels.map((m) => {
                                  const isCurrent = activeSession.model === m.id;
                                  const canSelect = isConnected || isAcpFamily;
                                  return (
                                    <button
                                      key={m.id}
                                      disabled={!canSelect}
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
                                        fetch(`${daemonUrl}/api/sessions/${activeSession.id}`, {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({
                                            model: m.id,
                                            provider: m.agentKind,
                                          }),
                                        }).catch(() => {});
                                        setModelPickerOpen(false);
                                      }}
                                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                                        isCurrent
                                          ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                                          : canSelect
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
                                          {!isConnected && isAcpFamily && (
                                            <span className="rounded bg-[var(--v-bg-hover)] px-1.5 py-0.2 font-mono text-[9.5px] text-[var(--v-fg-faint)]">
                                              install CLI
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

                        {/* Custom ACP Command Quick-Bind (`acp:<cmd>`) */}
                        <div className="mt-1.5 border-t border-[var(--v-border-subtle)] px-1.5 pt-2">
                          <div className="mb-1 text-[10px] font-medium text-[var(--v-fg-muted)]">
                            Custom ACP Stdio Agent (JSON-RPC 2.0)
                          </div>
                          <div className="flex items-center gap-1">
                            <input
                              value={customAcpCmd}
                              onChange={(e) => setCustomAcpCmd(e.target.value)}
                              placeholder="e.g. opencode acp or goose acp"
                              className="flex-1 rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2 py-1 font-mono text-[11px] text-[var(--v-fg-primary)] focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const cmd = customAcpCmd.trim();
                                if (!cmd) return;
                                const acpSpec = cmd.startsWith("acp:") ? cmd : `acp:${cmd}`;
                                const short = cmd.split(/\s+/)[0] || "ACP";
                                setSessions((prev) =>
                                  prev.map((s) =>
                                    s.id === activeSession.id
                                      ? {
                                          ...s,
                                          agent_kind: acpSpec,
                                          model: acpSpec,
                                          model_short: `ACP · ${short}`,
                                        }
                                      : s
                                  )
                                );
                                setModelPickerOpen(false);
                              }}
                              className="rounded-md bg-[var(--v-bg-active)] px-2 py-1 text-[11px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)]"
                            >
                              Bind
                            </button>
                          </div>
                        </div>

                        <div className="mt-1 border-t border-[var(--v-border-subtle)] pt-1">
                          <button
                            onClick={() => {
                              setModelPickerOpen(false);
                              setHookEditCmd(repoHooks[activeRepo.path] || "");
                              setActiveModal("settings");
                            }}
                            className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                          >
                            <span>Manage CLI, ACP &amp; Worktree Hooks...</span>
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
                                fetch(`${daemonUrl}/api/sessions/${activeSession.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ effort: eff.id }),
                                }).catch(() => {});
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

                    <div className="flex flex-wrap items-center gap-1.5">
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

                      {/* Pill 3: Worktree Permission Mode (`auto_edit` / `ask_before_edit` / `bypass`) */}
                      <button
                        onClick={handleToggleApprovalMode}
                        title="Click to cycle: Auto-edit → Ask permissions (live PreToolUse gate) → Bypass"
                        className={`rounded-full px-2.5 py-1 text-[11.5px] transition-colors ${
                          activeSession.approval_mode === "ask_before_edit"
                            ? "bg-[#fbbf24]/15 font-medium text-[#fbbf24] hover:bg-[#fbbf24]/25"
                            : activeSession.approval_mode === "bypass"
                            ? "bg-[#34d399]/15 text-[#34d399] hover:bg-[#34d399]/25"
                            : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-body)]"
                        }`}
                      >
                        {activeSession.approval_mode === "ask_before_edit"
                          ? "Ask permissions"
                          : activeSession.approval_mode === "bypass"
                          ? "Bypass"
                          : "Auto-edit"}
                      </button>

                      {/* Pill 4: Attach Screenshot / Image (Cmd+V or Drag & Drop) */}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        title="Attach screenshot or image (or paste with ⌘V)"
                        className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                      </button>

                      {/* Pill 5: Hands-Free Voice Dictation Input (WebKit SpeechRecognition + Whisper STT Fallback) */}
                      <button
                        type="button"
                        onClick={handleToggleVoiceDictation}
                        title={
                          isDictating
                            ? "Stop voice dictation"
                            : "Hands-free voice dictation (Web Speech / Whisper STT)"
                        }
                        className={`flex h-6 items-center gap-1 rounded-full px-1.5 transition-colors cursor-pointer ${
                          isDictating
                            ? "bg-[#f87171]/20 text-[#f87171] animate-pulse"
                            : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)]"
                        }`}
                      >
                        {isDictating ? (
                          <>
                            <Square className="h-3 w-3 fill-current" />
                            <span className="font-mono text-[10px]">Listening…</span>
                          </>
                        ) : (
                          <Mic className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>

                    {/* Right Controls: BeautifulContextMeter (Real Token & USD Telemetry) + Submit / Stop Disc */}
                    <div className="flex items-center gap-2">
                      <BeautifulContextMeter
                        usedTokens={activeSession.tokens_used || 0}
                        maxTokens={activeSession.tokens_limit || 200000}
                        costUsd={activeSession.cost_usd || 0}
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
                          disabled={!prompt.trim() && pendingAttachments.length === 0}
                          className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${
                            prompt.trim() || pendingAttachments.length > 0
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
              5. ON-DEMAND SLIDE-OVER DRAWER (Changes / PR / Browser / Terminal)
                 - Strictly NO File Explorer or Inline Code Editor per user design
             ================================================================= */}
          <aside
            className={`flex flex-col overflow-hidden bg-[var(--v-bg-sidebar)] border-l border-[var(--v-border-subtle)] transition-all duration-200 ease-out ${
              drawerOpen
                ? "w-full md:w-[500px] opacity-100 max-md:fixed max-md:inset-0 max-md:z-40"
                : "w-0 border-l-0 opacity-0"
            }`}
          >
            <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-[var(--v-border-subtle)] px-3">
              <div className="flex items-center gap-0.5 overflow-x-auto">
                <button
                  onClick={() => setDrawerTab("diff")}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    drawerTab === "diff"
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-secondary)]"
                  }`}
                >
                  Changes ({activeDiffFiles.length})
                </button>
                <button
                  onClick={() => setDrawerTab("pr")}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    drawerTab === "pr"
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-secondary)]"
                  }`}
                >
                  PR
                </button>
                <button
                  onClick={() => setDrawerTab("browser")}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    drawerTab === "browser"
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-secondary)]"
                  }`}
                >
                  Preview
                </button>
                <button
                  onClick={() => setDrawerTab("terminal")}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    drawerTab === "terminal"
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-secondary)]"
                  }`}
                >
                  Terminal
                </button>
              </div>

              {/* One-Click Git Worktree Actions + Close */}
              <div className="flex shrink-0 items-center gap-1">
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
                      title="Check branch readiness & merge"
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
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleDiscardFile(currentDiffFile.path, false)}
                        title="Discard changes in this file (git checkout --)"
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] hover:bg-[var(--v-bg-hover)] hover:text-[#f87171] cursor-pointer"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>Discard</span>
                      </button>
                      <button
                        onClick={() =>
                          copyText(
                            currentDiffFile.path,
                            currentDiffFile.hunks.map((h) => h.content).join("\n")
                          )
                        }
                        title="Copy diff"
                        className="flex items-center gap-1 hover:text-[var(--v-fg-primary)] cursor-pointer"
                      >
                        {copiedKey === currentDiffFile.path ? (
                          <Check className="h-3 w-3 text-[#34d399]" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Dual-Line-Number Unified Diff Viewer + Multi-Line Batch Code Review */}
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
                      const lineDrafts = draftDiffComments.filter(
                        (c) => c.filePath === currentDiffFile.path && c.lineNum === lineNum
                      );
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
                                : "Click + to add inline review comment (single or batch)"
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
                                <span className="hidden font-bold text-[#38bdf8] group-hover:inline">
                                  +
                                </span>
                              )}
                            </span>
                            <span className="whitespace-pre">{line.content}</span>
                          </div>

                          {/* Pinned Draft Batch Comments on this line */}
                          {lineDrafts.map((dc) => (
                            <div
                              key={dc.id}
                              className="mx-3 my-1 flex items-center justify-between gap-2 rounded-lg border border-[#38bdf8]/40 bg-[var(--v-bg-surface)] px-2.5 py-1.5 font-sans text-[11.5px]"
                            >
                              <div className="min-w-0">
                                <span className="mr-1.5 rounded bg-[#38bdf8]/15 px-1.5 py-0.5 font-mono text-[10px] text-[#38bdf8]">
                                  L{dc.lineNum} queued
                                </span>
                                <span className="text-[var(--v-fg-primary)]">{dc.comment}</span>
                              </div>
                              <button
                                onClick={() =>
                                  setDraftDiffComments((prev) =>
                                    prev.filter((item) => item.id !== dc.id)
                                  )
                                }
                                title="Remove queued comment"
                                className="shrink-0 text-[var(--v-fg-muted)] hover:text-[#f87171]"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          ))}

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
                              <div className="flex flex-col gap-1.5">
                                <input
                                  autoFocus
                                  value={diffCommentText}
                                  onChange={(e) => setDiffCommentText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && diffCommentText.trim()) {
                                      setDraftDiffComments((prev) => [
                                        ...prev,
                                        {
                                          id: `dc-${Date.now()}`,
                                          filePath: currentDiffFile.path,
                                          lineNum,
                                          codeContent: line.content.trim(),
                                          comment: diffCommentText.trim(),
                                        },
                                      ]);
                                      setDiffCommentIdx(null);
                                      setDiffCommentText("");
                                    }
                                  }}
                                  placeholder="Write review feedback (Enter to queue in batch)..."
                                  className="w-full rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1.5 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                                />
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    onClick={() => {
                                      if (!diffCommentText.trim()) return;
                                      setDraftDiffComments((prev) => [
                                        ...prev,
                                        {
                                          id: `dc-${Date.now()}`,
                                          filePath: currentDiffFile.path,
                                          lineNum,
                                          codeContent: line.content.trim(),
                                          comment: diffCommentText.trim(),
                                        },
                                      ]);
                                      setDiffCommentIdx(null);
                                      setDiffCommentText("");
                                    }}
                                    className="flex items-center gap-1 rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-hover)] px-2.5 py-1 text-[11px] font-medium text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)]"
                                  >
                                    <MessageSquarePlus className="h-3 w-3" />
                                    <span>Add to Batch</span>
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (!diffCommentText.trim()) return;
                                      const reviewPrompt = `In \`${currentDiffFile.path}\` at line ${lineNum} (\`${line.content.trim()}\`), please make this change: ${diffCommentText.trim()}`;
                                      setDiffCommentIdx(null);
                                      setDiffCommentText("");
                                      handleSendPrompt(reviewPrompt);
                                    }}
                                    className="rounded-md bg-[var(--v-btn-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--v-btn-fg)]"
                                  >
                                    Ask Now
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Sticky Batch Review Dispatch Bar */}
                  {draftDiffComments.length > 0 && (
                    <div className="flex items-center justify-between gap-2 border-t border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3.5 py-2.5">
                      <span className="text-[11.5px] font-medium text-[var(--v-fg-primary)]">
                        {draftDiffComments.length} review comment
                        {draftDiffComments.length > 1 ? "s" : ""} queued
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setDraftDiffComments([])}
                          className="rounded-md px-2 py-1 text-[11px] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                        >
                          Clear
                        </button>
                        <button
                          onClick={handleDispatchBatchDiffComments}
                          className="rounded-md bg-[var(--v-btn-bg)] px-3 py-1 text-[11.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90"
                        >
                          Send Batch to Agent →
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            ) : drawerTab === "pr" ? (
              <PullRequestDrawer
                daemonUrl={daemonUrl}
                sessionId={activeSession.id}
                branchName={activeSession.branch_name}
                sessionTitle={activeSession.title}
                onDispatchAgentPrompt={(p) => handleSendPrompt(p)}
              />
            ) : drawerTab === "browser" ? (
              <BrowserPreviewDrawer
                daemonUrl={daemonUrl}
                sessionId={activeSession.id}
                initialUrl={activeSession.preview_url}
                onDispatchAgentPrompt={(p) => handleSendPrompt(p)}
              />
            ) : (
              <XtermTerminalDrawer
                daemonUrl={daemonUrl}
                sessionId={activeSession.id}
                worktreePath={activeSession.worktree_path}
                resolvedTheme={resolvedTheme}
                latestChunk={latestTerminalChunk}
                onDetectedLocalUrl={(url) => {
                  setSessions((prev) =>
                    prev.map((s) =>
                      s.id === activeSession.id && !s.preview_url ? { ...s, preview_url: url } : s
                    )
                  );
                }}
              />
            )}
          </aside>
        </div>
      </div>

      {/* =====================================================================
          6. MODALS (Velo Hub Automations, New Thread, New Repo, Command, Pairing QR, Settings)
         ===================================================================== */}
      {activeModal === "automations" && (
        <AutomationsModal
          daemonUrl={daemonUrl}
          defaultRepoPath={activeRepo.path}
          onClose={() => setActiveModal(null)}
          onJumpToSession={(sid) => {
            refreshSessions();
            setActiveId(sid);
          }}
        />
      )}

      {activeModal && activeModal !== "automations" && (
        <div
          onClick={() => setActiveModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[496px] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-5 shadow-2xl"
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
                <div className="max-h-[78vh] space-y-3 overflow-y-auto pr-1 text-[12.5px]">
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                      Project
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {repos.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => {
                            setTargetRepoIdForNewWt(r.id);
                            setNewSetupCommand(repoHooks[r.path] || "");
                          }}
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
                        Model / ACP Provider
                      </label>
                      <div className="max-h-[164px] overflow-y-auto grid grid-cols-2 gap-1.5 pr-1">
                        {modelCatalog.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => setNewModelId(m.id)}
                            className={`flex items-center justify-between gap-1 rounded-lg border px-2.5 py-1.5 text-left text-[12px] ${
                              newModelId === m.id
                                ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                                : "border-[var(--v-border-strong)] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)]"
                            }`}
                          >
                            <span className="truncate">{m.label}</span>
                            <span className="shrink-0 font-mono text-[9.5px] opacity-60">
                              {m.family.replace("ACP · ", "")}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                      Permission Gate
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          { id: "auto_edit", label: "Auto-edit" },
                          { id: "ask_before_edit", label: "Ask permissions" },
                          { id: "bypass", label: "Bypass" },
                        ] as { id: ApprovalMode; label: string }[]
                      ).map((pm) => (
                        <button
                          key={pm.id}
                          type="button"
                          onClick={() => setNewApproval(pm.id)}
                          className={`rounded-lg border px-2 py-1.5 text-[11.5px] ${
                            newApproval === pm.id
                              ? "border-[var(--v-fg-primary)] bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                              : "border-[var(--v-border-strong)] text-[var(--v-fg-muted)]"
                          }`}
                        >
                          {pm.label}
                        </button>
                      ))}
                    </div>
                  </div>
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
                      placeholder="Describe what to build or fix..."
                      className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 text-[12.5px] text-[var(--v-fg-primary)] focus:border-[var(--v-fg-muted)] focus:outline-none"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
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
                    <div>
                      <label
                        title="Runs automatically after git worktree add + smart node_modules/.venv symlink"
                        className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]"
                      >
                        Setup Hook (optional)
                      </label>
                      <input
                        value={newSetupCommand}
                        onChange={(e) => setNewSetupCommand(e.target.value)}
                        placeholder=".velo/setup.sh or pnpm i"
                        className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[12px] text-[var(--v-fg-primary)] focus:border-[var(--v-fg-muted)] focus:outline-none"
                      />
                    </div>
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
                      disabled={dispatchMode !== "single" && !newTaskDesc.trim()}
                      className="rounded-lg bg-[var(--v-btn-bg)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90 disabled:opacity-40"
                    >
                      {newTaskDesc.trim()
                        ? "Start thread"
                        : dispatchMode === "single"
                        ? "Create idle worktree"
                        : "Enter prompt to start"}
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
                    Settings · 模型服务、Worktree Hooks 与外观
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="max-h-[75vh] space-y-5 overflow-y-auto pr-1 text-[12.5px]">
                  {/* Section 1: CLI & ACP Model Providers */}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <label className="text-[11.5px] font-medium text-[var(--v-fg-secondary)]">
                        CLI &amp; ACP Providers (Claude, Codex, Antigravity `agy`, OpenCode, Copilot, Qwen)
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

                  {/* Section 2: Worktree Setup Hooks & Smart Dependency Symlinking */}
                  <div className="border-t border-[var(--v-border-subtle)] pt-4">
                    <div className="mb-1 flex items-center justify-between">
                      <label className="text-[11.5px] font-medium text-[var(--v-fg-secondary)]">
                        Worktree Initialization Hook ({activeRepo.name})
                      </label>
                      <span className="font-mono text-[10.5px] text-[#34d399]">
                        node_modules / .venv auto-symlinked
                      </span>
                    </div>
                    <p className="mb-2 text-[11px] text-[var(--v-fg-muted)]">
                      新建隔离 Worktree 时自动软链主仓库依赖，并优先执行下方命令或仓库内的{" "}
                      <code className="font-mono">.velo/setup.sh</code> /{" "}
                      <code className="font-mono">.worktreesetup</code>。
                    </p>
                    <div className="flex items-center gap-1.5">
                      <input
                        value={hookEditCmd}
                        onChange={(e) => setHookEditCmd(e.target.value)}
                        placeholder="e.g. cp ../../.env.local .env.local && pnpm build:proto"
                        className="flex-1 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--v-fg-primary)] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void handleSaveRepoHook(activeRepo.path, hookEditCmd.trim());
                          copyText("saved-hook", hookEditCmd.trim());
                        }}
                        className="rounded-lg bg-[var(--v-btn-bg)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90"
                      >
                        {copiedKey === "saved-hook" ? "Saved ✓" : "Save Hook"}
                      </button>
                    </div>
                  </div>

                  {/* Section 3: Appearance & Theme */}
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
                    {activeModal === "qr" ? "手机端扫码连接 (Velo Mobile)" : "Skills & Slash Commands"}
                  </h3>
                  <button
                    onClick={() => setActiveModal(null)}
                    className="text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {activeModal === "qr" ? (
                  <div className="space-y-3 text-[12px] text-[var(--v-fg-secondary)]">
                    {/* Mode Switcher: Cross-Network Zero-Trust Blind E2EE Relay vs Same Wi-Fi LAN */}
                    <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--v-bg-sidebar)] p-1">
                      <button
                        type="button"
                        onClick={() => setPairModeTab("e2ee")}
                        className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                          pairModeTab === "e2ee"
                            ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                            : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                        }`}
                      >
                        跨网零信任 E2EE 盲中继（5G 直通）
                      </button>
                      <button
                        type="button"
                        onClick={() => setPairModeTab("lan")}
                        className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                          pairModeTab === "lan"
                            ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                            : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                        }`}
                      >
                        同一 Wi-Fi / Tailscale 直连
                      </button>
                    </div>

                    {pairModeTab === "lan" ? (
                      <>
                        <div className="flex items-center justify-between rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[11px]">
                          <span className="flex items-center gap-1.5 text-[#34d399]">
                            <Server className="h-3.5 w-3.5" />
                            <span>Mac 局域网直连在线</span>
                          </span>
                          <span className="text-[var(--v-fg-muted)]">
                            {pairTicket?.daemon_addr || "127.0.0.1:6767"}
                          </span>
                        </div>

                        {(pairTicket?.lan_qr_svg || pairTicket?.qr_svg) && (
                          <div
                            className="mx-auto flex h-48 w-48 items-center justify-center rounded-xl bg-white p-2.5 shadow-sm"
                            dangerouslySetInnerHTML={{
                              __html: pairTicket.lan_qr_svg || pairTicket.qr_svg,
                            }}
                          />
                        )}

                        <div className="flex items-center gap-1.5 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] p-2.5 font-mono text-[11.5px] text-[var(--v-fg-primary)]">
                          <span className="flex-1 break-all">
                            {pairTicket?.lan_uri || "http://127.0.0.1:6767/?mobile=1"}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              copyText("lan-uri", pairTicket?.lan_uri || "")
                            }
                            className="shrink-0 rounded-md bg-[var(--v-bg-active)] px-2.5 py-1 font-sans text-[11px] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                          >
                            {copiedKey === "lan-uri" ? "已复制" : "复制链接"}
                          </button>
                        </div>

                        {pairTicket?.tailscale_uri && (
                          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[11px]">
                            <span className="truncate text-[var(--v-fg-secondary)]">
                              Tailscale 异地直连: {pairTicket.tailscale_uri}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                copyText("ts-uri", pairTicket.tailscale_uri || "")
                              }
                              className="shrink-0 rounded bg-[var(--v-bg-active)] px-2 py-0.5 font-sans text-[10.5px] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                            >
                              {copiedKey === "ts-uri" ? "已复制" : "复制"}
                            </button>
                          </div>
                        )}

                        <p className="rounded-lg bg-[var(--v-bg-sidebar)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--v-fg-muted)]">
                          手机与 Mac 连接同一 Wi-Fi 后，直接用<strong>系统相机</strong>或 <strong>Velo iOS App</strong> 扫码即可秒连（实时同步所有会话、流式输出、审批确认与代码 Diff）。
                        </p>
                      </>
                    ) : (
                      <>
                        {/* Live Zero-Trust Blind Relay Telemetry Banner */}
                        <div className="space-y-1.5 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 text-[#34d399]">
                              <Lock className="h-3.5 w-3.5" />
                              <span>
                                {pairTicket?.relay_url?.startsWith("wss://")
                                  ? "公网 TLS 1.3 零信任盲中继已就绪"
                                  : pairTicket?.e2ee_status?.tunnel?.status === "starting"
                                  ? "正在建立公网 TLS 1.3 盲中继隧道…"
                                  : "X25519 + ChaCha20-Poly1305 盲中继"}
                              </span>
                            </span>
                            <span className="text-[var(--v-fg-muted)]">
                              Room: {pairTicket?.room_id?.slice(0, 8) || "init…"}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-[var(--v-fg-muted)]">
                            <span className="truncate">
                              Endpoint: {pairTicket?.relay_url || "ws://127.0.0.1:6768"}
                            </span>
                            <span className="flex items-center gap-2 shrink-0">
                              {pairTicket?.e2ee_status?.ratchet_active && (
                                <span className="rounded bg-[#34d399]/15 px-1.5 py-0.5 text-[#34d399]">
                                  X25519·FS 前向安全
                                </span>
                              )}
                              <span>
                                已验证设备: {pairTicket?.e2ee_status?.peers_seen ?? 0}
                              </span>
                            </span>
                          </div>
                        </div>

                        {/* QR Type Selector: Native iOS App DeepLink vs Mobile Browser */}
                        <div className="flex items-center justify-center gap-1.5 text-[11px]">
                          <button
                            type="button"
                            onClick={() => setE2eeQrTarget("app")}
                            className={`rounded-md px-2.5 py-1 transition-colors cursor-pointer ${
                              e2eeQrTarget === "app"
                                ? "bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                                : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                            }`}
                          >
                            iOS 原生 App 配对码（支持 5G 蜂窝直扫）
                          </button>
                          <button
                            type="button"
                            onClick={() => setE2eeQrTarget("web")}
                            className={`rounded-md px-2.5 py-1 transition-colors cursor-pointer ${
                              e2eeQrTarget === "web"
                                ? "bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                                : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                            }`}
                          >
                            手机浏览器配对码
                          </button>
                        </div>

                        {(e2eeQrTarget === "web"
                          ? pairTicket?.web_qr_svg || pairTicket?.qr_svg
                          : pairTicket?.qr_svg) && (
                          <div
                            className="mx-auto flex h-48 w-48 items-center justify-center rounded-xl bg-white p-2.5 shadow-sm"
                            dangerouslySetInnerHTML={{
                              __html:
                                (e2eeQrTarget === "web"
                                  ? pairTicket?.web_qr_svg
                                  : pairTicket?.qr_svg) ||
                                pairTicket?.qr_svg ||
                                "",
                            }}
                          />
                        )}

                        <div className="flex items-center gap-1.5">
                          <input
                            value={customRelayInput}
                            onChange={(e) => setCustomRelayInput(e.target.value)}
                            placeholder="自定义固定 wss:// 盲中继（留空默认使用内置 Cloudflare 公网盲中继）"
                            className="flex-1 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              fetchPairTicket(customRelayInput.trim() || "auto")
                            }
                            className="shrink-0 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-active)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                          >
                            {customRelayInput.trim() ? "切换中继" : "自动公网隧道"}
                          </button>
                          <button
                            type="button"
                            disabled={rotatingRelayKey}
                            onClick={handleRotateRelayKey}
                            title="生成全新 256-bit 根密钥与房间号，立即吊销所有已配对手机"
                            className="shrink-0 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] px-2.5 py-1.5 text-[11px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                          >
                            {rotatingRelayKey ? "轮换中…" : "轮换密钥"}
                          </button>
                        </div>

                        <div className="flex items-center gap-1.5 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] p-2.5 font-mono text-[11px] text-[var(--v-fg-primary)]">
                          <span className="flex-1 break-all">
                            {e2eeQrTarget === "app"
                              ? pairTicket?.pairing_uri || "velo://pair"
                              : pairTicket?.uri ||
                                "http://127.0.0.1:6767/?mobile=1&relay=ws://127.0.0.1:6768"}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              copyText(
                                "e2ee-uri",
                                (e2eeQrTarget === "app"
                                  ? pairTicket?.pairing_uri
                                  : pairTicket?.uri) || ""
                              )
                            }
                            className="shrink-0 rounded-md bg-[var(--v-bg-active)] px-2 py-1 font-sans text-[10.5px] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                          >
                            {copiedKey === "e2ee-uri" ? "已复制" : "复制"}
                          </button>
                        </div>

                        <p className="rounded-lg bg-[var(--v-bg-sidebar)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--v-fg-muted)]">
                          <strong>零信任架构：</strong>中继层仅做无状态密文转发（0 数据库 · 强制校验 Poly1305 标签 · 断线即焚），256-bit 根密钥仅通过上方离线二维码传递，每次连接自动完成 <strong>X25519 临时密钥协商</strong>实现前向保密。手机切 5G 用系统相机或 Velo App 扫一次即可异地操控！
                        </p>
                      </>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <span className="text-[11px] text-[var(--v-fg-muted)]">
                        {pairModeTab === "lan"
                          ? "零配置 · 局域网低延迟 WebSocket 直连"
                          : `零信任端到端盲中继 (${pairTicket?.relay_url || "ws://127.0.0.1:6768"})`}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => {
                            setMobileMode(true);
                            setSidebarOpen(false);
                            setActiveModal(null);
                          }}
                          className="rounded-lg bg-[var(--v-btn-bg)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--v-btn-fg)] cursor-pointer"
                        >
                          在本机预览手机界面
                        </button>
                      </div>
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
