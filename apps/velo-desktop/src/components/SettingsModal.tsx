import React, { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  FolderGit2,
  Keyboard,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Sliders,
  Sparkles,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import type { ModelOption } from "../mockData";
import { EngineBrandGlyph } from "./ui/EngineBrandIcon";
import {
  VeloKbd,
  VeloSegmentedControl,
  VeloSwitch,
} from "./ui/VeloMotionPrimitives";

export type SettingsTabKey =
  | "appearance"
  | "providers"
  | "chat"
  | "worktree"
  | "shortcuts";

export interface SettingsRuntimeItem {
  id: string;
  name: string;
  available: boolean;
  version?: string | null;
  binary_path?: string | null;
}

interface SettingsModalProps {
  onClose: () => void;
  // Appearance
  themeMode: "system" | "light" | "dark";
  resolvedTheme: "light" | "dark";
  onChangeThemeMode: (mode: "system" | "light" | "dark") => void;
  tone: "zinc" | "claude" | "paseo";
  onChangeTone: (tone: "zinc" | "claude" | "paseo") => void;
  variant: "a" | "b" | "c";
  onChangeVariant: (v: "a" | "b" | "c") => void;
  reduceMotion: boolean;
  onChangeReduceMotion: (next: boolean) => void;
  // Chat & Composer preferences
  sendKeyMode: "enter" | "cmd_enter";
  onChangeSendKeyMode: (next: "enter" | "cmd_enter") => void;
  autoCollapseSteps: boolean;
  onChangeAutoCollapseSteps: (next: boolean) => void;
  // Providers
  runtimes: SettingsRuntimeItem[];
  modelCatalog: ModelOption[];
  onRefreshProviders: () => void;
  onLaunchCliLogin?: (providerId: string) => void;
  // Worktree Hooks
  activeRepoName: string;
  activeRepoPath: string;
  hookEditCmd: string;
  onChangeHookEditCmd: (v: string) => void;
  onSaveHook: () => void;
  hookSaved: boolean;
}

const NAV_ITEMS: Array<{
  id: SettingsTabKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "appearance", label: "外观与手感", icon: Palette },
  { id: "providers", label: "引擎与模型", icon: Cpu },
  { id: "chat", label: "对话与发送", icon: MessageSquare },
  { id: "worktree", label: "工作区与 Hooks", icon: FolderGit2 },
  { id: "shortcuts", label: "快捷键速查", icon: Keyboard },
];

