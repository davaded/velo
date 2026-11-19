import React, { useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Send, Server, Trash2, X } from "lucide-react";

export interface RemoteHostDto {
  id: string;
  label: string;
  ssh_target: string;
  default_cwd: string;
  is_local?: boolean;
  status: string;
  os_info?: string;
  detected_agents?: string[];
}

interface RemoteHostsModalProps {
  open: boolean;
  daemonUrl: string;
  onDispatchedSession: (rawSession: Record<string, unknown>) => void;
  onClose: () => void;
}

export const RemoteHostsModal: React.FC<RemoteHostsModalProps> = ({
  open,
  daemonUrl,
  onDispatchedSession,
  onClose,
}) => {
  const [hosts, setHosts] = useState<RemoteHostDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [newCwd, setNewCwd] = useState("~/code");

  const [dispatchHostId, setDispatchHostId] = useState<string | null>(null);
  const [dispatchProvider, setDispatchProvider] = useState<"claude" | "codex">("codex");
  const [dispatchPrompt, setDispatchPrompt] = useState("");
  const [dispatching, setDispatching] = useState(false);

  const loadHosts = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${daemonUrl}/api/hosts`);
      if (res.ok) {
        const d = (await res.json()) as { hosts?: RemoteHostDto[] };
        if (Array.isArray(d.hosts)) setHosts(d.hosts);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadHosts();
  }, [open]);

  if (!open) return null;

  const handleAdd = async () => {
    if (!newTarget.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`${daemonUrl}/api/hosts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: newLabel.trim() || newTarget.trim(),
          ssh_target: newTarget.trim(),
          default_cwd: newCwd.trim() || "~",
          prefer_hush: true,
        }),
      });
      if (res.ok) {
        setNewLabel("");
        setNewTarget("");
        await loadHosts();
      }
    } finally {
      setAdding(false);
    }
  };

  const handleProbe = async (id: string) => {
    setProbingId(id);
    try {
      await fetch(`${daemonUrl}/api/hosts/${encodeURIComponent(id)}/probe`, { method: "POST" });
      await loadHosts();
    } finally {
      setProbingId(null);
    }
  };

  const handleRemove = async (id: string) => {
    await fetch(`${daemonUrl}/api/hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadHosts();
  };

  const handleDispatch = async (hostId: string) => {
    if (!dispatchPrompt.trim()) return;
    setDispatching(true);
    try {
      const res = await fetch(`${daemonUrl}/api/hosts/${encodeURIComponent(hostId)}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: dispatchProvider,
          prompt: dispatchPrompt.trim(),
        }),
      });
      if (res.ok) {
        const d = (await res.json()) as { ok?: boolean; session?: Record<string, unknown> };
        if (d.ok && d.session) {
          onDispatchedSession(d.session);
          setDispatchPrompt("");
          setDispatchHostId(null);
          onClose();
        }
      }
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84vh] w-full max-w-[650px] flex-col overflow-hidden rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Server className="h-4 w-4 text-[#34d399]" />
            <div>
              <h3 className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                多主机与远端 SSH 节点管理 (Multi-Host)
              </h3>
              <p className="text-[11.5px] text-[var(--v-fg-muted)]">
                自动兼容 <code className="font-mono">hush ssh &lt;host&gt;</code> 与标准{" "}
                <code className="font-mono">ssh</code>，一键探测环境并派发远端 Agent 任务
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Add SSH Host Bar */}
        <div className="grid grid-cols-1 gap-2 border-b border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/50 px-5 py-3 sm:grid-cols-12">
          <input
            type="text"
            value={newTarget}
            onChange={(e) => setNewTarget(e.target.value)}
            placeholder="SSH 别名或地址 (如 s13 / dmit / root@ip)"
            className="sm:col-span-5 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
          />
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="显示名称 (可选)"
            className="sm:col-span-3 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
          />
          <input
            type="text"
            value={newCwd}
            onChange={(e) => setNewCwd(e.target.value)}
            placeholder="远端目录 (~)"
            className="sm:col-span-2 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
          />
          <button
            type="button"
            disabled={adding || !newTarget.trim()}
            onClick={() => void handleAdd()}
            className="sm:col-span-2 inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--v-btn-bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--v-btn-fg)] disabled:opacity-50 cursor-pointer"
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            <span>挂载</span>
          </button>
        </div>

        {/* Host List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {loading && hosts.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-[var(--v-fg-muted)]">正在读取主机节点…</div>
          ) : (
            hosts.map((h) => {
              const online = h.status === "online";
              const isDispatchOpen = dispatchHostId === h.id;
              return (
                <div
                  key={h.id}
                  className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/75 p-3.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          online ? "bg-[#34d399]" : h.status === "offline" ? "bg-[#f87171]" : "bg-[#fbbf24]"
                        }`}
                      />
                      <span className="text-[13.5px] font-semibold text-[var(--v-fg-primary)]">
                        {h.label}
                      </span>
                      <span className="rounded bg-[var(--v-bg-active)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--v-fg-muted)]">
                        {h.ssh_target}
                      </span>
                    </div>

                    {!h.is_local && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDispatchHostId(isDispatchOpen ? null : h.id)}
                          className="rounded-lg bg-[#a78bfa]/15 px-2.5 py-1 text-[11.5px] font-medium text-[#a78bfa] hover:bg-[#a78bfa]/25 cursor-pointer"
                        >
                          派发远端任务
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleProbe(h.id)}
                          title="探测连通性与已装 CLI"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${probingId === h.id ? "animate-spin" : ""}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemove(h.id)}
                          title="移除主机"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:text-[#f87171] cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--v-fg-muted)]">
                    {h.os_info && <span>{h.os_info}</span>}
                    {h.detected_agents && h.detected_agents.length > 0 && (
                      <>
                        <span>·</span>
                        <span>已检测到: {h.detected_agents.join(", ")}</span>
                      </>
                    )}
                  </div>

                  {isDispatchOpen && (
                    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] p-2.5">
                      <div className="flex items-center gap-2">
                        <select
                          value={dispatchProvider}
                          onChange={(e) => setDispatchProvider(e.target.value as "claude" | "codex")}
                          className="rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2 py-1 text-[11.5px] text-[var(--v-fg-primary)]"
                        >
                          <option value="codex">远端 Codex CLI</option>
                          <option value="claude">远端 Claude Code</option>
                        </select>
                        <input
                          type="text"
                          value={dispatchPrompt}
                          onChange={(e) => setDispatchPrompt(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void handleDispatch(h.id);
                          }}
                          placeholder={`向 ${h.label} 发送远端执行任务…`}
                          className="flex-1 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2.5 py-1 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={dispatching || !dispatchPrompt.trim()}
                          onClick={() => void handleDispatch(h.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-[var(--v-btn-bg)] px-3 py-1 text-[12px] font-medium text-[var(--v-btn-fg)] disabled:opacity-50 cursor-pointer"
                        >
                          {dispatching ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Send className="h-3 w-3" />
                          )}
                          <span>执行</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
