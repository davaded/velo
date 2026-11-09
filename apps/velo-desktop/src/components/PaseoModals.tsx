import React, { useState } from "react";
import {
  ArrowRightLeft,
  Bot,
  GitBranch,
  Layers,
  QrCode,
  Repeat,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { AgentProvider, PairingResponse, SessionInfo } from "../types";

interface NewWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    provider: AgentProvider;
    project_path: string;
    branch: string;
    prompt: string;
  }) => Promise<void>;
}

export const PaseoNewWorkspaceModal: React.FC<NewWorkspaceModalProps> = ({
  open,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState("claude-feature-worker");
  const [provider, setProvider] = useState<AgentProvider>("claude_code");
  const [projectPath, setProjectPath] = useState("/Users/daiyudai/code/velo");
  const [branch, setBranch] = useState("feat/paseo-ui");
  const [prompt, setPrompt] = useState(
    "Inspect the workspace architecture and implement the requested module with unit tests."
  );
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        provider,
        project_path: projectPath.trim(),
        branch: branch.trim() || "feat/agent-task",
        prompt: prompt.trim(),
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-[2px] p-4">
      <div
        className="w-full max-w-[480px] rounded-[10px] border shadow-2xl overflow-hidden"
        style={{
          backgroundColor: "var(--surface-1)",
          borderColor: "var(--border-accent)",
        }}
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
            <h3 className="text-[13.5px] font-semibold">New Isolated Workspace Agent</h3>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--surface-2)] cursor-pointer"
            style={{ color: "var(--fg-muted)" }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3.5 text-[12px]">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label style={{ color: "var(--fg-muted)" }}>Session Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-[32px] px-2.5 rounded-[6px] border font-mono-code text-[12px] focus:outline-none"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: "var(--border-accent)",
                  color: "var(--fg)",
                }}
              />
            </div>

            <div className="space-y-1">
              <label style={{ color: "var(--fg-muted)" }}>Agent Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as AgentProvider)}
                className="w-full h-[32px] px-2.5 rounded-[6px] border text-[12px] focus:outline-none"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: "var(--border-accent)",
                  color: "var(--fg)",
                }}
              >
                <option value="claude_code">Claude Code (NDJSON)</option>
                <option value="codex">OpenAI Codex CLI</option>
                <option value="opencode">OpenCode Agent</option>
                <option value="custom_pty">Interactive Shell PTY</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label style={{ color: "var(--fg-muted)" }}>Repository Path</label>
              <input
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                className="w-full h-[32px] px-2.5 rounded-[6px] border font-mono-code text-[11.5px] focus:outline-none"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: "var(--border-accent)",
                  color: "var(--fg)",
                }}
              />
            </div>

            <div className="space-y-1">
              <label className="flex items-center gap-1" style={{ color: "var(--fg-muted)" }}>
                <GitBranch className="w-3 h-3" />
                Worktree Branch
              </label>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="w-full h-[32px] px-2.5 rounded-[6px] border font-mono-code text-[11.5px] focus:outline-none"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: "var(--border-accent)",
                  color: "var(--fg)",
                }}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label style={{ color: "var(--fg-muted)" }}>Initial Task Prompt</label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full p-2.5 rounded-[6px] border text-[12.5px] focus:outline-none resize-none"
              style={{
                backgroundColor: "var(--surface-2)",
                borderColor: "var(--border-accent)",
                color: "var(--fg)",
              }}
            />
          </div>

          <div className="pt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-[30px] px-3 rounded-[6px] border text-[12px] cursor-pointer"
              style={{
                backgroundColor: "var(--surface-2)",
                borderColor: "var(--border-subtle)",
                color: "var(--fg-muted)",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="h-[30px] px-3.5 rounded-[6px] text-[12px] font-medium cursor-pointer"
              style={{
                backgroundColor: "var(--accent)",
                color: "#ffffff",
              }}
            >
              {submitting ? "Spawning Worktree..." : "Launch Workspace Agent"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface OrchestratorModalProps {
  open: boolean;
  initialTab: "handoff" | "advisor" | "committee" | "loop";
  activeSession: SessionInfo | null;
  onClose: () => void;
  onRunHandoff: (targetProvider: AgentProvider, note: string) => Promise<void>;
  onRunAdvisor: (advisorProvider: AgentProvider, question: string) => Promise<void>;
  onRunCommittee: (prompt: string, branchPrefix: string) => Promise<void>;
  onRunLoop: (goal: string, maxIterations: number) => Promise<void>;
}

export const PaseoOrchestratorModal: React.FC<OrchestratorModalProps> = ({
  open,
  initialTab,
  activeSession,
  onClose,
  onRunHandoff,
  onRunAdvisor,
  onRunCommittee,
  onRunLoop,
}) => {
  const [tab, setTab] = useState<"handoff" | "advisor" | "committee" | "loop">(initialTab);
  const [targetProvider, setTargetProvider] = useState<AgentProvider>("codex");
  const [textInput, setTextInput] = useState(
    "Review the current implementation for edge cases, concurrency safety, and test coverage."
  );
  const [branchPrefix, setBranchPrefix] = useState("committee/arch-review");
  const [maxIterations, setMaxIterations] = useState(3);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (tab === "handoff") {
        await onRunHandoff(targetProvider, textInput);
      } else if (tab === "advisor") {
        await onRunAdvisor(targetProvider, textInput);
      } else if (tab === "committee") {
        await onRunCommittee(textInput, branchPrefix);
      } else {
        await onRunLoop(textInput, maxIterations);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-[2px] p-4">
      <div
        className="w-full max-w-[520px] rounded-[10px] border shadow-2xl overflow-hidden"
        style={{
          backgroundColor: "var(--surface-1)",
          borderColor: "var(--border-accent)",
        }}
      >
        {/* Header */}
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
            <h3 className="text-[13.5px] font-semibold">
              Multi-Agent Orchestration (Paseo Skills)
            </h3>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--surface-2)] cursor-pointer"
            style={{ color: "var(--fg-muted)" }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Mode Selector Tabs */}
        <div
          className="px-3 py-2 border-b grid grid-cols-4 gap-1.5"
          style={{
            backgroundColor: "var(--surface-sidebar)",
            borderColor: "var(--border-subtle)",
          }}
        >
          {[
            { id: "handoff" as const, label: "/handoff", icon: ArrowRightLeft },
            { id: "advisor" as const, label: "/advisor", icon: Sparkles },
            { id: "committee" as const, label: "/committee", icon: Layers },
            { id: "loop" as const, label: "/loop", icon: Repeat },
          ].map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className="h-[28px] rounded-[6px] font-mono-code text-[11px] flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                style={{
                  backgroundColor: active ? "var(--surface-2)" : "transparent",
                  color: active ? "var(--accent-bright)" : "var(--fg-muted)",
                  border: active
                    ? "1px solid var(--border-accent)"
                    : "1px solid transparent",
                }}
              >
                <Icon className="w-3 h-3" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <form onSubmit={handleExecute} className="p-4 space-y-3.5 text-[12px]">
          {(tab === "handoff" || tab === "advisor") && (
            <div className="space-y-1">
              <label style={{ color: "var(--fg-muted)" }}>
                Source Session:{" "}
                <span className="font-mono-code" style={{ color: "var(--fg)" }}>
                  {activeSession?.name ?? "None"} ({activeSession?.worktree_branch})
                </span>
              </label>
              <div className="pt-1">
                <label className="block mb-1" style={{ color: "var(--fg-muted)" }}>
                  Target Agent Provider
                </label>
                <select
                  value={targetProvider}
                  onChange={(e) => setTargetProvider(e.target.value as AgentProvider)}
                  className="w-full h-[32px] px-2.5 rounded-[6px] border text-[12px] focus:outline-none"
                  style={{
                    backgroundColor: "var(--surface-2)",
                    borderColor: "var(--border-accent)",
                    color: "var(--fg)",
                  }}
                >
                  <option value="codex">OpenAI Codex CLI</option>
                  <option value="claude_code">Claude Code</option>
                  <option value="opencode">OpenCode Agent</option>
                </select>
              </div>
            </div>
          )}

          {tab === "committee" && (
            <div className="space-y-1">
              <label style={{ color: "var(--fg-muted)" }}>
                Committee Branch Prefix (spawns Claude Code + Codex + Synthesizer Judge)
              </label>
              <input
                value={branchPrefix}
                onChange={(e) => setBranchPrefix(e.target.value)}
                className="w-full h-[32px] px-2.5 rounded-[6px] border font-mono-code text-[12px] focus:outline-none"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: "var(--border-accent)",
                  color: "var(--fg)",
                }}
              />
            </div>
          )}

          {tab === "loop" && (
            <div className="space-y-1">
              <label style={{ color: "var(--fg-muted)" }}>
                Max Autonomous Verification Iterations (Worker + Evaluator)
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Number(e.target.value))}
                className="w-full h-[32px] px-2.5 rounded-[6px] border font-mono-code text-[12px] focus:outline-none"
                style={{
                  backgroundColor: "var(--surface-2)",
                  borderColor: "var(--border-accent)",
                  color: "var(--fg)",
                }}
              />
            </div>
          )}

          <div className="space-y-1">
            <label style={{ color: "var(--fg-muted)" }}>
              {tab === "handoff"
                ? "Handoff Instructions"
                : tab === "advisor"
                ? "Advisor Question"
                : tab === "committee"
                ? "Committee Task Prompt"
                : "Autonomous Goal Specification"}
            </label>
            <textarea
              rows={3}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              className="w-full p-2.5 rounded-[6px] border text-[12.5px] focus:outline-none resize-none"
              style={{
                backgroundColor: "var(--surface-2)",
                borderColor: "var(--border-accent)",
                color: "var(--fg)",
              }}
            />
          </div>

          <div className="pt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-[30px] px-3 rounded-[6px] border text-[12px] cursor-pointer"
              style={{
                backgroundColor: "var(--surface-2)",
                borderColor: "var(--border-subtle)",
                color: "var(--fg-muted)",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="h-[30px] px-3.5 rounded-[6px] text-[12px] font-medium cursor-pointer"
              style={{
                backgroundColor: "var(--accent)",
                color: "#ffffff",
              }}
            >
              {busy ? "Dispatching..." : `Execute /${tab}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface PairModalProps {
  open: boolean;
  pairing: PairingResponse | null;
  onClose: () => void;
}

export const PaseoPairModal: React.FC<PairModalProps> = ({ open, pairing, onClose }) => {
  if (!open || !pairing) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-[2px] p-4">
      <div
        className="w-full max-w-[440px] rounded-[10px] border shadow-2xl overflow-hidden"
        style={{
          backgroundColor: "var(--surface-1)",
          borderColor: "var(--border-accent)",
        }}
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4" style={{ color: "var(--accent-bright)" }} />
            <h3 className="text-[13.5px] font-semibold">Pair Mobile Device (E2EE Relay)</h3>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--surface-2)] cursor-pointer"
            style={{ color: "var(--fg-muted)" }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-[12px]">
          <div
            className="p-3 rounded-[8px] border font-mono-code text-[8px] leading-[8px] overflow-x-auto text-center select-all"
            style={{
              backgroundColor: "var(--surface-sidebar)",
              borderColor: "var(--border-subtle)",
              color: "var(--accent-bright)",
            }}
          >
            <pre className="inline-block text-left">{pairing.qr_ascii}</pre>
          </div>

          <div
            className="p-2.5 rounded-[6px] border space-y-1 font-mono-code text-[11px]"
            style={{
              backgroundColor: "var(--surface-2)",
              borderColor: "var(--border-subtle)",
            }}
          >
            <div className="flex items-center justify-between">
              <span style={{ color: "var(--fg-extra-muted)" }}>Room ID:</span>
              <span style={{ color: "var(--fg)" }}>{pairing.ticket.room_id}</span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ color: "var(--fg-extra-muted)" }}>Shared Key:</span>
              <span className="truncate max-w-[230px]" style={{ color: "var(--accent-bright)" }}>
                {pairing.ticket.shared_key_hex}
              </span>
            </div>
            <div className="pt-1 border-t" style={{ borderColor: "var(--border-subtle)" }}>
              <div className="truncate select-all" style={{ color: "var(--fg-muted)" }}>
                {pairing.uri}
              </div>
            </div>
          </div>

          <div
            className="flex items-center gap-2 text-[11px]"
            style={{ color: "var(--fg-muted)" }}
          >
            <ShieldCheck
              className="w-4 h-4 shrink-0"
              style={{ color: "var(--status-success)" }}
            />
            <span>
              End-to-end encrypted tunnel. Relay forwards opaque ciphertexts without reading
              source code or prompts.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
