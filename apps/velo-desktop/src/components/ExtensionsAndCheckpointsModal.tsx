import React, { useEffect, useState } from "react";
import {
  Blocks,
  CheckCircle2,
  Eye,
  FileCode2,
  FolderGit2,
  History,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { SLASH_SKILLS } from "../mockData";

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
  scope?: "project" | "global" | string;
  editable?: boolean;
}

/** Composer text after picking a skill: `/Name` plus any task already typed. */
export function composerTextForSkill(current: string, name: string): string {
  const trimmed = current.trim();
  const skill = name.trim();
  let task = "";
  if (trimmed.startsWith("/")) {
    const body = trimmed.slice(1);
    const lower = body.toLowerCase();
    const key = skill.toLowerCase();
    if (lower === key) {
      task = "";
    } else if (key && lower.startsWith(`${key} `)) {
      task = body.slice(skill.length).trim();
    } else {
      const space = body.search(/\s/);
      task = space === -1 ? "" : body.slice(space + 1).trim();
    }
  } else {
    task = trimmed;
  }
  return task ? `/${skill} ${task}` : `/${skill} `;
}

/** Longest skill name that prefixes the composer text. Project scope wins on a tie. */
export function matchSkillInvocation(
  text: string,
  skills: Array<Pick<SkillEntryDto, "name" | "path" | "scope">>
): { path: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const lower = body.toLowerCase();
  const ranked = skills
    .filter((sk) => sk.name.trim() && sk.path)
    .sort((a, b) => {
      const byLen = b.name.trim().length - a.name.trim().length;
      if (byLen !== 0) return byLen;
      return (a.scope === "project" ? 0 : 1) - (b.scope === "project" ? 0 : 1);
    });
  for (const sk of ranked) {
    const key = sk.name.trim().toLowerCase();
    if (lower === key || lower.startsWith(`${key} `)) {
      return { path: sk.path };
    }
  }
  return null;
}

interface Props {
  open: boolean;
  initialTab: "checkpoints" | "extensions";
  daemonUrl: string;
  sessionId: string | null;
  sessionTitle: string;
  workspacePath?: string;
  onUseSkill: (skill: SkillEntryDto) => void;
  onRunSlashCommand?: (cmd: string) => void;
  onSkillsUpdated?: (skills: SkillEntryDto[]) => void;
  onRewound: () => void;
  onClose: () => void;
}

