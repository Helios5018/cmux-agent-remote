import { describe, expect, it } from "vitest";
import { GRID_SPAN_CELLS, GRID_SPAN_ROW, GRID_SPAN_TEXT, SurfaceGridSchema } from "@car/protocol";
import { GridTracker, parseRenderGrid } from "../src/cmux/grid.ts";
import { buildReplayArgs } from "../src/cmux/control.ts";

/** 按真实 `cmux rpc terminal.replay` 的结构造一份最小样本。 */
function sample(overrides: Record<string, unknown> = {}) {
  return {
    columns: 10,
    rows: 2,
    render_grid: {
      format: "cmux.render-grid.v1",
      active_screen: "alternate",
      columns: 10,
      rows: 2,
      scrollback_rows: 1,
      history_rows: 512,
      terminal_foreground: "#D8DEE9",
      terminal_background: "#2E3440",
      terminal_cursor_color: "#C8C8C8",
      cursor: { row: 1, column: 3, visible: true, style: "block", blinking: true },
      styles: [
        { id: 0, foreground: "#D8DEE9", background: "#2E3440", bold: false, underline: false },
        { id: 1, foreground: "#A3BE8C", background: "#2E3440", bold: true, underline: false },
        { id: 2, foreground: "#D8DEE9", background: "#BF616A", bold: false, inverse: true },
      ],
      scrollback_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 5, text: "old  " }],
      row_spans: [
        { row: 0, column: 0, style_id: 1, cell_width: 2, text: "ok" },
        // 中文一个字占两格：这就是纯文本还原不了的信息
        { row: 0, column: 2, style_id: 0, cell_width: 2, text: "好" },
        // 纯空格 + 默认样式，应该被丢掉
        { row: 1, column: 0, style_id: 0, cell_width: 4, text: "    " },
        // 纯空格但带背景色，是色条，必须保留
        { row: 1, column: 4, style_id: 2, cell_width: 3, text: "   " },
      ],
      ...(overrides["render_grid"] as object | undefined),
    },
    ...overrides,
  };
}

describe("终端渲染网格", () => {
  it("走 rpc 而不是 read-screen，参数是数组不过 shell", () => {
    expect(buildReplayArgs("sf-1")).toEqual([
      "rpc",
      "terminal.replay",
      JSON.stringify({ surface_id: "sf-1" }),
    ]);
    expect(() => buildReplayArgs("")).toThrow();
  });

  it("回滚在上、视口在下，行号拼成一套绝对坐标", () => {
    const { grid } = parseRenderGrid(sample(), { surfaceId: "sf-1", now: 1000 });
    expect(grid.scrollbackRows).toBe(1);
    expect(grid.viewportRows).toBe(2);
    // scrollback 的 row 0 保持 0，视口的 row 0 挪到 1
    const rows = grid.spans.map((span) => span[GRID_SPAN_ROW]);
    expect(Math.min(...rows)).toBe(0);
    expect(grid.spans.find((span) => span[GRID_SPAN_TEXT] === "ok")?.[GRID_SPAN_ROW]).toBe(1);
    // 光标行同样要加上偏移
    expect(grid.cursor.row).toBe(2);
    expect(grid.cursor.column).toBe(3);
  });

  it("保留中文的真实格子宽度", () => {
    const { grid } = parseRenderGrid(sample(), { surfaceId: "sf-1", now: 1000 });
    const cjk = grid.spans.find((span) => span[GRID_SPAN_TEXT] === "好");
    expect(cjk?.[GRID_SPAN_CELLS]).toBe(2);
  });

  it("丢掉无意义的空白段，但保留带背景色的空白", () => {
    const { grid } = parseRenderGrid(sample(), { surfaceId: "sf-1", now: 1000 });
    const blanks = grid.spans.filter((span) => span[GRID_SPAN_TEXT].trim() === "");
    expect(blanks).toHaveLength(1);
    expect(grid.styles[blanks[0]![2]]?.inverse).toBe(true);
  });

  it("样式表省略与终端默认相同的颜色", () => {
    const { grid } = parseRenderGrid(sample(), { surfaceId: "sf-1", now: 1000 });
    expect(grid.foreground).toBe("#D8DEE9");
    expect(grid.background).toBe("#2E3440");
    // style 0 与默认色完全相同 → 空对象
    expect(grid.styles[0]).toEqual({});
    expect(grid.styles[1]).toEqual({ f: "#A3BE8C", bold: true });
  });

  it("识别全屏 TUI", () => {
    const alt = parseRenderGrid(sample(), { surfaceId: "sf-1", now: 1 }).grid;
    expect(alt.altScreen).toBe(true);
    const primary = parseRenderGrid(sample({ render_grid: { active_screen: "primary" } }), {
      surfaceId: "sf-1",
      now: 1,
    }).grid;
    expect(primary.altScreen).toBe(false);
  });

  it("内容没变 revision 不动，变了才自增", () => {
    const tracker = new GridTracker();
    const first = tracker.parse(sample(), "sf-1", 1);
    const second = tracker.parse(sample(), "sf-1", 2);
    expect(second.revision).toBe(first.revision);

    const changed = tracker.parse(
      sample({ render_grid: { row_spans: [{ row: 0, column: 0, style_id: 1, cell_width: 3, text: "new" }] } }),
      "sf-1",
      3,
    );
    expect(changed.revision).toBe(first.revision + 1);
  });

  it("带上滚动位置：画面一样但位置变了，也要当成新版本", () => {
    const tracker = new GridTracker();
    const bottom = tracker.parse(sample(), "sf-1", 1);
    expect(bottom.scrolledRows).toBe(0);

    const scrolled = tracker.parse(sample({ render_grid: { scrolled_rows: 40 } }), "sf-1", 2);
    expect(scrolled.scrolledRows).toBe(40);
    // 只有位置变了，spans 一模一样；不进指纹的话前端就收不到这次变化
    expect(scrolled.revision).toBe(bottom.revision + 1);
  });

  it("输出符合协议 schema", () => {
    const { grid } = parseRenderGrid(sample(), { surfaceId: "sf-1", now: 1000 });
    expect(SurfaceGridSchema.safeParse(grid).success).toBe(true);
  });

  it("缺 columns 直接报错，不返回半成品", () => {
    expect(() => parseRenderGrid({ render_grid: {} }, { surfaceId: "sf-1", now: 1 })).toThrow();
  });
});
