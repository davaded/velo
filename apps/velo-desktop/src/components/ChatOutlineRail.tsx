import React, { useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { VeloKbd } from "./ui/VeloMotionPrimitives";

export interface OutlineTurnSummary {
  index: number;
  key: string;
  promptSnippet: string;
}

interface ChatOutlineRailProps {
  turns: OutlineTurnSummary[];
  activeTurnKey?: string | null;
  onJumpToTurn: (turnKey: string) => void;
  findOpen: boolean;
  findQuery: string;
  onChangeFindQuery: (q: string) => void;
  onCloseFind: () => void;
}

export const ChatOutlineRail: React.FC<ChatOutlineRailProps> = ({
  turns,
  activeTurnKey,
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
        <div className="v-glass-popover v-popover-down-in absolute right-6 top-3 z-30 flex items-center gap-1.5 rounded-xl px-3 py-1.5">
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
          {findQuery.trim() ? (
            <span className="font-mono text-[10.5px] text-[var(--v-fg-muted)] tabular-nums">
              {matchingTurns.length > 0 ? `${matchCursor + 1}/${matchingTurns.length}` : "0"}
            </span>
          ) : (
            <VeloKbd>Esc</VeloKbd>
          )}
          <button
            type="button"
            onClick={() => jumpMatch(-1)}
            className="v-press rounded p-0.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => jumpMatch(1)}
            className="v-press rounded p-0.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onCloseFind}
            className="v-press rounded p-0.5 text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
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
            <div className="v-glass-popover v-popover-in mr-2 max-h-[340px] w-[248px] overflow-y-auto rounded-2xl p-1.5">
              <div className="flex items-center justify-between px-2 py-1 text-[10.5px] font-medium text-[var(--v-fg-muted)]">
                <span>对话轮次导航</span>
                <span className="font-mono text-[10px] tabular-nums">{turns.length} 轮</span>
              </div>
              {turns.map((t) => {
                const isActive = activeTurnKey === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => onJumpToTurn(t.key)}
                    className={`v-press flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] cursor-pointer ${
                      isActive
                        ? "bg-[var(--v-bg-active)] font-medium text-[var(--v-fg-primary)]"
                        : "text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                    }`}
                  >
                    <span
                      className={`shrink-0 font-mono text-[10px] tabular-nums ${
                        isActive ? "text-[var(--accent-bright)]" : "text-[var(--v-fg-faint)]"
                      }`}
                    >
                      #{t.index + 1}
                    </span>
                    <span className="truncate">{t.promptSnippet || "Turn"}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex flex-col items-end gap-1.5 py-2 px-1">
            {turns.slice(-24).map((t) => {
              const isActive = activeTurnKey === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => onJumpToTurn(t.key)}
                  title={`#${t.index + 1}: ${t.promptSnippet}`}
                  className={`h-[2.5px] rounded-full transition-all duration-150 cursor-pointer ${
                    isActive
                      ? "w-4 bg-[var(--accent-bright)]"
                      : "w-2.5 bg-[var(--v-fg-faint)] hover:w-4 hover:bg-[var(--accent-bright)]"
                  }`}
                />
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};
