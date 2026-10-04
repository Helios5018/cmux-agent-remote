import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMutations } from "../src/services/file-mutations.ts";
import { FileService } from "../src/services/files.ts";
import { createHarness } from "./helpers.ts";
const simulation = vi.hoisted(() => ({ crossDevice: false }));
vi.mock("node:fs/promises", async (actual) => {
  const fs = await actual<typeof import("node:fs/promises")>();
  const wrap = (fn: typeof fs.rename | typeof fs.link) => async (...args: Parameters<typeof fs.rename>) => {
    if (simulation.crossDevice && String(args[0]).includes("/cross-") && !String(args[0]).includes(".car-move-")) throw Object.assign(new Error("different drive"), { code: "EXDEV" });
    return fn(...args);
  };
  return { ...fs, rename: wrap(fs.rename), link: wrap(fs.link) };
});
let root: string; let files: FileService;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(),"car-mutations-")); files = new FileService(); });
afterEach(async () => { simulation.crossDevice = false; vi.restoreAllMocks(); await rm(root,{recursive:true,force:true}); });
it("剪切文件和非空目录，冲突不覆盖且保留源文件", async () => {
  await mkdir(join(root,"target")); await mkdir(join(root,"folder"));
  await writeFile(join(root,"a"),"A"); await writeFile(join(root,"folder/b"),"B");
  const result = await files.operate({action:"move",paths:[join(root,"a"),join(root,"folder")],directory:join(root,"target")});
  expect(result.ok).toBe(true); expect(result.paths).toHaveLength(2);
  expect(await readFile(join(root,"target/folder/b"),"utf8")).toBe("B");
  await expect(lstat(join(root,"a"))).rejects.toMatchObject({code:"ENOENT"});
  await writeFile(join(root,"a"),"new A");
  await expect(files.operate({action:"move",paths:[join(root,"a")],directory:join(root,"target")})).rejects.toThrow("已存在");
  expect(await readFile(join(root,"a"),"utf8")).toBe("new A"); expect(await readFile(join(root,"target/a"),"utf8")).toBe("A");
  await expect(files.operate({action:"move",paths:[join(root,"target")],directory:join(root,"target/folder")})).rejects.toThrow("自身");
});
it("跨文件系统复制完成后移除源文件，失败保留源文件并清理暂存", async () => {
  simulation.crossDevice = true; await mkdir(join(root,"target")); await mkdir(join(root,"cross-dir"));
  await writeFile(join(root,"cross-file"),"file"); await writeFile(join(root,"cross-dir/nested"),"nested");
  const result=await files.operate({action:"move",paths:[join(root,"cross-file"),join(root,"cross-dir")],directory:join(root,"target")});
  expect(result.ok).toBe(true); expect(await readFile(join(root,"target/cross-dir/nested"),"utf8")).toBe("nested");
  await expect(lstat(join(root,"cross-dir"))).rejects.toMatchObject({code:"ENOENT"});
  await mkdir(join(root,"cross-bad")); await symlink(join(root,"target"),join(root,"cross-bad/link"));
  const failed=await files.operate({action:"move",paths:[join(root,"cross-bad")],directory:join(root,"target")});
  expect(failed.ok).toBe(false); expect((await lstat(join(root,"cross-bad"))).isDirectory()).toBe(true);
  expect((await readdir(join(root,"target"))).some(n=>n.startsWith(".car-move-"))).toBe(false);
});
it("删除准备不会删除，确认令牌绑定会话、仅可使用一次，文件变化时拒绝", async () => {
  const path=join(root,"file"); await writeFile(path,"keep");
  const plan=await files.operate({action:"delete_prepare",paths:[path]},"one");
  expect(await readFile(path,"utf8")).toBe("keep");
  const token=(plan as {token:string}).token;
  await expect(files.operate({action:"delete",token,confirm:true},"two")).rejects.toThrow("失效");
  await writeFile(path,"changed file");
  await expect(files.operate({action:"delete",token,confirm:true},"one")).rejects.toThrow("变化");
  expect(await readFile(path,"utf8")).toBe("changed file");
  const fresh=await files.operate({action:"delete_prepare",paths:[path]},"one") as {token:string};
  expect((await files.operate({action:"delete",token:fresh.token,confirm:true},"one")).ok).toBe(true);
  await expect(lstat(path)).rejects.toMatchObject({code:"ENOENT"});
  await expect(files.operate({action:"delete",token:fresh.token,confirm:true},"one")).rejects.toThrow("失效");
});
it("批量删除非空目录；删除软链接不删除目标；过期确认失效", async () => {
  await mkdir(join(root,"folder"));await writeFile(join(root,"folder/child"),"x");await writeFile(join(root,"keep"),"keep");await symlink(join(root,"keep"),join(root,"alias"));
  const plan=await files.operate({action:"delete_prepare",paths:[join(root,"folder"),join(root,"folder/child"),join(root,"alias")]}) as {token:string;paths:string[]};
  expect(plan.paths).toHaveLength(2);
  const result=await files.operate({action:"delete",token:plan.token,confirm:true});expect(result.ok).toBe(true);
  expect(await readFile(join(root,"keep"),"utf8")).toBe("keep");
  await expect(lstat(join(root,"folder"))).rejects.toMatchObject({code:"ENOENT"});
  const expired=await files.operate({action:"delete_prepare",paths:[join(root,"keep")]}) as {token:string};
  vi.spyOn(Date,"now").mockReturnValue(Date.now()+121000);
  await expect(files.operate({action:"delete",token:expired.token,confirm:true})).rejects.toThrow("失效");
  await expect(files.operate({action:"delete_prepare",paths:["/"]})).rejects.toThrow("根目录");
});
it("删除接口强制登录及明确二次确认，准备阶段保留原文件", async () => {
  const h=await createHarness();const cookie=await h.loginCookie();const path=join(root,"api");await writeFile(path,"keep");
  const post=(body:unknown,auth=true)=>h.request("/api/files/operation",{method:"POST",cookie:auth?cookie:undefined,body:JSON.stringify(body)});
  expect((await post({action:"delete_prepare",paths:[path]},false)).status).toBe(401);
  const plan=await(await post({action:"delete_prepare",paths:[path]})).json() as {token:string};
  expect(await readFile(path,"utf8")).toBe("keep");
  expect((await post({action:"delete",token:plan.token})).status).toBe(400);
  expect((await post({action:"delete",token:plan.token,confirm:false})).status).toBe(400);
  expect((await post({action:"delete",token:plan.token,confirm:true})).status).toBe(200);
});

it("废纸篓与永久删除使用不同执行路径，准备阶段不执行", async () => {
  const path=join(root,"trash-me");await writeFile(path,"recoverable");
  const trash=vi.fn(async (_path:string)=>{});const mutations=new FileMutations(trash);
  const plan=await mutations.prepare([path],"session","trash");expect(trash).not.toHaveBeenCalled();
  await mutations.remove(plan.token!,"session");expect(trash).toHaveBeenCalledOnce();
  expect(await readFile(path,"utf8")).toBe("recoverable");
  const permanent=await mutations.prepare([path],"session","permanent");await mutations.remove(permanent.token!,"session");
  expect(trash).toHaveBeenCalledOnce();await expect(lstat(path)).rejects.toMatchObject({code:"ENOENT"});
});
