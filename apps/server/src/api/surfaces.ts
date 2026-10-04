import { z } from "zod";
import { ContextTopologyError, readSurfaceContext } from "../services/surface-context.ts";
import { sleep } from "@car/shared";
import { scrollOnce, scrollToBottom } from "../services/surface-scroll.ts";
import { Hono } from "hono";
import {
  CloseSurfaceRequestSchema,
  CreateSurfaceRequestSchema,
  isDangerousKey,
  RenameTitleRequestSchema,
  SurfaceInputRequestSchema,
  SurfaceKeyRequestSchema,
  SurfaceScrollRequestSchema,
  type CmuxPane,
  type CmuxWorkspace,
  type CreateSurfaceResponse,
  type ScrollKey,
  type SurfaceGrid,
} from "@car/protocol";
import { apiError, type AppContext } from "../context.ts";
import { CmuxError } from "../cmux/client.ts";
import { resolvePaneCwd } from "../cmux/cwd.ts";
import { safeJson } from "./http.ts";

/**
 * Surface 读写。
 * 所有写操作都在 URL 里显式指定 surface，服务端不存在 "current terminal" 概念。
 */
export function createSurfaceRoutes(ctx: AppContext) {
  const app = new Hono();

  /**
   * 在指定 pane 里新建一个 terminal surface，可选顺手起一个 Agent。
   *
   * 挂在集合根上而不是 /:surfaceId/xxx —— 建之前还没有 surface。
   * 但「写操作必须显式指定目标」的规矩照旧：paneId 必填，且必须在当前拓扑里真实存在。
   */
  app.post("/", async (c) => {
    const parsed = CreateSurfaceRequestSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json(apiError("BAD_REQUEST", "参数不合法"), 400);
    const { paneId, workspaceId, launch } = parsed.data;

    let created: CreateSurfaceResponse;
    try {
      // 先在拓扑里核对一遍：不认识的 pane 直接挡掉，不要把随手传的字符串丢给 CLI。
      const tree = await ctx.client.getTree();
      const found = findPane(tree.workspaces, paneId, workspaceId);
      if (!found) return c.json(apiError("NOT_FOUND", `pane 不存在: ${paneId}`), 404);

      const cwd = (await (ctx.paneCwd ?? resolvePaneCwd)(found.pane)) ?? undefined;
      const surface = await ctx.client.createSurface({
        paneId: found.pane.id ?? found.pane.ref,
        workspaceId: found.workspaceId,
        cwd,
      });

      let launchError: CreateSurfaceResponse["launchError"];
      if (launch) {
        // 新 shell 刚被唤醒，还在跑 .zshrc；太早打字有可能被吞掉。
        await sleep(LAUNCH_DELAY_MS);
        // 命令来自服务端白名单，前端只能选 claude/codex/grok/pi。
        let textWritten = false;
        try {
          await ctx.client.sendText(surface.surfaceId, ctx.config.launchCommands[launch]);
          textWritten = true;
          await ctx.client.sendKey(surface.surfaceId, "enter");
        } catch {
          launchError = {
            stage: textWritten ? "submit_unknown" : "text_unknown",
            message: textWritten
              ? "tab 已创建，启动命令已写入，但回车结果未知。请打开会话核对；若命令仍在输入行，仅补发 Enter。"
              : "tab 已创建，启动命令写入结果未知。请打开会话核对后继续启动，不要重复新建。",
          };
        }
      }

      created = {
        ok: true,
        surfaceId: surface.surfaceId,
        surfaceRef: surface.surfaceRef,
        paneId: surface.paneId ?? found.pane.id,
        workspaceId: surface.workspaceId ?? found.workspaceId,
        cwd: cwd ?? null,
        launched: launchError ? null : launch,
        ...(launchError ? { launchError } : {}),
      };
    } catch (error) {
      return handleCmuxError(c, error);
    }

    ctx.store.audit({
      at: ctx.now(),
      action: "surface.create",
      surfaceId: created.surfaceId,
      detail: `pane=${paneId} launch=${launch ?? "none"} cwd=${created.cwd ?? "default"}${created.launchError ? ` launchError=${created.launchError.stage}` : ""}`,
    });
    // 新 tab 里可能已经在起 Agent，尽快让它进入轮询和状态推断。
    ctx.poller?.scheduleImmediate(created.surfaceId);

    return c.json(created, 201);
  });

  app.get("/:surfaceId/context", async c => {
    c.header("Cache-Control", "no-store");
    const id = z.string().uuid().safeParse(c.req.param("surfaceId"));
    if (!id.success) return c.json(apiError("BAD_REQUEST", "需要 surface UUID"), 400);
    try {
      const context = await readSurfaceContext(ctx, id.data);
      return context ? c.json(context) : c.json(apiError("NOT_FOUND", "surface 不存在"), 404);
    } catch (error) {
      if (error instanceof ContextTopologyError) return c.json(apiError("CMUX_UNAVAILABLE", "无法读取 cmux 拓扑"), 503);
      throw error;
    }
  });

  app.get("/:surfaceId/output", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    try {
      const snapshot = await ctx.client.readSurface(surfaceId, {
        lines: Number(c.req.query("lines") ?? ctx.config.maxOutputLines) || ctx.config.maxOutputLines,
        scrollback: c.req.query("scrollback") === "1",
      });

      return c.json(snapshot);
    } catch (error) {
      return handleCmuxError(c, error);
    }
  });

  /** 彩色渲染网格：颜色、粗体、反显、光标、格子宽度都在这里。 */
  app.get("/:surfaceId/grid", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    try {
      const grid = await ctx.client.readGrid(surfaceId);

      return c.json(grid);
    } catch (error) {
      return handleCmuxError(c, error);
    }
  });

  /**
   * 网格之外更早的历史（纯文本、无颜色）。
   *
   * `terminal.replay` 每次只带最近 240 行回滚，再往上只有 `read-screen --scrollback`。
   * `drop` 由前端传当前网格已经画出来的行数，避免和网格重复。
   */
  app.get("/:surfaceId/history", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    const lines = clampInt(c.req.query("lines"), ctx.config.maxHistoryLines, 1, ctx.config.maxHistoryLines);
    const drop = clampInt(c.req.query("drop"), 0, 0, Number.MAX_SAFE_INTEGER);
    try {
      const text = await ctx.client.readHistory(surfaceId, lines);
      const all = text.length > 0 ? text.split("\n") : [];
      const kept = all.slice(0, Math.max(0, all.length - drop));
      return c.json({
        text: kept.join("\n"),
        totalLines: all.length,
        droppedTail: all.length - kept.length,
        truncated: all.length >= lines,
      });
    } catch (error) {
      return handleCmuxError(c, error);
    }
  });

  /**
   * 翻页。不往终端写任何东西，只是让终端 / TUI 换一屏来画。
   */
  app.post("/:surfaceId/scroll", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    const parsed = SurfaceScrollRequestSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json(apiError("BAD_REQUEST", "不支持的翻页动作"), 400);
    const { action } = parsed.data;

    try {
      const grid =
        action === "bottom"
          ? await scrollToBottom(ctx, surfaceId)
          : await scrollOnce(ctx, surfaceId, action);
      ctx.store.audit({ at: ctx.now(), action: "surface.scroll", surfaceId, detail: action });
      return c.json({ ok: true as const, grid });
    } catch (error) {
      return handleCmuxError(c, error);
    }
  });

  app.post("/:surfaceId/input", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    const parsed = SurfaceInputRequestSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json(apiError("BAD_REQUEST", "参数不合法"), 400);

    const { text, submit } = parsed.data;
    if (text.length === 0 && !submit) {
      return c.json(apiError("BAD_REQUEST", "内容为空"), 400);
    }

    let textWritten = false;
    try {
      if (text.length > 0) {
        await ctx.client.sendText(surfaceId, text, { bracketedPaste: ctx.engine.get(surfaceId)?.agent === "codex" });
        textWritten = true;
      }
      if (submit) await ctx.client.sendKey(surfaceId, "enter");
    } catch (error) {
      if (!textWritten && error instanceof CmuxError && error.code === "SURFACE_NOT_FOUND") {
        return handleCmuxError(c, error);
      }
      // 超时/命令报错可能发生在执行之后，不能声称「没发出去」。
      const code = textWritten ? "INPUT_TEXT_WRITTEN_SUBMIT_UNKNOWN" : "INPUT_DELIVERY_UNKNOWN";
      ctx.store.audit({ at: ctx.now(), action: "surface.input_uncertain", surfaceId,
        detail: `len=${text.length} submit=${submit} stage=${code}` });
      ctx.poller?.scheduleImmediate(surfaceId);
      return c.json(apiError(code, textWritten
        ? "文本已写入，提交结果未知。请先核对终端，避免重复发送正文。"
        : "发送结果未知。请先核对终端，避免重复输入。"), 500);
    }

    ctx.store.audit({
      at: ctx.now(),
      action: "surface.input",
      surfaceId,
      // 审计只记录长度，不落 prompt 原文。
      detail: `len=${text.length} submit=${submit}`,
    });

    const updated = ctx.engine.noteUserInput(surfaceId, submit);
    if (updated) {
      ctx.hub.broadcast({ type: "agent.list_changed", inbox: ctx.engine.inbox() });
    }
    ctx.poller?.scheduleImmediate(surfaceId);

    return c.json({ ok: true as const });
  });

  app.post("/:surfaceId/title", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    const parsed = RenameTitleRequestSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json(apiError("BAD_REQUEST", "名称不合法"), 400);

    try {
      await ctx.client.renameSurface(surfaceId, parsed.data.title);
      const tree = await ctx.client.getTree();
      ctx.engine.syncTree(tree);
    } catch (error) {
      return handleCmuxError(c, error);
    }

    ctx.store.audit({
      at: ctx.now(),
      action: "surface.rename",
      surfaceId,
      detail: `len=${parsed.data.title.length}`,
    });
    ctx.hub.broadcast({ type: "agent.list_changed", inbox: ctx.engine.inbox() });
    return c.json({ ok: true as const });
  });

  /**
   * 关掉 cmux 里的真实 tab。进程一起没，不是前端列表里藏起来。
   * workspace 最后一个 surface 关不掉（cmux `invalid_state`）。
   */
  app.post("/:surfaceId/close", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    const parsed = CloseSurfaceRequestSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) {
      return c.json(apiError("CONFIRM_REQUIRED", "关闭 surface 需要二次确认"), 428);
    }

    let workspaceId: string | undefined;
    try {
      const tree = await ctx.client.getTree();
      const found = findSurfaceInTree(tree.workspaces, surfaceId);
      if (!found) return c.json(apiError("NOT_FOUND", `surface 不存在: ${surfaceId}`), 404);
      const total = found.workspace.panes.reduce((sum, pane) => sum + pane.surfaces.length, 0);
      if (total <= 1) {
        return c.json(apiError("LAST_SURFACE", "这是这个 workspace 里最后一个 surface，cmux 不允许关掉"), 409);
      }
      workspaceId = found.workspace.id;
      await ctx.client.closeSurface(surfaceId, workspaceId);
      const next = await ctx.client.getTree();
      ctx.engine.syncTree(next);
    } catch (error) {
      return handleCmuxError(c, error);
    }

    ctx.store.audit({ at: ctx.now(), action: "surface.close", surfaceId, detail: `workspace=${workspaceId}` });
    ctx.hub.broadcast({ type: "agent.list_changed", inbox: ctx.engine.inbox() });
    return c.json({ ok: true as const });
  });

  app.post("/:surfaceId/key", async (c) => {
    const surfaceId = c.req.param("surfaceId");
    const parsed = SurfaceKeyRequestSchema.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) {
      return c.json(apiError("BAD_REQUEST", "不支持的按键"), 400);
    }
    const { key, confirm, repeat } = parsed.data;

    // 危险操作必须二次确认。
    if (isDangerousKey(key) && confirm !== true) {
      return c.json(apiError("CONFIRM_REQUIRED", `${key} 需要二次确认`), 428);
    }

    try {
      await ctx.client.sendKey(surfaceId, key);
      if (repeat === 2) {
        // Pi 要求两次 Ctrl+C 间隔小于 500 ms。分开发送，避免 TUI 合并输入事件。
        await new Promise((resolve) => setTimeout(resolve, 100));
        await ctx.client.sendKey(surfaceId, key);
      }
    } catch (error) {
      return handleCmuxError(c, error);
    }

    ctx.store.audit({ at: ctx.now(), action: "surface.key", surfaceId, detail: repeat === 2 ? `${key} x2` : key });
    ctx.poller?.scheduleImmediate(surfaceId);
    return c.json({ ok: true as const });
  });

  return app;
}

