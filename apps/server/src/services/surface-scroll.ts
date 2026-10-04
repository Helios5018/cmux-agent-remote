import type { ScrollKey, SurfaceGrid } from "@car/protocol";
import { sleep } from "@car/shared";
import type { AppContext } from "../context.ts";

/** 翻一屏，等 TUI 重绘完再截图 —— 读太快会拿到翻页前的旧画面。 */
export async function scrollOnce(ctx: AppContext, surfaceId: string, key: ScrollKey): Promise<SurfaceGrid> {
  await ctx.client.scrollSurface(surfaceId, key);
  await sleep(ctx.config.scrollRedrawDelayMs);
  return ctx.client.readGrid(surfaceId);
}

/**
 * 回到最新一屏。
 *
 * TUI 没有通用的「跳到底部」键（实测 Claude Code 收到 `end` 画面不动），
 * 只能连按 pagedown 直到画面不再变化。revision 只在内容变化时自增，
 * 拿它当「到底了」的判据；步数封顶兜住「Agent 正在刷输出，画面一直在变」。
 */
export async function scrollToBottom(ctx: AppContext, surfaceId: string): Promise<SurfaceGrid> {
  let grid = await ctx.client.readGrid(surfaceId);
  for (let step = 0; step < SCROLL_TO_BOTTOM_MAX_STEPS; step += 1) {
    const next = await scrollOnce(ctx, surfaceId, "pagedown");
    if (next.revision === grid.revision) return next;
    grid = next;
  }
  return grid;
}

const SCROLL_TO_BOTTOM_MAX_STEPS = 12;

