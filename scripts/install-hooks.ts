#!/usr/bin/env bun
import { chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { AgentKind } from "@car/protocol";
import { installHooks, HOOK_TARGETS } from "./hooks-config.ts";

/**
 * 给 Claude Code / Codex CLI / Grok Build 安装用户级 Hook，
 * 三家最终都调用同一个 cmux-agent-web-hook 脚本。
 *
 * 用法:
 *   bun run scripts/install-hooks.ts [--dry-run] [--agent claude|codex|grok] [--home <dir>] [--force]
 */

const here = dirname(fileURLToPath(import.meta.url));

function hasBinary(binary: string): boolean {
  try {
    execFileSync("command", ["-v", binary], { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch {
    try {
      execFileSync("/usr/bin/which", [binary], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const homeIndex = argv.indexOf("--home");
  const home = homeIndex >= 0 ? (argv[homeIndex + 1] ?? homedir()) : homedir();
  const agentIndex = argv.indexOf("--agent");
  const hookKinds = new Set<string>(HOOK_TARGETS.map((target) => target.agent));
  const only =
    agentIndex >= 0
      ? (argv[agentIndex + 1]?.split(",").filter((a): a is AgentKind => hookKinds.has(a)) ?? [])
      : undefined;

  const scriptPath = resolve(here, "cmux-agent-web-hook");
  if (!existsSync(scriptPath)) {
    console.error(`找不到 hook 脚本: ${scriptPath}`);
    process.exitCode = 1;
    return;
  }
  try {
    chmodSync(scriptPath, 0o755);
  } catch {
    // 权限设置失败不致命
  }

  const results = installHooks({
    home,
    scriptPath,
    dryRun,
    only: agentIndex >= 0 ? only : undefined,
    force,
    hasBinary,
  });

  console.log(`\nCMUX Agent Remote — 安装 Agent Hook${dryRun ? "（dry-run，不写文件）" : ""}\n`);
  for (const result of results) {
    const target = HOOK_TARGETS.find((t) => t.agent === result.agent);
    const events = target ? target.events.join(", ") : "";
    if (result.action === "skipped") {
      console.log(`  ○ ${result.agent.padEnd(7)} 跳过：${result.reason}`);
      continue;
    }
    console.log(`  ✓ ${result.agent.padEnd(7)} ${result.path}`);
    if (events) console.log(`    事件: ${events}`);
    if (result.backup) console.log(`    备份: ${result.backup}`);
  }
  console.log(`\n  Hook 脚本: ${scriptPath}`);
  console.log(`  运行 cmux-agent-remote 后，token / 端口会自动写入 ~/.cmux-agent-remote/hook.json\n`);
  console.log(`  卸载: bun run scripts/uninstall-hooks.ts\n`);
}

main();
