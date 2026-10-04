import type { AgentKind, CmuxKey, CmuxTree, GridSpan, ScrollKey, SurfaceGrid, SurfaceSnapshot } from "@car/protocol";
import {
  CmuxError,
  type CmuxClient,
  type CreatedSurface,
  type CreateSurfaceOptions,
  type ReadSurfaceOptions,
} from "./client.ts";
import { SnapshotTracker } from "./output.ts";

/**
 * 假的 cmux（--demo）。
 *
 * 两个用途：
 * 1. 在没有 cmux 的机器上演示 / 跑集成测试。
 * 2. 单测里精确控制拓扑与输出。
 */
export interface FakeSurfaceSpec {
  id: string;
  ref: string;
  title: string;
  agent: AgentKind | null;
  pid?: number;
  content: string;
  /** 视口之上更早的历史，用来演示翻页与「加载更早的历史」。 */
  history?: string;
}

export interface FakeWorkspaceSpec {
  id: string;
  ref: string;
  title: string;
  panes: Array<{ ref: string; id?: string; surfaces: FakeSurfaceSpec[] }>;
}

export class FakeCmuxClient implements CmuxClient {
  readonly sentText: Array<{ surfaceId: string; text: string }> = [];
  readonly sentKeys: Array<{ surfaceId: string; key: CmuxKey }> = [];
  readonly sentScrolls: Array<{ surfaceId: string; key: ScrollKey }> = [];
  readonly created: CreateSurfaceOptions[] = [];
  readonly closed: string[] = [];
  private nextSurfaceSeq = 0;
  private readonly snapshots = new SnapshotTracker();
  private readonly gridRevisions = new Map<string, { content: string; revision: number }>();
  /** surfaceId → 当前上滚了多少行，模拟翻页。 */
  private readonly scrollOffsets = new Map<string, number>();
  available = true;

  constructor(
    private workspaces: FakeWorkspaceSpec[] = defaultWorkspaces(),
    private readonly now: () => number = Date.now,
    private readonly uuidIds = false,
  ) {
    if (uuidIds) for (const workspace of this.workspaces) {
      workspace.id = crypto.randomUUID();
      for (const pane of workspace.panes) {
        pane.id = crypto.randomUUID();
        for (const surface of pane.surfaces) surface.id = crypto.randomUUID();
      }
    }
  }

  async ping(): Promise<boolean> {
    return this.available;
  }

  async getTree(): Promise<CmuxTree> {
    const pidIndex: Record<string, string> = {};
    const tree: CmuxTree = {
      fetchedAt: this.now(),
      pidIndex,
      workspaces: this.workspaces.map((workspace, wIndex) => ({
        id: workspace.id,
        ref: workspace.ref,
        index: wIndex,
        title: workspace.title,
        description: null,
        selected: wIndex === 0,
        windowRef: "window:1",
        panes: workspace.panes.map((pane, pIndex) => ({
          id: pane.id,
          ref: pane.ref,
          index: pIndex,
          focused: pIndex === 0,
          surfaces: pane.surfaces.map((surface, sIndex) => {
            if (surface.pid) pidIndex[String(surface.pid)] = surface.id;
            return {
              id: surface.id,
              ref: surface.ref,
              paneId: pane.id,
              paneRef: pane.ref,
              workspaceId: workspace.id,
              workspaceRef: workspace.ref,
              title: surface.title,
              type: "terminal",
              tty: null,
              focused: false,
              selected: sIndex === 0,
              index: sIndex,
              agent: surface.agent,
              agentPid: surface.pid ?? null,
            };
          }),
        })),
      })),
    };
    return tree;
  }

  async readSurface(surfaceId: string, _options: ReadSurfaceOptions = {}): Promise<SurfaceSnapshot> {
    const surface = this.findSurface(surfaceId);
    if (!surface) throw new Error(`surface not found: ${surfaceId}`);
    const { snapshot } = this.snapshots.update(surfaceId, surface.content, this.now());
    return snapshot;
  }

  async readSurfaceText(surfaceId: string, options: ReadSurfaceOptions = {}): Promise<Omit<SurfaceSnapshot, "revision">> {
    const surface = this.findSurface(surfaceId);
    if (!surface) throw new Error(`surface not found: ${surfaceId}`);
    return { surfaceId, content: surface.content.split("\n").slice(-(options.lines ?? 200)).join("\n"), fetchedAt: this.now() };
  }

