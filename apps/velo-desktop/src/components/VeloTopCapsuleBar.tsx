import React, { useState } from "react";
import {
  Command,
  Cpu,
  GitBranch,
  GitCompare,
  LayoutGrid,
  Palette,
  Plus,
  QrCode,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react";
import type { SessionInfo } from "../types";
import { VELO_THEMES, type VeloThemeId } from "../theme";
import { providerDisplayName } from "./PaseoLeftSidebar";

export type VeloStudioMode = "studio" | "fleet" | "diff" | "terminal";

interface VeloTopCapsuleBarProps {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  studioMode: VeloStudioMode;
  onChangeStudioMode: (mode: VeloStudioMode) => void;
  wsConnected: boolean;
  themeId: VeloThemeId;
  onSelectTheme: (id: VeloThemeId) => void;
  onOpenNewWorkspace: () => void;
  onOpenOrchestrator: (tab: "handoff" | "advisor" | "committee" | "loop") => void;
  onOpenPairModal: () => void;
  onOpenCommandPalette: () => void;
}

export const VeloTopCapsuleBar: React.FC<VeloTopCapsuleBarProps> = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  studioMode,
  onChangeStudioMode,
  wsConnected,
  themeId,
  onSelectTheme,
  onOpenNewWorkspace,
  onOpenOrchestrator,
  onOpenPairModal,
  onOpenCommandPalette,
}) => {
  const [showThemePopover, setShowThemePopover] = useState(false);

  return (
    <header className="h-[54px] px-4 rounded-[18px] flex items-center justify-between gap-3 shrink-0 velo-glass-pill relative z-30">
      {/* 1. Left: Velo Prismatic Brand Emblem + Mode Switcher */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center rare-3d-button"
            style={{ color: "#ffffff" }}
          >
            <Zap className="w-4 h-4 fill-current" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[14px] font-bold tracking-tight">VELO</span>
              <span
                className="font-mono-code text-[9.5px] px-1.5 py-0.2 rounded-full uppercase font-semibold"
                style={{
                  backgroundColor: "var(--surface-2)",
                  color: "var(--accent-bright)",
                  border: "1px solid var(--border-accent)",
                }}
              >
                OS 2.0
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono-code" style={{ color: "var(--fg-extra-muted)" }}>
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  backgroundColor: wsConnected ? "var(--status-success)" : "var(--status-danger)",
                }}
              />
              <span>{wsConnected ? "RUST DAEMON LIVE" : "LOCAL SNAPSHOT"}</span>
            </div>
          </div>
        </div>

        <div className="h-5 w-[1px] mx-1" style={{ backgroundColor: "var(--border-subtle)" }} />

        {/* Studio Mode Segmented Pill (Studio Dual-Stage | Fleet Matrix | Diff Lab | PTY) */}
        <div
          className="p-1 rounded-[11px] border flex items-center gap-1"
          style={{
            backgroundColor: "var(--surface-0)",
            borderColor: "var(--border-subtle)",
          }}
        >
          {[
            { id: "studio" as const, label: "Dual Studio", icon: Sparkles },
            { id: "fleet" as const, label: "Fleet Deck", icon: LayoutGrid },
            { id: "diff" as const, label: "Diff Lab", icon: GitCompare },
            { id: "terminal" as const, label: "PTY Matrix", icon: Terminal },
          ].map((m) => {
            const Icon = m.icon;
            const active = studioMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => onChangeStudioMode(m.id)}
                className={`h-[30px] px-3 rounded-[8px] flex items-center gap-1.5 text-[11.5px] font-semibold transition-all cursor-pointer ${
                  active ? "rare-3d-button text-white" : "hover:bg-[var(--surface-2)]"
                }`}
                style={!active ? { color: "var(--fg-muted)" } : undefined}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Center: Live Worktree Capsule Switcher (Replaces Paseo's Left Tree Sidebar!) */}
      <div className="flex items-center gap-2 overflow-x-auto py-1 min-w-0 flex-1 justify-center">
        {sessions.map((s) => {
          const active = s.id === selectedSessionId;
          const isRunning = s.status === "running" || s.status === "starting";
          return (
            <button
              key={s.id}
              onClick={() => onSelectSession(s.id)}
              className={`h-[36px] px-3 rounded-[11px] border flex items-center gap-2.5 transition-all cursor-pointer shrink-0 ${
                active ? "rare-specular-surface" : "hover:bg-[var(--surface-1)]"
              }`}
              style={{
                backgroundColor: active ? "var(--surface-2)" : "var(--surface-0)",
                borderColor: active ? "var(--accent)" : "var(--border-subtle)",
              }}
            >
              {isRunning ? (
                <span className="paseo-status-ring shrink-0" />
              ) : (
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor:
                      s.status === "completed"
                        ? "var(--status-success)"
                        : "var(--status-warning)",
                  }}
                />
              )}

              <div className="text-left">
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: active ? "var(--fg)" : "var(--fg-muted)" }}
                  >
                    {s.name}
                  </span>
                  <span
                    className="font-mono-code text-[9.5px] px-1.5 rounded"
                    style={{
                      backgroundColor: "var(--surface-1)",
                      color: "var(--accent-bright)",
                    }}
                  >
                    {providerDisplayName(s.provider)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 font-mono-code text-[10px]">
                  <GitBranch className="w-2.5 h-2.5" style={{ color: "var(--fg-extra-muted)" }} />
                  <span style={{ color: "var(--fg-extra-muted)" }}>{s.branch}</span>
                  {s.diff_stats && (s.diff_stats.insertions > 0 || s.diff_stats.deletions > 0) && (
                    <span className="flex items-center gap-0.5">
                      <span style={{ color: "var(--status-success)" }}>
                        +{s.diff_stats.insertions}
                      </span>
                      <span style={{ color: "var(--status-danger)" }}>
                        −{s.diff_stats.deletions}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}

        <button
          onClick={onOpenNewWorkspace}
          title="Spawn New Isolated Worktree Agent (⌘N)"
          className="h-[36px] px-3 rounded-[11px] border border-dashed flex items-center gap-1.5 text-[11.5px] font-medium hover:bg-[var(--surface-2)] transition-colors cursor-pointer shrink-0"
          style={{
            borderColor: "var(--border-accent)",
            color: "var(--accent-bright)",
          }}
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Worktree</span>
        </button>
      </div>

      {/* 3. Right: Command Center (⌘K), Multi-Agent Skills, Pair QR & Velo Theme Lab */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onOpenCommandPalette}
          className="h-[32px] px-2.5 rounded-[9px] border flex items-center gap-2 text-[11.5px] cursor-pointer hover:bg-[var(--surface-2)] transition-colors rare-specular-pill"
          style={{
            backgroundColor: "var(--surface-1)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg-muted)",
          }}
        >
          <Command className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />
          <span className="hidden xl:inline">Command</span>
          <kbd className="rare-keycap">⌘K</kbd>
        </button>

        <button
          onClick={() => onOpenOrchestrator("committee")}
          className="h-[32px] px-2.5 rounded-[9px] border flex items-center gap-1.5 text-[11.5px] font-medium cursor-pointer hover:bg-[var(--surface-2)] transition-colors rare-specular-pill"
          style={{
            backgroundColor: "var(--surface-1)",
            borderColor: "var(--border-subtle)",
            color: "var(--accent-bright)",
          }}
          title="Multi-Agent Orchestration (/handoff, /advisor, /committee, /loop)"
        >
          <Cpu className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Orchestrate</span>
        </button>

        <button
          onClick={onOpenPairModal}
          title="Mobile E2EE Relay QR"
          className="w-[32px] h-[32px] rounded-[9px] border flex items-center justify-center cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
          style={{
            backgroundColor: "var(--surface-1)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg-muted)",
          }}
        >
          <QrCode className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => setShowThemePopover((v) => !v)}
          className="h-[32px] px-2.5 rounded-[9px] border flex items-center gap-1.5 text-[11.5px] font-medium cursor-pointer hover:bg-[var(--surface-2)] transition-colors rare-specular-pill"
          style={{
            backgroundColor: "var(--surface-1)",
            borderColor: "var(--border-subtle)",
            color: "var(--fg)",
          }}
        >
          <Palette className="w-3.5 h-3.5" style={{ color: "var(--accent-bright)" }} />
          <span className="hidden md:inline">{VELO_THEMES[themeId].label}</span>
        </button>

        {showThemePopover && (
          <div
            className="absolute top-[60px] right-2 w-[230px] rounded-[14px] border p-2 z-50 rare-specular-surface t-modal-scale"
            style={{
              backgroundColor: "var(--surface-1)",
              borderColor: "var(--border-accent)",
            }}
          >
            <div
              className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--fg-extra-muted)" }}
            >
              Velo Visual Themes
            </div>
            {(Object.keys(VELO_THEMES) as VeloThemeId[]).map((id) => {
              const spec = VELO_THEMES[id];
              const active = id === themeId;
              return (
                <button
                  key={id}
                  onClick={() => {
                    onSelectTheme(id);
                    setShowThemePopover(false);
                  }}
                  className="w-full px-2.5 py-2 rounded-[8px] flex items-center justify-between text-left text-[12px] transition-colors cursor-pointer hover:bg-[var(--surface-2)]"
                  style={{
                    backgroundColor: active ? "var(--surface-2)" : "transparent",
                    color: active ? "var(--fg)" : "var(--fg-muted)",
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-3.5 h-3.5 rounded-full border"
                      style={{
                        backgroundColor: spec.colors.primary,
                        borderColor: spec.colors.primaryBright,
                      }}
                    />
                    <div>
                      <div className="font-medium leading-tight">{spec.label}</div>
                      <div className="text-[10px]" style={{ color: "var(--fg-extra-muted)" }}>
                        {spec.badge}
                      </div>
                    </div>
                  </div>
                  {active && (
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: "var(--accent-bright)" }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </header>
  );
};
