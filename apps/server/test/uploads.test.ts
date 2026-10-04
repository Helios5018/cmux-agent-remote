import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveUpload } from "../src/services/uploads.ts";
import { createHarness } from "./helpers.ts";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "car-uploads-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function upload(name = "截图 1.png", content = "image-data", extra: Record<string, string> = {}) {
  return new Request("http://localhost/api/files/upload", { method: "POST", body: content, headers: {
    "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name), "x-file-size": String(Buffer.byteLength(content)), "x-surface-id": "SURF-10", ...extra,
  } });
}
describe("附件流式上传", () => {
  it("保留原文件名、区分同名文件、存储会话关联，任何格式均可上传", async () => {
    const a = await saveUpload(root, upload()); const b = await saveUpload(root, upload());
    expect(a.path).not.toBe(b.path); expect(a.path).toMatch(/uploads\/\d{4}-\d{2}-\d{2}\/.+\/截图 1.png$/);
    expect(await readFile(a.path, "utf8")).toBe("image-data");
    const metadata = JSON.parse(await readFile(join(a.path, "../..", `${a.id}.json`), "utf8"));
    expect(metadata).toMatchObject({ name: "截图 1.png", surfaceId: "SURF-10", size: 10 });
    for (const name of ["movie.mov", "report.pdf", "metadata.json", "archive.zip"]) expect((await saveUpload(root, upload(name))).name).toBe(name);
  });
  it("拒绝越界文件名、过大文件和不完整上传，不遗留中间文件", async () => {
    for (const name of ["../a", "a/b", "a\\b", "..", "bad\nname", ""]) await expect(saveUpload(root, upload(name))).rejects.toThrow("文件名");
    await expect(saveUpload(root, upload(), 3)).rejects.toThrow("512 MB");
    await expect(saveUpload(root, upload("a.txt", "short", { "x-file-size": "9" }))).rejects.toThrow("未完成");
    await expect(saveUpload(root, upload("a.txt", "long", { "x-file-size": "1" }))).rejects.toThrow("不一致");
    const days = await readdir(join(root, "uploads"));
    for (const day of days) expect(await readdir(join(root, "uploads", day))).toEqual([]);
  });
  it("空文件可上传；读取流中断会清理暂存文件", async () => {
    expect((await saveUpload(root, upload("empty.txt", ""))).size).toBe(0);
    let reads = 0;
    const stream = new ReadableStream({ pull(controller) { if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2])); else controller.error(new Error("disconnected")); } });
    const req = new Request(upload("broken.bin", "1234"), { body: stream, duplex: "half" } as RequestInit);
    await expect(saveUpload(root, req)).rejects.toThrow("disconnected");
    const days = await readdir(join(root, "uploads"));
    for (const day of days) expect((await readdir(join(root, "uploads", day))).filter(n => n.startsWith(".upload-"))).toEqual([]);
  });
  it("API 要求登录和本站提交，返回可读取的本地路径", async () => {
    const h = await createHarness(); h.ctx.config.dataDir = root;
    try {
      expect((await h.app.request(upload())).status).toBe(401);
      const cookie = await h.loginCookie();
      expect((await h.app.request(upload("a", "x", { cookie, "sec-fetch-site": "cross-site" }))).status).toBe(403);
      expect((await h.app.request(upload("a", "x", { cookie, "content-type": "text/plain" }))).status).toBe(403);
      const response = await h.app.request(upload("a.pdf", "content", { cookie }));
      expect(response.status).toBe(201);
      const result = await response.json(); expect(await readFile(result.path, "utf8")).toBe("content");
    } finally { h.store.close(); }
  });
});
