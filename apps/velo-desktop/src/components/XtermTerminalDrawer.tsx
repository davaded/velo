import React, { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw, Trash2 } from "lucide-react";

export interface TerminalChunkPacket {
  seq: number;
  sessionId: string;
  data: string;
}

interface XtermTerminalDrawerProps {
  daemonUrl: string;
  sessionId: string;
  worktreePath: string;
  resolvedTheme: "light" | "dark";
  latestChunk: TerminalChunkPacket | null;
  onDetectedLocalUrl?: (url: string) => void;
}

const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}[^\s"'<>)]*/;

export const XtermTerminalDrawer: React.FC<XtermTerminalDrawerProps> = ({
  daemonUrl,
  sessionId,
  worktreePath,
  resolvedTheme,
  latestChunk,
  onDetectedLocalUrl,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastSeqRef = useRef<number>(0);
  const [connectedPid, setConnectedPid] = useState<number | null>(null);
  const [restarting, setRestarting] = useState(false);

  const buildXtermTheme = (mode: "light" | "dark") =>
    mode === "dark"
      ? {
          background: "#0b0b0d",
          foreground: "#e4e4e7",
          cursor: "#a1a1aa",
          cursorAccent: "#0b0b0d",
          selectionBackground: "rgba(161, 161, 170, 0.28)",
          black: "#18181b",
          red: "#f87171",
          green: "#4ade80",
          yellow: "#facc15",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#e4e4e7",
          brightBlack: "#52525b",
          brightRed: "#fca5a5",
          brightGreen: "#86efac",
          brightYellow: "#fde047",
          brightBlue: "#93c5fd",
          brightMagenta: "#d8b4fe",
          brightCyan: "#67e8f9",
          brightWhite: "#fafafa",
        }
      : {
          background: "#fafafa",
          foreground: "#18181b",
          cursor: "#3f3f46",
          cursorAccent: "#fafafa",
          selectionBackground: "rgba(63, 63, 70, 0.18)",
          black: "#18181b",
          red: "#dc2626",
          green: "#16a34a",
          yellow: "#ca8a04",
          blue: "#2563eb",
          magenta: "#9333ea",
          cyan: "#0891b2",
          brightBlack: "#71717a",
          brightRed: "#ef4444",
          brightGreen: "#22c55e",
          brightYellow: "#eab308",
          brightBlue: "#3b82f6",
          brightMagenta: "#a855f7",
          brightCyan: "#06b6d4",
          white: "#52525b",
          brightWhite: "#09090b",
        };

  // Mount xterm.js & attach to persistent PTY for `sessionId`
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.35,
      fontFamily:
        "'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      theme: buildXtermTheme(resolvedTheme),
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_, uri) => {
      window.open(uri, "_blank", "noopener,noreferrer");
    });
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(el);

    termRef.current = term;
    fitRef.current = fitAddon;
    lastSeqRef.current = 0;

    const sendResize = () => {
      try {
        fitAddon.fit();
        if (term.cols > 10 && term.rows > 3) {
          void fetch(`${daemonUrl}/api/sessions/${sessionId}/terminal/resize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cols: term.cols, rows: term.rows }),
          });
        }
      } catch {
        // ignore layout race
      }
    };

    const startPty = async () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
      try {
        const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/terminal/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cols: term.cols || 96,
            rows: term.rows || 28,
          }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          pid?: number | null;
          scrollback?: string;
        };
        if (cancelled) return;
        setConnectedPid(data.pid ?? null);
        if (data.scrollback) {
          term.write(data.scrollback);
          const m = data.scrollback.match(LOCAL_URL_RE);
          if (m && onDetectedLocalUrl) onDetectedLocalUrl(m[0]);
        }
      } catch {
        term.writeln("\r\n\x1b[31m[Disconnected from velo-daemon PTY]\x1b[0m");
      }
    };

    void startPty();

    const dataSub = term.onData((rawInput) => {
      void fetch(`${daemonUrl}/api/sessions/${sessionId}/terminal/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: rawInput }),
      });
    });

    const ro = new ResizeObserver(() => {
      sendResize();
    });
    ro.observe(el);

    return () => {
      cancelled = true;
      ro.disconnect();
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonUrl, sessionId]);

  // Dynamically update xterm theme when dark/light changes without losing PTY state
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = buildXtermTheme(resolvedTheme);
    }
  }, [resolvedTheme]);

  // Write live WebSocket PTY output chunks straight into xterm.js
  useEffect(() => {
    if (!latestChunk || latestChunk.sessionId !== sessionId) return;
    if (latestChunk.seq <= lastSeqRef.current) return;
    lastSeqRef.current = latestChunk.seq;
    if (termRef.current && latestChunk.data) {
      termRef.current.write(latestChunk.data);
      const m = latestChunk.data.match(LOCAL_URL_RE);
      if (m && onDetectedLocalUrl) {
        onDetectedLocalUrl(m[0]);
      }
    }
  }, [latestChunk, sessionId, onDetectedLocalUrl]);

  const handleSendCtrlC = async () => {
    await fetch(`${daemonUrl}/api/sessions/${sessionId}/terminal/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "\u0003" }),
    });
    termRef.current?.focus();
  };

  const handleClear = () => {
    termRef.current?.clear();
    termRef.current?.focus();
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      termRef.current?.reset();
      const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/terminal/restart`, {
        method: "POST",
      });
      if (res.ok) {
        const d = (await res.json()) as { pid?: number | null };
        setConnectedPid(d.pid ?? null);
      }
    } finally {
      setRestarting(false);
      termRef.current?.focus();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-8 px-3 border-b border-[var(--velo-border)] flex items-center justify-between text-[11px] bg-[var(--velo-bg-panel)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span className="font-mono text-[var(--velo-text-secondary)] truncate" title={worktreePath}>
            zsh · {worktreePath.split("/").slice(-2).join("/")}
          </span>
          {connectedPid && (
            <span className="text-[10px] font-mono text-[var(--velo-text-muted)]">
              PID {connectedPid}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleSendCtrlC}
            className="px-1.5 py-0.5 rounded text-[10.5px] font-mono text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)] hover:bg-[var(--velo-bg-hover)] transition"
            title="Send SIGINT (Ctrl+C)"
          >
            ^C
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="p-1 rounded text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)] hover:bg-[var(--velo-bg-hover)] transition"
            title="Clear scrollback"
          >
            <Trash2 className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={handleRestart}
            disabled={restarting}
            className="p-1 rounded text-[var(--velo-text-muted)] hover:text-[var(--velo-text-primary)] hover:bg-[var(--velo-bg-hover)] transition disabled:opacity-40"
            title="Restart PTY shell"
          >
            <RotateCcw className={`w-3 h-3 ${restarting ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
        className="flex-1 min-h-0 p-1.5 overflow-hidden"
        style={{ background: resolvedTheme === "dark" ? "#0b0b0d" : "#fafafa" }}
      />
    </div>
  );
};
