import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileService } from "../src/services/files.ts";
import { createHarness } from "./helpers.ts";
import { createApp } from "../src/app.ts";
let root: string; let files: FileService;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "car-files-"))); files = new FileService(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("独立文件模块", () => {
  it("分页目录优先、过滤和隐藏文件", async () => {
    await Promise.all(Array.from({ length: 105 }, (_,i) => writeFile(join(root, `file-${i}.txt`), "hello")));
    await mkdir(join(root,"folder")); await writeFile(join(root,".hidden"), "secret");
    const first = await files.list(root,false,"",0); const second = await files.list(root,false,"",first.next!);
    expect(first.entries[0]!.kind).toBe("directory"); expect(first.entries).toHaveLength(100); expect(second.entries).toHaveLength(6); expect(second.next).toBeNull();
    expect((await files.list(root,true,".hidden",0)).entries).toHaveLength(1);
  });
  it("可以访问项目之外的目录和软链接，保留名称与系统根目录保护", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "car-files-outside-")));
    try {
      await symlink(outside, join(root,"shortcut"));
      expect(await files.path(join(root,".."))).toBe(await realpath(join(root,"..")));
      expect(await files.path(join(root,"shortcut"))).toBe(outside);
      await files.operate({ action:"create", directory:join(root,"shortcut"), name:"outside.txt", kind:"file" });
      expect(await readFile(join(outside,"outside.txt"),"utf8")).toBe("");
      expect((await files.list(outside,false,"",0)).entries[0]!.name).toBe("outside.txt");
      expect((await files.list("/",false,"",0)).parent).toBeNull();
      await expect(files.operate({ action:"create", directory:root, name:"../bad", kind:"file" })).rejects.toThrow();
      await expect(files.operate({ action:"rename", path:"/", name:"moved" })).rejects.toThrow();
    } finally { await rm(outside, { recursive:true, force:true }); }
  });
  it("新建、文件与目录改名、多选跨目录复制、冲突不覆盖", async () => {
    await files.operate({ action:"create", directory:root, name:"a", kind:"file" }); await writeFile(join(root,"a"),"keep");
    await files.operate({ action:"create", directory:root, name:"target", kind:"directory" });
    await files.operate({ action:"rename", path:join(root,"a"), name:"b" });
    await files.operate({ action:"rename", path:join(root,"target"), name:"destination" });
    await writeFile(join(root,"c"),"second");
    await files.operate({ action:"copy", paths:[join(root,"b"),join(root,"c")], directory:join(root,"destination") });
    expect(await readFile(join(root,"destination/b"),"utf8")).toBe("keep");
    await expect(files.operate({ action:"copy", paths:[join(root,"b")], directory:join(root,"destination") })).rejects.toThrow("同名");
    await expect(files.operate({ action:"rename", path:join(root,"b"), name:"c" })).rejects.toThrow("同名");
    expect(await readFile(join(root,"c"),"utf8")).toBe("second");
    await expect(files.operate({ action:"copy", paths:[root], directory:join(root,"destination") })).rejects.toThrow("自身");
  });
  it("递归复制文件夹并拒绝软链接复制", async () => {
    await mkdir(join(root,"source/nested"), { recursive:true }); await mkdir(join(root,"target"));
    await writeFile(join(root,"source/nested/data"), "nested content");
    await files.operate({ action:"copy", paths:[join(root,"source")], directory:join(root,"target") });
    expect(await readFile(join(root,"target/source/nested/data"),"utf8")).toBe("nested content");
    await symlink(join(root,"source"), join(root,"alias"));
    await expect(files.operate({ action:"copy", paths:[join(root,"alias")], directory:join(root,"target") })).rejects.toThrow("软链接");
  });
  it("递归名称与内容搜索、取消、文本截断和二进制预览", async () => {
    await mkdir(join(root,"nested")); await writeFile(join(root,"nested/note.md"),"title\nneedle here");
    const signal = new AbortController();
    expect((await files.search(root,"note",false,false,0,signal.signal)).entries[0]!.name).toBe("note.md");
    expect((await files.search(root,"needle",true,false,0,signal.signal)).entries[0]).toMatchObject({ line:2, excerpt:"needle here" });
    signal.abort(); await expect(files.search(root,"x",true,false,0,signal.signal)).rejects.toThrow("取消");
    await writeFile(join(root,"large"),"a".repeat(200000)); expect(await files.preview(join(root,"large"))).toMatchObject({ kind:"text", truncated:true });
    await writeFile(join(root,"binary"),Buffer.from([1,0,2])); expect((await files.preview(join(root,"binary"))).kind).toBe("other");
  });
  it("文件 API 强制登录，写入无需 surfaceId，拒绝跨站提交", async () => {
    const h = await createHarness(); const app = createApp(h.ctx);
    expect((await app.request("/api/files/roots")).status).toBe(401);
    const cookie = await h.loginCookie(); const headers = { cookie, "content-type":"application/json" };
    const post = (body: unknown, extra = {}) => app.request("/api/files/operation", { method:"POST", headers:{...headers,...extra}, body:JSON.stringify(body) });
    expect((await post({ action:"create", directory:root, name:"api.txt", kind:"file" })).status).toBe(200);
    expect((await post({ action:"create", directory:root, name:"api.txt", kind:"file" })).status).toBe(409);
    expect((await post({ action:"create", directory:root, name:"cross", kind:"file" }, {"sec-fetch-site":"cross-site"})).status).toBe(403);
    expect((await app.request(`/api/files/list?path=${encodeURIComponent(root)}`, {headers})).status).toBe(200);
    expect((await app.request('/api/files/list?offset=-1', {headers})).status).toBe(400);
    expect((await app.request(`/api/files/list?path=${encodeURIComponent(join(root,".."))}`, {headers})).status).toBe(200);
    expect(await (await app.request("/api/files/roots", {headers})).json()).toMatchObject({ roots:["/"], home:expect.any(String) });
  });
});
