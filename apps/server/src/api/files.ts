import { saveUpload } from "../services/uploads.ts";
import { mediaResponse } from "../services/media.ts";
import { homedir } from "node:os";
import { Hono } from "hono";
import { extname } from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { FileOperationSchema } from "@car/protocol";
import { FileError, FileService, imageTypes } from "../services/files.ts";
import { apiError, type AppContext } from "../context.ts";
import type { Env } from "../security/middleware.ts";
import { safeJson } from "./http.ts";
export function createFileRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const files = new FileService();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const upload = c.req.path.endsWith("/upload");
    const contentType = c.req.header("content-type") ?? "";
    const validType = upload ? contentType === "application/octet-stream" : contentType.startsWith("application/json");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && (!validType || c.req.header("sec-fetch-site") === "cross-site")) {
      return c.json(apiError("BAD_REQUEST", "请从本站提交文件操作"), 403);
    }
    await next();
  });
  app.onError((error, c) => {
    const code = (error as NodeJS.ErrnoException).code;
    const status = error instanceof FileError ? error.status : code === "ENOENT" ? 404 : code === "EEXIST" ? 409 : code === "EACCES" || code === "EPERM" ? 403 : 400;
    return c.json(apiError("BAD_REQUEST", error instanceof FileError ? error.message : code === "ENOENT" ? "文件或目录已不存在" : code === "EEXIST" ? "已存在同名项目，请换一个名称" : "无法操作该路径，请检查权限和文件状态"), status);
  });
  app.post("/upload", async (c) => c.json(await saveUpload(ctx.config.dataDir, c.req.raw), 201));
  app.get("/roots", async (c) => c.json({ roots: await files.roots(), home: homedir() }));
  app.get("/list", async (c) => {
    const offset = Number(c.req.query("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new FileError("无效分页位置");
    const path = c.req.query("path") ?? (await files.roots())[0]!;
    const query = (c.req.query("q") ?? "").slice(0, 200);
    const mode = c.req.query("mode");
    return c.json(query && (mode === "name" || mode === "content")
      ? await files.search(path, query, mode === "content", c.req.query("hidden") === "1", offset, c.req.raw.signal)
      : await files.list(path, c.req.query("hidden") === "1", query, offset));
  });
  app.get("/preview", async (c) => c.json(await files.preview(c.req.query("path") ?? "")));
  app.on(["GET", "HEAD"], "/media", async (c) => mediaResponse(await files.path(c.req.query("path") ?? ""), c.req.raw));
  app.get("/download", async (c) => {
    const path = await files.path(c.req.query("path") ?? "");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await handle.stat();
      if (!s.isFile()) throw new FileError("只能下载普通文件");
      if (s.size > 20 * 1024 * 1024) throw new FileError("下载或图片预览上限为 20 MB", 413);
      const bytes = await handle.readFile();
      const inline = c.req.query("inline") === "1" && imageTypes[extname(path).toLowerCase()];
      return new Response(bytes, { headers: { "Content-Type": inline || "application/octet-stream", "Content-Disposition": inline ? "inline" : "attachment", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; sandbox" } });
    } finally { await handle.close(); }
  });
  app.post("/operation", async (c) => {
    const body = FileOperationSchema.safeParse(await safeJson(c.req.raw));
    if (!body.success) throw new FileError("无效文件操作");
    return c.json(await files.operate(body.data, c.get("session").id));
  });
  return app;
}
