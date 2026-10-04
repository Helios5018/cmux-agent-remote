import { describe, expect, it } from "vitest";
import { DEFAULT_HOME_TITLE, DEFAULT_TAB_TITLE, homeTitleOf, tabTitleOf } from "../src/appName.ts";

describe("应用名称：顶栏和浏览器标签", () => {
  it("没改过时两处各用原来的默认文案", () => {
    expect(homeTitleOf("")).toBe("Agents");
    expect(tabTitleOf("")).toBe("CMUX Agent Remote");
    expect(DEFAULT_HOME_TITLE).toBe("Agents");
    expect(DEFAULT_TAB_TITLE).toBe("CMUX Agent Remote");
  });

  it("改过之后顶栏和标签用同一个名字", () => {
    expect(homeTitleOf("家里 Mac")).toBe("家里 Mac");
    expect(tabTitleOf("家里 Mac")).toBe("家里 Mac");
  });
});
