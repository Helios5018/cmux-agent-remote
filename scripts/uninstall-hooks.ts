#!/usr/bin/env bun
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind } from "@car/protocol";
import { HOOK_TARGETS, uninstallHooks } from "./hooks-config.ts";

/**
 * 移除 CMUX Agent Remote 写入的 Hook，保留用户与 cmux 自己的配置。
 *
 * 用法:
 *   bun run scripts/uninstall-hooks.ts [--dry-run] [--agent claude|codex|grok] [--home <dir>]
 */

const here = dirname(fileURLToPath(import.meta.url));

function main(): void {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const homeIndex = argv.indexOf("--home");
  const home = homeIndex >= 0 ? (argv[homeIndex + 1] ?? homedir()) : homedir();
  const agentIndex = argv.indexOf("--agent");
  const hookKinds = new Set<string>(HOOK_TARGETS.map((target) => target.agent));
  const only =
    agentIndex >= 0
      ? (argv[agentIndex + 1]?.split(",").filter((a): a is AgentKind => hookKinds.has(a)) ?? [])
      : undefined;

  const results = uninstallHooks({
    home,
    scriptPath: resolve(here, "cmux-agent-web-hook"),
    dryRun,
    only: agentIndex >= 0 ? only : undefined,
  });

  console.log(`\nCMUX Agent Remote — 卸载 Agent Hook${dryRun ? "（dry-run，不写文件）" : ""}\n`);
  for (const result of results) {
    const label = {
      removed: "✓ 已移除",
      unchanged: "· 无需改动",
      skipped: "○ 跳过",
      installed: "?",
    }[result.action];
    console.log(`  ${label} ${result.agent.padEnd(7)} ${result.path}${result.reason ? `（${result.reason}）` : ""}`);
    if (result.backup) console.log(`    备份: ${result.backup}`);
  }
  console.log("");
}

main();
