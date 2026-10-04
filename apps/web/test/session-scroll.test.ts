import { describe, expect, it } from "vitest";
import { alignAfterScroll } from "../src/features/session/scroll.ts";

describe("翻页后的落点", () => {
  it("往回翻停在新一屏的底部 —— 那里才接着刚看到的第一行", () => {
    expect(alignAfterScroll("pageup")).toBe("bottom");
  });

  it("往下翻停在新一屏的顶部 —— 贴底会把中间整屏跳过去", () => {
    expect(alignAfterScroll("pagedown")).toBe("top");
  });

  it("回到最新一屏就是贴底", () => {
    expect(alignAfterScroll("bottom")).toBe("bottom");
  });

  it("两个方向的落点必须相反，接缝不在同一头", () => {
    expect(alignAfterScroll("pageup")).not.toBe(alignAfterScroll("pagedown"));
  });
});