function engineBadgeStyle(eng: string): { label: string; cls: string } {
  switch (eng) {
    case "velo":
      return { label: "Velo 通用", cls: "bg-[#8b5cf6]/18 text-[#a78bfa]" };
    case "antigravity":
      return { label: "Antigravity", cls: "bg-[#60a5fa]/15 text-[#60a5fa]" };
    case "cursor":
      return { label: "Cursor", cls: "bg-[#c084fc]/15 text-[#c084fc]" };
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
  workspacePath,
  onUseSkill,
  onRunSlashCommand,
  onSkillsUpdated,
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
  const [engineFilter, setEngineFilter] = useState<string>("all");

  // Skill Preview & Custom Skill Editor State
  const [previewSkill, setPreviewSkill] = useState<SkillEntryDto | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);

  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>("");
  const [draftDesc, setDraftDesc] = useState<string>("");
  const [draftScope, setDraftScope] = useState<"global" | "project">("global");
  const [draftContent, setDraftContent] = useState<string>("");
  const [savingSkill, setSavingSkill] = useState<boolean>(false);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setBanner("");
      setConfirmCpId(null);
      setPreviewSkill(null);
      setEditorOpen(false);
      setConfirmDeletePath(null);
    }
  }, [open, initialTab]);

  const loadData = async () => {
    setLoading(true);
    try {
      const wsQuery = workspacePath
        ? `?workspace=${encodeURIComponent(workspacePath)}`
        : "";
      const [cpRes, extRes] = await Promise.all([
        sessionId
          ? fetch(`${daemonUrl}/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`).catch(
              () => null
            )
          : Promise.resolve(null),
        fetch(`${daemonUrl}/api/extensions${wsQuery}`).catch(() => null),
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
        if (Array.isArray(d.skills)) {
          setSkills(d.skills);
          onSkillsUpdated?.(d.skills);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadData();
  }, [open, sessionId, workspacePath]);

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

  const handleOpenPreview = async (sk: SkillEntryDto) => {
    setPreviewSkill(sk);
    setPreviewContent("");
    setPreviewLoading(true);
    setEditorOpen(false);
    try {
      const res = await fetch(
        `${daemonUrl}/api/extensions/skill-content?path=${encodeURIComponent(sk.path)}`
      );
      const d = (await res.json()) as { ok?: boolean; content?: string; error?: string };
      if (res.ok && d.ok && typeof d.content === "string") {
        setPreviewContent(d.content);
      } else {
        setPreviewContent(`⚠️ 无法读取文件：${d.error || "未知错误"}`);
      }
    } catch {
      setPreviewContent("⚠️ 请求守护进程失败");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleOpenCreateEditor = () => {
    setPreviewSkill(null);
    setEditingPath(null);
    setDraftName("");
    setDraftDesc("");
    setDraftScope(workspacePath ? "project" : "global");
    setDraftContent("# 目标与规范\n\n1. 先阅读相关文件确认上下文。\n2. 遵循项目现有代码风格并补充必要测试。\n");
    setEditorOpen(true);
    setBanner("");
  };

  const handleOpenEditSkill = async (sk: SkillEntryDto) => {
    setPreviewSkill(null);
    setEditingPath(sk.path);
    setDraftName(sk.name);
    setDraftDesc(sk.description);
    setDraftScope(sk.scope === "project" ? "project" : "global");
    setDraftContent("加载中…");
    setEditorOpen(true);
    try {
      const res = await fetch(
        `${daemonUrl}/api/extensions/skill-content?path=${encodeURIComponent(sk.path)}`
      );
      const d = (await res.json()) as { ok?: boolean; content?: string };
      if (res.ok && d.ok && typeof d.content === "string") {
        setDraftContent(d.content);
      }
    } catch {
      // ignore
    }
  };

  const handleSaveSkill = async () => {
    if (!draftName.trim() || !draftContent.trim()) {
      setBanner("⚠️ 请填写 Skill 名称与规范正文");
      return;
    }
    setSavingSkill(true);
    setBanner("");
    try {
      const res = await fetch(`${daemonUrl}/api/extensions/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draftName.trim(),
          description: draftDesc.trim(),
          content: draftContent,
          scope: draftScope,
          workspace: workspacePath || null,
          existing_path: editingPath,
        }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        error?: string;
        skills?: SkillEntryDto[];
        mcp_servers?: McpServerEntryDto[];
      };
      if (res.ok && d.ok) {
        if (Array.isArray(d.skills)) {
          setSkills(d.skills);
          onSkillsUpdated?.(d.skills);
        }
        if (Array.isArray(d.mcp_servers)) setMcps(d.mcp_servers);
        setEditorOpen(false);
        setEditingPath(null);
        setBanner(
          editingPath
            ? `✅ 已更新自定义 Skill「${draftName.trim()}」`
            : `✅ 已创建跨引擎 Skill「${draftName.trim()}」（可在全部引擎通过 / 搜索调用）`
        );
      } else {
        setBanner(`⚠️ ${d.error || "保存失败"}`);
      }
    } catch {
      setBanner("⚠️ 保存 Skill 请求失败");
    } finally {
      setSavingSkill(false);
    }
  };

  const handleDeleteSkill = async (sk: SkillEntryDto) => {
    setConfirmDeletePath(null);
    setBanner("");
    try {
      const res = await fetch(`${daemonUrl}/api/extensions/skills`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: sk.path,
          workspace: workspacePath || null,
        }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        error?: string;
        skills?: SkillEntryDto[];
      };
      if (res.ok && d.ok) {
        if (Array.isArray(d.skills)) {
          setSkills(d.skills);
          onSkillsUpdated?.(d.skills);
        }
        if (previewSkill?.path === sk.path) setPreviewSkill(null);
        setBanner(`✅ 已删除自定义 Skill「${sk.name}」`);
      } else {
        setBanner(`⚠️ ${d.error || "删除失败"}`);
      }
    } catch {
      setBanner("⚠️ 删除请求失败");
    }
  };

  const q = extQuery.trim().toLowerCase();
  const filteredMcps = mcps.filter((m) => {
    if (engineFilter !== "all" && engineFilter !== "project" && m.engine !== engineFilter) {
      return false;
    }
    return (
      !q ||
      m.name.toLowerCase().includes(q) ||
      m.engine.toLowerCase().includes(q) ||
      m.target.toLowerCase().includes(q)
    );
  });
  const filteredSkills = skills.filter((s) => {
    if (engineFilter === "project" && s.scope !== "project") return false;
    if (engineFilter !== "all" && engineFilter !== "project" && s.engine !== engineFilter) {
      return false;
    }
    return (
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.engine.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.path.toLowerCase().includes(q)
    );
  });

  const projectSkillCount = skills.filter((s) => s.scope === "project").length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-[740px] flex-col overflow-hidden rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] shadow-2xl"
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
                Skills &amp; MCP ({skills.length} / {mcps.length})
              </span>
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            {tab === "extensions" && (
              <button
                type="button"
                onClick={handleOpenCreateEditor}
                className="flex items-center gap-1 rounded-lg bg-[#8b5cf6] px-2.5 py-1.5 text-[11.5px] font-semibold text-white hover:opacity-90 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>新建 Skill</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void loadData()}
              disabled={loading}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
              title="刷新"
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

        {banner && (
          <div className="border-b border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/70 px-5 py-2 text-[12px] text-[var(--v-fg-primary)]">
            {banner}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "checkpoints" ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)]/40 px-3.5 py-2.5 text-[11.5px] text-[var(--v-fg-secondary)]">
                当前会话：<span className="font-medium text-[var(--v-fg-primary)]">{sessionTitle}</span>
                。Velo 会在每轮执行前自动用 <code className="font-mono">git stash create</code>{" "}
                留下无侵入快照（不污染 <code className="font-mono">git stash list</code>），回滚前也会自动保留一份当前状态备份。
              </div>

              {loading && checkpoints.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-12 text-[12.5px] text-[var(--v-fg-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>正在读取检查点…</span>
                </div>
              ) : checkpoints.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--v-border-strong)] py-12 text-center">
                  <History className="mx-auto mb-2 h-7 w-7 text-[var(--v-fg-faint)]" />
                  <div className="text-[13px] font-medium text-[var(--v-fg-secondary)]">
                    当前会话暂无 Git 检查点
                  </div>
                  <div className="mt-1 text-[11.5px] text-[var(--v-fg-muted)]">
                    在 Git 仓库中发送新指令后，系统会自动在每轮执行前记录一个可回滚节点
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {[...checkpoints].reverse().map((cp) => {
                    const isConfirming = confirmCpId === cp.id;
                    const isBusy = rewindingId === cp.id;
                    return (
                      <div
                        key={cp.id}
                        className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/70 px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="rounded-md bg-[#8b5cf6]/15 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-[#a78bfa]">
                                Turn #{cp.turn_index}
                              </span>
                              <span className="truncate text-[13px] font-medium text-[var(--v-fg-primary)]">
                                {cp.prompt_preview}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-[var(--v-fg-muted)]">
                              <span>HEAD {cp.head_short}</span>
                              <span>·</span>
                              <span className={cp.had_dirty_changes ? "text-[#fbbf24]" : "text-[#34d399]"}>
                                {cp.had_dirty_changes ? "含未提交变更快照" : "干净工作区"}
                              </span>
                              <span>·</span>
                              <span>{new Date(cp.created_at).toLocaleString()}</span>
                            </div>
                          </div>

                          {isConfirming ? (
                            <div className="flex shrink-0 items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setConfirmCpId(null)}
                                className="rounded-lg px-2.5 py-1 text-[11.5px] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRewind(cp)}
                                className="rounded-lg bg-[#f87171] px-2.5 py-1 text-[11.5px] font-semibold text-white hover:opacity-90 cursor-pointer"
                              >
                                确认回滚
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={Boolean(rewindingId)}
                              onClick={() => setConfirmCpId(cp.id)}
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] disabled:opacity-50 cursor-pointer"
                            >
                              {isBusy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                              <span>回滚到此轮前</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Create / Edit Custom Skill Inline Form */}
              {editorOpen && (
                <div className="rounded-xl border border-[#8b5cf6]/40 bg-[#8b5cf6]/6 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--v-fg-primary)]">
                      <FileCode2 className="h-4 w-4 text-[#a78bfa]" />
                      <span>{editingPath ? "编辑自定义 Skill" : "新建跨引擎自定义 Skill"}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditorOpen(false)}
                      className="text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] text-[var(--v-fg-muted)]">
                        Skill 名称（支持中英文）
                      </label>
                      <input
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        placeholder="如 react-perf-audit 或 接口联调规范"
                        className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3 py-1.5 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                      />
                    </div>
                    {!editingPath && (
                      <div>
                        <label className="mb-1 block text-[11px] text-[var(--v-fg-muted)]">
                          保存作用域
                        </label>
                        <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--v-bg-sidebar)] p-0.5 text-[11.5px]">
                          <button
                            type="button"
                            onClick={() => setDraftScope("global")}
                            className={`rounded-md py-1 font-medium cursor-pointer ${
                              draftScope === "global"
                                ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                                : "text-[var(--v-fg-muted)]"
                            }`}
                          >
                            全局 (~/.velo/skills)
                          </button>
                          <button
                            type="button"
                            disabled={!workspacePath}
                            onClick={() => setDraftScope("project")}
                            className={`rounded-md py-1 font-medium cursor-pointer disabled:opacity-40 ${
                              draftScope === "project"
                                ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                                : "text-[var(--v-fg-muted)]"
                            }`}
                          >
                            当前项目 (.velo/skills)
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] text-[var(--v-fg-muted)]">
                      一句话简介（用于 / 搜索与列表展示）
                    </label>
                    <input
                      value={draftDesc}
                      onChange={(e) => setDraftDesc(e.target.value)}
                      placeholder="例如：代码提交前检查性能瓶颈、类型安全与边界错误"
                      className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3 py-1.5 text-[12px] text-[var(--v-fg-primary)] focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] text-[var(--v-fg-muted)]">
                      SKILL.md 规范与执行步骤（Markdown）
                    </label>
                    <textarea
                      rows={7}
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--v-fg-primary)] focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[var(--v-fg-muted)]">
                      保存为标准 SKILL.md，Claude / Codex / AGY / Cursor / Grok 全引擎通用。
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditorOpen(false)}
                        className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={savingSkill || !draftName.trim() || !draftContent.trim()}
                        onClick={() => void handleSaveSkill()}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#8b5cf6] px-3.5 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-45 cursor-pointer"
                      >
                        {savingSkill && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        <span>{editingPath ? "保存修改" : "创建 Skill"}</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* SKILL.md Markdown Source Preview Panel */}
              {previewSkill && (
                <div className="rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-canvas)] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-[13px] font-semibold text-[var(--v-fg-primary)]">
                          {previewSkill.name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            engineBadgeStyle(previewSkill.engine).cls
                          }`}
                        >
                          {engineBadgeStyle(previewSkill.engine).label}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                        {previewSkill.path}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          onUseSkill(previewSkill);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 rounded-lg bg-[#8b5cf6] px-2.5 py-1 text-[11.5px] font-semibold text-white hover:opacity-90 cursor-pointer"
                      >
                        <Sparkles className="h-3 w-3" />
                        <span>跨引擎调用</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewSkill(null)}
                        className="rounded-lg p-1 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="max-h-[240px] overflow-auto rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--v-fg-body)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {previewLoading ? "正在读取 SKILL.md…" : previewContent}
                  </div>
                </div>
              )}

              {/* Search & Engine Filter Row */}
              <div className="space-y-2">
                <input
                  value={extQuery}
                  onChange={(e) => setExtQuery(e.target.value)}
                  placeholder="搜索本机 Skills（全局 + 当前项目）或 MCP 服务器…"
                  className="w-full rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-3.5 py-2 text-[12.5px] text-[var(--v-fg-primary)] focus:outline-none"
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  {[
                    { id: "all", label: `全部 (${skills.length})` },
                    ...(projectSkillCount > 0
                      ? [{ id: "project", label: `当前项目 (${projectSkillCount})` }]
                      : []),
                    { id: "velo", label: "Velo 通用" },
                    { id: "antigravity", label: "Antigravity" },
                    { id: "codex", label: "Codex" },
                    { id: "claude", label: "Claude" },
                    { id: "cursor", label: "Cursor" },
                  ].map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setEngineFilter(f.id)}
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                        engineFilter === f.id
                          ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] ring-1 ring-[var(--v-border-strong)]"
                          : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Skills Section (First & Prominent!) */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--v-fg-secondary)]">
                    <Wrench className="h-3.5 w-3.5 text-[#60a5fa]" />
                    <span>跨引擎可用 Skills ({filteredSkills.length})</span>
                  </div>
                  <span className="text-[11px] text-[var(--v-fg-muted)]">
                    调用后在输入框写任务，发送时附上技能全文
                  </span>
                </div>
                {filteredSkills.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--v-border-subtle)] py-6 text-center text-[12px] text-[var(--v-fg-muted)]">
                    未发现匹配的本地 Skill，可点击右上角「新建 Skill」创建
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredSkills.map((sk) => {
                      const badge = engineBadgeStyle(sk.engine);
                      const isDeleting = confirmDeletePath === sk.path;
                      return (
                        <div
                          key={sk.id}
                          className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/70 px-3.5 py-2.5"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {sk.scope === "project" && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#34d399]/18 px-2 py-0.5 text-[10px] font-semibold text-[#34d399]">
                                  <FolderGit2 className="h-2.5 w-2.5" />
                                  项目
                                </span>
                              )}
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}
                              >
                                {badge.label}
                              </span>
                              <span className="min-w-0 font-mono text-[12.5px] font-semibold text-[var(--v-fg-primary)]">
                                {sk.name}
                              </span>
                            </div>
                            {sk.description && (
                              <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--v-fg-muted)]">
                                {sk.description}
                              </p>
                            )}
                          </div>

                          <div className="mt-2 flex items-center gap-1 border-t border-[var(--v-border-subtle)] pt-2">
                            <button
                              type="button"
                              onClick={() => void handleOpenPreview(sk)}
                              title="查看 SKILL.md 原文"
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                            {sk.editable && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void handleOpenEditSkill(sk)}
                                  title="编辑自定义 Skill"
                                  className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                {isDeleting ? (
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteSkill(sk)}
                                    className="rounded-lg bg-[#f87171] px-2 py-1 text-[11px] font-semibold text-white cursor-pointer"
                                  >
                                    确认删除
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeletePath(sk.path)}
                                    title="删除自定义 Skill"
                                    className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[#f87171] cursor-pointer"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                onUseSkill(sk);
                                onClose();
                              }}
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--v-bg-active)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--v-fg-primary)] hover:bg-[var(--v-bg-hover)] cursor-pointer"
                            >
                              <Sparkles className="h-3 w-3 text-[#60a5fa]" />
                              <span>调用</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* MCP Servers Section */}
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--v-fg-secondary)]">
                  <Plug className="h-3.5 w-3.5 text-[#a78bfa]" />
                  <span>本机已接入 MCP 服务器 ({filteredMcps.length})</span>
                </div>
                {filteredMcps.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--v-border-subtle)] py-5 text-center text-[12px] text-[var(--v-fg-muted)]">
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
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}
                            >
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

              {/* Built-in Slash Commands Quick Reference (Unified from old Skills & Commands modal) */}
              {onRunSlashCommand && !q && engineFilter === "all" && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--v-fg-secondary)]">
                    <Terminal className="h-3.5 w-3.5 text-[#34d399]" />
                    <span>Velo 内置斜杠指令（输入框键入 / 随时呼出）</span>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {SLASH_SKILLS.map((s) => (
                      <button
                        key={s.cmd}
                        type="button"
                        onClick={() => {
                          onClose();
                          onRunSlashCommand(s.cmd);
                        }}
                        className="flex flex-col items-start gap-0.5 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-canvas)]/50 px-3 py-2 text-left hover:bg-[var(--v-bg-hover)] cursor-pointer"
                      >
                        <span className="font-mono text-[12px] font-semibold text-[var(--v-fg-primary)]">
                          {s.cmd}
                        </span>
                        <span className="line-clamp-2 text-[11px] leading-relaxed text-[var(--v-fg-muted)]">
                          {s.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
