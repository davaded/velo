import React, { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Eye,
  FileSymlink,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  SquareTerminal,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";

/**
 * ============================================================================
 * 1. PASEO SYNCED LOADER (packages/app/src/components/synced-loader.tsx)
 *    2x3 6-dot matrix synchronized to a 950ms 6-step opacity cycle
 * ============================================================================
 */
const SYNCED_LOADER_DURATION_MS = 950;
const SYNCED_LOADER_DOT_COUNT = 6;
const SYNCED_LOADER_OPACITY_STATES = [
  [1, 0, 0.78, 0, 0.56, 0.34],
  [0.78, 1, 0.56, 0, 0.34, 0],
  [0.56, 0.78, 0.34, 1, 0, 0],
  [0.34, 0.56, 0, 0.78, 0, 1],
  [0, 0.34, 0, 0.56, 1, 0.78],
  [0, 0, 1, 0.34, 0.78, 0.56],
] as const;

function getSyncedLoaderStep(nowMs: number): number {
  const elapsedMs = nowMs % SYNCED_LOADER_DURATION_MS;
  return Math.floor((elapsedMs * SYNCED_LOADER_DOT_COUNT) / SYNCED_LOADER_DURATION_MS);
}

export const PaseoSyncedLoader: React.FC<{
  size?: number;
  color?: string;
}> = ({ size = 14, color = "var(--fg)" }) => {
  const [step, setStep] = useState<number>(() => getSyncedLoaderStep(Date.now()));

  useEffect(() => {
    const interval = setInterval(() => {
      setStep(getSyncedLoaderStep(Date.now()));
    }, 80);
    return () => clearInterval(interval);
  }, []);

  const gap = Math.max(1.5, Math.round(size * 0.12));
  const dotSize = Math.max(2.2, (size - gap * 2) / 3);
  const gridWidth = dotSize * 2 + gap;
  const gridHeight = dotSize * 3 + gap * 2;
  const opacities = SYNCED_LOADER_OPACITY_STATES[step] ?? SYNCED_LOADER_OPACITY_STATES[0];

  return (
    <div
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      data-testid="turn-working-indicator"
    >
      <div
        style={{
          width: gridWidth,
          height: gridHeight,
          display: "grid",
          gridTemplateColumns: `repeat(2, ${dotSize}px)`,
          gridTemplateRows: `repeat(3, ${dotSize}px)`,
          gap: `${gap}px`,
        }}
      >
        {opacities.map((opacity, idx) => (
          <span
            key={idx}
            style={{
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: color,
              opacity,
              transition: "opacity 90ms linear",
            }}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * ============================================================================
 * 2. PASEO LIVE ELAPSED & TURN FOOTER (packages/app/src/agent-stream/turn-footer.tsx)
 *    Fixed 24px slot: swaps seamlessly from SyncedLoader + LiveElapsed to
 *    Copy + Retry + "Worked for Xs" (swaps to timestamp on hover).
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
    setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    const timer = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAtMs]);

  return (
    <span
      className="text-[13px] tabular-nums select-none"
      style={{ color: "var(--fg-muted)" }}
      data-testid="turn-working-elapsed"
    >
      {formatPaseoDuration(elapsedMs)}
    </span>
  );
};

export const PaseoTurnFooter: React.FC<{
  isRunning: boolean;
  startedAtMs?: number;
  durationMs?: number;
  completedAtLabel?: string;
  assistantContent?: string;
  onRetry?: () => void;
}> = ({
  isRunning,
  startedAtMs,
  durationMs,
  completedAtLabel,
  assistantContent,
  onRetry,
}) => {
  const [copied, setCopied] = useState(false);
  const [hoveredTiming, setHoveredTiming] = useState(false);

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
    return (
      <div
        className="mt-2 flex min-h-[24px] items-center gap-3"
        data-testid="turn-footer"
      >
        <PaseoSyncedLoader size={14} color="var(--fg)" />
        <PaseoLiveElapsed startedAtMs={startedAtMs || Date.now()} />
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

  return (
    <div
      className="mt-1.5 flex min-h-[24px] items-center gap-2"
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
          title="Regenerate turn"
          className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)] cursor-pointer"
          style={{ color: "var(--fg-muted)" }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
      {durationText && (
        <span
          onMouseEnter={() => setHoveredTiming(true)}
          onMouseLeave={() => setHoveredTiming(false)}
          className="text-[13px] tabular-nums select-none transition-colors"
          style={{ color: "var(--fg-muted)" }}
        >
          {canSwapTimestamp && hoveredTiming ? completedAtLabel : durationText}
        </span>
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
              className="h-3 w-3"
              style={{
                color: isActive ? "var(--fg)" : "var(--fg-muted)",
              }}
            />
          )}
        </div>

        {/* Label + Secondary Label Row */}
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
          <span
            className={`shrink-0 font-normal transition-colors ${
              isLoading ? "beautiful-shimmer-text" : ""
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
 * 5. PASEO THINKING BLOCK (ThoughtSlot -> ToolCall(toolName="thinking"))
 * ============================================================================
 */
export const BeautifulThinkingBlock: React.FC<{
  text: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
}> = ({ text, isStreaming = false, defaultExpanded = false }) => {
  const { summary, cleanedLines } = useMemo(() => parseReasoningContent(text), [text]);
  const [expanded, setExpanded] = useState(defaultExpanded);

  // If the only line is a single short **Summary** headline, showing it in secondaryLabel
  // is already 100% visible inline, and clicking expands the card just like Paseo.
  const hasDetail = cleanedLines.length > 0;

  if (!hasDetail && !isStreaming) {
    return null;
  }

  return (
    <PaseoExpandableBadge
      label="Thinking"
      secondaryLabel={summary || undefined}
      icon={Brain}
      isExpanded={expanded && hasDetail}
      onToggle={hasDetail ? () => setExpanded((v) => !v) : undefined}
      isLoading={isStreaming}
    >
      {hasDetail && (
        <div className="max-h-[280px] overflow-y-auto px-3.5 py-2.5 space-y-1">
          {cleanedLines.map((line, i) => renderFormattedLine(line, i))}
        </div>
      )}
    </PaseoExpandableBadge>
  );
};

/**
 * ============================================================================
 * 6. PASEO TOOL CALL CARD (packages/app/src/components/message.tsx + tool-call-details.tsx)
 * ============================================================================
 */
function resolvePaseoToolPresentation(
  toolName: string,
  input: unknown
): {
  displayName: string;
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
    (inputObj.file as string) ||
    (inputObj.target as string) ||
    undefined;
  const command =
    (inputObj.command as string) ||
    (inputObj.cmd as string) ||
    (typeof input === "string" ? input : undefined);
  const query =
    (inputObj.pattern as string) ||
    (inputObj.query as string) ||
    undefined;

  const shortPath = filePath
    ? filePath.replace(/^\/Users\/[^/]+\/code\/[^/]+\//, "")
    : undefined;

  if (lower.includes("bash") || lower.includes("shell") || lower.includes("cmd")) {
    return {
      displayName: "Shell",
      summary: command || shortPath,
      icon: SquareTerminal,
      kind: "shell",
      command: command || "",
    };
  }
  if (lower.includes("read") || lower.includes("view")) {
    return {
      displayName: "Read",
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
      summary: query || shortPath || command,
      icon: Search,
      kind: "search",
    };
  }
  if (lower.includes("task") || lower.includes("agent")) {
    return {
      displayName: "Task",
      summary: shortPath || command,
      icon: Bot,
      kind: "other",
    };
  }

  return {
    displayName: toolName,
    summary: shortPath || command || query,
    icon: Wrench,
    kind: "other",
  };
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
    () => resolvePaseoToolPresentation(toolName, input),
    [toolName, input]
  );
  const isRunning = output === undefined;

  return (
    <PaseoExpandableBadge
      label={pres.displayName}
      secondaryLabel={pres.summary}
      icon={pres.icon}
      isExpanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      onOpenFile={pres.kind === "edit" || pres.kind === "read" ? onOpenDiffTab : undefined}
      isLoading={isRunning}
      isError={isError}
    >
      {pres.kind === "shell" ? (
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
 * Beautiful UI (beautifului.dev) — Human-in-the-Loop Approval Card
 */
export const BeautifulApprovalCard: React.FC<{
  toolName: string;
  commandPreview: string;
  onApprove: () => void;
  onDeny: () => void;
}> = ({ toolName, commandPreview, onApprove, onDeny }) => {
  const [resolved, setResolved] = useState<"approved" | "denied" | null>(null);

  if (resolved) {
    return (
      <div
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-[7px] border text-[11.5px] font-mono-code"
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
      className="rounded-[10px] border p-3.5 space-y-2.5 rare-specular-surface t-modal-scale"
      style={{
        backgroundColor: "var(--surface-1)",
        borderColor: "var(--status-warning)",
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert
            className="w-4 h-4"
            style={{ color: "var(--status-warning)" }}
          />
          <span className="text-[12.5px] font-semibold">
            Human-in-the-Loop Approval Required
          </span>
        </div>
        <span
          className="font-mono-code text-[10px] px-2 py-0.5 rounded-full"
          style={{
            backgroundColor: "rgba(192, 150, 100, 0.16)",
            color: "var(--status-warning)",
          }}
        >
          {toolName}
        </span>
      </div>

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

      <div className="flex items-center justify-end gap-2 pt-0.5">
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
          Approve Execution
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
}> = ({ usedTokens, maxTokens = 200000 }) => {
  const pct = Math.min(100, Math.max(4, Math.round((usedTokens / maxTokens) * 100)));
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (pct / 100) * circumference;

  const strokeColor =
    pct > 80
      ? "var(--status-danger)"
      : pct > 55
      ? "var(--status-warning)"
      : "var(--accent-bright)";

  return (
    <div
      className="h-[24px] px-2 rounded-full border flex items-center gap-1.5 font-mono-code text-[10.5px] rare-specular-pill"
      style={{
        backgroundColor: "var(--surface-1)",
        borderColor: "var(--border-subtle)",
        color: "var(--fg-muted)",
      }}
      title={`Context Window: ${(usedTokens / 1000).toFixed(1)}k / ${(
        maxTokens / 1000
      ).toFixed(0)}k tokens (${pct}%)`}
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
      </svg>
      <span>{pct}%</span>
      <span style={{ color: "var(--fg-extra-muted)" }}>
        {(usedTokens / 1000).toFixed(1)}k
      </span>
    </div>
  );
};
