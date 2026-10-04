import {
  buildInbox,
  type AgentEvent,
  type AgentState,
  type AgentStatus,
  type CmuxSurface,
  type CmuxTree,
  type Inbox,
} from "@car/protocol";
import { agentSurfaces } from "../cmux/discovery.ts";
import type { StateStore } from "./store.ts";
import {
  applyStaleRule,
  DEFAULT_STALE_CONFIG,
  inferStatusFromOutput,
  type StaleConfig,
} from "./stale.ts";

/**
 * Module 3：State Engine —— 整个系统的大脑。
 *
 * 输入：cmux 拓扑 + Agent Hook + 进程状态 + 用户阅读状态 + 时间
 * 输出：统一的 AgentState 以及首页 Attention 排序
 */

export interface StateEngineOptions {
  store?: StateStore;
  now?: () => number;
  stale?: Partial<StaleConfig>;
  /** CLOSED 的 Agent 在列表里保留多久，默认 5 分钟。 */
  closedRetentionMs?: number;
  onChange?: (state: AgentState, previous: AgentStatus | undefined) => void;
}

export class StateEngine {
  private readonly agents = new Map<string, AgentState>();
  /** 用户当前正在查看的 surface（WebSocket 订阅维护）。 */
  private readonly viewing = new Set<string>();
  /** sessionId → surfaceId，Hook 缺 surfaceId 时用来补齐。 */
  private readonly sessionIndex = new Map<string, string>();
  /** pid → surfaceId，来自 cmux 进程树。 */
  private pidIndex = new Map<number, string>();
  /** surfaceId → 最近一次输出变化时间。 */
  private readonly outputChangedAt = new Map<string, number>();
  private closedAt = new Map<string, number>();

  private readonly now: () => number;
  private readonly staleConfig: StaleConfig;
  private readonly closedRetentionMs: number;
  private readonly store?: StateStore;
  private readonly onChange?: (state: AgentState, previous: AgentStatus | undefined) => void;

  constructor(options: StateEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.staleConfig = { ...DEFAULT_STALE_CONFIG, ...options.stale };
    this.closedRetentionMs = options.closedRetentionMs ?? 5 * 60 * 1000;
    this.store = options.store;
    this.onChange = options.onChange;
    this.restore();
  }

  private restore(): void {
    if (!this.store) return;
    for (const row of this.store.loadAll()) {
      // 上次运行就已经退出的 Agent 不用恢复，等 syncTree 决定谁还活着。
      if (row.status === "CLOSED") {
        this.store.deleteAgent(row.surfaceId);
        continue;
      }
      // 重启后不继承 WORKING：进程还在不在要等第一次 syncTree 才知道。
      this.agents.set(row.surfaceId, {
        id: row.surfaceId,
        agent: row.agent,
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        paneId: row.paneId,
        surfaceId: row.surfaceId,
        pid: row.pid,
        status: row.status === "WORKING" ? "POSSIBLY_STALE" : row.status,
        currentActivity: row.currentActivity,
        lastActivityAt: row.lastActivityAt,
        lastViewedAt: row.lastViewedAt,
        turnStartedAt: row.turnStartedAt,
        statusChangedAt: row.statusChangedAt,
        hookConnected: row.hookConnected,
        outputRevision: 0,
      });
      if (row.sessionId) this.sessionIndex.set(row.sessionId, row.surfaceId);
    }
  }

  // ---------------------------------------------------------------- 输入 A：cmux

  /** 用最新拓扑刷新 Agent 列表：新增、更新元信息、消失的标记 CLOSED。 */
  syncTree(tree: CmuxTree): AgentState[] {
    const now = this.now();
    const changed: AgentState[] = [];

    this.pidIndex = new Map(
      Object.entries(tree.pidIndex ?? {}).map(([pid, surfaceId]) => [Number(pid), surfaceId]),
    );

    const seen = new Set<string>();
    for (const surface of agentSurfaces(tree)) {
      seen.add(surface.id);
      const workspace = tree.workspaces.find((w) => w.id === surface.workspaceId);
      const next = this.upsertFromSurface(surface, workspace?.title, now);
      if (next) changed.push(next);
    }

    // 拓扑里已经不存在（或 Agent 进程已退出）→ CLOSED
    for (const [surfaceId, state] of this.agents) {
      if (seen.has(surfaceId)) continue;
      if (state.status !== "CLOSED") {
        const updated = this.transition(state, "CLOSED", now, { activity: undefined });
        changed.push(updated);
        this.closedAt.set(surfaceId, now);
      }
    }

    this.evictClosed(now);
    return changed;
  }

