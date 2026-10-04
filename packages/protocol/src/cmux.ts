import { z } from "zod";
import { AgentKindSchema } from "./agent.ts";

/**
 * cmux 真实结构：
 * Workspace └── Pane └── Surface └── Agent Process
 */

export const CmuxSurfaceSchema = z.object({
  /** cmux surface UUID，跨重启稳定，作为系统主键。 */
  id: z.string(),
  /** 短引用 surface:11，重启后会变，只用于展示与 CLI 调用。 */
  ref: z.string(),
  paneId: z.string().optional(),
  paneRef: z.string().optional(),
  workspaceId: z.string(),
  workspaceRef: z.string().optional(),
  title: z.string(),
  type: z.string(),
  tty: z.string().nullable().optional(),
  focused: z.boolean(),
  selected: z.boolean(),
  index: z.number().int(),
  /** 进程发现的结果：该 surface 里跑的是哪个 Agent。 */
  agent: AgentKindSchema.nullable(),
  agentPid: z.number().int().positive().nullable(),
});
export type CmuxSurface = z.infer<typeof CmuxSurfaceSchema>;

export const CmuxPaneSchema = z.object({
  id: z.string().optional(),
  ref: z.string(),
  index: z.number().int(),
  focused: z.boolean(),
  surfaces: z.array(CmuxSurfaceSchema),
});
export type CmuxPane = z.infer<typeof CmuxPaneSchema>;

export const CmuxWorkspaceSchema = z.object({
  id: z.string(),
  ref: z.string(),
  index: z.number().int(),
  title: z.string(),
  description: z.string().nullable().optional(),
  selected: z.boolean(),
  windowRef: z.string().optional(),
  panes: z.array(CmuxPaneSchema),
});
export type CmuxWorkspace = z.infer<typeof CmuxWorkspaceSchema>;

export const CmuxTreeSchema = z.object({
  workspaces: z.array(CmuxWorkspaceSchema),
  /** pid → surface UUID，用于把 Hook 上报的 pid 关联到 surface。 */
  pidIndex: z.record(z.string()).default({}),
  fetchedAt: z.number(),
});
export type CmuxTree = z.infer<typeof CmuxTreeSchema>;

export const SurfaceSnapshotSchema = z.object({
  surfaceId: z.string(),
  surfaceRef: z.string().optional(),
  workspaceId: z.string().optional(),
  /** 纯文本内容（第一版不做完整 terminal emulator）。 */
  content: z.string(),
  /** 内容变化才自增。 */
  revision: z.number().int().nonnegative(),
  fetchedAt: z.number(),
});
export type SurfaceSnapshot = z.infer<typeof SurfaceSnapshotSchema>;

/**
 * 按键白名单。
 * 名字必须和 `cmux send-key` 接受的写法完全一致 —— 这里每一个都实测过，
 * cmux 对不认识的键会直接返回 invalid_params: Unknown key。
 */
export const CmuxKeySchema = z.enum([
  "enter",
  "escape",
  "tab",
  "up",
  "down",
  "left",
  "right",
  // Ctrl+D 会直接关掉 surface，因此不提供；Ctrl+P 给 Pi 快速切换模型。
  "ctrl+c",
  "ctrl+p",
  // Option+↑ 给 Codex 打开排队消息/异步提问（edit_queued_message）。
  "alt+up",
]);
export type CmuxKey = z.infer<typeof CmuxKeySchema>;

export const ALLOWED_KEYS: readonly CmuxKey[] = CmuxKeySchema.options;

/**
 * 翻页键。
 *
 * 单独一组、不并进 CmuxKeySchema：翻页不改终端里的任何内容，只是让终端
 * （或全屏 TUI 自己）换一屏来画。全屏 TUI 的历史不在
 * 终端的 scrollback 里 —— `terminal.replay` 对备用屏永远只给一屏，
 * 想回看更早的输出只有让 TUI 自己翻页这一条路。
 *
 * 只收这两个键：`home` / `end` cmux 虽然认，但语义不可靠 —— 实测对
 * Claude Code 按 `end` 画面纹丝不动，对 shell 又变成「光标移到行尾」，
 * 那已经不是看一眼的事了。
 */
export const ScrollKeySchema = z.enum(["pageup", "pagedown"]);
export type ScrollKey = z.infer<typeof ScrollKeySchema>;

/**
 * 前端可以请求的翻页动作。
 *
 * `bottom` 没有对应按键，是服务端连按 pagedown 直到画面不再变化 ——
 * TUI 没有「跳到底部」的通用键，只能这么退回最新一屏。
 */
export const ScrollActionSchema = z.enum(["pageup", "pagedown", "bottom"]);
export type ScrollAction = z.infer<typeof ScrollActionSchema>;

/**
 * 需要二次确认的危险操作。
 *
 * 这里不放 Ctrl+D：实测对着 shell 发 EOF 会直接把 surface 关掉，
 * 代价太大而收益很小，索性不给这个入口。
 */
export const DANGEROUS_KEYS: readonly CmuxKey[] = ["ctrl+c"];

export function isDangerousKey(key: CmuxKey): boolean {
  return DANGEROUS_KEYS.includes(key);
}

/** 危险按键的后果说明，确认前展示给用户。 */
export const DANGEROUS_KEY_HINT: Partial<Record<CmuxKey, string>> = {
  "ctrl+c": "发送一次 Ctrl+C：可能清空输入、中断任务或退出 Agent",
};

/** 前端按钮名 / 浏览器 KeyboardEvent.key → cmux CLI 键名。 */
const KEY_ALIASES: Record<string, CmuxKey> = {
  enter: "enter",
  return: "enter",
  esc: "escape",
  escape: "escape",
  tab: "tab",
  up: "up",
  arrowup: "up",
  down: "down",
  arrowdown: "down",
  left: "left",
  arrowleft: "left",
  right: "right",
  arrowright: "right",
  "ctrl+c": "ctrl+c",
  "ctrl-c": "ctrl+c",
  ctrlc: "ctrl+c",
  "ctrl+p": "ctrl+p",
  "ctrl-p": "ctrl+p",
  ctrlp: "ctrl+p",
  "alt+up": "alt+up",
  "alt-up": "alt+up",
  altup: "alt+up",
};

export function normalizeKey(raw: string): CmuxKey | null {
  return KEY_ALIASES[raw.trim().toLowerCase()] ?? null;
}
