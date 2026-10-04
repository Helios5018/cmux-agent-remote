import type { CmuxKey, CmuxTree, ScrollKey, SurfaceGrid, SurfaceSnapshot } from "@car/protocol";
import { createSingleFlight, TtlCache } from "@car/shared";
import {
  CmuxError,
  type CmuxClient,
  type CreatedSurface,
  type CreateSurfaceOptions,
  type ReadSurfaceOptions,
  type SendTextOptions,
} from "./client.ts";
import {
  assertSurfaceTarget,
  assertWorkspaceTarget,
  buildCloseSurfaceArgs,
  buildNewSurfaceArgs,
  buildReadScreenArgs,
  buildRenameTabArgs,
  buildRenameWorkspaceArgs,
  buildReplayArgs,
  buildScrollKeyArgs,
  buildKeyDeliveryArgs,
  buildSendTextArgs,
  buildPasteTextArgs,
  TOP_ARGS,
  TREE_ARGS,
} from "./control.ts";
import { parseTopJson, parseTree } from "./discovery.ts";
import { GridParseError, GridTracker } from "./grid.ts";
import { parseReadScreenJson, SnapshotTracker } from "./output.ts";
import { createCliRunner, type CommandRunner } from "./exec.ts";

export interface CmuxCliClientOptions {
  runner?: CommandRunner;
  /** tree/top 结果的缓存时间，默认 1s；避免多个客户端把 CLI 打爆。 */
  treeTtlMs?: number;
  now?: () => number;
  snapshotTracker?: SnapshotTracker;
  maxOutputLines?: number;
}

/** 第一版实现：通过 cmux CLI 与 cmux 通信。 */
export class CmuxCliClient implements CmuxClient {
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private readonly treeCache: TtlCache<CmuxTree>;
  private readonly treeFlight = createSingleFlight<CmuxTree>();
  readonly snapshots: SnapshotTracker;
  readonly grids = new GridTracker();
  private readonly maxOutputLines: number;

  constructor(options: CmuxCliClientOptions = {}) {
    this.runner = options.runner ?? createCliRunner();
    this.now = options.now ?? Date.now;
    this.treeCache = new TtlCache<CmuxTree>(options.treeTtlMs ?? 1000, this.now);
    this.maxOutputLines = options.maxOutputLines ?? 400;
    this.snapshots = options.snapshotTracker ?? new SnapshotTracker({ maxLines: this.maxOutputLines });
  }

  async ping(): Promise<boolean> {
    const result = await this.runner(["ping"], { timeoutMs: 3000 });
    return result.code === 0 && /pong/i.test(result.stdout);
  }

  async getTree(fresh = false): Promise<CmuxTree> {
    if (fresh) this.invalidateTree();
    const cached = this.treeCache.get("tree");
    if (cached) return cached;

    return this.treeFlight("tree", async () => {
      const cachedInFlight = this.treeCache.get("tree");
      if (cachedInFlight) return cachedInFlight;

      const [treeResult, topResult] = await Promise.all([
        this.runner(TREE_ARGS, { timeoutMs: 8000 }),
        this.runner(TOP_ARGS, { timeoutMs: 12_000 }),
      ]);

      if (treeResult.code !== 0) {
        throw new CmuxError("无法获取 cmux 拓扑", "CMUX_UNAVAILABLE", treeResult.stderr.trim());
      }

      const rawTree = parseJson(treeResult.stdout);
      if (!rawTree) {
        throw new CmuxError("cmux tree 输出不是合法 JSON", "CMUX_COMMAND_FAILED", treeResult.stdout.slice(0, 200));
      }

      // top 失败不致命：拿不到进程信息只是识别不出 Agent，拓扑仍然可用。
      const rawTop = topResult.code === 0 ? parseJson(topResult.stdout) : null;
      const processMap = parseTopJson(rawTop ?? {});

      const tree = parseTree(rawTree, processMap, this.now());
      this.treeCache.set("tree", tree);
      return tree;
    });
  }

  /** 强制重新拉取拓扑（例如收到 hook 之后）。 */
  invalidateTree(): void {
    this.treeCache.clear();
  }

  async readSurface(surfaceId: string, options: ReadSurfaceOptions = {}): Promise<SurfaceSnapshot> {
    const text = await this.readSurfaceText(surfaceId, options);
    return this.snapshots.update(text.surfaceId, text.content, text.fetchedAt, {
      surfaceRef: text.surfaceRef, workspaceId: text.workspaceId,
    }).snapshot;
  }

  async readSurfaceText(surfaceId: string, options: ReadSurfaceOptions = {}): Promise<Omit<SurfaceSnapshot, "revision">> {
    const args = buildReadScreenArgs(surfaceId, options.lines ?? this.maxOutputLines, options.scrollback ?? false);
    const result = await this.runner(args, { timeoutMs: 8000 });
    if (result.code !== 0) {
      const message = result.stderr.trim();
      if (/not found|no such|unknown surface/i.test(message)) {
        throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND", message);
      }
      throw new CmuxError(`读取 surface 失败: ${surfaceId}`, "CMUX_COMMAND_FAILED", message);
    }
    const parsed = parseReadScreenJson(parseJson(result.stdout) ?? {});
    return { surfaceId: parsed.surfaceId ?? surfaceId, content: parsed.text, fetchedAt: this.now(),
      surfaceRef: parsed.surfaceRef, workspaceId: parsed.workspaceId };
  }

