import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GridSpan, GridStyle, SurfaceGrid } from "@car/protocol";
import {
  GRID_SPAN_CELLS,
  GRID_SPAN_COLUMN,
  GRID_SPAN_ROW,
  GRID_SPAN_STYLE,
  GRID_SPAN_TEXT,
} from "@car/protocol";

/**
 * 终端渲染网格。
 *
 * 为什么不直接 `<pre>{text}`：终端是固定的格子矩阵，中文占 2 格、框线字符占 1 格，
 * 而浏览器 fallback 字体的中文宽度未必正好是 2 倍，逐行会累积错位，TUI 边框就断了。
 * 这里每段都带 cmux 给的 `cells`（真实格子数），按 `left: 列 * 格宽` 绝对定位，
 * 完全不依赖字体度量。
 *
 * 两种排版模式（cmux 不允许第三方客户端改终端列数，只能在展示层适配）：
 *   fit  —— 整屏等比缩放到容器宽度，边框严格保真，全屏 TUI 用这个
 *   flow —— 按容器宽度软换行，普通命令输出用这个，手机上读着舒服
 */

export type GridLayout = "fit" | "flow";

/** 单个字符格的宽高比例，用探针实测后覆盖。 */
const FALLBACK_CELL_RATIO = 0.6;

/**
 * 基准字号。fit 模式下没法直接用字号（整屏要缩到屏宽），
 * 这里拿它当分母，把调字号换算成缩放倍数：1.0 就是正好铺满屏宽。
 */
export const DEFAULT_GRID_FONT_SIZE = 12.5;

interface Row {
  row: number;
  spans: GridSpan[];
}

function groupRows(grid: SurfaceGrid): Row[] {
  const byRow = new Map<number, GridSpan[]>();
  for (const span of grid.spans) {
    const row = span[GRID_SPAN_ROW];
    const list = byRow.get(row);
    if (list) list.push(span);
    else byRow.set(row, [span]);
  }
  const total = grid.scrollbackRows + grid.viewportRows;
  const rows: Row[] = [];
  for (let row = 0; row < total; row += 1) {
    rows.push({ row, spans: byRow.get(row) ?? [] });
  }
  // 顶部的空行没有信息量，直接裁掉，手机上少滚很多
  let start = 0;
  while (start < rows.length && (rows[start]?.spans.length ?? 0) === 0) start += 1;

  // 尾部同理。这一段对刚建出来的 tab 尤其重要：一个 62 行的空终端只有三行提示符，
  // 不裁的话页面自动滚到底看到的是一整屏空白，像是画面没加载出来。
  // 光标所在行要留着，否则看不见光标停在哪。
  const cursorRow = grid.cursor.visible ? grid.cursor.row : -1;
  let end = rows.length;
  while (end > start + 1 && (rows[end - 1]?.spans.length ?? 0) === 0 && rows[end - 1]?.row !== cursorRow) {
    end -= 1;
  }
  return rows.slice(start, end);
}

/**
 * flow 模式没有绝对定位，靠空格补回列间距。
 * （紧凑编码把「纯空白 + 默认样式」的段丢掉了，这里要还原缩进。）
 */
function withGaps(spans: GridSpan[]): Array<{ text: string; styleId: number | null }> {
  const out: Array<{ text: string; styleId: number | null }> = [];
  let column = 0;
  for (const span of spans) {
    const gap = span[GRID_SPAN_COLUMN] - column;
    if (gap > 0) out.push({ text: " ".repeat(gap), styleId: null });
    out.push({ text: span[GRID_SPAN_TEXT], styleId: span[GRID_SPAN_STYLE] });
    column = span[GRID_SPAN_COLUMN] + span[GRID_SPAN_CELLS];
  }
  return out;
}

function styleOf(style: GridStyle | undefined, grid: SurfaceGrid): React.CSSProperties {
  if (!style) return {};
  const fg = style.f ?? grid.foreground;
  const bg = style.b;
  const css: React.CSSProperties = {};
  // 反显就是前景背景对调，终端里用来做选中和高亮
  if (style.inverse) {
    css.color = bg ?? grid.background;
    css.background = fg;
  } else {
    if (style.f) css.color = fg;
    if (bg) css.background = bg;
  }
  if (style.bold) css.fontWeight = 700;
  if (style.faint) css.opacity = 0.6;
  if (style.italic) css.fontStyle = "italic";
  if (style.underline && style.strike) css.textDecoration = "underline line-through";
  else if (style.underline) css.textDecoration = "underline";
  else if (style.strike) css.textDecoration = "line-through";
  return css;
}

export function TerminalGrid({
  grid,
  layout,
  baseFontSize = DEFAULT_GRID_FONT_SIZE,
}: {
  grid: SurfaceGrid;
  layout: GridLayout;
  baseFontSize?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [cellRatio, setCellRatio] = useState(FALLBACK_CELL_RATIO);
  const [hostWidth, setHostWidth] = useState(0);

  // 实测一个字符在当前字体下的宽度，用来算缩放比例
  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    const width = probe.getBoundingClientRect().width / 100;
    if (width > 0) setCellRatio(width / baseFontSize);
  }, [baseFontSize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setHostWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => groupRows(grid), [grid]);

  // fit 模式：缩字号让 columns 列正好铺满容器宽度。
  // 调字号在这里变成缩放倍数 —— 手机上 120 列铺满屏宽只有 3px 高，
  // 想读清楚就得放大，代价是要横向滑动看完一行。
  const fitFontSize = Math.min(DEFAULT_GRID_FONT_SIZE, hostWidth / (grid.columns * cellRatio));
  const fontSize =
    layout === "fit" && hostWidth > 0
      ? Math.max(3, fitFontSize * (baseFontSize / DEFAULT_GRID_FONT_SIZE))
      : baseFontSize;
  const cellWidth = fontSize * cellRatio;

  return (
    <div className={`tgrid tgrid-${layout}`} ref={hostRef} style={{ background: grid.background }}>
      {/* 宽度探针：100 个 0 的实际宽度 ÷ 100 = 一格宽 */}
      <span className="tgrid-probe" ref={probeRef} style={{ fontSize: baseFontSize }} aria-hidden>
        {"0".repeat(100)}
      </span>

      <div
        className="tgrid-body"
        style={{
          fontSize,
          color: grid.foreground,
          width: layout === "fit" ? grid.columns * cellWidth : "100%",
        }}
      >
        {rows.map(({ row, spans }) =>
          layout === "fit" ? (
            <div className="tgrid-row" key={row}>
              {spans.map((span, index) => (
                <span
                  key={index}
                  className="tgrid-span"
                  style={{
                    ...styleOf(grid.styles[span[GRID_SPAN_STYLE]], grid),
                    left: span[GRID_SPAN_COLUMN] * cellWidth,
                    width: span[GRID_SPAN_CELLS] * cellWidth,
                  }}
                >
                  {span[GRID_SPAN_TEXT]}
                </span>
              ))}
              {grid.cursor.visible && grid.cursor.row === row ? (
                <span
                  className="tgrid-cursor"
                  style={{
                    left: grid.cursor.column * cellWidth,
                    width: cellWidth,
                    background: grid.cursorColor ?? grid.foreground,
                  }}
                />
              ) : null}
            </div>
          ) : (
            <div className="tgrid-line" key={row}>
              {spans.length === 0
                ? " "
                : withGaps(spans).map((piece, index) => (
                    <span
                      key={index}
                      style={piece.styleId === null ? undefined : styleOf(grid.styles[piece.styleId], grid)}
                    >
                      {piece.text}
                    </span>
                  ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
