import React, { useEffect, useState } from "react";
import {
  Blocks,
  CheckCircle2,
  History,
  Loader2,
  Plug,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";

export interface TurnCheckpointDto {
  id: string;
  turn_index: number;
  prompt_preview: string;
  git_ref: string;
  head_short: string;
  had_dirty_changes: boolean;
  created_at: string;
}

export interface McpServerEntryDto {
  id: string;
  name: string;
  engine: string;
  transport: string;
  target: string;
  enabled: boolean;
}

export interface SkillEntryDto {
  id: string;
  name: string;
  engine: string;
  description: string;
  path: string;
}

interface Props {
  open: boolean;
  initialTab: "checkpoints" | "extensions";
  daemonUrl: string;
  sessionId: string | null;
  sessionTitle: string;
  onUseSkillPrompt: (text: string) => void;
  onRewound: () => void;
  onClose: () => void;
}

function engineBadgeStyle(eng: string): { label: string; cls: string } {
  switch (eng) {
    case "antigravity":
      return { label: "Antigravity", cls: "bg-[#60a5fa]/15 text-[#60a5fa]" };
    case "cursor":
      return { label: "Cursor", cls: "bg-[#a78bfa]/15 text-[#a78bfa]" };
    case "claude":
      return { label: "Claude", cls: "bg-[#fb923c]/15 text-[#fb923c]" };
    case "codex":
      return { label: "Codex", cls: "bg-[#34d399]/15 text-[#34d399]" };
    default:
      return { label: eng, cls: "bg-[var(--v-bg-active)] text-[var(--v-fg-muted)]" };
  }
}

export const ExtensionsAndCheckpointsModal: React.FC<Props> = ({
  open,
  initialTab,
  daemonUrl,
  sessionId,
  sessionTitle,
  onUseSkillPrompt,
  onRewound,
  onClose,
}) => {
  const [tab, setTab] = useState<"checkpoints" | "extensions">(initialTab);
  const [checkpoints, setCheckpoints] = useState<TurnCheckpointDto[]>([]);
  const [mcps, setMcps] = useState<McpServerEntryDto[]>([]);
  const [skills, setSkills] = useState<SkillEntryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [rewindingId, setRewindingId] = useState<string | null>(null);
  const [confirmCpId, setConfirmCpId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string>("");
  const [extQuery, setExtQuery] = useState("");

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setBanner("");
      setConfirmCpId(null);
    }
  }, [open, initialTab]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [cpRes, extRes] = await Promise.all([
        sessionId
          ? fetch(`${daemonUrl}/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`).catch(
              () => null
            )
          : Promise.resolve(null),
        fetch(`${daemonUrl}/api/extensions`).catch(() => null),
      ]);
      if (cpRes && cpRes.ok) {
        const d = (await cpRes.json()) as { checkpoints?: TurnCheckpointDto[] };
        if (Array.isArray(d.checkpoints)) setCheckpoints(d.checkpoints);
      }
      if (extRes && extRes.ok) {
        const d = (await extRes.json()) as {
          mcp_servers?: McpServerEntryDto[];
          skills?: SkillEntryDto[];
        };
        if (Array.isArray(d.mcp_servers)) setMcps(d.mcp_servers);
        if (Array.isArray(d.skills)) setSkills(d.skills);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadData();
  }, [open, sessionId]);

  if (!open) return null;

  const handleRewind = async (cp: TurnCheckpointDto) => {
    if (!sessionId) return;
    setRewindingId(cp.id);
    setConfirmCpId(null);
    setBanner("");
    try {
      const res = await fetch(
        `${daemonUrl}/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/rewind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkpoint_id: cp.id }),
        }
      );
      const d = (await res.json()) as {
        ok?: boolean;
        error?: string;
        checkpoints?: TurnCheckpointDto[];
      };
      if (res.ok && d.ok) {
        if (Array.isArray(d.checkpoints)) setCheckpoints(d.checkpoints);
        setBanner(`✅ 已将工作区代码回滚到第 ${cp.turn_index} 轮之前（并已自动保留回滚前备份）`);
        onRewound();
      } else {
        setBanner(`⚠️ ${d.error || "回滚失败"}`);
      }
    } catch {
      setBanner("⚠️ 请求守护进程失败");
    } finally {
      setRewindingId(null);
    }
  };

  const q = extQuery.trim().toLowerCase();
  const filteredMcps = mcps.filter(
    (m) =>
      !q ||
      m.name.toLowerCase().includes(q) ||
      m.engine.toLowerCase().includes(q) ||
      m.target.toLowerCase().includes(q)
  );
  const filteredSkills = skills.filter(
    (s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.engine.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
  );

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
          <div className="flex items-center gap-1.5 rounded-xl bg-[var(--v-bg-hover)] p-1">
            <button
              type="button"
              onClick={() => setTab("checkpoints")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                tab === "checkpoints"
                  ? "bg-[var(--v-bg-surface)] text-[var(--v-fg-primary)] shadow-sm"
                  : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <History className="h-3.5 w-3.5" />
              <span>每轮检查点回滚 ({checkpoints.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setTab("extensions")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                tab === "extensions"
                  ? "bg-[var(--v-bg-surface)] text-[var(--v-fg-primary)] shadow-sm"
                  : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
              }`}
            >
              <Blocks className="h-3.5 w-3.5" />
              <span>
                MCP & Skills ({mcps.length + skills.length})
              </span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadData()}
              title="刷新"
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {banner && (
            <div className="mb-3 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/60 px-3.5 py-2 text-[12px] text-[var(--v-fg-primary)]">
              {banner}
            </div>
          )}

          {tab === "checkpoints" ? (
            <div className="space-y-3">
              <div className="text-[12px] text-[var(--v-fg-muted)]">
                当前会话：<span className="font-medium text-[var(--v-fg-primary)]">{sessionTitle}</span> ·
                每轮派发前自动生成轻量 Git 快照（不污染 stash 列表），回滚前也会自动保留一份安全备份。
              </div>

              {loading && checkpoints.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-12 text-[12.5px] text-[var(--v-fg-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>正在加载检查点…</span>
                </div>
              ) : checkpoints.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--v-border-subtle)] py-12 text-center text-[12.5px] text-[var(--v-fg-muted)]">
                  当前会话暂无 Git 检查点（在 Git 仓库里发起新对话轮次后会自动记录）
                </div>
              ) : (
                <div className="space-y-2">
                  {[...checkpoints].reverse().map((cp) => {
                    const isBusy = rewindingId === cp.id;
                    const isConfirm = confirmCpId === cp.id;
                    const timeStr = new Date(cp.created_at).toLocaleString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    });
                    return (
                      <div
                        key={cp.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/70 px-3.5 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-[#a78bfa]/15 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[#a78bfa]">
                              第 {cp.turn_index} 轮前
                            </span>
                            <span className="truncate text-[13px] font-medium text-[var(--v-fg-primary)]">
                              {cp.prompt_preview}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-[var(--v-fg-muted)]">
                            <span>HEAD {cp.head_short}</span>
                            <span>·</span>
                            <span>{cp.had_dirty_changes ? "含未提交改动快照" : "干净基线"}</span>
                            <span>·</span>
                            <span>{timeStr}</span>
                          </div>
                        </div>

                        {!isConfirm ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setConfirmCpId(cp.id)}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                          >
                            {isBusy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                            <span>回滚代码</span>
                          </button>
                        ) : (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleRewind(cp)}
                              className="rounded-lg bg-[#f59e0b] px-2.5 py-1.5 text-[11.5px] font-semibold text-black hover:opacity-90 cursor-pointer"
                            >
                              确认回滚
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmCpId(null)}
                              className="px-1.5 py-1 text-[11px] text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                            >
                              取消
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <input
                type="text"
                value={extQuery}
                onChange={(e) => setExtQuery(e.target.value)}
                placeholder="筛选 MCP 服务器或 Skill 名称 / 描述…"
                className="w-full rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)] px-3.5 py-2 text-[12.5px] text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:border-[var(--v-border-strong)] focus:outline-none"
              />

              {/* MCP Servers */}
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--v-fg-secondary)]">
                  <Plug className="h-3.5 w-3.5 text-[#34d399]" />
                  <span>本机已接入 MCP 服务器 ({filteredMcps.length})</span>
                </div>
                {filteredMcps.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--v-border-subtle)] py-6 text-center text-[12px] text-[var(--v-fg-muted)]">
                    未发现匹配的 MCP 配置
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {filteredMcps.map((m) => {
                      const badge = engineBadgeStyle(m.engine);
                      return (
                        <div
                          key={m.id}
                          className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/70 p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[12.5px] font-semibold text-[var(--v-fg-primary)]">
                              {m.name}
                            </span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>
                              {badge.label}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                            <CheckCircle2
                              className={`h-3 w-3 shrink-0 ${
                                m.enabled ? "text-[#34d399]" : "text-[var(--v-fg-faint)]"
                              }`}
                            />
                            <span className="uppercase">{m.transport}</span>
                            <span>·</span>
                            <span className="truncate">{m.target}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Skills */}
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--v-fg-secondary)]">
                  <Wrench className="h-3.5 w-3.5 text-[#60a5fa]" />
                  <span>本机已安装 Skills ({filteredSkills.length})</span>
                </div>
                {filteredSkills.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--v-border-subtle)] py-6 text-center text-[12px] text-[var(--v-fg-muted)]">
                    未发现匹配的本地 Skill
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredSkills.map((sk) => {
                      const badge = engineBadgeStyle(sk.engine);
                      return (
                        <div
                          key={sk.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/70 px-3.5 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>
                                {badge.label}
                              </span>
                              <span className="truncate font-mono text-[12.5px] font-semibold text-[var(--v-fg-primary)]">
                                {sk.name}
                              </span>
                            </div>
                            {sk.description && (
                              <p className="mt-1 line-clamp-2 text-[11.5px] text-[var(--v-fg-muted)]">
                                {sk.description}
                              </p>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              onUseSkillPrompt(`请使用 \`${sk.name}\` 技能协助完成以下任务：`);
                              onClose();
                            }}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--v-bg-active)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                          >
                            <Sparkles className="h-3 w-3 text-[#60a5fa]" />
                            <span>调用</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
