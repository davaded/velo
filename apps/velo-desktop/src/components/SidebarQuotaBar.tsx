import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";

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

function providerShortLabel(provider: string, fallback: string): string {
  switch (provider) {
    case "antigravity":
      return "Antigravity";
    case "cursor":
      return "Cursor";
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      return fallback;
  }
}

function providerBarClass(provider: string, status: string): string {
  if (status === "exhausted") return "bg-[#f87171]";
  if (status === "warning") return "bg-[#fbbf24]";
  switch (provider) {
    case "antigravity":
      return "bg-[#60a5fa]";
    case "cursor":
      return "bg-[#a78bfa]";
    case "claude":
      return "bg-[#fb923c]";
    default:
      return "bg-[#34d399]";
  }
}

export const SidebarQuotaBar: React.FC<{
  daemonUrl: string;
  onOpenAnalytics: () => void;
}> = ({ daemonUrl, onOpenAnalytics }) => {
  const [cards, setCards] = useState<ProviderQuotaCard[]>([]);
  const [refreshing, setRefreshing] = useState(false);
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

  // Strictly show quota bars ONLY for real subscription/rate-limit windows
  const subscriptionCards = cards.filter(
    (c) => c.mode === "subscription" && c.windows.length > 0
  );

  if (subscriptionCards.length === 0) return null;

  const lowestRemaining = subscriptionCards.reduce((minPct, card) => {
    const wPrimary = card.windows.find((w) => w.id === "5h") || card.windows[0];
    if (!wPrimary) return minPct;
    return Math.min(minPct, Math.max(0, Math.min(100, Math.round(wPrimary.remaining_percent))));
  }, 100);

  return (
    <div className="mx-2 mb-1.5 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/75 px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={onOpenAnalytics}
          title="查看完整订阅配额与花费分析"
          className="flex min-w-0 items-center gap-1.5 text-[10.5px] font-medium text-[var(--v-fg-muted)] transition-colors hover:text-[var(--v-fg-primary)] cursor-pointer"
        >
          <span className="truncate">订阅配额</span>
          {collapsed && (
            <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums">
              <span className="flex items-center gap-0.5">
                {subscriptionCards.map((card) => {
                  const wPrimary = card.windows.find((w) => w.id === "5h") || card.windows[0];
                  return (
                    <span
                      key={card.provider}
                      className={`h-1.5 w-1.5 rounded-full ${providerBarClass(
                        card.provider,
                        wPrimary?.status || "healthy"
                      )}`}
                    />
                  );
                })}
              </span>
              <span
                className={
                  lowestRemaining <= 15
                    ? "text-[#f87171]"
                    : lowestRemaining <= 30
                    ? "text-[#fbbf24]"
                    : "text-[var(--v-fg-secondary)]"
                }
              >
                最低 {lowestRemaining}%
              </span>
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1">
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
            title={collapsed ? "展开订阅配额明细" : "收起订阅配额以留出更多工作区空间"}
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

      {!collapsed && (
        <div className="mt-1.5 space-y-1.5">
          {subscriptionCards.map((card) => {
            const shortName = providerShortLabel(card.provider, card.label);
            const wPrimary = card.windows.find((w) => w.id === "5h") || card.windows[0];
            const w7d = card.windows.find((w) => w.id === "7d");
            if (!wPrimary) return null;

            const remPct = Math.max(0, Math.min(100, wPrimary.remaining_percent));
            const resetTxt = formatResetCountdown(wPrimary.reset_in_seconds);
            const barColor = providerBarClass(card.provider, wPrimary.status);

            const fullTooltip = [
              `${shortName} (${card.plan_badge})`,
              `当前窗口剩余 ${Math.round(remPct)}%`,
              w7d ? `7天窗口剩余 ${Math.round(w7d.remaining_percent)}%` : null,
              wPrimary.detail_text || null,
              resetTxt ? `重置倒计时 ${resetTxt}` : null,
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <button
                key={card.provider}
                type="button"
                onClick={onOpenAnalytics}
                title={fullTooltip}
                className="block w-full space-y-0.5 rounded-md text-left transition-opacity hover:opacity-90 cursor-pointer"
              >
                <div className="flex items-center justify-between gap-1.5 text-[10.5px]">
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-[var(--v-fg-body)]">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${barColor}`} />
                    <span className="truncate">{shortName}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
                    <span className="font-medium text-[var(--v-fg-body)]">
                      {Math.round(remPct)}%
                    </span>
                    {w7d && (
                      <span className="text-[var(--v-fg-faint)]">
                        7d {Math.round(w7d.remaining_percent)}%
                      </span>
                    )}
                    {resetTxt && (
                      <span className="text-[var(--v-fg-muted)]">{resetTxt}</span>
                    )}
                  </span>
                </div>
                <div className="h-[4px] w-full overflow-hidden rounded-full bg-[var(--v-bg-active)]">
                  <div
                    style={{ width: `${Math.max(4, remPct)}%` }}
                    className={`h-full rounded-full transition-all duration-300 ${barColor}`}
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
