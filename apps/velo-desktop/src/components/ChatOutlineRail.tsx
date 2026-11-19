import React, { useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

export interface OutlineTurnSummary {
  index: number;
  key: string;
  promptSnippet: string;
}

interface ChatOutlineRailProps {
  turns: OutlineTurnSummary[];
  onJumpToTurn: (turnKey: string) => void;
  findOpen: boolean;
  findQuery: string;
  onChangeFindQuery: (q: string) => void;
  onCloseFind: () => void;
}

export const ChatOutlineRail: React.FC<ChatOutlineRailProps> = ({
  turns,
  onJumpToTurn,
  findOpen,
  findQuery,
  onChangeFindQuery,
  onCloseFind,
}) => {
  const [hoveredRail, setHoveredRail] = useState(false);
  const [matchCursor, setMatchCursor] = useState(0);

  const matchingTurns = findQuery.trim()
    ? turns.filter((t) =>
        t.promptSnippet.toLowerCase().includes(findQuery.trim().toLowerCase())
      )
    : [];

  const jumpMatch = (delta: number) => {
    if (matchingTurns.length === 0) return;
    const nextIdx = (matchCursor + delta + matchingTurns.length) % matchingTurns.length;
    setMatchCursor(nextIdx);
    onJumpToTurn(matchingTurns[nextIdx].key);
  };

  return (
    <>
      {/* In-Chat Find Bar (⌘F) */}
      {findOpen && (
        <div className="absolute right-6 top-3 z-30 flex items-center gap-1.5 rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)]/95 px-3 py-1.5 shadow-xl backdrop-blur-md">
          <Search className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
          <input
            autoFocus
            type="text"
            value={findQuery}
            onChange={(e) => {
              setMatchCursor(0);
              onChangeFindQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCloseFind();
              if (e.key === "Enter") jumpMatch(e.shiftKey ? -1 : 1);
            }}
            placeholder="在当前会话中定位提问…"
            className="w-44 bg-transparent text-[12px] text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:outline-none"
          />
          {findQuery.trim() && (
            <span className="font-mono text-[10.5px] text-[var(--v-fg-muted)] tabular-nums">
              {matchingTurns.length > 0 ? `${matchCursor + 1}/${matchingTurns.length}` : "0"}
            </span>
          )}
          <button
            type="button"
            onClick={() => jumpMatch(-1)}
            className="rounded p-0.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => jumpMatch(1)}
            className="rounded p-0.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onCloseFind}
            className="rounded p-0.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Paseo-Style Right-Edge Turn Tick Outline Rail */}
      {turns.length >= 2 && (
        <div
          onMouseEnter={() => setHoveredRail(true)}
          onMouseLeave={() => setHoveredRail(false)}
          className="max-md:hidden absolute right-2 top-1/2 z-20 -translate-y-1/2 flex items-center"
        >
          {hoveredRail && (
            <div className="mr-2 max-h-[340px] w-[240px] overflow-y-auto rounded-xl border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)]/95 p-1.5 shadow-2xl backdrop-blur-md">
              <div className="px-2 py-1 text-[10.5px] font-medium text-[var(--v-fg-muted)]">
                对话轮次导航 ({turns.length})
              </div>
              {turns.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => onJumpToTurn(t.key)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] text-[var(--v-fg-body)] transition-colors hover:bg-[var(--v-bg-active)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                >
                  <span className="shrink-0 font-mono text-[10px] text-[var(--v-fg-faint)]">
                    #{t.index + 1}
                  </span>
                  <span className="truncate">{t.promptSnippet || "Turn"}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col items-end gap-1.5 py-2 px-1">
            {turns.slice(-24).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => onJumpToTurn(t.key)}
                title={`#${t.index + 1}: ${t.promptSnippet}`}
                className="h-[2.5px] w-2.5 rounded-full bg-[var(--v-fg-faint)] transition-all hover:w-4 hover:bg-[#a78bfa] cursor-pointer"
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
};
