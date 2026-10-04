import { describe, expect, it } from "vitest";
import {
  applyPaste,
  composerKeysForAgent,
  countTextLines,
  PASTE_EXPAND_LINES,
  shouldExpandEditorForText,
} from "../src/components/Composer.tsx";

describe("Agent 快捷键", () => {
  it("只给 Pi 展示用于切换模型的 Ctrl+P", () => {
    expect(composerKeysForAgent("pi")).toContain("ctrl+p");
    expect(composerKeysForAgent("claude")).not.toContain("ctrl+p");
    expect(composerKeysForAgent(null)).not.toContain("ctrl+p");
  });

  it("只给 Codex 展示打开排队消息 / 异步提问的 Option+↑", () => {
    expect(composerKeysForAgent("codex")).toContain("alt+up");
    expect(composerKeysForAgent("claude")).not.toContain("alt+up");
    expect(composerKeysForAgent("pi")).not.toContain("alt+up");
    expect(composerKeysForAgent(null)).not.toContain("alt+up");
  });
});

describe("输入框展开判断", () => {
  it("空文本算 1 行", () => {
    expect(countTextLines("")).toBe(1);
  });

  it("按换行计数，末尾换行也算新行", () => {
    expect(countTextLines("hello")).toBe(1);
    expect(countTextLines("a\nb")).toBe(2);
    expect(countTextLines("a\n")).toBe(2);
    expect(countTextLines("1\n2\n3\n4\n5\n6\n7\n8")).toBe(8);
  });

  it("满 8 行才自动进展开编辑", () => {
    const seven = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    const eight = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    expect(shouldExpandEditorForText(seven)).toBe(false);
    expect(shouldExpandEditorForText(eight)).toBe(true);
    expect(PASTE_EXPAND_LINES).toBe(8);
  });

  it("粘贴进选区再判断，替换选中而不是永远追加", () => {
    const next = applyPaste("aaaBBB", "1\n2\n3\n4\n5\n6\n7\n8", 3, 6);
    expect(next).toBe("aaa1\n2\n3\n4\n5\n6\n7\n8");
    expect(shouldExpandEditorForText(next)).toBe(true);
  });

  it("短粘贴不放大", () => {
    expect(shouldExpandEditorForText(applyPaste("hi", "there", 2, 2))).toBe(false);
  });
});
