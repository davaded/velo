import React, { useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckSquare,
  Eye,
  EyeOff,
  FolderGit2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";

export interface ExternalCliSessionItem {
  provider: "claude" | "codex" | string;
  cli_session_id: string;
  title: string;
  cwd: string;
  project_name: string;
  updated_at: string;
  message_count: number;
  last_preview: string;
  imported_session_id?: string | null;
  is_ephemeral?: boolean;
  ephemeral_reason?: string | null;
}

export type CliSessionManageAction = "delete" | "hide" | "unhide_all";

interface CliSessionsModalProps {
  open: boolean;
  daemonUrl: string;
  externalSessions?: ExternalCliSessionItem[] | null;
  externalHiddenCount?: number;
  onRequestE2eeList?: () => void;
  onImportViaE2ee?: (provider: string, cliSessionId: string) => void;
  onManageViaE2ee?: (
    action: CliSessionManageAction,
    items: Array<{ provider: string; cli_session_id: string }>
  ) => void;
  onImportedSession: (rawSession: Record<string, unknown>) => void;
  onClose: () => void;
}

export const CliSessionsModal: React.FC<CliSessionsModalProps> = ({
  open,
  daemonUrl,
  externalSessions,
  externalHiddenCount,
  onRequestE2eeList,
  onImportViaE2ee,
  onManageViaE2ee,
  onImportedSession,
  onClose,
}) => {
  const [items, setItems] = useState<ExternalCliSessionItem[]>([]);
  const [hiddenCount, setHiddenCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [managing, setManaging] = useState<boolean>(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [confirmCleanEphemeral, setConfirmCleanEphemeral] = useState<boolean>(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState<boolean>(false);
  const [query, setQuery] = useState<string>("");
  const [providerFilter, setProviderFilter] = useState<
    "all" | "claude" | "codex" | "cursor" | "antigravity"
  >("all");
  const [showEphemeral, setShowEphemeral] = useState<boolean>(false);
  const [selectMode, setSelectMode] = useState<boolean>(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [statusBanner, setStatusBanner] = useState<string>("");

  const itemKey = (it: { provider: string; cli_session_id: string }) =>
    `${it.provider}:${it.cli_session_id}`;

  const loadList = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${daemonUrl}/api/cli-sessions`);
      if (res.ok) {
        const data = (await res.json()) as {
          sessions?: ExternalCliSessionItem[];
          hidden_count?: number;
        };
        if (Array.isArray(data.sessions)) {
          setItems(data.sessions);
          setHiddenCount(typeof data.hidden_count === "number" ? data.hidden_count : 0);
          setLoading(false);
          return;
        }
      }
    } catch {
      // Fallback to E2EE relay if remote
    }
    onRequestE2eeList?.();
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      setConfirmDeleteKey(null);
      setConfirmCleanEphemeral(false);
      setConfirmBatchDelete(false);
      setStatusBanner("");
      void loadList();
    }
  }, [open]);

  useEffect(() => {
    if (Array.isArray(externalSessions)) {
      setItems(externalSessions);
      if (typeof externalHiddenCount === "number") {
        setHiddenCount(externalHiddenCount);
      }
      setLoading(false);
    }
  }, [externalSessions, externalHiddenCount]);

  const ephemeralItems = useMemo(() => items.filter((it) => Boolean(it.is_ephemeral)), [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (!showEphemeral && it.is_ephemeral) return false;
      if (providerFilter !== "all" && it.provider !== providerFilter) return false;
      if (!q) return true;
      return (
        it.title.toLowerCase().includes(q) ||
        it.project_name.toLowerCase().includes(q) ||
        it.cwd.toLowerCase().includes(q) ||
        it.last_preview.toLowerCase().includes(q)
      );
    });
  }, [items, query, providerFilter, showEphemeral]);

  if (!open) return null;

  const runManageAction = async (
    action: CliSessionManageAction,
    targets: Array<{ provider: string; cli_session_id: string }>,
    successMsg: string
  ) => {
    setManaging(true);
    setConfirmDeleteKey(null);
    setConfirmCleanEphemeral(false);
    setConfirmBatchDelete(false);

    // Optimistic removal for delete/hide
    if (action === "delete" || action === "hide") {
      const targetSet = new Set(targets.map(itemKey));
      setItems((prev) => prev.filter((it) => !targetSet.has(itemKey(it))));
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        targetSet.forEach((k) => next.delete(k));
        return next;
      });
    }

    try {
      const res = await fetch(`${daemonUrl}/api/cli-sessions/manage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, items: targets }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          ok?: boolean;
          sessions?: ExternalCliSessionItem[];
          hidden_count?: number;
        };
        if (Array.isArray(data.sessions)) {
          setItems(data.sessions);
        }
        if (typeof data.hidden_count === "number") {
          setHiddenCount(data.hidden_count);
        }
        setStatusBanner(successMsg);
        setManaging(false);
        return;
      }
    } catch {
      // Fallback to E2EE relay
    }

    onManageViaE2ee?.(action, targets);
    setStatusBanner(successMsg);
    setManaging(false);
  };

  const handleImport = async (item: ExternalCliSessionItem) => {
    setImportingId(item.cli_session_id);
    try {
      const res = await fetch(`${daemonUrl}/api/cli-sessions/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: item.provider,
          cli_session_id: item.cli_session_id,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { ok?: boolean; session?: Record<string, unknown> };
        if (data.ok && data.session) {
          onImportedSession(data.session);
          setImportingId(null);
          onClose();
          return;
        }
      }
    } catch {
      // fallback to E2EE
    }
    onImportViaE2ee?.(item.provider, item.cli_session_id);
    setTimeout(() => {
      setImportingId(null);
      onClose();
    }, 450);
  };

  const toggleSelect = (it: ExternalCliSessionItem) => {
    const k = itemKey(it);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const selectedItems = items.filter((it) => selectedKeys.has(itemKey(it)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84vh] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <TerminalSquare className="h-4 w-4 text-[#a78bfa]" />
            <div>
              <h3 className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                接管与管理本机终端会话
              </h3>
              <p className="text-[11.5px] text-[var(--v-fg-muted)]">
                自动过滤单轮探测/临时会话，支持一键清理本地文件或仅从列表隐藏
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setSelectMode((v) => !v);
                setSelectedKeys(new Set());
                setConfirmBatchDelete(false);
              }}
              className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer ${
                selectMode
                  ? "bg-[#a78bfa]/15 text-[#a78bfa]"
                  : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              {selectMode ? "退出批量" : "批量管理"}
            </button>
            <button
              type="button"
              onClick={() => void loadList()}
              title="刷新扫描"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Search & Provider Filter */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--v-border-subtle)] px-5 py-2.5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--v-fg-faint)]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索会话标题、项目目录或对话内容…"
              className="w-full rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] py-1.5 pl-8 pr-3 text-[12.5px] text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:border-[var(--v-border-strong)] focus:outline-none"
            />
          </div>

          <div className="flex items-center rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] p-0.5 text-[11.5px]">
            {(["all", "claude", "codex", "cursor", "antigravity"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setProviderFilter(tab)}
                className={`rounded-md px-2 py-1 transition-colors cursor-pointer ${
                  providerFilter === tab
                    ? "bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                    : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-body)]"
                }`}
              >
                {tab === "all"
                  ? "全部"
                  : tab === "claude"
                  ? "Claude"
                  : tab === "codex"
                  ? "Codex"
                  : tab === "cursor"
                  ? "Cursor"
                  : "AGY"}
              </button>
            ))}
          </div>
        </div>

        {/* Ephemeral Auto-Filter & Cleanup Strip */}
        {(ephemeralItems.length > 0 || statusBanner) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/40 px-5 py-2 text-[11.5px]">
            <div className="flex items-center gap-2 text-[var(--v-fg-muted)]">
              <Sparkles className="h-3.5 w-3.5 text-[#fbbf24]" />
              {ephemeralItems.length > 0 ? (
                <span>
                  {showEphemeral
                    ? `正在显示含 ${ephemeralItems.length} 条临时/测试会话的全部记录`
                    : `已自动过滤 ${ephemeralItems.length} 条临时/测试会话`}
                </span>
              ) : (
                <span className="text-[#34d399]">{statusBanner}</span>
              )}
            </div>

            {ephemeralItems.length > 0 && (
              <div className="flex items-center gap-1.5">
                {!confirmCleanEphemeral ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowEphemeral((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2 py-0.5 text-[11px] text-[var(--v-fg-body)] hover:border-[var(--v-border-strong)] cursor-pointer"
                    >
                      {showEphemeral ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      <span>{showEphemeral ? "隐藏临时" : "查看临时"}</span>
                    </button>
                    <button
                      type="button"
                      disabled={managing}
                      onClick={() => setConfirmCleanEphemeral(true)}
                      className="inline-flex items-center gap-1 rounded-md bg-[#f87171]/15 px-2 py-0.5 text-[11px] font-medium text-[#f87171] hover:bg-[#f87171]/25 cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>一键清理 ({ephemeralItems.length})</span>
                    </button>
                  </>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={managing}
                      onClick={() =>
                        void runManageAction(
                          "delete",
                          ephemeralItems.map((it) => ({
                            provider: it.provider,
                            cli_session_id: it.cli_session_id,
                          })),
                          `已永久删除 ${ephemeralItems.length} 条临时会话文件`
                        )
                      }
                      className="rounded-md bg-[#ef4444] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#dc2626] cursor-pointer"
                    >
                      删除本地文件
                    </button>
                    <button
                      type="button"
                      disabled={managing}
                      onClick={() =>
                        void runManageAction(
                          "hide",
                          ephemeralItems.map((it) => ({
                            provider: it.provider,
                            cli_session_id: it.cli_session_id,
                          })),
                          `已永久隐藏 ${ephemeralItems.length} 条临时会话`
                        )
                      }
                      className="rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-canvas)] px-2 py-0.5 text-[11px] text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-active)] cursor-pointer"
                    >
                      仅隐藏
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmCleanEphemeral(false)}
                      className="px-1.5 py-0.5 text-[11px] text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Batch Action Bar */}
        {selectMode && (
          <div className="flex items-center justify-between gap-2 border-b border-[var(--v-border-subtle)] bg-[#a78bfa]/8 px-5 py-2 text-[11.5px]">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  if (selectedKeys.size === filtered.length && filtered.length > 0) {
                    setSelectedKeys(new Set());
                  } else {
                    setSelectedKeys(new Set(filtered.map(itemKey)));
                  }
                }}
                className="font-medium text-[#a78bfa] hover:underline cursor-pointer"
              >
                {selectedKeys.size === filtered.length && filtered.length > 0
                  ? "取消全选"
                  : `全选当前 (${filtered.length})`}
              </button>
              <span className="text-[var(--v-fg-muted)]">已选 {selectedItems.length} 项</span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={selectedItems.length === 0 || managing}
                onClick={() =>
                  void runManageAction(
                    "hide",
                    selectedItems.map((it) => ({
                      provider: it.provider,
                      cli_session_id: it.cli_session_id,
                    })),
                    `已隐藏 ${selectedItems.length} 条会话`
                  )
                }
                className="inline-flex items-center gap-1 rounded-md border border-[var(--v-border-strong)] bg-[var(--v-bg-canvas)] px-2.5 py-1 text-[11px] text-[var(--v-fg-body)] hover:bg-[var(--v-bg-active)] disabled:opacity-40 cursor-pointer"
              >
                <EyeOff className="h-3 w-3" />
                <span>批量隐藏</span>
              </button>
              {!confirmBatchDelete ? (
                <button
                  type="button"
                  disabled={selectedItems.length === 0 || managing}
                  onClick={() => setConfirmBatchDelete(true)}
                  className="inline-flex items-center gap-1 rounded-md bg-[#f87171]/15 px-2.5 py-1 text-[11px] font-medium text-[#f87171] hover:bg-[#f87171]/25 disabled:opacity-40 cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>批量删除文件</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={managing}
                  onClick={() =>
                    void runManageAction(
                      "delete",
                      selectedItems.map((it) => ({
                        provider: it.provider,
                        cli_session_id: it.cli_session_id,
                      })),
                      `已删除 ${selectedItems.length} 个本地会话文件`
                    )
                  }
                  className="rounded-md bg-[#ef4444] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#dc2626] cursor-pointer"
                >
                  确认删除 {selectedItems.length} 个文件？
                </button>
              )}
            </div>
          </div>
        )}

        {/* Session List */}
        <div className="flex-1 overflow-y-auto p-3">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-14 text-[12.5px] text-[var(--v-fg-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>正在扫描本机终端会话…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-14 text-center text-[12.5px] text-[var(--v-fg-muted)]">
              未找到匹配的原生终端会话
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((item) => {
                const k = itemKey(item);
                const isBusy = importingId === item.cli_session_id;
                const isSelected = selectedKeys.has(k);
                const isConfirmDel = confirmDeleteKey === k;
                const relTime = (() => {
                  const d = new Date(item.updated_at);
                  if (Number.isNaN(d.getTime())) return "";
                  return d.toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                })();
                return (
                  <div
                    key={k}
                    onClick={selectMode ? () => toggleSelect(item) : undefined}
                    className={`group flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${
                      selectMode ? "cursor-pointer" : ""
                    } ${
                      isSelected
                        ? "border-[#a78bfa]/70 bg-[#a78bfa]/8"
                        : item.is_ephemeral
                        ? "border-dashed border-[#fbbf24]/35 bg-[var(--v-bg-canvas)]/45 hover:border-[#fbbf24]/60"
                        : "border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/70 hover:border-[var(--v-border-strong)]"
                    }`}
                  >
                    {selectMode && (
                      <div className="shrink-0 text-[var(--v-fg-muted)]">
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4 text-[#a78bfa]" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                            item.provider === "claude"
                              ? "bg-[#fb923c]/15 text-[#fb923c]"
                              : item.provider === "cursor"
                              ? "bg-[#a78bfa]/15 text-[#a78bfa]"
                              : item.provider === "antigravity"
                              ? "bg-[#60a5fa]/15 text-[#60a5fa]"
                              : "bg-[#34d399]/15 text-[#34d399]"
                          }`}
                        >
                          {item.provider === "claude"
                            ? "Claude"
                            : item.provider === "cursor"
                            ? "Cursor"
                            : item.provider === "antigravity"
                            ? "AGY"
                            : "Codex"}
                        </span>
                        {item.is_ephemeral && (
                          <span className="shrink-0 rounded-full bg-[#fbbf24]/15 px-1.5 py-0.5 text-[10px] font-medium text-[#fbbf24]">
                            临时 · {item.ephemeral_reason || "测试"}
                          </span>
                        )}
                        <span className="truncate text-[13px] font-medium text-[var(--v-fg-primary)]">
                          {item.title}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--v-fg-muted)]">
                        <span className="inline-flex items-center gap-1 font-mono">
                          <FolderGit2 className="h-3 w-3 opacity-70" />
                          {item.project_name}
                        </span>
                        <span>·</span>
                        <span>{item.message_count} 条消息</span>
                        {relTime && (
                          <>
                            <span>·</span>
                            <span>{relTime}</span>
                          </>
                        )}
                      </div>
                      {item.last_preview && (
                        <p className="mt-1 truncate text-[11.5px] text-[var(--v-fg-faint)]">
                          {item.last_preview}
                        </p>
                      )}
                    </div>

                    {!selectMode && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled={managing}
                          title="仅从列表隐藏（不删本地文件）"
                          onClick={(e) => {
                            e.stopPropagation();
                            void runManageAction(
                              "hide",
                              [{ provider: item.provider, cli_session_id: item.cli_session_id }],
                              "已从接管列表隐藏"
                            );
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-faint)] opacity-70 transition-all hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] hover:opacity-100 cursor-pointer"
                        >
                          <EyeOff className="h-3.5 w-3.5" />
                        </button>

                        {!isConfirmDel ? (
                          <button
                            type="button"
                            disabled={managing}
                            title="删除本地 CLI 会话文件"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteKey(k);
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-faint)] opacity-70 transition-all hover:bg-[#f87171]/15 hover:text-[#f87171] hover:opacity-100 cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={managing}
                            onClick={(e) => {
                              e.stopPropagation();
                              void runManageAction(
                                "delete",
                                [{ provider: item.provider, cli_session_id: item.cli_session_id }],
                                "已永久删除该本地会话文件"
                              );
                            }}
                            onMouseLeave={() => setConfirmDeleteKey(null)}
                            className="rounded-lg bg-[#ef4444] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#dc2626] cursor-pointer"
                          >
                            确认删?
                          </button>
                        )}

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleImport(item);
                          }}
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                            item.imported_session_id
                              ? "bg-[#34d399]/15 text-[#34d399] hover:bg-[#34d399]/25"
                              : "bg-[var(--v-fg-primary)] text-[var(--v-bg-canvas)] hover:opacity-90"
                          }`}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : item.imported_session_id ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : null}
                          <span>{item.imported_session_id ? "同步并打开" : "接管"}</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer for Hidden Sessions Restoration */}
        {hiddenCount > 0 && (
          <div className="flex items-center justify-between border-t border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/60 px-5 py-2.5 text-[11.5px] text-[var(--v-fg-muted)]">
            <span>已手动隐藏 {hiddenCount} 条本机终端会话（未删除磁盘文件）</span>
            <button
              type="button"
              disabled={managing}
              onClick={() => void runManageAction("unhide_all", [], "已恢复所有隐藏会话")}
              className="inline-flex items-center gap-1 font-medium text-[var(--v-fg-primary)] hover:underline cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              <span>恢复全部显示</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
