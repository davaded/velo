import React from "react";

export type EngineStatusIndicator = "idle" | "running" | "waiting" | "unread";

export interface EngineBrandMeta {
  key: "claude" | "codex" | "agy" | "cursor" | "grok" | "acp";
  label: string;
  color: string;
  tintBg: string;
  tintRing: string;
}

export function resolveEngineBrandMeta(engine?: string | null): EngineBrandMeta {
  const raw = (engine || "").toLowerCase();
  if (raw.includes("claude")) {
    return {
      key: "claude",
      label: "Claude",
      color: "#D97757",
      tintBg: "rgba(217, 119, 87, 0.14)",
      tintRing: "rgba(217, 119, 87, 0.28)",
    };
  }
  if (raw.includes("codex") || raw.includes("openai") || raw.includes("gpt")) {
    return {
      key: "codex",
      label: "Codex",
      color: "#10A37F",
      tintBg: "rgba(16, 163, 127, 0.14)",
      tintRing: "rgba(16, 163, 127, 0.28)",
    };
  }
  if (raw.includes("agy") || raw.includes("antigravity") || raw.includes("gemini")) {
    return {
      key: "agy",
      label: "Antigravity",
      color: "#5B93FA",
      tintBg: "rgba(91, 147, 250, 0.15)",
      tintRing: "rgba(91, 147, 250, 0.30)",
    };
  }
  if (raw.includes("cursor")) {
    return {
      key: "cursor",
      label: "Cursor",
      color: "#A78BFA",
      tintBg: "rgba(167, 139, 250, 0.14)",
      tintRing: "rgba(167, 139, 250, 0.28)",
    };
  }
  if (raw.includes("grok") || raw.includes("xai")) {
    return {
      key: "grok",
      label: "Grok",
      color: "#E4E4E7",
      tintBg: "rgba(161, 161, 170, 0.16)",
      tintRing: "rgba(161, 161, 170, 0.32)",
    };
  }
  return {
    key: "acp",
    label: "ACP",
    color: "#94A3B8",
    tintBg: "rgba(148, 163, 184, 0.14)",
    tintRing: "rgba(148, 163, 184, 0.26)",
  };
}

/**
 * Offline, zero-dependency official-style vector marks inspired by `lobehub/lobe-icons`.
 * Crisp at 12px–20px on Retina displays in both monochrome (unselected) and illuminated brand color (selected).
 */
