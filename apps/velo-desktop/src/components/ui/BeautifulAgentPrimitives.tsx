import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Eye,
  FileSymlink,
  GitFork,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";

/**
 * ============================================================================
 * 1. VERCEL AI ELEMENTS + PROMPT-KIT STATUS PRIMITIVES
 *    - `TextShimmer`: Smooth specular light band across active reasoning/working text
 *    - `PromptKitStatusIcon`: Retina orbital arc spinner & breathing Sparkles glyph
 *      (replaces smudgy 6-dot braille matrix in both Light & Dark themes)
 * ============================================================================
 */
export type AgentStatusPhase = "thinking" | "tool" | "working" | "writing" | "waiting";

export const TextShimmer: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => (
  <span className={`beautiful-shimmer-text ${className}`}>{children}</span>
);

export const PromptKitStatusIcon: React.FC<{
  phase?: AgentStatusPhase;
  size?: number;
}> = ({ phase = "working", size = 15 }) => {
  if (phase === "waiting") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
        data-testid="turn-working-indicator"
      >
        <ShieldAlert
          className="h-3.5 w-3.5 animate-pulse"
          style={{ color: "var(--status-warning)" }}
        />
      </span>
    );
  }

  if (phase === "thinking") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
        data-testid="turn-working-indicator"
      >
        <Sparkles
          className="h-3.5 w-3.5 velo-sparkle-breath"
          style={{ color: "var(--accent)" }}
        />
      </span>
    );
  }

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      data-testid="turn-working-indicator"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className="velo-orbital-spin"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke="var(--fg-extra-muted)"
          strokeOpacity="0.25"
          strokeWidth="1.75"
        />
        <path
          d="M14 8a6 6 0 0 0-6-6"
          stroke={phase === "writing" ? "var(--status-success)" : "var(--accent)"}
          strokeWidth="1.85"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
};

// Backwards-compatible alias if imported elsewhere
export const PaseoSyncedLoader: React.FC<{
  size?: number;
  color?: string;
}> = ({ size = 15 }) => <PromptKitStatusIcon phase="working" size={size} />;

/**
 * ============================================================================
 * 2. AI ELEMENTS + PROMPT-KIT LIVE STATUS & TURN FOOTER
 *    - Running: Crisp status icon + Shimmering phase text
 *      (`Thinking…` -> `Thinking for Xs` -> `Working · Searching…` -> `Working…` -> `Writing…`)
 *    - Completed: Copy + Retry + `Worked for Xs` (hover swaps to timestamp) + Diff pill
 * ============================================================================
 */
export function formatPaseoDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export const PaseoLiveElapsed: React.FC<{
  startedAtMs: number;
}> = ({ startedAtMs }) => {
  const [elapsedMs, setElapsedMs] = useState<number>(() =>
    Math.max(0, Date.now() - startedAtMs)
  );

  useEffect(() => {
    const update = () => setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAtMs]);

  return (
    <span
      className="text-[12.5px] tabular-nums select-none"
      style={{ color: "var(--fg-extra-muted)" }}
      data-testid="turn-working-elapsed"
    >
      {formatPaseoDuration(elapsedMs)}
    </span>
  );
};

