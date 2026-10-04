import { resolvePaneCwd } from "../cmux/cwd.ts";
import { FileService } from "../services/files.ts";
import { Hono } from "hono";
import { apiError, type AppContext } from "../context.ts";
import type { Env } from "../security/middleware.ts";

/** GET /api/agents —— 首页 Attention Inbox。 */
export function createAgentRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.get("/", (c) => c.json(ctx.engine.inbox()));

  app.get("/:surfaceId", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    const agent = ctx.engine.get(surfaceId);
    if (!agent) return c.json(apiError("NOT_FOUND", `没有找到 Agent: ${surfaceId}`), 404);

    // 打开会话即视为已读：RESPONDED_UNREAD → IDLE
    // markViewed 触发的状态变化由 engine.onChange 推送给所有客户端
    const updated = ctx.engine.markViewed(surfaceId) ?? agent;

    let snapshot = null;
    try {
      snapshot = await ctx.client.readSurface(surfaceId);

    } catch {
      // 读不到内容不影响状态展示。
    }

    return c.json({ agent: updated, snapshot });
  });

  app.get("/:surfaceId/cwd", async (c) => {
    const tree = await ctx.client.getTree();
    for (const workspace of tree.workspaces) for (const pane of workspace.panes) {
      const surface = pane.surfaces.find((s) => s.id === c.req.param("surfaceId"));
      if (!surface) continue;
      const path = await (ctx.paneCwd ?? resolvePaneCwd)({ ...pane, surfaces: [surface] });
      try { return c.json({ path: path ? await new FileService().directory(path) : null }); }
      catch { return c.json({ path: null }); }
    }
    return c.json({ path: null });
  });

  /** 显式标记已读。 */
  app.post("/:surfaceId/read", (c) => {
    const surfaceId = c.req.param("surfaceId");
    const updated = ctx.engine.markViewed(surfaceId);
    if (!updated) return c.json(apiError("NOT_FOUND", `没有找到 Agent: ${surfaceId}`), 404);
    ctx.hub.broadcast({ type: "agent.list_changed", inbox: ctx.engine.inbox() });
    return c.json({ ok: true as const, agent: updated });
  });

  return app;
}
