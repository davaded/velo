import { useCallback, useEffect, useRef, useState } from "react";
import {
  AgentEvent,
  AgentProvider,
  CreateSessionPayload,
  SessionDiffResponse,
  SessionInfo,
  WsServerMessage,
} from "../types/velo";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:6767";
const DEFAULT_WS_URL = "ws://127.0.0.1:6767/ws";

export function useVeloDaemon(daemonUrl = DEFAULT_DAEMON_URL, wsUrl = DEFAULT_WS_URL) {
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[]>>({});
  const wsRef = useRef<WebSocket | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`${daemonUrl}/api/sessions`);
      if (res.ok) {
        const list: SessionInfo[] = await res.json();
        setSessions(list);
        setConnected(true);
      }
    } catch {
      setConnected(false);
    }
  }, [daemonUrl]);

  const fetchSessionEvents = useCallback(
    async (sessionId: string) => {
      try {
        const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/events`);
        if (res.ok) {
          const evs: AgentEvent[] = await res.json();
          setEventsBySession((prev) => ({ ...prev, [sessionId]: evs }));
        }
      } catch {
        // ignore transient error
      }
    },
    [daemonUrl]
  );

  const fetchSessionDiff = useCallback(
    async (sessionId: string): Promise<SessionDiffResponse | null> => {
      try {
        const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/diff`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    [daemonUrl]
  );

  useEffect(() => {
    fetchSessions();
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isUnmounted = false;

    function connectWs() {
      if (isUnmounted) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isUnmounted) setConnected(true);
      };

      ws.onmessage = (evt) => {
        try {
          const msg: WsServerMessage = JSON.parse(evt.data);
          if (msg.kind === "sessions_snapshot") {
            setSessions(msg.sessions);
          } else if (msg.kind === "event") {
            const ev = msg.event;
            setEventsBySession((prev) => {
              const existing = prev[ev.session_id] || [];
              return { ...prev, [ev.session_id]: [...existing, ev] };
            });

            if (ev.type === "status_changed") {
              setSessions((prev) =>
                prev.map((s) =>
                  s.id === ev.session_id ? { ...s, status: ev.status } : s
                )
              );
              fetchSessions();
            } else if (ev.type === "diff_updated") {
              setSessions((prev) =>
                prev.map((s) =>
                  s.id === ev.session_id ? { ...s, diff_stats: ev.stats } : s
                )
              );
            } else if (ev.type === "tool_call_completed") {
              fetchSessions();
            }
          }
        } catch {
          // ignore malformed frame
        }
      };

      ws.onclose = () => {
        if (!isUnmounted) {
          setConnected(false);
          reconnectTimer = setTimeout(connectWs, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connectWs();

    return () => {
      isUnmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [wsUrl, fetchSessions]);

  const createSession = useCallback(
    async (payload: CreateSessionPayload): Promise<SessionInfo> => {
      const res = await fetch(`${daemonUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create session");
      }
      await fetchSessions();
      return data as SessionInfo;
    },
    [daemonUrl, fetchSessions]
  );

  const stopSession = useCallback(
    async (sessionId: string) => {
      await fetch(`${daemonUrl}/api/sessions/${sessionId}/stop`, {
        method: "POST",
      });
      await fetchSessions();
    },
    [daemonUrl, fetchSessions]
  );

  const sendInput = useCallback(
    async (sessionId: string, input: string) => {
      await fetch(`${daemonUrl}/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
    },
    [daemonUrl]
  );

  const handoffSession = useCallback(
    async (
      sessionId: string,
      targetProvider: AgentProvider,
      additionalInstructions?: string
    ): Promise<SessionInfo> => {
      const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_provider: targetProvider,
          additional_instructions: additionalInstructions || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to hand off session");
      }
      await fetchSessions();
      return data as SessionInfo;
    },
    [daemonUrl, fetchSessions]
  );

  const advisorSession = useCallback(
    async (
      sessionId: string,
      advisorProvider: AgentProvider,
      focusQuestion?: string
    ): Promise<SessionInfo> => {
      const res = await fetch(`${daemonUrl}/api/sessions/${sessionId}/advisor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          advisor_provider: advisorProvider,
          focus_question: focusQuestion || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to spawn advisor");
      }
      await fetchSessions();
      return data as SessionInfo;
    },
    [daemonUrl, fetchSessions]
  );

  const createCommittee = useCallback(
    async (
      providers: AgentProvider[],
      prompt: string,
      repoPath: string,
      namePrefix?: string
    ): Promise<SessionInfo[]> => {
      const res = await fetch(`${daemonUrl}/api/committee`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name_prefix: namePrefix || null,
          providers,
          prompt,
          repo_path: repoPath,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to dispatch committee");
      }
      await fetchSessions();
      return (data.sessions || []) as SessionInfo[];
    },
    [daemonUrl, fetchSessions]
  );

  const createLoopSession = useCallback(
    async (payload: {
      name?: string;
      provider: AgentProvider;
      prompt: string;
      check_command: string;
      max_iterations: number;
      repo_path: string;
      branch?: string;
    }): Promise<SessionInfo> => {
      const res = await fetch(`${daemonUrl}/api/loop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to start self-healing loop");
      }
      await fetchSessions();
      return data as SessionInfo;
    },
    [daemonUrl, fetchSessions]
  );

  return {
    connected,
    sessions,
    eventsBySession,
    fetchSessions,
    fetchSessionEvents,
    fetchSessionDiff,
    createSession,
    stopSession,
    sendInput,
    handoffSession,
    advisorSession,
    createCommittee,
    createLoopSession,
  };
}
