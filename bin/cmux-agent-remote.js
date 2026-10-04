#!/usr/bin/env node
/**
 * cmux-agent-remote 启动器。
 * 服务本体跑在 Bun 上（Hono + Bun.serve + WebSocket），这里只负责找到 bun 并转发参数。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../apps/server/src/index.ts");

function findBun() {
  const candidates = [
    process.env.BUN_PATH,
    join(homedir(), ".bun/bin/bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "bun";
}

const child = spawn(findBun(), ["run", entry, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error("启动失败，请确认已安装 Bun（https://bun.sh）:", error.message);
  process.exit(1);
});
