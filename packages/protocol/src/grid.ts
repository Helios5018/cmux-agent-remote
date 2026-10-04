import { z } from "zod";

/**
 * 终端渲染网格（来自 cmux 的 `terminal.replay` / `cmux.render-grid.v1`）。
 *
 * 为什么不用纯文本：`cmux read-screen` 只返回 plain text，颜色、粗体、反显、
 * 光标、全屏 TUI 状态在那一层就已经丢了；而且纯文本没有「每个字符占几格」的
 * 信息，浏览器字体的中文宽度未必正好是 2 倍，逐行会累积错位。
 *
 * 网格里每段都带 `cells`（终端真实格子数），前端按格子定位，不依赖字体度量。
 *
 * 传输上做了紧凑化：span 用数组元组、样式抽成表、纯空白且默认样式的段直接丢掉，
 * 111×62 的一屏从 69 KB 压到 13 KB（gzip 后约 4 KB）。
 */

/** 一段连续同样式的文本：[行, 起始列, 样式 id, 文本, 占用格子数]。 */
export const GridSpanSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.string(),
  z.number().int().nonnegative(),
]);
export type GridSpan = z.infer<typeof GridSpanSchema>;

export const GRID_SPAN_ROW = 0;
export const GRID_SPAN_COLUMN = 1;
export const GRID_SPAN_STYLE = 2;
export const GRID_SPAN_TEXT = 3;
export const GRID_SPAN_CELLS = 4;

/** 样式表条目。与默认前景 / 背景相同的颜色会被省略，减少体积。 */
export const GridStyleSchema = z.object({
  /** 前景色 #rrggbb，省略表示用终端默认前景。 */
  f: z.string().optional(),
  /** 背景色 #rrggbb，省略表示用终端默认背景。 */
  b: z.string().optional(),
  bold: z.boolean().optional(),
  faint: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  inverse: z.boolean().optional(),
  strike: z.boolean().optional(),
});
export type GridStyle = z.infer<typeof GridStyleSchema>;

export const GridCursorSchema = z.object({
  /** 绝对行号（含 scrollback 偏移）。 */
  row: z.number().int(),
  column: z.number().int().nonnegative(),
  visible: z.boolean(),
});
export type GridCursor = z.infer<typeof GridCursorSchema>;

export const SurfaceGridSchema = z.object({
  surfaceId: z.string(),
  /** 终端列数。 */
  columns: z.number().int().positive(),
  /** 可见视口行数。 */
  viewportRows: z.number().int().nonnegative(),
  /** 本次一并返回的回滚行数（cmux 固定给最近 240 行）。 */
  scrollbackRows: z.number().int().nonnegative(),
  /** 该 surface 总共还有多少行历史，用于判断能不能继续往上翻。 */
  historyRows: z.number().int().nonnegative(),
  /** 终端当前已经上滚了多少行；> 0 表示看到的不是最新一屏。 */
  scrolledRows: z.number().int().nonnegative(),
  /**
   * 是否处于备用屏（全屏 TUI，例如 Claude / Grok 的界面）。
   * 备用屏必须按网格等比缩放，普通屏可以软换行。
   */
  altScreen: z.boolean(),
  /** 终端默认前景 / 背景。 */
  foreground: z.string(),
  background: z.string(),
  cursorColor: z.string().optional(),
  cursor: GridCursorSchema,
  styles: z.array(GridStyleSchema),
  /** 行号是绝对坐标：0 .. scrollbackRows + viewportRows - 1。 */
  spans: z.array(GridSpanSchema),
  /** 内容指纹变化才自增，用于避免重复推送。 */
  revision: z.number().int().nonnegative(),
  fetchedAt: z.number(),
});
export type SurfaceGrid = z.infer<typeof SurfaceGridSchema>;

/** 绝对行号 → 是否属于可见视口。 */
export function isViewportRow(grid: SurfaceGrid, row: number): boolean {
  return row >= grid.scrollbackRows;
}

/** 网格一共有多少行。 */
export function gridRowCount(grid: SurfaceGrid): number {
  return grid.scrollbackRows + grid.viewportRows;
}

/**
 * 网格之外还剩多少行历史拿不到。
 *
 * `terminal.replay` 每次固定只带最近 240 行回滚，更早的部分要另走
 * `read-screen --scrollback`（纯文本，没有颜色）。备用屏没有 scrollback，
 * 这里恒为 0 —— 那种情况只能靠翻页键让 TUI 自己重画。
 */
export function gridMissingHistoryRows(grid: SurfaceGrid): number {
  return Math.max(0, grid.historyRows - grid.scrollbackRows);
}