const SHORTCUT_GROUPS: Array<{
  title: string;
  rows: Array<{ label: string; keys: string[] }>;
}> = [
  {
    title: "导航与视图",
    rows: [
      { label: "全局命令面板（搜会话 / 动作 / 模型）", keys: ["⌘", "K"] },
      { label: "展开或收起左侧工作区栏", keys: ["⌘", "B"] },
      { label: "在当前会话中查找提问", keys: ["⌘", "F"] },
      { label: "打开或关闭设置中心", keys: ["⌘", ","] },
      { label: "关闭当前弹窗 / 浮层 / 抽屉", keys: ["Esc"] },
    ],
  },
  {
    title: "输入、排队与审批",
    rows: [
      { label: "发送消息（或运行中加入待发队列）", keys: ["↵"] },
      { label: "换行（不发送）", keys: ["⇧", "↵"] },
      { label: "运行中立即插队打断执行 (Steer)", keys: ["⌘", "↵"] },
      { label: "输入框调用本地 Skills / 命令", keys: ["/"] },
      { label: "输入框引用工作区文件", keys: ["@"] },
      { label: "权限审批：允许一次 / 本会话总是允许 / 拒绝", keys: ["↵", "A", "Esc"] },
    ],
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  onClose,
  themeMode,
  resolvedTheme,
  onChangeThemeMode,
  tone,
  onChangeTone,
  variant,
  onChangeVariant,
  reduceMotion,
  onChangeReduceMotion,
  sendKeyMode,
  onChangeSendKeyMode,
  autoCollapseSteps,
  onChangeAutoCollapseSteps,
  runtimes,
  modelCatalog,
  onRefreshProviders,
  onLaunchCliLogin,
  activeRepoName,
  hookEditCmd,
  onChangeHookEditCmd,
  onSaveHook,
  hookSaved,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTabKey>("appearance");
  const [expandedRuntimeId, setExpandedRuntimeId] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const handleRescan = () => {
    setRescanning(true);
    onRefreshProviders();
    window.setTimeout(() => setRescanning(false), 650);
  };

  return (
    <div
      onClick={onClose}
      className="v-modal-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="v-glass-modal v-modal-in flex h-[540px] max-h-[84vh] w-full max-w-[780px] overflow-hidden rounded-2xl"
      >
        {/* Left Master Navigation Rail */}
        <aside className="flex w-[196px] shrink-0 flex-col border-r border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/65 p-3">
          <div className="mb-3 flex items-center gap-2 px-2 pt-0.5">
            <Sliders className="h-3.5 w-3.5 text-[var(--accent-bright)]" />
            <span className="text-[13px] font-semibold text-[var(--v-fg-primary)]">
              Settings
            </span>
          </div>

          <nav className="flex-1 space-y-0.5">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`v-press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium cursor-pointer ${
                    active
                      ? "bg-[var(--v-bg-active)] text-[var(--v-fg-primary)] shadow-2xs"
                      : "text-[var(--v-fg-secondary)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)]"
                  }`}
                >
                  <Icon
                    className={`h-3.5 w-3.5 shrink-0 ${
                      active ? "text-[var(--accent-bright)]" : "text-[var(--v-fg-muted)]"
                    }`}
                  />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="mt-2 flex items-center justify-between border-t border-[var(--v-border-subtle)] px-2 pt-2.5 text-[10.5px] text-[var(--v-fg-faint)]">
            <span>Velo Desktop</span>
            <VeloKbd>⌘,</VeloKbd>
          </div>
        </aside>

        {/* Right Detail Panel */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top Bar */}
          <div className="flex h-[48px] shrink-0 items-center justify-between border-b border-[var(--v-border-subtle)] px-5">
            <div className="text-[13.5px] font-semibold text-[var(--v-fg-primary)]">
              {NAV_ITEMS.find((n) => n.id === activeTab)?.label}
            </div>
            <button
              type="button"
              onClick={onClose}
              title="关闭 (Esc)"
              className="v-press flex h-7 w-7 items-center justify-center rounded-lg text-[var(--v-fg-muted)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeTab === "appearance" && (
              <div className="space-y-5">
                {/* Theme Mode */}
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[12.5px] font-medium text-[var(--v-fg-primary)]">
                        主题模式
                      </div>
                      <div className="text-[11px] text-[var(--v-fg-muted)]">
                        当前生效：{resolvedTheme === "dark" ? "深色 (Dark)" : "浅色 (Light)"}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        {
                          id: "system",
                          label: "跟随系统",
                          sub: "Auto",
                          icon: Monitor,
                          previewBg: "linear-gradient(135deg, #16161a 50%, #f3f4f6 50%)",
                        },
                        {
                          id: "light",
                          label: "浅色模式",
                          sub: "Light",
                          icon: Sun,
                          previewBg: "#f7f7f9",
                        },
                        {
                          id: "dark",
                          label: "深色模式",
                          sub: "Dark",
                          icon: Moon,
                          previewBg: "#111113",
                        },
                      ] as const
                    ).map(({ id, label, sub, icon: Icon, previewBg }) => {
                      const active = themeMode === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => onChangeThemeMode(id)}
                          className={`v-press flex flex-col items-start gap-2 rounded-xl border p-2.5 text-left cursor-pointer ${
                            active
                              ? "border-[var(--accent)] bg-[var(--v-bg-active)]/70"
                              : "border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/50 hover:border-[var(--v-border-strong)]"
                          }`}
                        >
                          <div
                            className="h-8 w-full rounded-lg border border-[var(--v-border-strong)]"
                            style={{ background: previewBg }}
                          />
                          <div className="flex w-full items-center justify-between">
                            <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--v-fg-primary)]">
                              <Icon className="h-3.5 w-3.5 text-[var(--v-fg-muted)]" />
                              {label}
                            </span>
                            <span className="font-mono text-[10px] text-[var(--v-fg-faint)]">
                              {sub}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Color Tone */}
                <section className="space-y-2 border-t border-[var(--v-border-subtle)] pt-4">
                  <div className="text-[12.5px] font-medium text-[var(--v-fg-primary)]">
                    色彩基调
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        {
                          id: "zinc",
                          label: "Carbon Zinc",
                          desc: "冷峻中性黑灰",
                          swatches: ["#0c0c0e", "#16161a", "#a78bfa"],
                        },
                        {
                          id: "claude",
                          label: "Claude Warm",
                          desc: "温润纸感暖灰",
                          swatches: ["#12110e", "#26231e", "#e08759"],
                        },
                        {
                          id: "paseo",
                          label: "Forest",
                          desc: "沉静冷杉深绿",
                          swatches: ["#0b0e0d", "#1c2522", "#34d399"],
                        },
                      ] as const
                    ).map((t) => {
                      const active = tone === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => onChangeTone(t.id)}
                          className={`v-press flex flex-col gap-1.5 rounded-xl border p-2.5 text-left cursor-pointer ${
                            active
                              ? "border-[var(--accent)] bg-[var(--v-bg-active)]/70"
                              : "border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/50 hover:border-[var(--v-border-strong)]"
                          }`}
                        >
                          <div className="flex items-center gap-1">
                            {t.swatches.map((hex) => (
                              <span
                                key={hex}
                                className="h-3 w-3 rounded-full border border-white/15"
                                style={{ backgroundColor: hex }}
                              />
                            ))}
                          </div>
                          <div className="text-[12px] font-medium text-[var(--v-fg-primary)]">
                            {t.label}
                          </div>
                          <div className="text-[10.5px] text-[var(--v-fg-muted)]">
                            {t.desc}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Real Working Surface Material */}
                <section className="space-y-2 border-t border-[var(--v-border-subtle)] pt-4">
                  <div>
                    <div className="text-[12.5px] font-medium text-[var(--v-fg-primary)]">
                      表面材质
                    </div>
                    <div className="text-[11px] text-[var(--v-fg-muted)]">
                      实时切换浮层、输入框与弹窗的玻璃与质感层次（对话滚动区始终保持纯哑光 60fps）
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        {
                          id: "a",
                          label: "Sharp Matte",
                          desc: "极致锐利哑光（偏 Linear）",
                        },
                        {
                          id: "b",
                          label: "Frosted Glass",
                          desc: "毛玻璃高光浮层（推荐）",
                        },
                        {
                          id: "c",
                          label: "Tactile Elevated",
                          desc: "微立体内高光阴影",
                        },
                      ] as const
                    ).map((m) => {
                      const active = variant === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => onChangeVariant(m.id)}
                          className={`v-press flex flex-col gap-1 rounded-xl border p-2.5 text-left cursor-pointer ${
                            active
                              ? "border-[var(--accent)] bg-[var(--v-bg-active)]/70"
                              : "border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/50 hover:border-[var(--v-border-strong)]"
                          }`}
                        >
                          <div className="flex items-center justify-between text-[12px] font-medium text-[var(--v-fg-primary)]">
                            <span>{m.label}</span>
                            {active && <Check className="h-3.5 w-3.5 text-[#34d399]" />}
                          </div>
                          <div className="text-[10.5px] text-[var(--v-fg-muted)]">
                            {m.desc}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Reduce Motion */}
                <section className="flex items-center justify-between gap-4 border-t border-[var(--v-border-subtle)] pt-4">
                  <div>
                    <div className="text-[12.5px] font-medium text-[var(--v-fg-primary)]">
                      减弱动态效果 (Reduce Motion)
                    </div>
                    <div className="text-[11px] text-[var(--v-fg-muted)]">
                      关闭流光边框、弹性过渡与数字滚动，适合极速零动效偏好
                    </div>
                  </div>
                  <VeloSwitch
                    checked={reduceMotion}
                    onChange={onChangeReduceMotion}
                    label="减弱动态效果"
                  />
                </section>
              </div>
            )}

            {activeTab === "providers" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-[11.5px] text-[var(--v-fg-muted)]">
                    已检测本机 CLI 与 ACP 引擎，共解锁{" "}
                    <span className="font-mono font-medium text-[var(--v-fg-primary)] tabular-nums">
                      {modelCatalog.length}
                    </span>{" "}
                    个模型
                  </div>
                  <button
                    type="button"
                    onClick={handleRescan}
                    className="v-press inline-flex items-center gap-1.5 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-sidebar)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--v-fg-body)] hover:bg-[var(--v-bg-hover)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${rescanning ? "animate-spin" : ""}`}
                    />
                    <span>重新扫描</span>
                  </button>
                </div>

                <div className="space-y-2">
                  {runtimes.map((rt) => {
                    const unlocked = modelCatalog.filter((m) => m.runtimeId === rt.id);
                    const isExpanded = expandedRuntimeId === rt.id;
                    return (
                      <div
                        key={rt.id}
                        className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/65 px-3.5 py-2.5 transition-colors hover:border-[var(--v-border-strong)]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <EngineBrandGlyph
                              engine={rt.id}
                              size={15}
                              colored={rt.available}
                              className={rt.available ? "shrink-0" : "shrink-0 opacity-40"}
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[12.5px] font-medium text-[var(--v-fg-primary)]">
                                  {rt.name}
                                </span>
                                <span
                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] ${
                                    rt.available
                                      ? "bg-[#34d399]/14 text-[#34d399]"
                                      : "bg-[var(--v-bg-active)] text-[var(--v-fg-muted)]"
                                  }`}
                                >
                                  <span
                                    className="h-1.5 w-1.5 rounded-full"
                                    style={{
                                      backgroundColor: rt.available ? "#34d399" : "#71717a",
                                    }}
                                  />
                                  {rt.available ? "Connected" : "Not installed"}
                                </span>
                              </div>
                              <div className="mt-0.5 truncate font-mono text-[10.5px] text-[var(--v-fg-muted)]">
                                {rt.version || "未在 PATH 中检测到可执行文件"}
                                {rt.binary_path ? ` · ${rt.binary_path}` : ""}
                              </div>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            {onLaunchCliLogin && rt.id !== "acp" && (
                              <button
                                type="button"
                                onClick={() => onLaunchCliLogin(rt.id)}
                                title="在 Mac 终端启动登录命令"
                                className="v-press inline-flex items-center gap-1 rounded-lg border border-[var(--v-border-subtle)] bg-[var(--v-bg-surface)] px-2 py-1 text-[10.5px] text-[var(--v-fg-secondary)] hover:border-[var(--v-border-strong)] hover:text-[var(--v-fg-primary)] cursor-pointer"
                              >
                                <Terminal className="h-3 w-3" />
                                <span>登录</span>
                              </button>
                            )}
                            {unlocked.length > 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedRuntimeId(isExpanded ? null : rt.id)
                                }
                                className="v-press inline-flex items-center gap-1 rounded-lg bg-[var(--v-bg-active)] px-2 py-1 font-mono text-[10.5px] text-[var(--v-fg-secondary)] hover:text-[var(--v-fg-primary)] cursor-pointer tabular-nums"
                              >
                                <span>{unlocked.length} 模型</span>
                                {isExpanded ? (
                                  <ChevronDown className="h-3 w-3" />
                                ) : (
                                  <ChevronRight className="h-3 w-3" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>

                        {isExpanded && unlocked.length > 0 && (
                          <div className="velo-phase-morph mt-2.5 flex flex-wrap gap-1 border-t border-[var(--v-border-subtle)] pt-2">
                            {unlocked.slice(0, 36).map((m) => (
                              <span
                                key={m.id}
                                className="rounded-md bg-[var(--v-bg-surface)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--v-fg-secondary)]"
                              >
                                {m.label}
                              </span>
                            ))}
                            {unlocked.length > 36 && (
                              <span className="px-1.5 py-0.5 text-[10.5px] text-[var(--v-fg-muted)]">
                                +{unlocked.length - 36} 更多
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === "chat" && (
              <div className="space-y-4">
                <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/55 divide-y divide-[var(--v-border-subtle)]">
                  <div className="flex items-center justify-between gap-4 p-3.5">
                    <div>
                      <div className="text-[12.5px] font-medium text-[var(--v-fg-primary)]">
                        发送消息快捷键
                      </div>
                      <div className="text-[11px] text-[var(--v-fg-muted)]">
                        {sendKeyMode === "enter"
                          ? "按 Enter 直接发送，Shift+Enter 换行"
                          : "按 ⌘Enter 发送，Enter 直接换行（适合多行长指令）"}
                      </div>
                    </div>
                    <VeloSegmentedControl
                      size="sm"
                      value={sendKeyMode}
                      onChange={onChangeSendKeyMode}
                      options={[
                        { id: "enter", label: "Enter" },
                        { id: "cmd_enter", label: "⌘Enter" },
                      ]}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4 p-3.5">
                    <div>
                      <div className="text-[12.5px] font-medium text-[var(--v-fg-primary)]">
                        完成后自动折叠执行轨迹
                      </div>
                      <div className="text-[11px] text-[var(--v-fg-muted)]">
                        回复结束后将思考与工具足迹自动收拢为单行摘要，保持阅读清爽
                      </div>
                    </div>
                    <VeloSwitch
                      checked={autoCollapseSteps}
                      onChange={onChangeAutoCollapseSteps}
                      label="完成后自动折叠执行轨迹"
                    />
                  </div>
                </div>

                <div className="flex items-start gap-2.5 rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/40 p-3.5 text-[11.5px] text-[var(--v-fg-muted)]">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent-bright)]" />
                  <div>
                    运行期间按 <VeloKbd>↵</VeloKbd> 会自动加入待发队列，按{" "}
                    <VeloKbd>⌘↵</VeloKbd> 可立即打断当前轮并插队执行（Steer）。
                  </div>
                </div>
              </div>
            )}

            {activeTab === "worktree" && (
              <div className="space-y-4">
                <div className="rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/55 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[12.5px] font-medium text-[var(--v-fg-primary)]">
                        Worktree Initialization Hook ({activeRepoName})
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--v-fg-muted)]">
                        新建隔离 Worktree 时自动软链主仓库依赖，并优先执行下方命令或仓库内的{" "}
                        <code className="font-mono">.velo/setup.sh</code> /{" "}
                        <code className="font-mono">.worktreesetup</code>。
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-[#34d399]/14 px-2 py-0.5 font-mono text-[10px] text-[#34d399]">
                      node_modules / .venv auto-symlinked
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      value={hookEditCmd}
                      onChange={(e) => onChangeHookEditCmd(e.target.value)}
                      placeholder="e.g. cp ../../.env.local .env.local && pnpm build:proto"
                      className="flex-1 rounded-lg border border-[var(--v-border-strong)] bg-[var(--v-bg-surface)] px-3 py-2 font-mono text-[11.5px] text-[var(--v-fg-primary)] transition-colors focus:border-[var(--accent)] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={onSaveHook}
                      className="v-press rounded-lg bg-[var(--v-btn-bg)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--v-btn-fg)] hover:opacity-90 cursor-pointer"
                    >
                      {hookSaved ? "Saved ✓" : "Save Hook"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "shortcuts" && (
              <div className="space-y-4">
                {SHORTCUT_GROUPS.map((group) => (
                  <div key={group.title} className="space-y-1.5">
                    <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--v-fg-muted)]">
                      {group.title}
                    </div>
                    <div className="divide-y divide-[var(--v-border-subtle)] rounded-xl border border-[var(--v-border-subtle)] bg-[var(--v-bg-sidebar)]/55">
                      {group.rows.map((row) => (
                        <div
                          key={row.label}
                          className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[12px]"
                        >
                          <span className="text-[var(--v-fg-body)]">{row.label}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            {row.keys.map((k, idx) => (
                              <VeloKbd key={`${row.label}-${idx}`}>{k}</VeloKbd>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
