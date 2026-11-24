import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ChevronDown, ChevronUp, Clock, RefreshCw } from "lucide-react";
import { EngineBrandGlyph } from "./ui/EngineBrandIcon";
import { VeloNumberTicker } from "./ui/VeloMotionPrimitives";

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

export function formatResetCountdown(sec?: number | null, verbose = false): string {
  if (typeof sec !== "number" || sec <= 0) return "";
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (hrs >= 24) {
    const days = Math.floor(hrs / 24);
    const remH = hrs % 24;
    const base = remH > 0 ? `${days}d ${remH}h` : `${days}d`;
    return verbose ? `${base} 后重置` : base.replace(" ", "");
  }
  if (hrs > 0) {
    const base = mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
    return verbose ? `${base} 后重置` : base.replace(" ", "");
  }
  const base = `${Math.max(1, mins)}m`;
  return verbose ? `${base} 后重置` : base;
}

export function getQuotaProviderMeta(
  provider: string,
  fallback: string
): {
  shortName: string;
  compactTag: string;
  accent: string;
  gradient: string;
  tintBg: string;
} {
  switch (provider) {
    case "antigravity":
      return {
        shortName: "Antigravity",
        compactTag: "AGY",
        accent: "#5B93FA",
        gradient: "linear-gradient(90deg, #3B82F6 0%, #60A5FA 100%)",
        tintBg: "rgba(59, 130, 246, 0.12)",
      };
    case "cursor":
      return {
        shortName: "Cursor",
        compactTag: "Cursor",
        accent: "#A78BFA",
        gradient: "linear-gradient(90deg, #8B5CF6 0%, #C084FC 100%)",
        tintBg: "rgba(139, 92, 246, 0.12)",
      };
    case "claude":
      return {
        shortName: "Claude",
        compactTag: "Claude",
        accent: "#D97757",
        gradient: "linear-gradient(90deg, #D97757 0%, #F59E0B 100%)",
        tintBg: "rgba(217, 119, 87, 0.12)",
      };
    case "codex":
      return {
        shortName: "Codex",
        compactTag: "Codex",
        accent: "#10A37F",
        gradient: "linear-gradient(90deg, #10B981 0%, #34D399 100%)",
        tintBg: "rgba(16, 185, 129, 0.12)",
      };
    default:
      return {
        shortName: fallback,
        compactTag: fallback,
        accent: "#34D399",
        gradient: "linear-gradient(90deg, #10B981 0%, #34D399 100%)",
        tintBg: "rgba(52, 211, 153, 0.12)",
      };
  }
}

export function resolveQuotaBarGradient(status: string, defaultGradient: string): string {
  if (status === "exhausted") return "linear-gradient(90deg, #DC2626 0%, #F87171 100%)";
  if (status === "warning") return "linear-gradient(90deg, #D97706 0%, #FBBF24 100%)";
  return defaultGradient;
}

export function resolveQuotaPctColorClass(status: string): string {
  if (status === "exhausted") return "text-[var(--sem-danger)]";
  if (status === "warning") return "text-[var(--sem-warning)]";
  return "text-[var(--v-fg-primary)]";
}

function selectPrimaryWindows(card: ProviderQuotaCard): {
  primary: QuotaWindowItem | undefined;
  secondary7d: QuotaWindowItem | undefined;
  poolPrefix: string;
} {
  const w5h = card.windows.find((w) => w.id === "5h");
  const w7d = card.windows.find((w) => w.id === "7d");
  const g5h = card.windows.find((w) => w.id === "g1-5h");
  const g7d = card.windows.find((w) => w.id === "g1-7d");

  if (w5h && g5h && g5h.remaining_percent < w5h.remaining_percent) {
    return { primary: g5h, secondary7d: g7d, poolPrefix: "Claude/GPT · 5h" };
  }
  if (w5h) {
    return { primary: w5h, secondary7d: w7d, poolPrefix: "5h" };
  }
  return { primary: card.windows[0], secondary7d: w7d, poolPrefix: "" };
}

/**
 * Refined Native-Craft Sidebar Quota Telemetry Widget:
 * - Clean recessed card grouping with clear 3-tier hierarchy (Brand + % -> 4px gradient track -> Quiet meta + reset)
 * - Opaque elevated portal hover popover (zero text bleed-through, never clipped by sidebar overflow)
 * - Compact single-row pill summary when collapsed
 */
