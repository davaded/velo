import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentEvent,
  AgentKind,
  ApprovalMode,
  DEMO_REPOS,
  DiffFileItem,
  EffortLevel,
  MODEL_CATALOG,
  ModelOption,
  SLASH_SKILLS,
  VeloRepo,
  VeloSession,
  canonicalRepoPath,
  normalizeToVeloSession,
  repoIdFromPath,
} from "./mockData";
import { parseUnifiedDiff } from "./utils/diffParser";
import {
  AgentStatusPhase,
  BeautifulApprovalCard,
  BeautifulContextMeter,
  BeautifulQuestionCard,
  BeautifulThinkingBlock,
  BeautifulToolCallCard,
  PaseoExecutionTraceGroup,
  PaseoMarkdown,
  PaseoTraceStepItem,
  PaseoTurnFooter,
  PaseoTurnTelemetry,
  extractThinkingHeadline,
  isFocusFootprintProvider,
  resolvePaseoToolPresentation,
} from "./components/ui/BeautifulAgentPrimitives";
import {
  EngineBrandGlyph,
  EngineSessionBadge,
  EngineStatusIndicator,
} from "./components/ui/EngineBrandIcon";
import { XtermTerminalDrawer, TerminalChunkPacket } from "./components/XtermTerminalDrawer";
import { PullRequestDrawer } from "./components/PullRequestDrawer";
import { BrowserPreviewDrawer } from "./components/BrowserPreviewDrawer";
import { AutomationsModal, ParsedScheduleDto } from "./components/AutomationsModal";
import { AnalyticsAndPushModal } from "./components/AnalyticsAndPushModal";
import { CliSessionsModal, ExternalCliSessionItem } from "./components/CliSessionsModal";
import { QueuedPromptsBar } from "./components/QueuedPromptsBar";
import {
  ForkBranchModal,
  ForkConfirmPayload,
  ForkLaunchTarget,
} from "./components/ForkBranchModal";
import { ChatOutlineRail, OutlineTurnSummary } from "./components/ChatOutlineRail";
import { IsolatedComposerTextarea } from "./components/IsolatedComposerTextarea";
import { SidebarQuotaBar } from "./components/SidebarQuotaBar";
import { RemoteHostDto, RemoteHostsModal } from "./components/RemoteHostsModal";
import {
  ExtensionsAndCheckpointsModal,
  SkillEntryDto,
  composerTextForSkill,
  matchSkillInvocation,
} from "./components/ExtensionsAndCheckpointsModal";
import {
  ENGINE_TABS,
  InlineModelSelectorGrid,
  ModelPickerPopover,
  getEngineTabForAgentKind,
  getEngineTabForModel,
  isModelAvailable,
  pickFeaturedModelsForEngine,
} from "./components/ModelPickerPopover";
import { e2eeOpenFrame, e2eeSealJson } from "./utils/e2eeRelayClient";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Blocks,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleGauge,
  Copy,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  GitPullRequest,
  Globe,
  History,
  ImagePlus,
  Layers,
  Play,
  Lock,
  MessageSquarePlus,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings,
  Smartphone,
  SquarePen,
  Sun,
  Terminal,
  Trash2,
  Undo2,
  WifiOff,
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
  isImage?: boolean;
  displayName?: string;
  size?: number;
  relPath?: string;
}

interface WorkspaceFileMentionItem {
  path: string;
  abs_path: string;
  name: string;
  dir: string;
  modified: boolean;
  size: number;
}

function formatCompactFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseUserMessageWithFiles(raw: string): { files: string[]; body: string } {
  if (!raw.startsWith("[Referenced Files]\n")) {
    return { files: [], body: raw };
  }
  const lines = raw.split("\n");
  const files: string[] = [];
  let idx = 1;
  while (idx < lines.length && lines[idx].startsWith("- ")) {
    const p = lines[idx].slice(2).trim();
    if (p) files.push(p);
    idx++;
  }
  while (idx < lines.length && lines[idx].trim() === "") {
    idx++;
  }
  return { files, body: lines.slice(idx).join("\n") };
}

interface LastModelPref {
  agent_kind: AgentKind;
  model: string;
  model_short: string;
  effort: EffortLevel;
}

const LAST_MODEL_PREF_KEY = "velo.lastModelPref.v1";

