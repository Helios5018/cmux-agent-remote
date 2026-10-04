import { z } from "zod";
import { AgentKindSchema, type AgentEvent, type AgentKind } from "@car/protocol";

/**
 * Hook 落地形态。
 *
 * 三家 Agent 的 hook 都是「事件名 + stdin JSON」，
 * `cmux-agent-web-hook` 把它们统一包成下面这个信封 POST 给服务端。
 * Hook 只负责状态，不传输终端内容。
 */
export const HookEnvelopeSchema = z.object({
  /** 原生事件名，例如 PreToolUse / Stop / Notification。 */
  event: z.string().min(1).max(64),
  /** 原生 stdin JSON，尽量原样透传，由 adapter 解释。 */
  payload: z.record(z.unknown()).default({}),
  context: z
    .object({
      workspaceId: z.string().min(1).optional(),
      surfaceId: z.string().min(1).optional(),
      pid: z.coerce.number().int().positive().optional(),
      cwd: z.string().optional(),
      timestamp: z.coerce.number().int().nonnegative().optional(),
    })
    .default({}),
});
export type HookEnvelope = z.infer<typeof HookEnvelopeSchema>;

export const HookRequestSchema = HookEnvelopeSchema.extend({
  agent: AgentKindSchema,
});
export type HookRequest = z.infer<typeof HookRequestSchema>;

export interface HookAdapter {
  kind: AgentKind;
  /** 原生事件 → 统一事件；返回 null 表示这个事件不关心。 */
  normalize(envelope: HookEnvelope, now: number): AgentEvent | null;
}

/** 从原生 payload 里安全取字符串。 */
export function pickString(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function pickNumber(payload: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** 需要用户批准 / 需要用户回答，靠 notification 文案区分。 */
const APPROVAL_HINTS = [
  /needs? your permission/i,
  /permission to use/i,
  /approve/i,
  /approval/i,
  /allow .* to run/i,
  /是否允许/,
  /需要.*授权/,
  /需要.*批准/,
];

const INPUT_HINTS = [
  /waiting for your input/i,
  /waiting for user input/i,
  /is idle/i,
  /needs? your input/i,
  /awaiting input/i,
  /等待.*输入/,
  /需要.*输入/,
];

export type NotificationIntent = "needs_approval" | "needs_input" | "activity";

export function classifyNotification(message: string | undefined): NotificationIntent {
  if (!message) return "activity";
  if (APPROVAL_HINTS.some((re) => re.test(message))) return "needs_approval";
  if (INPUT_HINTS.some((re) => re.test(message))) return "needs_input";
  return "activity";
}

/** 生成统一事件的公共部分。 */
export function baseEvent(
  agent: AgentKind,
  envelope: HookEnvelope,
  now: number,
): Omit<AgentEvent, "event"> {
  const payload = envelope.payload;
  return {
    version: 1,
    agent,
    sessionId: pickString(payload, "session_id", "sessionId", "conversation_id", "thread_id"),
    pid: envelope.context.pid ?? pickNumber(payload, "pid", "process_id"),
    workspaceId: envelope.context.workspaceId,
    surfaceId: envelope.context.surfaceId,
    cwd: envelope.context.cwd ?? pickString(payload, "cwd", "workspace_dir", "working_directory"),
    timestamp: envelope.context.timestamp ?? now,
  };
}

/** 工具调用的活动描述，例如 "Running Bash"。 */
export function toolActivity(payload: Record<string, unknown>): string | undefined {
  const tool = pickString(payload, "tool_name", "toolName", "tool");
  if (!tool) return undefined;
  const input = payload["tool_input"] ?? payload["toolInput"];
  if (input && typeof input === "object") {
    const command = pickString(input as Record<string, unknown>, "command", "file_path", "path", "pattern");
    if (command) {
      const short = command.length > 60 ? `${command.slice(0, 59)}…` : command;
      return `${tool}: ${short}`;
    }
  }
  return `Running ${tool}`;
}
