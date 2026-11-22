import React, { useEffect, useMemo, useState } from "react";
import { Folder, GitFork, Search, Sparkles, X } from "lucide-react";
import { AgentKind, EffortLevel, ModelOption } from "../mockData";
import {
  ENGINE_TABS,
  RuntimeAvailability,
  getEngineTabForModel,
  isModelAvailable,
} from "./ModelPickerPopover";

export interface ForkLaunchTarget {
  sourceSessionId: string;
  sourceTitle: string;
  repoRoot: string;
  currentModel: string;
  currentEffort: EffortLevel;
  currentAgentKind: AgentKind;
  upToUserTurn?: number;
  upToUserText?: string;
  userTurnsFromEnd?: number;
}

export interface ForkConfirmPayload {
  title: string;
  provider: AgentKind;
  model: string;
  effort: EffortLevel;
  repoRoot?: string;
  initialPrompt?: string;
}

interface ForkBranchModalProps {
  target: ForkLaunchTarget | null;
  models: ModelOption[];
  runtimes: RuntimeAvailability[];
  onClose: () => void;
  onConfirm: (payload: ForkConfirmPayload) => Promise<void> | void;
}

const EFFORT_OPTIONS: Array<{ id: EffortLevel; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

export const ForkBranchModal: React.FC<ForkBranchModalProps> = ({
  target,
  models,
  runtimes,
  onClose,
  onConfirm,
}) => {
  const [title, setTitle] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<EffortLevel>("medium");
  const [activeEngineTab, setActiveEngineTab] = useState<string>("all");
  const [modelQuery, setModelQuery] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [editingRepo, setEditingRepo] = useState(false);
  const [repoOverride, setRepoOverride] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!target) return;
    const baseName = target.sourceTitle.replace(/^Fork ·\s*/i, "").trim() || "Session";
    setTitle(`Fork · ${baseName}`);
    setSelectedModelId(target.currentModel);
    setSelectedEffort(target.currentEffort || "medium");
    setActiveEngineTab("all");
    setModelQuery("");
    setInitialPrompt("");
    setEditingRepo(false);
    setRepoOverride(target.repoRoot);
    setSubmitting(false);
  }, [target]);

  const selectedModelObj = useMemo(
    () => models.find((m) => m.id === selectedModelId) || null,
    [models, selectedModelId]
  );

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    return models.filter((m) => {
      if (activeEngineTab !== "all" && getEngineTabForModel(m) !== activeEngineTab) {
        return false;
      }
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        (m.family || "").toLowerCase().includes(q)
      );
    });
  }, [models, activeEngineTab, modelQuery]);

  if (!target) return null;

  const isSwitchingModel = selectedModelId !== target.currentModel;
  const resolvedProvider: AgentKind = selectedModelObj?.agentKind || target.currentAgentKind;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm({
        title: title.trim() || `Fork · ${target.sourceTitle}`,
        provider: resolvedProvider,
        model: selectedModelId || target.currentModel,
        effort: selectedEffort,
        repoRoot:
          editingRepo && repoOverride.trim() && repoOverride.trim() !== target.repoRoot
            ? repoOverride.trim()
            : undefined,
        initialPrompt: initialPrompt.trim() || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (
            e.key === "Enter" &&
            !e.shiftKey &&
            (e.metaKey || e.ctrlKey || document.activeElement?.tagName !== "TEXTAREA")
          ) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
        className="flex max-h-[86vh] w-full max-w-[540px] flex-col overflow-hidden rounded-2xl border border-[var(--v-border-strong)] bg-[var(--v-bg-canvas)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--v-border-subtle)] px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#a78bfa]/14 text-[#a78bfa]">
              <GitFork className="h-3.5 w-3.5" />
            </div>
            <div>
              <div className="text-[13.5px] font-semibold text-[var(--v-fg-primary)]">
                Fork 新分支对话
              </div>
              <div className="text-[11px] text-[var(--v-fg-muted)]">
                {target.upToUserTurn
                  ? `从第 #${target.upToUserTurn} 轮分叉 · 保留该轮及之前完整上下文`
                  : "从当前完整会话分叉 · 支持沿用原模型或换模型接管"}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
          {target.upToUserText && (
            <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-3 py-2 text-[11.5px] text-[var(--v-fg-secondary)]">
              <span className="mr-1.5 font-mono text-[10.5px] text-[#a78bfa]">分叉锚点</span>
              <span className="line-clamp-2">{target.upToUserText}</span>
            </div>
          )}

          {/* Branch Title & Workspace Folder Lock */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[var(--v-fg-muted)]">
                分支标题
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Fork · Session"
                className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1.5 text-[12.5px] text-[var(--v-fg-primary)] focus:border-[var(--v-fg-muted)] focus:outline-none"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[11px] font-medium text-[var(--v-fg-muted)]">
                  工作区目录（已锁定原目录）
                </label>
                <button
                  type="button"
                  onClick={() => setEditingRepo((v) => !v)}
                  className="text-[10.5px] text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                >
                  {editingRepo ? "恢复锁定" : "更改"}
                </button>
              </div>
              {editingRepo ? (
                <input
                  value={repoOverride}
                  onChange={(e) => setRepoOverride(e.target.value)}
                  className="w-full rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--v-fg-primary)] focus:outline-none"
                />
              ) : (
                <div
                  title={target.repoRoot}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--v-fg-secondary)]"
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)]" />
                  <span className="truncate">{target.repoRoot.replace(/^\/Users\/[^/]+/, "~")}</span>
                </div>
              )}
            </div>
          </div>

          {/* Target Engine & Model Picker */}
          <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)]/70 p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--v-fg-primary)]">
                <Sparkles className="h-3.5 w-3.5 text-[#a78bfa]" />
                <span>目标模型与引擎</span>
                {isSwitchingModel && (
                  <span className="rounded-full bg-[#a78bfa]/15 px-2 py-0.5 text-[10px] font-medium text-[#a78bfa]">
                    跨模型接管
                  </span>
                )}
              </span>

              {/* Effort pills */}
              <div className="flex items-center gap-0.5 rounded-lg bg-[var(--v-bg-sidebar)] p-0.5">
                {EFFORT_OPTIONS.map((eff) => (
                  <button
                    key={eff.id}
                    type="button"
                    onClick={() => setSelectedEffort(eff.id)}
                    className={`rounded-md px-2 py-0.5 text-[10.5px] font-medium transition-colors cursor-pointer ${
                      selectedEffort === eff.id
                        ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                        : "text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)]"
                    }`}
                  >
                    {eff.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Engine filter tabs + search */}
            <div className="mb-2 flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveEngineTab("all")}
                className={`rounded-md px-2 py-0.5 text-[11px] font-medium cursor-pointer ${
                  activeEngineTab === "all"
                    ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                    : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)]"
                }`}
              >
                全部
              </button>
              {ENGINE_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveEngineTab(tab.key)}
                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium cursor-pointer ${
                    activeEngineTab === tab.key
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)]"
                      : "text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)]"
                  }`}
                >
                  {tab.shortLabel}
                </button>
              ))}
              <div className="relative ml-auto min-w-[120px] flex-1 sm:max-w-[165px]">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--v-fg-muted)]" />
                <input
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder="搜索模型…"
                  className="w-full rounded-md border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)] py-0.5 pl-6 pr-2 text-[11px] text-[var(--v-fg-primary)] focus:border-[var(--v-fg-muted)] focus:outline-none"
                />
              </div>
            </div>

            {/* Model Grid */}
            <div className="grid max-h-[180px] grid-cols-1 gap-1 overflow-y-auto pr-0.5 sm:grid-cols-2">
              {filteredModels.map((m) => {
                const isSelected = m.id === selectedModelId;
                const isCurrentSource = m.id === target.currentModel;
                const avail = isModelAvailable(m, runtimes);
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={!avail}
                    onClick={() => setSelectedModelId(m.id)}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                      isSelected
                        ? "border-[#a78bfa]/70 bg-[#a78bfa]/12 text-[var(--v-fg-primary)]"
                        : "border-transparent bg-[var(--v-bg-sidebar)]/75 text-[var(--v-fg-body)] hover:border-[var(--v-border-subtle)] hover:bg-[var(--v-bg-hover)]"
                    } ${!avail ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium">{m.label}</div>
                      <div className="truncate font-mono text-[10px] text-[var(--v-fg-muted)]">
                        {m.family || m.agentKind}
                      </div>
                    </div>
                    {isCurrentSource && (
                      <span className="shrink-0 rounded bg-[var(--v-bg-active)] px-1.5 py-0.5 text-[9.5px] text-[var(--v-fg-muted)]">
                        原模型
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Optional immediate first instruction */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--v-fg-muted)]">
              首条分支指令（可选，留空则进入新对话后再输入）
            </label>
            <textarea
              rows={2}
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="例如：换一个更轻量的实现方案，继续完成剩余部分…"
              className="w-full resize-none rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1.5 text-[12.5px] text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:border-[var(--v-fg-muted)] focus:outline-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/60 px-4 py-2.5">
          <span className="text-[11px] text-[var(--v-fg-muted)]">
            按 Enter 沿用当前选项秒分叉 · Esc 取消
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--v-btn-bg)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--v-btn-fg)] transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              <GitFork className="h-3.5 w-3.5" />
              <span>
                {submitting
                  ? "分叉中…"
                  : initialPrompt.trim()
                  ? "分叉并立即执行"
                  : isSwitchingModel
                  ? "分叉并切换模型"
                  : "确认分叉"}
              </span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
