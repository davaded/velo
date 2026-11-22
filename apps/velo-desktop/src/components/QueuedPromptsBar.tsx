import React, { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Pencil, Trash2, X, Zap } from "lucide-react";
import { QueuedPromptDto } from "../mockData";

interface QueuedPromptsBarProps {
  items: QueuedPromptDto[];
  onRemove: (queueId: string) => void;
  onRunNow: (queueId: string) => void;
  onEditBack?: (item: QueuedPromptDto) => void;
  onReorder?: (queueId: string, direction: "up" | "down") => void;
  onClearAll?: () => void;
}

export const QueuedPromptsBar: React.FC<QueuedPromptsBarProps> = ({
  items,
  onRemove,
  onRunNow,
  onEditBack,
  onReorder,
  onClearAll,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  if (!items || items.length === 0) return null;

  const showCollapseToggle = items.length > 2;
  const visibleItems = collapsed ? items.slice(0, 1) : items;

  return (
    <div className="mx-1.5 -mb-[1px] rounded-t-[14px] border border-b-0 border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/92 px-3 py-2 backdrop-blur-md">
      {/* Compact Header Strip */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => showCollapseToggle && setCollapsed((c) => !c)}
          className={`flex items-center gap-1.5 text-[11px] font-medium text-[var(--v-fg-secondary)] ${
            showCollapseToggle ? "cursor-pointer hover:text-[var(--v-fg-primary)]" : "cursor-default"
          }`}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#fbbf24] animate-pulse" />
          <span>待发队列 · {items.length}</span>
          {showCollapseToggle && (
            <span className="inline-flex items-center text-[var(--v-fg-muted)]">
              {collapsed ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </span>
          )}
        </button>

        {onClearAll && items.length > 1 && (
          <button
            type="button"
            onClick={onClearAll}
            title="清空全部待发队列"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[#f87171] cursor-pointer"
          >
            <Trash2 className="h-2.5 w-2.5" />
            <span>清空</span>
          </button>
        )}
      </div>

      {/* Queue Rows */}
      <div className="mt-1.5 flex flex-col gap-1">
        {visibleItems.map((q, idx) => (
          <div
            key={q.id}
            className="group flex items-center justify-between gap-2 rounded-lg border border-transparent bg-[var(--v-bg-surface)]/85 px-2.5 py-1.5 text-[12px] text-[var(--v-fg-body)] transition-colors hover:border-[var(--v-border-subtle)] hover:bg-[var(--v-bg-surface)]"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2" title={q.input}>
              <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded bg-[var(--v-bg-active)]/80 px-1 font-mono text-[10px] font-semibold text-[var(--v-fg-muted)]">
                {idx + 1}
              </span>
              <span className="truncate leading-snug">{q.input}</span>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              {onReorder && items.length > 1 && !collapsed && (
                <div className="mr-0.5 hidden items-center gap-0.5 group-hover:flex">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => onReorder(q.id, "up")}
                    title="上移优先级"
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] disabled:opacity-25 cursor-pointer"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === items.length - 1}
                    onClick={() => onReorder(q.id, "down")}
                    title="下移优先级"
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] disabled:opacity-25 cursor-pointer"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => onRunNow(q.id)}
                title="打断当前执行，立即插队运行这条"
                className="inline-flex h-6 items-center gap-1 rounded-md border border-[#f59e0b]/30 bg-[#f59e0b]/8 px-2 text-[11px] font-medium text-[#d97706] dark:text-[#fbbf24] transition-colors hover:border-[#f59e0b]/55 hover:bg-[#f59e0b]/18 cursor-pointer"
              >
                <Zap className="h-2.5 w-2.5" />
                <span>插队</span>
              </button>

              {onEditBack && (
                <button
                  type="button"
                  onClick={() => onEditBack(q)}
                  title="撤回到输入框重新编辑"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}

              <button
                type="button"
                onClick={() => onRemove(q.id)}
                title="移除此条排队"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--v-fg-muted)] transition-colors hover:bg-[#f87171]/12 hover:text-[#f87171] cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
        {collapsed && items.length > 1 && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="px-2 py-0.5 text-left text-[10.5px] text-[var(--v-fg-muted)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            还有 {items.length - 1} 条排队指令，点击展开…
          </button>
        )}
      </div>
    </div>
  );
};
