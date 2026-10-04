import { REFRESH_INTERVAL_MS, type AgentState } from "@car/protocol";
import type { CmuxClient } from "../cmux/client.ts";
import type { StateEngine } from "../state/engine.ts";
import type { RealtimeHub } from "./hub.ts";
import type { RuntimeDiagnostics } from "../diagnostics.ts";

/**
 * Surface 输出刷新策略。
 *
 * - 正在查看：300~500ms
 * - Working：1s
 * - Idle：5~10s
 * - 完全不可见、且有 hook 在管状态：不持续读取
 * 内容没变化时不向浏览器推送。
 */

export interface PollerOptions {
  diagnostics?: RuntimeDiagnostics;
  client: CmuxClient;
  engine: StateEngine;
  hub: RealtimeHub;
  now?: () => number;
  /** 拓扑刷新间隔。 */
  treeIntervalMs?: number;
  /** 主循环粒度。 */
  tickMs?: number;
  /** 同时进行的 read-screen 数量上限。 */
  concurrency?: number;
  onError?: (error: unknown, context: string) => void;
}

export class Poller {
  private readonly client: CmuxClient;
  private readonly engine: StateEngine;
  private readonly hub: RealtimeHub;
  private readonly now: () => number;
  private readonly treeIntervalMs: number;
  private readonly tickMs: number;
  private readonly concurrency: number;
  private readonly onError?: (error: unknown, context: string) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastTreeAt = 0;
  private lastTreeAttemptAt: number | null = null;
  private lastTreeSuccessAt: number | null = null;
  private treeFailures = 0;
  private readonly diagnostics?: RuntimeDiagnostics;
  private readonly nextDueAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  /** 每个 surface 最近推送过的网格 revision，避免重复推同一帧。 */
  private readonly gridRevisions = new Map<string, number>();
  private readonly observations = new Map<string, { source: "grid" | "text"; revision: number }>();

  constructor(options: PollerOptions) {
    this.diagnostics = options.diagnostics;
    this.client = options.client;
    this.engine = options.engine;
    this.hub = options.hub;
    this.now = options.now ?? Date.now;
    this.treeIntervalMs = options.treeIntervalMs ?? 2000;
    this.tickMs = options.tickMs ?? 200;
    this.concurrency = options.concurrency ?? 4;
    this.onError = options.onError;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      void this.tick().finally(() => {
        if (this.running) this.timer = setTimeout(loop, this.tickMs);
      });
    };
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 单次循环：刷新拓扑 + 读到期的 surface + 处理 stale。 */
  async tick(): Promise<void> {
    const now = this.now();

    if (now - this.lastTreeAt >= this.treeIntervalMs) {
      this.lastTreeAt = now;
      await this.refreshTree();
    }

    // stale 检查产生的状态变化同样由 engine.onChange 推送
    this.engine.tick();

    const due = this.dueSurfaces(now).slice(0, this.concurrency);
    if (due.length > 0) {
      await Promise.all(due.map((surfaceId) => this.refreshSurface(surfaceId)));
    }
  }

  async refreshTree(): Promise<void> {
    this.lastTreeAttemptAt = this.now();
    try {
      const tree = await this.client.getTree();
      const changed = this.engine.syncTree(tree);
      const live = new Set(tree.workspaces.flatMap(w => w.panes.flatMap(p => p.surfaces.map(s => s.id))));
      for (const id of this.nextDueAt.keys()) {
        if (!live.has(id)) {
          this.nextDueAt.delete(id);
          this.gridRevisions.delete(id);
          this.observations.delete(id);
        }
      }
      // 状态变化由 engine.onChange 单独推送，这里只推整表（含标题等元信息变化）。
      if (changed.length > 0) {
        this.hub.broadcast({ type: "agent.list_changed", inbox: this.engine.inbox() });
      }
      this.lastTreeSuccessAt = this.now();
      this.treeFailures = 0;
    } catch (error) {
      this.treeFailures += 1;
      this.diagnostics?.recordError("topology", error);
      this.onError?.(error, "refreshTree");
    }
  }

  topologyDiagnostics() {
    const staleAfterMs = Math.max(this.treeIntervalMs * 3, 10_000);
    return {
      status: this.treeFailures > 0 ? "degraded" as const
        : this.lastTreeSuccessAt === null ? "unknown" as const
        : this.now() - this.lastTreeSuccessAt > staleAfterMs ? "stale" as const : "ok" as const,
      lastAttemptAt: this.lastTreeAttemptAt,
      lastSuccessAt: this.lastTreeSuccessAt,
      consecutiveFailures: this.treeFailures,
      staleAfterMs,
    };
  }

