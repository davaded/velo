import React, { useCallback, useEffect, useState } from "react";
import { CalendarClock, Copy, Check, Play, Plus, Trash2, Webhook, X } from "lucide-react";

interface AutomationRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: "cron" | "github_webhook" | "generic_webhook";
  cron_expr?: string | null;
  webhook_secret?: string | null;
  github_events?: string[];
  repo_path: string;
  branch_prefix: string;
  provider: string;
  model?: string | null;
  prompt_template: string;
  last_run_at?: string | null;
  last_session_id?: string | null;
  run_count: number;
}

interface AutomationsModalProps {
  daemonUrl: string;
  defaultRepoPath: string;
  onClose: () => void;
  onJumpToSession: (sessionId: string) => void;
}

export const AutomationsModal: React.FC<AutomationsModalProps> = ({
  daemonUrl,
  defaultRepoPath,
  onClose,
  onJumpToSession,
}) => {
  const [rules, setRules] = useState<AutomationRuleDto[]>([]);
  const [name, setName] = useState("Nightly Test & Audit");
  const [triggerType, setTriggerType] = useState<"cron" | "github_webhook" | "generic_webhook">(
    "cron"
  );
  const [cronExpr, setCronExpr] = useState("0 9 * * 1-5");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [provider, setProvider] = useState("claude");
  const [repoPath, setRepoPath] = useState(defaultRepoPath);
  const [promptTemplate, setPromptTemplate] = useState(
    "Run the test suite, inspect any recent regressions or {{title}} ({{url}}), and prepare a clean fix commit."
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch(`${daemonUrl}/api/automations`);
      if (res.ok) {
        const d = (await res.json()) as { automations?: AutomationRuleDto[] };
        setRules(d.automations || []);
      }
    } catch {
      // ignore
    }
  }, [daemonUrl]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !promptTemplate.trim()) return;
    await fetch(`${daemonUrl}/api/automations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        enabled: true,
        trigger_type: triggerType,
        cron_expr: triggerType === "cron" ? cronExpr.trim() : null,
        webhook_secret: webhookSecret.trim() || null,
        github_events:
          triggerType === "github_webhook"
            ? ["issues", "issue_comment", "pull_request", "check_run"]
            : [],
        repo_path: repoPath.trim() || defaultRepoPath,
        branch_prefix: "auto/hub",
        provider,
        prompt_template: promptTemplate,
      }),
    });
    await loadRules();
  };

  const handleToggle = async (rule: AutomationRuleDto) => {
    await fetch(`${daemonUrl}/api/automations/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    await loadRules();
  };

  const handleDelete = async (id: string) => {
    await fetch(`${daemonUrl}/api/automations/${id}`, { method: "DELETE" });
    await loadRules();
  };

  const handleRunNow = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`${daemonUrl}/api/automations/${id}/trigger`, {
        method: "POST",
      });
      if (res.ok) {
        const d = (await res.json()) as { session?: { id?: string } };
        await loadRules();
        if (d.session?.id) {
          onJumpToSession(d.session.id);
          onClose();
        }
      }
    } finally {
      setBusyId(null);
    }
  };

  const copyWebhookUrl = (rule: AutomationRuleDto) => {
    const endpoint =
      rule.trigger_type === "github_webhook"
        ? `${daemonUrl}/api/webhooks/github/${rule.id}`
        : `${daemonUrl}/api/webhooks/trigger/${rule.id}`;
    void navigator.clipboard.writeText(endpoint);
    setCopiedId(rule.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-[var(--velo-border)] bg-[var(--velo-bg-panel)] shadow-2xl overflow-hidden flex flex-col max-h-[86vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--velo-border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-[var(--velo-text-secondary)]" />
            <div>
              <div className="text-[13px] font-semibold text-[var(--velo-text-primary)]">
                Velo Hub · Scheduled Cron & Webhook Automations
              </div>
              <div className="text-[11px] text-[var(--velo-text-muted)]">
                Unattended background worktree triggers (GitHub Issues/PRs, Generic Webhooks & Cron)
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)] hover:bg-[var(--velo-bg-hover)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* New Automation Form */}
          <form
            onSubmit={handleCreate}
            className="rounded-xl border border-[var(--velo-border)] bg-[var(--velo-bg-card)] p-3.5 space-y-2.5 text-[12px]"
          >
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10.5px] text-[var(--velo-text-muted)]">Rule Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] text-[var(--velo-text-primary)] outline-none"
                />
              </div>
              <div>
                <label className="text-[10.5px] text-[var(--velo-text-muted)]">Trigger</label>
                <select
                  value={triggerType}
                  onChange={(e) =>
                    setTriggerType(
                      e.target.value as "cron" | "github_webhook" | "generic_webhook"
                    )
                  }
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] text-[var(--velo-text-primary)] outline-none"
                >
                  <option value="cron">Cron Schedule</option>
                  <option value="github_webhook">GitHub Webhook (HMAC)</option>
                  <option value="generic_webhook">Generic JSON Webhook</option>
                </select>
              </div>
              <div>
                <label className="text-[10.5px] text-[var(--velo-text-muted)]">Agent Runtime</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] text-[var(--velo-text-primary)] outline-none"
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">OpenAI Codex</option>
                  <option value="agy">Google Antigravity CLI (agy)</option>
                  <option value="acp:opencode acp">OpenCode (ACP)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {triggerType === "cron" ? (
                <div>
                  <label className="text-[10.5px] text-[var(--velo-text-muted)]">
                    5-Field Cron Expression (UTC)
                  </label>
                  <input
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                    placeholder="0 9 * * 1-5"
                    className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] font-mono text-[var(--velo-text-primary)] outline-none"
                  />
                </div>
              ) : (
                <div>
                  <label className="text-[10.5px] text-[var(--velo-text-muted)]">
                    HMAC Secret (Optional `X-Hub-Signature-256`)
                  </label>
                  <input
                    value={webhookSecret}
                    onChange={(e) => setWebhookSecret(e.target.value)}
                    placeholder="whsec_..."
                    className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] font-mono text-[var(--velo-text-primary)] outline-none"
                  />
                </div>
              )}
              <div>
                <label className="text-[10.5px] text-[var(--velo-text-muted)]">
                  Target Repository Path
                </label>
                <input
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] font-mono text-[var(--velo-text-primary)] outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-[10.5px] text-[var(--velo-text-muted)]">
                Prompt Template (supports `{"{{event}}"}`, `{"{{title}}"}`, `{"{{body}}"}`, `{"{{url}}"}`)
              </label>
              <textarea
                rows={2}
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
                className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] text-[var(--velo-text-primary)] outline-none"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--velo-text-primary)] text-[var(--velo-bg-app)] font-medium text-[11.5px] hover:opacity-90 transition"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Automation Rule
              </button>
            </div>
          </form>

          {/* Existing Rules List */}
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-[var(--velo-text-muted)] uppercase tracking-wider">
              Configured Rules ({rules.length})
            </div>
            {rules.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-[var(--velo-text-muted)] border border-dashed border-[var(--velo-border)] rounded-xl">
                No automation rules yet. Create a Cron job or GitHub Webhook above.
              </div>
            ) : (
              rules.map((r) => (
                <div
                  key={r.id}
                  className="rounded-xl border border-[var(--velo-border)] bg-[var(--velo-bg-card)] p-3 flex items-center justify-between gap-3 text-[12px]"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={() => handleToggle(r)}
                      />
                      <span className="font-medium text-[var(--velo-text-primary)] truncate">
                        {r.name}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-[var(--velo-bg-hover)] font-mono text-[10px] text-[var(--velo-text-secondary)]">
                        {r.trigger_type === "cron" ? `cron: ${r.cron_expr}` : r.trigger_type}
                      </span>
                      <span className="font-mono text-[10.5px] text-[var(--velo-text-muted)]">
                        runs: {r.run_count}
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--velo-text-muted)] truncate">
                      {r.prompt_template}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {r.trigger_type !== "cron" && (
                      <button
                        type="button"
                        onClick={() => copyWebhookUrl(r)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--velo-border)] text-[10.5px] text-[var(--velo-text-secondary)] hover:bg-[var(--velo-bg-hover)]"
                        title="Copy Webhook Endpoint URL"
                      >
                        {copiedId === r.id ? (
                          <Check className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <Webhook className="w-3 h-3" />
                        )}
                        URL
                      </button>
                    )}
                    {r.last_session_id && (
                      <button
                        type="button"
                        onClick={() => {
                          onJumpToSession(r.last_session_id!);
                          onClose();
                        }}
                        className="px-2 py-1 rounded-md border border-[var(--velo-border)] text-[10.5px] font-mono text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)]"
                      >
                        Last Run
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRunNow(r.id)}
                      disabled={busyId === r.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--velo-text-primary)] text-[var(--velo-bg-app)] text-[10.5px] font-medium hover:opacity-90 disabled:opacity-40"
                    >
                      <Play className="w-3 h-3" />
                      {busyId === r.id ? "Starting..." : "Run Now"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(r.id)}
                      className="p-1.5 rounded-md text-[var(--velo-text-muted)] hover:text-red-400 hover:bg-[var(--velo-bg-hover)]"
                      title="Delete rule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
