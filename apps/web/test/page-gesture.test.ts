import { describe, expect, it } from "vitest";
import {
  accumulateWheel,
  dampDrag,
  DRAG_THRESHOLD,
  WHEEL_THRESHOLD,
} from "../src/hooks/usePageGesture.ts";

describe("翻页手势：滚轮累计", () => {
  it("攒够一屏才翻，不是滚一下翻一次", () => {
    let accum = 0;
    let pages = 0;
    // 触控板一格大约 10px，滚一格不该翻页
    for (let i = 0; i < 5; i += 1) {
      const result = accumulateWheel(accum, -10);
      accum = result.accum;
      if (result.page) pages += 1;
    }
    expect(pages).toBe(0);

    const final = accumulateWheel(-WHEEL_THRESHOLD + 5, -10);
    expect(final.page).toBe("up");
    // 翻完清零，否则惯性滚动会连着翻好几屏
    expect(final.accum).toBe(0);
  });

  it("鼠标滚轮一档就够一次", () => {
    expect(accumulateWheel(0, -120).page).toBe("up");
    expect(accumulateWheel(0, 120).page).toBe("down");
  });

  it("换方向立刻清零，不会攒出莫名其妙的翻页", () => {
    // 往上攒了一大半，然后改往下滚
    const turned = accumulateWheel(-WHEEL_THRESHOLD + 5, 20);
    expect(turned.page).toBeNull();
    expect(turned.accum).toBe(20);
  });

  it("方向对得上：往上滚看上一屏", () => {
    expect(accumulateWheel(0, -WHEEL_THRESHOLD).page).toBe("up");
    expect(accumulateWheel(0, WHEEL_THRESHOLD).page).toBe("down");
  });
});

describe("翻页手势：跟手位移", () => {
  it("越拖越沉，但始终跟手同向", () => {
    expect(dampDrag(0)).toBe(0);
    expect(dampDrag(20)).toBeGreaterThan(0);
    expect(dampDrag(-20)).toBeLessThan(0);
    expect(dampDrag(200)).toBeGreaterThan(dampDrag(100));
    // 阻尼：拖 200px 画面不该真的走 200px
    expect(dampDrag(200)).toBeLessThan(200);
  });

  it("位移有上限，拖到底也不会把画面甩出屏幕", () => {
    expect(dampDrag(5000)).toBeLessThanOrEqual(96);
    expect(dampDrag(-5000)).toBeGreaterThanOrEqual(-96);
  });

  it("过阈值前后的位移都在可见范围内，用户看得到反馈", () => {
    expect(dampDrag(DRAG_THRESHOLD)).toBeGreaterThan(8);
  });
});
