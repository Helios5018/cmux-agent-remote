import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath, rename, mkdir, mkdtemp, rmdir, rm, link, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { FileError } from "./files.ts";
import type { FileMutationResult } from "@car/protocol";
const inside = (parent: string, path: string) => { const r = relative(parent, path); return !r || (r !== ".." && !r.startsWith("../") && !r.startsWith("/")); };
const message = (e: unknown) => e instanceof FileError ? e.message : (e as NodeJS.ErrnoException).code === "EEXIST" ? "目标已存在同名项目" : "操作失败，请检查权限与文件状态";

// Resolve parent links, but never follow the selected link itself when moving/deleting.
async function itemPath(input: string) {
  const path = resolve(input);
  if (path === "/") throw new FileError("不能移动或删除系统根目录", 403);
  return join(await realpath(dirname(path)), basename(path));
}
async function selection(inputs: string[]) {
  const paths = [...new Set(await Promise.all(inputs.map(itemPath)))];
  return paths.filter((p) => !paths.some((parent) => parent !== p && inside(parent, p)));
}
async function fingerprint(path: string) {
  const rows: string[] = []; let count = 0;
  const walk = async (p: string): Promise<void> => {
    if (++count > 10000) throw new FileError("单次操作最多支持 10000 项，请分批处理", 413);
    const s = await lstat(p);
    rows.push(JSON.stringify([p, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode]));
    if (s.isDirectory()) for (const name of (await readdir(p)).sort()) await walk(join(p, name));
  };
  await walk(path); return rows.join("\n");
}
export async function trashItem(path: string) {
  if (process.platform !== "darwin") throw new FileError("废纸篓功能仅支持 macOS");
  const script = 'ObjC.import("Foundation"); function run(argv) { if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, null)) throw Error("Cannot move item to Trash"); return "ok"; }';
  await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, path], { timeout: 30000, maxBuffer: 65536 });
}
export class FileMutations {
  constructor(private readonly trash: (path: string) => Promise<void> = trashItem) {}
  private pending = new Map<string, { owner: string; mode: "trash" | "permanent"; expires: number; paths: string[]; prints: string[] }>();
  async prepare(inputs: string[], owner: string, mode: "trash" | "permanent" = "permanent"): Promise<FileMutationResult> {
    for (const [key, plan] of this.pending) if (plan.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 100) throw new FileError("待确认操作过多，请稍后重试");
    const paths = await selection(inputs);
    const prints = await Promise.all(paths.map(fingerprint));
    const token = randomUUID();
    this.pending.set(token, { owner, paths, prints, mode, expires: Date.now() + 120000 });
    return { ok: true, token, paths };
  }
  async remove(token: string, owner: string): Promise<FileMutationResult> {
    const plan = this.pending.get(token);
    if (!plan || plan.owner !== owner || plan.expires < Date.now()) throw new FileError("删除确认已失效，请重新确认", 409);
    this.pending.delete(token);
    // Validate the complete selection before removing anything.
    for (let i = 0; i < plan.paths.length; i++) {
      if (await itemPath(plan.paths[i]!) !== plan.paths[i] || await fingerprint(plan.paths[i]!) !== plan.prints[i]) throw new FileError("文件在确认期间已变化，请重新确认", 409);
    }
    const result: FileMutationResult = { ok: true, paths: [], failed: [] };
    for (const path of plan.paths) {
      try { if (plan.mode === "trash") await this.trash(path); else await rm(path, { recursive: true, force: false }); result.paths.push(path); }
      catch (e) { result.ok = false; result.failed!.push({ path, message: message(e) }); }
    }
    return result;
  }
  async move(inputs: string[], destination: string, copy: (source: string, target: string) => Promise<void>): Promise<FileMutationResult> {
    const directory = await realpath(destination);
    if (!(await lstat(directory)).isDirectory()) throw new FileError("请选择目标文件夹");
    const paths = await selection(inputs);
    const targets = paths.map((p) => join(directory, basename(p)));
    if (new Set(targets).size !== targets.length) throw new FileError("所选项目有重名，请分开移动", 409);
    // Conflicts are preflighted so a conflicting selection does not half-move.
    for (let i = 0; i < paths.length; i++) {
      if (inside(paths[i]!, targets[i]!)) throw new FileError("不能移动到自身或子目录");
      await lstat(paths[i]!);
      try { await lstat(targets[i]!); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      throw new FileError(`目标已存在：${basename(targets[i]!)}`, 409);
    }
    const result: FileMutationResult = { ok: true, paths: [], failed: [] };
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]!, target = targets[i]!;
      try {
        const s = await lstat(path);
        if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw new FileError("暂不支持剪切软链接或特殊文件");
        try {
          if (s.isDirectory()) {
            await mkdir(target); // reserve an empty destination, never merge/overwrite
            try { await rename(path, target); } catch (e) { await rmdir(target); throw e; }
          } else { await link(path, target); await unlink(path); }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
          // Different drives: copy to a private staging location, verify source, then publish.
          const before = await fingerprint(path);
          const stage = await mkdtemp(join(directory, ".car-move-"));
          try {
            const copied = join(stage, basename(path)); await copy(path, copied);
            if (await fingerprint(path) !== before) throw new FileError("源文件在复制时已变化，已保留源文件", 409);
            if (s.isDirectory()) { await mkdir(target); try { await rename(copied, target); } catch (e) { await rmdir(target); throw e; } }
            else await link(copied, target);
            await rm(path, { recursive: true, force: false });
          } finally { await rm(stage, { recursive: true, force: true }); }
        }
        result.paths.push(path);
      } catch (e) { result.ok = false; result.failed!.push({ path, message: message(e) }); }
    }
    return result;
  }
}
