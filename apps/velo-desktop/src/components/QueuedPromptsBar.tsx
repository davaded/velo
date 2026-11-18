import React from "react";
import { ListOrdered, X } from "lucide-react";
import { QueuedPromptDto } from "../mockData";

interface QueuedPromptsBarProps {
  items: QueuedPromptDto[];
  onRemove: (queueId: string) => void;
}

export const QueuedPromptsBar: React.FC<QueuedPromptsBarProps> = ({ items, onRemove }) => {
  if (!items || items.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-xl border border-[#a78bfa]/25 bg-[#a78bfa]/8 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#a78bfa]">
        <ListOrdered className="h-3.5 w-3.5" />
        <span>队列待发 ({items.length}) · 当前轮结束后自动依次执行</span>
      </div>
      <div className="flex flex-col gap-1">
        {items.map((q, idx) => (
          <div
            key={q.id}
            className="flex items-center justify-between gap-2 rounded-lg bg-[var(--v-bg-surface)]/80 px-2.5 py-1 text-[12px] text-[var(--v-fg-body)]"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                #{idx + 1}
              </span>
              <span className="truncate">{q.input}</span>
            </div>
            <button
              type="button"
              onClick={() => onRemove(q.id)}
              title="取消此条排队消息"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