export const SidebarQuotaBar: React.FC<{
  daemonUrl: string;
  onOpenAnalytics: () => void;
}> = ({ daemonUrl, onOpenAnalytics }) => {
  const [cards, setCards] = useState<ProviderQuotaCard[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const [popoverRect, setPopoverRect] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  const openHoverFor = (provider: string) => {
    setHoveredProvider(provider);
    if (containerRef.current) {
      const r = containerRef.current.getBoundingClientRect();
      setPopoverRect({
        left: Math.max(8, r.left + 8),
        bottom: Math.max(12, window.innerHeight - r.top + 8),
        width: Math.max(256, r.width - 16),
      });
    }
  };

  // Strictly show quota rows ONLY for real subscription/rate-limit windows
  const subscriptionCards = cards.filter(
    (c) => c.mode === "subscription" && c.windows.length > 0
  );

  if (subscriptionCards.length === 0) return null;

  const hoveredCard = hoveredProvider
    ? subscriptionCards.find((c) => c.provider === hoveredProvider) || null
    : null;

  return (
    <div
      ref={containerRef}
      className="relative shrink-0 border-t border-[var(--v-border-subtle)]/80 px-2.5 pb-2.5 pt-2"
      onMouseLeave={() => setHoveredProvider(null)}
    >
      {/* Opaque Elevated Portal Popover (Never clipped by sidebar, zero transparency bleed-through) */}
      {hoveredCard &&
        popoverRect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: `${popoverRect.left}px`,
              bottom: `${popoverRect.bottom}px`,
              width: `${popoverRect.width}px`,
              boxShadow: "var(--v-shadow-popover)",
            }}
            className="v-popover-in pointer-events-none z-50 rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-3"
          >
            {/* Popover Header */}
            <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-[var(--v-border-subtle)] pb-2">
              <span className="flex min-w-0 items-center gap-2 text-[12px] font-semibold text-[var(--v-fg-primary)]">
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: getQuotaProviderMeta(hoveredCard.provider, hoveredCard.label).tintBg }}
                >
                  <EngineBrandGlyph engine={hoveredCard.provider} size={12} colored />
                </span>
                <span className="truncate">{hoveredCard.label}</span>
              </span>
              <span className="shrink-0 rounded-full border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)] px-2 py-0.5 font-mono text-[9.5px] font-medium text-[var(--v-fg-secondary)]">
                {hoveredCard.plan_badge}
              </span>
            </div>

            {/* All Windows Breakdown */}
            <div className="space-y-2.5">
              {hoveredCard.windows.map((w) => {
                const meta = getQuotaProviderMeta(hoveredCard.provider, hoveredCard.label);
                const gradient = resolveQuotaBarGradient(w.status, meta.gradient);
                const pct = Math.max(0, Math.min(100, w.remaining_percent));
                const resetTxt = formatResetCountdown(w.reset_in_seconds, true);

                return (
                  <div key={w.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] font-medium text-[var(--v-fg-body)]">
                        {w.label}
                      </span>
                      <span
                        className={`shrink-0 font-mono text-[11px] font-semibold tabular-nums ${resolveQuotaPctColorClass(
                          w.status
                        )}`}
                      >
                        <VeloNumberTicker value={Math.round(pct)} suffix="%" durationMs={240} />
                      </span>
                    </div>

                    <div className="h-[4px] w-full overflow-hidden rounded-full bg-[var(--v-bg-active)]">
                      <div
                        style={{
                          width: `${Math.max(3, pct)}%`,
                          background: gradient,
                          transition: "width 280ms var(--ease-swift)",
                        }}
                        className="h-full rounded-full"
                      />
                    </div>

                    {(w.detail_text || resetTxt) && (
                      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--v-fg-muted)]">
                        <span className="truncate font-mono tabular-nums">
                          {w.detail_text || `已用 ${Math.round(w.used_percent)}%`}
                        </span>
                        {resetTxt ? (
                          <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums text-[var(--v-fg-faint)]">
                            <Clock className="h-2.5 w-2.5" />
                            <span>{resetTxt}</span>
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Subtle Action Hint Footer */}
            <div className="mt-2.5 flex items-center justify-between border-t border-[var(--v-border-subtle)] pt-2 text-[10px] text-[var(--v-fg-muted)]">
              <span>点击查看完整账单与配额明细</span>
              <ArrowUpRight className="h-3 w-3 text-[var(--v-fg-faint)]" />
            </div>
          </div>,
          document.body
        )}

      {/* Section Header */}
      <div className="flex items-center justify-between px-1">
        <button
          type="button"
          onClick={onOpenAnalytics}
          title="查看完整配额与账单"
          className="group flex min-w-0 items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.04em] text-[var(--v-fg-muted)] transition-colors hover:text-[var(--v-fg-primary)] cursor-pointer"
        >
          <span>配额</span>
          {!collapsed && (
            <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-70" />
          )}
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void fetchQuotas(true)}
            title="刷新实时配额"
            className="v-press flex h-5 w-5 items-center justify-center rounded-md text-[var(--v-fg-faint)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <RefreshCw className={`h-2.5 w-2.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "展开配额明细" : "收起配额"}
            className="v-press flex h-5 w-5 items-center justify-center rounded-md text-[var(--v-fg-faint)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            {collapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Collapsed Mode: Sleek Compact Pill Chips */}
      {collapsed && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {subscriptionCards.map((card) => {
            const { primary } = selectPrimaryWindows(card);
            if (!primary) return null;
            const pct = Math.max(0, Math.min(100, Math.round(primary.remaining_percent)));
            return (
              <button
                key={card.provider}
                type="button"
                onClick={onOpenAnalytics}
                onMouseEnter={() => openHoverFor(card.provider)}
                className="v-press inline-flex flex-1 min-w-0 items-center justify-between gap-1.5 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/80 px-2 py-1 text-[10.5px] transition-colors hover:border-[var(--v-border-strong)] hover:bg-[var(--v-bg-surface)] cursor-pointer"
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <EngineBrandGlyph engine={card.provider} size={11} colored className="shrink-0" />
                  <span className="truncate font-medium text-[var(--v-fg-body)]">
                    {getQuotaProviderMeta(card.provider, card.label).compactTag}
                  </span>
                </span>
                <span
                  className={`shrink-0 font-mono font-semibold tabular-nums ${resolveQuotaPctColorClass(
                    primary.status
                  )}`}
                >
                  {pct}%
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded Mode: Cohesive Recessed Telemetry Card */}
      {!collapsed && (
        <div className="mt-1.5 overflow-hidden rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/85 divide-y divide-[var(--v-border-subtle)]/75">
          {subscriptionCards.map((card) => {
            const meta = getQuotaProviderMeta(card.provider, card.label);
            const { primary, secondary7d, poolPrefix } = selectPrimaryWindows(card);
            if (!primary) return null;

            const remPct = Math.max(0, Math.min(100, primary.remaining_percent));
            const gradient = resolveQuotaBarGradient(primary.status, meta.gradient);
            const resetShort = formatResetCountdown(primary.reset_in_seconds, false);

            // Clean quiet sub-caption on left
            const subLeft = primary.detail_text
              ? primary.detail_text.replace(/\s*\/\s*/, " / ")
              : secondary7d
              ? `${poolPrefix || "5h"} · 7d ${Math.round(secondary7d.remaining_percent)}%`
              : primary.label;

            return (
              <button
                key={card.provider}
                type="button"
                onClick={onOpenAnalytics}
                onMouseEnter={() => openHoverFor(card.provider)}
                className="group block w-full px-2.5 py-2 text-left transition-colors hover:bg-[var(--v-bg-hover)]/70 cursor-pointer"
              >
                {/* Tier 1: Brand Identity + Bold Primary Percentage */}
                <div className="flex items-center justify-between gap-2 leading-none">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <EngineBrandGlyph
                      engine={card.provider}
                      size={12.5}
                      colored
                      className="shrink-0 opacity-90 transition-opacity group-hover:opacity-100"
                    />
                    <span className="truncate text-[11.5px] font-medium text-[var(--v-fg-primary)]">
                      {meta.shortName}
                    </span>
                  </span>

                  <span
                    className={`shrink-0 font-mono text-[11.5px] font-semibold tabular-nums ${resolveQuotaPctColorClass(
                      primary.status
                    )}`}
                  >
                    <VeloNumberTicker value={Math.round(remPct)} suffix="%" durationMs={280} />
                  </span>
                </div>

                {/* Tier 2: Crisp 4px Gradient Progress Track */}
                <div className="mt-1.5 h-[4px] w-full overflow-hidden rounded-full bg-[var(--v-bg-active)]">
                  <div
                    style={{
                      width: `${Math.max(4, remPct)}%`,
                      background: gradient,
                      transition: "width 320ms var(--ease-swift)",
                    }}
                    className="h-full rounded-full opacity-90 transition-opacity group-hover:opacity-100"
                  />
                </div>

                {/* Tier 3: Quiet Telemetry Subline (Spend or 7d + Reset Countdown) */}
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] leading-none">
                  <span className="truncate font-mono text-[var(--v-fg-muted)] tabular-nums">
                    {subLeft}
                  </span>
                  {resetShort ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[var(--v-fg-faint)] tabular-nums">
                      <Clock className="h-2.5 w-2.5 opacity-75" />
                      <span>{resetShort}</span>
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