  private upsertFromSurface(surface: CmuxSurface, workspaceTitle: string | undefined, now: number): AgentState | null {
    if (!surface.agent) return null;
    const existing = this.agents.get(surface.id);

    if (!existing) {
      const created: AgentState = {
        id: surface.id,
        agent: surface.agent,
        workspaceId: surface.workspaceId,
        workspaceRef: surface.workspaceRef,
        workspaceTitle,
        paneId: surface.paneId,
        paneRef: surface.paneRef,
        surfaceId: surface.id,
        surfaceRef: surface.ref,
        surfaceTitle: surface.title,
        pid: surface.agentPid ?? undefined,
        status: "IDLE",
        lastActivityAt: now,
        statusChangedAt: now,
        hookConnected: false,
        outputRevision: 0,
      };
      this.agents.set(surface.id, created);
      this.persist(created, now);
      this.onChange?.(created, undefined);
      return created;
    }

    const wasClosed = existing.status === "CLOSED";
    const updated: AgentState = {
      ...existing,
      agent: surface.agent,
      workspaceId: surface.workspaceId,
      workspaceRef: surface.workspaceRef,
      workspaceTitle: workspaceTitle ?? existing.workspaceTitle,
      paneId: surface.paneId,
      paneRef: surface.paneRef,
      surfaceRef: surface.ref,
      surfaceTitle: surface.title,
      pid: surface.agentPid ?? existing.pid,
    };
    this.agents.set(surface.id, updated);
    this.closedAt.delete(surface.id);

    if (wasClosed) {
      // 进程回来了（例如 cmux 恢复会话）。
      return this.transition(updated, "IDLE", now, {});
    }

    const metaChanged =
      existing.surfaceTitle !== updated.surfaceTitle ||
      existing.workspaceTitle !== updated.workspaceTitle ||
      existing.surfaceRef !== updated.surfaceRef ||
      existing.pid !== updated.pid;
    if (metaChanged) {
      this.persist(updated, now);
      return updated;
    }
    return null;
  }

  // ---------------------------------------------------------------- 输入 B：Hook

  /** 应用一个统一 Agent 事件；返回受影响的状态。 */
  applyEvent(event: AgentEvent): AgentState | null {
    const now = this.now();
    const surfaceId = this.resolveSurface(event);
    if (!surfaceId) return null;

    let state = this.agents.get(surfaceId);
    if (!state) {
      // Hook 比 tree 轮询更快到，先建一个占位状态，等 syncTree 补齐元信息。
      state = {
        id: surfaceId,
        agent: event.agent,
        workspaceId: event.workspaceId ?? "",
        surfaceId,
        status: "IDLE",
        lastActivityAt: now,
        statusChangedAt: now,
        hookConnected: true,
        outputRevision: 0,
      };
      this.agents.set(surfaceId, state);
    }

    if (event.sessionId) {
      this.sessionIndex.set(event.sessionId, surfaceId);
      state = { ...state, sessionId: event.sessionId };
      this.agents.set(surfaceId, state);
    }
    if (event.pid) {
      state = { ...state, pid: state.pid ?? event.pid };
      this.agents.set(surfaceId, state);
    }
    state = { ...state, hookConnected: true };
    this.agents.set(surfaceId, state);

    switch (event.event) {
      case "session_started":
        return this.transition(state, "IDLE", now, { activity: undefined, resetTurn: true });

      case "turn_started":
        return this.transition(state, "WORKING", now, {
          activity: event.activity ?? "Thinking",
          startTurn: true,
        });

      case "activity":
        // 正在等用户的时候收到工具活动，说明用户已经批过了 → 回到 WORKING。
        return this.transition(state, "WORKING", now, { activity: event.activity });

      case "needs_approval":
        return this.transition(state, "NEEDS_APPROVAL", now, {
          activity: event.activity ?? "Waiting for approval",
        });

      case "needs_input":
        return this.transition(state, "NEEDS_INPUT", now, {
          activity: event.activity ?? "Waiting for input",
        });

      case "turn_finished": {
        // 用户正在看这个会话时，回合结束直接算已读。
        const status: AgentStatus = this.viewing.has(surfaceId) ? "IDLE" : "RESPONDED_UNREAD";
        return this.transition(state, status, now, { activity: undefined, resetTurn: true, markViewed: status === "IDLE" });
      }

      case "session_ended":
        return this.transition(state, "CLOSED", now, { activity: undefined, resetTurn: true });

      case "failure":
        return this.transition(state, "ERROR", now, {
          activity: event.activity ?? "Agent failure",
          resetTurn: true,
        });

      default:
        return null;
    }
  }

