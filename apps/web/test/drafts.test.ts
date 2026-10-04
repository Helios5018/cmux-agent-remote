import { describe, expect, it } from "vitest";
import { DraftStore } from "../src/stores/drafts.ts";
import { ApiError, api } from "../src/api.ts";
import { vi } from "vitest";

describe("按会话保存输入", () => {
  it("切换会话保留独立草稿，慢响应只清原会话", async () => {
    const drafts = new DraftStore();
    drafts.edit("a", "甲的任务");
    drafts.edit("b", "乙的任务");
    let finish!: () => void;
    const pending = drafts.run("a", () => new Promise<void>(resolve => { finish = resolve; }), true);
    expect(drafts.get("a").busy).toBe(true);
    expect(drafts.get("b").text).toBe("乙的任务");
    const duplicate = vi.fn();
    await drafts.run("a", duplicate, true);
    expect(duplicate).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(drafts.get("a").text).toBe("");
    expect(drafts.get("b").text).toBe("乙的任务");
  });

  it("明确拒绝保留草稿且可重试，未知结果必须先核对", async () => {
    const drafts = new DraftStore();
    drafts.edit("a", "任务");
    await drafts.run("a", async () => { throw new ApiError(401, "UNAUTHORIZED", "请登录"); }, true);
    expect(drafts.get("a")).toMatchObject({ text: "任务", uncertain: false });
    await drafts.run("a", async () => { throw new TypeError("网络断开"); }, true);
    expect(drafts.get("a")).toMatchObject({ text: "任务", uncertain: true });
    const retry = vi.fn();
    await drafts.run("a", retry, true);
    expect(retry).not.toHaveBeenCalled();
    drafts.edit("a", "不能覆盖待核对的草稿");
    expect(drafts.get("a").text).toBe("任务");
    drafts.resolve("a", false);
    await drafts.run("a", async () => {}, true);
    expect(drafts.get("a").text).toBe("");
  });

  it("正文已写入时支持只补回车，失败仍保留草稿", async () => {
    const drafts = new DraftStore();
    drafts.edit("a", "原文");
    await drafts.run("a", async () => { throw new ApiError(500, "INPUT_TEXT_WRITTEN_SUBMIT_UNKNOWN", "未知"); }, true);
    expect(drafts.get("a")).toMatchObject({ textWritten: true, uncertain: true, text: "原文" });
    await drafts.run("a", async () => { throw new ApiError(401, "UNAUTHORIZED", "登录已过期"); }, true, true);
    expect(drafts.get("a")).toMatchObject({ textWritten: true, uncertain: true, text: "原文" });
    await drafts.run("a", async () => {}, true, true);
    expect(drafts.get("a")).toMatchObject({ text: "", uncertain: false });
  });

  it.each(["clear", "forget"] as const)("%s 后的迟到响应不能恢复旧状态", async method => {
    const drafts = new DraftStore();
    drafts.edit("a", "旧任务");
    let fail!: (reason: unknown) => void;
    const pending = drafts.run("a", () => new Promise<void>((_, reject) => { fail = reject; }), true);
    drafts[method]("a");
    drafts.edit("a", "新的草稿");
    fail(new Error("旧请求失败"));
    await pending;
    expect(drafts.get("a")).toMatchObject({ text: "新的草稿", busy: false, uncertain: false, message: null });
  });

  it("空或 HTML 成功响应不能清空草稿", async () => {
    const drafts = new DraftStore();
    drafts.edit("a", "保留的正文");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>代理错误</html>", { status: 200 })));
    try {
      await drafts.run("a", () => api.sendInput("a", drafts.get("a").text, true).then(() => {}), true);
      expect(drafts.get("a")).toMatchObject({ text: "保留的正文", uncertain: true });
    } finally { vi.unstubAllGlobals(); }
  });
});