  async readHistory(surfaceId: string, lines: number): Promise<string> {
    const args = buildReadScreenArgs(surfaceId, lines, true);
    const result = await this.runner(args, { timeoutMs: 12_000 });
    if (result.code !== 0) {
      const message = result.stderr.trim();
      if (/not found|no such|unknown surface/i.test(message)) {
        throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND", message);
      }
      throw new CmuxError(`读取历史失败: ${surfaceId}`, "CMUX_COMMAND_FAILED", message);
    }
    // 刻意绕开 snapshots：这里的文本只给人看，不能污染状态推断的基线。
    return parseReadScreenJson(parseJson(result.stdout) ?? {}).text;
  }

  async readGrid(surfaceId: string): Promise<SurfaceGrid> {
    const result = await this.runner(buildReplayArgs(surfaceId), { timeoutMs: 8000 });
    if (result.code !== 0) {
      const message = result.stderr.trim();
      if (/not found|no such|unknown surface/i.test(message)) {
        throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND", message);
      }
      throw new CmuxError(`读取渲染网格失败: ${surfaceId}`, "CMUX_COMMAND_FAILED", message);
    }
    const raw = parseJson(result.stdout);
    if (!raw) {
      throw new CmuxError("terminal.replay 输出不是合法 JSON", "CMUX_COMMAND_FAILED", result.stdout.slice(0, 200));
    }
    try {
      return this.grids.parse(raw, surfaceId, this.now());
    } catch (error) {
      if (error instanceof GridParseError) {
        throw new CmuxError(error.message, "CMUX_COMMAND_FAILED");
      }
      throw error;
    }
  }

  async createSurface(options: CreateSurfaceOptions): Promise<CreatedSurface> {
    const result = await this.runner(buildNewSurfaceArgs(options), { timeoutMs: 10_000 });
    if (result.code !== 0) {
      const message = result.stderr.trim();
      if (/not found|no such|unknown pane|invalid_params/i.test(message)) {
        throw new CmuxError(`pane 不存在: ${options.paneId}`, "PANE_NOT_FOUND", message);
      }
      throw new CmuxError("新建 surface 失败", "CMUX_COMMAND_FAILED", message);
    }

    const raw = parseJson(result.stdout) as Record<string, unknown> | null;
    const surfaceId = typeof raw?.["surface_id"] === "string" ? (raw["surface_id"] as string) : "";
    const surfaceRef = typeof raw?.["surface_ref"] === "string" ? (raw["surface_ref"] as string) : "";
    if (!surfaceId) {
      // 没有 UUID 就没法当主键用，宁可报错也不要返回一个会随重启失效的 ref。
      throw new CmuxError("cmux 没有返回新 surface 的 id", "CMUX_COMMAND_FAILED", result.stdout.slice(0, 200));
    }

    // cmux 的新 tab 是懒启动的：没被激活过就没有 tty，读画面会报
    // internal_error: Failed to read terminal text。发一次回车把 shell 拉起来 ——
    // 回车最干净，只多一行提示符（escape 会在终端里留个 ^[）。
    try {
      await this.sendKey(surfaceId, "enter");
    } catch {
      // 唤醒失败不回滚：surface 已经建出来了，让用户在会话页里自己敲一下也能起来。
    }

    this.invalidateTree();
    return {
      surfaceId,
      surfaceRef: surfaceRef || surfaceId,
      paneId: typeof raw?.["pane_id"] === "string" ? (raw["pane_id"] as string) : undefined,
      workspaceId: typeof raw?.["workspace_id"] === "string" ? (raw["workspace_id"] as string) : undefined,
    };
  }

  async createWorkspace(windowId?: string): Promise<CreatedSurface> {
    // legacy new-workspace 即使传 --json 也可能只输出 OK workspace:N。
    return this.createTopology(["rpc", "workspace.create", JSON.stringify({
      ...(windowId ? { window_id: windowId } : {}), focus: false,
    })]);
  }

  async createPane(workspaceId: string, surfaceId: string): Promise<CreatedSurface> {
    assertWorkspaceTarget(workspaceId);
    assertSurfaceTarget(surfaceId);
    return this.createTopology(["--id-format", "both", "new-split", "right",
      "--workspace", workspaceId, "--surface", surfaceId, "--focus", "false", "--json"]);
  }

