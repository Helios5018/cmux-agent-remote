import type { CmuxKey, ScrollKey } from "@car/protocol";

/**
 * 控制类命令的参数构造。
 *
 * 安全约束：所有写操作都必须显式带 surface，
 * 绝不允许 "send to current terminal" —— 这里用类型和运行时双重保证。
 */

export function assertSurfaceTarget(surfaceId: string | undefined | null): asserts surfaceId is string {
  if (typeof surfaceId !== "string" || surfaceId.trim().length === 0) {
    throw new Error("每个写操作都必须显式指定 surface");
  }
}

/** 新建 surface 没有 surfaceId 可带，但同样不允许「在当前 pane 建」。 */
export function assertPaneTarget(paneId: string | undefined | null): asserts paneId is string {
  if (typeof paneId !== "string" || paneId.trim().length === 0) {
    throw new Error("新建 surface 必须显式指定 pane");
  }
}

export interface NewSurfaceTarget {
  paneId: string;
  workspaceId?: string;
  /** 工作目录。不传的话 cmux 会用一个不可控的默认目录（实测会落到 /tmp）。 */
  cwd?: string;
}

/**
 * 新建 terminal surface。
 *
 * `--id-format both` 是全局选项，必须排在子命令前面，
 * 有它才会在 JSON 里带上 surface UUID —— 短引用 surface:N 重启就变，不能当主键。
 */
export function buildNewSurfaceArgs(target: NewSurfaceTarget): string[] {
  assertPaneTarget(target.paneId);
  const args = [
    "--id-format",
    "both",
    "new-surface",
    "--json",
    "--type",
    "terminal",
    "--pane",
    target.paneId,
    // 不抢 Mac 上的焦点：从手机上建 tab 不应该把桌面画面切走。
    "--focus",
    "false",
  ];
  if (target.workspaceId) args.push("--workspace", target.workspaceId);
  if (target.cwd) args.push("--working-directory", target.cwd);
  return args;
}

export function buildSendTextArgs(surfaceId: string, text: string): string[] {
  assertSurfaceTarget(surfaceId);
  // `--` 之后的内容一律当作字面文本，避免 "-r" 之类开头的 prompt 被当成 flag。
  return ["send", "--surface", surfaceId, "--", text];
}

export function buildPasteTextArgs(surfaceId: string, text: string): string[] {
  assertSurfaceTarget(surfaceId);
  // 整段文本走 bracketed paste，避免 Codex 把紧随其后的 Enter 并入粘贴。
  // terminal.paste 默认会自动提交，必须明确禁用；提交由调用方单独发一次 Enter。
  return ["rpc", "terminal.paste", JSON.stringify({ terminal_id: surfaceId, text, submit_key: "none" })];
}

export function buildSendKeyArgs(surfaceId: string, key: CmuxKey): string[] {
  assertSurfaceTarget(surfaceId);
  return ["send-key", "--surface", surfaceId, "--", key];
}

/**
 * Ctrl 组合键对应的 PTY 控制字节。
 *
 * cmux `send-key ctrl+c` / `ctrl+p` 会返回成功，但对启用了终端键盘协议的
 * Claude / Codex / Grok / Pi TUI 实测不会触发动作。直接往 PTY 写控制字节
 * 才和本机按键一致：Ctrl+C = ETX (0x03)，Ctrl+P = DLE (0x10)。
 */
export const CONTROL_KEY_BYTES: Partial<Record<CmuxKey, string>> = {
  "ctrl+c": "\x03",
  "ctrl+p": "\x10",
};

/**
 * 发送控制字符，见 `CONTROL_KEY_BYTES`。此接口不是原始 PTY 写入：
 * cmux 会将 ESC 转为独立的 Escape 按键。不能用它发送 CSI 等转义序列；
 * Option+↑ 等组合键必须走 send-key，让终端按当前键盘协议编码。
 */
export function buildTerminalInputArgs(surfaceId: string, text: string): string[] {
  assertSurfaceTarget(surfaceId);
  return ["rpc", "terminal.input", JSON.stringify({ terminal_id: surfaceId, text })];
}

export function buildKeyDeliveryArgs(surfaceId: string, key: CmuxKey): string[] {
  const bytes = CONTROL_KEY_BYTES[key];
  return bytes !== undefined ? buildTerminalInputArgs(surfaceId, bytes) : buildSendKeyArgs(surfaceId, key);
}

/**
 * 翻页。走的还是 send-key，但语义上只是换一屏来看（见 `SurfaceScrollRequestSchema`）。
 */
export function buildScrollKeyArgs(surfaceId: string, key: ScrollKey): string[] {
  assertSurfaceTarget(surfaceId);
  return ["send-key", "--surface", surfaceId, "--", key];
}

export function buildReadScreenArgs(surfaceId: string, lines: number, scrollback: boolean): string[] {
  assertSurfaceTarget(surfaceId);
  const args = ["read-screen", "--surface", surfaceId, "--lines", String(lines), "--json"];
  if (scrollback) args.push("--scrollback");
  return args;
}

/**
 * 彩色渲染网格。走 RPC 而不是 read-screen：
 * read-screen 的定义就是 "as plain text"，颜色和格子宽度在那一层已经没了。
 */
export function buildReplayArgs(surfaceId: string): string[] {
  assertSurfaceTarget(surfaceId);
  return ["rpc", "terminal.replay", JSON.stringify({ surface_id: surfaceId })];
}

export function assertWorkspaceTarget(workspaceId: string | undefined | null): asserts workspaceId is string {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new Error("改 workspace 名必须显式指定 workspace");
  }
}

export function buildRenameTabArgs(surfaceId: string, title: string, workspaceId: string): string[] {
  assertSurfaceTarget(surfaceId);
  assertWorkspaceTarget(workspaceId);
  return ["rename-tab", "--workspace", workspaceId, "--surface", surfaceId, "--title", title];
}

export function buildRenameWorkspaceArgs(workspaceId: string, title: string): string[] {
  assertWorkspaceTarget(workspaceId);
  // rename-workspace 没有 --title，只有位置参数；--title 会被当成名字写进去。
  return ["rename-workspace", "--workspace", workspaceId, "--", title];
}

/**
 * 关掉 surface。必须显式带 surface，绝不允许落到「当前焦点 tab」。
 * workspace 上下文用来定位跨 workspace 的 UUID；同 workspace 时可不传。
 */
export function buildCloseSurfaceArgs(surfaceId: string, workspaceId?: string): string[] {
  assertSurfaceTarget(surfaceId);
  const args = ["close-surface", "--surface", surfaceId];
  if (workspaceId) args.push("--workspace", workspaceId);
  return args;
}

export const TREE_ARGS = ["tree", "--all", "--json", "--id-format", "both"];
export const TOP_ARGS = ["top", "--all", "--processes", "--json"];