  /** 把假内容按行摊成网格，每行一段，够测试链路用。 */
  async readGrid(surfaceId: string): Promise<SurfaceGrid> {
    const surface = this.findSurface(surfaceId);
    if (!surface) throw new Error(`surface not found: ${surfaceId}`);
    const full = this.fullLines(surface);
    const viewportRows = surface.content.split("\n").length;
    // 和真实终端一样：视口是缓冲区末尾的一个窗口，翻页只是把窗口往上挪
    const offset = this.clampOffset(surfaceId, full.length - viewportRows);
    const lines = full.slice(full.length - viewportRows - offset, full.length - offset);
    const spans: GridSpan[] = lines.map((line, row) => [row, 0, line.startsWith(">") ? 1 : 0, line, line.length]);
    // 和真实实现一样：内容没变 revision 就不动，否则「没变化不推送」的逻辑没法验证
    const shown = lines.join("\n");
    const last = this.gridRevisions.get(surfaceId);
    const revision = last && last.content === shown ? last.revision : (last?.revision ?? 0) + 1;
    this.gridRevisions.set(surfaceId, { content: shown, revision });
    return {
      surfaceId,
      columns: Math.max(20, ...lines.map((line) => line.length)),
      viewportRows,
      scrollbackRows: 0,
      historyRows: full.length - viewportRows,
      scrolledRows: offset,
      altScreen: false,
      foreground: "#d8dee9",
      background: "#0d1014",
      cursor: { row: Math.max(0, lines.length - 1), column: 0, visible: true },
      styles: [{}, { f: "#a3be8c" }],
      spans,
      revision,
      fetchedAt: this.now(),
    };
  }

  async readHistory(surfaceId: string, lines: number): Promise<string> {
    const surface = this.findSurface(surfaceId);
    if (!surface) throw new Error(`surface not found: ${surfaceId}`);
    const full = this.fullLines(surface);
    return full.slice(Math.max(0, full.length - lines)).join("\n");
  }

  async createSurface(options: CreateSurfaceOptions): Promise<CreatedSurface> {
    const target = this.findPane(options.paneId);
    if (!target) throw new Error(`pane not found: ${options.paneId}`);
    this.created.push(options);

    const seq = (this.nextSurfaceSeq += 1);
    const surface: FakeSurfaceSpec = {
      id: this.uuidIds ? crypto.randomUUID() : `sf-new-${seq}`,
      ref: `surface:${900 + seq}`,
      title: "Terminal",
      agent: null,
      // 真实实现建完会发一次回车把 shell 拉起来，这里也给一个提示符。
      content: `➜  ${options.cwd ?? "~"} `,
    };
    target.pane.surfaces.push(surface);
    return {
      surfaceId: surface.id,
      surfaceRef: surface.ref,
      paneId: target.pane.id,
      workspaceId: target.workspaceId,
    };
  }

  async createWorkspace(_windowId?: string): Promise<CreatedSurface> {
    const id = crypto.randomUUID();
    const paneId = crypto.randomUUID();
    this.workspaces.push({ id, ref: `workspace:${id}`, title: "新 Workspace",
      panes: [{ id: paneId, ref: `pane:${paneId}`, surfaces: [] }] });
    return this.createSurface({ paneId: paneId, workspaceId: id });
  }

  async createPane(workspaceId: string, surfaceId: string): Promise<CreatedSurface> {
    const workspace = this.workspaces.find(w => w.id === workspaceId);
    if (!workspace || !workspace.panes.some(p => p.surfaces.some(s => s.id === surfaceId))) {
      throw new CmuxError("workspace 或 surface 不存在", "WORKSPACE_NOT_FOUND");
    }
    const id = crypto.randomUUID();
    workspace.panes.push({ id, ref: `pane:${id}`, surfaces: [] });
    return this.createSurface({ paneId: id, workspaceId });
  }

  async sendText(surfaceId: string, text: string): Promise<void> {
    const surface = this.findSurface(surfaceId);
    if (!surface) throw new Error(`surface not found: ${surfaceId}`);
    this.sentText.push({ surfaceId, text });
    surface.content = `${surface.content}\n> ${text}`;
  }

  async sendKey(surfaceId: string, key: CmuxKey): Promise<void> {
    const surface = this.findSurface(surfaceId);
    if (!surface) throw new Error(`surface not found: ${surfaceId}`);
    this.sentKeys.push({ surfaceId, key });
  }

  async scrollSurface(surfaceId: string, key: ScrollKey): Promise<void> {
    const surface = this.findSurface(surfaceId);
    if (!surface) throw new Error(`surface not found: ${surfaceId}`);
    this.sentScrolls.push({ surfaceId, key });
    const viewportRows = surface.content.split("\n").length;
    const maxOffset = Math.max(0, this.fullLines(surface).length - viewportRows);
    const current = this.scrollOffsets.get(surfaceId) ?? 0;
    const next = key === "pageup" ? current + viewportRows : current - viewportRows;
    this.scrollOffsets.set(surfaceId, Math.min(maxOffset, Math.max(0, next)));
  }

  // ---- 测试辅助 ----

  /** 历史 + 当前内容，就是这个 surface 的完整缓冲区。 */
  private fullLines(surface: FakeSurfaceSpec): string[] {
    const history = surface.history ? surface.history.split("\n") : [];
    return [...history, ...surface.content.split("\n")];
  }

  private clampOffset(surfaceId: string, maxOffset: number): number {
    const offset = Math.min(Math.max(0, maxOffset), this.scrollOffsets.get(surfaceId) ?? 0);
    this.scrollOffsets.set(surfaceId, offset);
    return offset;
  }

