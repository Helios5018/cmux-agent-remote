import type { CmuxKey, CmuxTree, ScrollKey, SurfaceGrid, SurfaceSnapshot } from "@car/protocol";

/**
 * Module 1：cmux Adapter —— 系统的眼睛和手。
 *
 * 第一版用 cmux CLI 实现；后续可换成 cmux Unix Socket，
 * 上层业务只依赖这个接口，不感知实现变化。
 */
export interface CmuxClient {
  /** 是否可用（cmux 是否在跑）。 */
  ping(): Promise<boolean>;

  /** 完整拓扑：Workspace → Pane → Surface（含 Agent 进程发现结果）。 */
  getTree(fresh?: boolean): Promise<CmuxTree>;

  /** 读取某个 surface 的当前输出（纯文本，便宜，用于后台状态推断）。 */
  readSurface(surfaceId: string, options?: ReadSurfaceOptions): Promise<SurfaceSnapshot>;

  /** Read current text without touching SnapshotTracker or Agent state. */
  readSurfaceText(surfaceId: string, options?: ReadSurfaceOptions): Promise<Omit<SurfaceSnapshot, "revision">>;

  /**
   * 读取彩色渲染网格（贵一些，只给正在查看的 surface 用）。
   * 纯文本没有颜色，也没有「每个字符占几格」的信息，无法还原 TUI。
   */
  readGrid(surfaceId: string): Promise<SurfaceGrid>;

  /**
   * 在指定 pane 里新建一个 terminal surface。
   *
   * 实现方需要保证返回时这个 surface 已经能读能写 —— cmux 的新 tab 是懒启动的，
   * 没被激活过就没有 tty，`read-screen` / `terminal.replay` 都会直接报错。
   */
  createSurface(options: CreateSurfaceOptions): Promise<CreatedSurface>;

  createWorkspace(windowId?: string): Promise<CreatedSurface>;
  createPane(workspaceId: string, surfaceId: string): Promise<CreatedSurface>;

  /** 向 surface 输入文本（只打字，不回车）。 */
  sendText(surfaceId: string, text: string, options?: SendTextOptions): Promise<void>;

  /** 向 surface 发送按键。 */
  sendKey(surfaceId: string, key: CmuxKey): Promise<void>;

  /**
   * 翻页。只改看到哪一屏，不写入内容 —— 备用屏（全屏 TUI）的历史
   * 拿不到 scrollback，只能靠这个让 TUI 自己重画更早的一屏。
   */
  scrollSurface(surfaceId: string, key: ScrollKey): Promise<void>;

  /**
   * 读取原始历史文本（含 scrollback，纯文本无颜色）。
   *
   * 与 `readSurface` 的区别：不进 SnapshotTracker、不参与状态推断 ——
   * 一次性把上千行历史塞进快照会让「输出有没有变化」的判断全乱掉。
   */
  readHistory(surfaceId: string, lines: number): Promise<string>;

  /** 改 surface / tab 在 cmux 里的真实标题。 */
  renameSurface(surfaceId: string, title: string): Promise<void>;

  /** 改 workspace 在 cmux 里的真实标题。 */
  renameWorkspace(workspaceId: string, title: string): Promise<void>;

  /**
   * 关掉一个 surface（cmux 里的真实 tab，进程一起没）。
   * workspace 里最后一个 surface 关不掉，cmux 会报 invalid_state。
   */
  closeWorkspace(workspaceId: string): Promise<void>;
  closeSurface(surfaceId: string, workspaceId?: string): Promise<void>;
}

export interface SendTextOptions {
  /** 将正文作为完整粘贴事件交付，避免 Codex 的连续输入检测吞掉提交键。 */
  bracketedPaste?: boolean;
}

export interface CreateSurfaceOptions {
  /** 目标 pane，UUID 或 pane:N 短引用。 */
  paneId: string;
  /** 用短引用时的 workspace 上下文。 */
  workspaceId?: string;
  /** 工作目录；不传由 cmux 自己决定（不可控）。 */
  cwd?: string;
}

export interface CreatedSurface {
  surfaceId: string;
  surfaceRef: string;
  paneId?: string;
  workspaceId?: string;
}

export interface ReadSurfaceOptions {
  /** 读取行数，默认 200。 */
  lines?: number;
  /** 是否包含 scrollback。 */
  scrollback?: boolean;
}

export class CmuxError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CMUX_UNAVAILABLE"
      | "CMUX_COMMAND_FAILED"
      | "SURFACE_NOT_FOUND"
      | "PANE_NOT_FOUND"
      | "WORKSPACE_NOT_FOUND"
      | "LAST_SURFACE",
    readonly detail?: string,
  ) {
    super(message);
    this.name = "CmuxError";
  }
}
