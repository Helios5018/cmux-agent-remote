import { describe, expect, it } from "vitest";
import { nodesText, replaceNodes, sliceNodes, type FileReference, type InputNode } from "../src/features/attachments/model.ts";
import { DraftStore } from "../src/stores/drafts.ts";
const image: FileReference = { type: "file", id: "image", name: "图 1.png", path: "/Users/link/图 1.png", size: 4, status: "ready" };
const video: FileReference = { type: "file", id: "video", name: "clip.mp4", size: 100, status: "uploading" };
describe("正文内附件", () => {
  it("按光标选区替换，文件作为原子节点，发送展开路径且保留顺序", () => {
    const nodes: InputNode[] = [{ type: "text", text: "参考这个，检查视频" }];
    const next = replaceNodes(nodes, 2, 4, [image]);
    expect(nodesText(next)).toBe('参考"/Users/link/图 1.png"，检查视频');
    expect(sliceNodes(next, 2, 3)).toEqual([image]);
    expect(nodesText(replaceNodes(next, 2, 3, []))).toBe("参考，检查视频");
    expect(nodesText([image, { type: "text", text: "\n和" }, { ...image, path: '/tmp/a"b.png' }])).toBe('"/Users/link/图 1.png"\n和"/tmp/a\\"b.png"');
  });
  it("切换会话时上传更新原草稿，删除和清空后迟到响应不复活附件", () => {
    const drafts = new DraftStore(); drafts.editNodes("a", [image, video]); drafts.edit("b", "other");
    drafts.updateFile("a", "video", { status: "ready", path: "/tmp/clip.mp4" });
    expect(drafts.get("a").text).toContain('"/tmp/clip.mp4"'); expect(drafts.get("b").text).toBe("other");
    drafts.editNodes("a", [image]); drafts.updateFile("a", "video", { path: "/late" }); expect(drafts.get("a").nodes).toEqual([image]);
    drafts.clear(); drafts.updateFile("a", "image", { path: "/late" }); expect(drafts.get("a").text).toBe("");
  });
  it("发送失败保留引用和文字；未知结果核对后保留或清除；按键不清空附件", async () => {
    const drafts = new DraftStore(); drafts.editNodes("a", [image]);
    await drafts.run("a", async () => { throw new Error("network"); }, true);
    expect(drafts.get("a").uncertain).toBe(true); expect(drafts.get("a").nodes).toEqual([image]);
    drafts.resolve("a", false); expect(drafts.get("a").nodes).toEqual([image]);
    await drafts.run("a", async () => {}, false); expect(drafts.get("a").nodes).toEqual([image]);
    await drafts.run("a", async () => {}, true); expect(drafts.get("a").text).toBe(""); expect(drafts.get("a").nodes).toBeUndefined();
  });
});
