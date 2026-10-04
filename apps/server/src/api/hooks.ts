import { Hono } from "hono";
import { AgentKindSchema } from "@car/protocol";
import { type AppContext } from "../context.ts";
import { HookEnvelopeSchema, normalizeHook } from "../hooks/index.ts";
import { requireHookToken } from "../security/middleware.ts";
import { safeJson } from "./http.ts";

/**
 * Hook Receiver。
 *
 * 铁律：Hook 服务失效不能影响 Agent 本身运行，
 * 所以这里永远返回 200 + {ok:...}，绝不返回会让 Agent CLI 报错的状态码。
 */
export function createHookRoutes(ctx: AppContext) {
  const app = new Hono();

  app.post("/:agent", requireHookToken(ctx), async (c) => {
    const agentParam = AgentKindSchema.safeParse(c.req.param("agent"));
    if (!agentParam.success) return c.json({ ok: false, ignored: "unknown agent" }, 200);

    const parsed = HookEnvelopeSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, ignored: "bad payload" }, 200);

    const now = ctx.now();
    ctx.diagnostics.hookReceived(agentParam.data);
    const event = normalizeHook(agentParam.data, parsed.data, now);
    if (!event) {
      ctx.diagnostics.hookFinished("ignored");
      return c.json({ ok: true, applied: false, reason: "event ignored" }, 200);
    }

    const state = ctx.engine.applyEvent(event);
    if (!state) {
      ctx.diagnostics.hookFinished("unresolved");
      // 关联不到 surface：可能 Agent 不在 cmux 里，或者拓扑还没刷新。
      return c.json({ ok: true, applied: false, reason: "surface not resolved" }, 200);
    }
    ctx.diagnostics.hookFinished("applied");

    // 单个状态变化由 engine.onChange 推送，这里只补一条整表更新用于重排首页。
    ctx.hub.broadcast({ type: "agent.list_changed", inbox: ctx.engine.inbox() });
    ctx.poller?.scheduleImmediate(state.surfaceId);

    return c.json({ ok: true, applied: true, status: state.status }, 200);
  });

  return app;
}
