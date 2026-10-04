import type { AgentEvent } from "@car/protocol";
import { normalizeEventName } from "./claude.ts";
import {
  baseEvent,
  classifyNotification,
  pickString,
  toolActivity,
  type HookAdapter,
  type HookEnvelope,
} from "./types.ts";

/**
 * Codex CLI Adapter。
 *
 * Codex 的 ~/.codex/hooks.json 支持：
 * SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
 * PermissionRequest / PreCompact / PostCompact / SubagentStart /
 * SubagentStop / Stop。
 *
 * 其中 PermissionRequest 是 Codex 的批准入口 → NEEDS_APPROVAL。
 */
export const codexAdapter: HookAdapter = {
  kind: "codex",
  normalize(envelope: HookEnvelope, now: number): AgentEvent | null {
    const base = baseEvent("codex", envelope, now);
    const payload = envelope.payload;
    const name = normalizeEventName(envelope.event);

    switch (name) {
      case "sessionstart":
        return { ...base, event: "session_started" };

      case "userpromptsubmit":
        return { ...base, event: "turn_started", activity: "Thinking" };

      case "permissionrequest": {
        // Codex 会在 payload 里带上决策结果；已经自动批准的不该打扰用户。
        const decision = pickString(payload, "decision", "permission_decision", "result", "status");
        if (decision && /allow|approved|accept|auto/i.test(decision)) {
          return { ...base, event: "activity", activity: toolActivity(payload) ?? "Approved" };
        }
        return {
          ...base,
          event: "needs_approval",
          activity: toolActivity(payload) ?? "Waiting for approval",
        };
      }

      case "pretooluse":
        return { ...base, event: "activity", activity: toolActivity(payload) ?? "Running tool" };

      case "posttooluse":
        return { ...base, event: "activity", activity: toolActivity(payload) ?? "Tool finished" };

      case "subagentstart":
        return { ...base, event: "activity", activity: "Subagent running" };

      case "subagentstop":
        return { ...base, event: "activity", activity: "Subagent finished" };

      case "precompact":
      case "postcompact":
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

      case "stop":
      case "turnend":
      case "turncomplete":
        return { ...base, event: "turn_finished" };

      case "sessionend":
        return { ...base, event: "session_ended" };

      case "failure":
      case "error":
      case "turnfailure":
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
