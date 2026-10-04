import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * cmux-agent-web-hook 是真正跑在 Agent 进程里的那段 shell。
 * 它的两个铁律必须用真实执行来验证：
 *   1. 能把状态送到服务端
 *   2. 服务端不可用时绝不影响 Agent（exit 0 且 stdout 为空）
 */

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/cmux-agent-web-hook");

interface Received {
  url: string;
  token: string | undefined;
  body: unknown;
}

function runHook(
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "/bin/sh",
      [HOOK, ...args],
      { env: { ...process.env, ...env }, timeout: 10_000 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number"
          ? ((error as { code: number }).code)
          : 0;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.end(input);
  });
}

describe("cmux-agent-web-hook 脚本", () => {
  let server: Server;
  let port = 0;
  let received: Received[] = [];
  let home: string;

  beforeEach(async () => {
    received = [];
    home = mkdtempSync(join(tmpdir(), "car-hookhome-"));

    server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = Buffer.concat(chunks).toString("utf8");
        }
        received.push({
          url: request.url ?? "",
          token: request.headers["x-car-token"] as string | undefined,
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });

    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;

    writeFileSync(
      join(home, "hook.json"),
      JSON.stringify({ endpoint: `http://127.0.0.1:${port}/api/hooks`, token: "TOKEN-XYZ" }),
    );
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  });

  const config = () => ({ CMUX_AGENT_REMOTE_CONFIG: join(home, "hook.json") });

  it("把原生事件包成统一信封 POST 到 /api/hooks/<agent>", async () => {
    const result = await runHook(["codex", "PreToolUse"], JSON.stringify({ session_id: "s1", tool_name: "shell" }), {
      ...config(),
      CMUX_WORKSPACE_ID: "WS-1",
      CMUX_SURFACE_ID: "SURF-1",
    });

    expect(result.code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("/api/hooks/codex");
    expect(received[0]?.token).toBe("TOKEN-XYZ");

    const body = received[0]?.body as {
      event: string;
      payload: Record<string, unknown>;
      context: Record<string, unknown>;
    };
    expect(body.event).toBe("PreToolUse");
    expect(body.payload).toMatchObject({ session_id: "s1", tool_name: "shell" });
    expect(body.context).toMatchObject({ workspaceId: "WS-1", surfaceId: "SURF-1" });
    expect(Number(body.context["timestamp"])).toBeGreaterThan(1_600_000_000_000);
    expect(Number(body.context["pid"])).toBeGreaterThan(0);
  });

  it("stdin 不是 JSON 时降级成空 payload，仍然上报事件", async () => {
    await runHook(["grok", "Stop"], "这不是 JSON", config());
    expect((received[0]?.body as { payload: unknown }).payload).toEqual({});
  });

  it("stdout 必须为空（否则会污染 Claude 的 UserPromptSubmit 上下文）", async () => {
    const result = await runHook(["claude", "UserPromptSubmit"], "{}", config());
    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  });

  it("服务端不可用时静默成功，绝不影响 Agent", async () => {
    await new Promise<void>((done) => server.close(() => done()));
    const result = await runHook(["claude", "Stop"], "{}", config());
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    // 重新起一个空 server 让 afterEach 的 close 不报错
    server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  });

  it("没有配置文件时直接安静退出", async () => {
    const result = await runHook(["claude", "Stop"], "{}", {
      CMUX_AGENT_REMOTE_CONFIG: join(home, "does-not-exist.json"),
      CMUX_AGENT_REMOTE_ENDPOINT: "",
    });
    expect(result.code).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("环境变量可以覆盖配置文件", async () => {
    await runHook(["claude", "SessionStart"], "{}", {
      CMUX_AGENT_REMOTE_CONFIG: join(home, "does-not-exist.json"),
      CMUX_AGENT_REMOTE_ENDPOINT: `http://127.0.0.1:${port}/api/hooks`,
      CMUX_AGENT_REMOTE_TOKEN: "ENV-TOKEN",
    });
    expect(received[0]?.token).toBe("ENV-TOKEN");
    expect(received[0]?.url).toBe("/api/hooks/claude");
  });

  it("cwd 里的引号不会破坏 JSON", async () => {
    const weird = mkdtempSync(join(tmpdir(), 'car-we"ird-'));
    try {
      await runHook(["codex", "Stop"], "{}", { ...config(), PWD: weird });
      const body = received[0]?.body as { context: Record<string, unknown> } | undefined;
      expect(body).toBeTruthy();
      expect(typeof body?.context["cwd"]).toBe("string");
    } finally {
      rmSync(weird, { recursive: true, force: true });
    }
  });
});
