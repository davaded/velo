import React, { useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, FolderGit2, Square } from "lucide-react";
import { EngineBrandGlyph } from "./ui/EngineBrandIcon";
import type { MeshInvocationDto } from "../mockData";

interface MeshInvocationCardProps {
  invocation: MeshInvocationDto;
  onJumpToSession?: (sessionId: string) => void;
  onCancel?: (invocationId: string) => void;
}

function folderBasename(p: string): string {
  const clean = (p || "").replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || "workspace";
}

function statusMeta(status: MeshInvocationDto["status"]): {
  label: string;
  dotClass: string;
  badgeClass: string;
  isActive: boolean;
} {
  switch (status) {
    case "pending_approval":
      return {
        label: "待审批",
        dotClass: "bg-amber-400 animate-pulse",
        badgeClass: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        isActive: true,
      };
    case "queued":
      return {
        label: "排队中",
        dotClass: "bg-sky-400",
        badgeClass: "bg-sky-500/15 text-sky-400 border-sky-500/30",
        isActive: true,
      };
    case "running":
      return {
        label: "执行中",
        dotClass: "bg-emerald-400 animate-pulse",
        badgeClass: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        isActive: true,
      };
    case "completed":
      return {
        label: "已完成",
        dotClass: "bg-emerald-400",
        badgeClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
        isActive: false,
      };
    case "timed_out":
      return {
        label: "超时·后台运行中",
        dotClass: "bg-amber-400",
        badgeClass: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        isActive: false,
      };
    case "cancelled":
      return {
        label: "已取消",
        dotClass: "bg-zinc-400",
        badgeClass: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
        isActive: false,
      };
    case "failed":
    default:
      return {
        label: "失败",
        dotClass: "bg-red-400",
        badgeClass: "bg-red-500/15 text-red-400 border-red-500/30",
        isActive: false,
      };
  }
}

export const MeshInvocationCard: React.FC<MeshInvocationCardProps> = ({
  invocation,
  onJumpToSession,
  onCancel,
}) => {
  const [expanded, setExpanded] = useState(false);
  const st = statusMeta(invocation.status);
  const targetFolder = folderBasename(invocation.callee_repo_root);
  const insertions = invocation.diff_stats?.insertions ?? 0;
  const deletions = invocation.diff_stats?.deletions ?? 0;
  const hasDiff = insertions > 0 || deletions > 0;

  return (
    <div className="my-1.5 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] transition-colors">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--v-fg-muted)]" />
          )}
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--v-bg-hover)]">
            <EngineBrandGlyph engine={invocation.callee_provider} size={14} />
          </span>
          <span className="truncate text-[12.5px] font-semibold text-[var(--v-fg-primary)]">
            {invocation.callee_session_name}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--v-bg-hover)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--v-fg-secondary)]">
            <FolderGit2 className="h-2.5 w-2.5 opacity-75" />
            {targetFolder}
          </span>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${st.badgeClass}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${st.dotClass}`} />
            {st.label}
          </span>
          {hasDiff && (
            <span className="shrink-0 font-mono text-[10.5px]">
              <span className="text-emerald-400">+{insertions}</span>{" "}
              <span className="text-red-400">−{deletions}</span>
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {st.isActive && onCancel && (
            <button
              type="button"
              onClick={() => onCancel(invocation.id)}
              title="中止跨会话调用"
              className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10.5px] font-medium text-red-400 hover:bg-red-500/20 cursor-pointer"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              中止
            </button>
          )}
          {invocation.callee_session_id && onJumpToSession && (
            <button
              type="button"
              onClick={() => onJumpToSession(invocation.callee_session_id!)}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--v-border-subtle)] bg-[var(--v-bg-hover)] px-2 py-1 text-[11px] font-medium text-[var(--v-fg-primary)] hover:border-[var(--v-border-strong)] cursor-pointer"
            >
              直达现场
              <ArrowUpRight className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {!expanded && invocation.prompt && (
        <div className="truncate border-t border-[var(--v-border-subtle)]/60 px-3 py-1.5 text-[11.5px] text-[var(--v-fg-muted)]">
          {invocation.kind === "spawn" ? "跨目录新建会话 · " : "协作指令 · "}
          {invocation.prompt}
        </div>
      )}

      {expanded && (
        <div className="space-y-2 border-t border-[var(--v-border-subtle)] px-3 py-2.5 text-[12px]">
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[var(--v-fg-muted)]">
              派发指令 ({invocation.kind === "spawn" ? "新建会话" : "已有会话"}) · 深度 {invocation.depth}
            </div>
            <div className="whitespace-pre-wrap rounded-lg bg-[var(--v-bg-canvas)] px-2.5 py-2 text-[var(--v-fg-body)]">
              {invocation.prompt}
            </div>
          </div>

          {invocation.result_summary && (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-emerald-400">
                返回结果摘要
              </div>
              <div className="max-h-[220px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--v-bg-canvas)] px-2.5 py-2 text-[var(--v-fg-primary)]">
                {invocation.result_summary}
              </div>
            </div>
          )}

          {invocation.error && (
            <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-[11.5px] text-red-400">
              {invocation.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
