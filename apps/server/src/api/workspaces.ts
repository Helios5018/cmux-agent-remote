import { FileService } from "../services/files.ts";
import { sleep } from "@car/shared";
import { Hono } from "hono";
import { CreateWorkspaceRequestSchema, CloseTopologyRequestSchema, RenameTitleRequestSchema } from "@car/protocol";
import { apiError, type AppContext } from "../context.ts";
import { CmuxError } from "../cmux/client.ts";
import { type Env } from "../security/middleware.ts";
import { safeJson } from "./http.ts";

/** GET /api/tree —— cmux 真实结构：Workspace → Pane → Surface。 */
export function createWorkspaceRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.get("/", async (c) => {
    try {
      const tree = await ctx.client.getTree();
      // 顺带把最新拓扑喂给 State Engine，页面刷新即可纠正状态。
      ctx.engine.syncTree(tree);
      return c.json(tree);
    } catch (error) {
      if (error instanceof CmuxError) {
        return c.json(apiError("CMUX_UNAVAILABLE", error.message), 503);
      }
      return c.json(apiError("INTERNAL", "获取 cmux 拓扑失败"), 500);
    }
  });

  return app;
}

/** POST /api/workspaces/:workspaceId/title —— 改 cmux workspace 的真实名字。 */
export function createWorkspaceWriteRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  async function created(surface: Awaited<ReturnType<AppContext["client"]["createWorkspace"]>>, action: string) {
    ctx.store.audit({ at: ctx.now(), action, surfaceId: surface.surfaceId,
      detail: `workspace=${surface.workspaceId}` });
    ctx.engine.syncTree(await ctx.client.getTree());
    ctx.hub.broadcast({ type: "agent.list_changed", inbox: ctx.engine.inbox() });
    ctx.poller?.scheduleImmediate(surface.surfaceId);
    return { ok: true as const, ...surface };
  }

  app.post("/", async (c) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json(apiError("BAD_REQUEST", "请选择有效工作目录和 launch 类型"), 400);
    let cwd: string;
    try { cwd = await new FileService().directory(parsed.data.cwd); }
    catch { return c.json(apiError("BAD_REQUEST", "目录不存在或无法访问，请重新选择文件夹"), 400); }
    if (/[\x00-\x1f\x7f]/.test(cwd)) return c.json(apiError("BAD_REQUEST", "目录不能包含控制字符"), 400);
    try {
      const tree = await ctx.client.getTree();
      const windowId = (tree.workspaces.find(w => w.selected) ?? tree.workspaces[0])?.windowRef;
      const surface = await ctx.client.createWorkspace(windowId);
      let launchError: string | undefined;
      let textWritten = false;
      try {
        await sleep(150);
        // 单引号转义目录；只有 cd 成功才执行服务端白名单里的 Agent 命令。
        const quoted = "'" + cwd.replaceAll("'", "'\\''") + "'";
        const command = `cd -- ${quoted}` + (parsed.data.launch ? ` && ${ctx.config.launchCommands[parsed.data.launch]}` : "");
        await ctx.client.sendText(surface.surfaceId, command);
        textWritten = true;
        await ctx.client.sendKey(surface.surfaceId, "enter");
      } catch {
        launchError = textWritten
          ? "Workspace 已创建，初始化命令已写入，但回车结果未知。请检查画面；若命令仍在输入行，仅补 Enter，不要重发正文，也不要重复创建。"
          : "Workspace 已创建，初始化命令写入结果未知。请打开会话检查，不要重发正文，也不要重复创建。";
      }
      try { await created(surface, "workspace.create"); }
      catch { launchError ??= "Workspace 已创建，列表刷新失败。请打开会话检查。"; }
      return c.json({ ok: true as const, ...surface, ...(launchError ? { launchError } : {}) }, 201);
    } catch (error) {
      return c.json(apiError("CMUX_UNAVAILABLE", error instanceof Error ? error.message : "增加 workspace 失败"), 503);
    }
  });

  app.post("/:workspaceId/panes", async (c) => {
    try {
      const tree = await ctx.client.getTree();
      const id = c.req.param("workspaceId");
      const workspace = tree.workspaces.find(w => w.id === id || w.ref === id);
      if (!workspace) return c.json(apiError("NOT_FOUND", "workspace 不存在"), 404);
      const pane = workspace.panes.find(p => p.focused) ?? workspace.panes[0];
      const surface = pane?.surfaces.find(s => s.selected) ?? pane?.surfaces[0];
      if (!surface) return c.json(apiError("NOT_FOUND", "workspace 没有可分屏的 surface"), 404);
      return c.json(await created(await ctx.client.createPane(workspace.id, surface.id), "pane.create"), 201);
    } catch (error) {
      return c.json(apiError("CMUX_UNAVAILABLE", error instanceof Error ? error.message : "增加 pane 失败"), 503);
    }
  });

  // pane 没有可用的整体关闭 RPC：逐个关闭确认范围内的 surface，最后一个关闭时分屏自动移除。
  for (const scope of ["workspace", "pane"] as const) {
    const path = scope === "workspace" ? "/:workspaceId/close" : "/:workspaceId/panes/:paneId/close";
    app.post(path, async (c) => {
      const parsed = CloseTopologyRequestSchema.safeParse(await safeJson(c.req.raw));
      if (!parsed.success) return c.json(apiError("CONFIRM_REQUIRED", "请确认关闭范围后再操作"), 428);
      const closedSurfaceIds: string[] = [];
      try {
        const tree = await ctx.client.getTree(true);
        const workspace = tree.workspaces.find(w => w.id === c.req.param("workspaceId"));
        if (!workspace) return c.json(apiError("NOT_FOUND", "workspace 已不存在，请刷新"), 404);
        const pane = scope === "pane" ? workspace.panes.find(p => (p.id ?? p.ref) === c.req.param("paneId")) : undefined;
        if (scope === "pane" && !pane) return c.json(apiError("NOT_FOUND", "pane 已不存在，请重新选择"), 404);
        if (scope === "pane" && workspace.panes.length <= 1) {
          return c.json(apiError("LAST_PANE", "这是最后一个 pane，请使用关闭 workspace"), 409);
        }
        const ids = (pane ? pane.surfaces : workspace.panes.flatMap(p => p.surfaces)).map(s => s.id);
        const confirmed = new Set(parsed.data.surfaceIds);
        if (ids.length !== confirmed.size || !ids.every(id => confirmed.has(id))) {
          return c.json(apiError("TOPOLOGY_CHANGED", "终端列表已变化，请取消并重新查看关闭范围"), 409);
        }
        if (scope === "workspace") {
          await ctx.client.closeWorkspace(workspace.id);
          closedSurfaceIds.push(...ids);
        } else {
          for (const id of ids) {
            await ctx.client.closeSurface(id, workspace.id);
            closedSurfaceIds.push(id);
          }
        }
        ctx.store.audit({ at: ctx.now(), action: `${scope}.close`,
          detail: `workspace=${workspace.id} pane=${pane?.id ?? pane?.ref ?? "all"} count=${closedSurfaceIds.length}` });
        return c.json({ ok: true as const });
      } catch (error) {
        ctx.store.audit({ at: ctx.now(), action: `${scope}.close_failed`,
          detail: `workspace=${c.req.param("workspaceId")} closed=${closedSurfaceIds.length}` });
        const detail = error instanceof Error ? error.message : "cmux 操作失败";
        return c.json(apiError("CMUX_UNAVAILABLE", `关闭未完成（已关闭 ${closedSurfaceIds.length} 个 surface）：${detail}。请取消并刷新查看剩余项。`), 503);
      } finally {
        // 部分成功也要同步，防止已关闭的终端继续显示为运行中。
        try {
          ctx.engine.syncTree(await ctx.client.getTree());
          ctx.hub.broadcast({ type: "agent.list_changed", inbox: ctx.engine.inbox() });
        } catch { /* 保留原始关闭结果，后续轮询恢复。 */ }
      }
    });
  }

  app.post("/:workspaceId/title", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const parsed = RenameTitleRequestSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json(apiError("BAD_REQUEST", "名称不合法"), 400);

    try {
      const tree = await ctx.client.getTree();
      const found = tree.workspaces.find((workspace) => workspace.id === workspaceId || workspace.ref === workspaceId);
      if (!found) return c.json(apiError("NOT_FOUND", `workspace 不存在: ${workspaceId}`), 404);
      await ctx.client.renameWorkspace(found.id, parsed.data.title);
      ctx.engine.syncTree(await ctx.client.getTree());
    } catch (error) {
      if (error instanceof CmuxError) {
        if (error.code === "WORKSPACE_NOT_FOUND") {
          return c.json(apiError("NOT_FOUND", error.message), 404);
        }
        return c.json(apiError("CMUX_UNAVAILABLE", error.message), 503);
      }
      return c.json(apiError("INTERNAL", "改 workspace 名称失败"), 500);
    }

    ctx.store.audit({
      at: ctx.now(),
      action: "workspace.rename",
      detail: `workspace=${workspaceId} len=${parsed.data.title.length}`,
    });
    ctx.hub.broadcast({ type: "agent.list_changed", inbox: ctx.engine.inbox() });
    return c.json({ ok: true as const });
  });

  return app;
}