/** 按 UUID 或 pane:N 短引用找 pane；短引用会重复，所以带 workspace 时先缩范围。 */
function findPane(
  workspaces: Array<{ id: string; ref: string; panes: CmuxPane[] }>,
  paneId: string,
  workspaceId?: string,
): { pane: CmuxPane; workspaceId: string } | null {
  for (const workspace of workspaces) {
    if (workspaceId && workspace.id !== workspaceId && workspace.ref !== workspaceId) continue;
    for (const pane of workspace.panes) {
      if (pane.id === paneId || pane.ref === paneId) return { pane, workspaceId: workspace.id };
    }
  }
  return null;
}

/** 新建 surface 后等 shell 初始化完再敲启动命令。 */
const LAUNCH_DELAY_MS = 150;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function handleCmuxError(
  c: { json: (body: unknown, status?: 400 | 404 | 409 | 500 | 503) => Response },
  error: unknown,
) {
  if (error instanceof CmuxError) {
    if (error.code === "LAST_SURFACE") {
      return c.json(apiError("LAST_SURFACE", error.message), 409);
    }
    if (error.code === "SURFACE_NOT_FOUND" || error.code === "PANE_NOT_FOUND" || error.code === "WORKSPACE_NOT_FOUND") {
      return c.json(apiError("NOT_FOUND", error.message), 404);
    }
    return c.json(apiError("CMUX_UNAVAILABLE", error.message), 503);
  }
  return c.json(apiError("INTERNAL", "cmux 操作失败"), 500);
}

/** 按 UUID 或 surface:N 短引用找 surface，并带回所属 workspace。 */
function findSurfaceInTree(
  workspaces: CmuxWorkspace[],
  surfaceId: string,
): { workspace: CmuxWorkspace } | null {
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      if (pane.surfaces.some((surface) => surface.id === surfaceId || surface.ref === surfaceId)) {
        return { workspace };
      }
    }
  }
  return null;
}
