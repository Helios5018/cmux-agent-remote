import { createApp } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";
import { FakeCmuxClient } from "../src/cmux/fake-client.ts";
import type { AppContext } from "../src/context.ts";
import { RealtimeHub } from "../src/realtime/hub.ts";
import { SessionManager } from "../src/security/token.ts";
import { LoginThrottle } from "../src/security/throttle.ts";
import { StateEngine } from "../src/state/engine.ts";
import { StateStore } from "../src/state/store.ts";
import { RuntimeDiagnostics } from "../src/diagnostics.ts";

export const TEST_PIN = "4271";
export const TEST_HOOK_TOKEN = "hook-secret-for-tests-0123456789";
/** 新建 surface 时服务端「反查」出来的工作目录，测试里固定成这个值。 */
export const TEST_PANE_CWD = "/tmp/car-test-cwd";

export interface TestHarness {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  client: FakeCmuxClient;
  engine: StateEngine;
  store: StateStore;
  clock: { value: number; advance(ms: number): void };
  request(path: string, init?: RequestInit & { cookie?: string; ip?: string }): Promise<Response>;
  loginCookie(): Promise<string>;
}

export async function createHarness(options: { pin?: string; trustProxy?: boolean } = {}): Promise<TestHarness> {
  const clock = {
    value: 1_700_000_000_000,
    advance(ms: number) {
      this.value += ms;
    },
  };
  const now = () => clock.value;

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 4318,
    pin: options.pin ?? TEST_PIN,
    hookToken: TEST_HOOK_TOKEN,
    pinLength: 4,
    trustProxy: options.trustProxy ?? false,
    dataDir: "/tmp/car-test",
    dbPath: ":memory:",
    auditMaxAgeDays: 30,
    auditMaxRows: 100_000,
    staticDir: "",
    staleAfterMs: 600_000,
    demo: true,
    maxOutputLines: 400,
    maxHistoryLines: 5000,
    // 测试用假 cmux，没有真的重绘要等
    scrollRedrawDelayMs: 0,
    launchCommands: { claude: "c-d", codex: "codex-d", grok: "g-d", pi: "pi" },
  };

  const client = new FakeCmuxClient(undefined, now);
  // 真实 SQLite，但只存在内存里：既覆盖 SQL 逻辑，又不留文件
  const store = await StateStore.open(":memory:", { now });
  const hub = new RealtimeHub({ now });
  const engine = new StateEngine({ now, store, onChange: (state) => hub.broadcastStatus(state) });
  const sessions = new SessionManager({ token: config.pin, now });
  const throttle = new LoginThrottle({ now });

  const ctx: AppContext = {
    config,
    diagnostics: new RuntimeDiagnostics(now),
    client,
    engine,
    store,
    sessions,
    throttle,
    hub,
    // 假 cmux 的 tty / pid 都是编的，绝不能拿去 lsof 真实进程
    paneCwd: async () => TEST_PANE_CWD,
    now,
  };
  const app = createApp(ctx);

  // 先同步一次拓扑，让 Agent 列表就绪
  engine.syncTree(await client.getTree());

  const harness: TestHarness = {
    ctx,
    app,
    client,
    engine,
    store,
    clock,
    async request(path, init = {}) {
      const { cookie, ip, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (cookie) headers.set("cookie", cookie);
      if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      // 第三个参数就是 Bun 传给 Hono 的 env，里面带真实来源 IP
      return app.request(`http://localhost${path}`, { ...rest, headers }, { ip });
    },
    async loginCookie() {
      const response = await harness.request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ token: config.pin }),
      });
      const setCookie = response.headers.get("set-cookie") ?? "";
      return setCookie.split(";")[0] ?? "";
    },
  };

  return harness;
}
