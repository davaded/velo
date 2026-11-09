import { AgentEvent, SessionStatus } from "../types/velo";

export type TimelineItem =
  | {
      kind: "reasoning";
      id: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "message";
      id: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "tool";
      id: string;
      toolId: string;
      toolName: string;
      arguments: unknown;
      output: string | null;
      isError: boolean;
      completed: boolean;
      timestamp: string;
    }
  | {
      kind: "status";
      id: string;
      status: SessionStatus;
      message: string | null;
      timestamp: string;
    }
  | {
      kind: "error";
      id: string;
      error: string;
      timestamp: string;
    };

/**
 * Merges granular streaming AgentEvents into clean, cohesive UI conversation items:
 * - Consecutive `thinking_delta` -> single collapsible Reasoning block
 * - Consecutive `message_delta` -> single cohesive Assistant Message block
 * - `tool_call_requested` + matching `tool_call_completed` -> paired Tool Card
 */
export function aggregateEventsToTimeline(events: AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIndexById = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const last = items[items.length - 1];

    switch (ev.type) {
      case "thinking_delta": {
        if (last && last.kind === "reasoning") {
          last.text += "\n" + ev.text;
        } else {
          items.push({
            kind: "reasoning",
            id: `reason-${i}`,
            text: ev.text,
            timestamp: ev.timestamp,
          });
        }
        break;
      }

      case "message_delta": {
        if (last && last.kind === "message") {
          last.text += "\n" + ev.text;
        } else {
          items.push({
            kind: "message",
            id: `msg-${i}`,
            text: ev.text,
            timestamp: ev.timestamp,
          });
        }
        break;
      }

      case "tool_call_requested": {
        const idx = items.length;
        toolIndexById.set(ev.tool_id, idx);
        items.push({
          kind: "tool",
          id: `tool-${ev.tool_id}-${i}`,
          toolId: ev.tool_id,
          toolName: ev.tool_name,
          arguments: ev.arguments,
          output: null,
          isError: false,
          completed: false,
          timestamp: ev.timestamp,
        });
        break;
      }

      case "tool_call_completed": {
        const existingIdx = toolIndexById.get(ev.tool_id);
        if (existingIdx !== undefined && items[existingIdx]?.kind === "tool") {
          const toolItem = items[existingIdx] as Extract<
            TimelineItem,
            { kind: "tool" }
          >;
          toolItem.output = ev.output;
          toolItem.isError = ev.is_error;
          toolItem.completed = true;
        } else {
          items.push({
            kind: "tool",
            id: `tool-done-${ev.tool_id}-${i}`,
            toolId: ev.tool_id,
            toolName: ev.tool_id,
            arguments: {},
            output: ev.output,
            isError: ev.is_error,
            completed: true,
            timestamp: ev.timestamp,
          });
        }
        break;
      }

      case "status_changed": {
        items.push({
          kind: "status",
          id: `status-${i}`,
          status: ev.status,
          message: ev.message,
          timestamp: ev.timestamp,
        });
        break;
      }

      case "error": {
        items.push({
          kind: "error",
          id: `err-${i}`,
          error: ev.error,
          timestamp: ev.timestamp,
        });
        break;
      }

      default:
        break;
    }
  }

  return items;
}
