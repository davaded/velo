import React, { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileCode2,
  Loader2,
  ShieldAlert,
  Sparkles,
  Terminal,
  Wrench,
  X,
  XCircle,
} from "lucide-react";

/**
 * Beautiful UI (beautifului.dev) — Shimmering Reasoning & Thinking Block
 * Combined with transitions.dev smooth 0fr -> 1fr grid collapse
 */
export const BeautifulThinkingBlock: React.FC<{
  text: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
}> = ({ text, isStreaming = false, defaultExpanded = false }) => {
  const hasBody = text.trim().length > 0;
  const [expanded, setExpanded] = useState(defaultExpanded && hasBody);
  const [elapsedSec, setElapsedSec] = useState<number>(0.4);

  useEffect(() => {
    if (isStreaming && hasBody) {
      setExpanded(true);
    } else if (!isStreaming) {
      // Automatically fold into a clean 1-line summary once thinking completes
      setExpanded(false);
    }
  }, [isStreaming, hasBody]);

  useEffect(() => {
    if (!isStreaming) return;
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsedSec(Number(((Date.now() - started) / 1000 + 0.4).toFixed(1)));
    }, 100);
    return () => clearInterval(timer);
  }, [isStreaming]);

  const estimatedTokens = hasBody ? Math.max(12, Math.round(text.length * 1.2)) : 0;
  const previewLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() || "";

  return (
    <div className="t-blur-swap my-1">
      <button
        type="button"
        onClick={() => {
          if (hasBody) setExpanded((v) => !v);
        }}
        className="group inline-flex items-center gap-2 px-2.5 py-1 rounded-[7px] text-[12px] border transition-all cursor-pointer rare-specular-pill max-w-full"
        style={{
          backgroundColor: expanded ? "var(--surface-2)" : "var(--surface-1)",
          borderColor: isStreaming
            ? "var(--accent)"
            : expanded
            ? "var(--border-accent)"
            : "var(--border-subtle)",
          color: "var(--fg-muted)",
        }}
      >
        {hasBody && (
          <ChevronRight
            className="w-3.5 h-3.5 shrink-0 transition-transform duration-200"
            style={{
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              color: "var(--fg-extra-muted)",
            }}
          />
        )}
        {isStreaming ? (
          <Loader2
            className="w-3.5 h-3.5 shrink-0 animate-spin"
            style={{ color: "var(--accent-bright)" }}
          />
        ) : (
          <Sparkles
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: "var(--accent-bright)" }}
          />
        )}
        <span
          className={`font-medium shrink-0 ${isStreaming ? "beautiful-shimmer-text" : ""}`}
          style={!isStreaming ? { color: "var(--fg)" } : undefined}
        >
          {isStreaming ? "Thinking..." : `Thought for ${elapsedSec.toFixed(1)}s`}
        </span>
        {!expanded && previewLine && (
          <span
            className="truncate max-w-[320px] text-[11.5px]"
            style={{ color: "var(--fg-extra-muted)" }}
          >
            {previewLine}
          </span>
        )}
        <span
          className="font-mono-code text-[10px] px-1.5 py-0.2 rounded-full ml-1 shrink-0 flex items-center gap-1"
          style={{
            backgroundColor: "var(--surface-0)",
            color: isStreaming ? "var(--accent-bright)" : "var(--fg-extra-muted)",
          }}
        >
          <Clock className="w-2.5 h-2.5" />
          {elapsedSec.toFixed(1)}s{estimatedTokens > 0 ? ` · ${estimatedTokens} tok` : ""}
        </span>
      </button>

      {hasBody && (
        <div className={`t-grid-collapse ${expanded ? "t-expanded" : ""}`}>
          <div className="t-grid-collapse-inner">
            <div
              className="paseo-indent-rail ml-3 mt-1.5 py-1.5 px-3 rounded-r-[7px] text-[12.5px] leading-relaxed whitespace-pre-wrap"
              style={{
                backgroundColor: "rgba(255,255,255,0.015)",
                color: "var(--fg-muted)",
              }}
            >
              {text}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Beautiful UI (beautifului.dev) — Tool-Call Chip & Expandable Diff/JSON Record Card
 */
export const BeautifulToolCallCard: React.FC<{
  toolName: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  onOpenDiffTab?: () => void;
}> = ({ toolName, input, output, isError = false, onOpenDiffTab }) => {
  const [expanded, setExpanded] = useState(false);

  const inputObj =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const targetFile =
    (inputObj.file_path as string) ||
    (inputObj.target as string) ||
    (inputObj.file as string) ||
    (inputObj.path as string) ||
    (inputObj.command as string) ||
    (inputObj.pattern as string) ||
    null;

  const isEdit =
    toolName.toLowerCase().includes("edit") ||
    toolName.toLowerCase().includes("write");
  const isShell =
    toolName.toLowerCase().includes("bash") ||
    toolName.toLowerCase().includes("check") ||
    toolName.toLowerCase().includes("cmd");

  const Icon = isEdit ? FileCode2 : isShell ? Terminal : Wrench;

  return (
    <div className="t-blur-swap my-1">
      <div
        className="inline-flex flex-col rounded-[8px] border overflow-hidden transition-colors max-w-full rare-specular-pill"
        style={{
          backgroundColor: "var(--surface-1)",
          borderColor: expanded ? "var(--border-accent)" : "var(--border-subtle)",
        }}
      >
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-2 min-w-0 cursor-pointer text-left"
          >
            <ChevronRight
              className="w-3.5 h-3.5 shrink-0 transition-transform duration-200"
              style={{
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                color: "var(--fg-extra-muted)",
              }}
            />
            <span
              className="w-5 h-5 rounded-[5px] flex items-center justify-center shrink-0"
              style={{
                backgroundColor: "var(--surface-2)",
                color: "var(--accent-bright)",
              }}
            >
              <Icon className="w-3 h-3" />
            </span>
            <span
              className="font-mono-code font-semibold text-[11.5px]"
              style={{ color: "var(--fg)" }}
            >
              {toolName}
            </span>
            {targetFile && (
              <span
                className="font-mono-code text-[11px] px-1.5 py-0.5 rounded border truncate max-w-[320px]"
                style={{
                  backgroundColor: "var(--surface-0)",
                  borderColor: "var(--border-subtle)",
                  color: "var(--fg-muted)",
                }}
              >
                {String(targetFile)}
              </span>
            )}
          </button>

          {isEdit && (
            <button
              type="button"
              onClick={onOpenDiffTab}
              className="font-mono-code text-[10.5px] px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer hover:bg-[var(--surface-2)]"
              title="Inspect in Working Diff"
            >
              <span style={{ color: "var(--status-success)" }}>+8</span>
              <span style={{ color: "var(--status-danger)" }}>−0</span>
            </button>
          )}

          {output !== undefined ? (
            <span
              className="ml-1 flex items-center gap-1 text-[10.5px] font-mono-code px-1.5 py-0.5 rounded-full shrink-0"
              style={{
                backgroundColor: isError
                  ? "rgba(216, 132, 123, 0.14)"
                  : "rgba(108, 177, 123, 0.14)",
                color: isError ? "var(--status-danger)" : "var(--status-success)",
              }}
            >
              {isError ? (
                <XCircle className="w-3 h-3" />
              ) : (
                <CheckCircle2 className="w-3 h-3" />
              )}
              {isError ? "failed" : "ok"}
            </span>
          ) : (
            <span
              className="ml-1 flex items-center gap-1 text-[10.5px] font-mono-code px-1.5 py-0.5 rounded-full shrink-0"
              style={{
                backgroundColor: "rgba(139, 92, 246, 0.14)",
                color: "var(--accent-bright)",
              }}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="beautiful-shimmer-text">running...</span>
            </span>
          )}
        </div>

        {/* Smooth transitions.dev 0fr -> 1fr Drawer */}
        <div className={`t-grid-collapse ${expanded ? "t-expanded" : ""}`}>
          <div className="t-grid-collapse-inner">
            <div
              className="border-t px-3 py-2 space-y-2 font-mono-code text-[11px]"
              style={{
                backgroundColor: "var(--surface-0)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div>
                <div
                  className="text-[10px] uppercase tracking-wider mb-1"
                  style={{ color: "var(--fg-extra-muted)" }}
                >
                  Arguments
                </div>
                <pre
                  className="overflow-x-auto whitespace-pre-wrap"
                  style={{ color: "var(--fg-muted)" }}
                >
                  {JSON.stringify(input, null, 2)}
                </pre>
              </div>
              {output && (
                <div
                  className="pt-1.5 border-t"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <div
                    className="text-[10px] uppercase tracking-wider mb-1"
                    style={{ color: "var(--fg-extra-muted)" }}
                  >
                    Output
                  </div>
                  <pre
                    className="overflow-x-auto whitespace-pre-wrap"
                    style={{
                      color: isError ? "var(--status-danger)" : "var(--status-success)",
                    }}
                  >
                    {output}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
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