function readLastModelPref(): LastModelPref | null {
  try {
    const raw = window.localStorage.getItem(LAST_MODEL_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastModelPref>;
    if (parsed && parsed.agent_kind && parsed.model && parsed.model_short) {
      return {
        agent_kind: parsed.agent_kind,
        model: parsed.model,
        model_short: parsed.model_short,
        effort: parsed.effort || "medium",
      };
    }
  } catch {
    // ignore
  }
  return null;
}

function saveLastModelPref(pref: Partial<LastModelPref>): void {
  try {
    const existing = readLastModelPref();
    const merged: LastModelPref = {
      agent_kind: pref.agent_kind ?? existing?.agent_kind ?? "claude",
      model: pref.model ?? existing?.model ?? "claude-fable-5-2",
      model_short: pref.model_short ?? existing?.model_short ?? "Fable 5.2",
      effort: pref.effort ?? existing?.effort ?? "medium",
    };
    window.localStorage.setItem(LAST_MODEL_PREF_KEY, JSON.stringify(merged));
  } catch {
    // ignore
  }
}

function scheduleIdleWork(fn: () => void, timeoutMs = 1500): () => void {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(fn, { timeout: timeoutMs });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(fn, 60);
  return () => window.clearTimeout(id);
}

const DEFAULT_PENDING_BY_SESSION: Record<string, PendingApprovalItem> = {};

/** Same projected reply, not a second copy. Matches Paseo's catch-up rule. */
function foldAssistantProjection(
  previous: string,
  incoming: string
): "incoming" | "previous" | "distinct" {
  const prev = previous.trim();
  const next = incoming.trim();
  if (!prev || !next || prev.startsWith("⚠️") || next.startsWith("⚠️")) return "distinct";
  if (prev === next) return "previous";
  if (next.startsWith(prev) && prev.length >= 24) return "incoming";
  if (prev.startsWith(next) && next.length >= 24) return "previous";
  if (prev.length >= 40 && next.includes(prev)) return "incoming";
  if (next.length >= 40 && prev.includes(next)) return "previous";
  return "distinct";
}

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
      const clientMsgId =
        typeof ev.client_msg_id === "string" && ev.client_msg_id.trim()
          ? ev.client_msg_id.trim()
          : undefined;
      if (text || imgs.length > 0) {
        reconstructed.push({
          id: clientMsgId ? `u-hist-${clientMsgId}` : `u-hist-${i}`,
          session_id: sid,
          timestamp: ts,
          kind: "user",
          content: text,
          images: imgs.length > 0 ? imgs : undefined,
          client_msg_id: clientMsgId,
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
      const rawStep = lastStepMs > 0 && tsMs >= lastStepMs ? tsMs - lastStepMs : 0;
      const stepDeltaMs = rawStep > 0 ? Math.max(500, rawStep) : undefined;
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
      let folded = false;
      for (let j = reconstructed.length - 1; j > activeHistUserIdx; j--) {
        const item = reconstructed[j];
        if (item.kind !== "assistant") continue;
        const fold = foldAssistantProjection(item.content, text);
        if (fold === "distinct") continue;
        folded = true;
        if (fold === "previous") break;
        const toolAfter = reconstructed.slice(j + 1).some((entry) => entry.kind === "tool_call");
        if (toolAfter) {
          reconstructed.splice(j, 1);
          folded = false;
        } else {
          item.content = text;
        }
        break;
      }
      if (folded) continue;
      reconstructed.push({
        id: `as-hist-${i}`,
        session_id: sid,
        timestamp: ts,
        kind: "assistant",
        content: text,
      });
    } else if (evType === "usage_updated") {
      if (activeHistUserIdx >= 0) {
        const inTok = Number(ev.input_tokens ?? 0);
        const outTok = Number(ev.output_tokens ?? 0);
        const cacheRead = Number(ev.cache_read_tokens ?? 0);
        const costUsd = Number(ev.cost_usd ?? 0);
        const outTps = Number(ev.output_tps ?? 0);
        reconstructed[activeHistUserIdx] = {
          ...reconstructed[activeHistUserIdx],
          tps: outTps >= 0.5 ? outTps : reconstructed[activeHistUserIdx].tps,
          input_tokens: inTok || reconstructed[activeHistUserIdx].input_tokens,
          output_tokens: outTok || reconstructed[activeHistUserIdx].output_tokens,
          cache_read_tokens: cacheRead || reconstructed[activeHistUserIdx].cache_read_tokens,
          cost_usd: costUsd || reconstructed[activeHistUserIdx].cost_usd,
        };
      }
    } else if (evType === "error") {
      const errText = String(ev.error ?? "Agent execution error");
      const prevItem = reconstructed[reconstructed.length - 1];
      // Deduplicate stacked timeout/auth error lines within the same turn
      if (prevItem && prevItem.id.startsWith("err-")) {
        continue;
      }
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

function parseAgentErrorBanner(
  rawContent: string,
  fallbackProvider: string
): {
  isError: boolean;
  isAuthRequired: boolean;
  provider: string;
  loginCommand: string;
  authUrl: string;
  message: string;
} | null {
  const trimmed = rawContent.trim();
  const hasWarnPrefix = trimmed.startsWith("⚠️");
  const stripped = hasWarnPrefix ? trimmed.replace(/^⚠️\s*/, "").trim() : trimmed;
  if (!hasWarnPrefix && !stripped.startsWith("[AUTH_REQUIRED|")) {
    return null;
  }

  const defaultLoginCmd = (p: string) => {
    if (p === "cursor" || p === "cursor-agent") return "cursor-agent login";
    if (p === "agy" || p === "antigravity") return 'agy -i "hi"';
    if (p === "codex") return "codex login";
    if (p === "grok") return "grok";
    return "claude auth login";
  };

  if (stripped.startsWith("[AUTH_REQUIRED|")) {
    const closeIdx = stripped.indexOf("]");
    if (closeIdx !== -1) {
      const meta = stripped.slice(1, closeIdx).split("|");
      const provider = meta[1] || fallbackProvider || "agy";
      const loginCommand = meta[2] || defaultLoginCmd(provider);
      const authUrl = meta[3] || "";
      const message = stripped.slice(closeIdx + 1).trim();
      return {
        isError: true,
        isAuthRequired: true,
        provider,
        loginCommand,
        authUrl,
        message: message || "CLI 需要重新登录认证",
      };
    }
  }

  const isAuth =
    /authentication required|not authenticated|authentication timed out|authentication failed|agent login|claude login|codex login|api_key|oauth|401 unauthorized/i.test(
      stripped
    );
  const detectedProv = /agent login|cursor/i.test(stripped)
    ? "cursor"
    : /accounts\.google\.com|antigravity|agy/i.test(stripped)
    ? "agy"
    : /codex/i.test(stripped)
    ? "codex"
    : /grok|xai/i.test(stripped)
    ? "grok"
    : fallbackProvider || "claude";
  const urlMatch = stripped.match(/https:\/\/[^\s"'<>)]+/);

  return {
    isError: true,
    isAuthRequired: isAuth,
    provider: detectedProv,
    loginCommand: defaultLoginCmd(detectedProv),
    authUrl: urlMatch ? urlMatch[0] : "",
    message: stripped,
  };
}

const MAX_EVENTS_CACHE_BYTES = 512 * 1024; // 512 KB cap; SQLite WAL daemon is source of truth

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function purgeBloatedStorageCaches(): void {
  try {
    window.localStorage.removeItem("velo.events.v4");
    window.localStorage.removeItem("velo.events.v3");
    window.localStorage.removeItem("velo.events.v2");
    window.localStorage.removeItem("velo.events.v1");
    window.localStorage.removeItem("velo.repos.v2");
  } catch {
    // ignore
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // WKWebView 5 MB localStorage quota exceeded — evict disposable event cache and retry once
    purgeBloatedStorageCaches();
    if (key === "velo.events.v4") return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Never throw out of a React render/effect
    }
  }
}

function compactEventsForLocalStorage(
  eventsBySession: Record<string, AgentEvent[]>,
  activeId: string
): string | null {
  try {
    const keys = Object.keys(eventsBySession);
    if (keys.length === 0) return "{}";
    const prioritized = [
      ...(activeId && eventsBySession[activeId] ? [activeId] : []),
      ...keys.filter((k) => k !== activeId).slice(-4),
    ];
    const compact: Record<string, AgentEvent[]> = {};
    for (const sid of prioritized) {
      const list = eventsBySession[sid];
      if (!Array.isArray(list) || list.length === 0) continue;
      compact[sid] = list.slice(-20).map((ev) => ({
        ...ev,
        content:
          typeof ev.content === "string" && ev.content.length > 1200
            ? `${ev.content.slice(0, 1200)}…`
            : ev.content,
        tool_output:
          typeof ev.tool_output === "string" && ev.tool_output.length > 600
            ? `${ev.tool_output.slice(0, 600)}…`
            : ev.tool_output,
        tool_args:
          typeof ev.tool_args === "string" && ev.tool_args.length > 400
            ? `${ev.tool_args.slice(0, 400)}…`
            : ev.tool_args,
        tool_input: undefined,
        images: Array.isArray(ev.images)
          ? ev.images.filter((img) => typeof img === "string" && !img.startsWith("data:") && img.length < 512)
          : undefined,
      }));
    }
    const serialized = JSON.stringify(compact);
    if (serialized.length > MAX_EVENTS_CACHE_BYTES) {
      return null;
    }
    return serialized;
  } catch {
    return null;
  }
}

// Self-heal bloated pre-existing localStorage event cache immediately on module load
try {
  const existingEventsRaw = window.localStorage.getItem("velo.events.v4");
  if (existingEventsRaw && existingEventsRaw.length > MAX_EVENTS_CACHE_BYTES) {
    purgeBloatedStorageCaches();
  }
} catch {
  // ignore
}

export function App() {
  const [localDaemonUrl] = useState<string>(() => {
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

  const [daemonUrl, setDaemonUrl] = useState<string>(() => {
    const saved = safeStorageGet("velo.activeDaemonUrl.v1");
    if (saved && (saved.startsWith("http://") || saved.startsWith("https://"))) {
      return saved.replace(/\/$/, "");
    }
    return localDaemonUrl;
  });
  const [federatedHosts, setFederatedHosts] = useState<RemoteHostDto[]>([]);
  const [monitorMenuOpen, setMonitorMenuOpen] = useState<boolean>(false);
  const desktopClientIdRef = useRef<string>(
    `desktop-${Math.random().toString(36).slice(2, 10)}`
  );

  const handleSwitchControlPlane = useCallback(
    (targetUrl: string) => {
      const clean = targetUrl.replace(/\/+$/, "");
      if (!clean || clean === daemonUrl) return;
      if (clean === localDaemonUrl) {
        safeStorageSet("velo.activeDaemonUrl.v1", "");
      } else {
        safeStorageSet("velo.activeDaemonUrl.v1", clean);
      }
      eventsMetaBySessionRef.current = {};
      setEventsBySession({});
      setSessions([]);
      setActiveId("");
      setDaemonUrl(clean);
    },
    [daemonUrl, localDaemonUrl]
  );

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
    const saved = safeStorageGet("velo.themeMode");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "system";
  });
  const [tone, setTone] = useState<ToneId>(() => {
    const saved = safeStorageGet("velo.tone");
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
    safeStorageSet("velo.themeMode", themeMode);
    safeStorageSet("velo.tone", tone);
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
  // Persistent per-workspace folder expand/collapse memory keyed by canonical path.
  // Unrecorded folders default to collapsed (except the active session's folder) so
  // restarts and newly discovered repos never explode the sidebar open uncontrollably.
  const [repoFolderState, setRepoFolderState] = useState<Record<string, "open" | "closed">>(() => {
    try {
      const saved = safeStorageGet("velo.repoFolderState.v1");
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          const clean: Record<string, "open" | "closed"> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (v === "open" || v === "closed") clean[k] = v;
          }
          return clean;
        }
      }
    } catch {
      // ignore
    }
    return {};
  });
  useEffect(() => {
    try {
      safeStorageSet("velo.repoFolderState.v1", JSON.stringify(repoFolderState));
    } catch {
      // ignore
    }
  }, [repoFolderState]);
  const [diffFilesCollapsedBySession, setDiffFilesCollapsedBySession] = useState<
    Record<string, boolean>
  >({});
  const [autoCollapseSteps, setAutoCollapseSteps] = useState<boolean>(() => {
    const saved = safeStorageGet("velo.autoCollapseSteps");
    return saved === null ? true : saved !== "false";
  });
  useEffect(() => {
    safeStorageSet("velo.autoCollapseSteps", String(autoCollapseSteps));
  }, [autoCollapseSteps]);
  const [repos, setRepos] = useState<VeloRepo[]>(() => {
    try {
      const saved =
        safeStorageGet("velo.repos.v3") || safeStorageGet("velo.repos.v2");
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

  // Core Sessions & Events (Persisted across restarts; zero fake demo threads)
  const [sessions, setSessions] = useState<VeloSession[]>(() => {
    try {
      const saved = safeStorageGet("velo.sessions.v3");
      if (saved) {
        const parsed = (JSON.parse(saved) as VeloSession[]).filter(
          (s) => s.id !== "sess-default"
        );
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
    return [];
  });
  const [activeId, setActiveId] = useState<string>(() => {
    const saved = safeStorageGet("velo.activeId.v3");
    return saved && saved !== "sess-default" ? saved : "";
  });
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[]>>(() => {
    try {
      const saved = safeStorageGet("velo.events.v4");
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, AgentEvent[]>;
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch {
      // ignore
    }
    return {};
  });

  const reposLatestRef = useRef(repos);
  reposLatestRef.current = repos;
  const sessionsLatestRef = useRef(sessions);
  sessionsLatestRef.current = sessions;
  const activeIdLatestRef = useRef(activeId);
  activeIdLatestRef.current = activeId;
  const eventsLatestRef = useRef(eventsBySession);
  eventsLatestRef.current = eventsBySession;

  // Debounced idle persistence: avoids synchronous JSON.stringify/localStorage stalls during streaming
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        safeStorageSet("velo.repos.v3", JSON.stringify(reposLatestRef.current));
      } catch {
        // ignore
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [repos]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        safeStorageSet("velo.sessions.v3", JSON.stringify(sessionsLatestRef.current));
      } catch {
        // ignore
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [sessions]);

  useEffect(() => {
    safeStorageSet("velo.activeId.v3", activeId);
  }, [activeId]);

  useEffect(() => {
    const hasStreaming = Object.values(eventsBySession).some((list) =>
      list.some((ev) => ev.is_streaming_chunk)
    );
    // Defer heavy event-cache serialization while streaming; flush automatically when stream settles or on pagehide
    const delayMs = hasStreaming ? 4000 : 1400;
    let cancelIdle: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelIdle = scheduleIdleWork(() => {
        const compact = compactEventsForLocalStorage(
          eventsLatestRef.current,
          activeIdLatestRef.current
        );
        if (compact !== null) {
          safeStorageSet("velo.events.v4", compact);
        } else {
          purgeBloatedStorageCaches();
        }
      }, 1800);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [eventsBySession, activeId]);

  const [connected, setConnected] = useState<boolean>(false);
  const [wsReconnectNonce, setWsReconnectNonce] = useState<number>(0);
  const [connectionGraceElapsed, setConnectionGraceElapsed] = useState<boolean>(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setConnectionGraceElapsed(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);
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
  const pendingDiffTargetPathRef = useRef<string | null>(null);

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
  const [headerMoreMenuOpen, setHeaderMoreMenuOpen] = useState<boolean>(false);

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

  // Per-Session Composer State (each thread keeps its own unsent text draft + image attachments)
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>(() => {
    try {
      const raw = safeStorageGet("velo.drafts.v1");
      const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [attachmentsBySession, setAttachmentsBySession] = useState<
    Record<string, PendingAttachmentItem[]>
  >({});
  const draftsLatestRef = useRef<Record<string, string>>(draftsBySession);
  const draftPersistTimerRef = useRef<number | null>(null);
  const scheduleDraftStoragePersist = useCallback(() => {
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      try {
        const compact: Record<string, string> = {};
        for (const [k, v] of Object.entries(draftsLatestRef.current)) {
          if (v && v.length <= 24_000) compact[k] = v;
        }
        const serialized = JSON.stringify(compact);
        if (serialized.length <= 200_000) {
          safeStorageSet("velo.drafts.v1", serialized);
        }
      } catch {
        // ignore
      }
    }, 600);
  }, []);
  useEffect(() => {
    // Keep draftsLatestRef in sync when draftsBySession is updated structurally (e.g. draft-empty carry-over)
    draftsLatestRef.current = { ...draftsBySession, ...draftsLatestRef.current };
    scheduleDraftStoragePersist();
  }, [draftsBySession, scheduleDraftStoragePersist]);

  // Flush debounced caches cleanly on app quit / tab hide so zero drafts or events are lost
  useEffect(() => {
    const flushAllCaches = () => {
      try {
        safeStorageSet("velo.repos.v3", JSON.stringify(reposLatestRef.current));
        safeStorageSet("velo.sessions.v3", JSON.stringify(sessionsLatestRef.current));
        const compactDrafts: Record<string, string> = {};
        for (const [k, v] of Object.entries(draftsLatestRef.current)) {
          if (v && v.length <= 24_000) compactDrafts[k] = v;
        }
        const serializedDrafts = JSON.stringify(compactDrafts);
        if (serializedDrafts.length <= 200_000) {
          safeStorageSet("velo.drafts.v1", serializedDrafts);
        }
        const compactEvents = compactEventsForLocalStorage(
          eventsLatestRef.current,
          activeIdLatestRef.current
        );
        if (compactEvents !== null) {
          safeStorageSet("velo.events.v4", compactEvents);
        }
      } catch {
        // ignore
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushAllCaches();
    };
    window.addEventListener("pagehide", flushAllCaches);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flushAllCaches);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState<number>(0);
  const slashActionRunnersRef = useRef<Array<() => void>>([]);
  const [fileMentionQuery, setFileMentionQuery] = useState<string | null>(null);
  const [fileMentionResults, setFileMentionResults] = useState<WorkspaceFileMentionItem[]>([]);
  const [fileMentionIdx, setFileMentionIdx] = useState<number>(0);
  const [forkLaunchTarget, setForkLaunchTarget] = useState<ForkLaunchTarget | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState<boolean>(false);
  const [composerDragOver, setComposerDragOver] = useState<boolean>(false);
  const [oldestSeqBySession, setOldestSeqBySession] = useState<Record<string, number>>({});
  const [hasMoreHistoryBySession, setHasMoreHistoryBySession] = useState<Record<string, boolean>>({});
  const [loadingOlderBySession, setLoadingOlderBySession] = useState<Record<string, boolean>>({});
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState<string>("");

  // Modals, Repo Worktree Setup Hooks, Custom ACP Runtime, & E2EE Pairing Ticket
  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [enabledAutomationsCount, setEnabledAutomationsCount] = useState<number>(0);
  const [pendingScheduleDraft, setPendingScheduleDraft] = useState<{
    rawInput: string;
    parsed: ParsedScheduleDto;
    repoPath: string;
    provider: string;
    model?: string;
    saving?: boolean;
  } | null>(null);
  const bypassScheduleInterceptRef = useRef<boolean>(false);
  const [scheduleCreatedToast, setScheduleCreatedToast] = useState<string | null>(null);
  const [pairTicket, setPairTicket] = useState<PairingTicketDto | null>(null);
  const [serviceStatus, setServiceStatus] = useState<{
    label: string;
    plist_installed: boolean;
    launchd_loaded: boolean;
    launchd_pid?: number | null;
    prevent_idle_sleep: boolean;
    caffeinate_active: boolean;
  } | null>(null);
  const [serviceUpdating, setServiceUpdating] = useState<boolean>(false);
  const [cmdQuery, setCmdQuery] = useState<string>("");
  const [newTaskName, setNewTaskName] = useState<string>("feat/new-thread");
  const [newTaskDesc, setNewTaskDesc] = useState<string>("");
  const [newModelId, setNewModelId] = useState<string>("claude-fable-5-2");
  const [newApproval, setNewApproval] = useState<ApprovalMode>("auto_edit");
  const [newSetupCommand, setNewSetupCommand] = useState<string>("");
  const [repoHooks, setRepoHooks] = useState<Record<string, string>>({});
  const [hookEditCmd, setHookEditCmd] = useState<string>("");
  const [customAcpCmd, setCustomAcpCmd] = useState<string>("");
  const [newRepoPath, setNewRepoPath] = useState<string>("~/code");
  const [newRepoMode, setNewRepoMode] = useState<"existing" | "create">("existing");
  const [newFolderParent, setNewFolderParent] = useState<string>("~/code");
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [newFolderInitGit, setNewFolderInitGit] = useState<boolean>(true);
  const [analyticsModalOpen, setAnalyticsModalOpen] = useState<boolean>(false);
  const [cliImportOpen, setCliImportOpen] = useState<boolean>(false);
  const [hostsModalOpen, setHostsModalOpen] = useState<boolean>(false);
  const [extCpModalOpen, setExtCpModalOpen] = useState<boolean>(false);
  const [extCpInitialTab, setExtCpInitialTab] = useState<"checkpoints" | "extensions">("checkpoints");
  const [localSkills, setLocalSkills] = useState<SkillEntryDto[]>([]);
  const [relocateTarget, setRelocateTarget] = useState<{
    mode: "workspace" | "session";
    oldPath: string;
    sessionId?: string;
    newPath: string;
  } | null>(null);
  const [showArchivedDrawer, setShowArchivedDrawer] = useState<boolean>(false);
  const [sessionPendingDelete, setSessionPendingDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [chatFindOpen, setChatFindOpen] = useState<boolean>(false);
  const [chatFindQuery, setChatFindQuery] = useState<string>("");
  const [unreadSessionIds, setUnreadSessionIds] = useState<Record<string, boolean>>(() => {
    try {
      const raw = safeStorageGet("velo.unread.v1");
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      safeStorageSet("velo.unread.v1", JSON.stringify(unreadSessionIds));
    } catch {
      // ignore
    }
  }, [unreadSessionIds]);
  const [e2eeCliSessions, setE2eeCliSessions] = useState<ExternalCliSessionItem[] | null>(null);
  const [e2eeCliHiddenCount, setE2eeCliHiddenCount] = useState<number>(0);
  const [analyticsInitialTab, setAnalyticsInitialTab] = useState<"analytics" | "search" | "push">(
    "analytics"
  );
  const [showAllTurnsBySession, setShowAllTurnsBySession] = useState<Record<string, boolean>>({});

  // Full-Color xterm.js PTY Stream Packet & Turn Timing State
  const [latestTerminalChunk, setLatestTerminalChunk] = useState<TerminalChunkPacket | null>(null);
  const termSeqRef = useRef<number>(0);
  const turnStartMsRef = useRef<Record<string, number>>({});
  const stepStartMsRef = useRef<Record<string, number>>({});
  const streamOutCharsRef = useRef<Record<string, { startedAtMs: number; chars: number }>>({});
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
        liveTps?: number;
      }
    >
  >({});

  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatContentRef = useRef<HTMLDivElement | null>(null);
  const isPinnedToBottomRef = useRef<boolean>(true);
  const programmaticScrollRef = useRef<boolean>(false);
  const userScrollIntentAtRef = useRef<number>(0);
  const lastScrollTopRef = useRef<number>(0);
  const eventsMetaBySessionRef = useRef<
    Record<string, { newestSeq: number | null; eventCount: number; latestTsMs: number | null }>
  >({});
  const [showJumpToBottom, setShowJumpToBottom] = useState<boolean>(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Optimistic queue rows use `q-local-*` until the daemon returns the real id.
  // Clicks that happen in that window are applied once the real id arrives.
  const queuedIntentRef = useRef<Map<string, "drop" | "run">>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resizeSnapRafRef = useRef<number | null>(null);

  const nudgeWebKitScrollRepaint = useCallback((el: HTMLDivElement | null, pinToBottom: boolean) => {
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const target = pinToBottom ? maxScroll : Math.min(el.scrollTop, maxScroll);
    programmaticScrollRef.current = true;
    // Force WKWebView's ScrollingTree composited tile cache to re-sync after height shrinks / layer unmounts
    if (maxScroll > 0) {
      el.scrollTop = target > 0 ? target - 1 : 1;
      void el.offsetHeight;
    }
    el.scrollTop = target;
    lastScrollTopRef.current = el.scrollTop;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  const snapChatToBottomImmediate = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    programmaticScrollRef.current = true;
    el.scrollTop = maxScroll;
    lastScrollTopRef.current = el.scrollTop;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  const scrollChatToBottom = useCallback((smooth = false) => {
    if (smooth) {
      isPinnedToBottomRef.current = true;
      setShowJumpToBottom(false);
      requestAnimationFrame(() => {
        const el = chatScrollRef.current;
        if (el) {
          const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
          programmaticScrollRef.current = true;
          el.scrollTo({ top: maxScroll, behavior: "smooth" });
          lastScrollTopRef.current = maxScroll;
          window.setTimeout(() => {
            programmaticScrollRef.current = false;
          }, 260);
        } else {
          streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      });
      return;
    }
    if (!isPinnedToBottomRef.current) return;
    requestAnimationFrame(() => {
      if (!isPinnedToBottomRef.current) return;
      snapChatToBottomImmediate();
    });
  }, [snapChatToBottomImmediate]);

  // Auto-keep viewport locked to the very bottom whenever content height or window size
  // changes while in PinnedBottom mode. Always defer via rAF so WKWebView never mutates
  // scrollTop synchronously inside a ResizeObserver layout pass.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const contentEl = chatContentRef.current;
    const scrollEl = chatScrollRef.current;
    if (!contentEl && !scrollEl) return;
    const ro = new ResizeObserver(() => {
      if (resizeSnapRafRef.current !== null) return;
      resizeSnapRafRef.current = requestAnimationFrame(() => {
        resizeSnapRafRef.current = null;
        const el = chatScrollRef.current;
        if (!el) return;
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        if (isPinnedToBottomRef.current) {
          snapChatToBottomImmediate();
        } else if (el.scrollTop > maxScroll) {
          // Clamp out-of-bounds scrollTop when an expanded trace collapses above the viewport
          nudgeWebKitScrollRepaint(el, false);
        }
      });
    });
    if (contentEl) ro.observe(contentEl);
    if (scrollEl) ro.observe(scrollEl);
    return () => {
      ro.disconnect();
      if (resizeSnapRafRef.current !== null) {
        cancelAnimationFrame(resizeSnapRafRef.current);
        resizeSnapRafRef.current = null;
      }
    };
  }, [snapChatToBottomImmediate, nudgeWebKitScrollRepaint]);

  const activeSession = useMemo<VeloSession>(() => {
    const found =
      sessions.find((s) => s.id === activeId) ||
      sessions.find((s) => !s.archived) ||
      sessions[0];
    if (found) return found;
    const defaultRepo = repos[0] || DEMO_REPOS[0];
    const lastPref = readLastModelPref();
    return {
      id: "draft-empty",
      repo_id: defaultRepo.id,
      title: "New thread",
      agent_kind: lastPref?.agent_kind || "claude",
      model: lastPref?.model || "claude-fable-5-2",
      model_short: lastPref?.model_short || "Fable 5.2",
      effort: lastPref?.effort || "medium",
      status: "idle",
      branch_name: defaultRepo.default_branch || "main",
      worktree_path: defaultRepo.path,
      project_path: defaultRepo.path,
      approval_mode: "auto_edit",
      queued_prompts: [],
      tokens_used: 0,
      tokens_limit: 200000,
      cost_usd: 0,
      files_changed: 0,
      insertions: 0,
      deletions: 0,
      updated_at: "ready",
    };
  }, [sessions, activeId, repos]);

  const activeSessionIdRef = useRef<string>(activeSession.id);
  activeSessionIdRef.current = activeSession.id;
  const sessionsStatusRef = useRef<Record<string, string>>({});
  sessionsStatusRef.current = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of sessions) {
      map[s.id] = s.status;
    }
    return map;
  }, [sessions]);

  const [promptProgrammaticNonce, setPromptProgrammaticNonce] = useState<number>(0);
  const [hasComposerText, setHasComposerText] = useState<boolean>(() =>
    Boolean((draftsLatestRef.current[activeSession.id] ?? "").trim())
  );
  const hasComposerTextRef = useRef<boolean>(hasComposerText);
  hasComposerTextRef.current = hasComposerText;

  useEffect(() => {
    const nextHas = Boolean((draftsLatestRef.current[activeSession.id] ?? "").trim());
    if (nextHas !== hasComposerTextRef.current) {
      hasComposerTextRef.current = nextHas;
      setHasComposerText(nextHas);
    }
  }, [activeSession.id]);

  const pendingAttachments = useMemo(
    () => attachmentsBySession[activeSession.id] ?? [],
    [attachmentsBySession, activeSession.id]
  );

  const commitDraftToState = useCallback((sid: string, val: string) => {
    if (!sid) return;
    if (!val) {
      delete draftsLatestRef.current[sid];
    } else {
      draftsLatestRef.current[sid] = val;
    }
    setDraftsBySession((prev) => {
      const cur = prev[sid] ?? "";
      if (val === cur) return prev;
      const next = { ...prev };
      if (!val) {
        delete next[sid];
      } else {
        next[sid] = val;
      }
      return next;
    });
  }, []);

  const setPrompt = useCallback(
    (updater: string | ((prev: string) => string), targetSid?: string) => {
      const sid = targetSid || activeSessionIdRef.current || "draft-empty";
      const cur = draftsLatestRef.current[sid] ?? "";
      const nextVal = typeof updater === "function" ? updater(cur) : updater;
      if (nextVal === cur) return;
      if (!nextVal) {
        delete draftsLatestRef.current[sid];
      } else {
        draftsLatestRef.current[sid] = nextVal;
      }
      if (sid === activeSessionIdRef.current) {
        const nextHas = Boolean(nextVal.trim());
        if (nextHas !== hasComposerTextRef.current) {
          hasComposerTextRef.current = nextHas;
          setHasComposerText(nextHas);
        }
        setPromptProgrammaticNonce((n) => n + 1);
      }
      setDraftsBySession((prev) => {
        const next = { ...prev };
        if (!nextVal) {
          delete next[sid];
        } else {
          next[sid] = nextVal;
        }
        return next;
      });
      scheduleDraftStoragePersist();
    },
    [scheduleDraftStoragePersist]
  );

  const setPendingAttachments = useCallback(
    (
      updater:
        | PendingAttachmentItem[]
        | ((prev: PendingAttachmentItem[]) => PendingAttachmentItem[]),
      targetSid?: string
    ) => {
      const sid = targetSid || activeSessionIdRef.current || "draft-empty";
      setAttachmentsBySession((prev) => {
        const cur = prev[sid] ?? [];
        const nextVal = typeof updater === "function" ? updater(cur) : updater;
        const next = { ...prev };
        if (nextVal.length === 0) {
          delete next[sid];
        } else {
          next[sid] = nextVal;
        }
        return next;
      });
    },
    []
  );

  // Close slash menu when switching between threads so another thread's `/` state never carries over
  useEffect(() => {
    setSlashFilter(null);
  }, [activeSession.id]);

  const activeRepo = useMemo(
    () =>
      repos.find(
        (r) =>
          r.id === activeSession.repo_id ||
          canonicalRepoPath(r.path) === canonicalRepoPath(activeSession.project_path)
      ) ||
      repos[0] ||
      DEMO_REPOS[0],
    [repos, activeSession.repo_id, activeSession.project_path]
  );

  // Sync real local + project-level + Velo custom Skills for the active workspace so `/` slash completion is always live
  useEffect(() => {
    const wsPath = (activeSession.project_path || activeRepo?.path || "").trim();
    let cancelled = false;
    const qs = wsPath ? `?workspace=${encodeURIComponent(wsPath)}` : "";
    fetch(`${daemonUrl}/api/extensions${qs}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.skills)) {
          setLocalSkills(data.skills as SkillEntryDto[]);
        }
      })
      .catch(() => {
        // Offline or E2EE-only mode: keep previous skill list
      });
    return () => {
      cancelled = true;
    };
  }, [daemonUrl, activeSession.project_path, activeRepo?.path]);

  const activeEvents = useMemo(
    () => eventsBySession[activeSession.id] || [],
    [eventsBySession, activeSession.id]
  );

  const outlineTurns = useMemo<OutlineTurnSummary[]>(() => {
    const out: OutlineTurnSummary[] = [];
    for (const ev of activeEvents) {
      if (ev.kind === "user") {
        out.push({
          index: out.length,
          key: ev.id,
          promptSnippet: ev.content.replace(/\s+/g, " ").trim().slice(0, 60) || "Turn",
        });
      }
    }
    return out;
  }, [activeEvents]);

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
          // Fetch canonical workspace list from daemon so Desktop & iOS share identical folders
          fetch(`${daemonUrl}/api/workspaces`)
            .then((r) => (r.ok ? r.json() : null))
            .then((wsObj: { workspaces?: string[] } | null) => {
              if (!wsObj || !Array.isArray(wsObj.workspaces)) return;
              const daemonPaths = wsObj.workspaces.map(canonicalRepoPath);
              const allPaths = Array.from(
                new Set([
                  ...daemonPaths,
                  ...normalized.map((s) => canonicalRepoPath(s.project_path)),
                ].filter(Boolean))
              );

              setRepos((prevRepos) => {
                if (allPaths.length === 0) return [];
                const prevByPath = new Map<string, VeloRepo>();
                for (const r of prevRepos) {
                  prevByPath.set(canonicalRepoPath(r.path), r);
                }
                return allPaths.map((cp) => {
                  const existing = prevByPath.get(cp);
                  const folder = cp.split("/").filter(Boolean).pop() || "workspace";
                  return {
                    id: repoIdFromPath(cp),
                    code: existing?.code || folder.slice(0, 2).toUpperCase(),
                    name: folder,
                    path: cp,
                    default_branch: existing?.default_branch || "main",
                  };
                });
              });
            })
            .catch(() => {});

          if (normalized.length > 0) {
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
                title: n.title || existing.title,
                // Always trust canonical repo_id & project_path from daemon so Desktop & iOS folders never diverge!
                repo_id: n.repo_id,
                project_path: n.project_path,
                agent_kind: n.agent_kind || existing.agent_kind,
                model: n.model || existing.model,
                model_short: n.model_short || existing.model_short,
                effort: n.effort || existing.effort,
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
            return combined;
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

    fetch(`${daemonUrl}/api/automations`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { automations?: Array<{ enabled?: boolean }> }) => {
        if (Array.isArray(data.automations)) {
          setEnabledAutomationsCount(data.automations.filter((a) => a.enabled).length);
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
              const pendingTarget = pendingDiffTargetPathRef.current;
              const matchedPending = pendingTarget
                ? (() => {
                    const cleaned = pendingTarget.replace(/^["'`]|["'`]$/g, "").trim();
                    const base = cleaned.split("/").pop() || cleaned;
                    return (
                      converted.find((c) => c.path === cleaned) ||
                      converted.find((c) => cleaned.endsWith(c.path) || c.path.endsWith(cleaned)) ||
                      converted.find((c) => cleaned.includes(c.path) || c.path.includes(cleaned)) ||
                      converted.find((c) => (c.path.split("/").pop() || c.path) === base)
                    );
                  })()
                : undefined;
              if (matchedPending) {
                pendingDiffTargetPathRef.current = null;
                setSelectedDiffPath(matchedPending.path);
              } else {
                setSelectedDiffPath((prev) =>
                  converted.some((c) => c.path === prev) ? prev : converted[0].path
                );
              }
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
      snapChatToBottomImmediate();
    });
  }, [activeSession.id, refreshSessionDiffAndFiles, snapChatToBottomImmediate]);

  useEffect(() => {
    activeSessionIdRef.current = activeSession.id;
    setUnreadSessionIds((prev) => {
      if (!prev[activeSession.id]) return prev;
      const next = { ...prev };
      delete next[activeSession.id];
      return next;
    });
  }, [activeSession.id]);

  // Authoritative sync of persisted event history from SQLite WAL.
  // Supports lightweight `after_seq` incremental catch-up on window focus so unchanged
  // sessions perform zero array replacement and never disturb scroll position.
  const syncSessionEventsFromDaemon = useCallback(
    (sid: string, options?: { incremental?: boolean }) => {
      if (!sid || sid.startsWith("sess-") || sid.startsWith("wt-")) return;
      const meta = eventsMetaBySessionRef.current[sid];
      const useIncremental =
        Boolean(options?.incremental) && meta && typeof meta.newestSeq === "number";
      const qs = new URLSearchParams({ limit: "180" });
      if (useIncremental && meta && meta.newestSeq !== null) {
        qs.set("after_seq", String(meta.newestSeq));
        qs.set("known_count", String(meta.eventCount));
        if (meta.latestTsMs !== null) {
          qs.set("known_ts_ms", String(meta.latestTsMs));
        }
      }
      fetch(`${daemonUrl}/api/sessions/${sid}/events?${qs.toString()}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(
          (
            payload:
              | Array<Record<string, unknown>>
              | {
                  events?: Array<Record<string, unknown>>;
                  oldest_seq?: number | null;
                  newest_seq?: number | null;
                  latest_ts_ms?: number | null;
                  event_count?: number;
                  has_more?: boolean;
                  incremental?: boolean;
                  unchanged?: boolean;
                }
          ) => {
            if (!Array.isArray(payload)) {
              if (payload?.unchanged) {
                if (sid === activeSessionIdRef.current && isPinnedToBottomRef.current) {
                  requestAnimationFrame(() => snapChatToBottomImmediate());
                }
                return;
              }
              eventsMetaBySessionRef.current[sid] = {
                newestSeq:
                  typeof payload?.newest_seq === "number"
                    ? payload.newest_seq
                    : meta?.newestSeq ?? null,
                eventCount:
                  typeof payload?.event_count === "number"
                    ? payload.event_count
                    : meta?.eventCount ?? 0,
                latestTsMs:
                  typeof payload?.latest_ts_ms === "number"
                    ? payload.latest_ts_ms
                    : meta?.latestTsMs ?? null,
              };
              if (!payload?.incremental) {
                if (typeof payload?.oldest_seq === "number") {
                  setOldestSeqBySession((prev) => ({ ...prev, [sid]: payload.oldest_seq as number }));
                }
                setHasMoreHistoryBySession((prev) => ({
                  ...prev,
                  [sid]: Boolean(payload?.has_more),
                }));
              }
            }
            const rawList = Array.isArray(payload)
              ? payload
              : Array.isArray(payload?.events)
              ? payload.events
              : [];
            const isIncrementalAppend = !Array.isArray(payload) && Boolean(payload?.incremental);

            if (rawList.length === 0) {
              if (isIncrementalAppend) return;
              setEventsBySession((prev) => {
                const cur = prev[sid] || [];
                if (cur.some((x) => x.is_streaming_chunk)) return prev;
                if (cur.length === 0) return prev;
                return { ...prev, [sid]: [] };
              });
              return;
            }
            const reconstructed = reconstructEventsFromHistory(sid, rawList);
            if (reconstructed.length > 0) {
              setEventsBySession((prev) => {
                const cur = prev[sid] || [];
                const isActivelyStreaming = cur.some((x) => x.is_streaming_chunk);
                if (isActivelyStreaming) {
                  return prev;
                }
                if (isIncrementalAppend && cur.length > 0) {
                  const next = [...cur];
                  let mutated = false;
                  for (const incoming of reconstructed) {
                    if (incoming.kind === "user") {
                      const trimmedIn = incoming.content.trim();
                      let existingIdx = -1;
                      if (incoming.client_msg_id) {
                        for (let i = next.length - 1; i >= 0; i--) {
                          if (
                            next[i].kind === "user" &&
                            next[i].client_msg_id === incoming.client_msg_id
                          ) {
                            existingIdx = i;
                            break;
                          }
                        }
                      }
                      if (existingIdx === -1) {
                        const floor = Math.max(0, next.length - 60);
                        for (let i = next.length - 1; i >= floor; i--) {
                          if (
                            next[i].kind === "user" &&
                            next[i].content.trim() === trimmedIn
                          ) {
                            existingIdx = i;
                            break;
                          }
                        }
                      }
                      if (existingIdx !== -1) {
                        next[existingIdx] = {
                          ...next[existingIdx],
                          id: incoming.id,
                          timestamp: incoming.timestamp,
                          client_msg_id: incoming.client_msg_id ?? next[existingIdx].client_msg_id,
                          duration_ms: incoming.duration_ms ?? next[existingIdx].duration_ms,
                          completed_at: incoming.completed_at ?? next[existingIdx].completed_at,
                          tps: incoming.tps ?? next[existingIdx].tps,
                          input_tokens: incoming.input_tokens ?? next[existingIdx].input_tokens,
                          output_tokens: incoming.output_tokens ?? next[existingIdx].output_tokens,
                          cache_read_tokens:
                            incoming.cache_read_tokens ?? next[existingIdx].cache_read_tokens,
                          cost_usd: incoming.cost_usd ?? next[existingIdx].cost_usd,
                        };
                        mutated = true;
                        continue;
                      }
                      next.push(incoming);
                      mutated = true;
                      continue;
                    }

                    if (incoming.kind === "tool_call") {
                      const existingToolIdx = next.findIndex(
                        (e) => e.kind === "tool_call" && e.id === incoming.id
                      );
                      if (existingToolIdx !== -1) {
                        next[existingToolIdx] = {
                          ...next[existingToolIdx],
                          ...incoming,
                        };
                        mutated = true;
                        continue;
                      }
                      next.push(incoming);
                      mutated = true;
                      continue;
                    }

                    // Determine current turn boundary for thinking/assistant deduplication
                    let turnStart = 0;
                    for (let i = next.length - 1; i >= 0; i--) {
                      if (next[i].kind === "user") {
                        turnStart = i + 1;
                        break;
                      }
                    }

                    if (incoming.kind === "thinking") {
                      const trimmedIn = incoming.content.trim();
                      const alreadyInTurn = next
                        .slice(turnStart)
                        .some(
                          (e) =>
                            e.kind === "thinking" &&
                            (e.content.trim() === trimmedIn || e.content.includes(trimmedIn))
                        );
                      if (alreadyInTurn) continue;
                      next.push(incoming);
                      mutated = true;
                      continue;
                    }

                    if (incoming.kind === "assistant") {
                      let folded = false;
                      for (let i = next.length - 1; i >= turnStart; i--) {
                        if (next[i].kind !== "assistant") continue;
                        const fold = foldAssistantProjection(next[i].content, incoming.content);
                        if (fold === "distinct") continue;
                        folded = true;
                        if (fold === "incoming") {
                          next[i] = { ...next[i], content: incoming.content };
                          mutated = true;
                        }
                        break;
                      }
                      if (!folded) {
                        next.push(incoming);
                        mutated = true;
                      }
                    }
                  }
                  return mutated ? { ...prev, [sid]: next } : prev;
                }
                return { ...prev, [sid]: reconstructed };
              });
              if (sid === activeSessionIdRef.current) {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    nudgeWebKitScrollRepaint(chatScrollRef.current, isPinnedToBottomRef.current);
                  });
                });
              }
            }
          }
        )
        .catch(() => {
          if (
            e2eeRelayConfig &&
            e2eeWsRef.current &&
            e2eeWsRef.current.readyState === WebSocket.OPEN
          ) {
            const sealed = e2eeSealJson(
              e2eeRelayConfig.sharedKeyHex,
              "mobile-web",
              e2eeNonceRef.current++,
              { cmd: "get_events_page", session_id: sid, limit: 140 }
            );
            e2eeWsRef.current.send(sealed);
          }
        });
    },
    [daemonUrl, e2eeRelayConfig, snapChatToBottomImmediate, nudgeWebKitScrollRepaint]
  );

  const loadOlderEventsForSession = useCallback(
    async (sid: string) => {
      if (!sid || sid === "sess-default" || loadingOlderBySession[sid]) return;
      const beforeSeq = oldestSeqBySession[sid];
      if (typeof beforeSeq !== "number") return;
      setLoadingOlderBySession((prev) => ({ ...prev, [sid]: true }));
      const scrollEl = chatScrollRef.current;
      const prevScrollHeight = scrollEl ? scrollEl.scrollHeight : 0;
      const prevScrollTop = scrollEl ? scrollEl.scrollTop : 0;

      try {
        const res = await fetch(
          `${daemonUrl}/api/sessions/${sid}/events?limit=160&before_seq=${beforeSeq}`
        );
        if (res.ok) {
          const page = (await res.json()) as {
            events?: Array<Record<string, unknown>>;
            oldest_seq?: number | null;
            has_more?: boolean;
          };
          if (typeof page.oldest_seq === "number") {
            setOldestSeqBySession((prev) => ({ ...prev, [sid]: page.oldest_seq as number }));
          }
          setHasMoreHistoryBySession((prev) => ({ ...prev, [sid]: Boolean(page.has_more) }));
          const olderRaw = Array.isArray(page.events) ? page.events : [];
          const olderEvents = reconstructEventsFromHistory(sid, olderRaw);
          if (olderEvents.length > 0) {
            setEventsBySession((prev) => {
              const cur = prev[sid] || [];
              const headKeys = new Set(
                cur.slice(0, 10).map((e) => `${e.timestamp}|${e.content.slice(0, 64)}`)
              );
              const deduped = olderEvents.filter(
                (e) => !headKeys.has(`${e.timestamp}|${e.content.slice(0, 64)}`)
              );
              return deduped.length > 0 ? { ...prev, [sid]: [...deduped, ...cur] } : prev;
            });
            requestAnimationFrame(() => {
              const el = chatScrollRef.current;
              if (el && prevScrollHeight > 0) {
                el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
              }
            });
          }
          setLoadingOlderBySession((prev) => ({ ...prev, [sid]: false }));
          return;
        }
      } catch {
        // Fallback to E2EE relay below
      }

      if (
        e2eeRelayConfig &&
        e2eeWsRef.current &&
        e2eeWsRef.current.readyState === WebSocket.OPEN
      ) {
        const sealed = e2eeSealJson(
          e2eeRelayConfig.sharedKeyHex,
          "mobile-web",
          e2eeNonceRef.current++,
          { cmd: "get_events_page", session_id: sid, before_seq: beforeSeq, limit: 140 }
        );
        e2eeWsRef.current.send(sealed);
      }
      setLoadingOlderBySession((prev) => ({ ...prev, [sid]: false }));
    },
    [daemonUrl, e2eeRelayConfig, loadingOlderBySession, oldestSeqBySession]
  );

  useEffect(() => {
    syncSessionEventsFromDaemon(activeSession.id);
  }, [activeSession.id, syncSessionEventsFromDaemon]);

  useEffect(() => {
    const resyncActiveOnFocus = () => {
      refreshSessions();
      const sid = activeSessionIdRef.current;
      const activeStatus = sid ? sessionsStatusRef.current[sid] : undefined;
      const isLiveRunningWithWs =
        directWsConnectedRef.current &&
        (activeStatus === "running" || activeStatus === "waiting_approval");
      if (sid && !isLiveRunningWithWs) {
        syncSessionEventsFromDaemon(sid, { incremental: true });
      }
      if (isPinnedToBottomRef.current) {
        requestAnimationFrame(() => snapChatToBottomImmediate());
      }
    };
    const onVisibilityChange = () => {
      if (!document.hidden) {
        resyncActiveOnFocus();
      }
    };
    window.addEventListener("focus", resyncActiveOnFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", resyncActiveOnFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshSessions, syncSessionEventsFromDaemon, snapChatToBottomImmediate]);

  // Phase 3: Report desktop presence to daemon so push notifications stay silent while
  // the user is actively viewing the same session on Mac.
  useEffect(() => {
    const reportPresence = (focused: boolean) => {
      const sid = activeSessionIdRef.current;
      const validUuid =
        sid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)
          ? sid
          : null;
      fetch(`${daemonUrl}/api/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: desktopClientIdRef.current,
          platform: "desktop",
          focused,
          active_session_id: validUuid,
        }),
      }).catch(() => {});
    };
    reportPresence(document.hasFocus() && !document.hidden);
    const onFocus = () => reportPresence(true);
    const onBlur = () => reportPresence(false);
    const onVis = () => reportPresence(!document.hidden && document.hasFocus());
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    const hb = window.setInterval(() => {
      if (!document.hidden && document.hasFocus()) {
        reportPresence(true);
      }
    }, 12_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(hb);
    };
  }, [daemonUrl, activeSession.id]);

  // Phase 4: Load federated multi-host registry from local daemon so sidebar host switcher stays live
  useEffect(() => {
    fetch(`${localDaemonUrl}/api/hosts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d?.hosts)) setFederatedHosts(d.hosts as RemoteHostDto[]);
      })
      .catch(() => {});
  }, [localDaemonUrl]);

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

  const fetchServiceStatus = useCallback(() => {
    fetch(`${daemonUrl}/api/system/service`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((st) => setServiceStatus(st))
      .catch(() => {});
  }, [daemonUrl]);

  const handleUpdateSystemService = useCallback(
    async (payload: {
      action?: "install" | "uninstall" | "restart";
      prevent_idle_sleep?: boolean;
    }) => {
      setServiceUpdating(true);
      try {
        const res = await fetch(`${daemonUrl}/api/system/service`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.service) setServiceStatus(data.service);
        }
      } catch {
        // daemon may be restarting into launchd
      } finally {
        window.setTimeout(() => {
          fetchServiceStatus();
          if (payload.action === "install" || payload.action === "restart") {
            fetchPairTicket();
          }
          setServiceUpdating(false);
        }, 950);
      }
    },
    [daemonUrl, fetchPairTicket, fetchServiceStatus]
  );

  // Fetch Pairing Ticket & poll live E2EE bridge/tunnel status while QR modal is open
  useEffect(() => {
    if (activeModal === "settings") {
      fetchServiceStatus();
      return;
    }
    if (activeModal !== "qr") return;
    fetchPairTicket();
    fetchServiceStatus();
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
      fetchServiceStatus();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeModal, daemonUrl, fetchPairTicket, fetchServiceStatus]);

  // Coalesce high-frequency streaming text/thinking chunks (~24ms active / 120ms background)
  // so 60Hz+ token frames never thrash React state or WKWebView layout.
  const pendingStreamChunksRef = useRef<
    Map<
      string,
      {
        kind: "thinking" | "assistant";
        delta: string;
        replace: boolean;
        now: string;
        originMs: number;
      }
    >
  >(new Map());
  const streamFlushTimerRef = useRef<number | null>(null);
  const ttftRecordedBySessionRef = useRef<Record<string, boolean>>({});

  const flushPendingStreamChunks = useCallback(
    (onlySid?: string) => {
      const pending = pendingStreamChunksRef.current;
      if (pending.size === 0) return;

      const entries: Array<
        [
          string,
          {
            kind: "thinking" | "assistant";
            delta: string;
            replace: boolean;
            now: string;
            originMs: number;
          }
        ]
      > = [];

      if (onlySid) {
        const item = pending.get(onlySid);
        if (!item) return;
        pending.delete(onlySid);
        entries.push([onlySid, item]);
      } else {
        for (const entry of pending.entries()) {
          entries.push(entry);
        }
        pending.clear();
        if (streamFlushTimerRef.current !== null) {
          window.clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
      }

      const nowMs = Date.now();
      let touchedActive = false;
      setEventsBySession((prev) => {
        let changed = false;
        const nextMap = { ...prev };
        for (const [sid, chunk] of entries) {
          if (sid === activeSessionIdRef.current) touchedActive = true;
          const list = nextMap[sid] || [];
          const last = list[list.length - 1];
          if (chunk.kind === "thinking") {
            if (last && last.kind === "thinking") {
              const nextContent = chunk.replace
                ? chunk.delta || last.content
                : `${last.content}${chunk.delta}`;
              nextMap[sid] = [
                ...list.slice(0, -1),
                {
                  ...last,
                  content: nextContent,
                  started_at_ms: last.started_at_ms || chunk.originMs,
                  is_streaming_chunk: true,
                },
              ];
            } else {
              nextMap[sid] = [
                ...list,
                {
                  id: `th-stream-${nowMs}-${Math.random().toString(36).slice(2, 5)}`,
                  session_id: sid,
                  timestamp: chunk.now,
                  kind: "thinking",
                  content: chunk.delta,
                  started_at_ms: chunk.originMs,
                  is_streaming_chunk: true,
                },
              ];
            }
            changed = true;
          } else {
            if (last && last.kind === "assistant" && last.is_streaming_chunk) {
              nextMap[sid] = [
                ...list.slice(0, -1),
                {
                  ...last,
                  content: chunk.replace ? chunk.delta : `${last.content}${chunk.delta}`,
                },
              ];
            } else {
              const cleanedPrev =
                last && last.kind === "thinking" && last.is_streaming_chunk
                  ? [
                      ...list.slice(0, -1),
                      {
                        ...last,
                        is_streaming_chunk: false,
                        duration_ms:
                          last.duration_ms ??
                          Math.max(500, nowMs - (last.started_at_ms || chunk.originMs)),
                      },
                    ]
                  : list;
              nextMap[sid] = [
                ...cleanedPrev,
                {
                  id: `as-stream-${nowMs}-${Math.random().toString(36).slice(2, 5)}`,
                  session_id: sid,
                  timestamp: chunk.now,
                  kind: "assistant",
                  content: chunk.delta,
                  is_streaming_chunk: true,
                },
              ];
            }
            changed = true;
          }
        }
        return changed ? nextMap : prev;
      });
      if (touchedActive) {
        scrollChatToBottom(false);
      }
    },
    [scrollChatToBottom]
  );

  const enqueueStreamChunk = useCallback(
    (
      sid: string,
      kind: "thinking" | "assistant",
      delta: string,
      replace: boolean,
      now: string,
      originMs: number
    ) => {
      const pending = pendingStreamChunksRef.current;
      const existing = pending.get(sid);
      if (existing && existing.kind !== kind) {
        // Phase transition (thinking -> assistant or vice versa): flush previous kind first
        flushPendingStreamChunks(sid);
      }
      const cur = pending.get(sid);
      if (cur && cur.kind === kind) {
        cur.delta = replace ? delta : `${cur.delta}${delta}`;
        cur.replace = cur.replace || replace;
        cur.now = now;
      } else {
        pending.set(sid, { kind, delta, replace, now, originMs });
      }
      if (streamFlushTimerRef.current === null) {
        const delayMs = sid === activeSessionIdRef.current ? 24 : 120;
        streamFlushTimerRef.current = window.setTimeout(() => {
          streamFlushTimerRef.current = null;
          flushPendingStreamChunks();
        }, delayMs);
      }
    },
    [flushPendingStreamChunks]
  );

  // Shared event dispatcher for both direct Daemon `/ws` and E2EE `velo-relay` (`ChaCha20-Poly1305`)
  const processServerPayload = useCallback(
    (raw: Record<string, unknown>) => {
      if (raw.type === "models_snapshot" && Array.isArray(raw.models)) {
        setModelCatalog(raw.models as ModelOption[]);
        return;
      }
      if (raw.type === "workspaces_snapshot" && Array.isArray(raw.workspaces)) {
        const wsPaths = (raw.workspaces as string[]).map(canonicalRepoPath).filter(Boolean);
        setRepos((prev) => {
          if (wsPaths.length === 0) return [];
          const byPath = new Map<string, VeloRepo>();
          for (const cp of wsPaths) {
            const existing = prev.find((r) => canonicalRepoPath(r.path) === cp);
            const folder = cp.split("/").filter(Boolean).pop() || "workspace";
            byPath.set(cp, {
              id: repoIdFromPath(cp),
              code: existing?.code || folder.slice(0, 2).toUpperCase(),
              name: folder,
              path: cp,
              default_branch: existing?.default_branch || "main",
            });
          }
          return Array.from(byPath.values());
        });
        return;
      }
      if (raw.kind === "sessions_snapshot" && Array.isArray(raw.sessions)) {
        const normalized = raw.sessions.map((item, idx) => normalizeToVeloSession(item, idx));
        setSessions((prev) => {
          const prevById = new Map(prev.map((s) => [s.id, s]));
          const merged = normalized.map((n) => {
            const existing = prevById.get(n.id);
            if (!existing) return n;
            return {
              ...n,
              title: n.title || existing.title,
              agent_kind: n.agent_kind || existing.agent_kind,
              model: n.model || existing.model,
              model_short: n.model_short || existing.model_short,
              effort: n.effort || existing.effort,
            };
          });
          const mergedIds = new Set(merged.map((s) => s.id));
          const remainingLocal = prev.filter(
            (d) =>
              !mergedIds.has(d.id) &&
              !(normalized.length > 0 && d.id === "sess-default" && d.title === "New thread") &&
              (d.id.startsWith("sess-") || d.id.startsWith("wt-"))
          );
          return [...remainingLocal, ...merged];
        });
        if (normalized.length > 0) {
          setRepos((prev) => {
            const byPath = new Map(prev.map((r) => [canonicalRepoPath(r.path), { ...r, id: repoIdFromPath(r.path), path: canonicalRepoPath(r.path) }]));
            for (const s of normalized) {
              const cp = canonicalRepoPath(s.project_path);
              if (cp && !byPath.has(cp)) {
                const folder = cp.split("/").filter(Boolean).pop() || "workspace";
                byPath.set(cp, {
                  id: repoIdFromPath(cp),
                  code: folder.slice(0, 2).toUpperCase(),
                  name: folder,
                  path: cp,
                  default_branch: "main",
                });
              }
            }
            return Array.from(byPath.values());
          });
          if (!initialDaemonSyncedRef.current) {
            initialDaemonSyncedRef.current = true;
            setActiveId((curId) =>
              curId === "sess-default" || !curId ? normalized[0].id : curId
            );
          }
        }
        return;
      }

      if (raw.type === "cli_sessions_snapshot" && Array.isArray(raw.sessions)) {
        setE2eeCliSessions(raw.sessions as ExternalCliSessionItem[]);
        if (typeof raw.hidden_count === "number") {
          setE2eeCliHiddenCount(raw.hidden_count);
        }
        return;
      }

      if (raw.type === "cli_session_imported" && raw.ok && raw.session) {
        const imported = normalizeToVeloSession(raw.session, 0);
        setSessions((prev) => [imported, ...prev.filter((s) => s.id !== imported.id)]);
        setActiveId(imported.id);
        syncSessionEventsFromDaemon(imported.id);
        return;
      }

      if (
        (raw.type === "session_forked" || raw.type === "ssh_session_started") &&
        raw.ok &&
        raw.session
      ) {
        const created = normalizeToVeloSession(raw.session, 0);
        const cp = canonicalRepoPath(created.project_path);
        if (cp) {
          created.project_path = cp;
          created.repo_id = repoIdFromPath(cp);
          setRepos((prevRepos) => {
            if (prevRepos.some((r) => canonicalRepoPath(r.path) === cp)) return prevRepos;
            const folder = cp.split("/").filter(Boolean).pop() || "workspace";
            return [
              ...prevRepos,
              {
                id: repoIdFromPath(cp),
                code: folder.slice(0, 2).toUpperCase(),
                name: folder,
                path: cp,
                default_branch: created.branch_name || "main",
              },
            ];
          });
        }
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        setActiveId(created.id);
        syncSessionEventsFromDaemon(created.id);
        return;
      }

      if (
        raw.type === "events_page" &&
        typeof raw.session_id === "string" &&
        Array.isArray(raw.events)
      ) {
        const pageSid = raw.session_id;
        if (typeof raw.oldest_seq === "number") {
          setOldestSeqBySession((prev) => ({ ...prev, [pageSid]: raw.oldest_seq as number }));
        }
        setHasMoreHistoryBySession((prev) => ({
          ...prev,
          [pageSid]: Boolean(raw.has_more),
        }));
        const parsedPage = reconstructEventsFromHistory(
          pageSid,
          raw.events as Array<Record<string, unknown>>
        );
        if (parsedPage.length > 0) {
          setEventsBySession((prev) => {
            const cur = prev[pageSid] || [];
            if (cur.length === 0) {
              return { ...prev, [pageSid]: parsedPage };
            }
            const headKeys = new Set(
              cur.slice(0, 10).map((e) => `${e.timestamp}|${e.content.slice(0, 64)}`)
            );
            const deduped = parsedPage.filter(
              (e) => !headKeys.has(`${e.timestamp}|${e.content.slice(0, 64)}`)
            );
            return deduped.length > 0 ? { ...prev, [pageSid]: [...deduped, ...cur] } : prev;
          });
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
      const frameSeq =
        raw.kind === "event" && typeof raw.seq === "number" ? (raw.seq as number) : undefined;
      const evObj =
        raw.kind === "event" && raw.event && typeof raw.event === "object"
          ? (raw.event as Record<string, unknown>)
          : raw;

      const evType = String(evObj.type ?? "");
      const sid = String(evObj.session_id ?? "");
      if (!sid) return;

      // Advance authoritative SQLite cursor from WS events so focus resync hits `unchanged: true`,
      // and ignore stale persisted WS frames that were already superseded by a newer HTTP sync.
      if (frameSeq !== undefined) {
        const prevMeta = eventsMetaBySessionRef.current[sid];
        const prevNewest = prevMeta?.newestSeq ?? null;
        if (
          prevNewest !== null &&
          frameSeq <= prevNewest &&
          evType !== "status_changed" &&
          evType !== "usage_updated"
        ) {
          return;
        }
        if (prevNewest === null || frameSeq > prevNewest) {
          const parsedEvTs =
            typeof evObj.timestamp === "string" ? new Date(evObj.timestamp).getTime() : NaN;
          eventsMetaBySessionRef.current[sid] = {
            newestSeq: frameSeq,
            eventCount: (prevMeta?.eventCount ?? 0) + 1,
            latestTsMs: Number.isNaN(parsedEvTs) ? Date.now() : parsedEvTs,
          };
        }
      }

      // Preserve strict ordering: flush any buffered streaming chunks for this session
      // before applying lifecycle, tool, final delta, or error events.
      if (evType !== "thinking_chunk" && evType !== "message_chunk") {
        flushPendingStreamChunks(sid);
      }

      if (evType === "user_message") {
        delete ttftRecordedBySessionRef.current[sid];
        const text = String(evObj.text ?? "").trim();
        const imgs = Array.isArray(evObj.images) ? evObj.images.map(String).filter(Boolean) : [];
        const clientMsgId =
          typeof evObj.client_msg_id === "string" && evObj.client_msg_id.trim()
            ? evObj.client_msg_id.trim()
            : undefined;
        if (!text && imgs.length === 0) return;
        const parsedTs =
          typeof evObj.timestamp === "string" ? new Date(evObj.timestamp).getTime() : NaN;
        const turnOriginMs = Number.isNaN(parsedTs) ? Date.now() : parsedTs;
        const serverTsLabel = Number.isNaN(parsedTs)
          ? now
          : new Date(parsedTs).toLocaleTimeString([], { hour12: false });
        turnStartMsRef.current[sid] = turnOriginMs;
        stepStartMsRef.current[sid] = turnOriginMs;
        delete streamOutCharsRef.current[sid];
        // Reset per-turn timing immediately so messages sent from iOS NEVER accumulate the previous turn's duration!
        setTurnTimingBySession((prev) => ({
          ...prev,
          [sid]: {
            startedAtMs: turnOriginMs,
            bootStage: "spawned",
          },
        }));
        setSessions((prev) => {
          if (!prev.some((s) => s.id === sid)) {
            refreshSessions();
          }
          return prev;
        });
        setEventsBySession((prev) => {
          const list = prev[sid] || [];
          // 1. Deterministic correlation via client_msg_id across full session history
          if (clientMsgId) {
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i].kind === "user" && list[i].client_msg_id === clientMsgId) {
                const next = [...list];
                next[i] = {
                  ...next[i],
                  id: `u-sync-${frameSeq ?? Date.now()}`,
                  timestamp: serverTsLabel,
                  seq: frameSeq ?? next[i].seq,
                  images: imgs.length > 0 ? imgs : next[i].images,
                };
                return { ...prev, [sid]: next };
              }
            }
          }
          // 2. Fallback: match unconfirmed optimistic bubble (`u-local-*`) within recent 20 events
          for (let i = list.length - 1; i >= Math.max(0, list.length - 20); i--) {
            if (
              list[i].kind === "user" &&
              list[i].id.startsWith("u-local-") &&
              list[i].content.trim() === text
            ) {
              const next = [...list];
              next[i] = {
                ...next[i],
                id: `u-sync-${frameSeq ?? Date.now()}`,
                timestamp: serverTsLabel,
                client_msg_id: clientMsgId ?? next[i].client_msg_id,
                seq: frameSeq ?? next[i].seq,
                images: imgs.length > 0 ? imgs : next[i].images,
              };
              return { ...prev, [sid]: next };
            }
          }
          return {
            ...prev,
            [sid]: [
              ...list,
              {
                id: `u-ws-${frameSeq ?? Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                session_id: sid,
                timestamp: serverTsLabel,
                kind: "user",
                content: text,
                images: imgs.length > 0 ? imgs : undefined,
                client_msg_id: clientMsgId,
                seq: frameSeq,
              },
            ],
          };
        });
        scrollChatToBottom(true);
        return;
      }

      if (evType === "permission_requested") {
        if (sid && sid !== activeSessionIdRef.current) {
          setUnreadSessionIds((prev) => ({ ...prev, [sid]: true }));
        }
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
        if (sid && sid !== activeSessionIdRef.current) {
          setUnreadSessionIds((prev) => ({ ...prev, [sid]: true }));
        }
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

      // Record Time-To-First-Token (TTFT) once per turn without triggering updater churn on every chunk
      if (
        !ttftRecordedBySessionRef.current[sid] &&
        (evType === "thinking_chunk" ||
          evType === "thinking_delta" ||
          evType === "tool_call_requested" ||
          evType === "message_chunk" ||
          evType === "message_delta")
      ) {
        ttftRecordedBySessionRef.current[sid] = true;
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
        const parsedStatusTs =
          typeof evObj.timestamp === "string" ? new Date(evObj.timestamp).getTime() : NaN;
        const statusTsMs = Number.isNaN(parsedStatusTs) ? Date.now() : parsedStatusTs;
        if (st === "running") {
          const pidMatch = statusMsg.match(/PID\s+(?:Some\()?(\d+)/i);
          const parsedPid = pidMatch ? Number(pidMatch[1]) : undefined;
          if (!turnStartMsRef.current[sid]) {
            turnStartMsRef.current[sid] = statusTsMs;
          }
          if (!stepStartMsRef.current[sid]) {
            stepStartMsRef.current[sid] = turnStartMsRef.current[sid];
          }
          setTurnTimingBySession((prev) => {
            const cur = prev[sid];
            const isFreshTurn = !cur || cur.durationMs !== undefined;
            const freshStart = turnStartMsRef.current[sid] || statusTsMs;
            return {
              ...prev,
              [sid]: {
                startedAtMs: isFreshTurn ? freshStart : cur.startedAtMs || freshStart,
                ttftMs: isFreshTurn ? undefined : cur.ttftMs,
                bootStage: !isFreshTurn && cur.bootStage === "bound" ? "bound" : "spawned",
                agentPid: parsedPid ?? cur?.agentPid,
                providerThreadShort: cur?.providerThreadShort,
                liveTps: isFreshTurn ? undefined : cur.liveTps,
              },
            };
          });
        } else if (st === "completed" || st === "failed" || st === "stopped") {
          const nowDoneMs = statusTsMs;
          const startedAtMs = turnStartMsRef.current[sid] || nowDoneMs - 1000;
          const stepOriginMs = stepStartMsRef.current[sid] || startedAtMs;
          delete turnStartMsRef.current[sid];
          delete stepStartMsRef.current[sid];
          delete streamOutCharsRef.current[sid];
          const computedDur = Math.max(500, nowDoneMs - startedAtMs);
          setTurnTimingBySession((prev) => {
            const cur = prev[sid];
            const sMs =
              cur && cur.durationMs === undefined && cur.startedAtMs
                ? cur.startedAtMs
                : startedAtMs;
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
        if (st === "completed" || st === "failed") {
          if (sid && sid !== activeSessionIdRef.current) {
            setUnreadSessionIds((prev) => ({ ...prev, [sid]: true }));
          }
          if (st === "completed") {
            refreshSessionDiffAndFiles(sid);
          }
          syncSessionEventsFromDaemon(sid);
          if (sid === activeSessionIdRef.current) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                nudgeWebKitScrollRepaint(chatScrollRef.current, isPinnedToBottomRef.current);
              });
            });
          }
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
        enqueueStreamChunk(sid, "thinking", delta, replace, now, originMs);
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
        const inTok = Number(evObj.input_tokens ?? 0);
        const outTok = Number(evObj.output_tokens ?? 0);
        const totalTok = Number(evObj.total_tokens ?? 0) || inTok + outTok;
        const cacheRead = Number(evObj.cache_read_tokens ?? 0);
        const ctxWin = Number(evObj.context_window ?? 0);
        const costDelta = Number(evObj.cost_usd ?? 0);
        const outTps = Number(evObj.output_tps ?? 0);
        if (outTps >= 0.5) {
          setTurnTimingBySession((prev) => {
            const cur = prev[sid] || { startedAtMs: Date.now() };
            return { ...prev, [sid]: { ...cur, liveTps: outTps } };
          });
        }
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  tokens_used: totalTok > 0 ? totalTok : s.tokens_used,
                  input_tokens: inTok > 0 ? inTok : s.input_tokens,
                  output_tokens: outTok > 0 ? Math.max(s.output_tokens || 0, outTok) : s.output_tokens,
                  cache_read_tokens: cacheRead > 0 ? cacheRead : s.cache_read_tokens,
                  tokens_limit: ctxWin > 0 ? ctxWin : s.tokens_limit,
                  cost_usd: costDelta > 0 ? Math.max(s.cost_usd || 0, costDelta) : s.cost_usd,
                }
              : s
          )
        );
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
          if (lastUserIdx === -1) return prev;
          const next = [...list];
          next[lastUserIdx] = {
            ...next[lastUserIdx],
            tps: outTps >= 0.5 ? outTps : next[lastUserIdx].tps,
            input_tokens: inTok || next[lastUserIdx].input_tokens,
            output_tokens: outTok || next[lastUserIdx].output_tokens,
            cache_read_tokens: cacheRead || next[lastUserIdx].cache_read_tokens,
            cost_usd: costDelta || next[lastUserIdx].cost_usd,
          };
          return { ...prev, [sid]: next };
        });
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
        enqueueStreamChunk(sid, "assistant", delta, replace, now, originMs);
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
          let turnStart = 0;
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].kind === "user") {
              turnStart = i + 1;
              break;
            }
          }
          const streamingIdx = (() => {
            for (let i = list.length - 1; i >= turnStart; i--) {
              if (list[i].kind === "assistant" && list[i].is_streaming_chunk) return i;
            }
            return -1;
          })();
          if (streamingIdx !== -1) {
            const next = [...list];
            next[streamingIdx] = {
              ...next[streamingIdx],
              content: text,
              is_streaming_chunk: false,
            };
            return { ...prev, [sid]: next };
          }
          for (let i = list.length - 1; i >= turnStart; i--) {
            if (list[i].kind !== "assistant") continue;
            const fold = foldAssistantProjection(list[i].content, text);
            if (fold === "distinct") continue;
            if (fold === "previous") return prev;
            const toolAfter = list.slice(i + 1).some((entry) => entry.kind === "tool_call");
            if (toolAfter) {
              const without = list.filter((_, idx) => idx !== i);
              return {
                ...prev,
                [sid]: [
                  ...without,
                  {
                    id: `as-${nowMsgMs}-${Math.random().toString(36).slice(2, 5)}`,
                    session_id: sid,
                    timestamp: now,
                    kind: "assistant" as const,
                    content: text,
                    is_streaming_chunk: false,
                  },
                ],
              };
            }
            const next = [...list];
            next[i] = { ...next[i], content: text, is_streaming_chunk: false };
            return { ...prev, [sid]: next };
          }
          let targetIdx = -1;
          for (let i = list.length - 1; i >= turnStart; i--) {
            if (list[i].kind === "tool_call") break;
            if (list[i].kind === "assistant") {
              targetIdx = i;
              break;
            }
          }
          if (targetIdx !== -1) {
            const existing = list[targetIdx];
            const next = [...list];
            next[targetIdx] = {
              ...existing,
              content: `${existing.content}\n\n${text}`.trim(),
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
        setEventsBySession((prev) => {
          const list = prev[sid] || [];
          const prevItem = list[list.length - 1];
          if (prevItem && prevItem.id.startsWith("err-")) {
            return prev;
          }
          return {
            ...prev,
            [sid]: [
              ...list,
              {
                id: `err-${Date.now()}`,
                session_id: sid,
                timestamp: now,
                kind: "assistant",
                content: `⚠️ ${errText}`,
              },
            ],
          };
        });
        scrollChatToBottom(false);
      }
    },
    [
      daemonUrl,
      enqueueStreamChunk,
      flushPendingStreamChunks,
      refreshSessionDiffAndFiles,
      refreshSessions,
      scrollChatToBottom,
      syncSessionEventsFromDaemon,
      nudgeWebKitScrollRepaint,
    ]
  );

  // Subscribe to live WebSocket events with automatic reconnect across daemon restarts
  useEffect(() => {
    const wsUrl = `${daemonUrl.replace(/^http/, "ws")}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let unmounted = false;

    const connectWs = () => {
      if (unmounted) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          if (unmounted) return;
          directWsConnectedRef.current = true;
          setConnected(true);
          refreshSessions();
          syncSessionEventsFromDaemon(activeSessionIdRef.current);
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
          if (unmounted) return;
          setConnected(
            Boolean(e2eeWsRef.current && e2eeWsRef.current.readyState === WebSocket.OPEN)
          );
          reconnectTimer = window.setTimeout(connectWs, 1500);
        };
      } catch {
        directWsConnectedRef.current = false;
        setConnected(false);
        reconnectTimer = window.setTimeout(connectWs, 2000);
      }
    };

    connectWs();
    return () => {
      unmounted = true;
      directWsConnectedRef.current = false;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [daemonUrl, wsReconnectNonce, processServerPayload, refreshSessions, syncSessionEventsFromDaemon]);

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
        setRepoFolderState((prev) => ({ ...prev, [canonicalRepoPath(targetRepo.path) || targetRepo.id]: "open" }));
        setActiveId(existingEmpty.id);
        setActiveModal(null);
        setTimeout(() => composerTextareaRef.current?.focus(), 20);
        return;
      }

      const branch = targetRepo.default_branch || "main";
      const newId = `wt-${Date.now()}`;
      const lastPref = readLastModelPref();
      const freshSession: VeloSession = {
        id: newId,
        repo_id: targetRepo.id,
        title: "New thread",
        agent_kind: lastPref?.agent_kind || activeSession.agent_kind || "claude",
        model: lastPref?.model || activeSession.model || "claude-fable-5-2",
        model_short: lastPref?.model_short || activeSession.model_short || "Fable 5.2",
        effort: lastPref?.effort || activeSession.effort || "medium",
        status: "idle",
        branch_name: branch,
        worktree_path: targetRepo.path,
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
      setRepoFolderState((prev) => ({ ...prev, [canonicalRepoPath(targetRepo.path) || targetRepo.id]: "open" }));
      setActiveId(newId);
      setActiveModal(null);
      setTimeout(() => composerTextareaRef.current?.focus(), 20);
    },
    [activeRepo, activeSession, eventsBySession, sessions]
  );

  const stopSessionRef = useRef<() => void>(() => {});
  const sessionHistoryRef = useRef<{ ids: string[]; idx: number; navigating: boolean }>({
    ids: [],
    idx: -1,
    navigating: false,
  });

  useEffect(() => {
    if (!activeId || activeId === "draft-empty") return;
    const h = sessionHistoryRef.current;
    if (h.navigating) {
      h.navigating = false;
      return;
    }
    if (h.ids[h.idx] === activeId) return;
    const trimmed = h.ids.slice(0, h.idx + 1);
    trimmed.push(activeId);
    if (trimmed.length > 40) trimmed.shift();
    h.ids = trimmed;
    h.idx = trimmed.length - 1;
  }, [activeId]);

  // Global Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "]")) {
        const h = sessionHistoryRef.current;
        const delta = e.key === "[" ? -1 : 1;
        let targetIdx = h.idx + delta;
        while (targetIdx >= 0 && targetIdx < h.ids.length) {
          const candId = h.ids[targetIdx];
          const found = sessionsLatestRef.current.find((s) => s.id === candId && !s.archived);
          if (found) {
            e.preventDefault();
            h.idx = targetIdx;
            h.navigating = true;
            const folderKey = canonicalRepoPath(found.project_path || found.worktree_path) || found.repo_id;
            if (folderKey) {
              setRepoFolderState((prev) => (prev[folderKey] === "open" ? prev : { ...prev, [folderKey]: "open" }));
            }
            setActiveId(found.id);
            return;
          }
          targetIdx += delta;
        }
        return;
      }
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
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        if (!activeModal) {
          e.preventDefault();
          setChatFindOpen(true);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setActiveModal((m) => (m === "settings" ? null : "settings"));
      } else if (e.key === "Escape") {
        if (activeModal) setActiveModal(null);
        else if (chatFindOpen) {
          setChatFindOpen(false);
          setChatFindQuery("");
        } else if (slashFilter !== null) setSlashFilter(null);
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
    chatFindOpen,
    drawerOpen,
    slashFilter,
    modelPickerOpen,
    effortPickerOpen,
    handleQuickNewThread,
  ]);

  const openDiffForFile = (filePath?: string) => {
    if (filePath) {
      const cleaned = filePath.replace(/^["'`]|["'`]$/g, "").trim();
      const base = cleaned.split("/").pop() || cleaned;
      const matched =
        activeDiffFiles.find((f) => f.path === cleaned) ||
        activeDiffFiles.find((f) => cleaned.endsWith(f.path) || f.path.endsWith(cleaned)) ||
        activeDiffFiles.find((f) => cleaned.includes(f.path) || f.path.includes(cleaned)) ||
        activeDiffFiles.find((f) => (f.path.split("/").pop() || f.path) === base);
      if (matched) {
        pendingDiffTargetPathRef.current = null;
        setSelectedDiffPath(matched.path);
      } else {
        pendingDiffTargetPathRef.current = cleaned;
      }
    }
    if (activeDiffFiles.length === 0 || (filePath && pendingDiffTargetPathRef.current)) {
      refreshSessionDiffAndFiles(activeSession.id);
    }
    setDrawerTab("diff");
    setDrawerOpen(true);
  };

  // Debounced `@` workspace file mention search (respects .gitignore & prioritizes Git modified files)
  useEffect(() => {
    if (fileMentionQuery === null) {
      setFileMentionResults([]);
      setFileMentionIdx(0);
      return;
    }
    const ws = canonicalRepoPath(activeSession.project_path || activeRepo.path);
    if (!ws) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const qs = new URLSearchParams({
        workspace: ws,
        q: fileMentionQuery,
        limit: "24",
      });
      fetch(`${daemonUrl}/api/workspaces/files?${qs.toString()}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return;
          if (Array.isArray(d?.files)) {
            setFileMentionResults(d.files as WorkspaceFileMentionItem[]);
            setFileMentionIdx(0);
          }
        })
        .catch(() => {});
    }, 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileMentionQuery, activeSession.project_path, activeRepo.path, daemonUrl]);

  const handleSelectFileMention = useCallback(
    (item: WorkspaceFileMentionItem) => {
      const originSid = activeSessionIdRef.current;
      setPendingAttachments((prev) => {
        if (prev.some((a) => a.path === item.abs_path)) return prev;
        return [
          ...prev,
          {
            filename: item.name,
            displayName: item.path,
            relPath: item.path,
            path: item.abs_path,
            url: "",
            isImage: false,
            size: item.size,
          },
        ];
      }, originSid);
      setPrompt((cur) => cur.replace(/(^|\s)@[^\s@]*$/, "$1"), originSid);
      setFileMentionQuery(null);
      setTimeout(() => composerTextareaRef.current?.focus(), 10);
    },
    [setPendingAttachments, setPrompt]
  );

  // Composer live keystroke handler (ZERO App re-renders on normal typing!)
  // Only touches React state when empty<->non-empty flips or `/` / `@` popover triggers change.
  const handleComposerLiveChange = useCallback(
    (sid: string, val: string) => {
      if (!val) {
        delete draftsLatestRef.current[sid];
      } else {
        draftsLatestRef.current[sid] = val;
      }
      scheduleDraftStoragePersist();

      if (sid === activeSessionIdRef.current) {
        const nextHas = Boolean(val.trim());
        if (nextHas !== hasComposerTextRef.current) {
          hasComposerTextRef.current = nextHas;
          setHasComposerText(nextHas);
        }
      }

      // Check `@file` mention at end of input (at start or after whitespace)
      const mentionMatch = val.match(/(?:^|\s)@([^\s@]*)$/);
      if (mentionMatch) {
        setFileMentionQuery(mentionMatch[1] ?? "");
        setSlashFilter((prev) => (prev === null ? prev : null));
        return;
      } else {
        setFileMentionQuery((prev) => (prev === null ? prev : null));
      }

      if (!val.startsWith("/")) {
        setSlashFilter((prev) => (prev === null ? prev : null));
        return;
      }
      const body = val.slice(1);
      // Once a skill or slash command is followed by whitespace (user is now typing the task body),
      // close the slash popover unless the typed text is still a prefix of a multi-word skill name.
      if (/\s/.test(body)) {
        const lower = body.toLowerCase();
        const stillCompletingMultiWordSkill =
          !matchSkillInvocation(val, localSkills) &&
          localSkills.some((sk) => sk.name.trim().toLowerCase().startsWith(lower));
        if (!stillCompletingMultiWordSkill) {
          setSlashFilter((prev) => (prev === null ? prev : null));
          return;
        }
      }
      setSlashFilter(body.toLowerCase());
      setSlashSelectedIdx(0);
    },
    [localSkills, scheduleDraftStoragePersist]
  );

  const resolveAttachmentUrl = useCallback(
    (imgRef: string): string => {
      if (!imgRef) return "";
      if (imgRef.startsWith("http://") || imgRef.startsWith("https://") || imgRef.startsWith("data:")) {
        return imgRef;
      }
      if (imgRef.startsWith("/api/attachments/")) {
        return `${daemonUrl}${imgRef}`;
      }
      if (imgRef.startsWith("/") || imgRef.startsWith("file://") || imgRef.startsWith("~/")) {
        return `${daemonUrl}/api/attachments-resolve?ref=${encodeURIComponent(imgRef)}`;
      }
      const basename = imgRef.split("/").pop() || imgRef;
      return `${daemonUrl}/api/attachments/${basename}`;
    },
    [daemonUrl]
  );

  const handleUploadImageFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter((f) => f && f.size <= 35 * 1024 * 1024);
      if (files.length === 0) return;
      const originSid = activeSessionIdRef.current;
      setUploadingAttachment(true);
      try {
        for (const file of files) {
          const isImg =
            file.type.startsWith("image/") ||
            /\.(png|jpe?g|webp|gif|heic|svg)$/i.test(file.name || "");
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
              filename: file.name || (isImg ? "pasted-image.png" : "attached-file.txt"),
              mime_type: file.type || (isImg ? "image/png" : "application/octet-stream"),
              data_base64: dataUrl,
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              filename: string;
              original_name?: string;
              is_image?: boolean;
              path: string;
              url: string;
              size?: number;
            };
            const finalIsImg = data.is_image !== undefined ? data.is_image : isImg;
            setPendingAttachments(
              (prev) => [
                ...prev,
                {
                  filename: data.filename,
                  displayName: data.original_name || file.name || data.filename,
                  path: data.path,
                  url: `${daemonUrl}${data.url}`,
                  isImage: finalIsImg,
                  size: data.size ?? file.size,
                },
              ],
              originSid
            );
          }
        }
      } catch {
        // ignore upload failure
      } finally {
        setUploadingAttachment(false);
      }
    },
    [daemonUrl, setPendingAttachments]
  );

  const handleRemoveQueuedPrompt = useCallback(
    async (queueId: string) => {
      const sid = activeSession.id;
      const item = (activeSession.queued_prompts || []).find((q) => q.id === queueId);
      if (queueId.startsWith("q-local-")) {
        queuedIntentRef.current.set(queueId, "drop");
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid
            ? { ...s, queued_prompts: (s.queued_prompts || []).filter((q) => q.id !== queueId) }
            : s
        )
      );
      const query =
        queueId.startsWith("q-local-") && item?.input
          ? `?input=${encodeURIComponent(item.input)}`
          : "";
      try {
        await fetch(
          `${daemonUrl}/api/sessions/${sid}/queue/${encodeURIComponent(queueId)}${query}`,
          { method: "DELETE" }
        );
      } catch {
        sendE2eeCommand({
          cmd: "remove_queued_prompt",
          session_id: sid,
          queue_id: queueId,
          input: item?.input,
        });
      }
    },
    [activeSession.id, activeSession.queued_prompts, daemonUrl]
  );

  // Register global hooks for macOS Menu Bar Status Item (`VeloApp.swift`)
  useEffect(() => {
    const w = window as unknown as {
      __veloOpenCliImport?: () => void;
      __veloOpenPairModal?: () => void;
      __veloSelectSession?: (sid: string) => void;
    };
    w.__veloOpenCliImport = () => setCliImportOpen(true);
    w.__veloOpenPairModal = () => {
      fetchPairTicket();
      setActiveModal("qr");
    };
    w.__veloSelectSession = (sid: string) => {
      if (sid) {
        const target = sessionsLatestRef.current.find((s) => s.id === sid);
        if (target) {
          const folderKey =
            canonicalRepoPath(target.project_path || target.worktree_path) || target.repo_id;
          if (folderKey) {
            setRepoFolderState((prev) =>
              prev[folderKey] === "open" ? prev : { ...prev, [folderKey]: "open" }
            );
          }
        }
        setActiveId(sid);
        syncSessionEventsFromDaemon(sid);
      }
    };
    return () => {
      delete w.__veloOpenCliImport;
      delete w.__veloOpenPairModal;
      delete w.__veloSelectSession;
    };
  }, [fetchPairTicket, syncSessionEventsFromDaemon]);

  const handleSendPrompt = async (
    customText?: string,
    overridePriorEvents?: AgentEvent[],
    truncateToUserTurn?: number,
    overrideImages?: string[],
    executionMode?: "queue" | "steer",
    preserveComposer?: boolean
  ) => {
    const attachedPaths =
      overrideImages !== undefined
        ? overrideImages
        : pendingAttachments.filter((a) => a.isImage !== false).map((a) => a.path);
    const attachedNonImageFiles =
      overrideImages !== undefined
        ? []
        : pendingAttachments.filter((a) => a.isImage === false);
    const rawTyped = (
      customText ??
      (draftsLatestRef.current[activeSession.id] ?? "")
    ).trim();
    if (!rawTyped && attachedPaths.length === 0 && attachedNonImageFiles.length === 0) return;

    const filesBlock =
      attachedNonImageFiles.length > 0
        ? `[Referenced Files]\n${attachedNonImageFiles
            .map((f) => `- ${f.path}`)
            .join("\n")}`
        : "";
    const baseText =
      rawTyped ||
      (attachedNonImageFiles.length > 0
        ? "请分析并处理以上引用的文件。"
        : "Please inspect the attached image(s).");
    const rawText = filesBlock ? `${filesBlock}\n\n${baseText}` : baseText;
    const text = rawText;
    const skillPath = matchSkillInvocation(baseText, localSkills)?.path;

    if (!preserveComposer) {
      setPrompt("");
      setSlashFilter(null);
      setFileMentionQuery(null);
      if (overrideImages === undefined) {
        setPendingAttachments([]);
      }
    }

    const lowerCmd = rawText.trim().toLowerCase();
    if (lowerCmd === "/automations" || lowerCmd === "/schedule" || lowerCmd === "/定时") {
      setActiveModal("automations");
      return;
    }
    const skipSchedule = bypassScheduleInterceptRef.current;
    bypassScheduleInterceptRef.current = false;
    const isConversationalSchedule =
      !skipSchedule &&
      (lowerCmd.startsWith("/schedule ") ||
        rawText.trim().startsWith("/定时 ") ||
        /^(?:帮我定时|请定时|设个定时|创建定时任务|定时[：:])/.test(rawText.trim()));
    if (isConversationalSchedule && overridePriorEvents === undefined) {
      try {
        const res = await fetch(`${daemonUrl}/api/automations/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: rawText.trim() }),
        });
        if (res.ok) {
          const parsed = (await res.json()) as ParsedScheduleDto;
          if (parsed.ok) {
            setPendingScheduleDraft({
              rawInput: rawText.trim(),
              parsed,
              repoPath: activeSession.project_path || activeRepo.path,
              provider: activeSession.agent_kind || "claude",
              model: activeSession.model,
            });
            return;
          }
        }
      } catch {
        // fall through to opening modal if explicit /schedule command failed
      }
      if (lowerCmd.startsWith("/schedule ") || rawText.trim().startsWith("/定时 ")) {
        setActiveModal("automations");
        return;
      }
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

    if (rawText === "/import" || rawText === "/cli") {
      setCliImportOpen(true);
      return;
    }

    // Server-side Queue Mode: enqueue follow-up prompt without disturbing the running turn UI
    if (
      executionMode === "queue" &&
      (activeSession.status === "running" || activeSession.status === "waiting_approval")
    ) {
      const optimisticQueueItem = {
        id: `q-local-${Date.now()}`,
        input: text,
        images: attachedPaths,
        model: activeSession.model,
        effort: activeSession.effort || "medium",
      };
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSession.id
            ? { ...s, queued_prompts: [...(s.queued_prompts || []), optimisticQueueItem] }
            : s
        )
      );
      try {
        const qRes = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: text,
            model: activeSession.model,
            effort: activeSession.effort || "medium",
            images: attachedPaths,
            mode: "queue",
            skill_path: skillPath ?? null,
          }),
        });
        if (qRes.ok) {
          const queuedBody = (await qRes.json().catch(() => null)) as {
            item?: { id?: string };
          } | null;
          const realId = queuedBody?.item?.id;
          const intent = queuedIntentRef.current.get(optimisticQueueItem.id);
          if (intent) {
            queuedIntentRef.current.delete(optimisticQueueItem.id);
            if (realId) {
              await fetch(
                `${daemonUrl}/api/sessions/${activeSession.id}/queue/${encodeURIComponent(realId)}`,
                { method: "DELETE" }
              ).catch(() => {});
            }
            refreshSessions();
            return;
          }
          if (realId) {
            setSessions((prev) =>
              prev.map((s) =>
                s.id === activeSession.id
                  ? {
                      ...s,
                      queued_prompts: (s.queued_prompts || []).map((q) =>
                        q.id === optimisticQueueItem.id ? { ...q, id: realId } : q
                      ),
                    }
                  : s
              )
            );
          }
          refreshSessions();
          return;
        }
      } catch {
        // fallback to E2EE
      }
      sendE2eeCommand({
        cmd: "send_input",
        session_id: activeSession.id,
        input: text,
        model: activeSession.model,
        effort: activeSession.effort || "medium",
        images: attachedPaths,
        mode: "queue",
        skill_path: skillPath,
      });
      return;
    }

    const now = new Date().toLocaleTimeString([], { hour12: false });
    const baseEvents = overridePriorEvents ?? (eventsBySession[activeSession.id] || []);
    const clientMsgId = `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userEv: AgentEvent = {
      id: `u-local-${clientMsgId}`,
      session_id: activeSession.id,
      timestamp: now,
      kind: "user",
      content: text,
      images: attachedPaths.length > 0 ? attachedPaths : undefined,
      client_msg_id: clientMsgId,
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

    if (rawText === "/analytics" || rawText === "/billing") {
      setAnalyticsInitialTab("analytics");
      setAnalyticsModalOpen(true);
      return;
    }

    if (rawText.startsWith("/search")) {
      setAnalyticsInitialTab("search");
      setAnalyticsModalOpen(true);
      return;
    }

    // Real Daemon /handoff endpoint
    if (rawText.startsWith("/handoff")) {
      const rest = rawText.replace("/handoff", "").trim();
      const [firstToken, ...moreTokens] = rest.split(/\s+/);
      const knownTargets = ["claude", "codex", "agy", "grok", "cursor"];
      const targetProv =
        firstToken && knownTargets.includes(firstToken.toLowerCase())
          ? firstToken.toLowerCase()
          : activeSession.agent_kind === "codex"
          ? "claude"
          : "codex";
      const extraNote =
        firstToken && knownTargets.includes(firstToken.toLowerCase())
          ? moreTokens.join(" ").trim() || null
          : rest || null;
      try {
        const res = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/handoff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target_provider: targetProv,
            additional_instructions: extraNote,
          }),
        });
        if (res.ok) {
          const rawNew = await res.json();
          const created = normalizeToVeloSession(rawNew, 0);
          created.repo_id = activeSession.repo_id;
          setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
          setActiveId(created.id);
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
    const resolvedModelId = activeCatalogModel?.id || activeSession.model;
    const resolvedEffortValue =
      activeSupportedEfforts.length > 0 ? activeEffectiveEffort : undefined;

    try {
      // 1. Send clean user input to existing daemon session (uses native `codex exec resume` / `claude --resume` or ACP session/load)
      const inputRes = await fetch(`${daemonUrl}/api/sessions/${activeSession.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          model: resolvedModelId,
          effort: resolvedEffortValue,
          provider: providerName,
          approval_mode: activeSession.approval_mode,
          truncate_to_user_turn: truncateToUserTurn,
          reset_thread: truncateToUserTurn !== undefined,
          images: attachedPaths,
          mode: executionMode ?? null,
          skill_path: skillPath ?? null,
          client_msg_id: clientMsgId,
        }),
      });

      if (inputRes.ok) {
        scrollChatToBottom(true);
        return;
      }

      // 2. If activeSession was a local thread not yet on the daemon, promote it to a real daemon session
      const wantsIsolatedWorktree =
        activeSession.worktree_path !== activeSession.project_path &&
        activeSession.worktree_path.includes("/.velo/worktrees/");
      const createRes = await fetch(`${daemonUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nextTitle,
          provider: providerName,
          prompt: priorHistory.length > 0 ? promptWithContext : text,
          repo_path: activeRepo.path || "~/velo",
          branch: wantsIsolatedWorktree ? activeSession.branch_name : null,
          use_pty: false,
          model: resolvedModelId,
          effort: resolvedEffortValue,
          approval_mode: activeSession.approval_mode,
          images: attachedPaths,
          use_worktree: wantsIsolatedWorktree,
          client_msg_id: clientMsgId,
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
          skill_path: skillPath,
          client_msg_id: clientMsgId,
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

  const handleRunQueuedNow = async (queueId: string) => {
    const sid = activeSession.id;
    const item = (activeSession.queued_prompts || []).find((q) => q.id === queueId);
    if (!item || !sid) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sid
          ? { ...s, queued_prompts: (s.queued_prompts || []).filter((q) => q.id !== queueId) }
          : s
      )
    );
    if (queueId.startsWith("q-local-")) {
      queuedIntentRef.current.set(queueId, "run");
      await handleSendPrompt(item.input, undefined, undefined, item.images || [], "steer", true);
      return;
    }
    try {
      const res = await fetch(
        `${daemonUrl}/api/sessions/${sid}/queue/${encodeURIComponent(queueId)}/run`,
        { method: "POST" }
      );
      if (res.ok) {
        refreshSessions();
        syncSessionEventsFromDaemon(sid);
        return;
      }
    } catch {
      sendE2eeCommand({
        cmd: "run_queued_prompt",
        session_id: sid,
        queue_id: queueId,
      });
      return;
    }
    await fetch(`${daemonUrl}/api/sessions/${sid}/queue/${encodeURIComponent(queueId)}`, {
      method: "DELETE",
    }).catch(() => {});
    await handleSendPrompt(item.input, undefined, undefined, item.images || [], "steer", true);
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

  // Soft-archive or restore a thread while preserving all commits, worktree & event history
  const handleArchiveSession = async (
    sessionId: string,
    archived: boolean,
    e?: React.MouseEvent
  ) => {
    e?.stopPropagation();
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === sessionId ? { ...s, archived } : s));
      if (archived && activeSession.id === sessionId) {
        const nextActive = next.find((s) => !s.archived && s.id !== sessionId);
        setActiveId(nextActive ? nextActive.id : "");
      }
      return next;
    });
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!res.ok) {
        sendE2eeCommand({ cmd: "archive_session", session_id: sessionId, archived });
      }
    } catch {
      sendE2eeCommand({ cmd: "archive_session", session_id: sessionId, archived });
    }
  };

  // Open the Fork Launch Modal so user can keep current model (Enter) or switch engine/model in 1 step
  const handleForkSession = (
    upToUserTurn?: number,
    upToUserText?: string,
    userTurnsFromEnd?: number
  ) => {
    const sid = activeSession.id;
    if (!sid || sid === "draft-empty") return;
    setForkLaunchTarget({
      sourceSessionId: sid,
      sourceTitle: activeSession.title || "Session",
      repoRoot: canonicalRepoPath(activeSession.project_path || activeRepo.path),
      currentModel: activeSession.model,
      currentEffort: activeSession.effort || "medium",
      currentAgentKind: activeSession.agent_kind,
      upToUserTurn,
      upToUserText,
      userTurnsFromEnd,
    });
  };

  const handleConfirmForkBranch = async (payload: ForkConfirmPayload) => {
    if (!forkLaunchTarget) return;
    const target = forkLaunchTarget;
    const sid = target.sourceSessionId;
    setForkLaunchTarget(null);

    const ensureRepoRegistered = (forked: VeloSession) => {
      const cp = canonicalRepoPath(forked.project_path);
      if (!cp) return;
      forked.project_path = cp;
      forked.repo_id = repoIdFromPath(cp);
      setRepos((prevRepos) => {
        if (prevRepos.some((r) => canonicalRepoPath(r.path) === cp)) return prevRepos;
        const folder = cp.split("/").filter(Boolean).pop() || "workspace";
        return [
          ...prevRepos,
          {
            id: repoIdFromPath(cp),
            code: folder.slice(0, 2).toUpperCase(),
            name: folder,
            path: cp,
            default_branch: forked.branch_name || "main",
          },
        ];
      });
      setRepoFolderState((prev) => ({ ...prev, [cp]: "open" }));
    };

    const reqBody = {
      up_to_user_turn: target.upToUserTurn,
      up_to_user_text: target.upToUserText,
      user_turns_from_end: target.userTurnsFromEnd,
      title: payload.title,
      provider: payload.provider,
      model: payload.model,
      effort: payload.effort,
      repo_root: payload.repoRoot,
      initial_prompt: payload.initialPrompt,
    };

    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${sid}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      if (res.ok) {
        const d = (await res.json()) as { ok?: boolean; session?: Record<string, unknown> };
        if (d.ok && d.session) {
          const forked = normalizeToVeloSession(d.session, 0);
          ensureRepoRegistered(forked);
          setSessions((prev) => [forked, ...prev.filter((s) => s.id !== forked.id)]);
          setActiveId(forked.id);
          syncSessionEventsFromDaemon(forked.id);
          refreshSessions();
          setTimeout(() => composerTextareaRef.current?.focus(), 60);
          return;
        }
      }
      sendE2eeCommand({ cmd: "fork_session", session_id: sid, ...reqBody });
    } catch {
      sendE2eeCommand({ cmd: "fork_session", session_id: sid, ...reqBody });
    }
  };

  const handleEditBackQueuedPrompt = useCallback(
    (item: { id: string; input: string }) => {
      void handleRemoveQueuedPrompt(item.id);
      setPrompt((cur) => (cur.trim() ? `${cur}\n${item.input}` : item.input));
      setTimeout(() => composerTextareaRef.current?.focus(), 20);
    },
    [handleRemoveQueuedPrompt, setPrompt]
  );

  const handleReorderQueuedPrompt = useCallback(
    async (queueId: string, direction: "up" | "down") => {
      const sid = activeSession.id;
      if (!sid) return;
      // Optimistic local reorder
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          const q = [...(s.queued_prompts || [])];
          const idx = q.findIndex((item) => item.id === queueId);
          if (idx === -1) return s;
          const swapIdx = direction === "up" ? idx - 1 : idx + 1;
          if (swapIdx < 0 || swapIdx >= q.length) return s;
          [q[idx], q[swapIdx]] = [q[swapIdx], q[idx]];
          return { ...s, queued_prompts: q };
        })
      );
      try {
        await fetch(`${daemonUrl}/api/sessions/${sid}/queue/reorder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ queue_id: queueId, direction }),
        });
      } catch {
        // ignore
      }
    },
    [activeSession.id, daemonUrl]
  );

  const handleClearAllQueuedPrompts = useCallback(async () => {
    const items = activeSession.queued_prompts || [];
    for (const item of items) {
      await handleRemoveQueuedPrompt(item.id);
    }
  }, [activeSession.queued_prompts, handleRemoveQueuedPrompt]);

  const handleJumpToTurn = useCallback(
    (turnKey: string) => {
      setShowAllTurnsBySession((prev) =>
        prev[activeSession.id] ? prev : { ...prev, [activeSession.id]: true }
      );
      requestAnimationFrame(() => {
        const container = chatScrollRef.current;
        if (!container) return;
        const target = container.querySelector(
          `[data-turn-key="${CSS.escape(turnKey)}"]`
        ) as HTMLElement | null;
        if (target) {
          isPinnedToBottomRef.current = false;
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    },
    [activeSession.id]
  );

  // Delete / archive a thread from sidebar, daemon state, events history & isolated Git worktree
  const handleDeleteSession = async (sessionId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setDraftsBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setAttachmentsBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      if (remaining.length === 0) {
        setActiveId("");
        return [];
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

  // Remove a project workspace and its bound sessions permanently from sidebar & daemon
  const handleRemoveRepo = async (repoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const target = repos.find((r) => r.id === repoId);
    if (!target) return;
    const targetCanon = canonicalRepoPath(target.path);

    const removedSessionIds = sessions
      .filter((s) => s.repo_id === repoId || canonicalRepoPath(s.project_path) === targetCanon)
      .map((s) => s.id);

    setRepos((prev) => prev.filter((r) => r.id !== repoId && canonicalRepoPath(r.path) !== targetCanon));
    setSessions((prev) => {
      const remaining = prev.filter(
        (s) => s.repo_id !== repoId && canonicalRepoPath(s.project_path) !== targetCanon
      );
      if (
        remaining.length > 0 &&
        (activeSession.repo_id === repoId ||
          canonicalRepoPath(activeSession.project_path) === targetCanon)
      ) {
        setActiveId(remaining[0].id);
      } else if (remaining.length === 0) {
        setActiveId("");
      }
      return remaining;
    });
    if (removedSessionIds.length > 0) {
      setEventsBySession((prev) => {
        const next = { ...prev };
        for (const sid of removedSessionIds) {
          delete next[sid];
        }
        return next;
      });
    }

    try {
      const res = await fetch(`${daemonUrl}/api/workspaces`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target.path, delete_sessions: true }),
      });
      if (!res.ok) {
        sendE2eeCommand({
          cmd: "remove_workspace",
          path: target.path,
          delete_sessions: true,
        });
      }
      refreshSessions();
    } catch {
      sendE2eeCommand({
        cmd: "remove_workspace",
        path: target.path,
        delete_sessions: true,
      });
    }
  };

  // Relocate an entire workspace folder OR move an individual session to a new folder path
  const handleCommitRelocatePath = async () => {
    if (!relocateTarget) return;
    const cleanNew = canonicalRepoPath(relocateTarget.newPath.trim());
    const cleanOld = canonicalRepoPath(relocateTarget.oldPath.trim());
    if (!cleanNew) return;
    const targetSnap = relocateTarget;
    setRelocateTarget(null);

    if (targetSnap.mode === "session" && targetSnap.sessionId) {
      const sid = targetSnap.sessionId;
      const newRepoId = repoIdFromPath(cleanNew);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid
            ? {
                ...s,
                repo_id: newRepoId,
                project_path: cleanNew,
                worktree_path: s.worktree_path.includes("/.velo/worktrees/")
                  ? s.worktree_path
                  : cleanNew,
              }
            : s
        )
      );
      try {
        const res = await fetch(`${daemonUrl}/api/sessions/${sid}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo_path: cleanNew }),
        });
        if (!res.ok) {
          sendE2eeCommand({ cmd: "update_session", session_id: sid, repo_path: cleanNew });
        }
      } catch {
        sendE2eeCommand({ cmd: "update_session", session_id: sid, repo_path: cleanNew });
      }
      refreshSessions();
      return;
    }

    // Relocate entire workspace folder and all its sessions
    try {
      const res = await fetch(`${daemonUrl}/api/workspaces`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_path: cleanOld, new_path: cleanNew }),
      });
      if (!res.ok) {
        sendE2eeCommand({
          cmd: "relocate_workspace",
          old_path: cleanOld,
          new_path: cleanNew,
        });
      }
    } catch {
      sendE2eeCommand({
        cmd: "relocate_workspace",
        old_path: cleanOld,
        new_path: cleanNew,
      });
    }
    refreshSessions();
  };

  const handlePickRelocateFolder = async () => {
    try {
      const res = await fetch(`${daemonUrl}/api/pick-folder`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { path?: string };
        if (data.path) {
          setRelocateTarget((prev) => (prev ? { ...prev, newPath: data.path! } : prev));
        }
      }
    } catch {
      // ignore if cancelled
    }
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
            setRepoFolderState((prev) => ({ ...prev, [canonicalRepoPath(targetRepo.path) || targetRepo.id]: "open" }));
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
          setRepoFolderState((prev) => ({ ...prev, [canonicalRepoPath(targetRepo.path) || targetRepo.id]: "open" }));
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
          use_worktree: true,
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
        setRepoFolderState((prev) => ({ ...prev, [canonicalRepoPath(targetRepo.path) || targetRepo.id]: "open" }));
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
    setRepoFolderState((prev) => ({ ...prev, [canonicalRepoPath(targetRepo.path) || targetRepo.id]: "open" }));
    setActiveId(newId);
    setActiveModal(null);
  };

  const openAddWorkspaceModal = useCallback(
    (initialMode: "existing" | "create" = "existing") => {
      const samplePath = activeRepo?.path || repos[0]?.path || "~/code";
      const cleanSample = canonicalRepoPath(samplePath);
      const parts = cleanSample.split("/").filter(Boolean);
      const guessedParent =
        parts.length >= 2
          ? `${cleanSample.startsWith("/") ? "/" : ""}${parts.slice(0, -1).join("/")}`
          : "~/code";
      setNewFolderParent(guessedParent);
      setNewFolderName("");
      setNewRepoPath(guessedParent);
      setNewRepoMode(initialMode);
      setNewFolderInitGit(true);
      setActiveModal("new-repo");
    },
    [activeRepo, repos]
  );

  const EFFORT_DISPLAY_LABELS: Record<EffortLevel, string> = {
    none: "None",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "xHigh",
    max: "Max",
    ultra: "Ultra",
  };

  const resolveCatalogModel = useCallback(
    (modelId: string, agentKind: string): ModelOption | undefined => {
      const exact = modelCatalog.find((m) => m.id === modelId);
      if (exact) return exact;
      // Gracefully match legacy suffixed slugs like `gemini-4-neon-xhigh` or `cursor:claude-opus-5-5-high`
      const stripped = modelId.replace(/-(none|low|medium|high|xhigh|max)$/i, "");
      return (
        modelCatalog.find((m) => m.id === stripped) ||
        modelCatalog.find((m) => m.id === `agy:${stripped}` && m.agentKind === agentKind) ||
        modelCatalog.find((m) => m.agentKind === agentKind && m.isDefault)
      );
    },
    [modelCatalog]
  );

  const resolveSupportedEfforts = useCallback(
    (modelOpt: ModelOption | undefined, agentKind: string): EffortLevel[] => {
      if (modelOpt && Array.isArray(modelOpt.supportedEfforts)) {
        return modelOpt.supportedEfforts;
      }
      if (agentKind === "codex") return ["low", "medium", "high", "xhigh", "max"];
      if (agentKind === "grok") return ["low", "medium", "high", "xhigh"];
      if (agentKind === "agy") return ["low", "medium", "high"];
      if (agentKind === "cursor") return [];
      if (agentKind === "claude") return ["low", "medium", "high", "max"];
      return ["low", "medium", "high"];
    },
    []
  );

  const alignEffortForModel = useCallback(
    (
      currentEffort: EffortLevel | undefined,
      modelOpt: ModelOption | undefined,
      agentKind: string
    ): EffortLevel => {
      const supported = resolveSupportedEfforts(modelOpt, agentKind);
      if (supported.length === 0) return "medium";
      if (currentEffort && supported.includes(currentEffort)) {
        return currentEffort;
      }
      if (modelOpt?.defaultEffort && supported.includes(modelOpt.defaultEffort)) {
        return modelOpt.defaultEffort;
      }
      if (supported.includes("high")) return "high";
      if (supported.includes("medium")) return "medium";
      return supported[0];
    },
    [resolveSupportedEfforts]
  );

  const activeCatalogModel = useMemo(
    () => resolveCatalogModel(activeSession.model, activeSession.agent_kind),
    [resolveCatalogModel, activeSession.model, activeSession.agent_kind]
  );

  const activeSupportedEfforts = useMemo(
    () => resolveSupportedEfforts(activeCatalogModel, activeSession.agent_kind),
    [resolveSupportedEfforts, activeCatalogModel, activeSession.agent_kind]
  );

  const activeEffectiveEffort = useMemo(
    () => alignEffortForModel(activeSession.effort, activeCatalogModel, activeSession.agent_kind),
    [alignEffortForModel, activeSession.effort, activeCatalogModel, activeSession.agent_kind]
  );

  const handleSelectSessionEffort = useCallback(
    (eff: EffortLevel) => {
      setEffortPickerOpen(false);
      saveLastModelPref({ effort: eff });
      if (activeSession.id === "draft-empty") {
        const newId = `wt-${Date.now()}`;
        const materialized: VeloSession = {
          ...activeSession,
          id: newId,
          repo_id: activeRepo.id,
          worktree_path: activeRepo.path,
          project_path: activeRepo.path,
          effort: eff,
          updated_at: "now",
        };
        setSessions((prev) => [materialized, ...prev]);
        setEventsBySession((prev) => ({ ...prev, [newId]: [] }));
        setDraftsBySession((prev) => {
          const carried = draftsLatestRef.current["draft-empty"] ?? prev["draft-empty"];
          if (!carried) return prev;
          draftsLatestRef.current[newId] = carried;
          delete draftsLatestRef.current["draft-empty"];
          const next = { ...prev, [newId]: carried };
          delete next["draft-empty"];
          return next;
        });
        setAttachmentsBySession((prev) => {
          const carried = prev["draft-empty"];
          if (!carried || carried.length === 0) return prev;
          const next = { ...prev, [newId]: carried };
          delete next["draft-empty"];
          return next;
        });
        setActiveId(newId);
        return;
      }
      setSessions((prev) =>
        prev.map((s) => (s.id === activeSession.id ? { ...s, effort: eff } : s))
      );
      if (!activeSession.id.startsWith("wt-") && !activeSession.id.startsWith("sess-")) {
        fetch(`${daemonUrl}/api/sessions/${activeSession.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ effort: eff }),
        }).catch(() => {
          sendE2eeCommand({
            cmd: "update_session",
            session_id: activeSession.id,
            effort: eff,
          });
        });
      }
    },
    [activeRepo, activeSession, daemonUrl, sendE2eeCommand]
  );

  const handleSelectSessionModel = useCallback(
    async (m: ModelOption, isCrossEngineHandoff: boolean) => {
      setModelPickerOpen(false);
      const defaultEffortForEngine = alignEffortForModel(
        activeSession.effort,
        m,
        m.agentKind
      );
      saveLastModelPref({
        agent_kind: m.agentKind,
        model: m.id,
        model_short: m.shortLabel,
        effort: defaultEffortForEngine,
      });

      if (isCrossEngineHandoff && activeSession.id !== "draft-empty") {
        try {
          const res = await fetch(
            `${daemonUrl}/api/sessions/${activeSession.id}/handoff`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                target_provider: m.agentKind,
                model: m.id,
                effort: defaultEffortForEngine,
              }),
            }
          );
          if (res.ok) {
            const rawNew = await res.json();
            const created = normalizeToVeloSession(rawNew, 0);
            const cp = canonicalRepoPath(created.project_path || activeSession.project_path);
            created.project_path = cp;
            created.repo_id = repoIdFromPath(cp);
            created.agent_kind = m.agentKind;
            created.model = m.id;
            created.model_short = m.shortLabel;
            created.effort = defaultEffortForEngine;
            setSessions((prev) => [
              created,
              ...prev.filter((s) => s.id !== created.id),
            ]);
            setActiveId(created.id);
            syncSessionEventsFromDaemon(created.id);
            refreshSessions();
            setTimeout(() => composerTextareaRef.current?.focus(), 30);
            return;
          }
        } catch {
          // fallback to E2EE command
        }
        sendE2eeCommand({
          cmd: "handoff_session",
          session_id: activeSession.id,
          target_provider: m.agentKind,
          model: m.id,
          effort: defaultEffortForEngine,
        });
        return;
      }

      // If current view is the virtual `draft-empty` placeholder (not yet in `sessions`),
      // materialize a concrete draft thread so the selected model actually sticks!
      if (activeSession.id === "draft-empty") {
        const newId = `wt-${Date.now()}`;
        const materialized: VeloSession = {
          ...activeSession,
          id: newId,
          repo_id: activeRepo.id,
          worktree_path: activeRepo.path,
          project_path: activeRepo.path,
          agent_kind: m.agentKind,
          model: m.id,
          model_short: m.shortLabel,
          effort: defaultEffortForEngine,
          updated_at: "now",
        };
        setSessions((prev) => [materialized, ...prev]);
        setEventsBySession((prev) => ({ ...prev, [newId]: [] }));
        setDraftsBySession((prev) => {
          const carried = draftsLatestRef.current["draft-empty"] ?? prev["draft-empty"];
          if (!carried) return prev;
          draftsLatestRef.current[newId] = carried;
          delete draftsLatestRef.current["draft-empty"];
          const next = { ...prev, [newId]: carried };
          delete next["draft-empty"];
          return next;
        });
        setAttachmentsBySession((prev) => {
          const carried = prev["draft-empty"];
          if (!carried || carried.length === 0) return prev;
          const next = { ...prev, [newId]: carried };
          delete next["draft-empty"];
          return next;
        });
        setActiveId(newId);
        setTimeout(() => composerTextareaRef.current?.focus(), 20);
        return;
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSession.id
            ? {
                ...s,
                agent_kind: m.agentKind,
                model: m.id,
                model_short: m.shortLabel,
                effort: defaultEffortForEngine,
              }
            : s
        )
      );

      if (!activeSession.id.startsWith("wt-") && !activeSession.id.startsWith("sess-")) {
        fetch(`${daemonUrl}/api/sessions/${activeSession.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: m.id,
            provider: m.agentKind,
            effort: defaultEffortForEngine,
          }),
        }).catch(() => {
          sendE2eeCommand({
            cmd: "update_session",
            session_id: activeSession.id,
            model: m.id,
            provider: m.agentKind,
            effort: defaultEffortForEngine,
          });
        });
      }
      setTimeout(() => composerTextareaRef.current?.focus(), 20);
    },
    [activeRepo, activeSession, alignEffortForModel, daemonUrl, sendE2eeCommand]
  );

  const handleCreateRepo = async () => {
    const rawTarget =
      newRepoMode === "create"
        ? (() => {
            const parent = (newFolderParent.trim() || "~/code").replace(/\/+$/, "");
            const folder = newFolderName.trim().replace(/^\/+/, "");
            return folder ? `${parent}/${folder}` : parent;
          })()
        : newRepoPath.trim() || "~/code";

    const cleanPath = canonicalRepoPath(rawTarget);
    if (!cleanPath) return;
    const initGit = newRepoMode === "create" && newFolderInitGit;
    setActiveModal(null);

    const name = cleanPath.split("/").filter(Boolean).pop() || "workspace";
    const code = name.slice(0, 2).toUpperCase();
    const id = repoIdFromPath(cleanPath);
    const newRepo: VeloRepo = {
      id,
      code,
      name,
      path: cleanPath,
      default_branch: "main",
    };

    setRepos((prev) =>
      prev.some((r) => canonicalRepoPath(r.path) === cleanPath) ? prev : [...prev, newRepo]
    );
    setRepoFolderState((prev) => ({ ...prev, [cleanPath || id]: "open" }));

    try {
      const res = await fetch(`${daemonUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: cleanPath, init_git: initGit }),
      });
      if (res.ok) {
        refreshSessions();
      } else {
        sendE2eeCommand({ cmd: "add_workspace", path: cleanPath });
      }
    } catch {
      sendE2eeCommand({ cmd: "add_workspace", path: cleanPath });
    }

    // Immediately open a fresh empty thread inside the newly added/created workspace
    handleQuickNewThread(newRepo);
  };

  const handlePickRepoFolder = async (target: "existing" | "parent" = "existing") => {
    try {
      const res = await fetch(`${daemonUrl}/api/pick-folder`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { path?: string };
        if (data.path) {
          if (target === "parent") setNewFolderParent(data.path);
          else setNewRepoPath(data.path);
        }
      }
    } catch {
      // ignore if cancelled
    }
  };

  const handleOpenLocalFileLink = useCallback(
    (filePath: string, line?: number) => {
      if (!filePath) return;
      fetch(`${daemonUrl}/api/open-editor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, editor: "auto", line }),
      }).catch(() => {});
    },
    [daemonUrl]
  );

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
              onClick={() => setCliImportOpen(true)}
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <Terminal className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
              <span>接管终端会话</span>
            </button>
            <button
              onClick={() => setHostsModalOpen(true)}
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <Server className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
              <span>远端 SSH 主机</span>
            </button>
            <button
              onClick={() => setActiveModal("automations")}
              className="flex h-[30px] w-full items-center justify-between rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <span className="flex items-center gap-2.5">
                <CalendarClock className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                <span>定时任务</span>
              </span>
              {enabledAutomationsCount > 0 && (
                <span className="rounded bg-[#34d399]/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#10b981] dark:text-[#34d399]">
                  {enabledAutomationsCount}
                </span>
              )}
            </button>
            <button
              onClick={() => {
                setExtCpInitialTab("extensions");
                setExtCpModalOpen(true);
              }}
              className="flex h-[30px] w-full items-center justify-between rounded-md px-2.5 text-[13px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <span className="flex items-center gap-2.5">
                <Layers className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                <span>Skills &amp; MCP</span>
              </span>
              {localSkills.length > 0 && (
                <span className="rounded bg-[var(--v-bg-active)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--v-fg-muted)]">
                  {localSkills.length}
                </span>
              )}
            </button>
          </div>

          {/* Phase 4: Compact Federated Multi-Host Switcher Strip (only visible when >1 Daemon host is configured) */}
          {(() => {
            const daemonNodes = federatedHosts.filter(
              (h) => h.is_local || h.node_kind === "daemon"
            );
            if (daemonNodes.length <= 1) return null;
            return (
              <div className="mx-2.5 mb-2 flex items-center gap-1 overflow-x-auto rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/70 p-1">
                {daemonNodes.map((h) => {
                  const targetUrl = (h.is_local ? localDaemonUrl : h.daemon_url) || "";
                  const active =
                    targetUrl.replace(/\/+$/, "") === daemonUrl.replace(/\/+$/, "");
                  const online = h.status === "online";
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => targetUrl && handleSwitchControlPlane(targetUrl)}
                      title={`${h.label} (${targetUrl || "offline"})`}
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                        active
                          ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                          : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          online ? "bg-[#34d399]" : "bg-[var(--v-fg-faint)]"
                        }`}
                      />
                      <span className="max-w-[96px] truncate">
                        {h.label.replace(/\s*\(本机\)\s*/, "")}
                      </span>
                      {(h.running_count || 0) > 0 && (
                        <span className="font-mono text-[9.5px] text-[#34d399]">
                          {h.running_count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* Section Header: Workspaces (Direct Add / Create Folder + Collapse/Expand All) */}
          <div className="mx-2.5 border-t border-[var(--v-border-subtle)]/80 pb-1.5 pt-2.5">
            <div className="flex items-center justify-between px-0.5">
              <span className="pl-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--v-fg-muted)]">
                Workspaces
              </span>
              <div className="flex items-center gap-0.5">
              {repos.length > 0 && (() => {
                const activeRepoCanon = canonicalRepoPath(activeRepo.path);
                const anyOpen = repos.some((r) => {
                  const key = canonicalRepoPath(r.path) || r.id;
                  const explicit = repoFolderState[key];
                  return explicit ? explicit === "open" : key === activeRepoCanon;
                });
                return (
                  <button
                    type="button"
                    onClick={() => {
                      const targetState: "open" | "closed" = anyOpen ? "closed" : "open";
                      setRepoFolderState((prev) => {
                        const next = { ...prev };
                        for (const r of repos) {
                          const key = canonicalRepoPath(r.path) || r.id;
                          next[key] = targetState;
                        }
                        return next;
                      });
                    }}
                    title={anyOpen ? "全部收起文件夹" : "全部展开文件夹"}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                  >
                    {anyOpen ? (
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    )}
                  </button>
                );
              })()}
              <button
                type="button"
                onClick={() => openAddWorkspaceModal("create")}
                title="新建本地文件夹作为工作区"
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                <span>新建</span>
              </button>
              <button
                type="button"
                onClick={() => openAddWorkspaceModal("existing")}
                title="添加已有项目文件夹"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              </div>
            </div>
          </div>

          {/* Scrollable Project -> Thread Hierarchy (Refined macOS / Linear Tree Aesthetics) */}
          <div className="flex-1 space-y-2.5 overflow-y-auto px-2 py-1">
            {repos.length === 0 && (
              <button
                type="button"
                onClick={() => openAddWorkspaceModal("create")}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--v-border-strong)] px-3 py-4 text-[12px] text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                <span>添加或新建工作区文件夹</span>
              </button>
            )}
            {repos.map((repo) => {
              const canonRepoPath = canonicalRepoPath(repo.path);
              const repoKey = canonRepoPath || repo.id;
              const activeRepoCanon = canonicalRepoPath(activeRepo.path);
              const isActiveWorkspace = repoKey === activeRepoCanon;
              const repoItems = sessions.filter((s) => {
                if (s.archived) return false;
                if (s.project_path && s.project_path.trim()) {
                  return canonicalRepoPath(s.project_path) === canonRepoPath;
                }
                return s.repo_id === repo.id;
              });
              const explicitFolderState = repoFolderState[repoKey];
              const isCollapsed = explicitFolderState
                ? explicitFolderState === "closed"
                : repoKey !== activeRepoCanon;
              const folderHasWaiting = repoItems.some((s) => s.status === "waiting_approval");
              const folderHasRunning = repoItems.some((s) => s.status === "running");

              return (
                <div key={repo.id} className="space-y-1">
                  {/* Workspace Folder Header Row */}
                  <div
                    className={`group flex h-[28px] items-center justify-between rounded-lg px-1.5 transition-colors ${
                      isActiveWorkspace
                        ? "text-[var(--v-fg-body)]"
                        : "text-[var(--v-fg-secondary)]"
                    } hover:bg-[var(--v-bg-hover)]/70`}
                  >
                    <button
                      onClick={() =>
                        setRepoFolderState((prev) => ({
                          ...prev,
                          [repoKey]: isCollapsed ? "open" : "closed",
                        }))
                      }
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left cursor-pointer"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--v-fg-faint)] transition-transform group-hover:text-[var(--v-fg-muted)]" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0 text-[var(--v-fg-faint)] transition-transform group-hover:text-[var(--v-fg-muted)]" />
                      )}
                      {isCollapsed ? (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)] opacity-80" />
                      ) : (
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)]" />
                      )}
                      <span
                        className={`truncate text-[12px] tracking-[-0.01em] ${
                          isActiveWorkspace
                            ? "font-medium text-[var(--v-fg-body)]"
                            : "font-medium text-[var(--v-fg-secondary)] group-hover:text-[var(--v-fg-body)]"
                        }`}
                      >
                        {repo.name}
                      </span>
                      {repoItems.length > 0 && (
                        <span className="ml-0.5 inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-[var(--v-fg-faint)] tabular-nums">
                          {isCollapsed && folderHasWaiting ? (
                            <span className="h-1.5 w-1.5 rounded-full bg-[#fbbf24]" />
                          ) : isCollapsed && folderHasRunning ? (
                            <span className="h-1.5 w-1.5 rounded-full bg-[#34d399] animate-pulse" />
                          ) : null}
                          {repoItems.length}
                        </span>
                      )}
                    </button>

                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => handleQuickNewThread(repo)}
                        title={`在 ${repo.name} 中新建会话`}
                        className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--v-fg-muted)] opacity-0 transition-opacity hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] group-hover:opacity-100 cursor-pointer"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setRelocateTarget({
                            mode: "workspace",
                            oldPath: repo.path,
                            newPath: repo.path,
                          });
                        }}
                        title={`修改 ${repo.name} 的归属文件夹路径`}
                        className="hidden h-5 w-5 items-center justify-center rounded-md text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] group-hover:flex cursor-pointer"
                      >
                        <SquarePen className="h-3 w-3" />
                      </button>
                      <button
                        onClick={(e) => void handleRemoveRepo(repo.id, e)}
                        title={`移除文件夹 ${repo.name} 及旗下会话`}
                        className="hidden h-5 w-5 items-center justify-center rounded-md text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[#f87171] group-hover:flex cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  {/* Thread Rows (Clean native indentation, zero vertical guide line) */}
                  {!isCollapsed && (
                    <div className="space-y-0.5 pl-3">
                      {repoItems.length === 0 ? (
                        <button
                          type="button"
                          onClick={() => handleQuickNewThread(repo)}
                          className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-[var(--v-fg-faint)] transition-colors hover:bg-[var(--v-bg-hover)]/70 hover:text-[var(--v-fg-secondary)] cursor-pointer"
                        >
                          <Plus className="h-3 w-3" />
                          <span>新建会话</span>
                        </button>
                      ) : (
                        repoItems.map((w) => {
                          const isSelected = w.id === activeSession.id;
                          const hasPending = !!pendingApprovals[w.id] || !!pendingQuestions[w.id];
                          const hasDraft = !isSelected && Boolean(draftsBySession[w.id]?.trim());
                          const rowStatus: EngineStatusIndicator =
                            hasPending || w.status === "waiting_approval"
                              ? "waiting"
                              : w.status === "running"
                              ? "running"
                              : unreadSessionIds[w.id] && !isSelected
                              ? "unread"
                              : "idle";

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
                              style={
                                isSelected
                                  ? {
                                      backgroundColor: "var(--v-row-selected-bg)",
                                      color: "var(--v-row-selected-fg)",
                                    }
                                  : undefined
                              }
                              className={`group relative flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-left transition-colors duration-150 ${
                                isSelected
                                  ? ""
                                  : "text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)]/75 hover:text-[var(--v-fg-primary)]"
                              }`}
                            >
                              {/* Bare Refined Engine Brand Glyph (Monochrome idle -> Brand-illuminated on select; status decoupled) */}
                              <EngineSessionBadge
                                engine={w.agent_kind}
                                selected={isSelected}
                                status={rowStatus}
                                title={`${w.model_short || w.agent_kind}${
                                  rowStatus === "running"
                                    ? " · 正在执行"
                                    : rowStatus === "waiting"
                                    ? " · 等待审批"
                                    : rowStatus === "unread"
                                    ? " · 有未读新进展"
                                    : ""
                                }`}
                              />

                              {/* Thread Content Column */}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-1.5">
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
                                      className="w-full rounded border border-[var(--v-border-strong)] bg-[var(--v-bg-canvas)] px-1.5 py-0.5 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                                    />
                                  ) : (
                                    <span
                                      onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        setRenamingSessionId(w.id);
                                        setRenamingTitle(w.title);
                                      }}
                                      title={`${w.title} · ${w.model_short || w.agent_kind}`}
                                      className={`truncate text-[12.5px] leading-[1.35] ${
                                        isSelected
                                          ? "font-medium text-[var(--v-fg-primary)]"
                                          : "font-normal"
                                      }`}
                                    >
                                      {w.title}
                                    </span>
                                  )}
                                  <div className="flex shrink-0 items-center gap-1">
                                    {rowStatus === "waiting" ? (
                                      <span className="rounded bg-[#fbbf24]/15 px-1.5 py-[1px] text-[9.5px] font-medium text-[#d97706] dark:text-[#fbbf24] group-hover:hidden">
                                        待确认
                                      </span>
                                    ) : hasDraft ? (
                                      <span className="rounded bg-[#f59e0b]/15 px-1.5 py-[1px] text-[9.5px] font-medium text-[#d97706] dark:text-[#fbbf24] group-hover:hidden">
                                        草稿
                                      </span>
                                    ) : w.updated_at && w.updated_at !== "ready" ? (
                                      <span className="font-mono text-[10px] text-[var(--v-fg-faint)] tabular-nums group-hover:hidden">
                                        {w.updated_at}
                                      </span>
                                    ) : null}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setRenamingSessionId(w.id);
                                        setRenamingTitle(w.title);
                                      }}
                                      title="重命名会话"
                                      className="hidden h-4 w-4 items-center justify-center rounded text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] group-hover:flex"
                                    >
                                      <SquarePen className="h-2.5 w-2.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => handleArchiveSession(w.id, true, e)}
                                      title="归档会话"
                                      className="hidden h-4 w-4 items-center justify-center rounded text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] group-hover:flex"
                                    >
                                      <Archive className="h-2.5 w-2.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSessionPendingDelete({ id: w.id, title: w.title });
                                      }}
                                      title="删除会话"
                                      className="hidden h-4 w-4 items-center justify-center rounded text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-active)] hover:text-[#f87171] group-hover:flex"
                                    >
                                      <Trash2 className="h-2.5 w-2.5" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Collapsible Archived Sessions Drawer (Preserves Commits & History) */}
            {(() => {
              const archivedList = sessions.filter((s) => Boolean(s.archived));
              if (archivedList.length === 0) return null;
              return (
                <div className="mt-2 border-t border-[var(--v-border-subtle)] pt-2">
                  <button
                    type="button"
                    onClick={() => setShowArchivedDrawer((v) => !v)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1 text-[11.5px] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-surface)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                  >
                    <span className="flex items-center gap-1.5">
                      <Archive className="h-3 w-3" />
                      <span>已归档会话 ({archivedList.length})</span>
                    </span>
                    {showArchivedDrawer ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </button>
                  {showArchivedDrawer && (
                    <div className="mt-1 space-y-0.5">
                      {archivedList.map((arch) => (
                        <div
                          key={arch.id}
                          onClick={() => setActiveId(arch.id)}
                          className={`group flex cursor-pointer items-center justify-between gap-1.5 rounded-md px-2 py-1.5 text-[12px] ${
                            arch.id === activeSession.id
                              ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                              : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-surface)] hover:text-[var(--v-fg-body)]"
                          }`}
                        >
                          <span className="truncate">{arch.title}</span>
                          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={(e) => handleArchiveSession(arch.id, false, e)}
                              title="取消归档并恢复到主列表"
                              className="rounded p-0.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[#34d399]"
                            >
                              <ArchiveRestore className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSessionPendingDelete({ id: arch.id, title: arch.title });
                              }}
                              title="永久清理会话与 Worktree"
                              className="rounded p-0.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[#f87171]"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Real 5h / 7d Subscription Rate-Limit Window Balance Bar */}
        <SidebarQuotaBar
          daemonUrl={daemonUrl}
          onOpenAnalytics={() => {
            setAnalyticsInitialTab("analytics");
            setAnalyticsModalOpen(true);
          }}
        />

        {/* Bottom Compact Footer (Zero Duplication: Live Status / Usage on left, Theme & Settings on right) */}
        <div className="flex h-[40px] shrink-0 items-center justify-between border-t border-[var(--v-border-subtle)] px-2.5 text-[var(--v-fg-muted)]">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveModal("qr")}
              title={`手机扫码连接 (${connected || e2eeConnected ? "守护进程在线" : "正在重连"})`}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: connected || e2eeConnected ? "#34d399" : "#fbbf24" }}
              />
              <Smartphone className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => {
                setAnalyticsInitialTab("analytics");
                setAnalyticsModalOpen(true);
              }}
              title={`用量与费用分析 (当前上下文 ${tokenPercent}%)`}
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <CircleGauge className="h-4 w-4" />
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
        {/* Clean Minimal Workspace Header (42px, container-query responsive so narrow windows never squish or wrap) */}
        <header
          data-tauri-drag-region
          className={`@container flex h-[42px] shrink-0 items-center justify-between gap-2 border-b border-[var(--v-border-subtle)] pr-3 ${
            isMacDesktop && !sidebarOpen ? "pl-[78px]" : "pl-3.5"
          }`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                title="Show sidebar (⌘B)"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            )}
            <span
              title={activeSession.title}
              className="min-w-0 truncate text-[13px] font-medium text-[var(--v-fg-primary)]"
            >
              {activeSession.title}
            </span>
            {(() => {
              const parentSess = activeSession.parent_session_id
                ? sessions.find((s) => s.id === activeSession.parent_session_id)
                : undefined;
              if (!parentSess) return null;
              return (
                <button
                  type="button"
                  onClick={() => setActiveId(parentSess.id)}
                  title={`点击返回源会话：${parentSess.title}`}
                  className="hidden @[640px]:inline-flex max-w-[140px] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-md bg-[#a78bfa]/12 px-1.5 py-0.5 text-[10.5px] font-medium text-[#a78bfa] transition-colors hover:bg-[#a78bfa]/22 cursor-pointer"
                >
                  <GitFork className="h-2.5 w-2.5 shrink-0" />
                  <span className="min-w-0 truncate">{parentSess.title}</span>
                </button>
              );
            })()}
            <button
              type="button"
              onClick={() =>
                setRelocateTarget({
                  mode: activeSession.id && activeSession.id !== "draft-empty" ? "session" : "workspace",
                  oldPath: activeSession.project_path || activeRepo.path,
                  sessionId:
                    activeSession.id && activeSession.id !== "draft-empty"
                      ? activeSession.id
                      : undefined,
                  newPath: activeSession.project_path || activeRepo.path,
                })
              }
              title={`当前归属路径: ${activeSession.worktree_path}（点击可修改归属目录）`}
              className="hidden @[740px]:inline-flex max-w-[190px] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-md bg-[var(--v-bg-hover)] px-2 py-0.5 font-mono text-[11px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <Folder className="h-3 w-3 shrink-0 text-[var(--v-fg-muted)]" />
              <span className="min-w-0 truncate">{activeRepo.name}</span>
              <span className="shrink-0 text-[var(--v-fg-faint)]">/</span>
              <GitBranch className="h-3 w-3 shrink-0 text-[var(--v-fg-muted)]" />
              <span className="min-w-0 truncate">{activeSession.branch_name}</span>
            </button>
            {(() => {
              const isRunning =
                activeSession.status === "running" ||
                activeSession.status === "waiting_approval";
              const lastTurnUser = [...activeEvents]
                .reverse()
                .find((e) => e.kind === "user");
              const displayTps = isRunning
                ? turnTimingBySession[activeSession.id]?.liveTps ?? lastTurnUser?.tps
                : lastTurnUser?.tps;
              if (!displayTps || displayTps < 0.5) return null;
              return (
                <span
                  title="模型输出生成速率 (Tokens / Sec)"
                  className="hidden @[560px]:inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[#8b5cf6]/12 px-2 py-0.5 font-mono text-[11px] font-medium text-[#a78bfa] tabular-nums"
                >
                  <span>⚡ {displayTps.toFixed(1)} tok/s</span>
                </span>
              );
            })()}
          </div>

          {/* Right Header Controls: non-wrapping shrink-0 strip + container-responsive `···` overflow menu */}
          <div className="relative flex shrink-0 items-center gap-1 whitespace-nowrap">
            {/* Phase 3: Global P0-P3 Arbitrated Task Monitor Pill */}
            {(() => {
              const activeTasks = sessions
                .filter(
                  (s) =>
                    !s.archived &&
                    (s.status === "waiting_approval" || s.status === "running")
                )
                .sort((a, b) => {
                  const pa = a.status === "waiting_approval" ? 0 : a.id === activeSession.id ? 1 : 2;
                  const pb = b.status === "waiting_approval" ? 0 : b.id === activeSession.id ? 1 : 2;
                  return pa - pb;
                });
              if (activeTasks.length === 0) return null;
              const waitingCount = activeTasks.filter(
                (s) => s.status === "waiting_approval"
              ).length;
              const runningCount = activeTasks.length - waitingCount;
              const hasWaiting = waitingCount > 0;
              return (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMonitorMenuOpen((v) => !v)}
                    title="全局运行任务监控（P0 待审批优先 · 点击直达）"
                    className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors cursor-pointer ${
                      hasWaiting
                        ? "border-[#f59e0b]/40 bg-[#f59e0b]/12 text-[#d97706] dark:text-[#fbbf24] hover:bg-[#f59e0b]/20"
                        : "border-[#34d399]/35 bg-[#34d399]/10 text-[#059669] dark:text-[#34d399] hover:bg-[#34d399]/18"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full animate-pulse ${
                        hasWaiting ? "bg-[#f59e0b]" : "bg-[#34d399]"
                      }`}
                    />
                    <span>
                      {hasWaiting
                        ? `${waitingCount} 待批准${runningCount > 0 ? ` · ${runningCount} 运行` : ""}`
                        : `${runningCount} 运行中`}
                    </span>
                  </button>
                  {monitorMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-30"
                        onClick={() => setMonitorMenuOpen(false)}
                      />
                      <div className="absolute right-0 top-8 z-40 w-[280px] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1.5 shadow-2xl">
                        <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-medium text-[var(--v-fg-muted)]">
                          <span>全局任务监控 · P0-P2 优先级</span>
                          <span className="font-mono">{activeTasks.length} 项</span>
                        </div>
                        <div className="mt-0.5 max-h-[240px] space-y-0.5 overflow-y-auto">
                          {activeTasks.map((task) => {
                            const isWait = task.status === "waiting_approval";
                            const isCur = task.id === activeSession.id;
                            return (
                              <button
                                key={task.id}
                                type="button"
                                onClick={() => {
                                  setActiveId(task.id);
                                  const cp = canonicalRepoPath(task.project_path);
                                  if (cp) {
                                    setRepoFolderState((prev) => ({ ...prev, [cp]: "open" }));
                                  }
                                  setMonitorMenuOpen(false);
                                }}
                                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors cursor-pointer ${
                                  isCur
                                    ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                                    : "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)]"
                                }`}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <span
                                    className={`shrink-0 rounded px-1 py-0.5 font-mono text-[9.5px] font-semibold ${
                                      isWait
                                        ? "bg-[#f59e0b]/20 text-[#fbbf24]"
                                        : "bg-[#34d399]/15 text-[#34d399]"
                                    }`}
                                  >
                                    {isWait ? "P0" : isCur ? "P1" : "P2"}
                                  </span>
                                  <span className="truncate">{task.title}</span>
                                </div>
                                <span className="shrink-0 font-mono text-[10px] text-[var(--v-fg-muted)]">
                                  {isWait ? "待批准" : "执行中"}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
            <button
              type="button"
              onClick={() => {
                setAnalyticsInitialTab("search");
                setAnalyticsModalOpen(true);
              }}
              title="跨工作区全文搜索历史会话 · 用量账单 · 远程锁屏盲推送"
              className="hidden @[580px]:inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11.5px] text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <CircleGauge className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden @[1040px]:inline">账单/搜索</span>
            </button>

            <button
              type="button"
              onClick={() => setAutoCollapseSteps((v) => !v)}
              title={
                autoCollapseSteps
                  ? "当前：连续思考与 MCP/工具执行默认折叠收起（点击切换为默认展开）"
                  : "当前：执行过程默认展开（点击切换为默认折叠收起）"
              }
              className={`hidden @[780px]:inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11px] transition-colors cursor-pointer ${
                autoCollapseSteps
                  ? "bg-[var(--v-bg-hover)] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)]"
                  : "bg-[#8b5cf6]/15 text-[#a78bfa] hover:bg-[#8b5cf6]/25"
              }`}
            >
              <Layers className="h-3 w-3 shrink-0" />
              <span className="hidden @[1120px]:inline">
                {autoCollapseSteps ? "过程默认收起" : "过程默认展开"}
              </span>
            </button>

            {e2eeConnected && (
              <span
                title="End-to-End Encrypted Relay Active (X25519 + ChaCha20-Poly1305)"
                className="hidden @[640px]:inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[#34d399]/15 px-2 font-mono text-[10.5px] font-medium text-[#34d399]"
              >
                <Lock className="h-3 w-3 shrink-0" />
                <span className="hidden @[1180px]:inline">E2EE</span>
              </span>
            )}

            {mobileMode && !e2eeRelayConfig && (
              <button
                onClick={() => setMobileMode(false)}
                className="shrink-0 whitespace-nowrap rounded-md bg-[#34d399]/15 px-2 py-1 font-mono text-[11px] font-medium text-[#34d399]"
              >
                Exit Preview
              </button>
            )}

            <div className="relative hidden @[840px]:block shrink-0">
              <button
                onClick={() => {
                  setHeaderMoreMenuOpen(false);
                  setOpenInMenuOpen((o) => !o);
                }}
                title="Open isolated worktree in external IDE or Finder"
                className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[var(--v-bg-hover)] px-2 text-[11.5px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <span>Open in</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-[var(--v-fg-muted)]" />
              </button>

              {openInMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setOpenInMenuOpen(false)}
                    aria-hidden="true"
                  />
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
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                      >
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </>
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
              className={`flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 font-mono text-[11.5px] transition-colors cursor-pointer ${
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
              className={`hidden @[720px]:flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors cursor-pointer ${
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
              className={`relative hidden @[720px]:flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors cursor-pointer ${
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
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors cursor-pointer ${
                drawerOpen && drawerTab === "terminal"
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <Terminal className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => setChatFindOpen((v) => !v)}
              title="在当前会话中搜索提问轮次 (⌘F)"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors cursor-pointer ${
                chatFindOpen
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <Search className="h-3.5 w-3.5" />
            </button>
            {activeEvents.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setExtCpInitialTab("checkpoints");
                    setExtCpModalOpen(true);
                  }}
                  title="每轮自动检查点 · 一键回滚代码 (Rewind)"
                  className="hidden @[720px]:flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                >
                  <History className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleForkSession()}
                  title="从当前会话一键分叉探索新思路 (Fork)"
                  className="hidden @[720px]:flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                >
                  <GitFork className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => {
                setExtCpInitialTab("extensions");
                setExtCpModalOpen(true);
              }}
              title="查看本机 MCP 服务器与 Skills"
              className="hidden @[520px]:flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <Blocks className="h-3.5 w-3.5" />
            </button>

            {/* Compact overflow menu on narrower headers (< 840px) so every tool stays 1-click reachable without wrapping */}
            <div className="relative @[840px]:hidden shrink-0">
              <button
                type="button"
                onClick={() => {
                  setOpenInMenuOpen(false);
                  setHeaderMoreMenuOpen((o) => !o);
                }}
                title="更多工具"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {headerMoreMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setHeaderMoreMenuOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="absolute right-0 top-8 z-40 w-[200px] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1 shadow-2xl">
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreMenuOpen(false);
                        setAnalyticsInitialTab("analytics");
                        setAnalyticsModalOpen(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                    >
                      <CircleGauge className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span>账单与全局搜索</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreMenuOpen(false);
                        setAutoCollapseSteps((v) => !v);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                    >
                      <Layers className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span>{autoCollapseSteps ? "切换为过程默认展开" : "切换为过程默认收起"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreMenuOpen(false);
                        setExtCpInitialTab("extensions");
                        setExtCpModalOpen(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                    >
                      <Blocks className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span>Skills &amp; MCP</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreMenuOpen(false);
                        setDrawerTab("pr");
                        setDrawerOpen(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                    >
                      <GitPullRequest className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span>Pull Requests</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreMenuOpen(false);
                        setDrawerTab("browser");
                        setDrawerOpen(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                    >
                      <Globe className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span>浏览器预览</span>
                    </button>
                    {activeEvents.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setHeaderMoreMenuOpen(false);
                            setExtCpInitialTab("checkpoints");
                            setExtCpModalOpen(true);
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                        >
                          <History className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                          <span>检查点回滚 (Rewind)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setHeaderMoreMenuOpen(false);
                            void handleForkSession();
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                        >
                          <GitFork className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                          <span>分叉会话 (Fork)</span>
                        </button>
                      </>
                    )}
                    <div className="my-1 border-t border-[var(--v-border-subtle)]" />
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreMenuOpen(false);
                        handleOpenInEditor("cursor");
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                    >
                      <Folder className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span>在 Cursor 中打开</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreMenuOpen(false);
                        handleOpenInEditor("finder");
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                    >
                      <Folder className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span>在 Finder 中显示</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {!mobileMode && (
              <button
                onClick={() => setActiveModal("qr")}
                title="手机扫码连接 (Mobile Remote)"
                className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11.5px] text-[var(--v-fg-secondary)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <Smartphone className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden @[1000px]:inline">手机端</span>
              </button>
            )}
          </div>
        </header>

        {/* Subtle Disconnect / Reconnecting Hairline Banner (appears only after startup grace) */}
        {connectionGraceElapsed && !connected && !e2eeConnected && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/20 bg-amber-500/[0.07] px-3.5 py-1 text-[11.5px] text-amber-700 dark:text-amber-300">
            <div className="flex min-w-0 items-center gap-1.5">
              <WifiOff className="h-3 w-3 shrink-0" />
              <span className="truncate">
                与节点{" "}
                <span className="font-mono">
                  {federatedHosts.find(
                    (h) => (h.daemon_url || "").replace(/\/+$/, "") === daemonUrl
                  )?.label || (daemonUrl === localDaemonUrl ? "本机 Daemon" : daemonUrl)}
                </span>{" "}
                连接已断开，正在自动重连…
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setWsReconnectNonce((n) => n + 1);
                refreshSessions();
              }}
              className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-amber-500/20 cursor-pointer"
            >
              <RefreshCw className="h-2.5 w-2.5" />
              <span>立即重连</span>
            </button>
          </div>
        )}

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
            {sessions.filter((s) => !s.archived).map((s) => {
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
            <ChatOutlineRail
              turns={outlineTurns}
              onJumpToTurn={handleJumpToTurn}
              findOpen={chatFindOpen}
              findQuery={chatFindQuery}
              onChangeFindQuery={setChatFindQuery}
              onCloseFind={() => {
                setChatFindOpen(false);
                setChatFindQuery("");
              }}
            />
            {/* Scrollable Stream (Unified Scroll State Machine: zero yank-back on upward scroll, zero jump on focus) */}
            <div
              ref={chatScrollRef}
              onWheel={(e) => {
                userScrollIntentAtRef.current = Date.now();
                // Any deliberate upward scroll immediately releases PinnedBottom (never fight macOS trackpad inertia!)
                if (e.deltaY < -1) {
                  isPinnedToBottomRef.current = false;
                  setShowJumpToBottom(true);
                }
              }}
              onPointerDown={() => {
                userScrollIntentAtRef.current = Date.now();
              }}
              onTouchStart={() => {
                userScrollIntentAtRef.current = Date.now();
              }}
              onScroll={(e) => {
                const el = e.currentTarget;
                if (programmaticScrollRef.current) {
                  lastScrollTopRef.current = el.scrollTop;
                  return;
                }
                const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                const nearBottom = distanceFromBottom < 64;
                const scrolledUp = el.scrollTop < lastScrollTopRef.current - 2;
                const isRecentUserGesture = Date.now() - userScrollIntentAtRef.current < 1800;
                lastScrollTopRef.current = el.scrollTop;

                if (nearBottom) {
                  isPinnedToBottomRef.current = true;
                  setShowJumpToBottom(false);
                } else if (isRecentUserGesture && scrolledUp) {
                  isPinnedToBottomRef.current = false;
                  setShowJumpToBottom(true);
                } else if (!isPinnedToBottomRef.current) {
                  setShowJumpToBottom(true);
                }

                if (
                  !isPinnedToBottomRef.current &&
                  el.scrollTop < 32 &&
                  hasMoreHistoryBySession[activeSession.id] &&
                  !loadingOlderBySession[activeSession.id]
                ) {
                  void loadOlderEventsForSession(activeSession.id);
                }
              }}
              className="velo-chat-scroll w-full flex-1 overflow-y-auto overflow-x-hidden px-3.5 py-4 sm:px-6 sm:py-6"
              data-testid="agent-chat-scroll"
            >
              <div
                ref={chatContentRef}
                className="mx-auto flex w-full min-w-0 max-w-[680px] flex-col gap-1.5"
              >
                {hasMoreHistoryBySession[activeSession.id] && (
                  <div className="mb-2 flex justify-center">
                    <button
                      type="button"
                      onClick={() => void loadOlderEventsForSession(activeSession.id)}
                      disabled={Boolean(loadingOlderBySession[activeSession.id])}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-3 py-1 text-[11.5px] text-[var(--v-fg-muted)] transition-colors hover:border-[var(--v-border-strong)] hover:text-[var(--v-fg-primary)] cursor-pointer disabled:opacity-50"
                    >
                      <span>
                        {loadingOlderBySession[activeSession.id]
                          ? "正在加载更早记录…"
                          : "↑ 加载更早历史消息"}
                      </span>
                    </button>
                  </div>
                )}

                {activeEvents.length === 0 && (
                  <div className="my-12 flex flex-col items-center justify-center gap-4 text-center">
                    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-3.5 py-1 text-[12px] text-[var(--v-fg-secondary)]">
                      <Folder className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                      <span className="font-medium text-[var(--v-fg-primary)]">
                        {activeRepo.name}
                      </span>
                      <span className="text-[var(--v-fg-faint)]">/</span>
                      <GitBranch className="h-3 w-3 text-[var(--v-fg-muted)]" />
                      <span className="font-mono text-[11.5px]">{activeSession.branch_name}</span>
                    </div>

                    {/* Direct New-Thread Engine & Model Launchpad */}
                    {(() => {
                      const activeEngineKey = getEngineTabForAgentKind(activeSession.agent_kind);
                      const featuredModels = pickFeaturedModelsForEngine(
                        modelCatalog,
                        activeEngineKey,
                        5
                      );
                      const totalInEngine = modelCatalog.filter(
                        (m) => getEngineTabForModel(m) === activeEngineKey
                      ).length;

                      return (
                        <div className="w-full max-w-[540px] rounded-2xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/80 p-3.5 shadow-sm">
                          <div className="mb-2 flex items-center justify-between px-0.5 text-[11px]">
                            <span className="font-medium text-[var(--v-fg-muted)]">
                              选择本次新会话的引擎与模型
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setEffortPickerOpen(false);
                                setModelPickerOpen(true);
                              }}
                              className="font-medium text-[#a78bfa] hover:underline cursor-pointer"
                            >
                              搜索全部 {modelCatalog.length} 个模型 →
                            </button>
                          </div>

                          {/* Row 1: 5 Major Coding Engines */}
                          <div className="flex flex-wrap items-center justify-center gap-1.5">
                            {ENGINE_TABS.filter((t) => t.key !== "acp").map((tab) => {
                              const engineModels = modelCatalog.filter(
                                (m) => getEngineTabForModel(m) === tab.key
                              );
                              if (engineModels.length === 0) return null;
                              const isSel = activeEngineKey === tab.key;
                              const rt = runtimes.find((r) => r.id === tab.runtimeId);
                              const avail = rt
                                ? rt.available
                                : engineModels.some((m) => m.installed !== false);
                              const defaultModel =
                                engineModels.find((m) => m.isDefault) || engineModels[0];

                              return (
                                <button
                                  key={tab.key}
                                  type="button"
                                  disabled={!avail}
                                  onClick={() => void handleSelectSessionModel(defaultModel, false)}
                                  className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[12px] font-medium transition-all ${
                                    isSel
                                      ? "border-[var(--v-border-strong)] bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                                      : avail
                                      ? "border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/50 text-[var(--v-fg-secondary)] hover:border-[var(--v-border-strong)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                                      : "cursor-not-allowed border-transparent text-[var(--v-fg-faint)] opacity-45"
                                  }`}
                                >
                                  <span
                                    className="h-2 w-2 rounded-full"
                                    style={{
                                      backgroundColor: avail ? tab.dotColor : "var(--v-fg-faint)",
                                    }}
                                  />
                                  <span>{tab.shortLabel}</span>
                                </button>
                              );
                            })}
                          </div>

                          {/* Row 2: Featured Models of Selected Engine */}
                          {featuredModels.length > 0 && (
                            <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5 border-t border-[var(--v-border-subtle)] pt-2.5">
                              {featuredModels.map((m) => {
                                const isSel = (activeCatalogModel?.id || activeSession.model) === m.id;
                                const avail = isModelAvailable(m, runtimes);
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    disabled={!avail}
                                    onClick={() => void handleSelectSessionModel(m, false)}
                                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                                      isSel
                                        ? "border-[#34d399]/50 bg-[#34d399]/12 font-medium text-[var(--v-fg-primary)]"
                                        : "border-[var(--v-border-subtle)] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                                    }`}
                                  >
                                    <span>{m.label}</span>
                                    {isSel && <Check className="h-3 w-3 text-[#34d399]" />}
                                  </button>
                                );
                              })}
                              {totalInEngine > featuredModels.length && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEffortPickerOpen(false);
                                    setModelPickerOpen(true);
                                  }}
                                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--v-border-strong)] px-2.5 py-1 text-[11px] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                                >
                                  <span>+{totalInEngine - featuredModels.length} 更多</span>
                                </button>
                              )}
                            </div>
                          )}

                          {/* Row 3: Orthogonal Reasoning Effort for Selected Model */}
                          {activeSupportedEfforts.length > 1 && (
                            <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5 border-t border-[var(--v-border-subtle)] pt-2">
                              <span className="mr-1 text-[10.5px] text-[var(--v-fg-muted)]">
                                思考强度:
                              </span>
                              {activeSupportedEfforts.map((eff) => {
                                const isSel = activeEffectiveEffort === eff;
                                return (
                                  <button
                                    key={eff}
                                    type="button"
                                    onClick={() => handleSelectSessionEffort(eff)}
                                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                                      isSel
                                        ? "bg-[#8b5cf6]/20 text-[#a78bfa] ring-1 ring-[#8b5cf6]/40"
                                        : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                                    }`}
                                  >
                                    {EFFORT_DISPLAY_LABELS[eff] || eff}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <button
                      type="button"
                      onClick={() => {
                        setTargetRepoIdForNewWt(activeRepo.id);
                        setNewModelId(activeSession.model);
                        setNewSetupCommand(repoHooks[activeRepo.path] || "");
                        setActiveModal("new-worktree");
                      }}
                      className="text-[11.5px] text-[var(--v-fg-muted)] transition-colors hover:text-[var(--v-fg-primary)] cursor-pointer"
                    >
                      配置独立 Git Worktree · Committee 多模型竞速 · TDD 自动循环 →
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
                      const stableKey = ev.client_msg_id
                        ? `turn-${ev.client_msg_id}`
                        : `turn-u-${turns.length}`;
                      turns.push({ key: stableKey, userEv: ev, items: [] });
                    } else if (turns.length === 0) {
                      turns.push({ key: "turn-init", userEv: null, items: [ev] });
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

                  const MAX_WINDOWED_TURNS = 16;
                  const expandAll = Boolean(showAllTurnsBySession[activeSession.id]);
                  const hiddenEarlierTurns =
                    !expandAll && turns.length > MAX_WINDOWED_TURNS
                      ? turns.length - MAX_WINDOWED_TURNS
                      : 0;
                  const visibleTurns =
                    hiddenEarlierTurns > 0 ? turns.slice(hiddenEarlierTurns) : turns;

                  return (
                    <>
                      {hiddenEarlierTurns > 0 && (
                        <div className="mb-3 flex justify-center">
                          <button
                            type="button"
                            onClick={() =>
                              setShowAllTurnsBySession((p) => ({
                                ...p,
                                [activeSession.id]: true,
                              }))
                            }
                            className="rounded-full border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/60 px-3.5 py-1.5 text-[11.5px] font-medium text-[var(--v-fg-secondary)] transition-colors hover:border-[var(--v-border-strong)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                          >
                            ↑ 展开更早的 {hiddenEarlierTurns} 轮历史对话（长会话窗口渲染加速已开启）
                          </button>
                        </div>
                      )}
                      {visibleTurns.map((turn, visIdx) => {
                        const turnIdx = hiddenEarlierTurns + visIdx;
                        const isLatestTurn = turnIdx === turns.length - 1;
                        const isTurnRunning = isLatestTurn && isSessionRunning;
                        const lastTurnItem = turn.items[turn.items.length - 1];
                        const lastTurnAssistant = [...turn.items]
                          .reverse()
                          .find((e) => e.kind === "assistant");

                        let turnPhase: AgentStatusPhase = "working";
                        let turnStatusLabel: string | undefined = "Working…";
                        if (isTurnRunning) {
                          const latestThinkingEv = [...turn.items]
                            .reverse()
                            .find((e) => e.kind === "thinking");
                          const latestThinkHeadline = latestThinkingEv
                            ? extractThinkingHeadline(latestThinkingEv.content)
                            : "";
                          if (waitingLabel) {
                            turnPhase = "waiting";
                            turnStatusLabel = waitingLabel;
                          } else if (!lastTurnItem) {
                            turnPhase = "thinking";
                            turnStatusLabel = undefined;
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
                            turnStatusLabel = `${pres.workingVerb}…`;
                          } else if (
                            lastTurnItem.kind === "assistant" &&
                            lastTurnItem.is_streaming_chunk
                          ) {
                            turnPhase = "writing";
                            turnStatusLabel = "Writing…";
                          } else {
                            turnPhase = "thinking";
                            turnStatusLabel = latestThinkHeadline || undefined;
                          }
                        }

                        return (
                          <div
                            key={turn.key}
                            data-turn-key={turn.key}
                            className="flex flex-col gap-1.5 pb-3"
                          >
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
                                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
                                    className="group mt-2 mb-0.5 flex min-w-0 max-w-full flex-col items-end"
                                  >
                                    <div
                                      onClick={() => {
                                        const selected = window.getSelection()?.toString() ?? "";
                                        if (selected.length > 0) return;
                                        if (!isSessionRunning) {
                                          handleStartEditMessage(ev);
                                        }
                                      }}
                                      title={!isSessionRunning ? "点击可编辑并重新发送" : undefined}
                                      className={`velo-selectable min-w-0 max-w-[82%] overflow-hidden whitespace-pre-wrap break-words rounded-2xl rounded-tr-[4px] bg-[var(--v-bg-bubble)] px-4 py-2.5 text-[13.5px] leading-[1.48] text-[var(--v-fg-primary)] transition-colors ${
                                        !isSessionRunning
                                          ? "hover:brightness-105"
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
                                      {(() => {
                                        const parsedUser = parseUserMessageWithFiles(ev.content);
                                        return (
                                          <>
                                            {parsedUser.files.length > 0 && (
                                              <div className="mb-1.5 flex flex-wrap gap-1.5">
                                                {parsedUser.files.map((fp, fIdx) => (
                                                  <span
                                                    key={`${fp}-${fIdx}`}
                                                    title={fp}
                                                    className="velo-no-select inline-flex max-w-[240px] items-center gap-1 rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)]/80 px-2 py-0.5 font-mono text-[11px] text-[var(--v-fg-secondary)]"
                                                  >
                                                    <FileText className="h-3 w-3 shrink-0 text-[#a78bfa]" />
                                                    <span className="truncate">
                                                      {fp.split("/").pop() || fp}
                                                    </span>
                                                  </span>
                                                ))}
                                              </div>
                                            )}
                                            {parsedUser.body}
                                          </>
                                        );
                                      })()}
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

                            {/* 2. Chronological Agent Turn Items (Consecutive Thinking + MCP/Tools grouped into collapsible Trace) */}
                            {turn.items.map((ev, idx) => {
                              const isLastTurnItem = idx === turn.items.length - 1;
                              const isProcessStep = (item: AgentEvent) =>
                                item.kind === "thinking" || item.kind === "tool_call";

                              if (isProcessStep(ev)) {
                                if (idx > 0 && isProcessStep(turn.items[idx - 1])) {
                                  return null;
                                }
                                let endIdx = idx;
                                while (
                                  endIdx + 1 < turn.items.length &&
                                  isProcessStep(turn.items[endIdx + 1])
                                ) {
                                  endIdx++;
                                }
                                const useFocusGroupForSingle = Boolean(
                                  isTurnRunning &&
                                    endIdx === turn.items.length - 1 &&
                                    isFocusFootprintProvider(activeSession.agent_kind)
                                );
                                if (endIdx > idx || useFocusGroupForSingle) {
                                  const traceSteps: PaseoTraceStepItem[] = turn.items
                                    .slice(idx, endIdx + 1)
                                    .map((stepEv, relIdx) => {
                                      const absIdx = idx + relIdx;
                                      const isLastInTurn = absIdx === turn.items.length - 1;
                                      if (stepEv.kind === "thinking") {
                                        return {
                                          id: stepEv.id,
                                          kind: "thinking",
                                          text: stepEv.content,
                                          isStreamingThinking: Boolean(
                                            stepEv.is_streaming_chunk &&
                                              isTurnRunning &&
                                              isLastInTurn
                                          ),
                                          startedAtMs:
                                            stepEv.started_at_ms ??
                                            (isLatestTurn
                                              ? activeTurnTiming?.startedAtMs
                                              : undefined),
                                          durationMs: stepEv.duration_ms,
                                        };
                                      }
                                      return {
                                        id: stepEv.id,
                                        kind: "tool_call",
                                        toolName: stepEv.tool_name || "Tool",
                                        input:
                                          stepEv.tool_input ??
                                          (stepEv.tool_args
                                            ? { target: stepEv.tool_args }
                                            : stepEv.content),
                                        output:
                                          stepEv.tool_output ??
                                          (stepEv.tool_input === undefined
                                            ? stepEv.content
                                            : undefined),
                                        isError: stepEv.tool_is_error,
                                        fileArg: stepEv.tool_args,
                                      };
                                    });
                                  return (
                                    <PaseoExecutionTraceGroup
                                      key={`trace-${turn.key}-${idx}-${autoCollapseSteps ? "c" : "e"}`}
                                      steps={traceSteps}
                                      provider={activeSession.agent_kind}
                                      startedAtMs={
                                        isLatestTurn ? activeTurnTiming?.startedAtMs : undefined
                                      }
                                      isTurnRunning={Boolean(
                                        isTurnRunning && endIdx === turn.items.length - 1
                                      )}
                                      defaultExpanded={!autoCollapseSteps}
                                      onOpenDiffForFile={openDiffForFile}
                                    />
                                  );
                                }

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
                                      showLivePreview={
                                        (activeSession.agent_kind || "claude").toLowerCase() ===
                                        "claude"
                                      }
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
                                    isActive={Boolean(isTurnRunning && isLastTurnItem)}
                                    onOpenDiffTab={() => openDiffForFile(ev.tool_args)}
                                  />
                                );
                              }

                              const errBanner = parseAgentErrorBanner(
                                ev.content,
                                activeSession.agent_kind || "claude"
                              );
                              if (errBanner) {
                                return (
                                  <div
                                    key={ev.id}
                                    data-testid="agent-error-banner"
                                    className={`my-1.5 flex w-full flex-col gap-2.5 rounded-xl border px-3.5 py-3 ${
                                      errBanner.isAuthRequired
                                        ? "border-amber-500/35 bg-amber-500/[0.07]"
                                        : "border-red-500/35 bg-red-500/[0.07]"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex items-center gap-2">
                                        <Lock
                                          className={`h-3.5 w-3.5 shrink-0 ${
                                            errBanner.isAuthRequired
                                              ? "text-amber-400"
                                              : "text-red-400"
                                          }`}
                                        />
                                        <span
                                          className={`text-[12.5px] font-semibold ${
                                            errBanner.isAuthRequired
                                              ? "text-amber-400"
                                              : "text-red-400"
                                          }`}
                                        >
                                          {errBanner.isAuthRequired
                                            ? "CLI 认证已失效 · 需要重新登录"
                                            : "CLI 执行错误"}
                                        </span>
                                      </div>
                                      <span className="font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                                        {ev.timestamp}
                                      </span>
                                    </div>

                                    <div className="text-[12.5px] leading-relaxed text-[var(--v-fg-primary)] break-words">
                                      {errBanner.message}
                                    </div>

                                    {errBanner.isAuthRequired && (
                                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            if (
                                              !sendE2eeCommand({
                                                cmd: "launch_cli_login",
                                                provider: errBanner.provider,
                                              })
                                            ) {
                                              fetch(
                                                `${daemonUrl}/api/providers/${encodeURIComponent(
                                                  errBanner.provider
                                                )}/login`,
                                                { method: "POST" }
                                              )
                                                .then((r) => r.json())
                                                .then((d) => {
                                                  if (d?.message) {
                                                    setGitActionNotice(String(d.message));
                                                    window.setTimeout(
                                                      () => setGitActionNotice(null),
                                                      3500
                                                    );
                                                  }
                                                })
                                                .catch(() => {});
                                            }
                                          }}
                                          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-[11.5px] font-semibold text-black hover:bg-amber-400"
                                        >
                                          <Terminal className="h-3.5 w-3.5" />
                                          在 Mac 终端一键登录 ({errBanner.loginCommand})
                                        </button>

                                        {errBanner.authUrl && (
                                          <a
                                            href={errBanner.authUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)]"
                                          >
                                            <Globe className="h-3.5 w-3.5" />
                                            打开浏览器授权页 ↗
                                          </a>
                                        )}
                                      </div>
                                    )}
                                  </div>
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
                                    resolveImageUrl={resolveAttachmentUrl}
                                    onOpenFileLink={handleOpenLocalFileLink}
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
                            {/* Structured Plan Mode Quick Execute Card */}
                            {(() => {
                              if (!isLatestTurn || isTurnRunning || isSessionRunning) return null;
                              const assistantTxt = turn.items
                                .filter((it) => it.kind === "assistant")
                                .map((it) => it.content)
                                .join("\n");
                              const looksLikePlan =
                                /(?:^|\n)#{1,3}\s*(?:Implementation Plan|实施计划|实现计划|行动计划|Plan\b)/i.test(
                                  assistantTxt
                                ) || assistantTxt.includes("<plan>");
                              if (!looksLikePlan) return null;
                              return (
                                <div className="mb-2 mt-1 flex items-center justify-between gap-3 rounded-xl border border-[#34d399]/30 bg-[#34d399]/8 px-3.5 py-2.5">
                                  <div className="min-w-0">
                                    <div className="text-[12px] font-semibold text-[#34d399]">
                                      检测到结构化实施计划
                                    </div>
                                    <div className="text-[11px] text-[var(--v-fg-muted)]">
                                      确认方案无误后，可一键授权 Agent 开始按计划落地修改
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleSendPrompt(
                                        "计划确认无误，请按上述实施方案开始逐步落地代码修改并完成验证。"
                                      )
                                    }
                                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#34d399] px-3 py-1.5 text-[12px] font-semibold text-black hover:opacity-90 cursor-pointer"
                                  >
                                    <Play className="h-3 w-3 fill-current" />
                                    <span>批准并执行计划</span>
                                  </button>
                                </div>
                              );
                            })()}

                            {!(
                              isTurnRunning &&
                              !waitingLabel &&
                              isFocusFootprintProvider(activeSession.agent_kind) &&
                              lastTurnItem &&
                              (lastTurnItem.kind === "thinking" ||
                                lastTurnItem.kind === "tool_call")
                            ) && (
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
                              telemetry={{
                                insertions: isLatestTurn ? activeSession.insertions : 0,
                                deletions: isLatestTurn ? activeSession.deletions : 0,
                                tps:
                                  isLatestTurn && isTurnRunning
                                    ? activeTurnTiming?.liveTps ?? turn.userEv?.tps
                                    : turn.userEv?.tps,
                                inputTokens:
                                  turn.userEv?.input_tokens ??
                                  (isLatestTurn ? activeSession.input_tokens : undefined),
                                outputTokens: turn.userEv?.output_tokens,
                                cacheReadTokens:
                                  turn.userEv?.cache_read_tokens ??
                                  (isLatestTurn ? activeSession.cache_read_tokens : undefined),
                                costUsd: turn.userEv?.cost_usd,
                              }}
                              onOpenDiff={() => openDiffForFile()}
                              onRetry={
                                turn.userEv && !isSessionRunning
                                  ? () => handleRetryUserMessage(turn.userEv!)
                                  : undefined
                              }
                              onFork={
                                turn.userEv && !isSessionRunning
                                  ? () => {
                                      const userTurnsOnly = turns.filter((t) => t.userEv !== null);
                                      const userOrdinal = turns
                                        .slice(0, turnIdx + 1)
                                        .filter((t) => t.userEv !== null).length;
                                      const turnsFromEnd = Math.max(
                                        0,
                                        userTurnsOnly.length - userOrdinal
                                      );
                                      void handleForkSession(
                                        Math.max(1, userOrdinal),
                                        turn.userEv!.content,
                                        turnsFromEnd
                                      );
                                    }
                                  : undefined
                              }
                            />
                            )}
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

                {/* Inline Conversational Schedule Confirmation Card (`/schedule` or natural language) */}
                {pendingScheduleDraft && (
                  <div className="mb-2.5 rounded-xl border border-[#a78bfa]/35 bg-[var(--v-bg-surface)] px-3.5 py-3 shadow-lg">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#a78bfa]/18 text-[#a78bfa]">
                          <CalendarClock className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-[var(--v-fg-primary)]">
                            <span>确认创建定时任务</span>
                            <span className="rounded-md bg-[#34d399]/16 px-2 py-0.5 text-[11px] font-medium text-[#10b981] dark:text-[#34d399]">
                              {pendingScheduleDraft.parsed.schedule_text}
                            </span>
                            {pendingScheduleDraft.parsed.next_run_label && (
                              <span className="text-[11px] font-normal text-[var(--v-fg-muted)]">
                                下次：{pendingScheduleDraft.parsed.next_run_label}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-[12px] text-[var(--v-fg-secondary)]">
                            {pendingScheduleDraft.parsed.task_prompt || pendingScheduleDraft.rawInput}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPendingScheduleDraft(null)}
                        className="rounded-md p-1 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--v-border-subtle)] pt-2">
                      <span className="text-[11px] text-[var(--v-fg-muted)]">
                        工作区：{activeRepo.name} · 引擎：{pendingScheduleDraft.provider}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            const txt = pendingScheduleDraft.rawInput;
                            setPendingScheduleDraft(null);
                            bypassScheduleInterceptRef.current = true;
                            void handleSendPrompt(txt);
                          }}
                          className="rounded-md border border-[var(--v-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                        >
                          仅作为普通对话发送
                        </button>
                        <button
                          type="button"
                          disabled={pendingScheduleDraft.saving}
                          onClick={async () => {
                            const draft = pendingScheduleDraft;
                            setPendingScheduleDraft({ ...draft, saving: true });
                            try {
                              const res = await fetch(`${daemonUrl}/api/automations`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  name: draft.parsed.suggested_name || "定时任务",
                                  enabled: true,
                                  trigger_type: draft.parsed.trigger_type,
                                  cron_expr: draft.parsed.cron_expr || null,
                                  run_at: draft.parsed.run_at || null,
                                  schedule_text: draft.parsed.schedule_text,
                                  natural_input: draft.rawInput,
                                  repo_path: draft.repoPath,
                                  branch_prefix: "auto/hub",
                                  provider: draft.provider,
                                  model: draft.model,
                                  prompt_template:
                                    draft.parsed.task_prompt || draft.rawInput,
                                }),
                              });
                              if (res.ok) {
                                setEnabledAutomationsCount((c) => c + 1);
                                setPendingScheduleDraft(null);
                                setScheduleCreatedToast(
                                  `已创建定时任务：${draft.parsed.schedule_text} · ${
                                    draft.parsed.suggested_name || "已启用"
                                  }`
                                );
                                window.setTimeout(() => setScheduleCreatedToast(null), 4000);
                              } else {
                                setPendingScheduleDraft({ ...draft, saving: false });
                              }
                            } catch {
                              setPendingScheduleDraft({ ...draft, saving: false });
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded-md bg-[var(--v-btn-bg)] px-3 py-1 text-[11.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90 disabled:opacity-40 cursor-pointer"
                        >
                          <Check className="h-3 w-3" />
                          <span>{pendingScheduleDraft.saving ? "创建中…" : "确认启用"}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {scheduleCreatedToast && (
                  <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-[#34d399]/30 bg-[#34d399]/10 px-3 py-1.5 text-[11.5px] text-[#10b981] dark:text-[#34d399]">
                    <span className="truncate">{scheduleCreatedToast}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setScheduleCreatedToast(null);
                        setActiveModal("automations");
                      }}
                      className="shrink-0 underline hover:opacity-80 cursor-pointer"
                    >
                      查看全部
                    </button>
                  </div>
                )}

                {/* Slash Command Popover (Built-in Velo Workflow Actions + Prompt Skills + Real Local/Project Skills) */}
                {slashFilter !== null && (() => {
                  const q = slashFilter.trim().toLowerCase();
                  const builtinItems: Array<{
                    key: string;
                    cmd: string;
                    desc: string;
                    badge: string;
                    badgeTone: string;
                    run: () => void;
                  }> = [
                    {
                      key: "builtin:/rewind",
                      cmd: "/rewind",
                      desc: "打开每轮 Git 检查点并一键回滚代码",
                      badge: "Velo",
                      badgeTone: "bg-[#f59e0b]/15 text-[#fbbf24]",
                      run: () => {
                        setPrompt("");
                        setSlashFilter(null);
                        setExtCpInitialTab("checkpoints");
                        setExtCpModalOpen(true);
                      },
                    },
                    {
                      key: "builtin:/mcp",
                      cmd: "/mcp",
                      desc: "管理跨引擎 Skills、自定义技能与 MCP",
                      badge: "Velo",
                      badgeTone: "bg-[#8b5cf6]/15 text-[#a78bfa]",
                      run: () => {
                        setPrompt("");
                        setSlashFilter(null);
                        setExtCpInitialTab("extensions");
                        setExtCpModalOpen(true);
                      },
                    },
                    {
                      key: "builtin:/fork",
                      cmd: "/fork",
                      desc: "从当前会话一键分叉探索新分支思路",
                      badge: "Velo",
                      badgeTone: "bg-[#38bdf8]/15 text-[#38bdf8]",
                      run: () => {
                        setPrompt("");
                        setSlashFilter(null);
                        void handleForkSession();
                      },
                    },
                    {
                      key: "builtin:/cli",
                      cmd: "/cli",
                      desc: "接管与清理本机终端历史会话",
                      badge: "Velo",
                      badgeTone: "bg-[#34d399]/15 text-[#34d399]",
                      run: () => {
                        setPrompt("");
                        setSlashFilter(null);
                        setCliImportOpen(true);
                      },
                    },
                    {
                      key: "builtin:/schedule",
                      cmd: "/schedule",
                      desc: "白话文设定定时任务（如：/schedule 每天早上9点跑单测）",
                      badge: "定时",
                      badgeTone: "bg-[#a78bfa]/15 text-[#a78bfa]",
                      run: () => {
                        setSlashFilter(null);
                        setPrompt("/schedule ");
                        setTimeout(() => {
                          const el = composerTextareaRef.current;
                          if (!el) return;
                          el.focus();
                          el.setSelectionRange(10, 10);
                        }, 20);
                      },
                    },
                    {
                      key: "builtin:/hosts",
                      cmd: "/hosts",
                      desc: "管理多机与 SSH 远程服务器派发",
                      badge: "Velo",
                      badgeTone: "bg-[var(--v-bg-hover)] text-[var(--v-fg-muted)]",
                      run: () => {
                        setPrompt("");
                        setSlashFilter(null);
                        setHostsModalOpen(true);
                      },
                    },
                    ...SLASH_SKILLS.map((s) => ({
                      key: `slash:${s.cmd}`,
                      cmd: s.cmd,
                      desc: s.desc,
                      badge: "指令",
                      badgeTone: "bg-[var(--v-bg-hover)] text-[var(--v-fg-muted)]",
                      run: () => {
                        setSlashFilter(null);
                        void handleSendPrompt(`${s.cmd} `);
                      },
                    })),
                  ];

                  const realSkillItems = localSkills.map((sk) => {
                    const isProject = sk.scope === "project";
                    const isVelo = sk.engine === "velo" || sk.editable;
                    return {
                      key: `skill:${sk.path}`,
                      cmd: `/${sk.name}`,
                      desc: sk.description || sk.path,
                      badge: isProject ? `项目 · ${sk.engine}` : isVelo ? "Velo 技能" : sk.engine,
                      badgeTone: isProject
                        ? "bg-emerald-500/15 text-emerald-400"
                        : isVelo
                          ? "bg-[#8b5cf6]/15 text-[#a78bfa]"
                          : "bg-sky-500/15 text-sky-400",
                      run: () => {
                        const next = composerTextForSkill(
                          draftsLatestRef.current[activeSession.id] ?? "",
                          sk.name
                        );
                        setSlashFilter(null);
                        setPrompt(next);
                        setTimeout(() => {
                          const el = composerTextareaRef.current;
                          if (!el) return;
                          el.focus();
                          el.setSelectionRange(next.length, next.length);
                        }, 20);
                      },
                    };
                  });

                  const matches = (
                    items: typeof builtinItems
                  ) =>
                    items.filter(
                      (item) =>
                        !q ||
                        item.cmd.toLowerCase().includes(q) ||
                        item.desc.toLowerCase().includes(q) ||
                        item.badge.toLowerCase().includes(q)
                    );
                  const visibleSkills = matches(realSkillItems).slice(0, 8);
                  const visibleCommands = matches(builtinItems).slice(0, 6);
                  const hiddenSkills = Math.max(0, matches(realSkillItems).length - visibleSkills.length);
                  const combinedSlash = [...visibleSkills, ...visibleCommands];
                  slashActionRunnersRef.current = combinedSlash.map((it) => it.run);
                  const clampedSlashIdx =
                    combinedSlash.length > 0
                      ? Math.min(slashSelectedIdx, combinedSlash.length - 1)
                      : 0;

                  const renderItem = (item: (typeof builtinItems)[number], flatIdx: number) => {
                    const isActive = flatIdx === clampedSlashIdx;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onMouseEnter={() => setSlashSelectedIdx(flatIdx)}
                        onClick={item.run}
                        className={`block w-full overflow-hidden rounded-lg px-3 py-2 text-left transition-colors cursor-pointer ${
                          isActive
                            ? "bg-[var(--v-bg-active)]"
                            : "hover:bg-[var(--v-bg-active)]"
                        }`}
                      >
                        <div className="flex w-full min-w-0 items-center justify-between gap-2">
                          <div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12.5px] font-medium leading-snug text-[var(--v-fg-primary)]">
                            {item.cmd}
                          </div>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${item.badgeTone}`}
                          >
                            {item.badge}
                          </span>
                        </div>
                        <div className="mt-1 w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] leading-snug text-[var(--v-fg-muted)]">
                          {item.desc}
                        </div>
                      </button>
                    );
                  };

                  return (
                    <div className="mb-2 max-h-[320px] overflow-y-auto rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1.5 shadow-xl">
                      {visibleSkills.length === 0 && visibleCommands.length === 0 ? (
                        <div className="flex items-center justify-between px-3 py-2 text-[12px] text-[var(--v-fg-muted)]">
                          <span>没有匹配的指令或本地 Skill</span>
                          <button
                            type="button"
                            onClick={() => {
                              setSlashFilter(null);
                              setExtCpInitialTab("extensions");
                              setExtCpModalOpen(true);
                            }}
                            className="font-medium text-[#a78bfa] hover:underline cursor-pointer"
                          >
                            打开 Skills 面板新建
                          </button>
                        </div>
                      ) : (
                        <>
                          {visibleSkills.length > 0 && (
                            <div className="px-2 pb-1 pt-1 text-[10.5px] font-medium tracking-wide text-[var(--v-fg-faint)]">
                              Skills
                            </div>
                          )}
                          {visibleSkills.map((it, i) => renderItem(it, i))}
                          {hiddenSkills > 0 && (
                            <div className="flex items-center justify-between px-3 pb-1 text-[11px] text-[var(--v-fg-faint)]">
                              <span>还有 {hiddenSkills} 个 Skill，继续输入筛选</span>
                              <button
                                type="button"
                                onClick={() => {
                                  setSlashFilter(null);
                                  setExtCpInitialTab("extensions");
                                  setExtCpModalOpen(true);
                                }}
                                className="text-[#a78bfa] hover:underline cursor-pointer"
                              >
                                查看全部
                              </button>
                            </div>
                          )}
                          {visibleCommands.length > 0 && (
                            <div
                              className={`px-2 pb-1 pt-1.5 text-[10.5px] font-medium tracking-wide text-[var(--v-fg-faint)] ${
                                visibleSkills.length > 0
                                  ? "mt-1 border-t border-[var(--v-border-subtle)]"
                                  : ""
                              }`}
                            >
                              内置命令
                            </div>
                          )}
                          {visibleCommands.map((it, i) => renderItem(it, visibleSkills.length + i))}
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* `@` Workspace File Mention Popover */}
                {fileMentionQuery !== null && (
                  <div className="mb-2 max-h-[240px] overflow-y-auto rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1.5 shadow-2xl">
                    <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-medium text-[var(--v-fg-muted)]">
                      <span>
                        引用工作区文件 {fileMentionQuery ? `· "${fileMentionQuery}"` : "· 最近变更优先"}
                      </span>
                      <span className="font-mono text-[10px]">↑↓ 选择 · Enter 插入 · Esc 关闭</span>
                    </div>
                    {fileMentionResults.length === 0 ? (
                      <div className="px-2.5 py-2 text-[11.5px] text-[var(--v-fg-muted)]">
                        未找到匹配的工作区文件
                      </div>
                    ) : (
                      fileMentionResults.map((item, idx) => {
                        const active = idx === fileMentionIdx;
                        return (
                          <button
                            key={item.abs_path}
                            type="button"
                            onMouseEnter={() => setFileMentionIdx(idx)}
                            onClick={() => handleSelectFileMention(item)}
                            className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors cursor-pointer ${
                              active
                                ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                                : "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)]"
                            }`}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)]" />
                              <span className="truncate font-mono font-medium">{item.name}</span>
                              {item.dir && (
                                <span className="truncate font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                                  {item.dir}
                                </span>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {item.modified && (
                                <span className="rounded bg-[#34d399]/15 px-1.5 py-0.5 text-[9.5px] font-medium text-[#34d399]">
                                  M
                                </span>
                              )}
                              {item.size > 0 && (
                                <span className="font-mono text-[10px] text-[var(--v-fg-faint)]">
                                  {formatCompactFileSize(item.size)}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}

                {/* Docked Neutral Frosted Queue Tray (Right above Composer Card) */}
                <QueuedPromptsBar
                  items={activeSession.queued_prompts || []}
                  onRemove={(qid) => void handleRemoveQueuedPrompt(qid)}
                  onRunNow={(qid) => void handleRunQueuedNow(qid)}
                  onEditBack={(item) => handleEditBackQueuedPrompt(item)}
                  onReorder={(qid, dir) => void handleReorderQueuedPrompt(qid, dir)}
                  onClearAll={() => void handleClearAllQueuedPrompts()}
                />

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
                  className={`${
                    (activeSession.queued_prompts || []).length > 0
                      ? "rounded-b-[18px] rounded-t-[10px]"
                      : "rounded-[18px]"
                  } border bg-[var(--v-bg-surface)] px-4 pb-2.5 pt-3 shadow-lg transition-colors focus-within:border-[var(--v-fg-muted)] ${
                    composerDragOver
                      ? "border-[#34d399] ring-1 ring-[#34d399]/40"
                      : "border-[var(--v-border-strong)]"
                  }`}
                >
                  {/* Hidden file input for any local file or image picker */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleUploadImageFiles(e.target.files);
                        e.target.value = "";
                      }
                    }}
                  />

                  {/* Pending Multimodal Image & File Attachments Strip (Per-Session Isolated) */}
                  {(pendingAttachments.length > 0 || uploadingAttachment) && (
                    <div className="mb-2.5 flex flex-wrap items-center gap-2">
                      {pendingAttachments.map((att, attIdx) =>
                        att.isImage !== false ? (
                          <div
                            key={`${att.filename}-${attIdx}`}
                            className="group/att relative overflow-hidden rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)]"
                          >
                            <img
                              src={att.url}
                              alt={att.displayName || att.filename}
                              className="h-14 w-14 object-cover"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setPendingAttachments((prev) =>
                                  prev.filter((_, i) => i !== attIdx)
                                )
                              }
                              title="移除图片"
                              className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/75 text-white opacity-0 transition-opacity group-hover/att:opacity-100 cursor-pointer"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        ) : (
                          <div
                            key={`${att.path}-${attIdx}`}
                            title={att.path}
                            className="group/att inline-flex max-w-[260px] items-center gap-1.5 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1 text-[11.5px] text-[var(--v-fg-body)]"
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-[#a78bfa]" />
                            <span className="truncate font-mono">
                              {att.relPath ? `@${att.relPath}` : att.displayName || att.filename}
                            </span>
                            {att.size ? (
                              <span className="shrink-0 font-mono text-[10px] text-[var(--v-fg-muted)]">
                                {formatCompactFileSize(att.size)}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              onClick={() =>
                                setPendingAttachments((prev) =>
                                  prev.filter((_, i) => i !== attIdx)
                                )
                              }
                              title="移除文件"
                              className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[#f87171] cursor-pointer"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        )
                      )}
                      {uploadingAttachment && (
                        <div className="flex h-8 items-center rounded-lg border border-dashed border-[var(--v-border-strong)] px-3 font-mono text-[11px] text-[var(--v-fg-muted)]">
                          正在上传附件…
                        </div>
                      )}
                    </div>
                  )}

                  <IsolatedComposerTextarea
                    sessionId={activeSession.id}
                    initialValue={draftsLatestRef.current[activeSession.id] ?? ""}
                    programmaticNonce={promptProgrammaticNonce}
                    textareaRef={composerTextareaRef}
                    onLiveChange={handleComposerLiveChange}
                    onCommitDraft={commitDraftToState}
                      onPaste={(e) => {
                        const items = e.clipboardData?.items;
                        if (!items) return;
                        const pastedFiles: File[] = [];
                        for (let i = 0; i < items.length; i++) {
                          if (items[i].kind === "file") {
                            const file = items[i].getAsFile();
                            if (file) pastedFiles.push(file);
                          }
                        }
                        if (pastedFiles.length > 0) {
                          e.preventDefault();
                          handleUploadImageFiles(pastedFiles);
                        }
                      }}
                      onKeyDown={(e) => {
                        // Guard macOS Chinese/Japanese IME composition so pressing Enter to commit Pinyin never sends!
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (slashFilter !== null && slashActionRunnersRef.current.length > 0) {
                          const total = slashActionRunnersRef.current.length;
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setSlashSelectedIdx((i) => (i + 1) % total);
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setSlashSelectedIdx((i) => (i - 1 + total) % total);
                            return;
                          }
                          if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            const fn =
                              slashActionRunnersRef.current[
                                Math.min(slashSelectedIdx, total - 1)
                              ] || slashActionRunnersRef.current[0];
                            fn?.();
                            return;
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setSlashFilter(null);
                            return;
                          }
                        }
                        if (fileMentionQuery !== null) {
                          if (e.key === "ArrowDown" && fileMentionResults.length > 0) {
                            e.preventDefault();
                            setFileMentionIdx((i) => (i + 1) % fileMentionResults.length);
                            return;
                          }
                          if (e.key === "ArrowUp" && fileMentionResults.length > 0) {
                            e.preventDefault();
                            setFileMentionIdx(
                              (i) => (i - 1 + fileMentionResults.length) % fileMentionResults.length
                            );
                            return;
                          }
                          if ((e.key === "Enter" || e.key === "Tab") && fileMentionResults.length > 0) {
                            e.preventDefault();
                            const chosen = fileMentionResults[fileMentionIdx] || fileMentionResults[0];
                            if (chosen) handleSelectFileMention(chosen);
                            return;
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setFileMentionQuery(null);
                            return;
                          }
                        }
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (
                            activeSession.status === "running" ||
                            activeSession.status === "waiting_approval"
                          ) {
                            void handleSendPrompt(
                              undefined,
                              undefined,
                              undefined,
                              undefined,
                              e.metaKey || e.altKey ? "steer" : "queue"
                            );
                          } else {
                            void handleSendPrompt();
                          }
                        }
                      }}
                      placeholder={
                        activeSession.status === "running" ||
                        activeSession.status === "waiting_approval"
                          ? "正在执行中… 输入新指令按 Enter 排队，按 ⌘Enter 直接插队执行（支持 @ 引用文件）"
                          : `Ask ${
                              modelCatalog.find((m) => m.id === activeSession.model)?.label ||
                              activeSession.model_short
                            } anything... (@ 引用文件 · / 技能 · 拖拽或 ⌘V 粘贴任意文件/截图)`
                      }
                    />

                  {/* Composer Bottom Toolbar: Concrete Model Picker (Claude / Codex / ACP) + Effort + Permission Mode */}
                  <div className="relative mt-1.5 flex flex-wrap items-center justify-between gap-2">
                    {/* 1. Categorized & Searchable Engine + Model Picker Popover */}
                    {modelPickerOpen && (
                      <ModelPickerPopover
                        modelCatalog={modelCatalog}
                        runtimes={runtimes}
                        activeAgentKind={activeSession.agent_kind}
                        activeModelId={activeCatalogModel?.id || activeSession.model}
                        isSessionBound={(eventsBySession[activeSession.id]?.length ?? 0) > 0}
                        customAcpCmd={customAcpCmd}
                        onChangeCustomAcpCmd={setCustomAcpCmd}
                        onBindCustomAcp={() => {
                          const cmd = customAcpCmd.trim();
                          if (!cmd) return;
                          const acpSpec = cmd.startsWith("acp:") ? cmd : `acp:${cmd}`;
                          const short = cmd.split(/\s+/)[0] || "ACP";
                          void handleSelectSessionModel(
                            {
                              id: acpSpec,
                              label: `ACP · ${short}`,
                              shortLabel: `ACP · ${short}`,
                              family: "ACP · Custom",
                              runtimeId: "acp",
                              agentKind: acpSpec as AgentKind,
                              desc: cmd,
                              installed: true,
                            },
                            false
                          );
                        }}
                        onSelectModel={(m, isHandoff) => {
                          void handleSelectSessionModel(m, isHandoff);
                        }}
                        onOpenSettings={() => {
                          setModelPickerOpen(false);
                          setHookEditCmd(repoHooks[activeRepo.path] || "");
                          setActiveModal("settings");
                        }}
                        onClose={() => setModelPickerOpen(false)}
                      />
                    )}

                    {/* 2. Reasoning Effort Popover (Strictly scoped to active model's real supportedEfforts) */}
                    {effortPickerOpen && activeSupportedEfforts.length > 0 && (
                      <>
                        <div
                          className="fixed inset-0 z-20"
                          onClick={() => setEffortPickerOpen(false)}
                          aria-hidden="true"
                        />
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute bottom-9 left-[165px] z-30 w-[176px] rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-1.5 shadow-2xl"
                        >
                          <div className="px-2.5 py-1 text-[10.5px] font-medium text-[var(--v-fg-muted)]">
                            思考 / 推理强度
                          </div>
                          {activeSupportedEfforts.map((eff) => {
                            const active = activeEffectiveEffort === eff;
                            return (
                              <button
                                key={eff}
                                type="button"
                                onClick={() => handleSelectSessionEffort(eff)}
                                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] cursor-pointer ${
                                  active
                                    ? "bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                                    : "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)]"
                                }`}
                              >
                                <span>{EFFORT_DISPLAY_LABELS[eff] || eff}</span>
                                {active && <Check className="h-3.5 w-3.5 text-[#34d399]" />}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* Pill 1: Concrete Engine + Model Picker */}
                      {(() => {
                        const engTab = ENGINE_TABS.find(
                          (t) => t.key === getEngineTabForAgentKind(activeSession.agent_kind)
                        );
                        return (
                          <button
                            type="button"
                            onClick={() => {
                              setEffortPickerOpen(false);
                              setModelPickerOpen((o) => !o);
                            }}
                            title="切换引擎或模型（支持搜索与按厂商分类筛选）"
                            className="flex items-center gap-1.5 rounded-full bg-[var(--v-bg-active)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--v-fg-body)] transition-colors hover:bg-[var(--v-bg-hover)] cursor-pointer"
                          >
                            <EngineBrandGlyph
                              engine={activeSession.agent_kind}
                              size={12.5}
                              colored
                              className="shrink-0"
                            />
                            {engTab && (
                              <span className="font-mono text-[10px] text-[var(--v-fg-muted)]">
                                {engTab.shortLabel}
                              </span>
                            )}
                            <span>
                              {activeCatalogModel?.label ||
                                activeSession.model_short ||
                                activeSession.model}
                            </span>
                            <ChevronDown className="h-3 w-3 text-[var(--v-fg-muted)]" />
                          </button>
                        );
                      })()}

                      {/* Pill 2: Reasoning Effort (Only shown when the selected model supports configurable effort) */}
                      {activeSupportedEfforts.length > 0 && (
                        <button
                          type="button"
                          disabled={activeSupportedEfforts.length === 1}
                          onClick={() => {
                            setModelPickerOpen(false);
                            setEffortPickerOpen((o) => !o);
                          }}
                          title="当前模型支持的思考 / 推理强度"
                          className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] text-[var(--v-fg-muted)] transition-colors ${
                            activeSupportedEfforts.length > 1
                              ? "hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-body)] cursor-pointer"
                              : "opacity-65 cursor-default"
                          }`}
                        >
                          <span>
                            {EFFORT_DISPLAY_LABELS[activeEffectiveEffort] || activeEffectiveEffort}
                          </span>
                          {activeSupportedEfforts.length > 1 && (
                            <ChevronDown className="h-3 w-3 opacity-60" />
                          )}
                        </button>
                      )}

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

                      {/* Pill 4: Attach Any Local File or Screenshot (Drag & Drop, Paste, or Picker) */}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        title="附加本地文件或图片（支持拖拽、⌘V 粘贴，或输入 @ 引用工作区文件）"
                        className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Right Controls: BeautifulContextMeter (Real Token & USD Telemetry) + Submit / Stop Disc */}
                    <div className="flex items-center gap-2">
                      <BeautifulContextMeter
                        usedTokens={activeSession.tokens_used || 0}
                        maxTokens={activeSession.tokens_limit || 200000}
                        costUsd={activeSession.cost_usd || 0}
                      />
                      {activeSession.status === "running" ||
                      activeSession.status === "waiting_approval" ? (
                        <div className="flex items-center gap-1.5">
                          {(hasComposerText || pendingAttachments.length > 0) && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleSendPrompt(
                                    undefined,
                                    undefined,
                                    undefined,
                                    undefined,
                                    "queue"
                                  )
                                }
                                title="加入队列：当前轮完成后自动执行 (Enter)"
                                className="flex h-7 items-center gap-1 rounded-full bg-[#a78bfa]/18 px-2.5 text-[11.5px] font-medium text-[#a78bfa] transition-colors hover:bg-[#a78bfa]/28 cursor-pointer"
                              >
                                <span>排队</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleSendPrompt(
                                    undefined,
                                    undefined,
                                    undefined,
                                    undefined,
                                    "steer"
                                  )
                                }
                                title="插队执行：立即打断当前执行并马上跑这条指令 (⌘Enter)"
                                className="flex h-7 items-center gap-1 rounded-full bg-[#fbbf24]/20 px-2.5 text-[11.5px] font-semibold text-[#fbbf24] transition-colors hover:bg-[#fbbf24]/30 cursor-pointer"
                              >
                                <span>插队执行</span>
                              </button>
                            </>
                          )}
                          <button
                            onClick={handleStopSession}
                            title="停止当前执行 (Stop)"
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-[var(--v-btn-bg)] text-[var(--v-btn-fg)] transition-all hover:opacity-90"
                          >
                            <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleSendPrompt()}
                          disabled={!hasComposerText && pendingAttachments.length === 0}
                          className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${
                            hasComposerText || pendingAttachments.length > 0
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
                  {(() => {
                    const explicitDiffCollapsed = diffFilesCollapsedBySession[activeSession.id];
                    const isDiffListCollapsed =
                      explicitDiffCollapsed !== undefined
                        ? explicitDiffCollapsed
                        : activeDiffFiles.length > 5;
                    const visibleDiffFiles = isDiffListCollapsed
                      ? activeDiffFiles.slice(0, 5)
                      : activeDiffFiles;
                    return (
                      <div className="border-b border-[var(--v-border-subtle)] p-2.5">
                        {activeDiffFiles.length > 5 && (
                          <div className="mb-1.5 flex items-center justify-between px-0.5 text-[10.5px] text-[var(--v-fg-muted)]">
                            <span>变更文件 ({activeDiffFiles.length})</span>
                            <button
                              type="button"
                              onClick={() =>
                                setDiffFilesCollapsedBySession((prev) => ({
                                  ...prev,
                                  [activeSession.id]: !isDiffListCollapsed,
                                }))
                              }
                              className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                            >
                              {isDiffListCollapsed
                                ? `展开全部 (+${activeDiffFiles.length - 5})`
                                : "收起列表"}
                            </button>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-1">
                          {visibleDiffFiles.map((file) => {
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
                      </div>
                    );
                  })()}

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
          defaultProvider={activeSession.agent_kind}
          repos={repos}
          onClose={() => setActiveModal(null)}
          onJumpToSession={(sid) => {
            refreshSessions();
            setActiveId(sid);
          }}
          onCountChange={setEnabledAutomationsCount}
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
                      <label className="mb-1.5 block text-[11.5px] text-[var(--v-fg-secondary)]">
                        引擎与模型 (Model / ACP Provider)
                      </label>
                      <InlineModelSelectorGrid
                        modelCatalog={modelCatalog}
                        runtimes={runtimes}
                        selectedModelId={newModelId}
                        onSelectModelId={setNewModelId}
                      />
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
                <div className="mb-3.5 flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                    添加 / 新建工作区文件夹
                  </h3>
                  <button
                    type="button"
                    onClick={() => setActiveModal(null)}
                    className="text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Mode Switcher: Create New Local Folder vs Add Existing Folder */}
                <div className="mb-3.5 grid grid-cols-2 gap-1 rounded-lg bg-[var(--v-bg-sidebar)] p-1 text-[12px]">
                  <button
                    type="button"
                    onClick={() => setNewRepoMode("create")}
                    className={`rounded-md py-1.5 font-medium transition-colors cursor-pointer ${
                      newRepoMode === "create"
                        ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                        : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                    }`}
                  >
                    新建本地文件夹
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewRepoMode("existing")}
                    className={`rounded-md py-1.5 font-medium transition-colors cursor-pointer ${
                      newRepoMode === "existing"
                        ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                        : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                    }`}
                  >
                    选择已有文件夹
                  </button>
                </div>

                {newRepoMode === "create" ? (
                  <div className="space-y-3 text-[12.5px]">
                    <div>
                      <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                        存放位置（父目录）
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          value={newFolderParent}
                          onChange={(e) => setNewFolderParent(e.target.value)}
                          placeholder="~/code"
                          className="flex-1 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void handlePickRepoFolder("parent")}
                          className="shrink-0 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-active)] px-3 py-2 text-[12px] text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                        >
                          选择位置…
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-[11.5px] text-[var(--v-fg-secondary)]">
                        新文件夹名称
                      </label>
                      <input
                        autoFocus
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newFolderName.trim()) {
                            void handleCreateRepo();
                          }
                        }}
                        placeholder="例如 my-next-app 或 ai-demo"
                        className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[12px] text-[var(--v-fg-primary)] focus:border-[var(--v-fg-muted)] focus:outline-none"
                      />
                    </div>

                    <div className="rounded-lg bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[11px] text-[var(--v-fg-muted)]">
                      将创建：
                      <span className="text-[var(--v-fg-primary)]">
                        {`${(newFolderParent.trim() || "~/code").replace(/\/+$/, "")}/${
                          newFolderName.trim().replace(/^\/+/, "") || "<文件夹名>"
                        }`}
                      </span>
                    </div>

                    <label className="flex items-center gap-2 text-[12px] text-[var(--v-fg-secondary)] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={newFolderInitGit}
                        onChange={(e) => setNewFolderInitGit(e.target.checked)}
                        className="rounded border-[var(--v-border-strong)] accent-[#8b5cf6]"
                      />
                      <span>同时初始化 Git 仓库（支持 Diff 审查与每轮检查点回滚）</span>
                    </label>

                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setActiveModal(null)}
                        className="rounded-lg px-3 py-1.5 text-[12.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={!newFolderName.trim()}
                        onClick={() => void handleCreateRepo()}
                        className="rounded-lg bg-[var(--v-btn-bg)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90 disabled:opacity-40 cursor-pointer"
                      >
                        创建文件夹并开始
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={newRepoPath}
                        onChange={(e) => setNewRepoPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newRepoPath.trim()) {
                            void handleCreateRepo();
                          }
                        }}
                        placeholder="/path/to/project"
                        className="flex-1 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3 py-2 font-mono text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void handlePickRepoFolder("existing")}
                        className="shrink-0 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-active)] px-3 py-2 text-[12px] text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                      >
                        从 Finder 选择…
                      </button>
                    </div>
                    <p className="text-[11px] text-[var(--v-fg-muted)]">
                      可直接从 Finder 选择已有项目目录，或手动输入完整路径（目录不存在时将自动创建）。
                    </p>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setActiveModal(null)}
                        className="rounded-lg px-3 py-1.5 text-[12.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={!newRepoPath.trim()}
                        onClick={() => void handleCreateRepo()}
                        className="rounded-lg bg-[var(--v-btn-bg)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90 disabled:opacity-40 cursor-pointer"
                      >
                        添加工作区
                      </button>
                    </div>
                  </div>
                )}
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
                        CLI &amp; ACP Providers (Claude, Codex, Antigravity `agy`, Grok, Cursor, OpenCode, Copilot, Qwen)
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
                          { id: "paseo", label: "Forest" },
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
                                {pairTicket?.custom_relay_url
                                  ? "固定域名私有盲中继已锁定（重启永久免重扫）"
                                  : pairTicket?.relay_url?.startsWith("wss://")
                                  ? "公网 TLS 1.3 零信任盲中继已就绪（临时隧道）"
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

                        <div className="rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] px-3 py-2 text-[11.5px]">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 font-medium text-[var(--v-fg-primary)]">
                                <span
                                  className="h-2 w-2 rounded-full"
                                  style={{
                                    background: serviceStatus?.plist_installed
                                      ? "#34d399"
                                      : "#71717a",
                                  }}
                                />
                                <span>macOS 开机无感常驻 (LaunchAgent)</span>
                                {serviceStatus?.launchd_pid && (
                                  <span className="font-mono text-[10px] text-[var(--v-fg-muted)]">
                                    PID {serviceStatus.launchd_pid}
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 text-[10.5px] text-[var(--v-fg-muted)]">
                                关闭桌面窗口或重启 Mac 后后台守护进程自动常驻，手机随时跨网唤醒
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                disabled={serviceUpdating}
                                onClick={() =>
                                  handleUpdateSystemService({
                                    prevent_idle_sleep: !(
                                      serviceStatus?.prevent_idle_sleep ?? true
                                    ),
                                  })
                                }
                                title="使用 caffeinate -i 阻止空闲网络休眠（允许屏幕正常熄灭）"
                                className={`rounded-md border px-2 py-1 text-[10.5px] cursor-pointer ${
                                  serviceStatus?.prevent_idle_sleep
                                    ? "border-[#34d399]/40 bg-[#34d399]/10 text-[#34d399]"
                                    : "border-[var(--v-border-subtle)] text-[var(--v-fg-muted)]"
                                }`}
                              >
                                {serviceStatus?.prevent_idle_sleep
                                  ? "息屏不断连: 开"
                                  : "息屏不断连: 关"}
                              </button>
                              <button
                                type="button"
                                disabled={serviceUpdating}
                                onClick={() =>
                                  handleUpdateSystemService({
                                    action: serviceStatus?.plist_installed
                                      ? "uninstall"
                                      : "install",
                                  })
                                }
                                className="rounded-md bg-[var(--v-bg-active)] px-2.5 py-1 text-[11px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                              >
                                {serviceUpdating
                                  ? "配置中…"
                                  : serviceStatus?.plist_installed
                                  ? "已开启开机自启"
                                  : "开启开机常驻"}
                              </button>
                            </div>
                          </div>
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
      <AnalyticsAndPushModal
        open={analyticsModalOpen}
        initialTab={analyticsInitialTab}
        daemonUrl={daemonUrl}
        onClose={() => setAnalyticsModalOpen(false)}
        onSelectSession={(sid) => {
          setActiveId(sid);
          syncSessionEventsFromDaemon(sid);
        }}
      />
      <CliSessionsModal
        open={cliImportOpen}
        daemonUrl={daemonUrl}
        externalSessions={e2eeCliSessions}
        externalHiddenCount={e2eeCliHiddenCount}
        onRequestE2eeList={() => sendE2eeCommand({ cmd: "list_cli_sessions" })}
        onImportViaE2ee={(prov, cSid) =>
          sendE2eeCommand({
            cmd: "import_cli_session",
            provider: prov,
            cli_session_id: cSid,
          })
        }
        onManageViaE2ee={(action, items) =>
          sendE2eeCommand({
            cmd: "manage_cli_sessions",
            action,
            items,
          })
        }
        onImportedSession={(rawSess) => {
          const imported = normalizeToVeloSession(rawSess, 0);
          setSessions((prev) => [imported, ...prev.filter((s) => s.id !== imported.id)]);
          setActiveId(imported.id);
          syncSessionEventsFromDaemon(imported.id);
        }}
        onClose={() => setCliImportOpen(false)}
      />
      <RemoteHostsModal
        open={hostsModalOpen}
        daemonUrl={daemonUrl}
        localDaemonUrl={localDaemonUrl}
        onSwitchControlPlane={(targetUrl) => handleSwitchControlPlane(targetUrl)}
        onHostsUpdated={(list) => setFederatedHosts(list)}
        onDispatchedSession={(rawSess) => {
          const created = normalizeToVeloSession(rawSess, 0);
          setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
          setActiveId(created.id);
          syncSessionEventsFromDaemon(created.id);
        }}
        onClose={() => setHostsModalOpen(false)}
      />
      <ExtensionsAndCheckpointsModal
        open={extCpModalOpen}
        initialTab={extCpInitialTab}
        daemonUrl={daemonUrl}
        sessionId={activeSession?.id ?? null}
        sessionTitle={activeSession?.title ?? "当前会话"}
        workspacePath={activeSession?.project_path || activeRepo?.path}
        onUseSkill={(sk) => {
          setPrompt((cur) => {
            const next = composerTextForSkill(cur, sk.name);
            setTimeout(() => {
              const el = composerTextareaRef.current;
              if (!el) return;
              el.focus();
              el.setSelectionRange(next.length, next.length);
            }, 60);
            return next;
          });
        }}
        onRunSlashCommand={(cmd) => {
          void handleSendPrompt(cmd);
        }}
        onSkillsUpdated={(skills) => {
          setLocalSkills(skills);
        }}
        onRewound={() => {
          if (activeSession?.id) {
            syncSessionEventsFromDaemon(activeSession.id);
          }
        }}
        onClose={() => setExtCpModalOpen(false)}
      />

      {sessionPendingDelete && (
        <div
          onClick={() => setSessionPendingDelete(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
        >
          <div
            role="alertdialog"
            aria-labelledby="delete-session-title"
            aria-describedby="delete-session-body"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[420px] rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-5 shadow-2xl"
          >
            <div className="mb-2 flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-[#f87171]" />
              <span
                id="delete-session-title"
                className="text-[14px] font-semibold text-[var(--v-fg-primary)]"
              >
                删除会话？
              </span>
            </div>
            <p
              id="delete-session-body"
              className="text-[13px] leading-relaxed text-[var(--v-fg-secondary)]"
            >
              将永久删除「{sessionPendingDelete.title}」，对话记录和对应的 Git worktree
              会一起清掉。此操作无法撤销。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSessionPendingDelete(null)}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const targetId = sessionPendingDelete.id;
                  setSessionPendingDelete(null);
                  void handleDeleteSession(targetId);
                }}
                className="rounded-lg bg-[#f87171] px-3 py-1.5 text-[12.5px] font-medium text-black hover:opacity-90 cursor-pointer"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Relocate Folder / Rebind Session Workspace Path Modal */}
      {relocateTarget && (
        <div
          onClick={() => setRelocateTarget(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[460px] rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-5 shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Folder className="h-4 w-4 text-[#a78bfa]" />
                <span className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                  修改文件夹归属路径
                </span>
              </div>
              <button
                type="button"
                onClick={() => setRelocateTarget(null)}
                className="rounded-lg p-1 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {relocateTarget.sessionId && (
              <div className="mb-3 flex gap-1.5 rounded-lg bg-[var(--v-bg-hover)] p-1 text-[11.5px]">
                <button
                  type="button"
                  onClick={() => setRelocateTarget({ ...relocateTarget, mode: "session" })}
                  className={`flex-1 rounded-md py-1.5 font-medium transition-colors cursor-pointer ${
                    relocateTarget.mode === "session"
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  }`}
                >
                  仅更改当前会话归属目录
                </button>
                <button
                  type="button"
                  onClick={() => setRelocateTarget({ ...relocateTarget, mode: "workspace" })}
                  className={`flex-1 rounded-md py-1.5 font-medium transition-colors cursor-pointer ${
                    relocateTarget.mode === "workspace"
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  }`}
                >
                  迁移整个文件夹及旗下会话
                </button>
              </div>
            )}

            <div className="mb-2 text-[11.5px] text-[var(--v-fg-muted)]">
              原路径：<code className="font-mono text-[var(--v-fg-secondary)]">{relocateTarget.oldPath}</code>
            </div>

            <div className="flex items-center gap-2">
              <input
                autoFocus
                type="text"
                value={relocateTarget.newPath}
                onChange={(e) =>
                  setRelocateTarget({ ...relocateTarget, newPath: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCommitRelocatePath();
                  if (e.key === "Escape") setRelocateTarget(null);
                }}
                placeholder="/Users/you/code/project"
                className="flex-1 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-canvas)] px-3 py-2 font-mono text-[12.5px] text-[var(--v-fg-primary)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handlePickRelocateFolder()}
                className="shrink-0 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-hover)] px-3 py-2 text-[12px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-active)] cursor-pointer"
              >
                浏览选择…
              </button>
            </div>

            {repos.length > 0 && (
              <div className="mt-3">
                <div className="mb-1.5 text-[11px] text-[var(--v-fg-muted)]">快速选择已有工作区目录：</div>
                <div className="flex flex-wrap gap-1.5">
                  {repos.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() =>
                        setRelocateTarget({ ...relocateTarget, newPath: r.path })
                      }
                      className={`rounded-md border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                        canonicalRepoPath(relocateTarget.newPath) === canonicalRepoPath(r.path)
                          ? "border-[#8b5cf6] bg-[#8b5cf6]/15 text-[var(--v-fg-primary)]"
                          : "border-[var(--v-border-subtle)] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)]"
                      }`}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRelocateTarget(null)}
                className="rounded-lg px-3.5 py-1.5 text-[12.5px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleCommitRelocatePath()}
                disabled={!relocateTarget.newPath.trim()}
                className="rounded-lg bg-[var(--v-btn-bg)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90 disabled:opacity-40 cursor-pointer"
              >
                保存归属路径
              </button>
            </div>
          </div>
        </div>
      )}
      <ForkBranchModal
        target={forkLaunchTarget}
        models={modelCatalog}
        runtimes={runtimes}
        onClose={() => setForkLaunchTarget(null)}
        onConfirm={(payload) => void handleConfirmForkBranch(payload)}
      />
    </div>
  );
}
export default App;
