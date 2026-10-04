import { Hono } from "hono";
import { z } from "zod";
import { GitService } from "../services/git.ts";
import { apiError } from "../context.ts";
import type { Env } from "../security/middleware.ts";
import { safeJson } from "./http.ts";
export function createGitRoutes() {
  const app = new Hono<Env>(); const git = new GitService();
  const pathSchema = z.string().min(1).max(8192);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "POST" && (!(c.req.header("content-type") ?? "").startsWith("application/json") || c.req.header("sec-fetch-site") === "cross-site")) return c.json(apiError("BAD_REQUEST", "请从本站刷新 Git"), 403);
    await next();
  });
  app.onError((error, c) => c.json(apiError("BAD_REQUEST", error instanceof z.ZodError ? "无效 Git 请求" : error.message), 400));
  app.get("/status", async c => c.json(await git.status(pathSchema.parse(c.req.query("path")))));
  app.post("/fetch", async c => {
    const body = z.object({ path: pathSchema, force: z.boolean().default(false) }).parse(await safeJson(c.req.raw));
    return c.json(await git.fetch(body.path, body.force));
  });
  app.get("/branches", async c => c.json(await git.branches(pathSchema.parse(c.req.query("path")))));
  app.get("/history", async c => c.json(await git.history(pathSchema.parse(c.req.query("path")), c.req.query("ref") ?? "HEAD", z.coerce.number().int().min(0).max(100000).parse(c.req.query("offset") ?? 0))));
  app.get("/commit", async c => c.json(await git.commit(pathSchema.parse(c.req.query("path")), z.string().min(1).parse(c.req.query("ref")))));
  app.get("/content", async c => c.json(await git.content(pathSchema.parse(c.req.query("path")), pathSchema.parse(c.req.query("file")), z.enum(["staged", "unstaged", "untracked", "commit"]).parse(c.req.query("mode")), c.req.query("ref"))));
  app.get("/diff", async c => c.json(await git.diff(pathSchema.parse(c.req.query("path")), pathSchema.parse(c.req.query("file")), z.enum(["staged", "unstaged", "untracked", "commit"]).parse(c.req.query("mode")), c.req.query("ref"))));
  return app;
}
