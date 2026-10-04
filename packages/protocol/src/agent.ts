import { z } from "zod";

/** 当前支持的 Agent。 */
export const AgentKindSchema = z.enum(["claude", "codex", "grok", "pi"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AGENT_KINDS: readonly AgentKind[] = AgentKindSchema.options;

export const AGENT_DISPLAY_NAME: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

/**
 * 统一 Agent 状态。
 * 各 Agent 的原生 Hook 各不相同，但系统内部只认这一组。
 */
export const AgentStatusSchema = z.enum([
  "WORKING",
  "NEEDS_APPROVAL",
  "NEEDS_INPUT",
  "RESPONDED_UNREAD",
  "IDLE",
  "POSSIBLY_STALE",
  "ERROR",
  "CLOSED",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * 首页 Attention Inbox 的默认排序。
 * 数值越小越靠前。
 */
export const ATTENTION_PRIORITY: Record<AgentStatus, number> = {
  ERROR: 0,
  NEEDS_APPROVAL: 1,
  NEEDS_INPUT: 2,
  RESPONDED_UNREAD: 3,
  POSSIBLY_STALE: 4,
  WORKING: 5,
  IDLE: 6,
  CLOSED: 7,
};

/** 首页三个分组。 */
export const AttentionGroupSchema = z.enum(["NEEDS_YOU", "WORKING", "IDLE"]);
export type AttentionGroup = z.infer<typeof AttentionGroupSchema>;

export function attentionGroupOf(status: AgentStatus): AttentionGroup {
  switch (status) {
    case "ERROR":
    case "NEEDS_APPROVAL":
    case "NEEDS_INPUT":
    case "RESPONDED_UNREAD":
      return "NEEDS_YOU";
    case "WORKING":
    case "POSSIBLY_STALE":
      return "WORKING";
    case "IDLE":
    case "CLOSED":
      return "IDLE";
  }
}

/** UI 上的状态标记，和文档里的 ● ⚠ ◇ ○ △ 对齐。 */
export const STATUS_GLYPH: Record<AgentStatus, string> = {
  WORKING: "●",
  NEEDS_APPROVAL: "⚠",
  NEEDS_INPUT: "⚠",
  RESPONDED_UNREAD: "◇",
  IDLE: "○",
  POSSIBLY_STALE: "△",
  ERROR: "✕",
  CLOSED: "·",
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  WORKING: "Working",
  NEEDS_APPROVAL: "Needs approval",
  NEEDS_INPUT: "Needs input",
  RESPONDED_UNREAD: "Responded",
  IDLE: "Idle",
  POSSIBLY_STALE: "Possibly stale",
  ERROR: "Error",
  CLOSED: "Closed",
};

/**
 * Hook 归一化之后的统一事件。
 * Hook 只负责状态，不负责内容。
 */
export const AgentEventSchema = z.object({
  version: z.literal(1),
  agent: AgentKindSchema,
  event: z.enum([
    "session_started",
    "turn_started",
    "activity",
    "needs_input",
    "needs_approval",
    "turn_finished",
    "session_ended",
    "failure",
  ]),
  sessionId: z.string().min(1).optional(),
  pid: z.number().int().positive().optional(),
  workspaceId: z.string().min(1).optional(),
  surfaceId: z.string().min(1).optional(),
  activity: z.string().max(500).optional(),
  cwd: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export type AgentEventName = AgentEvent["event"];

/** State Engine 输出的 Agent 状态。 */
export const AgentStateSchema = z.object({
  /** 稳定主键：surface 的 cmux UUID。 */
  id: z.string(),
  agent: AgentKindSchema,
  sessionId: z.string().optional(),
  workspaceId: z.string(),
  workspaceRef: z.string().optional(),
  workspaceTitle: z.string().optional(),
  paneId: z.string().optional(),
  paneRef: z.string().optional(),
  surfaceId: z.string(),
  surfaceRef: z.string().optional(),
  surfaceTitle: z.string().optional(),
  pid: z.number().int().optional(),
  status: AgentStatusSchema,
  currentActivity: z.string().optional(),
  /** 最近一次“有事情发生”的时间（hook 事件或输出变化）。 */
  lastActivityAt: z.number(),
  /** 用户最近一次打开该会话的时间。 */
  lastViewedAt: z.number().optional(),
  /** 当前 turn 的开始时间，用于展示 Running 4m 32s。 */
  turnStartedAt: z.number().optional(),
  /** 最近一次状态变化时间。 */
  statusChangedAt: z.number(),
  /** 是否有 hook 在上报（没有 hook 时只能靠输出变化推断）。 */
  hookConnected: z.boolean(),
  /** 输出内容指纹的版本号，内容变化才自增。 */
  outputRevision: z.number().int().nonnegative(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

/** 首页汇总：2 Need You · 3 Working · 1 Error · 4 Idle */
export const InboxSummarySchema = z.object({
  needsYou: z.number().int().nonnegative(),
  working: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  idle: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type InboxSummary = z.infer<typeof InboxSummarySchema>;

export const InboxGroupSchema = z.object({
  group: AttentionGroupSchema,
  agents: z.array(AgentStateSchema),
});
export type InboxGroup = z.infer<typeof InboxGroupSchema>;

export const InboxSchema = z.object({
  summary: InboxSummarySchema,
  groups: z.array(InboxGroupSchema),
  generatedAt: z.number(),
});
export type Inbox = z.infer<typeof InboxSchema>;