  findPane(paneId: string): { pane: FakeWorkspaceSpec["panes"][number]; workspaceId: string } | undefined {
    for (const workspace of this.workspaces) {
      for (const pane of workspace.panes) {
        if (pane.id === paneId || pane.ref === paneId) return { pane, workspaceId: workspace.id };
      }
    }
    return undefined;
  }

  findSurface(surfaceId: string): FakeSurfaceSpec | undefined {
    for (const workspace of this.workspaces) {
      for (const pane of workspace.panes) {
        for (const surface of pane.surfaces) {
          if (surface.id === surfaceId || surface.ref === surfaceId) return surface;
        }
      }
    }
    return undefined;
  }

  appendOutput(surfaceId: string, text: string): void {
    const surface = this.findSurface(surfaceId);
    if (surface) surface.content = `${surface.content}\n${text}`;
  }

  removeSurface(surfaceId: string): void {
    for (const workspace of this.workspaces) {
      for (const pane of workspace.panes) {
        pane.surfaces = pane.surfaces.filter((surface) => surface.id !== surfaceId);
      }
    }
  }

  setWorkspaces(workspaces: FakeWorkspaceSpec[]): void {
    this.workspaces = workspaces;
  }

  async renameSurface(surfaceId: string, title: string): Promise<void> {
    const surface = this.findSurface(surfaceId);
    if (!surface) throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND");
    surface.title = title;
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<void> {
    const workspace = this.workspaces.find((item) => item.id === workspaceId || item.ref === workspaceId);
    if (!workspace) throw new CmuxError(`workspace 不存在: ${workspaceId}`, "WORKSPACE_NOT_FOUND");
    workspace.title = title;
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.find(w => w.id === workspaceId);
    if (!workspace) throw new CmuxError("workspace 不存在", "WORKSPACE_NOT_FOUND");
    this.closed.push(...workspace.panes.flatMap(p => p.surfaces.map(s => s.id)));
    this.workspaces = this.workspaces.filter(w => w.id !== workspaceId);
  }

  async closeSurface(surfaceId: string, _workspaceId?: string): Promise<void> {
    for (const workspace of this.workspaces) {
      const total = workspace.panes.reduce((sum, pane) => sum + pane.surfaces.length, 0);
      for (const pane of workspace.panes) {
        const hit = pane.surfaces.some((surface) => surface.id === surfaceId || surface.ref === surfaceId);
        if (!hit) continue;
        if (total <= 1) {
          throw new CmuxError("这是这个 workspace 里最后一个 surface，cmux 不允许关掉", "LAST_SURFACE");
        }
        pane.surfaces = pane.surfaces.filter((surface) => surface.id !== surfaceId && surface.ref !== surfaceId);
        this.closed.push(surfaceId);
        if (pane.surfaces.length === 0) {
          workspace.panes = workspace.panes.filter((item) => item !== pane);
        }
        return;
      }
    }
    throw new CmuxError(`surface 不存在: ${surfaceId}`, "SURFACE_NOT_FOUND");
  }
}

export function defaultWorkspaces(): FakeWorkspaceSpec[] {
  return [
    {
      id: "ws-world-model",
      ref: "workspace:5",
      title: "世界模型 Demo",
      panes: [
        {
          ref: "pane:7",
          id: "pane-7",
          surfaces: [
            {
              id: "sf-10",
              ref: "surface:10",
              title: "codex — 世界模型 Demo",
              agent: "codex",
              pid: 51001,
              content: "$ codex\n准备就绪。",
            },
            {
              id: "sf-11",
              ref: "surface:11",
              title: "codex — 评测流水线",
              agent: "codex",
              pid: 51002,
              content: "Running pnpm test...\n\n14 tests passed\n2 tests failed",
              // 给 demo 一段更早的历史，翻页和「加载更早的历史」才有东西可看
              history: Array.from({ length: 120 }, (_, i) => `[build] step ${i + 1}/120 done`).join("\n"),
            },
          ],
        },
        {
          ref: "pane:8",
          id: "pane-8",
          surfaces: [
            {
              id: "sf-12",
              ref: "surface:12",
              title: "zsh",
              agent: null,
              content: "$ ",
            },
          ],
        },
      ],
    },
    {
      id: "ws-eval",
      ref: "workspace:6",
      title: "业务评测平台",
      panes: [
        {
          ref: "pane:9",
          id: "pane-9",
          surfaces: [
            {
              id: "sf-20",
              ref: "surface:20",
              title: "claude — 业务评测平台",
              agent: "claude",
              pid: 52001,
              content: "我已经更新了 3 个文件，并修复了 evaluation mapping。",
            },
            {
              id: "sf-21",
              ref: "surface:21",
              title: "grok — P02 Evaluation",
              agent: "grok",
              pid: 52002,
              content: "Running command: pnpm lint",
            },
          ],
        },
      ],
    },
  ];
}
