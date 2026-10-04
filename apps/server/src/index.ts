import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { HELP_TEXT, parseArgs, type ServerConfig } from "./config.ts";
import { CmuxCliClient } from "./cmux/cli-client.ts";
import { FakeCmuxClient } from "./cmux/fake-client.ts";
import type { CmuxClient } from "./cmux/client.ts";
import type { AppContext } from "./context.ts";
import { RealtimeHub } from "./realtime/hub.ts";
import { Poller } from "./realtime/poller.ts";
import { authenticateUpgrade, createWebSocketHandlers } from "./realtime/websocket.ts";
import { resolveAccessPin, resolveHookToken, SessionManager } from "./security/token.ts";
import { LoginThrottle } from "./security/throttle.ts";
import { StateEngine } from "./state/engine.ts";
import { StateStore } from "./state/store.ts";
import { RuntimeDiagnostics } from "./diagnostics.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const { config, help, pinProvided, rotatePin, rotateHookToken, unlock } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP_TEXT);
    return;
  }

  mkdirSync(config.dataDir, { recursive: true });

  const diagnostics = new RuntimeDiagnostics();
  const store = await StateStore.open(config.dbPath, {
    auditMaxAgeMs: config.auditMaxAgeDays * 86_400_000,
    auditMaxRows: config.auditMaxRows,
    onCleanupError: error => diagnostics.recordError("audit.cleanup", error),
  });
  try {
    config.pin = resolveAccessPin(store, {
      explicit: pinProvided ? config.pin : "",
      rotate: rotatePin,
      digits: config.pinLength,
    });
  } catch (error) {
    console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  // Hook 密钥与人用的 PIN 完全分开：PIN 短，Hook 密钥长。
  config.hookToken = resolveHookToken(store, { rotate: rotateHookToken });
  const client: CmuxClient = config.demo ? new FakeCmuxClient(undefined, Date.now, true) : new CmuxCliClient({ maxOutputLines: config.maxOutputLines });

  const hub = new RealtimeHub();
  const engine = new StateEngine({
    store,
    stale: { staleAfterMs: config.staleAfterMs },
    onChange: (state) => hub.broadcastStatus(state),
  });
  const throttle = new LoginThrottle({
    persistence: {
      load: () => store.loadThrottle(),
      save: (entry) => store.saveThrottle(entry),
      remove: (key) => store.deleteThrottle(key),
    },
    onLock: (entry, scope) => {
      const seconds = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
      console.warn(
        `[security] 连续 ${entry.failures} 次 PIN 输错（${scope === "global" ? "全局" : entry.key}），` +
          `已锁定 ${seconds}s。若是你自己输错，可用 --unlock 启动来解锁。`,
      );
    },
  });
  if (unlock) throttle.unlock();

  const sessions = new SessionManager({
    token: config.pin,
    // 重启后手机端不用重新输 PIN。
    persistence: {
      load: () => store.loadSessions(),
      save: (session) => store.saveSession(session),
      remove: (id) => store.deleteSession(id),
    },
  });

  const ctx: AppContext = {
    config,
    diagnostics,
    client,
    engine,
    store,
    sessions,
    throttle,
    hub,
    // 假数据里的 tty / pid 都是编的，别拿它们去 lsof。
    paneCwd: config.demo ? async () => null : undefined,
    now: Date.now,
  };

  const poller = new Poller({
    diagnostics,
    client,
    engine,
    hub,
    onError: (error, where) => {
      if (process.env["CAR_DEBUG"] === "1") console.error(`[poller:${where}]`, error);
    },
  });
  ctx.poller = poller;

  // Hook 脚本要知道端口和 token，写一份配置到数据目录。
  writeHookConfig(config);

  const app = createApp(ctx);
  const staticDir = resolveStaticDir(config);
  const { websocket } = createWebSocketHandlers(ctx);

  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (!bun) {
    console.error("CMUX Agent Remote 需要 Bun 运行：bun run apps/server/src/index.ts");
    process.exitCode = 1;
    return;
  }

  const server = bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    maxRequestBodySize: 512 * 1024 * 1024,
    websocket,
    fetch: async (request: Request, srv: BunServer) => {
      const url = new URL(request.url);

      const ip = srv.requestIP(request)?.address;

      if (url.pathname === "/ws") {
        const session = authenticateUpgrade(ctx, request, ip);
        if (!session) return new Response("unauthorized", { status: 401 });
        if (srv.upgrade(request, { data: {} })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }

      // 把真实来源 IP 交给 Hono，限流与「Hook 只收本机」都依赖它。
      if (url.pathname === "/agent-guide.md" || url.pathname.startsWith("/api/")) return app.fetch(request, { ip });

      if (staticDir) {
        const response = await serveStatic(staticDir, url.pathname);
        if (response) return response;
      }
      return app.fetch(request, { ip });
    },
  });

  store.startAuditCleanup();
  poller.start();
  await poller.refreshTree();

  printBanner(config, server.port);

  const shutdown = () => {
    poller.stop();
    hub.closeAll();
    store.close();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

interface BunServer {
  port: number;
  upgrade(request: Request, options?: { data?: unknown }): boolean;
  requestIP(request: Request): { address: string } | null;
  stop(closeActive?: boolean): void;
}

interface BunLike {
  serve(options: Record<string, unknown>): BunServer;
  file(path: string): { exists(): Promise<boolean>; type: string };
}

async function serveStatic(root: string, pathname: string): Promise<Response | undefined> {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (!bun) return undefined;
  const clean = pathname.replace(/\?.*$/, "");
  const relative = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  // 目录穿越防护
  const target = resolve(root, relative);
  if (!target.startsWith(resolve(root))) return new Response("forbidden", { status: 403 });

  const file = bun.file(target);
  if (await file.exists()) {
    return new Response(file as unknown as BodyInit, { headers: cacheHeaders(relative) });
  }

  // SPA 回退
  const index = bun.file(join(root, "index.html"));
  if (await index.exists()) return new Response(index as unknown as BodyInit, {
    headers: { "content-type": "text/html; charset=utf-8", ...cacheHeaders("index.html") },
  });
  return undefined;
}

/**
 * 缓存策略。
 *
 * index.html 必须每次回源校验：它引的是带内容指纹的 JS，页面被缓存住的话
 * 手机上就会一直跑旧前端 —— 改完发现「点了没反应」，其实是根本没加载新代码。
 * assets/ 下的文件名本身带 hash，可以放心长期缓存。
 */
function cacheHeaders(relative: string): Record<string, string> {
  if (relative.startsWith("assets/")) {
    return { "cache-control": "public, max-age=31536000, immutable" };
  }
  return { "cache-control": "no-cache" };
}

function resolveStaticDir(config: ServerConfig): string | null {
  const candidates = [
    config.staticDir,
    resolve(here, "../../web/dist"),
    resolve(here, "../../../apps/web/dist"),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

/** Hook 脚本读取这个文件拿到 endpoint 与 token。 */
function writeHookConfig(config: ServerConfig): void {
  const target = join(config.dataDir, "hook.json");
  const payload = {
    endpoint: `http://127.0.0.1:${config.port}/api/hooks`,
    token: config.hookToken,
    updatedAt: Date.now(),
  };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn("[hook] 无法写入 hook 配置:", error);
  }
}

function lanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function printBanner(config: ServerConfig, port: number): void {
  const lines = [
    "",
    "  CMUX Agent Remote",
    "",
    `  Local:        http://localhost:${port}`,
  ];
  if (config.host === "0.0.0.0") {
    const lan = lanAddress();
    if (lan) lines.push(`  Network:      http://${lan}:${port}`);
  }
  lines.push("", `  Access PIN:   ${config.pin}`, "");
  if (config.demo) lines.push("  模式:         DEMO（使用内置假数据）", "");
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    lines.push(
      `  ⚠ 正在对外监听 ${config.host}。${config.pin.length <= 4 ? "4 位 PIN 依赖登录限流保护，" : ""}` +
        "公网暴露请务必走 Tunnel + HTTPS，并加 --trust-proxy。",
      "",
    );
  }
  console.log(lines.join("\n"));
}

void main();
