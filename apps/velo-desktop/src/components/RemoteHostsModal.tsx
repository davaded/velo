import React, { useEffect, useState } from "react";
import {
  ArrowRightLeft,
  Check,
  Copy,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Server,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

export interface RemoteHostDto {
  id: string;
  host_id?: string;
  node_kind?: "daemon" | "ssh" | string;
  label: string;
  ssh_target: string;
  daemon_url?: string;
  pairing_uri?: string;
  remote_host_id?: string;
  default_cwd: string;
  is_local?: boolean;
  status: string;
  os_info?: string;
  detected_agents?: string[];
  latency_ms?: number | null;
  running_count?: number;
  waiting_count?: number;
}

interface RemoteHostsModalProps {
  open: boolean;
  daemonUrl: string;
  localDaemonUrl?: string;
  onSwitchControlPlane?: (targetUrl: string, label: string) => void;
  onHostsUpdated?: (hosts: RemoteHostDto[]) => void;
  onDispatchedSession: (rawSession: Record<string, unknown>) => void;
  onClose: () => void;
}

export const RemoteHostsModal: React.FC<RemoteHostsModalProps> = ({
  open,
  daemonUrl,
  localDaemonUrl = "http://127.0.0.1:6767",
  onSwitchControlPlane,
  onHostsUpdated,
  onDispatchedSession,
  onClose,
}) => {
  const [tab, setTab] = useState<"daemon" | "ssh">("daemon");
  const [hosts, setHosts] = useState<RemoteHostDto[]>([]);
  const [localHostId, setLocalHostId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [copiedLocal, setCopiedLocal] = useState(false);

  // Daemon node form
  const [daemonLabel, setDaemonLabel] = useState("");
  const [daemonTargetUrl, setDaemonTargetUrl] = useState("");
  const [daemonPairingUri, setDaemonPairingUri] = useState("");

  // SSH node form
  const [newLabel, setNewLabel] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [newCwd, setNewCwd] = useState("~/code");

  const [dispatchHostId, setDispatchHostId] = useState<string | null>(null);
  const [dispatchProvider, setDispatchProvider] = useState<
    "claude" | "codex" | "antigravity" | "cursor"
  >("codex");
  const [dispatchPrompt, setDispatchPrompt] = useState("");
  const [dispatching, setDispatching] = useState(false);

  // Always manage host registry against the primary local daemon so remote switches never lose the registry
  const registryBase = localDaemonUrl || daemonUrl;

  const loadHosts = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${registryBase}/api/hosts`);
      if (res.ok) {
        const d = (await res.json()) as {
          hosts?: RemoteHostDto[];
          local_host_id?: string;
        };
        if (typeof d.local_host_id === "string") setLocalHostId(d.local_host_id);
        if (Array.isArray(d.hosts)) {
          setHosts(d.hosts);
          onHostsUpdated?.(d.hosts);
        }
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

  const handleAddDaemon = async () => {
    if (!daemonTargetUrl.trim() && !daemonPairingUri.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`${registryBase}/api/hosts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_kind: "daemon",
          label: daemonLabel.trim() || daemonTargetUrl.trim(),
          daemon_url: daemonTargetUrl.trim(),
          pairing_uri: daemonPairingUri.trim() || undefined,
        }),
      });
      if (res.ok) {
        setDaemonLabel("");
        setDaemonTargetUrl("");
        setDaemonPairingUri("");
        await loadHosts();
      }
    } finally {
      setAdding(false);
    }
  };

  const handleAddSsh = async () => {
    if (!newTarget.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`${registryBase}/api/hosts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_kind: "ssh",
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
      await fetch(`${registryBase}/api/hosts/${encodeURIComponent(id)}/probe`, {
        method: "POST",
      });
      await loadHosts();
    } finally {
      setProbingId(null);
    }
  };

  const handleRemove = async (id: string) => {
    await fetch(`${registryBase}/api/hosts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await loadHosts();
  };

  const handleDispatch = async (hostId: string) => {
    if (!dispatchPrompt.trim()) return;
    setDispatching(true);
    try {
      const res = await fetch(
        `${registryBase}/api/hosts/${encodeURIComponent(hostId)}/dispatch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: dispatchProvider,
            prompt: dispatchPrompt.trim(),
          }),
        }
      );
      if (res.ok) {
        const d = (await res.json()) as {
          ok?: boolean;
          session?: Record<string, unknown>;
        };
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

  const daemonHosts = hosts.filter(
    (h) => h.is_local || h.node_kind === "daemon"
  );
  const sshHosts = hosts.filter(
    (h) => !h.is_local && (h.node_kind || "ssh") === "ssh"
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Server className="h-4 w-4 text-[#34d399]" />
            <div>
              <h3 className="text-[14px] font-semibold text-[var(--v-fg-primary)]">
                多主机联邦控制面 (Multi-Host)
              </h3>
              <p className="text-[11.5px] text-[var(--v-fg-muted)]">
                {localHostId ? (
                  <>
                    本机标识 <code className="font-mono">{localHostId}</code> · 支持多台 Velo Daemon 主机秒切与免装 SSH 节点
                  </>
                ) : (
                  "统一管理多台 Velo Daemon 主机（LAN / Tailscale / Relay）与远端 SSH 节点"
                )}
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

        {/* Mode Tabs */}
        <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-5 py-2">
          <div className="flex items-center gap-1 rounded-lg bg-[var(--v-bg-canvas)] p-0.5">
            <button
              type="button"
              onClick={() => setTab("daemon")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer ${
                tab === "daemon"
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              <span>联邦 Daemon 主机 ({daemonHosts.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setTab("ssh")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer ${
                tab === "ssh"
                  ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                  : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <Terminal className="h-3.5 w-3.5" />
              <span>SSH 计算节点 ({sshHosts.length})</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(localDaemonUrl).catch(() => {});
              setCopiedLocal(true);
              setTimeout(() => setCopiedLocal(false), 1500);
            }}
            title="复制本机 Daemon 接入地址"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            {copiedLocal ? (
              <Check className="h-3 w-3 text-[#34d399]" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            <span>{copiedLocal ? "已复制地址" : "复制本机接入地址"}</span>
          </button>
        </div>

        {/* Add Bar */}
        {tab === "daemon" ? (
          <div className="space-y-2 border-b border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/50 px-5 py-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
              <input
                type="text"
                value={daemonTargetUrl}
                onChange={(e) => setDaemonTargetUrl(e.target.value)}
                placeholder="新主机 Daemon 地址 (如 http://100.64.0.5:6767)"
                className="sm:col-span-6 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
              />
              <input
                type="text"
                value={daemonLabel}
                onChange={(e) => setDaemonLabel(e.target.value)}
                placeholder="主机别名 (如 Linux-4090)"
                className="sm:col-span-4 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
              />
              <button
                type="button"
                disabled={adding || (!daemonTargetUrl.trim() && !daemonPairingUri.trim())}
                onClick={() => void handleAddDaemon()}
                className="sm:col-span-2 inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--v-btn-bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--v-btn-fg)] disabled:opacity-50 cursor-pointer"
              >
                {adding ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                <span>接入</span>
              </button>
            </div>
            <input
              type="text"
              value={daemonPairingUri}
              onChange={(e) => setDaemonPairingUri(e.target.value)}
              placeholder="可选：E2EE Relay 配对链接 velo://pair?...（公网自动降级通道）"
              className="w-full rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2.5 py-1 font-mono text-[11px] text-[var(--v-fg-secondary)] focus:outline-none"
            />
          </div>
        ) : (
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
              onClick={() => void handleAddSsh()}
              className="sm:col-span-2 inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--v-btn-bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--v-btn-fg)] disabled:opacity-50 cursor-pointer"
            >
              {adding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              <span>挂载</span>
            </button>
          </div>
        )}

        {/* Host List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {loading && hosts.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-[var(--v-fg-muted)]">
              正在读取主机节点…
            </div>
          ) : tab === "daemon" ? (
            daemonHosts.map((h) => {
              const online = h.status === "online";
              const targetUrl = (h.is_local ? localDaemonUrl : h.daemon_url) || "";
              const isCurrentControlPlane =
                targetUrl.replace(/\/+$/, "") === daemonUrl.replace(/\/+$/, "");
              return (
                <div
                  key={h.id}
                  className={`rounded-xl border p-3.5 transition-colors ${
                    isCurrentControlPlane
                      ? "border-[#34d399]/45 bg-[#34d399]/5"
                      : "border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/75"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          online
                            ? "bg-[#34d399]"
                            : h.status === "offline"
                            ? "bg-[#f87171]"
                            : "bg-[#fbbf24]"
                        }`}
                      />
                      <span className="truncate text-[13.5px] font-semibold text-[var(--v-fg-primary)]">
                        {h.label}
                      </span>
                      {targetUrl && (
                        <span className="hidden sm:inline-block truncate rounded bg-[var(--v-bg-active)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                          {targetUrl.replace(/^https?:\/\//, "")}
                        </span>
                      )}
                      {typeof h.latency_ms === "number" && online && (
                        <span className="font-mono text-[10.5px] text-[#34d399]">
                          {h.latency_ms}ms
                        </span>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {isCurrentControlPlane ? (
                        <span className="rounded-md bg-[#34d399]/15 px-2 py-1 text-[11px] font-medium text-[#34d399]">
                          当前控制面
                        </span>
                      ) : (
                        targetUrl &&
                        onSwitchControlPlane && (
                          <button
                            type="button"
                            onClick={() => {
                              onSwitchControlPlane(targetUrl, h.label);
                              onClose();
                            }}
                            className="inline-flex items-center gap-1 rounded-lg bg-[#a78bfa]/15 px-2.5 py-1 text-[11.5px] font-medium text-[#a78bfa] hover:bg-[#a78bfa]/25 cursor-pointer"
                          >
                            <ArrowRightLeft className="h-3 w-3" />
                            <span>切换控制面</span>
                          </button>
                        )
                      )}
                      {!h.is_local && (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleProbe(h.id)}
                            title="测速探测状态与可用引擎"
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                          >
                            <RefreshCw
                              className={`h-3.5 w-3.5 ${
                                probingId === h.id ? "animate-spin" : ""
                              }`}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRemove(h.id)}
                            title="移除主机"
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:text-[#f87171] cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--v-fg-muted)]">
                    {(h.host_id || h.remote_host_id) && (
                      <span className="font-mono">{h.host_id || h.remote_host_id}</span>
                    )}
                    {h.os_info && <span>· {h.os_info}</span>}
                    {(h.running_count || 0) > 0 && (
                      <span className="rounded bg-[#34d399]/12 px-1.5 py-0.5 font-mono text-[10px] text-[#34d399]">
                        {h.running_count} 运行中
                      </span>
                    )}
                    {(h.waiting_count || 0) > 0 && (
                      <span className="rounded bg-[#fbbf24]/15 px-1.5 py-0.5 font-mono text-[10px] text-[#fbbf24]">
                        {h.waiting_count} 待批准
                      </span>
                    )}
                    {h.detected_agents && h.detected_agents.length > 0 && (
                      <span>· 引擎: {h.detected_agents.join(", ")}</span>
                    )}
                  </div>
                </div>
              );
            })
          ) : sshHosts.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-[var(--v-fg-muted)]">
              暂无免装 SSH 节点；推荐在远端机器运行 <code className="font-mono">velo daemon</code> 后使用上方「联邦 Daemon 主机」获得完整能力。
            </div>
          ) : (
            sshHosts.map((h) => {
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
                          online
                            ? "bg-[#34d399]"
                            : h.status === "offline"
                            ? "bg-[#f87171]"
                            : "bg-[#fbbf24]"
                        }`}
                      />
                      <span className="text-[13.5px] font-semibold text-[var(--v-fg-primary)]">
                        {h.label}
                      </span>
                      <span className="rounded bg-[var(--v-bg-active)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--v-fg-muted)]">
                        {h.ssh_target}
                      </span>
                    </div>

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
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${
                            probingId === h.id ? "animate-spin" : ""
                          }`}
                        />
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
                          onChange={(e) =>
                            setDispatchProvider(
                              e.target.value as
                                | "claude"
                                | "codex"
                                | "antigravity"
                                | "cursor"
                            )
                          }
                          className="rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-2 py-1 text-[11.5px] text-[var(--v-fg-primary)]"
                        >
                          <option value="codex">远端 Codex CLI</option>
                          <option value="claude">远端 Claude Code</option>
                          <option value="antigravity">远端 Antigravity (agy)</option>
                          <option value="cursor">远端 Cursor Agent</option>
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
