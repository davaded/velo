import React, { useEffect, useState } from "react";
import { BarChart3, Bell, Check, Search, Shield, Sparkles, X } from "lucide-react";
import { ProviderQuotaCard } from "./SidebarQuotaBar";

interface BucketStats {
  key: string;
  label: string;
  sessions_count: number;
  turns_count: number;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cache_hit_pct: number;
  avg_tps: number;
  cost_usd: number;
}

interface UsageAnalyticsDto {
  sessions_count: number;
  turns_count: number;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_hit_pct: number;
  avg_tps: number;
  total_cost_usd: number;
  today_cost_usd: number;
  today_tokens: number;
  by_provider: BucketStats[];
  by_workspace: BucketStats[];
}

interface SearchHitDto {
  session_id: string;
  session_name: string;
  repo_root: string;
  provider: string;
  kind: string;
  snippet: string;
  timestamp_ms: number;
}

interface PushConfigDto {
  enabled: boolean;
  bark_target: string;
  webhook_url: string;
  blind_mode: boolean;
  notify_on_permission: boolean;
  notify_on_complete: boolean;
  notify_on_error: boolean;
}

interface Props {
  open: boolean;
  initialTab?: "analytics" | "search" | "push";
  daemonUrl: string;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
}

function fmtTokens(n: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtUsd(n: number): string {
  if (!n || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export const AnalyticsAndPushModal: React.FC<Props> = ({
  open,
  initialTab = "analytics",
  daemonUrl,
  onClose,
  onSelectSession,
}) => {
  const [tab, setTab] = useState<"analytics" | "search" | "push">(initialTab);
  const [analytics, setAnalytics] = useState<UsageAnalyticsDto | null>(null);
  const [quotaCards, setQuotaCards] = useState<ProviderQuotaCard[]>([]);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHitDto[]>([]);
  const [searching, setSearching] = useState(false);

  const [pushCfg, setPushCfg] = useState<PushConfigDto>({
    enabled: false,
    bark_target: "",
    webhook_url: "",
    blind_mode: true,
    notify_on_permission: true,
    notify_on_complete: true,
    notify_on_error: true,
  });
  const [savingPush, setSavingPush] = useState(false);
  const [pushBanner, setPushBanner] = useState<string>("");

  useEffect(() => {
    if (open && initialTab) {
      setTab(initialTab);
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    if (tab === "analytics") {
      setLoadingAnalytics(true);
      fetch(`${daemonUrl}/api/analytics/quotas`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (Array.isArray(d?.providers)) setQuotaCards(d.providers as ProviderQuotaCard[]);
        })
        .catch(() => {});
      fetch(`${daemonUrl}/api/analytics/usage`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d) setAnalytics(d as UsageAnalyticsDto);
        })
        .catch(() => {})
        .finally(() => setLoadingAnalytics(false));
    } else if (tab === "push") {
      fetch(`${daemonUrl}/api/push/config`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.config) setPushCfg(d.config as PushConfigDto);
        })
        .catch(() => {});
    }
  }, [open, tab, daemonUrl]);

  useEffect(() => {
    if (!open || tab !== "search") return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchHits([]);
      return;
    }
    const timer = setTimeout(() => {
      setSearching(true);
      fetch(`${daemonUrl}/api/search?q=${encodeURIComponent(q)}&limit=40`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          setSearchHits(Array.isArray(d?.hits) ? (d.hits as SearchHitDto[]) : []);
        })
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [open, tab, searchQuery, daemonUrl]);

  if (!open) return null;

  const savePush = async () => {
    setSavingPush(true);
    setPushBanner("");
    try {
      const r = await fetch(`${daemonUrl}/api/push/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pushCfg),
      });
      if (r.ok) setPushBanner("✅ 已保存远程推送配置");
      else setPushBanner("⚠️ 保存失败");
    } catch {
      setPushBanner("⚠️ 网络请求失败");
    } finally {
      setSavingPush(false);
    }
  };

  const testPush = async () => {
    await savePush();
    setPushBanner("正在发送锁屏测试通知…");
    try {
      const r = await fetch(`${daemonUrl}/api/push/test`, { method: "POST" });
      const d = await r.json();
      if (d?.ok) {
        setPushBanner("✅ 测试推送已送达，请查看手机锁屏通知");
      } else {
        setPushBanner(`⚠️ ${d?.error || "推送未成功，请检查 Bark Key 或 Webhook 地址"}`);
      }
    } catch {
      setPushBanner("⚠️ 测试推送请求失败");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[84vh] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] shadow-2xl"
      >
        {/* Header & Segmented Tabs */}
        <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-5 py-3.5">
          <div className="flex items-center gap-1.5 rounded-xl bg-[var(--v-bg-hover)] p-1">
            {(
              [
                { id: "analytics", label: "用量与账单", icon: BarChart3 },
                { id: "search", label: "全局搜索", icon: Search },
                { id: "push", label: "远程锁屏推送", icon: Bell },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                    active
                      ? "bg-[var(--v-bg-surface)] text-[var(--v-fg-primary)] shadow-sm"
                      : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === "analytics" && (
            <div className="space-y-5">
              {loadingAnalytics && !analytics ? (
                <div className="py-12 text-center text-[13px] text-[var(--v-fg-muted)]">
                  正在聚合 SQLite 指标与费率账单…
                </div>
              ) : analytics ? (
                <>
                  {/* 5h & 7d Subscription Rate-Limit Windows */}
                  {quotaCards.length > 0 && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {quotaCards.map((card) => (
                        <div
                          key={card.provider}
                          className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/45 p-3.5"
                        >
                          <div className="mb-2.5 flex items-center justify-between">
                            <span className="text-[12.5px] font-semibold text-[var(--v-fg-primary)]">
                              {card.label}
                            </span>
                            <span className="rounded-md bg-[var(--v-bg-active)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--v-fg-muted)]">
                              {card.plan_badge}
                            </span>
                          </div>
                          <div className="space-y-2">
                            {card.mode === "unauthenticated" ? (
                              <div className="text-[11.5px] text-[var(--v-fg-muted)]">
                                {card.summary_text || "当前未登录该 CLI 账号"}
                              </div>
                            ) : (
                              card.windows.map((w) => {
                                const rem = Math.max(0, Math.min(100, w.remaining_percent));
                                const resetHrs =
                                  typeof w.reset_in_seconds === "number" && w.reset_in_seconds > 0
                                    ? w.reset_in_seconds >= 86400
                                      ? `${Math.floor(w.reset_in_seconds / 86400)}d ${Math.floor((w.reset_in_seconds % 86400) / 3600)}h 后重置`
                                      : `${Math.floor(w.reset_in_seconds / 3600)}h ${Math.floor((w.reset_in_seconds % 3600) / 60)}m 后重置`
                                    : "";
                                const rightLabel =
                                  card.mode === "wallet" && w.detail_text
                                    ? w.detail_text
                                    : `${
                                        w.detail_text ? `${w.detail_text} · ` : ""
                                      }剩余 ${Math.round(rem)}%${resetHrs ? ` · ${resetHrs}` : ""}`;
                                return (
                                  <div key={w.id} className="space-y-1">
                                    <div className="flex items-center justify-between text-[11px]">
                                      <span className="text-[var(--v-fg-secondary)]">{w.label}</span>
                                      <span className="font-mono text-[10.5px] text-[var(--v-fg-muted)] tabular-nums">
                                        {rightLabel}
                                      </span>
                                    </div>
                                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--v-bg-active)]">
                                      <div
                                        style={{ width: `${Math.max(4, rem)}%` }}
                                        className={`h-full rounded-full ${
                                          w.status === "exhausted"
                                            ? "bg-[#f87171]"
                                            : w.status === "warning"
                                            ? "bg-[#fbbf24]"
                                            : card.provider === "claude"
                                            ? "bg-[#fb923c]"
                                            : "bg-[#34d399]"
                                        }`}
                                      />
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* KPI Cards */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/50 p-3.5">
                      <div className="text-[11px] text-[var(--v-fg-muted)]">累计折算账单</div>
                      <div className="mt-1 font-mono text-[20px] font-semibold text-[var(--v-fg-primary)] tabular-nums">
                        {fmtUsd(analytics.total_cost_usd)}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#34d399]">
                        今日 {fmtUsd(analytics.today_cost_usd)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/50 p-3.5">
                      <div className="text-[11px] text-[var(--v-fg-muted)]">总吞吐 Token</div>
                      <div className="mt-1 font-mono text-[20px] font-semibold text-[var(--v-fg-primary)] tabular-nums">
                        {fmtTokens(analytics.total_tokens)}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--v-fg-muted)]">
                        输出 {fmtTokens(analytics.output_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/50 p-3.5">
                      <div className="text-[11px] text-[var(--v-fg-muted)]">Prompt 缓存命中</div>
                      <div className="mt-1 font-mono text-[20px] font-semibold text-[#60a5fa] tabular-nums">
                        {analytics.cache_hit_pct.toFixed(1)}%
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--v-fg-muted)]">
                        命中 {fmtTokens(analytics.cache_read_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/50 p-3.5">
                      <div className="text-[11px] text-[var(--v-fg-muted)]">加权输出速率</div>
                      <div className="mt-1 font-mono text-[20px] font-semibold text-[#a78bfa] tabular-nums">
                        {analytics.avg_tps > 0 ? `${analytics.avg_tps.toFixed(1)}` : "—"}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--v-fg-muted)]">
                        tok/s · {analytics.turns_count} 轮对话
                      </div>
                    </div>
                  </div>

                  {/* By Provider */}
                  <div>
                    <div className="mb-2 text-[12px] font-semibold text-[var(--v-fg-secondary)]">
                      按 AI 引擎账单与速率分布
                    </div>
                    <div className="overflow-hidden rounded-xl border border-[var(--v-border-subtle)]">
                      <table className="w-full text-left text-[12px]">
                        <thead className="bg-[var(--v-bg-hover)]/70 text-[11px] text-[var(--v-fg-muted)]">
                          <tr>
                            <th className="px-3 py-2">引擎</th>
                            <th className="px-3 py-2">会话 / 轮次</th>
                            <th className="px-3 py-2">输入 / 输出</th>
                            <th className="px-3 py-2">缓存命中</th>
                            <th className="px-3 py-2">均速</th>
                            <th className="px-3 py-2 text-right">费用</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--v-border-subtle)]">
                          {analytics.by_provider.map((b) => (
                            <tr key={b.key} className="hover:bg-[var(--v-bg-hover)]/40">
                              <td className="px-3 py-2 font-mono font-semibold text-[var(--v-fg-primary)]">
                                {b.label}
                              </td>
                              <td className="px-3 py-2 font-mono text-[var(--v-fg-muted)] tabular-nums">
                                {b.sessions_count} / {b.turns_count}
                              </td>
                              <td className="px-3 py-2 font-mono text-[var(--v-fg-secondary)] tabular-nums">
                                {fmtTokens(b.input_tokens)} / {fmtTokens(b.output_tokens)}
                              </td>
                              <td className="px-3 py-2 font-mono text-[#60a5fa] tabular-nums">
                                {b.cache_hit_pct > 0 ? `${b.cache_hit_pct.toFixed(0)}%` : "—"}
                              </td>
                              <td className="px-3 py-2 font-mono text-[#a78bfa] tabular-nums">
                                {b.avg_tps > 0 ? `${b.avg_tps.toFixed(1)} tok/s` : "—"}
                              </td>
                              <td className="px-3 py-2 text-right font-mono font-medium text-[var(--v-fg-primary)] tabular-nums">
                                {fmtUsd(b.cost_usd)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* By Workspace */}
                  <div>
                    <div className="mb-2 text-[12px] font-semibold text-[var(--v-fg-secondary)]">
                      按项目工作区统计
                    </div>
                    <div className="space-y-1.5">
                      {analytics.by_workspace.map((w) => (
                        <div
                          key={w.key}
                          className="flex items-center justify-between rounded-xl border border-[var(--v-border-subtle)] px-3.5 py-2.5 text-[12px]"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-[var(--v-fg-primary)]">
                              {w.label}
                            </div>
                            <div className="truncate font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                              {w.key}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-4 font-mono tabular-nums">
                            <span className="text-[11px] text-[var(--v-fg-muted)]">
                              {w.sessions_count} 会话 · 输出 {fmtTokens(w.output_tokens)}
                            </span>
                            <span className="font-semibold text-[var(--v-fg-primary)]">
                              {fmtUsd(w.cost_usd)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          )}

          {tab === "search" && (
            <div className="space-y-3.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-[var(--v-fg-muted)]" />
                <input
                  autoFocus
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="跨全部项目与历史会话搜索关键词（标题、Prompt、AI 回复、报错）…"
                  className="w-full rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-hover)]/50 py-2.5 pl-10 pr-4 text-[13px] text-[var(--v-fg-primary)] placeholder:text-[var(--v-fg-muted)] focus:outline-none"
                />
              </div>
              {searching && (
                <div className="text-[12px] text-[var(--v-fg-muted)]">正在检索 SQLite 索引…</div>
              )}
              {!searching && searchQuery.trim() && searchHits.length === 0 && (
                <div className="py-10 text-center text-[12.5px] text-[var(--v-fg-muted)]">
                  未找到包含「{searchQuery.trim()}」的历史记录
                </div>
              )}
              <div className="space-y-2">
                {searchHits.map((h, i) => (
                  <button
                    key={`${h.session_id}-${h.timestamp_ms}-${i}`}
                    onClick={() => {
                      onSelectSession(h.session_id);
                      onClose();
                    }}
                    className="flex w-full flex-col gap-1 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/35 p-3 text-left transition-colors hover:border-[var(--v-border-strong)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12.5px] font-semibold text-[var(--v-fg-primary)]">
                        {h.session_name}
                      </span>
                      <span className="shrink-0 rounded-md bg-[var(--v-bg-active)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--v-fg-muted)]">
                        {h.provider.toUpperCase()} · {h.kind}
                      </span>
                    </div>
                    <div className="line-clamp-2 text-[12px] text-[var(--v-fg-secondary)]">
                      {h.snippet}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                      {h.repo_root}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === "push" && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-[#8b5cf6]/25 bg-[#8b5cf6]/8 p-3.5">
                <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[#a78bfa]" />
                <div className="text-[12px] leading-relaxed text-[var(--v-fg-secondary)]">
                  <strong>零明文盲推送（Zero-Plaintext Wakeup）</strong>：当手机 Velo App 被 iOS
                  系统挂起在后台时，通过 Bark（APNs）或 Webhook 发送唤醒信号，点击通知即可通过
                  <code className="mx-1 rounded bg-black/20 px-1 font-mono">velo://session/…</code>
                  直达加密会话，第三方推送通道全程看不到任何代码与对话内容。
                </div>
              </div>

              <label className="flex items-center justify-between rounded-xl border border-[var(--v-border-subtle)] px-3.5 py-2.5 cursor-pointer">
                <span className="text-[13px] font-medium text-[var(--v-fg-primary)]">
                  启用远程锁屏推送通知
                </span>
                <input
                  type="checkbox"
                  checked={pushCfg.enabled}
                  onChange={(e) => setPushCfg((p) => ({ ...p, enabled: e.target.checked }))}
                  className="h-4 w-4 accent-[#8b5cf6]"
                />
              </label>

              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-[var(--v-fg-secondary)]">
                  iOS Bark Key 或自建 Bark 服务地址（推荐）
                </label>
                <input
                  type="text"
                  value={pushCfg.bark_target}
                  onChange={(e) => setPushCfg((p) => ({ ...p, bark_target: e.target.value }))}
                  placeholder="例如 AbCdEf123456 或 https://api.day.app/AbCdEf123456"
                  className="w-full rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-hover)]/40 px-3.5 py-2 font-mono text-[12.5px] text-[var(--v-fg-primary)] focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-[var(--v-fg-secondary)]">
                  通用 Webhook 地址（可选：飞书 / Slack / Discord / ntfy）
                </label>
                <input
                  type="text"
                  value={pushCfg.webhook_url}
                  onChange={(e) => setPushCfg((p) => ({ ...p, webhook_url: e.target.value }))}
                  placeholder="https://..."
                  className="w-full rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-hover)]/40 px-3.5 py-2 font-mono text-[12.5px] text-[var(--v-fg-primary)] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 rounded-xl border border-[var(--v-border-subtle)] px-3 py-2 text-[12px] text-[var(--v-fg-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pushCfg.blind_mode}
                    onChange={(e) => setPushCfg((p) => ({ ...p, blind_mode: e.target.checked }))}
                    className="accent-[#8b5cf6]"
                  />
                  <span>零明文隐私模式（不带标题与内容）</span>
                </label>
                <label className="flex items-center gap-2 rounded-xl border border-[var(--v-border-subtle)] px-3 py-2 text-[12px] text-[var(--v-fg-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pushCfg.notify_on_permission}
                    onChange={(e) =>
                      setPushCfg((p) => ({ ...p, notify_on_permission: e.target.checked }))
                    }
                    className="accent-[#8b5cf6]"
                  />
                  <span>等待权限审批 / 提问时推送</span>
                </label>
                <label className="flex items-center gap-2 rounded-xl border border-[var(--v-border-subtle)] px-3 py-2 text-[12px] text-[var(--v-fg-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pushCfg.notify_on_complete}
                    onChange={(e) =>
                      setPushCfg((p) => ({ ...p, notify_on_complete: e.target.checked }))
                    }
                    className="accent-[#8b5cf6]"
                  />
                  <span>任务执行完成时推送</span>
                </label>
                <label className="flex items-center gap-2 rounded-xl border border-[var(--v-border-subtle)] px-3 py-2 text-[12px] text-[var(--v-fg-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pushCfg.notify_on_error}
                    onChange={(e) =>
                      setPushCfg((p) => ({ ...p, notify_on_error: e.target.checked }))
                    }
                    className="accent-[#8b5cf6]"
                  />
                  <span>执行报错中断时推送</span>
                </label>
              </div>

              {pushBanner && (
                <div className="rounded-lg bg-[var(--v-bg-hover)] px-3 py-2 text-[12px] text-[var(--v-fg-primary)]">
                  {pushBanner}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={testPush}
                  className="flex items-center gap-1.5 rounded-xl border border-[var(--v-border-strong)] px-3.5 py-2 text-[12px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                >
                  <Sparkles className="h-3.5 w-3.5 text-[#a78bfa]" />
                  <span>发送测试推送</span>
                </button>
                <button
                  type="button"
                  onClick={savePush}
                  disabled={savingPush}
                  className="flex items-center gap-1.5 rounded-xl bg-[var(--v-btn-bg)] px-4 py-2 text-[12px] font-medium text-[var(--v-btn-fg)] hover:opacity-90 cursor-pointer"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>保存配置</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
