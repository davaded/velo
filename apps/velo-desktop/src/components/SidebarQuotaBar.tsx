import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

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
  mode?: "subscription" | "wallet" | "unauthenticated" | string;
  summary_text?: string | null;
  windows: QuotaWindowItem[];
}

function formatResetCountdown(sec?: number | null): string {
  if (typeof sec !== "number" || sec <= 0) return "";
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (hrs >= 24) {
    const days = Math.floor(hrs / 24);
    const remH = hrs % 24;
    return `${days}d ${remH}h`;
  }
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

export const SidebarQuotaBar: React.FC<{
  daemonUrl: string;
  onOpenAnalytics: () => void;
}> = ({ daemonUrl, onOpenAnalytics }) => {
  const [cards, setCards] = useState<ProviderQuotaCard[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetchQuotas = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`${daemonUrl}/api/analytics/quotas`);
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
    void fetchQuotas();
    const id = setInterval(() => void fetchQuotas(), 45_000);
    return () => clearInterval(id);
  }, [daemonUrl]);

  // Only show configured/authenticated providers prominently; keep unauthenticated subtle
  const activeCards = cards.filter((c) => c.mode !== "unauthenticated");
  const unauthCards = cards.filter((c) => c.mode === "unauthenticated");

  if (cards.length === 0) return null;

  return (
    <div className="mx-2 mb-1.5 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/75 px-2.5 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <button
          type="button"
          onClick={onOpenAnalytics}
          className="text-[10.5px] font-medium text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)] cursor-pointer"
        >
          实时配额与余额监控
        </button>
        <button
          type="button"
          onClick={() => void fetchQuotas()}
          title="刷新实时配额"
          className="text-[var(--v-fg-faint)] hover:text-[var(--v-fg-primary)] cursor-pointer"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="space-y-1.5">
        {activeCards.map((card) => {
          const shortName = card.provider === "claude" ? "Claude" : "Codex";
          const isWallet = card.mode === "wallet";
          const wPrimary = card.windows.find((w) => w.id === "5h") || card.windows[0];
          const w7d = card.windows.find((w) => w.id === "7d");
          if (!wPrimary) return null;

          const remPct = Math.max(0, Math.min(100, wPrimary.remaining_percent));
          const resetTxt = formatResetCountdown(wPrimary.reset_in_seconds);
          const barColor =
            wPrimary.status === "exhausted"
              ? "bg-[#f87171]"
              : wPrimary.status === "warning"
              ? "bg-[#fbbf24]"
              : card.provider === "claude"
              ? "bg-[#fb923c]"
              : "bg-[#34d399]";

          const rightSummary = isWallet
            ? card.summary_text || wPrimary.detail_text || ""
            : `余 ${Math.round(remPct)}%${
                w7d ? ` · 7d ${Math.round(w7d.remaining_percent)}%` : ""
              }${resetTxt ? ` · ${resetTxt}` : ""}`;

          return (
            <div key={card.provider} className="space-y-0.5">
              <div className="flex items-center justify-between gap-1.5 text-[10.5px]">
                <span className="shrink-0 font-medium text-[var(--v-fg-body)]">
                  {shortName}
                </span>
                <span
                  title={rightSummary}
                  className="truncate font-mono text-[10px] text-[var(--v-fg-muted)] tabular-nums"
                >
                  {rightSummary}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--v-bg-active)]">
                <div
                  style={{ width: `${Math.max(4, remPct)}%` }}
                  className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                />
              </div>
            </div>
          );
        })}

        {unauthCards.length > 0 && (
          <div className="flex items-center justify-between pt-0.5 text-[10px] text-[var(--v-fg-faint)]">
            {unauthCards.map((c) => (
              <span key={c.provider}>
                {c.provider === "claude" ? "Claude" : "Codex"}: 未登录
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
