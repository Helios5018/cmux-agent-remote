import type { AgentEvent } from "@car/protocol";
import {
  baseEvent,
  classifyNotification,
  pickString,
  toolActivity,
  type HookAdapter,
  type HookEnvelope,
} from "./types.ts";

/**
 * Claude Code Adapter。
 *
 * Claude Code 的用户级 hook 事件：
 * SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
 * Notification / PreCompact / Stop / SubagentStop / SessionEnd。
 */
export const claudeAdapter: HookAdapter = {
  kind: "claude",
  normalize(envelope: HookEnvelope, now: number): AgentEvent | null {
    const base = baseEvent("claude", envelope, now);
    const payload = envelope.payload;
    const name = normalizeEventName(envelope.event);

    switch (name) {
      case "sessionstart":
        return { ...base, event: "session_started" };

      case "userpromptsubmit":
        return { ...base, event: "turn_started", activity: "Thinking" };

      case "pretooluse":
        return { ...base, event: "activity", activity: toolActivity(payload) ?? "Running tool" };

      case "posttooluse":
        return { ...base, event: "activity", activity: toolActivity(payload) ?? "Tool finished" };

      case "precompact":
        return { ...base, event: "activity", activity: "Compacting context" };

      case "notification": {
        const message = pickString(payload, "message", "title", "body");
        const intent = classifyNotification(message);
        if (intent === "needs_approval") {
          return { ...base, event: "needs_approval", activity: message ?? "Waiting for approval" };
        }
        if (intent === "needs_input") {
          return { ...base, event: "needs_input", activity: message ?? "Waiting for input" };
        }
        return { ...base, event: "activity", activity: message };
      }

      // Claude Code 在 permission 决策处也会触发 PermissionRequest（部分版本）。
      case "permissionrequest":
        return {
          ...base,
          event: "needs_approval",
          activity: toolActivity(payload) ?? "Waiting for approval",
        };

      case "stop":
        return { ...base, event: "turn_finished" };

      case "subagentstop":
        return { ...base, event: "activity", activity: "Subagent finished" };

      case "sessionend":
        return { ...base, event: "session_ended" };

      case "failure":
      case "error":
        return {
          ...base,
          event: "failure",
          activity: pickString(payload, "message", "error", "reason") ?? "Agent failure",
        };

      default:
        return null;
    }
  },
};

export function normalizeEventName(event: string): string {
  return event.replace(/[-_\s]/g, "").toLowerCase();
}
