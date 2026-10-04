import { z } from "zod";
import { AgentKindSchema } from "./agent.ts";

const Timestamp = z.number().int().nonnegative().nullable();

/** GET /api/diagnostics（需登录）。运行元数据不包含原始错误或 Hook payload。 */
export const DiagnosticsResponseSchema = z.object({
  now: z.number(),
  demo: z.boolean(),
  startedAt: z.number(),
  uptimeMs: z.number().nonnegative(),
  topology: z.object({
    status: z.enum(["unknown", "ok", "degraded", "stale"]),
    lastAttemptAt: Timestamp,
    lastSuccessAt: Timestamp,
    consecutiveFailures: z.number().int().nonnegative(),
    staleAfterMs: z.number().positive(),
  }).nullable(),
  hooks: z.object({
    lastReceivedAt: Timestamp,
    lastAppliedAt: Timestamp,
    lastAgent: AgentKindSchema.nullable(),
    lastOutcome: z.enum(["applied", "ignored", "unresolved"]).nullable(),
  }),
  storage: z.object({
    driver: z.enum(["bun", "node", "memory"]),
    persistent: z.boolean(),
  }),
  audit: z.object({
    maxAgeMs: z.number().int().positive(),
    maxRows: z.number().int().positive(),
    cleanupIntervalMs: z.number().positive(),
    cleanupBatchSize: z.number().int().positive(),
    lastAttemptAt: Timestamp,
    lastSuccessAt: Timestamp,
    consecutiveFailures: z.number().int().nonnegative(),
  }),
  recentErrors: z.array(z.object({
    at: z.number(),
    source: z.enum(["topology", "surface.grid", "surface.text", "api", "audit.cleanup"]),
    code: z.string(),
    message: z.string(),
  })).max(20),
});
export type DiagnosticsResponse = z.infer<typeof DiagnosticsResponseSchema>;
