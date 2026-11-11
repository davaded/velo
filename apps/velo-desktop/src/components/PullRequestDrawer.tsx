import React, { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  Wrench,
} from "lucide-react";

interface PrCheckItem {
  name: string;
  status: string;
  conclusion: string;
  details_url?: string | null;
}

interface PrDetail {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  mergeable?: string;
  reviewDecision?: string;
  headRefName?: string;
  baseRefName?: string;
  additions?: number;
  deletions?: number;
  comments?: Array<{
    author?: { login?: string };
    body?: string;
    createdAt?: string;
  }>;
}

interface PullRequestDrawerProps {
  daemonUrl: string;
  sessionId: string;
  branchName: string;
  sessionTitle: string;
  onDispatchAgentPrompt: (prompt: string) => void;
}

export const PullRequestDrawer: React.FC<PullRequestDrawerProps> = ({
  daemonUrl,
  sessionId,
  branchName,
  sessionTitle,
  onDispatchAgentPrompt,
}) => {
  const [loading, setLoading] = useState(false);
  const [exists, setExists] = useState(false);
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [checks, setChecks] = useState<PrCheckItem[]>([]);
  const [statusNote, setStatusNote] = useState<string>("");

  const [title, setTitle] = useState(sessionTitle || branchName);
  const [body, setBody] = useState(
    `## Summary\nAutomated changes prepared on isolated worktree branch \`${branchName}\` via Velo.`
  );
  const [baseBranch, setBaseBranch] = useState("main");
  const [isDraft, setIsDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setTitle(sessionTitle || branchName);
    setBody(
      `## Summary\nAutomated changes prepared on isolated worktree branch \`${branchName}\` via Velo.`
    );
  }, [sessionId, branchName, sessionTitle]);

  const fetchPr = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/pr`);
      const data = (await res.json()) as {
        ok?: boolean;
        exists?: boolean;
        pr?: PrDetail;
        checks?: PrCheckItem[];
        message?: string;
        error?: string;
      };
      setExists(Boolean(data.exists && data.pr));
      setPr(data.pr || null);
      setChecks(data.checks || []);
      setStatusNote(data.error || data.message || "");
    } catch {
      setStatusNote("Could not query GitHub PR status.");
    } finally {
      setLoading(false);
    }
  }, [daemonUrl, sessionId]);

  useEffect(() => {
    void fetchPr();
  }, [fetchPr]);

  const handleCreatePr = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    setStatusNote("");
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/pr/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body,
          base: baseBranch.trim() || undefined,
          draft: isDraft,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setStatusNote(data.error || "PR creation failed");
      } else {
        await fetchPr();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleMergePr = async (method: "squash" | "merge" | "rebase") => {
    setSubmitting(true);
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/pr/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setStatusNote(data.error || "Merge failed");
      } else {
        await fetchPr();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleFixCiWithAgent = async () => {
    let report = "";
    try {
      const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/pr/checks`);
      const d = (await res.json()) as { report?: string };
      report = d.report || "";
    } catch {
      // ignore
    }
    const failingNames = checks
      .filter((c) => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "ERROR")
      .map((c) => `- ${c.name} (${c.conclusion})${c.details_url ? `: ${c.details_url}` : ""}`)
      .join("\n");

    const prompt = [
      `GitHub PR #${pr?.number ?? ""} CI checks are failing on branch \`${branchName}\`.`,
      failingNames ? `Failing checks:\n${failingNames}` : "",
      report ? `\`gh pr checks\` output:\n\`\`\`\n${report}\n\`\`\`` : "",
      "Inspect the failure logs (using `gh run view` or running the failing tests locally), fix the root cause, and commit the fix.",
    ]
      .filter(Boolean)
      .join("\n\n");

    onDispatchAgentPrompt(prompt);
  };

  const failingCount = checks.filter(
    (c) => c.conclusion === "FAILURE" || c.conclusion === "ERROR" || c.conclusion === "TIMED_OUT"
  ).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-3.5 space-y-3.5 text-[12px]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium text-[var(--velo-text-primary)]">
          <GitPullRequest className="w-3.5 h-3.5 text-[var(--velo-text-muted)]" />
          <span>Pull Request · {branchName}</span>
        </div>
        <button
          type="button"
          onClick={fetchPr}
          disabled={loading}
          className="p-1 rounded text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)] hover:bg-[var(--velo-bg-hover)] transition"
          title="Refresh PR & CI status"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {statusNote && !exists && (
        <div className="px-2.5 py-2 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-card)] text-[11px] text-[var(--velo-text-muted)]">
          {statusNote}
        </div>
      )}

      {!exists || !pr ? (
        <div className="rounded-xl border border-[var(--velo-border)] bg-[var(--velo-bg-card)] p-3.5 space-y-3">
          <div className="text-[11.5px] font-medium text-[var(--velo-text-primary)]">
            Create GitHub Pull Request
          </div>
          <div className="space-y-1">
            <label className="text-[10.5px] text-[var(--velo-text-muted)]">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="feat: describe pull request"
              className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] text-[12px] text-[var(--velo-text-primary)] outline-none focus:border-[var(--velo-border-strong)]"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10.5px] text-[var(--velo-text-muted)]">Base Branch</label>
              <input
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
                className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] text-[12px] font-mono text-[var(--velo-text-primary)] outline-none"
              />
            </div>
            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--velo-text-secondary)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isDraft}
                  onChange={(e) => setIsDraft(e.target.checked)}
                />
                Open as Draft PR
              </label>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10.5px] text-[var(--velo-text-muted)]">Description</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--velo-border)] bg-[var(--velo-bg-app)] text-[11.5px] text-[var(--velo-text-primary)] outline-none resize-y"
            />
          </div>
          <button
            type="button"
            onClick={handleCreatePr}
            disabled={submitting || !title.trim() || branchName === "main" || branchName === "master"}
            className="w-full py-1.5 px-3 rounded-lg bg-[var(--velo-text-primary)] text-[var(--velo-bg-app)] font-medium text-[11.5px] hover:opacity-90 transition disabled:opacity-40"
          >
            {submitting
              ? "Pushing & Opening PR..."
              : branchName === "main" || branchName === "master"
              ? "Switch to a feature worktree to open a PR"
              : "Push Branch & Create PR"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Active PR Summary Card */}
          <div className="rounded-xl border border-[var(--velo-border)] bg-[var(--velo-bg-card)] p-3.5 space-y-2.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${
                      pr.state === "MERGED"
                        ? "bg-purple-500/15 text-purple-400"
                        : pr.isDraft
                        ? "bg-zinc-500/15 text-zinc-400"
                        : "bg-emerald-500/15 text-emerald-400"
                    }`}
                  >
                    {pr.isDraft ? "DRAFT" : pr.state}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--velo-text-muted)]">
                    #{pr.number}
                  </span>
                </div>
                <div className="mt-1 font-medium text-[13px] text-[var(--velo-text-primary)]">
                  {pr.title}
                </div>
              </div>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--velo-border)] text-[11px] text-[var(--velo-text-secondary)] hover:bg-[var(--velo-bg-hover)] shrink-0"
              >
                GitHub <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="flex items-center gap-3 text-[11px] font-mono text-[var(--velo-text-muted)]">
              <span>
                {pr.headRefName} → {pr.baseRefName}
              </span>
              {typeof pr.additions === "number" && (
                <span className="text-emerald-500">+{pr.additions}</span>
              )}
              {typeof pr.deletions === "number" && (
                <span className="text-red-400">-{pr.deletions}</span>
              )}
            </div>

            {pr.state === "OPEN" && (
              <div className="pt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleMergePr("squash")}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-500 transition disabled:opacity-40"
                >
                  <GitMerge className="w-3.5 h-3.5" />
                  Squash & Merge
                </button>
                <button
                  type="button"
                  onClick={() => handleMergePr("rebase")}
                  disabled={submitting}
                  className="px-2.5 py-1 rounded-lg border border-[var(--velo-border)] text-[11px] text-[var(--velo-text-secondary)] hover:bg-[var(--velo-bg-hover)] transition disabled:opacity-40"
                >
                  Rebase Merge
                </button>
              </div>
            )}
          </div>

          {/* CI Checks Section */}
          <div className="rounded-xl border border-[var(--velo-border)] bg-[var(--velo-bg-card)] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-[var(--velo-text-secondary)]">
                CI Status Checks ({checks.length})
              </span>
              {failingCount > 0 && (
                <button
                  type="button"
                  onClick={handleFixCiWithAgent}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 text-[10.5px] font-medium transition"
                >
                  <Wrench className="w-3 h-3" />
                  Ask Agent to Fix CI ({failingCount})
                </button>
              )}
            </div>

            {checks.length === 0 ? (
              <div className="text-[11px] text-[var(--velo-text-muted)] py-1">
                No CI checks reported for this pull request yet.
              </div>
            ) : (
              <div className="space-y-1">
                {checks.map((c, idx) => {
                  const isPass = c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL";
                  const isFail =
                    c.conclusion === "FAILURE" ||
                    c.conclusion === "ERROR" ||
                    c.conclusion === "TIMED_OUT";
                  return (
                    <div
                      key={`${c.name}-${idx}`}
                      className="flex items-center justify-between py-1 px-2 rounded-md bg-[var(--velo-bg-app)] text-[11px]"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {isPass ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        ) : isFail ? (
                          <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        ) : (
                          <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        )}
                        <span className="truncate text-[var(--velo-text-primary)]">{c.name}</span>
                      </div>
                      {c.details_url && (
                        <a
                          href={c.details_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[10px] text-[var(--velo-text-muted)] hover:underline shrink-0 ml-2"
                        >
                          Logs
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent PR Review Comments */}
          {pr.comments && pr.comments.length > 0 && (
            <div className="rounded-xl border border-[var(--velo-border)] bg-[var(--velo-bg-card)] p-3 space-y-2">
              <div className="text-[11px] font-medium text-[var(--velo-text-secondary)]">
                PR Comments ({pr.comments.length})
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {pr.comments.map((cm, i) => (
                  <div
                    key={i}
                    className="p-2 rounded-lg bg-[var(--velo-bg-app)] border border-[var(--velo-border)] space-y-1"
                  >
                    <div className="text-[10.5px] font-mono text-[var(--velo-text-muted)]">
                      @{cm.author?.login || "reviewer"}
                    </div>
                    <div className="text-[11.5px] text-[var(--velo-text-primary)] whitespace-pre-wrap">
                      {cm.body}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {statusNote && (
            <div className="text-[11px] text-red-400 px-1">{statusNote}</div>
          )}
        </div>
      )}
    </div>
  );
};
