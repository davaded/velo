import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

/**
 * ============================================================================
 * 1. VeloKbd — HeroUI-inspired tactile keyboard shortcut keycap badge
 * ============================================================================
 */
export const VeloKbd: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => (
  <kbd
    className={`v-kbd inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-1 font-mono text-[10px] font-medium leading-none tracking-tight select-none ${className}`}
  >
    {children}
  </kbd>
);

/**
 * ============================================================================
 * 2. VeloSegmentedControl — HeroUI / 21st.dev sliding-thumb segmented control
 *    GPU-accelerated transform indicator with zero layout jitter
 * ============================================================================
 */
export interface SegmentedOption<T extends string> {
  id: T;
  label?: string;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: string | number;
  title?: string;
}

export function VeloSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "sm",
  fullWidth = false,
  className = "",
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: "xs" | "sm" | "md";
  fullWidth?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  });

  const activeIdx = Math.max(
    0,
    options.findIndex((o) => o.id === value)
  );

  useEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      const btn = btnRefs.current[activeIdx];
      if (!container || !btn) return;
      const cRect = container.getBoundingClientRect();
      const bRect = btn.getBoundingClientRect();
      if (bRect.width <= 0) return;
      setThumb({
        left: bRect.left - cRect.left,
        width: bRect.width,
        ready: true,
      });
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    return () => ro?.disconnect();
  }, [activeIdx, options.length, fullWidth]);

  const padClass =
    size === "xs"
      ? "h-6 px-1.5 text-[11px]"
      : size === "md"
      ? "h-8 px-3 text-[12px]"
      : "h-7 px-2.5 text-[11.5px]";

  return (
    <div
      ref={containerRef}
      role="tablist"
      className={`relative inline-flex items-center rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] p-[2px] ${
        fullWidth ? "flex w-full" : ""
      } ${className}`}
    >
      {/* Sliding active background thumb */}
      {thumb.ready && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[2px] bottom-[2px] left-0 rounded-[6px] bg-[var(--v-bg-active)] shadow-2xs"
          style={{
            width: `${thumb.width}px`,
            transform: `translate3d(${thumb.left}px, 0, 0)`,
            transition: "transform 200ms var(--ease-swift), width 200ms var(--ease-swift)",
            boxShadow: "var(--v-glass-specular)",
          }}
        />
      )}

      {options.map((opt, idx) => {
        const Icon = opt.icon;
        const isActive = opt.id === value;
        return (
          <button
            key={opt.id}
            ref={(el) => {
              btnRefs.current[idx] = el;
            }}
            role="tab"
            type="button"
            aria-selected={isActive}
            title={opt.title || opt.label}
            onClick={() => onChange(opt.id)}
            className={`v-press relative z-10 inline-flex items-center justify-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap cursor-pointer ${padClass} ${
              fullWidth ? "flex-1" : ""
            } ${
              isActive
                ? "text-[var(--v-fg-primary)]"
                : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-secondary)]"
            }`}
          >
            {Icon && <Icon className={size === "xs" ? "h-3.5 w-3.5" : "h-3.5 w-3.5"} />}
            {opt.label && <span>{opt.label}</span>}
            {opt.badge !== undefined && (
              <span
                className={`rounded-full px-1.5 py-[1px] font-mono text-[10px] tabular-nums ${
                  isActive
                    ? "bg-[var(--v-bg-surface)] text-[var(--v-fg-primary)]"
                    : "bg-[var(--v-bg-hover)] text-[var(--v-fg-muted)]"
                }`}
              >
                {opt.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * ============================================================================
 * 3. VeloSwitch — 60fps tactile spring toggle switch
 * ============================================================================
 */
export const VeloSwitch: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}> = ({ checked, onChange, disabled = false, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => !disabled && onChange(!checked)}
    className={`group relative inline-flex h-[20px] w-[36px] shrink-0 items-center rounded-full border transition-colors duration-200 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
      checked
        ? "border-[var(--accent)] bg-[var(--accent)]"
        : "border-[var(--v-border-strong)] bg-[var(--v-bg-active)]"
    }`}
  >
    <span
      className={`pointer-events-none block h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-[var(--ease-swift)] group-active:scale-x-110 ${
        checked ? "translate-x-[18px]" : "translate-x-[2px]"
      }`}
    />
  </button>
);

/**
 * ============================================================================
 * 4. VeloNumberTicker — Magic UI-inspired smooth tabular-nums numeric roll
 * ============================================================================
 */
export const VeloNumberTicker: React.FC<{
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  durationMs?: number;
  className?: string;
}> = ({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  durationMs = 360,
  className = "",
}) => {
  const [display, setDisplay] = useState<number>(value);
  const fromRef = useRef<number>(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const startVal = fromRef.current;
    const diff = value - startVal;
    if (Math.abs(diff) < 0.0001) {
      setDisplay(value);
      return;
    }

    const prefersReduced =
      typeof window !== "undefined" &&
      (document.documentElement.getAttribute("data-reduce-motion") === "true" ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

    if (prefersReduced) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }

    const startTime = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      // Cubic ease-out matching --ease-swift feel
      const eased = 1 - Math.pow(1 - t, 3);
      const current = startVal + diff * eased;
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
        setDisplay(value);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      fromRef.current = value;
    };
  }, [value, durationMs]);

  const formatted =
    decimals > 0 ? display.toFixed(decimals) : Math.round(display).toLocaleString();

  return (
    <span className={`tabular-nums ${className}`}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
};

/**
 * ============================================================================
 * 5. VeloSpotlightCard — Aceternity-inspired subtle mouse-tracking card
 * ============================================================================
 */
export const VeloSpotlightCard: React.FC<{
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
}> = ({ onClick, className = "", children }) => {
  const ref = useRef<HTMLButtonElement | null>(null);

  const handleMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    el.style.setProperty("--my", `${e.clientY - rect.top}px`);
  };

  return (
    <button
      ref={ref}
      type="button"
      onPointerMove={handleMove}
      onClick={onClick}
      className={`v-spotlight-card v-press relative overflow-hidden rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/85 text-left cursor-pointer hover:border-[var(--v-border-strong)] ${className}`}
    >
      {children}
    </button>
  );
};

/**
 * ============================================================================
 * 6. VeloToastHost — Unified global frosted-glass spring toast stack
 * ============================================================================
 */
export type VeloToastTone = "success" | "info" | "warning" | "error";

export interface VeloToastItem {
  id: string;
  message: string;
  tone?: VeloToastTone;
}

export const VeloToastHost: React.FC<{
  toasts: VeloToastItem[];
  onDismiss: (id: string) => void;
}> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed top-12 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-1.5 px-3"
    >
      {toasts.map((toast) => {
        const tone = toast.tone || "info";
        const Icon =
          tone === "success"
            ? CheckCircle2
            : tone === "warning"
            ? AlertTriangle
            : tone === "error"
            ? XCircle
            : Info;
        const iconColor =
          tone === "success"
            ? "var(--sem-success)"
            : tone === "warning"
            ? "var(--sem-warning)"
            : tone === "error"
            ? "var(--sem-danger)"
            : "var(--accent-bright)";

        return (
          <div
            key={toast.id}
            className="v-glass-popover v-toast-in pointer-events-auto flex max-w-[440px] items-center gap-2 rounded-full px-3.5 py-1.5 text-[12px] text-[var(--v-fg-primary)]"
          >
            <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: iconColor }} />
            <span className="truncate font-medium">{toast.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

/**
 * ============================================================================
 * 7. Lightweight Safe Syntax Highlighter (Zero External Bundle Bloat)
 *    Supports TS/JS/TSX/Rust/Swift/Python/Go/Shell/JSON/CSS/SQL
 * ============================================================================
 */
const CODE_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "default",
  "import",
  "export",
  "from",
  "as",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "class",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "typeof",
  "keyof",
  "in",
  "of",
  // Rust / Swift / Go / Python / SQL
  "fn",
  "pub",
  "mod",
  "use",
  "struct",
  "impl",
  "trait",
  "match",
  "mut",
  "ref",
  "move",
  "where",
  "Self",
  "self",
  "crate",
  "super",
  "func",
  "guard",
  "protocol",
  "extension",
  "actor",
  "some",
  "any",
  "def",
  "elif",
  "pass",
  "lambda",
  "with",
  "yield",
  "None",
  "True",
  "False",
  "package",
  "defer",
  "chan",
  "select",
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT",
  "UPDATE",
  "DELETE",
  "JOIN",
  "ORDER",
  "GROUP",
  "LIMIT",
]);

const TOKEN_REGEX =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(`(?:\\[\s\S]|[^`])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b([A-Z][A-Za-z0-9_]*)\b|\b([a-zA-Z_][A-Za-z0-9_]*)\b(?=\s*\()|\b([a-zA-Z_][A-Za-z0-9_]*)\b/g;

export function highlightCodeLine(line: string, lang: string): React.ReactNode {
  const normalized = (lang || "").toLowerCase();
  if (normalized === "diff" || normalized === "patch") {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return <span className="v-diff-add block -mx-3 px-3">{line}</span>;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return <span className="v-diff-del block -mx-3 px-3">{line}</span>;
    }
    if (line.startsWith("@@")) {
      return <span className="v-diff-hunk block -mx-3 px-3">{line}</span>;
    }
    return line;
  }

  // Skip highlighting ultra-long single minified lines to protect 60fps
  if (line.length > 600) return line;

  const isHashCommentLang =
    normalized === "py" ||
    normalized === "python" ||
    normalized === "sh" ||
    normalized === "bash" ||
    normalized === "zsh" ||
    normalized === "shell" ||
    normalized === "yaml" ||
    normalized === "yml" ||
    normalized === "toml";

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  let k = 0;

  while ((match = TOKEN_REGEX.exec(line)) !== null) {
    const [full, comment, str, num, typeName, fnName, ident] = match;
    // Ignore `#` comments in non-hash languages (like Rust attributes or CSS hex)
    if (comment && comment.startsWith("#") && !isHashCommentLang) {
      continue;
    }

    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }

    if (comment) {
      nodes.push(
        <span key={k++} className="v-tok-com">
          {full}
        </span>
      );
    } else if (str) {
      nodes.push(
        <span key={k++} className="v-tok-str">
          {full}
        </span>
      );
    } else if (num) {
      nodes.push(
        <span key={k++} className="v-tok-num">
          {full}
        </span>
      );
    } else if (typeName) {
      if (CODE_KEYWORDS.has(typeName)) {
        nodes.push(
          <span key={k++} className="v-tok-kw">
            {full}
          </span>
        );
      } else {
        nodes.push(
          <span key={k++} className="v-tok-type">
            {full}
          </span>
        );
      }
    } else if (fnName) {
      if (CODE_KEYWORDS.has(fnName)) {
        nodes.push(
          <span key={k++} className="v-tok-kw">
            {full}
          </span>
        );
      } else {
        nodes.push(
          <span key={k++} className="v-tok-fn">
            {full}
          </span>
        );
      }
    } else if (ident && CODE_KEYWORDS.has(ident)) {
      nodes.push(
        <span key={k++} className="v-tok-kw">
          {full}
        </span>
      );
    } else {
      nodes.push(full);
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : line;
}