export const EngineBrandGlyph: React.FC<{
  engine?: string | null;
  size?: number;
  colored?: boolean;
  className?: string;
}> = ({ engine, size = 13, colored = false, className = "" }) => {
  const meta = resolveEngineBrandMeta(engine);
  const gradId = React.useId();

  switch (meta.key) {
    case "claude":
      // Anthropic Claude 12-ray starburst mark
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          aria-hidden="true"
        >
          <path
            d="M12 2.2L13.35 8.35L17.9 3.9L15.1 9.55L21.3 8.9L16.1 12.1L21.7 15.1L15.4 14.55L18.1 20.1L13.45 15.75L12 21.8L10.55 15.75L5.9 20.1L8.6 14.55L2.3 15.1L7.9 12.1L2.7 8.9L8.9 9.55L6.1 3.9L10.65 8.35L12 2.2Z"
            fill={colored ? meta.color : "currentColor"}
          />
        </svg>
      );

    case "codex":
      // OpenAI 6-petal interlocking blossom mark
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          aria-hidden="true"
        >
          <path
            d="M21.2 10.1a5.4 5.4 0 0 0-.47-4.46 5.5 5.5 0 0 0-5.91-2.64 5.42 5.42 0 0 0-4.08-1.82 5.5 5.5 0 0 0-5.24 3.8 5.42 5.42 0 0 0-3.62 2.63 5.5 5.5 0 0 0 .68 6.45 5.4 5.4 0 0 0 .47 4.46 5.5 5.5 0 0 0 5.91 2.64 5.42 5.42 0 0 0 4.08 1.82 5.5 5.5 0 0 0 5.24-3.8 5.42 5.42 0 0 0 3.62-2.63 5.5 5.5 0 0 0-.68-6.45ZM13.02 21.1a4.08 4.08 0 0 1-2.62-.95l.13-.07 4.35-2.51a.72.72 0 0 0 .36-.62v-6.13l1.84 1.06a.07.07 0 0 1 .04.05v5.08a4.1 4.1 0 0 1-4.1 4.09Zm-8.81-3.76a4.07 4.07 0 0 1-.49-2.74l.13.08 4.35 2.51a.7.7 0 0 0 .71 0l5.31-3.07v2.12a.07.07 0 0 1-.03.06l-4.4 2.54a4.1 4.1 0 0 1-5.58-1.5Zm-1.15-9.5A4.08 4.08 0 0 1 5.2 6.04v5.18a.7.7 0 0 0 .35.61l5.31 3.06-1.84 1.06a.07.07 0 0 1-.07 0l-4.4-2.54a4.1 4.1 0 0 1-1.49-5.57Zm15.1 3.51-5.31-3.07 1.84-1.06a.07.07 0 0 1 .07 0l4.4 2.54a4.1 4.1 0 0 1-.64 7.39v-5.19a.7.7 0 0 0-.36-.61Zm1.83-2.75-.13-.08-4.35-2.51a.7.7 0 0 0-.71 0L9.5 9.08V6.96a.07.07 0 0 1 .03-.06l4.4-2.54a4.1 4.1 0 0 1 6.06 4.24ZM8.48 12.66 6.64 11.6a.07.07 0 0 1-.04-.05V6.47a4.1 4.1 0 0 1 6.72-3.14l-.13.07-4.35 2.51a.72.72 0 0 0-.36.62v6.13Zm1-2.16 2.36-1.36 2.36 1.36v2.72l-2.36 1.36-2.36-1.36V10.5Z"
            fill={colored ? meta.color : "currentColor"}
          />
        </svg>
      );

    case "agy":
      // Google Gemini / Antigravity smooth 4-point spark mark
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          aria-hidden="true"
        >
          {colored && (
            <defs>
              <linearGradient id={gradId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#4E86F8" />
                <stop offset="55%" stopColor="#7C6BF5" />
                <stop offset="100%" stopColor="#B56CE2" />
              </linearGradient>
            </defs>
          )}
          <path
            d="M12 2C12.35 7.45 16.55 11.65 22 12C16.55 12.35 12.35 16.55 12 22C11.65 16.55 7.45 12.35 2 12C7.45 11.65 11.65 7.45 12 2Z"
            fill={colored ? `url(#${gradId})` : "currentColor"}
          />
        </svg>
      );

    case "cursor":
      // Cursor isometric 3D cube/prism mark
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          aria-hidden="true"
        >
          <path
            d="M12 2.25L20.5 7.15V16.85L12 21.75L3.5 16.85V7.15L12 2.25Z"
            stroke={colored ? meta.color : "currentColor"}
            strokeWidth="1.75"
            strokeLinejoin="round"
            fill={colored ? "rgba(167, 139, 250, 0.16)" : "none"}
          />
          <path
            d="M12 2.25L20.5 7.15L12 12L3.5 7.15L12 2.25Z"
            fill={colored ? meta.color : "currentColor"}
            fillOpacity={colored ? 0.35 : 0.22}
          />
          <path
            d="M12 12V21.75M12 12L20.5 7.15M12 12L3.5 7.15"
            stroke={colored ? meta.color : "currentColor"}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    case "grok":
      // xAI Grok orbital slash mark
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r="7.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeOpacity={colored ? 0.92 : 0.85}
          />
          <path
            d="M5.5 18.5L18.5 5.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      );

    default:
      // Generic ACP / Terminal mark
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          aria-hidden="true"
        >
          <rect
            x="3.5"
            y="4.5"
            width="17"
            height="15"
            rx="3.5"
            stroke={colored ? meta.color : "currentColor"}
            strokeWidth="1.8"
          />
          <path
            d="M8 10L11 12.5L8 15M13 15H16"
            stroke={colored ? meta.color : "currentColor"}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
};

/**
 * Bare, refined engine mark for sidebar thread rows:
 * - Zero heavy box/border around the icon (matches the calm matte monochrome sidebar & composer pill).
 * - Unselected: quiet low-contrast monochrome glyph; gently brightens on hover.
 * - Selected: cleanly illuminates in official brand color.
 * - Live status (running / waiting / unread) is decoupled via clean spinner or subtle corner dot.
 */
export const EngineSessionBadge: React.FC<{
  engine?: string | null;
  selected?: boolean;
  status?: EngineStatusIndicator;
  title?: string;
}> = ({ engine, selected = false, status = "idle", title }) => {
  const meta = resolveEngineBrandMeta(engine);

  return (
    <div
      title={title || meta.label}
      className={`relative flex h-4 w-4 shrink-0 items-center justify-center transition-colors duration-150 ${
        selected
          ? ""
          : "text-[var(--v-fg-muted)] opacity-55 group-hover:text-[var(--v-fg-secondary)] group-hover:opacity-90"
      }`}
    >
      {status === "running" ? (
        <span
          className="h-3.5 w-3.5 rounded-full border-[1.5px] border-[#34d399]/25 border-t-[#34d399] animate-spin"
          style={{ animationDuration: "1s" }}
          aria-label="正在执行"
        />
      ) : (
        <EngineBrandGlyph
          engine={engine}
          size={13}
          colored={selected}
          className={selected ? "" : "text-current"}
        />
      )}

      {status === "waiting" && (
        <span
          className="absolute -bottom-[1px] -right-[1px] h-[6px] w-[6px] rounded-full bg-[#fbbf24] ring-[1.5px] ring-[var(--v-bg-sidebar)] animate-pulse"
          aria-label="等待审批"
        />
      )}
      {status === "unread" && (
        <span
          className="absolute -bottom-[1px] -right-[1px] h-[5.5px] w-[5.5px] rounded-full bg-[#38bdf8] ring-[1.5px] ring-[var(--v-bg-sidebar)]"
          aria-label="未读新进展"
        />
      )}
    </div>
  );
};
