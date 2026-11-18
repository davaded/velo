import React, { useEffect, useMemo, useState } from "react";
import { Check, FolderGit2, Loader2, RefreshCw, Search, TerminalSquare, X } from "lucide-react";

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
}

interface CliSessionsModalProps {
  open: boolean;
  daemonUrl: string;
  externalSessions?: ExternalCliSessionItem[] | null;
  onRequestE2eeList?: () => void;
  onImportViaE2ee?: (provider: string, cliSessionId: string) => void;
  onImportedSession: (rawSession: Record<string, unknown>) => void;
  onClose: () => void;
}

export const CliSessionsModal: React.FC<CliSessionsModalProps> = ({
  open,
  daemonUrl,
  externalSessions,
  onRequestE2eeList,
  onImportViaE2ee,
  onImportedSession,
  onClose,
}) => {
  const [items, setItems] = useState<ExternalCliSessionItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");
  const [providerFilter, setProviderFilter] = useState<"all" | "claude" | "codex">("all");

  const loadList = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${daemonUrl}/api/cli-sessions`);
      if (res.ok) {
        const data = (await res.json()) as { sessions?: ExternalCliSessionItem[] };
        if (Array.isArray(data.sessions)) {
          setItems(data.sessions);
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
      void loadList();
    }
  }, [open]);

  useEffect(() => {
    if (Array.isArray(externalSessions)) {
      setItems(externalSessions);
      setLoading(false);
    }
  }, [externalSessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (providerFilter !== "all" && it.provider !== providerFilter) return false;
      if (!q) return true;
      return (
        it.title.toLowerCase().includes(q) ||
        it.project_name.toLowerCase().includes(q) ||
        it.cwd.toLowerCase().includes(q) ||
        it.last_preview.toLowerCase().includes(q)
      );
    });
  }, [items, query, providerFilter]);

  if (!open) return null;

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <TerminalSquare className="h-4 w-4 text-[#a78bfa]" />
            <div>
              <h3 className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                接管本机 Claude / Codex 终端会话
              </h3>
              <p className="text-[11.5px] text-[var(--v-fg-muted)]">
                自动扫描 <code className="font-mono">~/.claude/projects</code> 与{" "}
                <code className="font-mono">~/.codex/sessions</code>，原地无损续接上下文
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
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
            {(["all", "claude", "codex"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setProviderFilter(tab)}
                className={`rounded-md px-2.5 py-1 capitalize transition-colors cursor-pointer ${
                  providerFilter === tab
                    ? "bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                    : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-body)]"
                }`}
              >
                {tab === "all" ? "全部" : tab === "claude" ? "Claude Code" : "Codex"}
              </button>
            ))}
          </div>
        </div>

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
                const isClaude = item.provider === "claude";
                const isBusy = importingId === item.cli_session_id;
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
                    key={`${item.provider}-${item.cli_session_id}`}
                    className="group flex items-center justify-between gap-3 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/70 px-3.5 py-2.5 transition-colors hover:border-[var(--v-border-strong)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                            isClaude
                              ? "bg-[#fb923c]/15 text-[#fb923c]"
                              : "bg-[#34d399]/15 text-[#34d399]"
                          }`}
                        >
                          {isClaude ? "Claude" : "Codex"}
                        </span>
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

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleImport(item)}
                      className={`shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                        item.imported_session_id
                          ? "border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] text-[var(--v-fg-body)] hover:border-[var(--v-border-strong)]"
                          : "bg-[var(--v-btn-bg)] text-[var(--v-btn-fg)] hover:opacity-90"
                      }`}
                    >
                      {isBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : item.imported_session_id ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-[#34d399]" />
                          <span>同步打开</span>
                        </>
                      ) : (
                        <span>一键接管</span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
