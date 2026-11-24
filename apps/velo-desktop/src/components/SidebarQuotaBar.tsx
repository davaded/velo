import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
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
  compactTag: string;
  barColor: string;
} {
  switch (provider) {
    case "antigravity":
      return {
        shortName: "Antigravity",
        compactTag: "AGY",
        barColor: "#5B93FA",
      };
    case "cursor":
      return {
        shortName: "Cursor",
        compactTag: "Cursor",
        barColor: "#A78BFA",
      };
    case "claude":
      return {
        shortName: "Claude",
        compactTag: "Claude",
        barColor: "#D97757",
      };
    case "codex":
      return {
        shortName: "Codex",
        compactTag: "Codex",
        barColor: "#10A37F",
      };
    default:
      return {
        shortName: fallback,
        compactTag: fallback,
        barColor: "#34d399",
      };
  }
}

function resolveBarColor(status: string, defaultColor: string): string {
  if (status === "exhausted") return "#f87171";
  if (status === "warning") return "#fbbf24";
  return defaultColor;
}

/**
 * Seamless Matte Sidebar Quota Section:
 * - Zero heavy nested boxes or cramped 2-column widgets
 * - Shares the exact horizontal padding, typography, bare brand glyphs, and hairline borders of the sidebar
 * - Hovering any provider row reveals a clean floating glass breakdown of all rate-limit windows
 */
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
      className="relative shrink-0 border-t border-[var(--v-border-subtle)]/80 px-2.5 py-2"
      onMouseLeave={() => setHoveredProvider(null)}
    >
      {/* Floating Detail Popover on Row Hover (All Windows & Exact Reset Countdowns) */}
      {hoveredCard && (
        <div className="v-glass-popover v-popover-in pointer-events-none absolute bottom-full left-2 right-2 z-30 mb-1.5 rounded-2xl p-2.5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--v-fg-primary)]">
              <EngineBrandGlyph engine={hoveredCard.provider} size={12} colored />
              <span>{hoveredCard.label}</span>
            </span>
            <span className="rounded-full bg-[var(--v-bg-active)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--v-fg-muted)]">
              {hoveredCard.plan_badge}
            </span>
          </div>
          <div className="space-y-2">
            {hoveredCard.windows.map((w) => {
              const meta = providerMeta(hoveredCard.provider, hoveredCard.label);
              const color = resolveBarColor(w.status, meta.barColor);
              const pct = Math.max(0, Math.min(100, w.remaining_percent));
              const resetTxt = formatResetCountdown(w.reset_in_seconds);
              return (
                <div key={w.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-[10px]">
                    <span className="truncate text-[var(--v-fg-secondary)]">{w.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--v-fg-primary)] tabular-nums">
                      {w.detail_text ? `${w.detail_text} · ` : ""}
                      <VeloNumberTicker value={Math.round(pct)} suffix="%" durationMs={260} />
                      {resetTxt ? (
                        <span className="ml-1 text-[var(--v-fg-muted)]">{resetTxt}</span>
                      ) : null}
                    </span>
                  </div>
                  <div className="h-[2.5px] w-full overflow-hidden rounded-full bg-[var(--v-bg-active)]">
                    <div
                      style={{
                        width: `${Math.max(3, pct)}%`,
                        backgroundColor: color,
                        transition: "width 280ms var(--ease-swift)",
                      }}
                      className="h-full rounded-full opacity-90"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Header Line (Matches Workspaces Header Style) */}
      <div className="flex items-center justify-between px-1">
        <button
          type="button"
          onClick={onOpenAnalytics}
          title="查看完整配额与账单"
          className="flex min-w-0 items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--v-fg-muted)] transition-colors hover:text-[var(--v-fg-primary)] cursor-pointer"
        >
          <span>配额</span>
          {collapsed && (
            <span className="flex items-center gap-2 font-mono text-[10px] font-normal normal-case tracking-normal text-[var(--v-fg-secondary)] tabular-nums">
              {subscriptionCards.map((card) => {
                const wPrimary = card.windows.find((w) => w.id === "5h") || card.windows[0];
                if (!wPrimary) return null;
                return (
                  <span
                    key={card.provider}
                    onMouseEnter={() => setHoveredProvider(card.provider)}
                    className="inline-flex items-center gap-1"
                  >
                    <EngineBrandGlyph engine={card.provider} size={10.5} colored />
                    <span>{Math.round(wPrimary.remaining_percent)}%</span>
                  </span>
                );
              })}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void fetchQuotas(true)}
            title="刷新实时配额"
            className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--v-fg-faint)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <RefreshCw className={`h-2.5 w-2.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "展开配额明细" : "收起配额"}
            className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--v-fg-faint)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            {collapsed ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded Mode: Airy Full-Width Hairline Telemetry Rows */}
      {!collapsed && (
        <div className="mt-1.5 space-y-1">
          {subscriptionCards.map((card) => {
            const meta = providerMeta(card.provider, card.label);
            const wPrimary = card.windows.find((w) => w.id === "5h") || card.windows[0];
            const w7d = card.windows.find((w) => w.id === "7d");
            if (!wPrimary) return null;

            const remPct = Math.max(0, Math.min(100, wPrimary.remaining_percent));
            const barColor = resolveBarColor(wPrimary.status, meta.barColor);
            const isHovered = hoveredProvider === card.provider;

            // Clean, never-truncated right metric
            const metricText = wPrimary.detail_text
              ? `${wPrimary.detail_text.replace(/\s*\/\s*/, "/")} · ${Math.round(remPct)}%`
              : w7d
              ? `${Math.round(remPct)}% · 7d ${Math.round(w7d.remaining_percent)}%`
              : `${Math.round(remPct)}%`;

            return (
              <button
                key={card.provider}
                type="button"
                onClick={onOpenAnalytics}
                onMouseEnter={() => setHoveredProvider(card.provider)}
                className="group block w-full rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--v-bg-hover)]/75 cursor-pointer"
              >
                <div className="flex items-center justify-between gap-2 text-[11.5px] leading-none">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <EngineBrandGlyph
                      engine={card.provider}
                      size={11.5}
                      colored={isHovered}
                      className={
                        isHovered
                          ? "shrink-0"
                          : "shrink-0 text-[var(--v-fg-muted)] opacity-75 transition-opacity group-hover:opacity-100"
                      }
                    />
                    <span className="truncate font-medium text-[var(--v-fg-body)]">
                      {meta.shortName}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-[var(--v-fg-secondary)] tabular-nums">
                    {metricText}
                  </span>
                </div>

                {/* Hairline 2.5px Track */}
                <div className="mt-1.5 h-[2.5px] w-full overflow-hidden rounded-full bg-[var(--v-bg-active)]">
                  <div
                    style={{
                      width: `${Math.max(4, remPct)}%`,
                      backgroundColor: barColor,
                    }}
                    className="h-full rounded-full opacity-80 transition-all duration-300 group-hover:opacity-100"
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
