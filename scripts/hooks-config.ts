import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentKind } from "@car/protocol";

/**
 * Hook 安装 / 卸载的纯逻辑部分（方便在沙箱 HOME 里做单测）。
 *
 * 三家 Agent 的用户级 hook 配置都是同一种形状：
 *   { "hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": "..." } ] } ] } }
 * 区别只在文件位置和支持的事件名。
 */

/** 命令里带这个标记，卸载时才能精确识别是我们写进去的。 */
export const HOOK_MARKER = "cmux-agent-web-hook";

export interface HookTarget {
  agent: AgentKind;
  /** 配置文件绝对路径。 */
  path: (home: string) => string;
  /** 需要挂的原生事件。 */
  events: string[];
  /** 需要 matcher 字段的事件（工具类）。 */
  matcherEvents?: string[];
  /** 这个 Agent 的可执行文件名，用来判断是否安装了。 */
  binary: string;
  /** 该配置文件里除 hooks 之外还有别的内容（Claude 的 settings.json）。 */
  sharedFile: boolean;
}

export const HOOK_TARGETS: HookTarget[] = [
  {
    agent: "claude",
    path: (home) => join(home, ".claude", "settings.json"),
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SessionEnd",
    ],
    matcherEvents: ["PreToolUse", "PostToolUse"],
    binary: "claude",
    sharedFile: true,
  },
  {
    agent: "codex",
    path: (home) => join(home, ".codex", "hooks.json"),
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "Stop",
    ],
    matcherEvents: ["PreToolUse", "PostToolUse"],
    binary: "codex",
    sharedFile: false,
  },
  {
    agent: "grok",
    // Grok 支持 hooks 目录，用独立文件，不去碰 cmux 自己的 cmux-session.json。
    path: (home) => join(home, ".grok", "hooks", "cmux-agent-remote.json"),
    events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"],
    matcherEvents: ["PreToolUse"],
    binary: "grok",
    sharedFile: false,
  },
];

export interface HookCommandEntry {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks: HookCommandEntry[];
}

export type HooksMap = Record<string, HookMatcherEntry[]>;

export function buildCommand(scriptPath: string, agent: AgentKind, event: string): string {
  return `${quoteIfNeeded(scriptPath)} ${agent} ${event}`;
}

function quoteIfNeeded(path: string): string {
  return /[\s"']/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path;
}

function isOurEntry(entry: HookMatcherEntry): boolean {
  return entry.hooks.some((hook) => typeof hook.command === "string" && hook.command.includes(HOOK_MARKER));
}

/** 把我们的 hook 合并进已有配置，保留用户 / cmux 已有的 hook。 */
export function mergeHooks(
  existing: Record<string, unknown>,
  target: HookTarget,
  scriptPath: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  const hooks: HooksMap = { ...((existing["hooks"] as HooksMap | undefined) ?? {}) };

  for (const event of target.events) {
    const entries = [...(hooks[event] ?? [])].filter((entry) => !isOurEntry(entry));
    const entry: HookMatcherEntry = {
      hooks: [{ type: "command", command: buildCommand(scriptPath, target.agent, event), timeout: 5 }],
    };
    if (target.matcherEvents?.includes(event)) entry.matcher = "*";
    entries.push(entry);
    hooks[event] = entries;
  }

  next["hooks"] = hooks;
  return next;
}

/** 移除我们写进去的 hook，保留其它内容。 */
export function removeHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  const hooks = (existing["hooks"] as HooksMap | undefined) ?? {};
  const cleaned: HooksMap = {};

  for (const [event, entries] of Object.entries(hooks)) {
    const kept = entries.filter((entry) => !isOurEntry(entry));
    if (kept.length > 0) cleaned[event] = kept;
  }

  if (Object.keys(cleaned).length > 0) next["hooks"] = cleaned;
  else delete next["hooks"];
  return next;
}

export function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 写入前先备份成带时间戳的 .bak。 */
export function backupFile(path: string, stamp: string): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.${stamp}.bak`;
  writeFileSync(backup, readFileSync(path));
  return backup;
}

export interface ApplyResult {
  agent: AgentKind;
  path: string;
  action: "installed" | "removed" | "skipped" | "unchanged";
  backup?: string | null;
  reason?: string;
}

export interface ApplyOptions {
  home: string;
  scriptPath: string;
  dryRun?: boolean;
  /** 只处理指定 agent。 */
  only?: AgentKind[];
  /** 即使没装这个 Agent 的 CLI 也写入配置。 */
  force?: boolean;
  /** 判断 Agent CLI 是否存在，默认查 PATH。 */
  hasBinary?: (binary: string) => boolean;
  timestamp?: string;
}

export function installHooks(options: ApplyOptions): ApplyResult[] {
  const stamp = options.timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const results: ApplyResult[] = [];

  for (const target of HOOK_TARGETS) {
    if (options.only && !options.only.includes(target.agent)) continue;
    const path = target.path(options.home);

    if (!options.force && options.hasBinary && !options.hasBinary(target.binary)) {
      results.push({ agent: target.agent, path, action: "skipped", reason: `未找到 ${target.binary}` });
      continue;
    }

    const existing = readJsonFile(path);
    const merged = mergeHooks(existing, target, options.scriptPath);

    if (options.dryRun) {
      results.push({ agent: target.agent, path, action: "installed", reason: "dry-run" });
      continue;
    }

    mkdirSync(dirname(path), { recursive: true });
    const backup = backupFile(path, stamp);
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
    results.push({ agent: target.agent, path, action: "installed", backup });
  }

  return results;
}

export function uninstallHooks(options: ApplyOptions): ApplyResult[] {
  const stamp = options.timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const results: ApplyResult[] = [];

  for (const target of HOOK_TARGETS) {
    if (options.only && !options.only.includes(target.agent)) continue;
    const path = target.path(options.home);
    if (!existsSync(path)) {
      results.push({ agent: target.agent, path, action: "skipped", reason: "配置文件不存在" });
      continue;
    }

    const existing = readJsonFile(path);
    const cleaned = removeHooks(existing);
    // 独立文件清空后留一个空壳，避免 Agent 读到半截配置。
    const isEmptyShell = !target.sharedFile && Object.keys(cleaned).length === 0;
    const final = isEmptyShell ? { hooks: {} } : cleaned;

    // 和最终要写入的内容比较，保证重复卸载是幂等的。
    if (JSON.stringify(final) === JSON.stringify(existing)) {
      results.push({ agent: target.agent, path, action: "unchanged" });
      continue;
    }

    if (options.dryRun) {
      results.push({ agent: target.agent, path, action: "removed", reason: "dry-run" });
      continue;
    }

    const backup = backupFile(path, stamp);
    writeFileSync(path, `${JSON.stringify(final, null, 2)}\n`);
    results.push({ agent: target.agent, path, action: "removed", backup });
  }

  return results;
}