  /** 计算此刻该读哪些 surface。 */
  private dueSurfaces(now: number): string[] {
    const viewed = new Set(this.hub.viewedSurfaces());
    const candidates: Array<{ surfaceId: string; due: number }> = [];

    for (const state of this.engine.list()) {
      if (state.status === "CLOSED") continue;
      if (this.inflight.has(state.surfaceId)) continue;
      const interval = this.intervalFor(state, viewed.has(state.surfaceId));
      viewed.delete(state.surfaceId);
      if (interval === null) continue;
      const due = this.nextDueAt.get(state.surfaceId) ?? 0;
      if (due <= now) candidates.push({ surfaceId: state.surfaceId, due });
    }

    // 正在被查看、但不是 Agent 的 surface（例如普通 shell）也要跟着刷新。
    for (const surfaceId of viewed) {
      if (this.inflight.has(surfaceId)) continue;
      const due = this.nextDueAt.get(surfaceId) ?? 0;
      if (due <= now) candidates.push({ surfaceId, due });
    }

    // 越早到期的越先读，保证公平。
    candidates.sort((a, b) => a.due - b.due);
    return candidates.map((item) => item.surfaceId);
  }

  /** 返回 null 表示这一轮不需要读。 */
  intervalFor(state: AgentState, isViewed: boolean): number | null {
    if (isViewed) return REFRESH_INTERVAL_MS.viewing;
    switch (state.status) {
      case "WORKING":
      case "NEEDS_APPROVAL":
      case "NEEDS_INPUT":
        return REFRESH_INTERVAL_MS.working;
      case "ERROR":
      case "RESPONDED_UNREAD":
      case "POSSIBLY_STALE":
        return REFRESH_INTERVAL_MS.idle;
      case "IDLE":
        // 有 hook 托底的 idle agent 完全不可见时不需要持续读取。
        return state.hookConnected ? null : REFRESH_INTERVAL_MS.idle;
      case "CLOSED":
        return null;
      default:
        return REFRESH_INTERVAL_MS.idle;
    }
  }

  private async refreshSurface(surfaceId: string): Promise<void> {
    this.inflight.add(surfaceId);
    const viewed = this.hub.viewedSurfaces().includes(surfaceId);
    try {
      // 正在查看的 surface 读彩色网格（贵但保真），其余只读纯文本做变化检测。
      if (viewed) await this.refreshGrid(surfaceId);
      else await this.refreshText(surfaceId);
    } catch (error) {
      this.diagnostics?.recordError(viewed ? "surface.grid" : "surface.text", error);
      this.onError?.(error, `${viewed ? "readGrid" : "readSurface"}:${surfaceId}`);
    } finally {
      this.inflight.delete(surfaceId);
      const current = this.engine.get(surfaceId);
      const isViewed = this.hub.viewedSurfaces().includes(surfaceId);
      const interval = isViewed ? REFRESH_INTERVAL_MS.viewing : current ? this.intervalFor(current, false) : null;
      this.nextDueAt.set(surfaceId, this.now() + (interval ?? REFRESH_INTERVAL_MS.idle));
    }
  }

  /** 后台刷新：纯文本，只为判断「有没有变化」。 */
  private async refreshText(surfaceId: string): Promise<void> {
    const snapshot = await this.client.readSurface(surfaceId);
    this.observe(surfaceId, "text", snapshot.revision);
  }

  /** 画面版本只用于去重；状态引擎使用独立的活动版本。 */
  private async refreshGrid(surfaceId: string): Promise<void> {
    const grid = await this.client.readGrid(surfaceId);
    if (this.gridRevisions.get(surfaceId) !== grid.revision) {
      this.gridRevisions.set(surfaceId, grid.revision);
      this.hub.sendToViewers(surfaceId, { type: "surface.grid", surfaceId, grid });
    }
    // 相同画面仍需检查静止时间，无 Hook 会话才能结束 WORKING。
    this.observe(surfaceId, "grid", grid.revision);
  }

  private observe(surfaceId: string, source: "grid" | "text", revision: number): void {
    const previous = this.observations.get(surfaceId);
    // 切换来源重新建立基线，不能比较两套独立编号。
    const changed = previous?.source === source && previous.revision !== revision;
    this.observations.set(surfaceId, { source, revision });
    const current = this.engine.get(surfaceId);
    if (!current || current.status === "CLOSED") return;
    const activityRevision = Math.max(1, current.outputRevision + (changed ? 1 : 0));
    if (this.engine.applyOutput(surfaceId, changed, activityRevision)) {
      this.hub.broadcast({ type: "agent.list_changed", inbox: this.engine.inbox() });
    }
  }

  /** 用户刚做了写操作，立刻安排一次读取。 */
  scheduleImmediate(surfaceId: string): void {
    this.nextDueAt.set(surfaceId, 0);
  }
}
