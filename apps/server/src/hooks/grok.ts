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
 * Grok Build Adapter。
 *
 * Grok 的 ~/.grok/hooks/*.json 支持：
 * SessionStart / UserPromptSubmit / PreToolUse / Notification / Stop / SessionEnd。
 *
 * Grok 用 Notification 承载「需要批准 / 需要输入 / 回合结束」的用户可见消息，
 * 所以文案分类在这里格外重要。
 */
export const grokAdapter: HookAdapter = {
  kind: "grok",
  normalize(envelope: HookEnvelope, now: number): AgentEvent | null {
    const base = baseEvent("grok", envelope, now);
    const payload = envelope.payload;
    const name = normalizeEventName(envelope.event);

    switch (name) {
      case "sessionstart":
        return { ...base, event: "session_started" };

      case "userpromptsubmit":
        return { ...base, event: "turn_started", activity: "Thinking" };

      case "pretooluse": {
        // Grok 在 always-approve 之外的模式下，PreToolUse 会带 approval 请求标记。
        const requiresApproval =
          payload["requires_approval"] === true ||
          payload["needs_approval"] === true ||
          /ask|prompt|manual/i.test(pickString(payload, "approval_mode", "permission_mode") ?? "");
        if (requiresApproval) {
          return {
            ...base,
            event: "needs_approval",
            activity: toolActivity(payload) ?? "Waiting for approval",
          };
        }
        return { ...base, event: "activity", activity: toolActivity(payload) ?? "Running tool" };
      }

      case "posttooluse":
        return { ...base, event: "activity", activity: toolActivity(payload) ?? "Tool finished" };

      case "notification": {
        const message = pickString(payload, "message", "title", "body", "text");
        const intent = classifyNotification(message);
        if (intent === "needs_approval") {
          return { ...base, event: "needs_approval", activity: message ?? "Waiting for approval" };
        }
        if (intent === "needs_input") {
          return { ...base, event: "needs_input", activity: message ?? "Waiting for input" };
        }
        // Grok 的完成通知就是它自己的回复摘要，直接作为活动文案。
        return { ...base, event: "activity", activity: message };
      }

      case "stop":
        return { ...base, event: "turn_finished" };

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
