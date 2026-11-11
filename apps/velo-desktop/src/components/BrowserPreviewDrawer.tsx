import React, { useEffect, useState } from "react";
import {
  ExternalLink,
  Globe,
  Monitor,
  RefreshCw,
  ScanEye,
  Smartphone,
} from "lucide-react";

interface BrowserPreviewDrawerProps {
  daemonUrl: string;
  sessionId: string;
  initialUrl?: string | null;
  onDispatchAgentPrompt: (prompt: string) => void;
}

export const BrowserPreviewDrawer: React.FC<BrowserPreviewDrawerProps> = ({
  daemonUrl,
  sessionId,
  initialUrl,
  onDispatchAgentPrompt,
}) => {
  const [inputUrl, setInputUrl] = useState<string>(initialUrl || "http://localhost:5173");
  const [activeUrl, setActiveUrl] = useState<string>(initialUrl || "http://localhost:5173");
  const [reloadKey, setReloadKey] = useState<number>(0);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [inspecting, setInspecting] = useState(false);

  useEffect(() => {
    if (initialUrl && initialUrl.trim()) {
      setInputUrl(initialUrl.trim());
      setActiveUrl(initialUrl.trim());
      setReloadKey((k) => k + 1);
    }
  }, [initialUrl]);

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    let target = inputUrl.trim();
    if (!target) return;
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = `http://${target}`;
    }
    setInputUrl(target);
    setActiveUrl(target);
    setReloadKey((k) => k + 1);
    void fetch(`${daemonUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preview_url: target }),
    });
  };

  const handleInspectForAgent = async () => {
    setInspecting(true);
    try {
      const res = await fetch(`${daemonUrl}/api/browser/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: activeUrl }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        status_line?: string;
        title?: string;
        has_error_overlay?: boolean;
        html_excerpt?: string;
        error?: string;
      };
      const prompt = data.ok
        ? [
            `Please inspect and verify the live preview at \`${activeUrl}\`:`,
            `- HTTP Status: ${data.status_line || "200 OK"}`,
            `- Document Title: ${data.title || "(none)"}`,
            data.has_error_overlay
              ? "- WARNING: Runtime / build error overlay detected in DOM!"
              : "- No runtime error overlay detected.",
            `HTML Snapshot Excerpt:\n\`\`\`html\n${(data.html_excerpt || "").slice(0, 1800)}\n\`\`\``,
            "Check if there are any layout, rendering, or runtime issues to address.",
          ].join("\n")
        : `The local dev server preview at \`${activeUrl}\` could not be reached (${
            data.error || "connection refused"
          }). Please start or fix the dev server in this worktree.`;
      onDispatchAgentPrompt(prompt);
    } finally {
      setInspecting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Browser Toolbar */}
      <form
        onSubmit={handleNavigate}
        className="h-9 px-2.5 border-b border-[var(--velo-border)] bg-[var(--velo-bg-panel)] flex items-center gap-1.5 shrink-0"
      >
        <Globe className="w-3.5 h-3.5 text-[var(--velo-text-muted)] shrink-0" />
        <input
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="http://localhost:5173"
          className="flex-1 min-w-0 px-2 py-1 rounded-md border border-[var(--velo-border)] bg-[var(--velo-bg-app)] font-mono text-[11px] text-[var(--velo-text-primary)] outline-none focus:border-[var(--velo-border-strong)]"
        />
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="p-1 rounded text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)] hover:bg-[var(--velo-bg-hover)]"
          title="Reload preview"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setViewport((v) => (v === "desktop" ? "mobile" : "desktop"))}
          className="p-1 rounded text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)] hover:bg-[var(--velo-bg-hover)]"
          title={`Switch to ${viewport === "desktop" ? "Mobile (390px)" : "Desktop"} viewport`}
        >
          {viewport === "desktop" ? (
            <Monitor className="w-3.5 h-3.5" />
          ) : (
            <Smartphone className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={handleInspectForAgent}
          disabled={inspecting}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--velo-border)] text-[10.5px] font-medium text-[var(--velo-text-secondary)] hover:bg-[var(--velo-bg-hover)] transition disabled:opacity-40"
          title="Capture DOM snapshot & HTTP health and send to Agent"
        >
          <ScanEye className="w-3 h-3" />
          <span>Inspect</span>
        </button>
        <a
          href={activeUrl}
          target="_blank"
          rel="noreferrer"
          className="p-1 rounded text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)] hover:bg-[var(--velo-bg-hover)]"
          title="Open in external browser"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </form>

      {/* Embedded Preview Surface */}
      <div className="flex-1 min-h-0 bg-[var(--velo-bg-app)] flex items-stretch justify-center overflow-auto">
        <div
          className={
            viewport === "mobile"
              ? "w-[390px] my-3 rounded-2xl border border-[var(--velo-border)] shadow-lg overflow-hidden bg-white"
              : "w-full h-full bg-white"
          }
        >
          <iframe
            key={`${activeUrl}-${reloadKey}`}
            src={activeUrl}
            title="Velo Built-in Workspace Preview"
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        </div>
      </div>
    </div>
  );
};
