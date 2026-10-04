import { createInfoRoutes } from "./api/info.ts";
import { createAgentGuideRoutes } from "./api/agent-guide.ts";
import { createGitRoutes } from "./api/git.ts";
import { createFileRoutes } from "./api/files.ts";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { SERVER_VERSION, type DiagnosticsResponse } from "@car/protocol";
import { createAgentRoutes } from "./api/agents.ts";
import { createAuthRoutes } from "./api/auth.ts";
import { createHookRoutes } from "./api/hooks.ts";
import { createSurfaceRoutes } from "./api/surfaces.ts";
import { createWorkspaceRoutes, createWorkspaceWriteRoutes } from "./api/workspaces.ts";
import { apiError, type AppContext } from "./context.ts";
import { requireAuth, type Env } from "./security/middleware.ts";

/**
 * Module 4：Web Server。
 * 这里只组装路由，不绑定运行时，方便在 Node 上用 app.request() 做集成测试。
 */
export function createApp(ctx: AppContext) {
  const app = new Hono<Env>();

  app.route("/", createAgentGuideRoutes());

  app.get("/api/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, version: SERVER_VERSION, demo: ctx.config.demo, now: ctx.now() });
  });

  // Hook 走独立鉴权（共享 token），不需要浏览器 Session。
  app.route("/api/hooks", createHookRoutes(ctx));

  app.route("/api/auth", createAuthRoutes(ctx));

  const api = new Hono<Env>();
  // 渲染网格一帧未压缩有 20~80 KB，手机上必须压；其余接口顺带受益。
  api.use("*", compress());
  api.use("*", requireAuth(ctx));
  api.get("/diagnostics", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      now: ctx.now(), demo: ctx.config.demo,
      ...ctx.diagnostics.snapshot(),
      topology: ctx.poller?.topologyDiagnostics() ?? null,
      storage: { driver: ctx.store.driver, persistent: ctx.store.persistent },
      audit: ctx.store.auditDiagnostics(),
    } satisfies DiagnosticsResponse);
  });
  api.route("/info", createInfoRoutes(ctx));
  api.route("/files", createFileRoutes(ctx));
  api.route("/git", createGitRoutes());
  api.route("/agents", createAgentRoutes(ctx));
  api.route("/tree", createWorkspaceRoutes(ctx));
  api.route("/workspaces", createWorkspaceWriteRoutes(ctx));
  api.route("/surfaces", createSurfaceRoutes(ctx));
  api.get("/audit", (c) => c.json({ entries: ctx.store.recentAudit(100) }));
  app.route("/api", api);

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json(apiError("NOT_FOUND", "接口不存在"), 404);
    }
    return c.text("Not Found", 404);
  });

  app.onError((error, c) => {
    ctx.diagnostics.recordError("api", error);
    console.error("[api] 未处理异常:", error);
    return c.json(apiError("INTERNAL", "服务器内部错误"), 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
