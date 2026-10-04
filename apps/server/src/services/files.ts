import { FileMutations } from "./file-mutations.ts";
import { mediaTypes } from "./media.ts";
import { constants } from "node:fs";
import { readdir, realpath, lstat, stat, open, mkdir, copyFile, link, unlink, rename } from "node:fs/promises";
import { resolve, relative, isAbsolute, join, dirname, basename, extname } from "node:path";
import type { FileEntry, FileListing, FileOperation, FilePreview } from "@car/protocol";

export class FileError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413 = 400) { super(message); }
}
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel)); };
export const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif" };
const PAGE = 100;
const PREVIEW = 128 * 1024;
export class FileService {
  private mutations = new FileMutations();
  private queue: Promise<unknown> = Promise.resolve();
  async roots() { return ["/"]; }
  async path(input: string) { return realpath(resolve(input)); }
  async directory(input: string) { const p = await this.path(input); if (!(await stat(p)).isDirectory()) throw new FileError("请选择文件夹"); return p; }
  private name(name: string) { if (!name || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name)) throw new FileError("名称不能包含路径分隔符或控制字符"); return name; }
  private async entry(path: string): Promise<FileEntry> {
    const s = await lstat(path);
    return { path, name: basename(path), kind: s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other", size: s.size, modified: s.mtimeMs };
  }
  async list(input: string, hidden: boolean, query: string, offset: number): Promise<FileListing> {
    const path = await this.directory(input);
    const names = (await readdir(path, { withFileTypes: true })).filter((e) => (hidden || !e.name.startsWith(".")) && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    names.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    const results = await Promise.allSettled(names.slice(offset, offset + PAGE).map((e) => this.entry(join(path, e.name))));
    const roots = await this.roots();
    return { path, parent: roots.some((r) => within(r, dirname(path))) && dirname(path) !== path ? dirname(path) : null, entries: results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []), next: offset + PAGE < names.length ? offset + PAGE : null };
  }
  async preview(input: string): Promise<FilePreview> {
    const path = await this.path(input);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await handle.stat();
      if (!s.isFile()) throw new FileError("仅支持预览普通文件");
      const base = { path, name: basename(path), size: s.size, truncated: s.size > PREVIEW };
      if (imageTypes[extname(path).toLowerCase()] && s.size <= 20 * 1024 * 1024) return { ...base, kind: "image", truncated: false };
      const mime = mediaTypes[extname(path).toLowerCase()];
      if (mime) return { ...base, kind: mime.startsWith("video/") ? "video" : "audio", truncated: false };
      const buffer = Buffer.alloc(Math.min(PREVIEW, s.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      return bytes.includes(0) ? { ...base, kind: "other" } : { ...base, kind: "text", text: bytes.toString("utf8") };
    } finally { await handle.close(); }
  }
  async search(input: string, query: string, content: boolean, hidden: boolean, offset: number, signal: AbortSignal): Promise<FileListing> {
    const path = await this.directory(input);
    const entries: FileEntry[] = [];
    const pending = [path]; let scanned = 0; const deadline = Date.now() + 5000;
    let limited = false;
    while (pending.length) {
      if (signal.aborted) throw new FileError("搜索已取消");
      if (scanned >= 20000 || Date.now() > deadline) { limited = true; break; }
      const dir = pending.pop()!;
      let names;
      try { await this.directory(dir); names = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      names.sort((a,b) => a.name.localeCompare(b.name));
      for (const e of names) {
        if (signal.aborted) throw new FileError("搜索已取消");
        if (++scanned > 20000 || Date.now() > deadline) { limited = true; break; }
        if ((!hidden && e.name.startsWith(".")) || e.name === "node_modules" || e.name === ".git") continue;
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) pending.push(p);
        try {
          if (!content && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) entries.push(await this.entry(p));
          if (content && e.isFile() && (await stat(p)).size <= PREVIEW) {
            const preview = await this.preview(p);
            const lines = preview.text?.split("\n");
            const index = lines?.findIndex((line) => line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? -1;
            if (lines && index >= 0) entries.push({ ...await this.entry(p), line: index + 1, excerpt: lines[index]!.slice(0,300) });
          }
        } catch { /* Unreadable files do not stop a search. */ }
        if (entries.length > offset + PAGE) break;
      }
      if (entries.length > offset + PAGE) break;
    }
    return { path, parent: null, entries: entries.slice(offset, offset + PAGE), next: entries.length > offset + PAGE ? offset + PAGE : null, limited };
  }
  operate(operation: FileOperation, owner = "internal") {
    const task = this.queue.then(() => this.perform(operation, owner));
    this.queue = task.catch(() => undefined); return task;
  }
  private async absent(path: string) { try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; } throw new FileError(`已存在同名项目：${basename(path)}。请先重命名后重试`, 409); }
  private async copy(source: string, target: string, budget: { count: number; bytes: number }) {
    const s = await lstat(source);
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw new FileError("不支持复制软链接或特殊文件");
    await this.path(source);
    if (++budget.count > 10000 || (budget.bytes += s.size) > 512 * 1024 * 1024) throw new FileError("单次复制上限为 10000 项或 512 MB", 413);
    if (s.isDirectory()) {
      await mkdir(target);
      for (const name of await readdir(source)) await this.copy(join(source,name), join(target,name), budget);
    } else await copyFile(source, target, constants.COPYFILE_EXCL);
  }
  private async perform(op: FileOperation, owner: string) {
    if (op.action === "delete_prepare") return this.mutations.prepare(op.paths, owner, op.mode);
    if (op.action === "delete") return this.mutations.remove(op.token, owner);
    if (op.action === "move") return this.mutations.move(op.paths, op.directory, (source, target) => this.copy(source, target, { count: 0, bytes: 0 }));
    if (op.action === "create") {
      const target = join(await this.directory(op.directory), this.name(op.name));
      if (op.kind === "directory") await mkdir(target); else { const f = await open(target, "wx"); await f.close(); }
      return { ok: true, paths: [target] };
    }
    if (op.action === "rename") {
      const path = await this.path(op.path);
      if ((await this.roots()).includes(path)) throw new FileError("不能重命名根目录", 403);
      if ((await lstat(resolve(op.path))).isSymbolicLink()) throw new FileError("暂不支持重命名软链接");
      const target = join(dirname(path), this.name(op.name)); await this.absent(target);
      const s = await lstat(path);
      // Hard-link creation is exclusive: never overwrite an externally created file.
      if (s.isFile()) { await link(path, target); await unlink(path); }
      else if (s.isDirectory()) { await mkdir(target); await rename(path, target); }
      else throw new FileError("不支持重命名特殊文件");
      return { ok: true, paths: [target] };
    }
    const directory = await this.directory(op.directory);
    const sources = await Promise.all(op.paths.map(async (p) => { if ((await lstat(resolve(p))).isSymbolicLink()) throw new FileError("不支持复制软链接"); return this.path(p); }));
    const targets = sources.map((s) => join(directory, basename(s)));
    if (new Set(targets).size !== targets.length) throw new FileError("所选文件存在同名项目", 409);
    for (let i = 0; i < sources.length; i++) {
      if (within(sources[i]!, targets[i]!)) throw new FileError("不能复制到自身或子目录");
      await this.absent(targets[i]!);
    }
    const completed: string[] = [];
    try {
      const budget = { count: 0, bytes: 0 };
      for (let i = 0; i < sources.length; i++) { await this.copy(sources[i]!, targets[i]!, budget); completed.push(targets[i]!); }
    } catch (error) { throw new FileError(`复制未全部完成，已完成 ${completed.length} 项；目标可能有部分文件。${error instanceof Error ? error.message : "请刷新检查"}`, 409); }
    return { ok: true, paths: completed };
  }
}
