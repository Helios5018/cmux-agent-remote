import { z } from "zod";
import { AgentStateSchema, AgentStatusSchema, InboxSchema } from "./agent.ts";
import { SurfaceGridSchema } from "./grid.ts";

/** 服务端 → 浏览器。 */

export const AgentStatusChangedSchema = z.object({
  type: z.literal("agent.status_changed"),
  surfaceId: z.string(),
  status: AgentStatusSchema,
  agent: AgentStateSchema,
});

export const AgentListChangedSchema = z.object({
  type: z.literal("agent.list_changed"),
  inbox: InboxSchema,
});

export const SurfaceSnapshotMessageSchema = z.object({
  type: z.literal("surface.snapshot"),
  surfaceId: z.string(),
  revision: z.number().int().nonnegative(),
  content: z.string(),
});

/** 正在查看的 surface 推送彩色渲染网格。 */
export const SurfaceGridMessageSchema = z.object({
  type: z.literal("surface.grid"),
  surfaceId: z.string(),
  grid: SurfaceGridSchema,
});

export const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  serverVersion: z.string(),
  now: z.number(),
});

export const PongMessageSchema = z.object({
  type: z.literal("pong"),
  now: z.number(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  PongMessageSchema,
  AgentStatusChangedSchema,
  AgentListChangedSchema,
  SurfaceSnapshotMessageSchema,
  SurfaceGridMessageSchema,
  ErrorMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** 浏览器 → 服务端。 */

export const SubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  /** 当前正在查看的 surface；决定高频刷新目标。 */
  surfaceId: z.string().nullable(),
});

export const PingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  SubscribeMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Surface 输出刷新间隔。 */
export const REFRESH_INTERVAL_MS = {
  /** 用户正在查看的 surface。 */
  viewing: 400,
  /** Working 中的 Agent。 */
  working: 1000,
  /** Idle Agent。 */
  idle: 8000,
} as const;
