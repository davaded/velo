import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { EngineBrandGlyph } from "./ui/EngineBrandIcon";

export interface QuotaWindowItem {
  id: string;
  label: string;
  used_percent: number;
  remaining_percent: number;
  reset_in_seconds?: number | null;
  detail_text?: string | null;
  status: "healthy" | "warning" | "exhausted" | string;
}

export interface ProviderQuotaCard {
  provider: string;
  label: string;
  plan_badge: string;
  mode?: "subscription" | "api_key" | "unauthenticated" | string;
  summary_text?: string | null;
  windows: QuotaWindowItem[];
}

const COLLAPSE_STORAGE_KEY = "velo.quotaBarCollapsed.v1";

function formatResetCountdown(sec?: number | null): string {
  if (typeof sec !== "number" || sec <= 0) return "";
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (hrs >= 24) {
    const days = Math.floor(hrs / 24);
    const remH = hrs % 24;
    return remH > 0 ? `${days}d${remH}h` : `${days}d`;
  }
  if (hrs > 0) return mins > 0 ? `${hrs}h${mins}m` : `${hrs}h`;
  return `${Math.max(1, mins)}m`;
}

function providerMeta(provider: string, fallback: string): {
  shortName: string;
  stroke: string;
  softBg: string;
  badgeText: string;
} {
  switch (provider) {
    case "antigravity":
      return {
        shortName: "Antigravity",
        stroke: "#60a5fa",
        softBg: "rgba(96, 165, 250, 0.12)",
        badgeText: "#60a5fa",
      };
    case "cursor":
      return {
        shortName: "Cursor",
        stroke: "#a78bfa",
        softBg: "rgba(167, 139, 250, 0.12)",
        badgeText: "#a78bfa",
      };
    case "claude":
      return {
        shortName: "Claude",
        stroke: "#e08759",
        softBg: "rgba(224, 135, 89, 0.12)",
        badgeText: "#e08759",
      };
    case "codex":
      return {
        shortName: "Codex",
        stroke: "#34d399",
        softBg: "rgba(52, 211, 153, 0.12)",
        badgeText: "#34d399",
      };
    default:
      return {
        shortName: fallback,
        stroke: "#34d399",
        softBg: "rgba(52, 211, 153, 0.12)",
        badgeText: "#34d399",
      };
  }
}

function statusStrokeColor(status: string, defaultStroke: string): string {
  if (status === "exhausted") return "#f87171";
  if (status === "warning") return "#fbbf24";
  return defaultStroke;
}

/** Precision SVG Radial Ring Gauge (macOS / Raycast / Linear style) */
const RadialRing: React.FC<{
  percent: number;
  size: number;
  strokeWidth: number;
  color: string;
  showCenterText?: boolean;
}> = ({ percent, size, strokeWidth, color, showCenterText = false }) => {
  const clamped = Math.max(0, Math.min(100, percent));
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);

  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--v-bg-active)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 400ms cubic-bezier(0.22, 1, 0.36, 1)" }}
        />
      </svg>
      {showCenterText && (
        <span className="absolute font-mono text-[8.5px] font-semibold tracking-tight text-[var(--v-fg-primary)] tabular-nums">
          {Math.round(clamped)}
        </span>
      )}
    </div>
  );
};

