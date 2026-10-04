import type { GridSpan, GridStyle, SurfaceGrid } from "@car/protocol";
import { fingerprint } from "@car/shared";

/**
 * 把 cmux 的 `cmux.render-grid.v1` 原始 JSON 转成前端用的紧凑网格。
 *
 * 原始格式一屏 69 KB，主要浪费在：每个 span 都是带长字段名的对象、
 * 样式表里一堆用不到的布尔位、以及大量「纯空格 + 默认样式」的填充段。
 * 这里全部压掉，实测降到 13 KB（gzip 约 4 KB）。
 */

type Json = Record<string, unknown>;

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter((x) => typeof x === "object" && x !== null) as Json[]) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class GridParseError extends Error {}

interface RawSpan {
  row: number;
  column: number;
  styleId: number;
  text: string;
  cells: number;
}

function parseSpan(raw: Json): RawSpan | null {
  const row = num(raw["row"]);
  const column = num(raw["column"]);
  const text = typeof raw["text"] === "string" ? raw["text"] : undefined;
  if (row === undefined || column === undefined || text === undefined) return null;
  return {
    row,
    column,
    styleId: num(raw["style_id"]) ?? 0,
    text,
    // cell_width 是终端真实格子数（中文 2 格），缺失时退回字符数
    cells: num(raw["cell_width"]) ?? text.length,
  };
}

/** 样式表：与终端默认色相同的颜色省略掉，布尔位只留为 true 的。 */
function compactStyles(raw: Json[], foreground: string, background: string): GridStyle[] {
  const styles: GridStyle[] = [];
  for (const entry of raw) {
    const id = num(entry["id"]);
    const style: GridStyle = {};
    const f = str(entry["foreground"]);
    const b = str(entry["background"]);
    if (f && f !== foreground) style.f = f;
    if (b && b !== background) style.b = b;
    if (entry["bold"] === true) style.bold = true;
    if (entry["faint"] === true) style.faint = true;
    if (entry["italic"] === true) style.italic = true;
    if (entry["underline"] === true) style.underline = true;
    if (entry["inverse"] === true) style.inverse = true;
    if (entry["strikethrough"] === true) style.strike = true;
    // cmux 的 id 是从 0 开始的连续下标，按位置放回去
    styles[id ?? styles.length] = style;
  }
  for (let i = 0; i < styles.length; i += 1) styles[i] ??= {};
  return styles;
}

/**
 * 纯空白且没有任何可见效果的段可以丢掉 —— 前端按终端默认背景铺底即可。
 * 注意带背景色 / 下划线 / 反显的空白是有意义的（色条、选中态），必须保留。
 */
function isDroppableBlank(span: RawSpan, styles: GridStyle[]): boolean {
  if (span.text.trim().length > 0) return false;
  const style = styles[span.styleId];
  if (!style) return true;
  return !style.b && !style.underline && !style.inverse && !style.strike;
}

export interface ParseGridOptions {
  surfaceId: string;
  now: number;
  /** 上一版的指纹与 revision，内容没变就不自增 revision。 */
  previous?: { fingerprint: string; revision: number };
}

export interface ParsedGrid {
  grid: SurfaceGrid;
  fingerprint: string;
}

export function parseRenderGrid(raw: unknown, options: ParseGridOptions): ParsedGrid {
  const root = (raw ?? {}) as Json;
  const gridRaw = (root["render_grid"] ?? {}) as Json;
  const columns = num(gridRaw["columns"]) ?? num(root["columns"]);
  if (!columns || columns <= 0) {
    throw new GridParseError("render_grid 缺少 columns");
  }

  const foreground = str(gridRaw["terminal_foreground"]) ?? "#d8dee9";
  const background = str(gridRaw["terminal_background"]) ?? "#0d1014";
  const styles = compactStyles(asArray(gridRaw["styles"]), foreground, background);

  const viewportRows = num(gridRaw["rows"]) ?? num(root["rows"]) ?? 0;
  const scrollbackRows = num(gridRaw["scrollback_rows"]) ?? 0;
  const scrolledRows = num(gridRaw["scrolled_rows"]) ?? 0;

  const spans: GridSpan[] = [];
  const push = (span: RawSpan | null, rowOffset: number) => {
    if (!span) return;
    if (isDroppableBlank(span, styles)) return;
    spans.push([span.row + rowOffset, span.column, span.styleId, span.text, span.cells]);
  };

  // 回滚在上（绝对行 0..scrollbackRows-1），视口在下
  for (const item of asArray(gridRaw["scrollback_spans"])) push(parseSpan(item), 0);
  for (const item of asArray(gridRaw["row_spans"])) push(parseSpan(item), scrollbackRows);

  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cursorRaw = (gridRaw["cursor"] ?? {}) as Json;
  const cursor = {
    row: (num(cursorRaw["row"]) ?? 0) + scrollbackRows,
    column: num(cursorRaw["column"]) ?? 0,
    visible: cursorRaw["visible"] === true,
  };

  // 指纹只覆盖会影响画面的部分：样式表 + 段 + 光标 + 滚动位置
  // （翻到顶之后再按上一页，画面可能一模一样，靠 scrolledRows 才知道位置变了）
  const print = fingerprint(
    JSON.stringify([styles, spans, cursor, columns, viewportRows, scrollbackRows, scrolledRows]),
  );
  const revision =
    options.previous && options.previous.fingerprint === print
      ? options.previous.revision
      : (options.previous?.revision ?? 0) + 1;

  return {
    fingerprint: print,
    grid: {
      surfaceId: options.surfaceId,
      columns,
      viewportRows,
      scrollbackRows,
      historyRows: num(gridRaw["history_rows"]) ?? 0,
      scrolledRows,
      altScreen: str(gridRaw["active_screen"]) === "alternate",
      foreground,
      background,
      cursorColor: str(gridRaw["terminal_cursor_color"]),
      cursor,
      styles,
      spans,
      revision,
      fetchedAt: options.now,
    },
  };
}

/** 每个 surface 记住上一版指纹，避免内容没变还反复推送。 */
export class GridTracker {
  private readonly last = new Map<string, { fingerprint: string; revision: number }>();

  parse(raw: unknown, surfaceId: string, now: number): SurfaceGrid {
    const previous = this.last.get(surfaceId);
    const parsed = parseRenderGrid(raw, { surfaceId, now, previous });
    this.last.set(surfaceId, { fingerprint: parsed.fingerprint, revision: parsed.grid.revision });
    return parsed.grid;
  }

  forget(surfaceId: string): void {
    this.last.delete(surfaceId);
  }
}
