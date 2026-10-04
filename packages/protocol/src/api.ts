import { z } from "zod";
import { AgentKindSchema, AgentStateSchema, AgentStatusSchema, InboxSchema } from "./agent.ts";
import { CmuxKeySchema, CmuxTreeSchema, ScrollActionSchema, SurfaceSnapshotSchema } from "./cmux.ts";
import { SurfaceGridSchema } from "./grid.ts";

/** POST /api/auth/login */
export const LoginRequestSchema = z.object({
  token: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** 会话：登录后即可读写，不再分只读 / 控制模式。 */
export const SessionInfoSchema = z.object({
  authenticated: z.boolean(),
  serverVersion: z.string(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

/** GET /api/agents */
export const AgentsResponseSchema = InboxSchema;
export type AgentsResponse = z.infer<typeof AgentsResponseSchema>;

/** GET /api/agents/:surfaceId */
export const AgentDetailResponseSchema = z.object({
  agent: AgentStateSchema,
  snapshot: SurfaceSnapshotSchema.nullable(),
});
export type AgentDetailResponse = z.infer<typeof AgentDetailResponseSchema>;

/** GET /api/tree */
export const TreeResponseSchema = CmuxTreeSchema;
export type TreeResponse = z.infer<typeof TreeResponseSchema>;

/** GET /api/surfaces/:surfaceId/output */
export const SurfaceOutputResponseSchema = SurfaceSnapshotSchema;
export type SurfaceOutputResponse = z.infer<typeof SurfaceOutputResponseSchema>;

/**
 * POST /api/surfaces —— 在指定 pane 里新建一个 surface。
 *
 * 只建 terminal：`--type agent-session` 建出来的是 cmux 自己的 Agent 面板，
 * `read-screen` 报 "Surface is not a terminal"、`terminal.replay` 直接 not_found，
 * 在这边既看不到画面也发不了输入，等于建了个盲盒。
 *
 * `launch` 是白名单枚举而不是自由命令字符串 —— 这个接口开在公网上，
 * 收任意命令等于送一个远程 shell。
 */
export const CreateWorkspaceRequestSchema = z.object({
  cwd: z.string().min(1).max(4096).regex(/^\//).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  launch: AgentKindSchema.nullable().default(null),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type CreateWorkspaceResponse = { ok: true; workspaceId: string; surfaceId: string; launchError?: string };

export const CreateSurfaceRequestSchema = z.object({
  /** 目标 pane（UUID 优先，也认 pane:N 短引用）。必填：不存在「当前 pane」这种概念。 */
  paneId: z.string().min(1).max(128),
  /** pane 用短引用时需要 workspace 上下文才能定位。 */
  workspaceId: z.string().min(1).max(128).optional(),
  /** 建完顺手起哪个 Agent；null 就是一个干净的 shell。 */
  launch: AgentKindSchema.nullable().default(null),
});
export type CreateSurfaceRequest = z.infer<typeof CreateSurfaceRequestSchema>;

export const CreateSurfaceResponseSchema = z.object({
  ok: z.literal(true),
  /** 新 surface 的 UUID，可以直接跳会话页。 */
  surfaceId: z.string(),
  surfaceRef: z.string(),
  paneId: z.string().optional(),
  workspaceId: z.string().optional(),
  /** 服务端替它选的工作目录；反查不到时为 null（cmux 用自己的默认值）。 */
  cwd: z.string().nullable(),
  launched: AgentKindSchema.nullable(),
  /** tab 已创建，但启动命令未得到完整确认；不可重新创建来重试。 */
  launchError: z.object({
    stage: z.enum(["text_unknown", "submit_unknown"]),
    message: z.string(),
  }).optional(),
});
export type CreateSurfaceResponse = z.infer<typeof CreateSurfaceResponseSchema>;

/** POST /api/surfaces/:surfaceId/input */
export const SurfaceInputRequestSchema = z.object({
  text: z.string().max(20000),
  submit: z.boolean().default(true),
});
export type SurfaceInputRequest = z.infer<typeof SurfaceInputRequestSchema>;

/** POST /api/surfaces/:surfaceId/key */
export const SurfaceKeyRequestSchema = z.object({
  key: CmuxKeySchema,
  /** 危险按键必须带上确认标记。 */
  confirm: z.boolean().optional(),
  /** 连按仅允许 Ctrl+C；由服务端控制间隔，避免网络延迟错过退出窗口。 */
  repeat: z.union([z.literal(1), z.literal(2)]).default(1),
}).refine(({ key, repeat }) => repeat === 1 || key === "ctrl+c", {
  message: "只有 Ctrl+C 支持连按",
});
export type SurfaceKeyRequest = z.infer<typeof SurfaceKeyRequestSchema>;

/** 写操作（input / key / 改名）的响应。 */
export const SurfaceWriteResponseSchema = z.object({
  ok: z.literal(true),
});
export type SurfaceWriteResponse = z.infer<typeof SurfaceWriteResponseSchema>;

/** POST /api/surfaces/:surfaceId/close —— 关掉 cmux 里的真实 tab。 */
export const CloseSurfaceRequestSchema = z.object({
  /** 关掉 tab 会干掉里面的进程，必须显式确认。 */
  confirm: z.literal(true),
});
export type CloseSurfaceRequest = z.infer<typeof CloseSurfaceRequestSchema>;

/** POST /api/surfaces/:surfaceId/title 与 POST /api/workspaces/:workspaceId/title */
export const RenameTitleRequestSchema = z.object({
  title: z.string().trim().min(1).max(80),
});
export type RenameTitleRequest = z.infer<typeof RenameTitleRequestSchema>;

/**
 * POST /api/surfaces/:surfaceId/scroll —— 翻页。
 *
 * 和 /key 分开：翻页只改「看到哪一屏」，不往终端里写东西。
 */
export const SurfaceScrollRequestSchema = z.object({
  action: ScrollActionSchema,
});
export type SurfaceScrollRequest = z.infer<typeof SurfaceScrollRequestSchema>;

/** 翻页后顺带把新画面带回来，省掉一次往返。 */
export const SurfaceScrollResponseSchema = z.object({
  ok: z.literal(true),
  grid: SurfaceGridSchema,
});
export type SurfaceScrollResponse = z.infer<typeof SurfaceScrollResponseSchema>;

/**
 * GET /api/surfaces/:surfaceId/history —— 网格之外更早的历史（纯文本、无颜色）。
 *
 * `terminal.replay` 只给最近 240 行回滚，再往上只能走 `read-screen --scrollback`。
 */
export const SurfaceHistoryResponseSchema = z.object({
  /** 已经去掉与网格重叠部分之后的历史文本。 */
  text: z.string(),
  /** cmux 一共给了多少行（含与网格重叠的部分）。 */
  totalLines: z.number().int().nonnegative(),
  /** 因为与网格重叠而被去掉的尾部行数。 */
  droppedTail: z.number().int().nonnegative(),
  /** 是否顶到了请求行数上限，上面可能还有更早的内容。 */
  truncated: z.boolean(),
});
export type SurfaceHistoryResponse = z.infer<typeof SurfaceHistoryResponseSchema>;

export const OkResponseSchema = z.object({
  ok: z.literal(true),
});

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** POST /api/agents/:surfaceId/read —— 标记已读，RESPONDED_UNREAD → IDLE */
export const MarkReadResponseSchema = z.object({
  ok: z.literal(true),
  agent: AgentStateSchema,
});

/** 批量关闭必须携带用户确认时看到的完整 surface 集合。 */
export const CloseTopologyRequestSchema = z.object({
  confirm: z.literal(true),
  surfaceIds: z.array(z.string().min(1)).min(1),
});

/** Authenticated installation identity, persisted with the database. */
export const ServerInfoResponseSchema = z.object({
  instanceId: z.string().uuid(), serverVersion: z.string(), agentApiVersion: z.literal(1),
  demo: z.boolean(), guidePath: z.literal("/agent-guide.md"),
});
export type ServerInfoResponse = z.infer<typeof ServerInfoResponseSchema>;

export const SurfaceContextResponseSchema = z.object({
  instanceId: z.string().uuid(),
  surface: z.object({
    id: z.string().uuid(), title: z.string(), type: z.string(), paneId: z.string().nullable(),
    workspaceId: z.string(), workspaceTitle: z.string(),
  }),
  agent: z.object({
    kind: AgentKindSchema, sessionId: z.string().nullable(), status: AgentStatusSchema.nullable(),
    currentActivity: z.string().nullable(), hookConnected: z.boolean(), lastActivityAt: z.number().nullable(),
  }).nullable(),
  cwd: z.string().nullable(),
  git: z.object({ root: z.string(), branch: z.string(), hasChanges: z.boolean() }).nullable(),
  output: z.object({ content: z.string(), fetchedAt: z.number(), limitLines: z.literal(200), limited: z.boolean() }).nullable(),
  issues: z.array(z.object({ section: z.enum(["cwd", "git", "output"]), code: z.string(), message: z.string() })),
  fetchedAt: z.number(),
});
export type SurfaceContextResponse = z.infer<typeof SurfaceContextResponseSchema>;