export const SidebarQuotaBar: React.FC<{
  daemonUrl: string;
  onOpenAnalytics: () => void;
}> = ({ daemonUrl, onOpenAnalytics }) => {
  const [cards, setCards] = useState<ProviderQuotaCard[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  const fetchQuotas = async (force = false) => {
    setRefreshing(true);
    try {
      const qs = force ? "?refresh=1" : "";
      const res = await fetch(`${daemonUrl}/api/analytics/quotas${qs}`);
      if (res.ok) {
        const data = (await res.json()) as { providers?: ProviderQuotaCard[] };
        if (Array.isArray(data.providers)) {
          setCards(data.providers);
        }
      }
    } catch {
      // ignore offline
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void fetchQuotas(false);
    const id = setInterval(() => void fetchQuotas(false), 60_000);
    return () => clearInterval(id);
  }, [daemonUrl]);

  // Strictly show quota tiles ONLY for real subscription/rate-limit windows
  const subscriptionCards = cards.filter(
    (c) => c.mode === "subscription" && c.windows.length > 0
  );

  if (subscriptionCards.length === 0) return null;

  const hoveredCard = hoveredProvider
    ? subscriptionCards.find((c) => c.provider === hoveredProvider) || null
    : null;

  return (
    <div
      className="relative mx-2 mb-1.5 pt-1"
      onMouseLeave={() => setHoveredProvider(null)}
    >
      {/* Floating Glass Detail Popover on Tile Hover (shows ALL windows, e.g. Gemini 5h/7d + Claude/GPT 5h/7d or Cursor $75/$400) */}
      {hoveredCard && (
        <div className="pointer-events-none absolute bottom-full left-0 right-0 z-30 mb-1.5 rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)]/95 p-2.5 shadow-xl backdrop-blur-md">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--v-fg-primary)]">
              <EngineBrandGlyph engine={hoveredCard.provider} size={12.5} colored />
              <span>{hoveredCard.label}</span>
            </span>
            <span className="rounded bg-[var(--v-bg-active)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--v-fg-muted)]">
              {hoveredCard.plan_badge}
            </span>
          </div>
          <div className="space-y-1.5">
            {hoveredCard.windows.map((w) => {
              const meta = providerMeta(hoveredCard.provider, hoveredCard.label);
              const color = statusStrokeColor(w.status, meta.stroke);
              const pct = Math.max(0, Math.min(100, w.remaining_percent));
              const resetTxt = formatResetCountdown(w.reset_in_seconds);
              return (
                <div key={w.id} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-1.5 text-[10px]">
                    <span className="truncate text-[var(--v-fg-secondary)]">{w.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--v-fg-primary)] tabular-nums">
                      {w.detail_text ? `${w.detail_text} · ` : ""}
                      {Math.round(pct)}%
                      {resetTxt ? (
                        <span className="ml-1 text-[var(--v-fg-muted)]">{resetTxt}</span>
                      ) : null}
                    </span>
                  </div>
                  <div className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--v-bg-active)]">
                    <div
                      style={{ width: `${Math.max(3, pct)}%`, backgroundColor: color }}
                      className="h-full rounded-full"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Subtle Section Header */}
      <div className="mb-1 flex items-center justify-between px-1">
        <button
          type="button"
          onClick={onOpenAnalytics}
          title="点击查看完整配额与花费账单"
          className="text-[10.5px] font-semibold tracking-wide text-[var(--v-fg-muted)] transition-colors hover:text-[var(--v-fg-primary)] cursor-pointer"
        >
          订阅配额
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void fetchQuotas(true)}
            title="刷新实时配额"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--v-fg-faint)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <RefreshCw className={`h-2.5 w-2.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "展开配额卡片" : "收起为精简环状条"}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--v-fg-faint)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            {collapsed ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {/* Collapsed Mode: Single Ultra-Slim Mini-Ring Telemetry Strip */}
      {collapsed ? (
        <div className="flex items-center gap-1.5 overflow-x-auto rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/80 px-2 py-1.5">
          {subscriptionCards.map((card) => {
            const meta = providerMeta(card.provider, card.label);
            const wPrimary = card.windows.find((w) => w.id === "5h") || card.windows[0];
            if (!wPrimary) return null;
            const remPct = Math.max(0, Math.min(100, wPrimary.remaining_percent));
            const stroke = statusStrokeColor(wPrimary.status, meta.stroke);
            return (
              <button
                key={card.provider}
                type="button"
                onClick={onOpenAnalytics}
                onMouseEnter={() => setHoveredProvider(card.provider)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-[var(--v-bg-hover)] cursor-pointer"
              >
                <RadialRing percent={remPct} size={14} strokeWidth={2} color={stroke} />
                <span className="truncate text-[10.5px] font-medium text-[var(--v-fg-body)]">
                  {meta.shortName === "Antigravity" ? "AGY" : meta.shortName}
                </span>
                <span className="font-mono text-[10px] font-semibold text-[var(--v-fg-primary)] tabular-nums">
                  {Math.round(remPct)}%
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        /* Expanded Mode: Modern 2-Column Bento Micro-Tiles with SVG Radial Rings */
        <div
          className={`grid gap-1.5 ${
            subscriptionCards.length >= 2 ? "grid-cols-2" : "grid-cols-1"
          }`}
        >
          {subscriptionCards.map((card) => {
            const meta = providerMeta(card.provider, card.label);
            const wPrimary = card.windows.find((w) => w.id === "5h") || card.windows[0];
            const w7d = card.windows.find((w) => w.id === "7d");
            const wAlt5h = card.windows.find((w) => w.id === "g1-5h");
            if (!wPrimary) return null;

            const remPct = Math.max(0, Math.min(100, wPrimary.remaining_percent));
            const stroke = statusStrokeColor(wPrimary.status, meta.stroke);
            const resetTxt = formatResetCountdown(wPrimary.reset_in_seconds);
            const isHovered = hoveredProvider === card.provider;

            // Compact high-signal secondary line:
            // - For Cursor: show real dollar usage e.g. "$75.5/$400"
            // - For Antigravity / Claude: show 7d & reset countdown
            const compactDetail = wPrimary.detail_text
              ? wPrimary.detail_text.replace(/\s*\/\s*/, "/")
              : w7d
              ? `7d ${Math.round(w7d.remaining_percent)}%`
              : resetTxt
              ? `${resetTxt} 重置`
              : card.plan_badge;

            const footerMeta = wPrimary.detail_text
              ? resetTxt
                ? `${resetTxt} 重置`
                : "月度额度"
              : wAlt5h
              ? `C/G ${Math.round(wAlt5h.remaining_percent)}%`
              : resetTxt
              ? `${resetTxt} 重置`
              : "5h 窗口";

            return (
              <button
                key={card.provider}
                type="button"
                onClick={onOpenAnalytics}
                onMouseEnter={() => setHoveredProvider(card.provider)}
                className={`group flex flex-col justify-between rounded-xl border p-2 text-left transition-all duration-150 cursor-pointer ${
                  isHovered
                    ? "border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] shadow-xs"
                    : "border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/75 hover:border-[var(--v-border-strong)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <RadialRing
                    percent={remPct}
                    size={28}
                    strokeWidth={2.75}
                    color={stroke}
                    showCenterText
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-semibold leading-tight text-[var(--v-fg-primary)]">
                      {meta.shortName}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[9.5px] leading-tight text-[var(--v-fg-muted)] tabular-nums">
                      {compactDetail}
                    </div>
                  </div>
                </div>

                {/* Micro Footer Bar: Reset countdown or secondary pool + crisp brand glyph */}
                <div className="mt-1.5 flex items-center justify-between border-t border-[var(--v-border-subtle)]/70 pt-1 text-[9.5px] text-[var(--v-fg-muted)]">
                  <span className="truncate font-mono tabular-nums">{footerMeta}</span>
                  <EngineBrandGlyph
                    engine={card.provider}
                    size={11}
                    colored
                    className="shrink-0 opacity-90"
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