export interface PaseoTurnTelemetry {
  insertions?: number;
  deletions?: number;
  tps?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export const PaseoTurnFooter: React.FC<{
  isRunning: boolean;
  phase?: AgentStatusPhase;
  statusLabel?: string;
  waitingLabel?: string;
  startedAtMs?: number;
  durationMs?: number;
  completedAtLabel?: string;
  assistantContent?: string;
  telemetry?: PaseoTurnTelemetry;
  onOpenDiff?: () => void;
  onRetry?: () => void;
  onFork?: () => void;
}> = ({
  isRunning,
  phase = "thinking",
  statusLabel,
  waitingLabel,
  startedAtMs,
  durationMs,
  completedAtLabel,
  assistantContent,
  telemetry,
  onOpenDiff,
  onRetry,
  onFork,
}) => {
  const [copied, setCopied] = useState(false);
  const [hoveredTiming, setHoveredTiming] = useState(false);
  const [liveMs, setLiveMs] = useState<number>(() =>
    startedAtMs ? Math.max(0, Date.now() - startedAtMs) : 0
  );

  useEffect(() => {
    if (!isRunning) return;
    const origin = startedAtMs || Date.now();
    const tick = () => setLiveMs(Math.max(0, Date.now() - origin));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning, startedAtMs]);

  const handleCopy = async () => {
    if (!assistantContent) return;
    try {
      await navigator.clipboard.writeText(assistantContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  if (isRunning) {
    const effectivePhase: AgentStatusPhase = waitingLabel ? "waiting" : phase;
    const liveSec = Math.max(0, Math.round(liveMs / 1000));
    const formattedElapsed = formatPaseoDuration(liveMs);

    let primaryStatus = statusLabel || "Working…";
    let showTrailingClock = true;

    if (waitingLabel) {
      primaryStatus = waitingLabel;
    } else if (effectivePhase === "thinking") {
      if (statusLabel) {
        primaryStatus = statusLabel;
      } else if (liveSec >= 1) {
        primaryStatus = `Thinking for ${formattedElapsed}…`;
        showTrailingClock = false;
      } else {
        primaryStatus = "Thinking…";
        showTrailingClock = false;
      }
    } else if (effectivePhase === "writing") {
      primaryStatus = statusLabel || "Writing…";
    } else if (effectivePhase === "tool") {
      primaryStatus = statusLabel || "Working…";
    } else {
      primaryStatus = statusLabel || "Working…";
    }

    return (
      <div
        className="mt-2 flex min-h-[26px] items-center gap-2 select-none"
        data-testid="turn-footer"
      >
        <PromptKitStatusIcon phase={effectivePhase} size={15} />
        <div
          key={`${effectivePhase}-${statusLabel || ""}`}
          className="velo-phase-morph flex min-w-0 items-center gap-1.5 text-[13px]"
        >
          {waitingLabel ? (
            <span className="font-medium" style={{ color: "var(--status-warning)" }}>
              {primaryStatus}
            </span>
          ) : (
            <TextShimmer className="font-medium truncate">{primaryStatus}</TextShimmer>
          )}
          {showTrailingClock && (
            <>
              <span className="text-[12px]" style={{ color: "var(--fg-extra-muted)" }}>
                ·
              </span>
              <span
                className="text-[12.5px] tabular-nums"
                style={{ color: "var(--fg-extra-muted)" }}
                data-testid="turn-working-elapsed"
              >
                {formattedElapsed}
              </span>
            </>
          )}
          {telemetry?.tps !== undefined && telemetry.tps > 0.5 && (
            <span
              className="ml-1 font-mono-code text-[11.5px] tabular-nums"
              style={{ color: "var(--fg-extra-muted)" }}
            >
              · {telemetry.tps.toFixed(1)} tok/s
            </span>
          )}
        </div>
      </div>
    );
  }

  const durationText =
    durationMs !== undefined && durationMs > 0
      ? `Worked for ${formatPaseoDuration(durationMs)}`
      : completedAtLabel || "";

  const canSwapTimestamp = Boolean(
    durationMs !== undefined && durationMs > 0 && completedAtLabel
  );

  const ins = telemetry?.insertions || 0;
  const del = telemetry?.deletions || 0;
  const inTok = telemetry?.inputTokens || 0;
  const outTok = telemetry?.outputTokens || 0;
  const totalTok = inTok + outTok;
  const cacheRead = telemetry?.cacheReadTokens || 0;
  const cacheHitPct =
    inTok > 0 && cacheRead > 0 ? Math.min(100, Math.round((cacheRead / inTok) * 100)) : 0;
  const computedTps =
    telemetry?.tps && telemetry.tps >= 0.5 ? telemetry.tps : 0;
  const costUsd = telemetry?.costUsd || 0;

  if (!assistantContent && !onRetry && !durationText && totalTok === 0) {
    return null;
  }

  return (
    <div
      className="mt-1 flex min-h-[24px] flex-wrap items-center gap-1.5"
      data-testid="turn-footer"
    >
      {assistantContent && (
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy response"}
          className="-ml-1 flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)] cursor-pointer"
          style={{ color: copied ? "var(--status-success)" : "var(--fg-muted)" }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          title="重试本轮 (Retry turn)"
          className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)] cursor-pointer"
        >
          <RotateCcw className="h-3.5 w-3.5" style={{ color: "var(--fg-muted)" }} />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          onClick={onFork}
          title="从此处克隆出新分支会话 (Fork session from this turn)"
          className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)] cursor-pointer"
        >
          <GitFork className="h-3.5 w-3.5" style={{ color: "var(--fg-muted)" }} />
        </button>
      )}

      {durationText && (
        <span
          onMouseEnter={() => canSwapTimestamp && setHoveredTiming(true)}
          onMouseLeave={() => setHoveredTiming(false)}
          className="ml-0.5 text-[12.5px] tabular-nums select-none transition-colors"
          style={{ color: "var(--fg-muted)" }}
        >
          {hoveredTiming && canSwapTimestamp ? completedAtLabel : durationText}
        </span>
      )}

      {computedTps > 0.5 && (
        <span
          className="font-mono-code text-[11.5px] font-medium tabular-nums select-none text-[#a78bfa]"
          title="Output generation throughput (tokens/sec)"
        >
          · ⚡ {computedTps.toFixed(1)} tok/s
        </span>
      )}

      {totalTok > 0 && (
        <span
          className="font-mono-code text-[11px] tabular-nums select-none"
          style={{ color: "var(--fg-extra-muted)" }}
          title={`Input: ${inTok.toLocaleString()} · Output: ${outTok.toLocaleString()}`}
        >
          · {formatCompactTokens(totalTok)} tok
        </span>
      )}

      {cacheHitPct > 0 && (
        <span
          className="font-mono-code text-[11px] tabular-nums select-none"
          style={{ color: "var(--status-success)" }}
          title={`Prompt Cache Hit: ${cacheRead.toLocaleString()} / ${inTok.toLocaleString()} input tokens`}
        >
          · 缓存 {cacheHitPct}%
        </span>
      )}

      {costUsd > 0 && (
        <span
          className="font-mono-code text-[11px] tabular-nums select-none"
          style={{ color: "var(--fg-extra-muted)" }}
          title="Estimated API cost for this turn"
        >
          · ${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(3)}
        </span>
      )}

      {(ins > 0 || del > 0) && onOpenDiff && (
        <button
          type="button"
          onClick={onOpenDiff}
          title="Review worktree changes"
          className="ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono-code text-[11.5px] tabular-nums transition-colors hover:bg-[var(--surface-2)] cursor-pointer"
        >
          <span style={{ color: "var(--status-success)" }}>+{ins}</span>
          <span style={{ color: "var(--status-danger)" }}>−{del}</span>
        </button>
      )}
    </div>
  );
};

/**
 * ============================================================================
 * 3. PASEO INDENT RAIL (packages/app/src/components/indent-rail.tsx)
 * ============================================================================
 */
export const PaseoIndentRail: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => (
  <div
    className={`ml-[1px] pl-[19px] border-l ${className}`}
    style={{ borderColor: "var(--border-subtle)" }}
  >
    {children}
  </div>
);

/**
 * ============================================================================
 * 4. PASEO EXPANDABLE BADGE (packages/app/src/components/message.tsx)
 *    - Collapsed: flat borderless row (-mx-2 px-2 py-1), 22x22 icon slot
 *      that swaps from semantic tool icon (12px) to ChevronRight on hover/expanded.
 *    - Loading: Paseo Web Shimmer across label + secondaryLabel.
 *    - Expanded: attached detail card (or pill + IndentRail when borderlessWhenExpanded).
 * ============================================================================
 */
export const PaseoExpandableBadge: React.FC<{
  label: string;
  secondaryLabel?: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  isExpanded: boolean;
  onToggle?: () => void;
  onOpenFile?: () => void;
  isLoading?: boolean;
  isError?: boolean;
  borderlessWhenExpanded?: boolean;
  children?: React.ReactNode;
}> = ({
  label,
  secondaryLabel,
  icon: IconComponent,
  isExpanded,
  onToggle,
  onOpenFile,
  isLoading = false,
  isError = false,
  borderlessWhenExpanded = false,
  children,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const isInteractive = Boolean(onToggle && children);
  const isActive = isHovered || isExpanded;
  const showChevron = isInteractive && (isHovered || isExpanded);

  return (
    <div
      className="-mx-2 my-0.5 select-none"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        role={isInteractive ? "button" : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onClick={() => {
          if (isInteractive && onToggle) onToggle();
        }}
        onKeyDown={(e) => {
          if (isInteractive && onToggle && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onToggle();
          }
        }}
        className={`flex items-center px-2 py-1 text-[13px] transition-colors ${
          isInteractive ? "cursor-pointer" : "cursor-default"
        } ${
          isExpanded
            ? borderlessWhenExpanded
              ? "rounded-full border border-transparent"
              : "rounded-t-[8px] rounded-b-none border"
            : "rounded-[8px] border border-transparent"
        }`}
        style={{
          backgroundColor: isExpanded ? "var(--surface-1)" : "transparent",
          borderColor:
            isExpanded && !borderlessWhenExpanded
              ? "var(--border-subtle)"
              : "transparent",
        }}
      >
        {/* 22x22 Leading Icon Slot: Tool Icon when idle, ChevronRight when hovered or expanded */}
        <div className="mr-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full">
          {showChevron ? (
            <ChevronRight
              className="h-3.5 w-3.5 transition-transform duration-150"
              style={{
                color: "var(--fg)",
                transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
              }}
            />
          ) : isError ? (
            <TriangleAlert
              className="h-3 w-3"
              style={{ color: "var(--status-danger)" }}
            />
          ) : (
            <IconComponent
              className={`h-3.5 w-3.5 ${isLoading ? "velo-sparkle-breath" : ""}`}
              style={{
                color: isActive || isLoading ? "var(--fg)" : "var(--fg-muted)",
              }}
            />
          )}
        </div>

        {/* Label + Secondary Label Row */}
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
          <span
            className={`shrink-0 transition-colors ${
              isLoading ? "beautiful-shimmer-text font-medium" : "font-normal"
            }`}
            style={
              !isLoading
                ? { color: isActive ? "var(--fg)" : "var(--fg-muted)" }
                : undefined
            }
          >
            {label}
          </span>

          {secondaryLabel && (
            <span
              className={`ml-2 min-w-0 flex-1 truncate font-normal transition-colors ${
                isLoading ? "beautiful-shimmer-text" : ""
              }`}
              style={
                !isLoading
                  ? { color: isActive ? "var(--fg)" : "var(--fg-muted)" }
                  : undefined
              }
            >
              {secondaryLabel}
            </span>
          )}

          {onOpenFile && isHovered && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenFile();
              }}
              title="Open file in Changes"
              className="ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--surface-2)] cursor-pointer"
              style={{ color: "var(--fg-muted)" }}
            >
              <FileSymlink className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Expanded Detail Container */}
      {isExpanded && children && (
        <div
          className={`selectable-text overflow-hidden ${
            borderlessWhenExpanded
              ? "pt-1"
              : "rounded-b-[8px] border border-t-0"
          }`}
          style={{
            borderColor: borderlessWhenExpanded
              ? "transparent"
              : "var(--border-subtle)",
            backgroundColor: borderlessWhenExpanded
              ? "transparent"
              : "var(--surface-0)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};

/**
 * Helper to clean raw reasoning text (strips fake boilerplate and formats **bold** headers)
 */
function parseReasoningContent(raw: string): {
  summary: string;
  cleanedLines: string[];
} {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("正在分析工作区上下文") &&
        !l.startsWith("推理完成（思考")
    );

  if (lines.length === 0) {
    return { summary: "", cleanedLines: [] };
  }

  // Extract latest headline or last line as summary, stripping markdown **
  let summary = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("**") && line.endsWith("**") && line.length > 4) {
      summary = line.slice(2, -2).trim();
      break;
    }
  }
  if (!summary) {
    summary = lines[lines.length - 1].replace(/\*\*/g, "").trim();
  }

  return { summary, cleanedLines: lines };
}

function renderFormattedLine(line: string, idx: number) {
  if (line.startsWith("**") && line.endsWith("**") && line.length > 4) {
    return (
      <div
        key={idx}
        className="font-medium text-[13px] mt-1.5 first:mt-0"
        style={{ color: "var(--fg)" }}
      >
        {line.slice(2, -2)}
      </div>
    );
  }
  // Inline **bold** segments
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return (
    <div
      key={idx}
      className="text-[13px] leading-[1.6]"
      style={{ color: "var(--fg-muted)" }}
    >
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={i} className="font-medium" style={{ color: "var(--fg)" }}>
            {part.slice(2, -2)}
          </strong>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </div>
  );
}

/**
 * ============================================================================
 * 5. VERCEL AI ELEMENTS `<Reasoning>` (`BeautifulThinkingBlock`)
 *    - Streaming: Shimmering `Thinking…` / `Thinking for Xs` + live headline
 *    - Completed: Collapsible `Thought for Xs` trigger + clean reasoning rail
 * ============================================================================
 */
export const BeautifulThinkingBlock: React.FC<{
  text: string;
  isStreaming?: boolean;
  startedAtMs?: number;
  durationMs?: number;
  defaultExpanded?: boolean;
}> = ({
  text,
  isStreaming = false,
  startedAtMs,
  durationMs,
  defaultExpanded = false,
}) => {
  const { summary, cleanedLines } = useMemo(() => parseReasoningContent(text), [text]);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(
    defaultExpanded ? true : null
  );
  const [liveThinkMs, setLiveThinkMs] = useState<number>(() =>
    startedAtMs ? Math.max(0, Date.now() - startedAtMs) : 0
  );
  const scrollBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isStreaming) return;
    const origin = startedAtMs || Date.now();
    const tick = () => setLiveThinkMs(Math.max(0, Date.now() - origin));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isStreaming, startedAtMs]);

  const hasDetail = cleanedLines.length > 0;
  const effectiveExpanded = userExpanded ?? defaultExpanded;

  useEffect(() => {
    if (isStreaming && effectiveExpanded && scrollBoxRef.current) {
      scrollBoxRef.current.scrollTop = scrollBoxRef.current.scrollHeight;
    }
  }, [text, isStreaming, effectiveExpanded]);

  if (!hasDetail && !isStreaming) {
    return null;
  }

  const primaryLabel = isStreaming
    ? Math.round(liveThinkMs / 1000) >= 1
      ? `Thinking for ${formatPaseoDuration(liveThinkMs)}`
      : "Thinking…"
    : durationMs !== undefined && durationMs >= 500
    ? `Thought for ${formatPaseoDuration(durationMs)}`
    : "Thought";

  const displaySecondary = summary ? `· ${summary}` : undefined;

  return (
    <PaseoExpandableBadge
      label={primaryLabel}
      secondaryLabel={displaySecondary}
      icon={isStreaming ? Sparkles : Brain}
      isExpanded={effectiveExpanded && hasDetail}
      onToggle={
        hasDetail
          ? () => setUserExpanded((prev) => !(prev ?? effectiveExpanded))
          : undefined
      }
      isLoading={isStreaming}
      borderlessWhenExpanded
    >
      {hasDetail && (
        <PaseoIndentRail className="my-1">
          <div
            ref={scrollBoxRef}
            className="max-h-[240px] overflow-y-auto py-1 space-y-1"
          >
            {cleanedLines.map((line, i) => renderFormattedLine(line, i))}
          </div>
        </PaseoIndentRail>
      )}
    </PaseoExpandableBadge>
  );
};

/**
 * ============================================================================
 * 6. PASEO TOOL CALL CARD (packages/app/src/components/message.tsx + tool-call-details.tsx)
 * ============================================================================
 */
export function resolvePaseoToolPresentation(
  toolName: string,
  input: unknown,
  output?: string
): {
  displayName: string;
  workingVerb: string;
  summary?: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  kind: "shell" | "edit" | "read" | "search" | "other";
  command?: string;
  filePath?: string;
} {
  const lower = toolName.trim().toLowerCase();
  const inputObj =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const filePath =
    (inputObj.file_path as string) ||
    (inputObj.path as string) ||
    (inputObj.Path as string) ||
    (inputObj.TargetFile as string) ||
    (inputObj.AbsolutePath as string) ||
    (inputObj.DirectoryPath as string) ||
    (inputObj.file as string) ||
    (inputObj.target as string) ||
    undefined;
  const command =
    (inputObj.command as string) ||
    (inputObj.CommandLine as string) ||
    (inputObj.cmd as string) ||
    (typeof input === "string" ? input : undefined);
  let query =
    (inputObj.pattern as string) ||
    (inputObj.Pattern as string) ||
    (inputObj.query as string) ||
    (inputObj.Query as string) ||
    undefined;

  if ((!query || !query.trim()) && output && output.startsWith("Searched:")) {
    query = output.replace(/^Searched:\s*/i, "").split("\n")[0].trim();
  }

  const shortPath = filePath
    ? filePath.replace(/^\/Users\/[^/]+\/code\/[^/]+\//, "")
    : undefined;

  if (
    lower.includes("bash") ||
    lower.includes("shell") ||
    lower.includes("cmd") ||
    lower.includes("command")
  ) {
    return {
      displayName: "Shell",
      workingVerb: "Running command",
      summary: command || shortPath,
      icon: SquareTerminal,
      kind: "shell",
      command: command || "",
    };
  }
  if (lower.includes("read") || lower.includes("view") || lower === "list_dir") {
    return {
      displayName: "Read",
      workingVerb: shortPath ? `Reading ${shortPath}` : "Reading file",
      summary: shortPath || command,
      icon: Eye,
      kind: "read",
      filePath,
    };
  }
  if (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("patch") ||
    lower.includes("file_change")
  ) {
    return {
      displayName: lower.includes("write") ? "Write" : "Edit",
      workingVerb: shortPath ? `Editing ${shortPath}` : "Editing code",
      summary: shortPath || command,
      icon: Pencil,
      kind: "edit",
      filePath,
    };
  }
  if (
    lower.includes("search") ||
    lower.includes("grep") ||
    lower.includes("glob") ||
    lower.includes("find")
  ) {
    return {
      displayName: "Search",
      workingVerb: query ? `Searching "${query.slice(0, 36)}"` : "Searching",
      summary: query || shortPath || command,
      icon: Search,
      kind: "search",
    };
  }
  if (lower.includes("task") || lower.includes("agent")) {
    return {
      displayName: "Task",
      workingVerb: "Delegating subagent",
      summary: shortPath || command,
      icon: Bot,
      kind: "other",
    };
  }

  return {
    displayName: toolName,
    workingVerb: `Running ${toolName}`,
    summary: shortPath || command || query,
    icon: Wrench,
    kind: "other",
  };
}

type InlineDiffRow = { kind: "del" | "add" | "ctx"; text: string };

function extractInlineDiffFromToolInput(input: unknown): {
  rows: InlineDiffRow[];
  added: number;
  removed: number;
} | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  // 1. Unified patch (`patch` / `diff`)
  const rawPatch =
    typeof obj.patch === "string"
      ? obj.patch
      : typeof obj.diff === "string"
      ? obj.diff
      : null;
  if (rawPatch && rawPatch.trim()) {
    const rows: InlineDiffRow[] = [];
    let added = 0;
    let removed = 0;
    for (const line of rawPatch.split("\n").slice(0, 140)) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
      if (line.startsWith("+")) {
        added++;
        rows.push({ kind: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        removed++;
        rows.push({ kind: "del", text: line.slice(1) });
      } else {
        rows.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
      }
    }
    if (added > 0 || removed > 0) return { rows, added, removed };
  }

  // 2. Claude MultiEdit (`edits: [{ old_string, new_string }]`)
  const editPairs: Array<{ oldStr: string; newStr: string }> = [];
  if (Array.isArray(obj.edits)) {
    for (const e of obj.edits) {
      if (e && typeof e === "object") {
        const eo = e as Record<string, unknown>;
        const o = String(eo.old_string ?? eo.Target ?? "");
        const n = String(eo.new_string ?? eo.Replacement ?? "");
        if (o || n) editPairs.push({ oldStr: o, newStr: n });
      }
    }
  } else if (
    typeof obj.old_string === "string" ||
    typeof obj.new_string === "string" ||
    typeof obj.Target === "string" ||
    typeof obj.Replacement === "string"
  ) {
    editPairs.push({
      oldStr: String(obj.old_string ?? obj.Target ?? ""),
      newStr: String(obj.new_string ?? obj.Replacement ?? ""),
    });
  } else if (typeof obj.content === "string" || typeof obj.Content === "string") {
    const written = String(obj.content ?? obj.Content ?? "");
    const lines = written.split("\n").slice(0, 80);
    return {
      rows: lines.map((l) => ({ kind: "add" as const, text: l })),
      added: written.split("\n").length,
      removed: 0,
    };
  }

  if (editPairs.length === 0) return null;

  const rows: InlineDiffRow[] = [];
  let added = 0;
  let removed = 0;
  for (const pair of editPairs) {
    const oldLines = pair.oldStr ? pair.oldStr.split("\n") : [];
    const newLines = pair.newStr ? pair.newStr.split("\n") : [];
    for (const l of oldLines.slice(0, 60)) {
      removed++;
      rows.push({ kind: "del", text: l });
    }
    for (const l of newLines.slice(0, 60)) {
      added++;
      rows.push({ kind: "add", text: l });
    }
  }
  return rows.length > 0 ? { rows, added, removed } : null;
}

function extractSubagentDelegation(
  toolName: string,
  input: unknown
): { role: string; prompt: string } | null {
  const lower = toolName.trim().toLowerCase();
  if (!lower.includes("task") && !lower.includes("subagent") && !lower.includes("delegate")) {
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const role = String(
    obj.description ?? obj.Role ?? obj.subagent_type ?? obj.TypeName ?? "Subagent"
  );
  const prompt = String(obj.prompt ?? obj.Prompt ?? "");
  return { role, prompt };
}

export const BeautifulToolCallCard: React.FC<{
  toolName: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  onOpenDiffTab?: () => void;
}> = ({ toolName, input, output, isError = false, onOpenDiffTab }) => {
  const [expanded, setExpanded] = useState(false);
  const pres = useMemo(
    () => resolvePaseoToolPresentation(toolName, input, output),
    [toolName, input, output]
  );
  const inlineDiff = useMemo(
    () => (pres.kind === "edit" ? extractInlineDiffFromToolInput(input) : null),
    [pres.kind, input]
  );
  const subagentInfo = useMemo(
    () => extractSubagentDelegation(toolName, input),
    [toolName, input]
  );
  const isRunning = output === undefined;

  const enrichedSecondary = useMemo(() => {
    if (subagentInfo) {
      return `${subagentInfo.role}${isRunning ? " · 运行中" : ""}`;
    }
    const base = isRunning ? (pres.kind === "shell" ? pres.summary : undefined) : pres.summary;
    if (inlineDiff && !isRunning) {
      const stat = `+${inlineDiff.added}${inlineDiff.removed > 0 ? ` −${inlineDiff.removed}` : ""}`;
      return base ? `${base}  (${stat})` : stat;
    }
    return base;
  }, [subagentInfo, isRunning, pres.kind, pres.summary, inlineDiff]);

  return (
    <PaseoExpandableBadge
      label={subagentInfo ? "Subagent" : isRunning ? pres.workingVerb : pres.displayName}
      secondaryLabel={enrichedSecondary}
      icon={pres.icon}
      isExpanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      onOpenFile={pres.kind === "edit" || pres.kind === "read" ? onOpenDiffTab : undefined}
      isLoading={isRunning}
      isError={isError}
    >
      {subagentInfo ? (
        <div className="space-y-2 px-3.5 py-2.5 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[#a78bfa]/15 px-2 py-0.5 font-mono-code text-[10.5px] font-medium text-[#a78bfa]">
              {subagentInfo.role}
            </span>
            <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
              {isRunning ? "子代理正在独立执行…" : "子代理已完成汇报"}
            </span>
          </div>
          {subagentInfo.prompt && (
            <div
              className="rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5 text-[11.5px] whitespace-pre-wrap"
              style={{ color: "var(--fg-muted)" }}
            >
              {subagentInfo.prompt.slice(0, 420)}
              {subagentInfo.prompt.length > 420 ? "…" : ""}
            </div>
          )}
          {output && (
            <pre
              className="max-h-[220px] overflow-auto whitespace-pre-wrap font-mono-code text-[11.5px]"
              style={{ color: isError ? "var(--status-danger)" : "var(--fg)" }}
            >
              {output}
            </pre>
          )}
        </div>
      ) : inlineDiff ? (
        <div className="max-h-[300px] overflow-auto font-mono-code text-[11.5px] leading-[1.55]">
          <div
            className="flex items-center justify-between border-b px-3 py-1.5 text-[11px]"
            style={{ borderColor: "var(--border-subtle)", color: "var(--fg-muted)" }}
          >
            <span className="truncate">{pres.summary || "Inline changes"}</span>
            <span className="shrink-0 tabular-nums">
              <span style={{ color: "var(--status-success)" }}>+{inlineDiff.added}</span>{" "}
              <span style={{ color: "var(--status-danger)" }}>−{inlineDiff.removed}</span>
            </span>
          </div>
          <div className="py-1">
            {inlineDiff.rows.map((row, idx) => (
              <div
                key={idx}
                className={`flex px-3 py-0.2 whitespace-pre overflow-x-auto ${
                  row.kind === "add"
                    ? "bg-[#34d399]/12 text-[#34d399]"
                    : row.kind === "del"
                    ? "bg-[#f87171]/12 text-[#f87171]"
                    : "text-[var(--fg-muted)]"
                }`}
              >
                <span className="mr-2 w-3 shrink-0 select-none opacity-75">
                  {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
                </span>
                <span>{row.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : pres.kind === "shell" ? (
        <div className="max-h-[280px] overflow-auto px-3.5 py-2.5 font-mono-code text-[12px] leading-[1.55]">
          {pres.command && (
            <div className="whitespace-pre-wrap" style={{ color: "var(--fg)" }}>
              <span style={{ color: "var(--fg-muted)" }}>$ </span>
              {pres.command}
            </div>
          )}
          {output && (
            <pre
              className="mt-2 whitespace-pre-wrap overflow-x-auto"
              style={{
                color: isError ? "var(--status-danger)" : "var(--fg-muted)",
              }}
            >
              {output}
            </pre>
          )}
        </div>
      ) : (
        <div className="max-h-[280px] overflow-auto divide-y" style={{ borderColor: "var(--border-subtle)" }}>
          {input !== undefined && input !== null && Object.keys(input as object).length > 0 && (
            <div className="px-3.5 py-2 font-mono-code text-[11.5px]">
              <div className="mb-1 text-[11px]" style={{ color: "var(--fg-muted)" }}>
                Input
              </div>
              <pre
                className="overflow-x-auto whitespace-pre-wrap"
                style={{ color: "var(--fg)" }}
              >
                {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {output && (
            <div className="px-3.5 py-2 font-mono-code text-[11.5px]">
              <div className="mb-1 text-[11px]" style={{ color: "var(--fg-muted)" }}>
                Output
              </div>
              <pre
                className="overflow-x-auto whitespace-pre-wrap"
                style={{
                  color: isError ? "var(--status-danger)" : "var(--fg-muted)",
                }}
              >
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </PaseoExpandableBadge>
  );
};

/**
 * ============================================================================
 * 7. PASEO TOOL CALL GROUP (packages/app/src/agent-stream/view.tsx -> OverviewToolCallGroupView)
 *    Collapses 2+ consecutive completed tool calls into a single ExpandableBadge
 *    with a human-readable summary ("Read 2 files, ran 1 command") and IndentRail.
 * ============================================================================
 */
export interface PaseoToolGroupItem {
  id: string;
  toolName: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  fileArg?: string;
}

function summarizeToolGroup(items: PaseoToolGroupItem[]): {
  label: string;
  secondaryLabel: string;
  hasError: boolean;
  isAnyRunning: boolean;
} {
  let shellCount = 0;
  let readCount = 0;
  let editCount = 0;
  let searchCount = 0;
  let otherCount = 0;
  let hasError = false;
  let isAnyRunning = false;
  let activeWorkingVerb = "";

  for (const item of items) {
    if (item.isError) hasError = true;
    const pres = resolvePaseoToolPresentation(item.toolName, item.input, item.output);
    if (item.output === undefined) {
      isAnyRunning = true;
      activeWorkingVerb = pres.workingVerb;
    }
    if (pres.kind === "shell") shellCount++;
    else if (pres.kind === "read") readCount++;
    else if (pres.kind === "edit") editCount++;
    else if (pres.kind === "search") searchCount++;
    else otherCount++;
  }

  const parts: string[] = [];
  if (readCount > 0) parts.push(`read ${readCount} ${readCount === 1 ? "file" : "files"}`);
  if (searchCount > 0) parts.push(`searched ${searchCount} ${searchCount === 1 ? "pattern" : "patterns"}`);
  if (shellCount > 0) parts.push(`ran ${shellCount} ${shellCount === 1 ? "command" : "commands"}`);
  if (editCount > 0) parts.push(`edited ${editCount} ${editCount === 1 ? "file" : "files"}`);
  if (otherCount > 0) parts.push(`${otherCount} other`);

  const summaryText = isAnyRunning && activeWorkingVerb
    ? `${activeWorkingVerb}…`
    : parts.length > 0
    ? parts.join(", ").replace(/^./, (c) => c.toUpperCase())
    : `${items.length} tool calls`;

  return {
    label: `${items.length} tool calls`,
    secondaryLabel: summaryText,
    hasError,
    isAnyRunning,
  };
}

export interface PaseoTraceStepItem {
  id: string;
  kind: "thinking" | "tool_call";
  text?: string;
  isStreamingThinking?: boolean;
  startedAtMs?: number;
  durationMs?: number;
  toolName?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  fileArg?: string;
}

export const PaseoExecutionTraceGroup: React.FC<{
  steps: PaseoTraceStepItem[];
  defaultExpanded?: boolean;
  onOpenDiffForFile?: (fileArg?: string) => void;
}> = ({ steps, defaultExpanded = false, onOpenDiffForFile }) => {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? defaultExpanded;

  const meta = useMemo(() => {
    let thinkCount = 0;
    let toolCount = 0;
    let hasError = false;
    let isAnyRunning = false;
    let latestStepHint = "";

    for (const st of steps) {
      if (st.kind === "thinking") {
        thinkCount++;
        const parsed = parseReasoningContent(st.text || "");
        if (parsed.summary) {
          latestStepHint = parsed.summary;
        }
        if (st.isStreamingThinking) {
          isAnyRunning = true;
        }
      } else {
        toolCount++;
        if (st.isError) hasError = true;
        const pres = resolvePaseoToolPresentation(
          st.toolName || "Tool",
          st.input,
          st.output
        );
        if (st.output === undefined) {
          isAnyRunning = true;
          latestStepHint = pres.summary
            ? `${pres.displayName} · ${pres.summary}`
            : pres.workingVerb;
        } else {
          latestStepHint = pres.summary
            ? `${pres.displayName} · ${pres.summary}`
            : pres.displayName;
        }
      }
    }

    const parts: string[] = [];
    if (thinkCount > 0) parts.push(`思考 ${thinkCount} 次`);
    if (toolCount > 0) parts.push(`工具/MCP ${toolCount} 次`);
    const countsText = parts.join(" · ");

    const label = isAnyRunning
      ? `执行中 (${steps.length} 步)`
      : `已收起 ${steps.length} 步执行过程`;
    const secondaryLabel = isAnyRunning
      ? latestStepHint
        ? `· ${latestStepHint}`
        : `· ${countsText}`
      : `· ${countsText}${latestStepHint ? ` · ${latestStepHint}` : ""}`;

    return {
      label,
      secondaryLabel,
      hasError,
      isAnyRunning,
    };
  }, [steps]);

  return (
    <PaseoExpandableBadge
      label={meta.label}
      secondaryLabel={meta.secondaryLabel}
      icon={meta.isAnyRunning ? Sparkles : Wrench}
      isExpanded={expanded}
      onToggle={() => setUserExpanded((prev) => !(prev ?? defaultExpanded))}
      isLoading={meta.isAnyRunning}
      isError={meta.hasError}
      borderlessWhenExpanded
    >
      <PaseoIndentRail className="space-y-0.5 py-0.5">
        {steps.map((st) =>
          st.kind === "thinking" ? (
            <BeautifulThinkingBlock
              key={st.id}
              text={st.text || ""}
              isStreaming={st.isStreamingThinking}
              startedAtMs={st.startedAtMs}
              durationMs={st.durationMs}
              defaultExpanded={false}
            />
          ) : (
            <BeautifulToolCallCard
              key={st.id}
              toolName={st.toolName || "Tool"}
              input={st.input}
              output={st.output}
              isError={st.isError}
              onOpenDiffTab={() => onOpenDiffForFile?.(st.fileArg)}
            />
          )
        )}
      </PaseoIndentRail>
    </PaseoExpandableBadge>
  );
};

/**
 * ============================================================================
 * 8. PASEO MARKDOWN & CODE BLOCK RENDERER
 *    Renders assistant prose with syntax-styled fenced code blocks (with 1-click Copy),
 *    inline code badges, tables, headings, blockquotes, lists, and links.
 * ============================================================================
 */
const PaseoCodeBlock: React.FC<{
  language: string;
  code: string;
}> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="my-2 overflow-hidden rounded-[8px] border"
      style={{
        borderColor: "var(--border-subtle)",
        backgroundColor: "var(--surface-0)",
      }}
    >
      <div
        className="flex items-center justify-between border-b px-3 py-1.5 text-[11.5px]"
        style={{
          borderColor: "var(--border-subtle)",
          backgroundColor: "var(--surface-1)",
          color: "var(--fg-muted)",
        }}
      >
        <span className="font-mono-code lowercase select-none">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopyCode}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)] cursor-pointer"
          style={{ color: copied ? "var(--status-success)" : "var(--fg-muted)" }}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre
        className="overflow-x-auto p-3 font-mono-code text-[12.5px] leading-[1.55]"
        style={{ color: "var(--fg)" }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
};

function renderInlineMarkdown(text: string): React.ReactNode[] {
  // Tokenize inline `code`, **bold**, *italic*, ~~strike~~, and [label](url)
  const tokenRegex =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*\n]*\*)/g;
  const parts = text.split(tokenRegex);

  return parts.map((part, idx) => {
    if (!part) return null;

    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return (
        <code
          key={idx}
          className="mx-[1px] rounded-[5px] border px-1.5 py-[1px] font-mono-code text-[12px]"
          style={{
            backgroundColor: "var(--surface-1)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg)",
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold" style={{ color: "var(--fg)" }}>
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4) {
      return (
        <del key={idx} style={{ color: "var(--fg-muted)" }}>
          {part.slice(2, -2)}
        </del>
      );
    }

    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={idx} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }

    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={idx}
          href={linkMatch[2]}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 transition-opacity hover:opacity-80"
          style={{ color: "var(--accent-bright)" }}
        >
          {linkMatch[1]}
        </a>
      );
    }

    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export const PaseoMarkdown: React.FC<{
  content: string;
  isStreaming?: boolean;
  className?: string;
}> = ({ content, isStreaming = false, className = "" }) => {
  const blocks = useMemo(() => {
    const result: Array<
      | { type: "code"; lang: string; code: string }
      | { type: "prose"; text: string }
    > = [];

    const fenceRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = fenceRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        result.push({
          type: "prose",
          text: content.slice(lastIndex, match.index),
        });
      }
      result.push({
        type: "code",
        lang: match[1] || "",
        code: match[2].replace(/\n$/, ""),
      });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
      const tail = content.slice(lastIndex);
      // Handle an unclosed fenced code block while tokens are actively streaming
      const unclosedMatch = tail.match(/([\s\S]*?)```([a-zA-Z0-9_-]*)\n([\s\S]*)$/);
      if (unclosedMatch) {
        if (unclosedMatch[1]) {
          result.push({
            type: "prose",
            text: unclosedMatch[1],
          });
        }
        result.push({
          type: "code",
          lang: unclosedMatch[2] || "",
          code: unclosedMatch[3],
        });
      } else {
        result.push({
          type: "prose",
          text: tail,
        });
      }
    }

    return result;
  }, [content]);

  const renderProseSegment = (text: string, blockIdx: number) => {
    const lines = text.split("\n");
    const elements: React.ReactNode[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // Horizontal Rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        elements.push(
          <hr
            key={`${blockIdx}-hr-${i}`}
            className="my-3 border-t"
            style={{ borderColor: "var(--border-subtle)" }}
          />
        );
        i++;
        continue;
      }

      // Headings
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const sizeClass =
          level === 1
            ? "text-[16px] font-semibold mt-3 mb-1.5"
            : level === 2
            ? "text-[14.5px] font-semibold mt-2.5 mb-1"
            : "text-[13.5px] font-semibold mt-2 mb-0.5";
        elements.push(
          <div
            key={`${blockIdx}-h-${i}`}
            className={sizeClass}
            style={{ color: "var(--fg)" }}
          >
            {renderInlineMarkdown(headingMatch[2])}
          </div>
        );
        i++;
        continue;
      }

      // Markdown Table
      if (
        trimmed.startsWith("|") &&
        trimmed.endsWith("|") &&
        i + 1 < lines.length &&
        /^\s*\|[\s:-]+\|/.test(lines[i + 1])
      ) {
        const headerCells = trimmed
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
        i += 2; // skip header + separator
        const rows: string[][] = [];
        while (
          i < lines.length &&
          lines[i].trim().startsWith("|") &&
          lines[i].trim().endsWith("|")
        ) {
          rows.push(
            lines[i]
              .trim()
              .slice(1, -1)
              .split("|")
              .map((c) => c.trim())
          );
          i++;
        }
        elements.push(
          <div
            key={`${blockIdx}-tbl-${i}`}
            className="my-2 overflow-x-auto rounded-[8px] border"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <table className="w-full border-collapse text-left text-[12.5px]">
              <thead>
                <tr
                  className="border-b"
                  style={{
                    borderColor: "var(--border-subtle)",
                    backgroundColor: "var(--surface-1)",
                  }}
                >
                  {headerCells.map((hc, cIdx) => (
                    <th
                      key={cIdx}
                      className="px-3 py-1.5 font-semibold"
                      style={{ color: "var(--fg)" }}
                    >
                      {renderInlineMarkdown(hc)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
                {rows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-3 py-1.5">
                        {renderInlineMarkdown(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      // Unordered List
      if (/^[-*+]\s+/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
          i++;
        }
        elements.push(
          <ul
            key={`${blockIdx}-ul-${i}`}
            className="my-1.5 list-disc space-y-1 pl-5 text-[13.5px] leading-[1.65]"
          >
            {items.map((it, idx) => (
              <li key={idx}>{renderInlineMarkdown(it)}</li>
            ))}
          </ul>
        );
        continue;
      }

      // Ordered List
      if (/^\d+\.\s+/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
          i++;
        }
        elements.push(
          <ol
            key={`${blockIdx}-ol-${i}`}
            className="my-1.5 list-decimal space-y-1 pl-5 text-[13.5px] leading-[1.65]"
          >
            {items.map((it, idx) => (
              <li key={idx}>{renderInlineMarkdown(it)}</li>
            ))}
          </ol>
        );
        continue;
      }

      // Blockquote
      if (trimmed.startsWith(">")) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        elements.push(
          <blockquote
            key={`${blockIdx}-bq-${i}`}
            className="my-2 border-l-2 pl-3 italic text-[13px]"
            style={{
              borderColor: "var(--border-accent)",
              color: "var(--fg-muted)",
            }}
          >
            {quoteLines.map((ql, idx) => (
              <div key={idx}>{renderInlineMarkdown(ql)}</div>
            ))}
          </blockquote>
        );
        continue;
      }

      // Standard Paragraph
      elements.push(
        <p
          key={`${blockIdx}-p-${i}`}
          className="my-1 first:mt-0 last:mb-0 text-[13.5px] leading-[1.68]"
        >
          {renderInlineMarkdown(line)}
        </p>
      );
      i++;
    }

    return elements;
  };

  return (
    <div
      className={`w-full space-y-1.5 text-[13.5px] leading-[1.68] ${className}`}
      style={{ color: "var(--v-fg-body)" }}
    >
      {blocks.map((b, idx) =>
        b.type === "code" ? (
          <PaseoCodeBlock key={idx} language={b.lang} code={b.code} />
        ) : (
          <React.Fragment key={idx}>{renderProseSegment(b.text, idx)}</React.Fragment>
        )
      )}
      {isStreaming && (
        <span
          aria-hidden="true"
          className="inline-block h-[14px] w-[6px] translate-y-[2px] rounded-[1px] animate-pulse"
          style={{ backgroundColor: "var(--fg-muted)" }}
        />
      )}
    </div>
  );
};

/**
 * Beautiful UI (beautifului.dev) — Human-in-the-Loop Approval Card
 */
export const BeautifulApprovalCard: React.FC<{
  toolName: string;
  commandPreview: string;
  reason?: string;
  onApprove: () => void;
  onAlwaysAllow?: () => void;
  onDeny: () => void;
}> = ({ toolName, commandPreview, reason, onApprove, onAlwaysAllow, onDeny }) => {
  const [resolved, setResolved] = useState<"approved" | "denied" | null>(null);

  if (resolved) {
    return (
      <div
        className="mb-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-[7px] border text-[11.5px] font-mono-code"
        style={{
          backgroundColor: "var(--surface-1)",
          borderColor: "var(--border-subtle)",
          color:
            resolved === "approved" ? "var(--status-success)" : "var(--status-danger)",
        }}
      >
        <Check className="w-3.5 h-3.5" />
        <span>
          Permission {resolved} for {toolName}
        </span>
      </div>
    );
  }

  return (
    <div
      className="mb-2.5 rounded-[12px] border p-3.5 space-y-2.5 rare-specular-surface t-modal-scale"
      style={{
        backgroundColor: "var(--surface-1)",
        borderColor: "var(--status-warning)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldAlert
            className="w-4 h-4 shrink-0"
            style={{ color: "var(--status-warning)" }}
          />
          <span className="text-[12.5px] font-semibold truncate">
            Live Tool Permission Approval
          </span>
        </div>
        <span
          className="font-mono-code text-[10px] px-2 py-0.5 rounded-full shrink-0"
          style={{
            backgroundColor: "rgba(192, 150, 100, 0.16)",
            color: "var(--status-warning)",
          }}
        >
          {toolName}
        </span>
      </div>

      {reason && (
        <div className="text-[11.5px]" style={{ color: "var(--fg-muted)" }}>
          {reason}
        </div>
      )}

      <pre
        className="font-mono-code text-[11.5px] px-3 py-2 rounded-[6px] border overflow-x-auto"
        style={{
          backgroundColor: "var(--surface-0)",
          borderColor: "var(--border-subtle)",
          color: "var(--fg)",
        }}
      >
        $ {commandPreview}
      </pre>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => {
            setResolved("denied");
            onDeny();
          }}
          className="h-[27px] px-2.5 rounded-[6px] border text-[11.5px] flex items-center gap-1 cursor-pointer hover:bg-[var(--surface-2)]"
          style={{
            borderColor: "var(--border-accent)",
            color: "var(--fg-muted)",
          }}
        >
          <X className="w-3 h-3" />
          Deny
        </button>
        {onAlwaysAllow && (
          <button
            type="button"
            onClick={() => {
              setResolved("approved");
              onAlwaysAllow();
            }}
            className="h-[27px] px-2.5 rounded-[6px] border text-[11.5px] font-medium flex items-center gap-1 cursor-pointer hover:bg-[var(--surface-2)]"
            style={{
              borderColor: "var(--border-accent)",
              color: "var(--fg)",
            }}
          >
            <Check className="w-3 h-3" />
            Always Allow in Session
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setResolved("approved");
            onApprove();
          }}
          className="h-[27px] px-3 rounded-[6px] text-[11.5px] font-medium flex items-center gap-1 cursor-pointer rare-3d-button"
          style={{
            backgroundColor: "var(--accent)",
            color: "#ffffff",
          }}
        >
          <Check className="w-3 h-3" />
          Allow Once
        </button>
      </div>
    </div>
  );
};

/**
 * Interactive Bidirectional `AskUserQuestion` Card (`velo_ask_user`)
 */
export const BeautifulQuestionCard: React.FC<{
  question: string;
  options: string[];
  allowMultiple?: boolean;
  onSubmit: (answers: string[]) => void;
}> = ({ question, options, allowMultiple = false, onSubmit }) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [customAnswer, setCustomAnswer] = useState<string>("");

  const toggleOption = (opt: string) => {
    if (allowMultiple) {
      setSelected((prev) =>
        prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]
      );
    } else {
      setSelected([opt]);
    }
  };

  const handleConfirm = () => {
    const combined = [...selected];
    if (customAnswer.trim()) {
      combined.push(customAnswer.trim());
    }
    if (combined.length === 0) return;
    onSubmit(combined);
  };

  return (
    <div
      className="mb-2.5 rounded-[12px] border p-3.5 space-y-2.5"
      style={{
        backgroundColor: "var(--surface-1)",
        borderColor: "var(--accent)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-semibold" style={{ color: "var(--fg)" }}>
          {question}
        </span>
        <span
          className="font-mono-code text-[10px] px-2 py-0.5 rounded-full shrink-0"
          style={{
            backgroundColor: "var(--surface-3)",
            color: "var(--accent-bright)",
          }}
        >
          {allowMultiple ? "Multi-select" : "Agent Question"}
        </span>
      </div>

      {options.length > 0 && (
        <div className="grid grid-cols-1 gap-1.5">
          {options.map((opt) => {
            const isChosen = selected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggleOption(opt)}
                className="flex items-center justify-between rounded-[8px] border px-3 py-1.5 text-left text-[12px] transition-colors cursor-pointer"
                style={{
                  backgroundColor: isChosen ? "var(--surface-3)" : "var(--surface-0)",
                  borderColor: isChosen ? "var(--accent)" : "var(--border-subtle)",
                  color: "var(--fg)",
                }}
              >
                <span>{opt}</span>
                {isChosen && (
                  <Check className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--status-success)" }} />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <input
          value={customAnswer}
          onChange={(e) => setCustomAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleConfirm();
            }
          }}
          placeholder={
            options.length > 0
              ? "Or type a custom answer..."
              : "Type your answer for the agent..."
          }
          className="flex-1 rounded-[7px] border px-2.5 py-1.5 text-[12px] outline-none"
          style={{
            backgroundColor: "var(--surface-0)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg)",
          }}
        />
        <button
          type="button"
          onClick={handleConfirm}
          disabled={selected.length === 0 && !customAnswer.trim()}
          className="h-[30px] px-3 rounded-[7px] text-[11.5px] font-medium cursor-pointer disabled:opacity-40"
          style={{
            backgroundColor: "var(--accent)",
            color: "#ffffff",
          }}
        >
          Reply
        </button>
      </div>
    </div>
  );
};

/**
 * Beautiful UI + beUI — Radial Context Window & Token Telemetry Meter
 */
export const BeautifulContextMeter: React.FC<{
  usedTokens: number;
  maxTokens?: number;
  costUsd?: number;
}> = ({ usedTokens, maxTokens = 200000, costUsd = 0 }) => {
  const rawPct = Math.round((usedTokens / maxTokens) * 100);
  const pct = usedTokens <= 0 ? 0 : Math.min(100, Math.max(1, rawPct));
  const arcPct = usedTokens <= 0 ? 0 : Math.min(100, Math.max(4, rawPct));
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (arcPct / 100) * circumference;

  const strokeColor =
    pct > 80
      ? "var(--status-danger)"
      : pct > 55
      ? "var(--status-warning)"
      : "var(--accent-bright)";

  const formattedTokens =
    usedTokens <= 0
      ? "0k"
      : usedTokens < 1000
      ? `${usedTokens}`
      : `${(usedTokens / 1000).toFixed(1)}k`;

  const costSuffix = costUsd > 0 ? ` · $${costUsd.toFixed(4)}` : "";

  return (
    <div
      className="h-[24px] px-2 rounded-full border flex items-center gap-1.5 font-mono-code text-[10.5px] rare-specular-pill"
      style={{
        backgroundColor: "var(--surface-1)",
        borderColor: "var(--border-subtle)",
        color: "var(--fg-muted)",
      }}
      title={`Context Window: ${formattedTokens} / ${(maxTokens / 1000).toFixed(
        0
      )}k tokens (${pct}%)${costSuffix}`}
    >
      <svg width="16" height="16" className="-rotate-90">
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="transparent"
          stroke="var(--surface-3)"
          strokeWidth="2"
        />
        {usedTokens > 0 && (
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="transparent"
            stroke={strokeColor}
            strokeWidth="2"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        )}
      </svg>
      <span>{pct}%</span>
      <span style={{ color: "var(--fg-extra-muted)" }}>{formattedTokens}</span>
    </div>
  );
};
