import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
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
  WrapText,
  Wrench,
  X,
} from "lucide-react";
import {
  VeloKbd,
  VeloNumberTicker,
  highlightCodeLine,
} from "./VeloMotionPrimitives";

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
    const primaryStatus = waitingLabel
      ? waitingLabel
      : statusLabel || (effectivePhase === "thinking" ? "Thinking" : "Working");
    const liveSec = Math.max(0, Math.round(liveMs / 1000));
    const formattedElapsed = formatPaseoDuration(liveMs);

    return (
      <div
        className="mt-1.5 flex min-h-[24px] items-center gap-1.5 select-none"
        data-testid="turn-footer"
      >
        <PromptKitStatusIcon phase={effectivePhase} size={14} />
        <div
          key={`${effectivePhase}-${primaryStatus}`}
          className="velo-phase-morph flex min-w-0 items-center gap-1.5 text-[13.5px]"
        >
          {waitingLabel ? (
            <span className="font-normal" style={{ color: "var(--status-warning)" }}>
              {primaryStatus}
            </span>
          ) : (
            <TextShimmer className="font-normal truncate">{primaryStatus}</TextShimmer>
          )}
          {!waitingLabel && liveSec >= 1 && (
            <span
              className="text-[12.5px] tabular-nums"
              style={{ color: "var(--fg-extra-muted)" }}
              data-testid="turn-working-elapsed"
            >
              · {formattedElapsed}
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

  // Compact power-user telemetry tucked cleanly into tooltip instead of a noisy bottom dashboard
  const telemetryTooltipParts: string[] = [];
  if (computedTps > 0.5) telemetryTooltipParts.push(`${computedTps.toFixed(1)} tok/s`);
  if (totalTok > 0) telemetryTooltipParts.push(`${formatCompactTokens(totalTok)} tok`);
  if (cacheHitPct > 0) telemetryTooltipParts.push(`Cache ${cacheHitPct}%`);
  if (costUsd > 0) {
    telemetryTooltipParts.push(`$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(3)}`);
  }
  const telemetryTooltip = telemetryTooltipParts.join(" · ");

  if (!assistantContent && !onRetry && !durationText && ins === 0 && del === 0) {
    return null;
  }

  return (
    <div
      className="mt-1.5 flex min-h-[24px] flex-wrap items-center gap-1 opacity-70 transition-opacity duration-150 hover:opacity-100"
      data-testid="turn-footer"
    >
      {assistantContent && (
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy response"}
          className="v-press -ml-1 flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--surface-2)] cursor-pointer"
          style={{ color: copied ? "var(--status-success)" : "var(--fg-muted)" }}
        >
          <span key={copied ? "ok" : "cp"} className="v-icon-morph">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </span>
        </button>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          title="重试本轮 (Retry turn)"
          className="v-press flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--surface-2)] hover:text-[var(--fg)] cursor-pointer"
        >
          <RotateCcw className="h-3.5 w-3.5" style={{ color: "var(--fg-muted)" }} />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          onClick={onFork}
          title="从此处克隆出新分支会话 (Fork session from this turn)"
          className="v-press flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--surface-2)] hover:text-[var(--fg)] cursor-pointer"
        >
          <GitFork className="h-3.5 w-3.5" style={{ color: "var(--fg-muted)" }} />
        </button>
      )}

      {durationText && (
        <span
          onMouseEnter={() => canSwapTimestamp && setHoveredTiming(true)}
          onMouseLeave={() => setHoveredTiming(false)}
          title={telemetryTooltip || undefined}
          className="ml-1 text-[12px] tabular-nums select-none transition-colors"
          style={{ color: "var(--fg-extra-muted)" }}
        >
          {hoveredTiming && canSwapTimestamp ? completedAtLabel : durationText}
        </span>
      )}

      {(ins > 0 || del > 0) && onOpenDiff && (
        <button
          type="button"
          onClick={onOpenDiff}
          title="Review worktree changes"
          className="v-press ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono-code text-[11.5px] tabular-nums hover:bg-[var(--surface-2)] cursor-pointer"
        >
          <span style={{ color: "var(--status-success)" }}>
            <VeloNumberTicker value={ins} prefix="+" durationMs={300} />
          </span>
          <span style={{ color: "var(--status-danger)" }}>
            <VeloNumberTicker value={del} prefix="−" durationMs={300} />
          </span>
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

const FILLER_THINKING_LINES = new Set([
  "i'm thinking through how to approach this",
  "i am thinking through how to approach this",
  "let me think",
  "let's think",
  "let's see",
  "okay",
  "alright",
  "hmm",
]);

export function isPlaceholderReasoningText(raw: string): boolean {
  const t = raw.trim().replace(/\*\*/g, "").trim();
  if (/^Reasoning completed\s*\(\d+\s+thinking tokens\)$/i.test(t)) return true;
  const nonFiller = t
    .split("\n")
    .map((l) =>
      l
        .trim()
        .toLowerCase()
        .replace(/[.!?,:…]+$/g, "")
        .trim()
    )
    .filter((l) => l.length > 0 && !FILLER_THINKING_LINES.has(l));
  return nonFiller.length === 0;
}

export function extractThinkingTokensFromPlaceholder(raw: string): number | null {
  const m = raw.match(/Reasoning completed\s*\((\d+)\s+thinking tokens\)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Only returns a concise native `**Bold Heading**` (e.g. Codex reasoning summaries <= 52 chars).
 * Never slices raw long prose mid-sentence as a fake title.
 */
export function extractThinkingHeadline(raw: string): string {
  if (!raw || isPlaceholderReasoningText(raw)) return "";

  // 1. Collect ALL native **Bold Headings** (handles Codex concatenating "**A** **B**" on one line)
  const boldMatches: string[] = [];
  const boldRe = /\*\*([^*\n]{2,64})\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(raw)) !== null) {
    const inner = m[1].trim().replace(/[.。:：…]+$/g, "").trim();
    const norm = inner.toLowerCase();
    if (
      inner.length >= 2 &&
      inner.length <= 58 &&
      !/^reasoning completed\s*\(/i.test(norm) &&
      !FILLER_THINKING_LINES.has(norm)
    ) {
      boldMatches.push(inner);
    }
  }
  if (boldMatches.length > 0) {
    return boldMatches[boldMatches.length - 1];
  }
  return "";
}

/**
 * Helper to clean raw reasoning text (strips fake boilerplate and filler openers)
 */
function parseReasoningContent(raw: string): {
  summary: string;
  cleanedLines: string[];
} {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (l.startsWith("正在分析工作区上下文") || l.startsWith("推理完成（思考")) return false;
      const norm = l
        .replace(/\*\*/g, "")
        .trim()
        .toLowerCase()
        .replace(/[.!?,:…]+$/g, "")
        .trim();
      if (FILLER_THINKING_LINES.has(norm)) return false;
      if (/^reasoning completed\s*\(\d+\s+thinking tokens\)$/i.test(norm)) return false;
      return true;
    });

  if (lines.length === 0) {
    return { summary: "", cleanedLines: [] };
  }

  return { summary: extractThinkingHeadline(raw), cleanedLines: lines };
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
  showLivePreview?: boolean;
}> = React.memo(({
  text,
  isStreaming = false,
  startedAtMs,
  durationMs,
  defaultExpanded = false,
  showLivePreview = false,
}) => {
  const { summary, cleanedLines } = useMemo(() => parseReasoningContent(text), [text]);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(
    defaultExpanded ? true : null
  );
  const [liveThinkMs, setLiveThinkMs] = useState<number>(() =>
    startedAtMs ? Math.max(0, Date.now() - startedAtMs) : 0
  );
  const scrollBoxRef = useRef<HTMLDivElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);

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
    if (isStreaming && showLivePreview && !effectiveExpanded && previewBoxRef.current) {
      previewBoxRef.current.scrollTop = previewBoxRef.current.scrollHeight;
    }
  }, [text, isStreaming, effectiveExpanded, showLivePreview]);

  if (!hasDetail && !isStreaming) {
    return null;
  }

  const primaryLabel = isStreaming
    ? Math.round(liveThinkMs / 1000) >= 1
      ? `Thinking for ${formatPaseoDuration(liveThinkMs)}`
      : "Thinking…"
    : durationMs !== undefined && durationMs >= 1000
    ? `Thought for ${formatPaseoDuration(durationMs)}`
    : "Thought";

  const displaySecondary = summary ? `· ${summary}` : undefined;
  const renderSoftPreview = Boolean(isStreaming && showLivePreview && hasDetail && !effectiveExpanded);

  return (
    <div>
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
      {renderSoftPreview && (
        <PaseoIndentRail className="mt-0.5 mb-1">
          <div
            ref={previewBoxRef}
            className="max-h-[64px] overflow-hidden text-[12px] leading-[1.5] space-y-0.5 select-none"
            style={{
              color: "var(--fg-extra-muted)",
              WebkitMaskImage:
                "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.85) 32%, black 100%)",
              maskImage:
                "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.85) 32%, black 100%)",
            }}
          >
            {cleanedLines.slice(-4).map((line, i) => (
              <div key={i} className="truncate">
                {line.replace(/\*\*/g, "")}
              </div>
            ))}
          </div>
        </PaseoIndentRail>
      )}
    </div>
  );
});

/**
 * ============================================================================
 * 6. PASEO TOOL CALL CARD (packages/app/src/components/message.tsx + tool-call-details.tsx)
 * ============================================================================
 */
const MCP_ACTION_LABELS: Record<string, string> = {
  take_screenshot: "Screenshot",
  take_snapshot: "Snapshot",
  click: "Click",
  evaluate_script: "Evaluate",
  list_console_messages: "Console",
  list_pages: "Pages",
  navigate_page: "Navigate",
  new_page: "New page",
  close_page: "Close page",
  select_page: "Select page",
  fill: "Fill",
  fill_form: "Fill form",
  hover: "Hover",
  press_key: "Key press",
  wait_for: "Wait",
  list_network_requests: "Network",
  get_network_request: "Request",
  get_console_message: "Log",
  resize_page: "Resize",
};

function formatMcpServerLabel(rawServer: string): string {
  const s = rawServer.trim().toLowerCase();
  if (s.includes("chrome-devtools")) return "Chrome DevTools";
  if (s.includes("playwright")) return "Playwright";
  if (s.includes("github")) return "GitHub";
  if (s.includes("figma")) return "Figma";
  if (s.includes("linear")) return "Linear";
  if (s.includes("postgres") || s.includes("supabase")) return "Database";
  const cleaned = rawServer
    .replace(/-plugin_.*$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return cleaned
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ") || "MCP";
}

function isInternalAgentNoisePath(filePath?: string): boolean {
  if (!filePath) return false;
  return (
    filePath.includes("/.gemini/antigravity-cli/mcp/") ||
    filePath.includes("/.gemini/antigravity/mcp/") ||
    filePath.includes("/.system_generated/steps/") ||
    filePath.includes("/.system_generated/logs/")
  );
}

export function resolvePaseoToolPresentation(
  toolName: string,
  input: unknown,
  output?: string
): {
  displayName: string;
  workingVerb: string;
  summary?: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  kind: "shell" | "edit" | "read" | "search" | "mcp" | "other";
  command?: string;
  filePath?: string;
  isInternalNoise?: boolean;
  mcpServer?: string;
  mcpAction?: string;
} {
  const lower = toolName.trim().toLowerCase();
  const inputObj =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  // Semantic MCP tool presentation (`call_mcp_tool` or `mcp_<server>_<tool>`)
  if (lower === "call_mcp_tool" || lower.startsWith("mcp_")) {
    const rawServer =
      (inputObj.ServerName as string) ||
      (inputObj.server_name as string) ||
      (lower.startsWith("mcp_") ? toolName.split("_").slice(1, -1).join("_") : "MCP");
    const rawTool =
      (inputObj.ToolName as string) ||
      (inputObj.tool_name as string) ||
      (lower.startsWith("mcp_") ? toolName.split("_").slice(-1)[0] : toolName);
    const serverLabel = formatMcpServerLabel(rawServer);
    const actionLabel =
      MCP_ACTION_LABELS[rawTool.toLowerCase()] || rawTool.replace(/_/g, " ");
    return {
      displayName: serverLabel,
      workingVerb: `${serverLabel} · ${actionLabel}`,
      summary: actionLabel,
      icon: Sparkles,
      kind: "mcp",
      mcpServer: serverLabel,
      mcpAction: actionLabel,
    };
  }

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
  const internalNoise = isInternalAgentNoisePath(filePath);

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
    const baseName = shortPath ? shortPath.split("/").pop() || shortPath : undefined;
    return {
      displayName: "Read",
      workingVerb: baseName ? `Reading ${baseName}` : "Reading file",
      summary: shortPath || command,
      icon: Eye,
      kind: "read",
      filePath,
      isInternalNoise: internalNoise,
    };
  }
  if (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("patch") ||
    lower.includes("file_change")
  ) {
    const baseName = shortPath ? shortPath.split("/").pop() || shortPath : undefined;
    return {
      displayName: lower.includes("write") ? "Write" : "Edit",
      workingVerb: baseName ? `Editing ${baseName}` : "Editing code",
      summary: shortPath || command,
      icon: Pencil,
      kind: "edit",
      filePath,
      isInternalNoise: internalNoise,
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
      workingVerb: query ? `Searching "${query.slice(0, 28)}"` : "Searching",
      summary: query || shortPath || command,
      icon: Search,
      kind: "search",
    };
  }
  if (lower.includes("task") || lower.includes("agent")) {
    return {
      displayName: "Task",
      workingVerb: "Running subagent",
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
  isActive?: boolean;
  onOpenDiffTab?: () => void;
}> = React.memo(({ toolName, input, output, isError = false, isActive = false, onOpenDiffTab }) => {
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
  const isRunning = isActive && output === undefined;

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
            <div className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]" style={{ color: "var(--fg)" }}>
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
}, (prev, next) =>
  prev.toolName === next.toolName &&
  prev.input === next.input &&
  prev.output === next.output &&
  prev.isError === next.isError &&
  prev.isActive === next.isActive
);

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

export type TraceEngineMode = "focus_footprint" | "codex_summary" | "claude_stream";

export function resolveTraceEngineMode(provider?: string): TraceEngineMode {
  const p = (provider || "").trim().toLowerCase();
  if (p === "agy" || p === "antigravity" || p === "cursor" || p === "grok") {
    return "focus_footprint";
  }
  if (p === "codex") {
    return "codex_summary";
  }
  return "claude_stream";
}

export function isFocusFootprintProvider(provider?: string): boolean {
  return resolveTraceEngineMode(provider) === "focus_footprint";
}

type FlatActivityRow =
  | { kind: "thinking"; step: PaseoTraceStepItem }
  | { kind: "tool"; step: PaseoTraceStepItem }
  | { kind: "explore_batch"; id: string; steps: PaseoTraceStepItem[] };

function isExplorationTool(step: PaseoTraceStepItem): boolean {
  if (step.kind !== "tool_call") return false;
  const pres = resolvePaseoToolPresentation(step.toolName || "Tool", step.input, step.output);
  return pres.kind === "read" || pres.kind === "search";
}

function buildFlatActivityRows(
  steps: PaseoTraceStepItem[],
  isTurnRunning: boolean,
  hideInternalNoise: boolean
): FlatActivityRow[] {
  const filtered: PaseoTraceStepItem[] = [];
  for (const st of steps) {
    if (st.kind === "thinking") {
      const text = st.text || "";
      const streaming = Boolean(isTurnRunning && st.isStreamingThinking);
      if (streaming || !isPlaceholderReasoningText(text)) {
        filtered.push(st);
      }
      continue;
    }
    if (hideInternalNoise) {
      const pres = resolvePaseoToolPresentation(st.toolName || "Tool", st.input, st.output);
      if (pres.isInternalNoise) continue;
    }
    filtered.push(st);
  }

  const rows: FlatActivityRow[] = [];
  let i = 0;
  while (i < filtered.length) {
    const st = filtered[i];
    if (st.kind === "thinking") {
      rows.push({ kind: "thinking", step: st });
      i++;
      continue;
    }

    // Coalesce 2+ consecutive read/search exploration steps into a single crisp row
    if (isExplorationTool(st)) {
      let j = i;
      while (j + 1 < filtered.length && isExplorationTool(filtered[j + 1])) {
        j++;
      }
      if (j > i) {
        rows.push({
          kind: "explore_batch",
          id: `explore-${st.id}-${j - i + 1}`,
          steps: filtered.slice(i, j + 1),
        });
        i = j + 1;
        continue;
      }
    }

    rows.push({ kind: "tool", step: st });
    i++;
  }
  return rows;
}

const ExploreBatchRow: React.FC<{
  steps: PaseoTraceStepItem[];
  isTurnRunning: boolean;
  onOpenDiffForFile?: (fileArg?: string) => void;
}> = ({ steps, isTurnRunning, onOpenDiffForFile }) => {
  const [expanded, setExpanded] = useState(false);

  const info = useMemo(() => {
    let readCount = 0;
    let searchCount = 0;
    let hasError = false;
    let runningVerb = "";
    const targets: string[] = [];

    for (const st of steps) {
      if (st.isError) hasError = true;
      const pres = resolvePaseoToolPresentation(st.toolName || "Tool", st.input, st.output);
      if (pres.kind === "read") readCount++;
      else searchCount++;
      if (isTurnRunning && st.output === undefined) {
        runningVerb = pres.workingVerb;
      }
      const shortTarget = pres.summary
        ? pres.kind === "read"
          ? pres.summary.split("/").pop() || pres.summary
          : pres.summary.slice(0, 28)
        : "";
      if (shortTarget && !targets.includes(shortTarget)) {
        targets.push(shortTarget);
      }
    }

    const isAnyRunning = Boolean(isTurnRunning && runningVerb);
    const labelParts: string[] = [];
    if (readCount > 0) labelParts.push(`Read ${readCount} ${readCount === 1 ? "file" : "files"}`);
    if (searchCount > 0)
      labelParts.push(`Searched ${searchCount} ${searchCount === 1 ? "query" : "queries"}`);

    const label = isAnyRunning ? `${runningVerb}…` : labelParts.join(" · ");

    const preview =
      targets.length > 0
        ? targets.slice(0, 2).join(", ") +
          (targets.length > 2 ? ` +${targets.length - 2}` : "")
        : undefined;

    return {
      label,
      secondaryLabel: isAnyRunning
        ? readCount + searchCount > 1
          ? `· ${readCount + searchCount} items`
          : undefined
        : preview,
      hasError,
      isAnyRunning,
      icon: readCount >= searchCount ? Eye : Search,
    };
  }, [steps, isTurnRunning]);

  return (
    <PaseoExpandableBadge
      label={info.label}
      secondaryLabel={info.secondaryLabel}
      icon={info.icon}
      isExpanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      isLoading={info.isAnyRunning}
      isError={info.hasError}
      borderlessWhenExpanded
    >
      <PaseoIndentRail className="space-y-0.5 py-0.5">
        {steps.map((st) => (
          <BeautifulToolCallCard
            key={st.id}
            toolName={st.toolName || "Tool"}
            input={st.input}
            output={st.output}
            isError={st.isError}
            isActive={isTurnRunning}
            onOpenDiffTab={() => onOpenDiffForFile?.(st.fileArg)}
          />
        ))}
      </PaseoIndentRail>
    </PaseoExpandableBadge>
  );
};

interface FocusFootprintRow {
  category: "edit" | "shell" | "mcp" | "read";
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  isActive: boolean;
  items: Array<{ label: string; count: number; fileArg?: string }>;
  extraCount: number;
}

interface FocusFootprintData {
  activeToolVerb: string;
  activeCategory: "edit" | "shell" | "mcp" | "read" | null;
  visibleStepCount: number;
  hasError: boolean;
  rows: FocusFootprintRow[];
}

function buildFocusFootprintData(
  steps: PaseoTraceStepItem[],
  isTurnRunning: boolean
): FocusFootprintData {
  let hasError = false;
  let visibleStepCount = 0;
  let activeToolVerb = "";
  let activeCategory: FocusFootprintData["activeCategory"] = null;

  const editMap = new Map<string, { label: string; count: number; fileArg?: string }>();
  const cmdMap = new Map<string, { label: string; count: number }>();
  const mcpMap = new Map<string, { server: string; actions: string[]; count: number }>();
  const readSet: string[] = [];
  let searchCount = 0;

  for (const st of steps) {
    if (st.kind === "thinking") {
      if (!isPlaceholderReasoningText(st.text || "")) {
        visibleStepCount++;
      }
      continue;
    }
    if (st.isError) hasError = true;
    const pres = resolvePaseoToolPresentation(st.toolName || "Tool", st.input, st.output);
    if (pres.isInternalNoise) continue;

    visibleStepCount++;
    if (isTurnRunning && st.output === undefined) {
      activeToolVerb = pres.workingVerb;
      if (pres.kind === "edit") activeCategory = "edit";
      else if (pres.kind === "shell") activeCategory = "shell";
      else if (pres.kind === "mcp") activeCategory = "mcp";
      else if (pres.kind === "read" || pres.kind === "search") activeCategory = "read";
    }

    if (pres.kind === "edit") {
      const base = pres.summary ? pres.summary.split("/").pop() || pres.summary : "file";
      const prev = editMap.get(base);
      if (prev) prev.count += 1;
      else editMap.set(base, { label: base, count: 1, fileArg: st.fileArg || pres.filePath });
    } else if (pres.kind === "shell") {
      const rawCmd = (pres.command || pres.summary || "shell").split("\n")[0].trim();
      const shortCmd = rawCmd.length > 44 ? `${rawCmd.slice(0, 42).trimEnd()}…` : rawCmd;
      const prev = cmdMap.get(shortCmd);
      if (prev) prev.count += 1;
      else cmdMap.set(shortCmd, { label: shortCmd, count: 1 });
    } else if (pres.kind === "mcp") {
      const srv = pres.mcpServer || pres.displayName || "MCP";
      const act = pres.mcpAction || pres.summary || "Call";
      const prev = mcpMap.get(srv);
      if (prev) {
        prev.count += 1;
        if (!prev.actions.includes(act)) prev.actions.push(act);
      } else {
        mcpMap.set(srv, { server: srv, actions: [act], count: 1 });
      }
    } else if (pres.kind === "read") {
      const base = pres.summary ? pres.summary.split("/").pop() || pres.summary : "";
      if (base && !readSet.includes(base)) readSet.push(base);
    } else if (pres.kind === "search") {
      searchCount++;
    }
  }

  const rows: FocusFootprintRow[] = [];

  if (editMap.size > 0) {
    const all = Array.from(editMap.values());
    rows.push({
      category: "edit",
      icon: Pencil,
      isActive: activeCategory === "edit",
      items: all.slice(0, 3),
      extraCount: Math.max(0, all.length - 3),
    });
  }

  if (cmdMap.size > 0) {
    const all = Array.from(cmdMap.values());
    rows.push({
      category: "shell",
      icon: SquareTerminal,
      isActive: activeCategory === "shell",
      items: all.slice(0, 2),
      extraCount: Math.max(0, all.length - 2),
    });
  }

  if (mcpMap.size > 0) {
    const mcpItems = Array.from(mcpMap.values()).map((m) => ({
      label: `${m.server} · ${m.actions.slice(0, 2).join(" / ")}`,
      count: m.count,
    }));
    rows.push({
      category: "mcp",
      icon: Sparkles,
      isActive: activeCategory === "mcp",
      items: mcpItems.slice(0, 2),
      extraCount: Math.max(0, mcpItems.length - 2),
    });
  }

  // Only add Read/Search node if we still have room within the 3-row budget
  if (rows.length < 3 && (readSet.length > 0 || searchCount > 0)) {
    const items: Array<{ label: string; count: number }> = [];
    for (const f of readSet.slice(0, 3)) {
      items.push({ label: f, count: 1 });
    }
    if (items.length === 0 && searchCount > 0) {
      items.push({ label: "Code search", count: searchCount });
    }
    rows.push({
      category: "read",
      icon: readSet.length > 0 ? Eye : Search,
      isActive: activeCategory === "read",
      items,
      extraCount: Math.max(0, readSet.length - 3),
    });
  }

  return {
    activeToolVerb,
    activeCategory,
    visibleStepCount: Math.max(visibleStepCount, 1),
    hasError,
    rows: rows.slice(0, 3),
  };
}

function summarizeCompletedActivity(steps: PaseoTraceStepItem[]): {
  label: string;
  secondaryLabel?: string;
  hasError: boolean;
} {
  let readCount = 0;
  let searchCount = 0;
  let editCount = 0;
  let shellCount = 0;
  let mcpCount = 0;
  let mcpServerName = "";
  let otherCount = 0;
  let realThinkCount = 0;
  let hasError = false;
  const editedFiles: string[] = [];

  for (const st of steps) {
    if (st.kind === "thinking") {
      if (!isPlaceholderReasoningText(st.text || "")) {
        realThinkCount++;
      }
      continue;
    }
    if (st.isError) hasError = true;
    const pres = resolvePaseoToolPresentation(st.toolName || "Tool", st.input, st.output);
    if (pres.isInternalNoise) continue;
    if (pres.kind === "read") readCount++;
    else if (pres.kind === "search") searchCount++;
    else if (pres.kind === "edit") {
      editCount++;
      const f = pres.summary ? pres.summary.split("/").pop() || pres.summary : "";
      if (f && !editedFiles.includes(f)) editedFiles.push(f);
    } else if (pres.kind === "shell") shellCount++;
    else if (pres.kind === "mcp") {
      mcpCount++;
      if (!mcpServerName && pres.mcpServer) mcpServerName = pres.mcpServer;
    } else otherCount++;
  }

  const parts: string[] = [];
  if (editedFiles.length > 0) {
    parts.push(`Edited ${editedFiles.length} ${editedFiles.length === 1 ? "file" : "files"}`);
  } else if (editCount > 0) {
    parts.push(`${editCount} ${editCount === 1 ? "edit" : "edits"}`);
  }
  if (shellCount > 0) parts.push(`${shellCount} ${shellCount === 1 ? "command" : "commands"}`);
  if (mcpCount > 0) parts.push(`${mcpServerName || "MCP"} ×${mcpCount}`);
  if (readCount > 0 && parts.length < 3) {
    parts.push(`Read ${readCount} ${readCount === 1 ? "file" : "files"}`);
  }
  if (searchCount > 0 && parts.length < 3) {
    parts.push(`${searchCount} ${searchCount === 1 ? "search" : "searches"}`);
  }
  if (otherCount > 0 && parts.length < 3) {
    parts.push(`${otherCount} ${otherCount === 1 ? "tool" : "tools"}`);
  }
  if (parts.length === 0 && realThinkCount > 0) {
    parts.push(`Thought ${realThinkCount} ${realThinkCount === 1 ? "time" : "times"}`);
  }

  const label = parts.length > 0 ? parts.join(" · ") : `${steps.length} steps`;
  const secondaryLabel =
    editedFiles.length > 0
      ? editedFiles.slice(0, 2).join(", ") +
        (editedFiles.length > 2 ? ` +${editedFiles.length - 2}` : "")
      : undefined;

  return { label, secondaryLabel, hasError };
}

const CodexSummaryThinkingRow: React.FC<{
  step: PaseoTraceStepItem;
  isStreaming: boolean;
}> = ({ step, isStreaming }) => {
  const text = step.text || "";
  const headline = useMemo(() => extractThinkingHeadline(text), [text]);
  const [expanded, setExpanded] = useState(false);
  const { cleanedLines } = useMemo(() => parseReasoningContent(text), [text]);

  if (!headline) {
    return (
      <BeautifulThinkingBlock
        text={text}
        isStreaming={isStreaming}
        startedAtMs={step.startedAtMs}
        durationMs={step.durationMs}
        defaultExpanded={false}
      />
    );
  }

  const hasMoreLines = cleanedLines.length > 1;
  return (
    <div className="py-0.5">
      <div
        role={hasMoreLines ? "button" : undefined}
        tabIndex={hasMoreLines ? 0 : undefined}
        onClick={() => hasMoreLines && setExpanded((v) => !v)}
        className={`group flex items-center gap-1.5 rounded-[7px] -mx-1 px-1.5 py-0.5 text-[12.5px] ${
          hasMoreLines ? "cursor-pointer hover:bg-[var(--surface-1)]" : ""
        }`}
      >
        <Sparkles
          className={`h-3 w-3 shrink-0 ${isStreaming ? "velo-sparkle-breath" : ""}`}
          style={{ color: isStreaming ? "var(--accent)" : "var(--fg-extra-muted)" }}
        />
        <span
          className={`min-w-0 flex-1 truncate ${
            isStreaming ? "beautiful-shimmer-text font-medium" : "font-medium"
          }`}
          style={!isStreaming ? { color: "var(--fg-muted)" } : undefined}
        >
          {headline}
        </span>
        {hasMoreLines && (
          <ChevronRight
            className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100 transition-transform"
            style={{
              color: "var(--fg-muted)",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
          />
        )}
      </div>
      {expanded && hasMoreLines && (
        <PaseoIndentRail className="my-1">
          <div className="max-h-[200px] overflow-y-auto py-0.5 space-y-1">
            {cleanedLines.map((line, i) => renderFormattedLine(line, i))}
          </div>
        </PaseoIndentRail>
      )}
    </div>
  );
};

function resolveInlineTraceSummary(
  steps: PaseoTraceStepItem[],
  isTurnRunning: boolean
): {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; style?: React.CSSProperties }>;
  label: string;
  activeVerb: string;
  hasError: boolean;
} {
  let latestHeadline = "";
  let activeVerb = "";
  let activeKind: "edit" | "shell" | "read" | "search" | "mcp" | "other" | null = null;
  let hasError = false;

  let readCount = 0;
  let searchCount = 0;
  let editCount = 0;
  let shellCount = 0;
  let mcpCount = 0;
  let otherCount = 0;
  let totalThinkMs = 0;

  let lastReadFile = "";
  let lastEditFile = "";
  let lastShellCmd = "";
  let lastSearchQuery = "";
  let lastMcpLabel = "";

  for (const st of steps) {
    if (st.kind === "thinking") {
      if (st.durationMs) totalThinkMs += st.durationMs;
      const h = extractThinkingHeadline(st.text || "");
      if (h) latestHeadline = h;
      continue;
    }

    if (st.isError) hasError = true;
    const pres = resolvePaseoToolPresentation(st.toolName || "Tool", st.input, st.output);
    if (pres.isInternalNoise) continue;

    if (isTurnRunning && st.output === undefined) {
      activeVerb = pres.workingVerb;
      activeKind =
        pres.kind === "edit" ||
        pres.kind === "shell" ||
        pres.kind === "read" ||
        pres.kind === "search" ||
        pres.kind === "mcp"
          ? pres.kind
          : "other";
    }

    if (pres.kind === "read") {
      readCount++;
      const base = pres.summary ? pres.summary.split("/").pop() || pres.summary : "";
      if (base) lastReadFile = base;
    } else if (pres.kind === "search") {
      searchCount++;
      if (pres.summary) lastSearchQuery = pres.summary.slice(0, 36);
    } else if (pres.kind === "edit") {
      editCount++;
      const base = pres.summary ? pres.summary.split("/").pop() || pres.summary : "";
      if (base) lastEditFile = base;
    } else if (pres.kind === "shell") {
      shellCount++;
      const raw = (pres.command || pres.summary || "").split("\n")[0].trim();
      if (raw) {
        lastShellCmd = raw.length > 36 ? `${raw.slice(0, 34).trimEnd()}…` : raw;
      }
    } else if (pres.kind === "mcp") {
      mcpCount++;
      const srv = pres.mcpServer || pres.displayName || "MCP";
      const act = pres.mcpAction ? ` · ${pres.mcpAction}` : "";
      lastMcpLabel = `${srv}${act}`;
    } else {
      otherCount++;
    }
  }

  const pickIcon = () => {
    if (hasError) return TriangleAlert;
    if (activeKind === "edit") return Pencil;
    if (activeKind === "shell") return SquareTerminal;
    if (activeKind === "read") return Eye;
    if (activeKind === "search") return Search;
    if (activeKind === "mcp") return Sparkles;

    const hl = latestHeadline.toLowerCase();
    if (
      hl &&
      /\b(check|inspect|search|find|investigat|analyz|look|explor|review|verify|audit)\w*/i.test(hl)
    ) {
      return Search;
    }
    if (editCount > 0) return Pencil;
    if (searchCount > 0) return Search;
    if (readCount > 0) return Eye;
    if (shellCount > 0) return SquareTerminal;
    if (mcpCount > 0) return Sparkles;
    return Search;
  };

  // While running: prefer crisp semantic headline or active verb
  if (isTurnRunning) {
    const label = activeVerb
      ? latestHeadline && activeKind !== "edit"
        ? latestHeadline
        : activeVerb
      : latestHeadline || "Thinking";
    const runningIcon =
      label === "Thinking" && !hasError ? Sparkles : pickIcon();
    return {
      icon: runningIcon,
      label,
      activeVerb: activeVerb || latestHeadline,
      hasError,
    };
  }

  // Completed: one calm natural phrase (prefer model's semantic headline when exploration/checking)
  let label = "";
  if (latestHeadline && editCount === 0) {
    label = latestHeadline;
  } else if (editCount === 1 && lastEditFile) {
    label = `Edited ${lastEditFile}`;
  } else if (editCount > 1) {
    label = `Edited ${editCount} files`;
  } else if (shellCount === 1 && lastShellCmd) {
    label = `Ran ${lastShellCmd}`;
  } else if (shellCount > 1) {
    label = `Ran ${shellCount} commands`;
  } else if (readCount > 0 && searchCount === 0) {
    label = readCount === 1 && lastReadFile ? `Read ${lastReadFile}` : `Read ${readCount} files`;
  } else if (searchCount > 0) {
    label =
      searchCount === 1 && lastSearchQuery
        ? `Searched ${lastSearchQuery}`
        : `Searched ${searchCount} queries`;
  } else if (mcpCount > 0) {
    label = mcpCount === 1 && lastMcpLabel ? lastMcpLabel : `${lastMcpLabel || "MCP"} ×${mcpCount}`;
  } else if (otherCount > 0) {
    label = otherCount === 1 ? "Used 1 tool" : `Used ${otherCount} tools`;
  } else if (latestHeadline) {
    label = latestHeadline;
  } else if (totalThinkMs >= 1000) {
    label = `Thought for ${formatPaseoDuration(totalThinkMs)}`;
  } else {
    label = "Thought";
  }

  return {
    icon: pickIcon(),
    label,
    activeVerb: "",
    hasError,
  };
}

export const PaseoExecutionTraceGroup: React.FC<{
  steps: PaseoTraceStepItem[];
  provider?: string;
  startedAtMs?: number;
  isTurnRunning?: boolean;
  defaultExpanded?: boolean;
  onOpenDiffForFile?: (fileArg?: string) => void;
}> = ({
  steps,
  provider,
  startedAtMs,
  isTurnRunning = false,
  defaultExpanded = false,
  onOpenDiffForFile,
}) => {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [heldLabel, setHeldLabel] = useState<string>("");
  const [fallbackStartMs] = useState<number>(() => Date.now());
  const prevRunningRef = useRef<boolean>(isTurnRunning);
  const engineMode = resolveTraceEngineMode(provider);

  // Smoothly return to clean single-line state when turn completes
  useEffect(() => {
    if (prevRunningRef.current && !isTurnRunning) {
      setUserExpanded(null);
      setHeldLabel("");
    }
    prevRunningRef.current = isTurnRunning;
  }, [isTurnRunning]);

  const flatRows = useMemo(
    () => buildFlatActivityRows(steps, isTurnRunning, engineMode === "focus_footprint"),
    [steps, isTurnRunning, engineMode]
  );

  const inlineSummary = useMemo(
    () => resolveInlineTraceSummary(steps, isTurnRunning),
    [steps, isTurnRunning]
  );

  // 1.2s transition buffer so rapid 0.2s tool calls don't flash back to `Thinking`
  const rawActiveLabel = isTurnRunning ? inlineSummary.activeVerb : "";
  useEffect(() => {
    if (!isTurnRunning) {
      setHeldLabel("");
      return;
    }
    if (rawActiveLabel) {
      setHeldLabel(rawActiveLabel);
      return;
    }
    if (!heldLabel) return;
    const timer = window.setTimeout(() => {
      setHeldLabel("");
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [rawActiveLabel, isTurnRunning, heldLabel]);

  if (flatRows.length === 0 && !isTurnRunning) {
    return null;
  }

  const drawerOpen = userExpanded ?? defaultExpanded;
  const ActionIcon = inlineSummary.icon;
  const displayLabel =
    isTurnRunning && !inlineSummary.activeVerb && heldLabel
      ? heldLabel
      : inlineSummary.label;

  const renderFlatRows = () => (
    <div className="space-y-0.5">
      {flatRows.map((row) => {
        if (row.kind === "thinking") {
          const isStreamingThis = Boolean(isTurnRunning && row.step.isStreamingThinking);
          if (engineMode === "codex_summary") {
            return (
              <CodexSummaryThinkingRow
                key={row.step.id}
                step={row.step}
                isStreaming={isStreamingThis}
              />
            );
          }
          return (
            <BeautifulThinkingBlock
              key={row.step.id}
              text={row.step.text || ""}
              isStreaming={isStreamingThis}
              startedAtMs={row.step.startedAtMs}
              durationMs={row.step.durationMs}
              defaultExpanded={false}
              showLivePreview={engineMode === "claude_stream"}
            />
          );
        }
        if (row.kind === "explore_batch") {
          return (
            <ExploreBatchRow
              key={row.id}
              steps={row.steps}
              isTurnRunning={isTurnRunning}
              onOpenDiffForFile={onOpenDiffForFile}
            />
          );
        }
        return (
          <BeautifulToolCallCard
            key={row.step.id}
            toolName={row.step.toolName || "Tool"}
            input={row.step.input}
            output={row.step.output}
            isError={row.step.isError}
            isActive={isTurnRunning}
            onOpenDiffTab={() => onOpenDiffForFile?.(row.step.fileArg)}
          />
        );
      })}
    </div>
  );

  const effectiveStartedAtMs = startedAtMs ?? fallbackStartMs;

  return (
    <div className="my-1 select-none">
      <button
        type="button"
        onClick={() => setUserExpanded((prev) => !(prev ?? defaultExpanded))}
        className="group/trace v-press inline-flex max-w-full items-center gap-1.5 py-0.5 text-left text-[13.5px] leading-[1.45] cursor-pointer"
      >
        <ActionIcon
          strokeWidth={1.75}
          className={`h-[14px] w-[14px] shrink-0 transition-colors ${
            isTurnRunning ? "velo-sparkle-breath" : ""
          }`}
          style={{
            color: inlineSummary.hasError
              ? "var(--status-danger)"
              : isTurnRunning
              ? "var(--accent)"
              : "var(--fg-extra-muted)",
          }}
        />
        <span
          className={`truncate font-normal transition-colors group-hover/trace:text-[var(--fg)] ${
            isTurnRunning ? "beautiful-shimmer-text" : ""
          }`}
          style={
            !isTurnRunning
              ? {
                  color: inlineSummary.hasError
                    ? "var(--status-danger)"
                    : "var(--fg-muted)",
                }
              : undefined
          }
        >
          {displayLabel}
        </span>
        {isTurnRunning && (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[12px]"
            style={{ color: "var(--fg-extra-muted)" }}
          >
            <span>·</span>
            <PaseoLiveElapsed startedAtMs={effectiveStartedAtMs} />
          </span>
        )}
        <ChevronRight
          strokeWidth={1.75}
          className="h-[13px] w-[13px] shrink-0 opacity-60 transition-all duration-150 group-hover/trace:opacity-100"
          style={{
            color: "var(--fg-extra-muted)",
            transform: drawerOpen ? "rotate(90deg)" : "rotate(0deg)",
          }}
        />
      </button>

      {drawerOpen && flatRows.length > 0 && (
        <div className="velo-phase-morph ml-[20px] mt-1 mb-1 space-y-0.5">
          {renderFlatRows()}
        </div>
      )}
    </div>
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
}> = React.memo(({ language, code }) => {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);
  const isLong = lines.length > 35;
  const [collapsed, setCollapsed] = useState(false);

  const visibleLines = collapsed ? lines.slice(0, 14) : lines;

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
      className="group/code my-2.5 overflow-hidden rounded-[10px] border shadow-2xs"
      style={{
        borderColor: "var(--border-subtle)",
        backgroundColor: "var(--surface-0)",
      }}
    >
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px]"
        style={{
          borderColor: "var(--border-subtle)",
          backgroundColor: "var(--surface-1)",
          color: "var(--fg-muted)",
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono-code font-medium lowercase select-none text-[var(--v-fg-secondary)]">
            {language || "code"}
          </span>
          <span className="font-mono-code text-[10px] tabular-nums opacity-65 select-none">
            {lines.length} {lines.length === 1 ? "line" : "lines"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWrapLines((w) => !w)}
            title={wrapLines ? "取消自动换行" : "自动换行"}
            className={`v-press inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] cursor-pointer ${
              wrapLines
                ? "bg-[var(--surface-3)] text-[var(--fg)]"
                : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
            }`}
          >
            <WrapText className="h-3 w-3" />
          </button>
          {isLong && (
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="v-press inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)] cursor-pointer"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform duration-150 ${
                  collapsed ? "-rotate-90" : ""
                }`}
              />
              <span>{collapsed ? "展开" : "收起"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopyCode}
            className="v-press inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] hover:bg-[var(--surface-2)] hover:text-[var(--fg)] cursor-pointer"
            style={{ color: copied ? "var(--status-success)" : "var(--fg-muted)" }}
          >
            <span key={copied ? "ok" : "cp"} className="v-icon-morph">
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </span>
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
      <div className="relative">
        <pre
          className={`overflow-x-auto p-3 font-mono-code text-[12.5px] leading-[1.58] ${
            wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"
          }`}
          style={{ color: "var(--fg)" }}
        >
          <code>
            {visibleLines.map((line, i) => (
              <React.Fragment key={i}>
                {i > 0 && "\n"}
                {highlightCodeLine(line, language)}
              </React.Fragment>
            ))}
          </code>
        </pre>
        {collapsed && (
          <div
            className="flex items-end justify-center pb-2 pt-8 absolute inset-x-0 bottom-0"
            style={{
              background:
                "linear-gradient(to bottom, transparent 0%, var(--surface-0) 78%)",
            }}
          >
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="v-press rounded-full border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3 py-0.5 text-[11px] font-medium text-[var(--v-fg-secondary)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              展开剩余 {lines.length - 14} 行
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

type MdListItem = {
  depth: number;
  text: string;
  checked?: boolean;
  ordered?: string;
};

type MdBlock =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "hr" }
  | { type: "blockquote"; text: string }
  | { type: "list"; items: MdListItem[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "image"; alt: string; src: string }
  | { type: "paragraph"; text: string };

function matchFenceOpen(line: string): { marker: "`" | "~"; lang: string } | null {
  const match = line.match(/^ {0,3}(```+|~~~+)(.*)$/);
  if (!match) return null;
  const lang = match[2].trim().split(/\s+/)[0] || "";
  return { marker: match[1][0] === "`" ? "`" : "~", lang };
}

function matchFenceClose(line: string, marker: "`" | "~"): boolean {
  const trimmed = line.trim();
  return marker === "`" ? /^```+\s*$/.test(trimmed) : /^~~~+\s*$/.test(trimmed);
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && trimmed.replace(/\|/g, "").trim().length > 0;
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableCells(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
  );
}

function splitTableCells(line: string): string[] {
  let raw = line.trim();
  if (raw.startsWith("|")) raw = raw.slice(1);
  if (raw.endsWith("|") && !raw.endsWith("\\|")) raw = raw.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && raw[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(current.trim().replace(/<br\s*\/?>/gi, "\n"));
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim().replace(/<br\s*\/?>/gi, "\n"));
  return cells;
}

function parseListMarker(line: string): MdListItem | null {
  const match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  if (!match) return null;
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return null;
  const indent = match[1].replace(/\t/g, "  ").length;
  let text = match[3];
  let checked: boolean | undefined;
  const task = text.match(/^\[([ xX])\]\s+(.*)$/);
  if (task && /^[-*+]$/.test(match[2])) {
    checked = task[1].toLowerCase() === "x";
    text = task[2];
  }
  const ordered = /^\d/.test(match[2]) ? match[2].replace(/\)$/, ".") : undefined;
  return { depth: Math.min(6, Math.floor(indent / 2)), text, checked, ordered };
}

function isStructuralLine(line: string, nextLine?: string): boolean {
  if (matchFenceOpen(line)) return true;
  if (/^ {0,3}#{1,6}\s+\S/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}([-*_])\1{2,}\s*$/.test(line)) return true;
  if (parseListMarker(line)) return true;
  if (nextLine && isTableRow(line) && isTableSeparator(nextLine)) return true;
  return false;
}

function parseMarkdownBlocks(content: string): MdBlock[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/<br\s*\/?>/gi, "\n");
  const lines = normalized.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = matchFenceOpen(line);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !matchFenceClose(lines[i], fence.marker)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: "code", lang: fence.lang, code: codeLines.join("\n") });
      continue;
    }

    if (/^ {0,3}([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        const cells = splitTableCells(lines[i]);
        while (cells.length < headers.length) cells.push("");
        rows.push(cells.slice(0, headers.length));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quote.push(lines[i].replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", text: quote.join("\n") });
      continue;
    }

    if (parseListMarker(line)) {
      const items: MdListItem[] = [];
      while (i < lines.length) {
        if (!lines[i].trim()) {
          if (i + 1 < lines.length && parseListMarker(lines[i + 1])) {
            i++;
            continue;
          }
          break;
        }
        const marker = parseListMarker(lines[i]);
        if (marker) {
          items.push(marker);
          i++;
          continue;
        }
        if (/^( {2,}|\t)/.test(lines[i]) && items.length > 0) {
          items[items.length - 1].text += "\n" + lines[i].trim();
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    const image = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)$/);
    if (image) {
      blocks.push({ type: "image", alt: image[1], src: image[2] });
      i++;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const next = lines[i + 1];
      if (paragraph.length > 0 && isStructuralLine(lines[i], next)) break;
      paragraph.push(lines[i].trimEnd());
      i++;
    }
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    }
  }

  return blocks;
}

function parseFileHref(url: string): { path: string; line?: number } | null {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) return null;
  let rest = trimmed.slice(7);
  if (rest.toLowerCase().startsWith("localhost/")) {
    rest = rest.slice("localhost".length);
  }
  let line: number | undefined;
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    const frag = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
    const lineMatch = frag.match(/^L?(\d+)/i);
    if (lineMatch) {
      const parsed = parseInt(lineMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) line = parsed;
    }
  }
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // keep raw path if malformed escape
  }
  if (!rest) return null;
  return { path: rest, line };
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("#")
  ) {
    return trimmed;
  }
  return null;
}

function safeImageSrc(
  src: string,
  resolveImageUrl?: (src: string) => string
): string | null {
  const trimmed = src.trim();
  if (!trimmed || /^javascript:/i.test(trimmed)) return null;
  const resolved = resolveImageUrl ? resolveImageUrl(trimmed) : trimmed;
  if (
    resolved.startsWith("https://") ||
    resolved.startsWith("http://") ||
    resolved.startsWith("data:image/") ||
    resolved.startsWith("/")
  ) {
    return resolved;
  }
  return null;
}

function parseMarkdownLink(
  text: string,
  start: number
): { label: string; url: string; end: number } | null {
  if (text[start] !== "[") return null;
  const labelEnd = text.indexOf("]", start + 1);
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return null;
  const label = text.slice(start + 1, labelEnd);
  if (label.includes("\n")) return null;
  const urlEnd = text.indexOf(")", labelEnd + 2);
  if (urlEnd < 0) return null;
  let url = text.slice(labelEnd + 2, urlEnd).trim();
  const titled = url.match(/^(\S+)\s+["'][^"']*["']$/);
  if (titled) url = titled[1];
  if (!url || /\s/.test(url)) return null;
  return { label, url, end: urlEnd + 1 };
}

function indexOfMarker(text: string, from: number, marker: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (!text.startsWith(marker, i)) continue;
    if (marker.length === 1) {
      const prev = text[i - 1] ?? "";
      const next = text[i + 1] ?? "";
      if (prev === marker || next === marker || prev === " ") continue;
    }
    return i;
  }
  return -1;
}

function renderInlineMarkdown(
  text: string,
  keyBase = "i",
  resolveImageUrl?: (src: string) => string,
  onOpenFileLink?: (filePath: string, line?: number) => void
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let plain = "";
  let key = 0;
  const flush = () => {
    if (!plain) return;
    out.push(plain);
    plain = "";
  };
  const push = (node: React.ReactNode) => {
    flush();
    out.push(<React.Fragment key={`${keyBase}-${key++}`}>{node}</React.Fragment>);
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length && /[\\`*_[\]{}()#+\-.!~|<>]/.test(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (text[i] === "`") {
      let ticks = 0;
      while (text[i + ticks] === "`") ticks++;
      const closer = "`".repeat(ticks);
      const close = text.indexOf(closer, i + ticks);
      if (close !== -1) {
        const code = text.slice(i + ticks, close).replace(/^ /, "").replace(/ $/, "");
        push(
          <code
            className="mx-[1px] rounded-[5px] border px-1.5 py-[1px] font-mono-code text-[12px]"
            style={{
              backgroundColor: "var(--surface-1)",
              borderColor: "var(--border-subtle)",
              color: "var(--fg)",
            }}
          >
            {code}
          </code>
        );
        i = close + ticks;
        continue;
      }
    }

    if (text.startsWith("![", i)) {
      const image = parseMarkdownLink(text, i + 1);
      if (image) {
        const src = safeImageSrc(image.url, resolveImageUrl);
        if (src) {
          push(
            <img
              src={src}
              alt={image.label || "image"}
              className="my-1 max-h-[280px] max-w-full rounded-lg border"
              style={{ borderColor: "var(--border-subtle)" }}
            />
          );
          i = image.end;
          continue;
        }
      }
    }

    if (text[i] === "[") {
      const link = parseMarkdownLink(text, i);
      if (link) {
        const fileTarget = parseFileHref(link.url);
        if (fileTarget) {
          const lineSuffix = fileTarget.line ? `:${fileTarget.line}` : "";
          push(
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenFileLink?.(fileTarget.path, fileTarget.line);
              }}
              title={`在编辑器中打开 ${fileTarget.path}${lineSuffix}`}
              className="inline-flex items-baseline gap-0.5 rounded-[5px] px-1 py-[0.5px] font-mono text-[12.5px] underline decoration-current/35 underline-offset-2 transition-colors hover:decoration-current cursor-pointer"
              style={{
                color: "var(--accent-bright)",
                backgroundColor: "var(--surface-2)",
              }}
            >
              {renderInlineMarkdown(
                link.label,
                `${keyBase}-f${key}`,
                resolveImageUrl,
                onOpenFileLink
              )}
            </button>
          );
          i = link.end;
          continue;
        }
        const href = safeHref(link.url);
        if (href) {
          push(
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 transition-opacity hover:opacity-80"
              style={{ color: "var(--accent-bright)" }}
            >
              {renderInlineMarkdown(
                link.label,
                `${keyBase}-a${key}`,
                resolveImageUrl,
                onOpenFileLink
              )}
            </a>
          );
          i = link.end;
          continue;
        }
      }
    }

    // Auto-linkify bare http:// and https:// URLs in prose (e.g. http://localhost:5173/)
    if (text.startsWith("http://", i) || text.startsWith("https://", i)) {
      const rest = text.slice(i);
      const urlMatch = rest.match(/^https?:\/\/[^\s<>()[\]"'`\u3000-\u303F\uFF00-\uFFEF]+/);
      if (urlMatch) {
        const rawUrl = urlMatch[0].replace(/[.,;:!?]+$/, "");
        if (rawUrl.length > 8) {
          push(
            <a
              href={rawUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 transition-opacity hover:opacity-80"
              style={{ color: "var(--accent-bright)" }}
            >
              {rawUrl}
            </a>
          );
          i += rawUrl.length;
          continue;
        }
      }
    }

    if (
      (text.startsWith("***", i) || text.startsWith("___", i)) &&
      text[i + 3] &&
      text[i + 3] !== " " &&
      text[i + 3] !== text[i]
    ) {
      const marker = text.slice(i, i + 3);
      const close = indexOfMarker(text, i + 3, marker);
      if (close !== -1) {
        push(
          <strong className="font-semibold" style={{ color: "var(--fg)" }}>
            <em>
              {renderInlineMarkdown(
                text.slice(i + 3, close),
                `${keyBase}-bi${key}`,
                resolveImageUrl,
                onOpenFileLink
              )}
            </em>
          </strong>
        );
        i = close + 3;
        continue;
      }
    }

    if (
      (text.startsWith("**", i) || text.startsWith("__", i)) &&
      text[i + 2] &&
      text[i + 2] !== " " &&
      text[i + 2] !== text[i]
    ) {
      const marker = text.slice(i, i + 2);
      const close = indexOfMarker(text, i + 2, marker);
      if (close !== -1) {
        push(
          <strong className="font-semibold" style={{ color: "var(--fg)" }}>
            {renderInlineMarkdown(
              text.slice(i + 2, close),
              `${keyBase}-b${key}`,
              resolveImageUrl,
              onOpenFileLink
            )}
          </strong>
        );
        i = close + 2;
        continue;
      }
    }

    if (text.startsWith("~~", i) && text[i + 2] && text[i + 2] !== " ") {
      const close = indexOfMarker(text, i + 2, "~~");
      if (close !== -1) {
        push(
          <del style={{ color: "var(--fg-muted)" }}>
            {renderInlineMarkdown(
              text.slice(i + 2, close),
              `${keyBase}-s${key}`,
              resolveImageUrl,
              onOpenFileLink
            )}
          </del>
        );
        i = close + 2;
        continue;
      }
    }

    const marker = text[i];
    if ((marker === "*" || marker === "_") && text[i + 1] && text[i + 1] !== marker && text[i + 1] !== " ") {
      const prev = i > 0 ? text[i - 1] : "";
      const midWord = marker === "_" && /[\p{L}\p{N}]/u.test(prev);
      if (!midWord) {
        const close = indexOfMarker(text, i + 1, marker);
        if (close !== -1) {
          push(
            <em className="italic">
              {renderInlineMarkdown(
                text.slice(i + 1, close),
                `${keyBase}-e${key}`,
                resolveImageUrl,
                onOpenFileLink
              )}
            </em>
          );
          i = close + 1;
          continue;
        }
      }
    }

    plain += text[i];
    i++;
  }

  flush();
  return out;
}

function renderInlineLines(
  text: string,
  keyBase: string,
  resolveImageUrl?: (src: string) => string,
  onOpenFileLink?: (filePath: string, line?: number) => void
): React.ReactNode {
  const lines = text.split("\n");
  return lines.map((line, idx) => (
    <React.Fragment key={`${keyBase}-ln-${idx}`}>
      {idx > 0 && <br />}
      {renderInlineMarkdown(line, `${keyBase}-${idx}`, resolveImageUrl, onOpenFileLink)}
    </React.Fragment>
  ));
}

function headingClass(level: number): string {
  if (level === 1) return "text-[16px] font-semibold mt-3 mb-1.5";
  if (level === 2) return "text-[14.5px] font-semibold mt-2.5 mb-1";
  return "text-[13.5px] font-semibold mt-2 mb-0.5";
}

export const PaseoMarkdown: React.FC<{
  content: string;
  isStreaming?: boolean;
  className?: string;
  resolveImageUrl?: (src: string) => string;
  onOpenFileLink?: (filePath: string, line?: number) => void;
}> = React.memo(({ content, isStreaming = false, className = "", resolveImageUrl, onOpenFileLink }) => {
  const sanitizedContent = useMemo(
    () =>
      content
        .replace(/<ask_question_pending\s*\/?>/gi, "")
        .replace(/<\/ask_question_pending>/gi, "")
        .replace(/<ephemeral_message>[\s\S]*?<\/ephemeral_message>/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd(),
    [content]
  );
  const blocks = useMemo(() => parseMarkdownBlocks(sanitizedContent), [sanitizedContent]);

  const renderBlock = (block: MdBlock, idx: number) => {
    const key = `md-${idx}`;
    switch (block.type) {
      case "code":
        return <PaseoCodeBlock key={key} language={block.lang} code={block.code} />;
      case "heading":
        return (
          <div key={key} className={headingClass(block.level)} style={{ color: "var(--fg)" }}>
            {renderInlineMarkdown(block.text, key, resolveImageUrl, onOpenFileLink)}
          </div>
        );
      case "hr":
        return (
          <hr key={key} className="my-3 border-t" style={{ borderColor: "var(--border-subtle)" }} />
        );
      case "blockquote":
        return (
          <blockquote
            key={key}
            className="my-2 border-l-2 pl-3 text-[13px]"
            style={{ borderColor: "var(--border-accent)", color: "var(--fg-muted)" }}
          >
            {renderInlineLines(block.text, key, resolveImageUrl, onOpenFileLink)}
          </blockquote>
        );
      case "list":
        return (
          <div key={key} className="my-1.5 space-y-1 text-[13.5px] leading-[1.65]">
            {block.items.map((item, itemIdx) => (
              <div
                key={`${key}-li-${itemIdx}`}
                className="flex items-start gap-2"
                style={{ paddingLeft: item.depth * 16 }}
              >
                <span className="velo-no-select mt-[1px] w-5 shrink-0 text-right text-[var(--v-fg-muted)]">
                  {item.checked === true ? "☑" : item.checked === false ? "☐" : item.ordered || "•"}
                </span>
                <span className="min-w-0 flex-1">
                  {renderInlineLines(item.text, `${key}-li-${itemIdx}`, resolveImageUrl, onOpenFileLink)}
                </span>
              </div>
            ))}
          </div>
        );
      case "table":
        return (
          <div
            key={key}
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
                  {block.headers.map((cell, cellIdx) => (
                    <th
                      key={cellIdx}
                      className="px-3 py-1.5 font-semibold"
                      style={{ color: "var(--fg)" }}
                    >
                      {renderInlineLines(cell, `${key}-th-${cellIdx}`, resolveImageUrl, onOpenFileLink)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className="border-b last:border-b-0 transition-colors hover:bg-[var(--surface-2)]/60"
                    style={{
                      borderColor: "var(--border-subtle)",
                      backgroundColor: rowIdx % 2 === 1 ? "var(--surface-1)" : "transparent",
                    }}
                  >
                    {row.map((cell, cellIdx) => (
                      <td key={cellIdx} className="px-3 py-1.5 align-top">
                        {renderInlineLines(cell, `${key}-td-${rowIdx}-${cellIdx}`, resolveImageUrl, onOpenFileLink)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "image": {
        const src = safeImageSrc(block.src, resolveImageUrl);
        if (!src) {
          return (
            <p key={key} className="my-1 text-[13.5px] leading-[1.68]">
              {block.alt || block.src}
            </p>
          );
        }
        return (
          <img
            key={key}
            src={src}
            alt={block.alt || "image"}
            className="my-2 max-h-[320px] max-w-full rounded-lg border"
            style={{ borderColor: "var(--border-subtle)" }}
          />
        );
      }
      case "paragraph":
        return (
          <p key={key} className="my-1 text-[13.5px] leading-[1.68]">
            {renderInlineLines(block.text, key, resolveImageUrl, onOpenFileLink)}
          </p>
        );
    }
  };

  return (
    <div
      className={`velo-selectable w-full min-w-0 space-y-1 break-words text-[13.5px] leading-[1.68] ${className}`}
      style={{ color: "var(--v-fg-body)" }}
    >
      {blocks.map(renderBlock)}
      {isStreaming && (
        <span
          aria-hidden="true"
          className="velo-no-select v-caret-breath inline-block h-[14px] w-[2px] translate-y-[2.5px] rounded-full ml-0.5"
          style={{ backgroundColor: "var(--accent-bright)" }}
        />
      )}
    </div>
  );
}, (prev, next) =>
  prev.content === next.content &&
  prev.isStreaming === next.isStreaming &&
  prev.className === next.className
);

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

  useEffect(() => {
    if (resolved) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" || e.key === "y" || e.key === "Y") {
        e.preventDefault();
        setResolved("approved");
        onApprove();
      } else if ((e.key === "a" || e.key === "A") && onAlwaysAllow) {
        e.preventDefault();
        setResolved("approved");
        onAlwaysAllow();
      } else if (e.key === "Escape" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        setResolved("denied");
        onDeny();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resolved, onApprove, onAlwaysAllow, onDeny]);

  if (resolved) {
    return (
      <div
        className="velo-phase-morph mb-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-[8px] border text-[11.5px] font-mono-code"
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
      className="mb-2.5 rounded-[14px] border p-3.5 space-y-2.5 rare-specular-surface t-modal-scale"
      style={{
        backgroundColor: "var(--surface-1)",
        borderColor: "rgba(251, 191, 36, 0.45)",
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
            backgroundColor: "rgba(251, 191, 36, 0.14)",
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
        className="font-mono-code text-[11.5px] px-3 py-2 rounded-[8px] border overflow-x-auto"
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
          className="v-press h-[28px] px-2.5 rounded-[8px] border text-[11.5px] flex items-center gap-1.5 cursor-pointer hover:bg-[var(--surface-2)]"
          style={{
            borderColor: "var(--border-accent)",
            color: "var(--fg-muted)",
          }}
        >
          <X className="w-3 h-3" />
          <span>Deny</span>
          <VeloKbd>Esc</VeloKbd>
        </button>
        {onAlwaysAllow && (
          <button
            type="button"
            onClick={() => {
              setResolved("approved");
              onAlwaysAllow();
            }}
            className="v-press h-[28px] px-2.5 rounded-[8px] border text-[11.5px] font-medium flex items-center gap-1.5 cursor-pointer hover:bg-[var(--surface-2)]"
            style={{
              borderColor: "var(--border-accent)",
              color: "var(--fg)",
            }}
          >
            <Check className="w-3 h-3" />
            <span>Always Allow</span>
            <VeloKbd>A</VeloKbd>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setResolved("approved");
            onApprove();
          }}
          className="h-[28px] px-3 rounded-[8px] text-[11.5px] font-medium flex items-center gap-1.5 cursor-pointer rare-3d-button"
          style={{
            backgroundColor: "var(--accent)",
            color: "#ffffff",
          }}
        >
          <Check className="w-3 h-3" />
          <span>Allow Once</span>
          <VeloKbd className="!bg-white/15 !border-white/25 !text-white !shadow-none">↵</VeloKbd>
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

  useEffect(() => {
    if (options.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const num = Number(e.key);
      if (Number.isInteger(num) && num >= 1 && num <= Math.min(9, options.length)) {
        e.preventDefault();
        toggleOption(options[num - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options, allowMultiple]);

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
      className="mb-2.5 rounded-[14px] border p-3.5 space-y-2.5 rare-specular-surface t-modal-scale"
      style={{
        backgroundColor: "var(--surface-1)",
        borderColor: "rgba(139, 92, 246, 0.45)",
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
          {options.map((opt, idx) => {
            const isChosen = selected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggleOption(opt)}
                className="v-press flex items-center justify-between gap-2 rounded-[9px] border px-3 py-1.5 text-left text-[12px] cursor-pointer"
                style={{
                  backgroundColor: isChosen ? "var(--surface-3)" : "var(--surface-0)",
                  borderColor: isChosen ? "var(--accent)" : "var(--border-subtle)",
                  color: "var(--fg)",
                }}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {idx < 9 && <VeloKbd>{idx + 1}</VeloKbd>}
                  <span className="truncate">{opt}</span>
                </span>
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
          className="flex-1 rounded-[8px] border px-2.5 py-1.5 text-[12px] outline-none transition-colors focus:border-[var(--accent)]"
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
          className="rare-3d-button h-[30px] px-3 rounded-[8px] text-[11.5px] font-medium cursor-pointer disabled:opacity-40"
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