  /**
   * Hook → surface 的关联顺序：
   * 1. hook 自带 surfaceId（cmux 终端里的 CMUX_SURFACE_ID，最可靠）
   * 2. pid → cmux 进程树反查
   * 3. sessionId → 之前记录过的绑定
   * 4. workspaceId + agent 类型唯一命中
   */
  private resolveSurface(event: AgentEvent): string | undefined {
    if (event.surfaceId) {
      // CMUX_SURFACE_ID 是 UUID；如果拿到的是短 ref，尝试映射到 UUID。
      const direct = this.agents.get(event.surfaceId);
      if (direct) return direct.surfaceId;
      const byRef = [...this.agents.values()].find((a) => a.surfaceRef === event.surfaceId);
      return byRef?.surfaceId ?? event.surfaceId;
    }
    if (event.pid) {
      const bySelf = this.pidIndex.get(event.pid);
      if (bySelf) return bySelf;
      const byAgentPid = [...this.agents.values()].find((a) => a.pid === event.pid);
      if (byAgentPid) return byAgentPid.surfaceId;
    }
    if (event.sessionId) {
      const bound = this.sessionIndex.get(event.sessionId);
      if (bound) return bound;
    }
    if (event.workspaceId) {
      const candidates = [...this.agents.values()].filter(
        (a) => a.workspaceId === event.workspaceId && a.agent === event.agent && a.status !== "CLOSED",
      );
      if (candidates.length === 1) return candidates[0]?.surfaceId;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- 输入 C：输出变化

  /** 输出变化：既用于刷新 lastActivityAt，也用于无 hook Agent 的状态推断。 */
  applyOutput(surfaceId: string, changed: boolean, revision: number): AgentState | null {
    const state = this.agents.get(surfaceId);
    if (!state) return null;
    const now = this.now();

    if (changed) this.outputChangedAt.set(surfaceId, now);
    const lastChange = this.outputChangedAt.get(surfaceId);

    if (state.hookConnected) {
      // 有 hook 时状态以 hook 为准，输出变化只用来续命（避免误判 stale）。
      if (!changed) {
        if (state.outputRevision === revision) return null;
        const updated = { ...state, outputRevision: revision };
        this.agents.set(surfaceId, updated);
        return null;
      }
      const updated: AgentState = {
        ...state,
        outputRevision: revision,
        lastActivityAt: now,
      };
      this.agents.set(surfaceId, updated);
      if (updated.status === "POSSIBLY_STALE") {
        return this.transition(updated, "WORKING", now, {});
      }
      return null;
    }

    // 第一次读到这个 surface 只是「初始加载」，不是活动：
    // 否则刚发现的 idle Agent 会被误判成刚刚回复过。
    if (state.outputRevision === 0) {
      this.agents.set(surfaceId, { ...state, outputRevision: revision });
      this.outputChangedAt.set(surfaceId, now);
      return null;
    }

    const inferred = inferStatusFromOutput(state.status, changed, lastChange, now, this.staleConfig);
    const withRevision: AgentState = {
      ...state,
      outputRevision: revision,
      lastActivityAt: changed ? now : state.lastActivityAt,
    };
    this.agents.set(surfaceId, withRevision);

    if (inferred !== state.status) {
      const finalStatus: AgentStatus =
        inferred === "RESPONDED_UNREAD" && this.viewing.has(surfaceId) ? "IDLE" : inferred;
      // 推断出「回合结束」时要把上一轮的活动文案一起收掉，否则 Idle 上还挂着 Thinking。
      const turnEnded = finalStatus === "RESPONDED_UNREAD" || finalStatus === "IDLE";
      return this.transition(withRevision, finalStatus, now, {
        resetTurn: turnEnded,
        markViewed: finalStatus === "IDLE" && this.viewing.has(surfaceId),
      });
    }
    return null;
  }

  // ---------------------------------------------------------------- 输入 D：用户

  /** 用户打开会话：RESPONDED_UNREAD → IDLE。 */
  markViewed(surfaceId: string): AgentState | null {
    const state = this.agents.get(surfaceId);
    if (!state) return null;
    const now = this.now();
    if (state.status === "RESPONDED_UNREAD") {
      return this.transition(state, "IDLE", now, { markViewed: true });
    }
    const updated = { ...state, lastViewedAt: now };
    this.agents.set(surfaceId, updated);
    this.persist(updated, now);
    return updated;
  }

  /** WebSocket 订阅：标记用户正在实时查看某个 surface。 */
  setViewing(surfaceId: string | null, viewing: boolean): void {
    if (!surfaceId) return;
    if (viewing) this.viewing.add(surfaceId);
    else this.viewing.delete(surfaceId);
  }

  isViewing(surfaceId: string): boolean {
    return this.viewing.has(surfaceId);
  }

  /** 用户从 Web 发送了 prompt：乐观地进入 WORKING。 */
  noteUserInput(surfaceId: string, submitted: boolean): AgentState | null {
    const state = this.agents.get(surfaceId);
    if (!state) return null;
    const now = this.now();
    if (!submitted) {
      const updated = { ...state, lastActivityAt: now, lastViewedAt: now };
      this.agents.set(surfaceId, updated);
      return updated;
    }
    return this.transition(state, "WORKING", now, {
      activity: "Thinking",
      startTurn: true,
      markViewed: true,
    });
  }

  // ---------------------------------------------------------------- 时间

  /** 周期性调用：处理 POSSIBLY_STALE。 */
  tick(): AgentState[] {
    const now = this.now();
    const changed: AgentState[] = [];
    for (const state of [...this.agents.values()]) {
      const next = applyStaleRule(state, now, this.staleConfig);
      if (next !== state.status) changed.push(this.transition(state, next, now, {}));
    }
    this.evictClosed(now);
    return changed;
  }

  private evictClosed(now: number): void {
    for (const [surfaceId, at] of [...this.closedAt]) {
      if (now - at > this.closedRetentionMs) {
        this.agents.delete(surfaceId);
        this.closedAt.delete(surfaceId);
        this.outputChangedAt.delete(surfaceId);
        this.viewing.delete(surfaceId);
        for (const [sessionId, id] of this.sessionIndex) {
          if (id === surfaceId) this.sessionIndex.delete(sessionId);
        }
        try {
          this.store?.deleteAgent(surfaceId);
        } catch {
          // 存储不可用不影响主链路
        }
      }
    }
  }

  // ---------------------------------------------------------------- 输出

  private transition(
    state: AgentState,
    status: AgentStatus,
    now: number,
    options: { activity?: string; startTurn?: boolean; resetTurn?: boolean; markViewed?: boolean },
  ): AgentState {
    const previous = state.status;
    // 活动文案：给了就用；没给但这一步结束了回合就清空；否则保持原样。
    const nextActivity = options.activity ?? (options.resetTurn ? undefined : state.currentActivity);
    const updated: AgentState = {
      ...state,
      status,
      currentActivity: nextActivity,
      lastActivityAt: now,
      statusChangedAt: status !== previous ? now : state.statusChangedAt,
      turnStartedAt: options.startTurn
        ? now
        : options.resetTurn
          ? undefined
          : state.turnStartedAt,
      lastViewedAt: options.markViewed ? now : state.lastViewedAt,
    };
    this.agents.set(state.surfaceId, updated);
    this.persist(updated, now);
    if (status !== previous) {
      if (status === "CLOSED") this.closedAt.set(state.surfaceId, now);
      this.onChange?.(updated, previous);
    }
    return updated;
  }

  private persist(state: AgentState, now: number): void {
    try {
      this.store?.save(state, now);
    } catch {
      // 存储不可用不能影响主链路。
    }
  }

  get(surfaceId: string): AgentState | undefined {
    return this.agents.get(surfaceId);
  }

  list(): AgentState[] {
    return [...this.agents.values()];
  }

  /** 首页 Attention Inbox。 */
  inbox(): Inbox {
    return buildInbox(this.list(), this.now());
  }
}

export { compareByAttention } from "@car/protocol";