  private async createTopology(args: string[]): Promise<CreatedSurface> {
    const result = await this.runner(args, { timeoutMs: 10_000 });
    if (result.code !== 0) {
      throw new CmuxError("创建失败：" + (result.stderr.trim() || "cmux 命令失败"), "CMUX_COMMAND_FAILED");
    }
    this.invalidateTree();
    const raw = parseJson(result.stdout) as Record<string, unknown> | null;
    if (typeof raw?.surface_id !== "string" || typeof raw.workspace_id !== "string") {
      throw new CmuxError("cmux 没有返回新终端或 workspace 的 id，请刷新查看创建结果", "CMUX_COMMAND_FAILED");
    }
    // 只唤醒本次新建的 terminal，不向分屏来源发送输入。
    try { await this.sendKey(raw.surface_id, "enter"); } catch { /* 已创建，不能诱导重复创建。 */ }
    return {
      surfaceId: raw.surface_id,
      surfaceRef: typeof raw.surface_ref === "string" ? raw.surface_ref : raw.surface_id,
      workspaceId: raw.workspace_id,
      paneId: typeof raw.pane_id === "string" ? raw.pane_id : undefined,
    };
  }

  async sendText(surfaceId: string, text: string, options: SendTextOptions = {}): Promise<void> {
    const args = options.bracketedPaste ? buildPasteTextArgs(surfaceId, text) : buildSendTextArgs(surfaceId, text);
    const result = await this.runner(args, { timeoutMs: 8000 });
    if (result.code !== 0) {
      throw new CmuxError(`发送文本失败: ${surfaceId}`, "CMUX_COMMAND_FAILED", result.stderr.trim());
    }
  }

  async sendKey(surfaceId: string, key: CmuxKey): Promise<void> {
    const result = await this.runner(buildKeyDeliveryArgs(surfaceId, key), { timeoutMs: 8000 });
    if (result.code !== 0) {
      throw new CmuxError(`发送按键失败: ${surfaceId}`, "CMUX_COMMAND_FAILED", result.stderr.trim());
    }
  }

  async scrollSurface(surfaceId: string, key: ScrollKey): Promise<void> {
    const result = await this.runner(buildScrollKeyArgs(surfaceId, key), { timeoutMs: 8000 });
    if (result.code !== 0) {
      const message = result.stderr.trim();
      if (/not found|no such|unknown surface/i.test(message)) {
        throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND", message);
      }
      throw new CmuxError(`翻页失败: ${surfaceId}`, "CMUX_COMMAND_FAILED", message);
    }
  }

  async renameSurface(surfaceId: string, title: string): Promise<void> {
    // rename-tab 的 UUID 也在 workspace 内解析，不能沿用服务进程的当前工作区。
    assertSurfaceTarget(surfaceId);
    this.invalidateTree();
    const tree = await this.getTree();
    const workspace = tree.workspaces.find((item) =>
      item.panes.some((pane) => pane.surfaces.some((surface) => surface.id === surfaceId || surface.ref === surfaceId)),
    );
    if (!workspace) throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND");
    const result = await this.runner(buildRenameTabArgs(surfaceId, title, workspace.id), { timeoutMs: 8000 });
    if (result.code !== 0) {
      const message = result.stderr.trim();
      if (/not[_ ]found|no such|unknown surface|unknown tab/i.test(message)) {
        throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND", message);
      }
      throw new CmuxError(`改 surface 名称失败: ${surfaceId}`, "CMUX_COMMAND_FAILED", message);
    }
    this.invalidateTree();
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<void> {
    const result = await this.runner(buildRenameWorkspaceArgs(workspaceId, title), { timeoutMs: 8000 });
    if (result.code !== 0) {
      const message = result.stderr.trim();
      if (/not found|no such|unknown workspace/i.test(message)) {
        throw new CmuxError(`workspace 不存在: ${workspaceId}`, "WORKSPACE_NOT_FOUND", message);
      }
      throw new CmuxError(`改 workspace 名称失败: ${workspaceId}`, "CMUX_COMMAND_FAILED", message);
    }
    this.invalidateTree();
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    assertWorkspaceTarget(workspaceId);
    const tree = await this.getTree();
    const result = await this.runner(["close-workspace", "--workspace", workspaceId], { timeoutMs: 10_000 });
    this.invalidateTree();
    if (result.code !== 0) throw new CmuxError("关闭 workspace 失败：" + result.stderr.trim(), "CMUX_COMMAND_FAILED");
    for (const pane of tree.workspaces.find(w => w.id === workspaceId)?.panes ?? []) {
      for (const surface of pane.surfaces) {
        this.snapshots.forget(surface.id);
        this.grids.forget(surface.id);
      }
    }
  }

  async closeSurface(surfaceId: string, workspaceId?: string): Promise<void> {
    const result = await this.runner(buildCloseSurfaceArgs(surfaceId, workspaceId), { timeoutMs: 8000 });
    if (result.code !== 0) {
      const message = result.stderr.trim();
      if (/last surface/i.test(message)) {
        throw new CmuxError("这是这个 workspace 里最后一个 surface，cmux 不允许关掉", "LAST_SURFACE", message);
      }
      if (/not found|no such|unknown surface/i.test(message)) {
        throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND", message);
      }
      throw new CmuxError(`关闭 surface 失败: ${surfaceId}`, "CMUX_COMMAND_FAILED", message);
    }
    this.snapshots.forget(surfaceId);
    this.grids.forget(surfaceId);
    this.invalidateTree();
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // cmux 偶尔会在 JSON 前打印一行提示（例如别名弃用通知）。
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}
