import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentStatus, CmuxTree } from "@car/protocol";
import { parseTopJson, parseTree } from "../src/cmux/discovery.ts";
import { StateEngine } from "../src/state/engine.ts";
import { StateStore } from "../src/state/store.ts";
import { RAW_TOP, RAW_TREE } from "./fixtures.ts";

const T0 = 1_700_000_000_000;

class Clock {
  constructor(public value = T0) {}
  now = () => this.value;
  advance(ms: number) {
    this.value += ms;
    return this.value;
  }
}

function buildTree(now: number): CmuxTree {
  return parseTree(RAW_TREE, parseTopJson(RAW_TOP), now);
}

function hook(partial: Partial<AgentEvent> & { event: AgentEvent["event"] }, now: number): AgentEvent {
  return {
    version: 1,
    agent: "codex",
    timestamp: now,
    surfaceId: "SURF-11",
    ...partial,
  } as AgentEvent;
}

describe("State Engine —— cmux 拓扑同步", () => {
  let clock: Clock;
  let engine: StateEngine;

  beforeEach(() => {
    clock = new Clock();
    engine = new StateEngine({ now: clock.now });
    engine.syncTree(buildTree(clock.value));
  });

  it("只把跑着 Agent 的 surface 纳入管理", () => {
    expect(engine.list().map((a) => a.surfaceId).sort()).toEqual(["SURF-10", "SURF-11", "SURF-20"]);
    expect(engine.get("SURF-12")).toBeUndefined();
  });

  it("带上 workspace / pane / surface 的展示信息", () => {
    const agent = engine.get("SURF-11");
    expect(agent).toMatchObject({
      agent: "codex",
      workspaceId: "WS-WORLD",
      workspaceTitle: "世界模型 Demo",
      paneRef: "pane:7",
      surfaceRef: "surface:11",
      status: "IDLE",
      pid: 5201,
    });
  });

  it("surface 消失 → CLOSED；回来 → IDLE", () => {
    const shrunk = buildTree(clock.value);
    shrunk.workspaces[0]!.panes[0]!.surfaces = shrunk.workspaces[0]!.panes[0]!.surfaces.filter(
      (s) => s.id !== "SURF-11",
    );
    engine.syncTree(shrunk);
    expect(engine.get("SURF-11")?.status).toBe("CLOSED");

    clock.advance(1000);
    engine.syncTree(buildTree(clock.value));
    expect(engine.get("SURF-11")?.status).toBe("IDLE");
  });

  it("CLOSED 超过保留期后从列表移除", () => {
    const shrunk = buildTree(clock.value);
    shrunk.workspaces[0]!.panes[0]!.surfaces = [];
    engine.syncTree(shrunk);
    expect(engine.get("SURF-10")?.status).toBe("CLOSED");

    clock.advance(6 * 60 * 1000);
    engine.tick();
    expect(engine.get("SURF-10")).toBeUndefined();
  });
});

describe("State Engine —— Hook 状态机", () => {
  let clock: Clock;
  let engine: StateEngine;
  const transitions: Array<{ status: AgentStatus; previous?: AgentStatus }> = [];

  beforeEach(() => {
    clock = new Clock();
    transitions.length = 0;
    engine = new StateEngine({
      now: clock.now,
      onChange: (state, previous) => transitions.push({ status: state.status, previous }),
    });
    engine.syncTree(buildTree(clock.value));
  });

  it("完整回合：turn_started → activity → turn_finished（未读）", () => {
    engine.applyEvent(hook({ event: "turn_started" }, clock.value));
    expect(engine.get("SURF-11")?.status).toBe("WORKING");
    expect(engine.get("SURF-11")?.turnStartedAt).toBe(clock.value);

    clock.advance(2000);
    engine.applyEvent(hook({ event: "activity", activity: "Running tests" }, clock.value));
    expect(engine.get("SURF-11")).toMatchObject({ status: "WORKING", currentActivity: "Running tests" });

    clock.advance(2000);
    engine.applyEvent(hook({ event: "turn_finished" }, clock.value));
    expect(engine.get("SURF-11")?.status).toBe("RESPONDED_UNREAD");
    expect(engine.get("SURF-11")?.turnStartedAt).toBeUndefined();
  });

  it("用户正在看时，回合结束直接算已读", () => {
    engine.setViewing("SURF-11", true);
    engine.applyEvent(hook({ event: "turn_started" }, clock.value));
    engine.applyEvent(hook({ event: "turn_finished" }, clock.value));
    expect(engine.get("SURF-11")?.status).toBe("IDLE");
    expect(engine.get("SURF-11")?.lastViewedAt).toBe(clock.value);
  });

  it("打开会话后 RESPONDED_UNREAD → IDLE", () => {
    engine.applyEvent(hook({ event: "turn_finished" }, clock.value));
    expect(engine.get("SURF-11")?.status).toBe("RESPONDED_UNREAD");
    engine.markViewed("SURF-11");
    expect(engine.get("SURF-11")?.status).toBe("IDLE");
  });

  it("needs_approval / needs_input / failure", () => {
    engine.applyEvent(hook({ event: "needs_approval", activity: "允许运行 rm？" }, clock.value));
    expect(engine.get("SURF-11")).toMatchObject({ status: "NEEDS_APPROVAL", currentActivity: "允许运行 rm？" });

    engine.applyEvent(hook({ event: "needs_input" }, clock.value));
    expect(engine.get("SURF-11")?.status).toBe("NEEDS_INPUT");

    engine.applyEvent(hook({ event: "failure", activity: "API 502" }, clock.value));
    expect(engine.get("SURF-11")).toMatchObject({ status: "ERROR", currentActivity: "API 502" });
  });

  it("批准后收到工具活动 → 回到 WORKING", () => {
    engine.applyEvent(hook({ event: "needs_approval" }, clock.value));
    engine.applyEvent(hook({ event: "activity", activity: "Bash: rm build" }, clock.value));
    expect(engine.get("SURF-11")?.status).toBe("WORKING");
  });

  it("session_ended → CLOSED", () => {
    engine.applyEvent(hook({ event: "session_ended" }, clock.value));
    expect(engine.get("SURF-11")?.status).toBe("CLOSED");
  });

  it("状态没变化时不重复通知订阅者", () => {
    transitions.length = 0;
    engine.applyEvent(hook({ event: "turn_started" }, clock.value));
    engine.applyEvent(hook({ event: "activity" }, clock.value));
    engine.applyEvent(hook({ event: "activity" }, clock.value));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toEqual({ status: "WORKING", previous: "IDLE" });
  });
});

describe("State Engine —— Hook 与 surface 的关联", () => {
  let clock: Clock;
  let engine: StateEngine;

  beforeEach(() => {
    clock = new Clock();
    engine = new StateEngine({ now: clock.now });
    engine.syncTree(buildTree(clock.value));
  });

  it("优先用 hook 自带的 surfaceId", () => {
    engine.applyEvent(hook({ event: "turn_started", surfaceId: "SURF-10", agent: "codex" }, clock.value));
    expect(engine.get("SURF-10")?.status).toBe("WORKING");
    expect(engine.get("SURF-11")?.status).toBe("IDLE");
  });

  it("hook 给的是短 ref 时也能映射到 UUID", () => {
    engine.applyEvent(hook({ event: "turn_started", surfaceId: "surface:10" }, clock.value));
    expect(engine.get("SURF-10")?.status).toBe("WORKING");
  });

  it("没有 surfaceId 时用 pid 反查（含子进程 pid）", () => {
    engine.applyEvent(hook({ event: "turn_started", surfaceId: undefined, pid: 5102 }, clock.value));
    expect(engine.get("SURF-10")?.status).toBe("WORKING");
  });

  it("再没有就用之前记录的 sessionId", () => {
    engine.applyEvent(hook({ event: "session_started", sessionId: "sess-9" }, clock.value));
    engine.applyEvent(
      hook({ event: "turn_started", surfaceId: undefined, pid: undefined, sessionId: "sess-9" }, clock.value),
    );
    expect(engine.get("SURF-11")?.status).toBe("WORKING");
  });

  it("最后用 workspace + agent 类型唯一命中", () => {
    engine.applyEvent(
      hook(
        { event: "turn_started", agent: "claude", surfaceId: undefined, pid: undefined, workspaceId: "WS-EVAL" },
        clock.value,
      ),
    );
    expect(engine.get("SURF-20")?.status).toBe("WORKING");
  });

  it("workspace 内同类型 Agent 不唯一时宁可不猜", () => {
    const before = engine.list().map((a) => a.status);
    engine.applyEvent(
      hook(
        { event: "turn_started", agent: "codex", surfaceId: undefined, pid: undefined, workspaceId: "WS-WORLD" },
        clock.value,
      ),
    );
    expect(engine.list().map((a) => a.status)).toEqual(before);
  });
});

describe("State Engine —— 时间与输出推断", () => {
  let clock: Clock;
  let engine: StateEngine;

  beforeEach(() => {
    clock = new Clock();
    engine = new StateEngine({ now: clock.now, stale: { staleAfterMs: 600_000, inferredIdleAfterMs: 15_000 } });
    engine.syncTree(buildTree(clock.value));
  });

  it("WORKING 超过 10 分钟没动静 → POSSIBLY_STALE", () => {
    engine.applyEvent(hook({ event: "turn_started" }, clock.value));
    clock.advance(9 * 60 * 1000);
    expect(engine.tick()).toHaveLength(0);

    clock.advance(2 * 60 * 1000);
    const changed = engine.tick();
    expect(changed.map((s) => s.status)).toContain("POSSIBLY_STALE");
  });

  it("stale 之后输出又动了 → 回到 WORKING", () => {
    engine.applyEvent(hook({ event: "turn_started" }, clock.value));
    clock.advance(11 * 60 * 1000);
    engine.tick();
    expect(engine.get("SURF-11")?.status).toBe("POSSIBLY_STALE");

    clock.advance(1000);
    engine.applyOutput("SURF-11", true, 2);
    expect(engine.get("SURF-11")?.status).toBe("WORKING");
  });

  it("第一次读到 surface 只是初始加载，不算活动", () => {
    engine.applyOutput("SURF-10", true, 1);
    expect(engine.get("SURF-10")?.status).toBe("IDLE");

    clock.advance(30_000);
    engine.applyOutput("SURF-10", false, 1);
    // 从头到尾没变过的 Agent 应该一直是 IDLE，而不是「刚回复过」
    expect(engine.get("SURF-10")?.status).toBe("IDLE");
  });

  it("没有 hook 的 Agent：输出在动 → WORKING，静止够久 → RESPONDED_UNREAD", () => {
    engine.applyOutput("SURF-10", true, 1);
    engine.applyOutput("SURF-10", true, 2);
    expect(engine.get("SURF-10")?.status).toBe("WORKING");

    clock.advance(5000);
    engine.applyOutput("SURF-10", false, 2);
    expect(engine.get("SURF-10")?.status).toBe("WORKING");

    clock.advance(20_000);
    engine.applyOutput("SURF-10", false, 2);
    expect(engine.get("SURF-10")?.status).toBe("RESPONDED_UNREAD");
  });

  it("有 hook 的 Agent 不被输出推断影响状态", () => {
    engine.applyEvent(hook({ event: "needs_approval" }, clock.value));
    engine.applyOutput("SURF-11", true, 5);
    expect(engine.get("SURF-11")?.status).toBe("NEEDS_APPROVAL");
  });

  it("推断出回合结束时会清掉上一轮的活动文案", () => {
    engine.noteUserInput("SURF-10", true);
    expect(engine.get("SURF-10")).toMatchObject({ status: "WORKING", currentActivity: "Thinking" });

    engine.applyOutput("SURF-10", true, 1);
    clock.advance(20_000);
    engine.applyOutput("SURF-10", false, 1);

    expect(engine.get("SURF-10")?.status).toBe("RESPONDED_UNREAD");
    expect(engine.get("SURF-10")?.currentActivity).toBeUndefined();
  });

  it("用户从 Web 发消息 → 立刻进入 WORKING", () => {
    engine.applyEvent(hook({ event: "turn_finished" }, clock.value));
    expect(engine.get("SURF-11")?.status).toBe("RESPONDED_UNREAD");

    clock.advance(1000);
    engine.noteUserInput("SURF-11", true);
    expect(engine.get("SURF-11")).toMatchObject({ status: "WORKING", turnStartedAt: clock.value });
  });
});

describe("Attention Inbox 排序", () => {
  it("按 ERROR → NEEDS_APPROVAL → NEEDS_INPUT → RESPONDED → STALE → WORKING → IDLE 排", () => {
    const clock = new Clock();
    const engine = new StateEngine({ now: clock.now });
    engine.syncTree(buildTree(clock.value));

    engine.applyEvent(hook({ event: "needs_approval", surfaceId: "SURF-10" }, clock.value));
    engine.applyEvent(hook({ event: "turn_finished", surfaceId: "SURF-11" }, clock.value));
    engine.applyEvent(hook({ event: "failure", surfaceId: "SURF-20", agent: "claude" }, clock.value));

    const inbox = engine.inbox();
    const flat = inbox.groups.flatMap((group) => group.agents.map((agent) => agent.status));
    expect(flat).toEqual(["ERROR", "NEEDS_APPROVAL", "RESPONDED_UNREAD"]);
    expect(inbox.groups.map((g) => g.group)).toEqual(["NEEDS_YOU"]);
    expect(inbox.summary).toMatchObject({ needsYou: 2, error: 1, working: 0, idle: 0, total: 3 });
  });

  it("汇总口径：2 Need You · 3 Working · 1 Error · 4 Idle", () => {
    const clock = new Clock();
    const engine = new StateEngine({ now: clock.now });
    engine.syncTree(buildTree(clock.value));
    engine.applyEvent(hook({ event: "turn_started", surfaceId: "SURF-10" }, clock.value));

    const summary = engine.inbox().summary;
    expect(summary.working).toBe(1);
    expect(summary.idle).toBe(2);
    expect(summary.total).toBe(3);
  });
});

describe("状态持久化", () => {
  it("重启后恢复未读状态，但不盲信 WORKING", async () => {
    const clock = new Clock();
    const store = await StateStore.open(":memory:");

    const engine = new StateEngine({ now: clock.now, store });
    engine.syncTree(buildTree(clock.value));
    engine.applyEvent(hook({ event: "turn_finished" }, clock.value));
    engine.applyEvent(hook({ event: "turn_started", surfaceId: "SURF-10" }, clock.value));

    const revived = new StateEngine({ now: clock.now, store });
    expect(revived.get("SURF-11")?.status).toBe("RESPONDED_UNREAD");
    // 重启后进程是否还活着未知，先降级成 POSSIBLY_STALE，等第一次 syncTree 纠正
    expect(revived.get("SURF-10")?.status).toBe("POSSIBLY_STALE");
    store.close();
  });

  it("存储不可用时主链路照常工作", () => {
    const clock = new Clock();
    const engine = new StateEngine({ now: clock.now, store: StateStore.inMemory() });
    engine.syncTree(buildTree(clock.value));
    expect(() => engine.applyEvent(hook({ event: "turn_started" }, clock.value))).not.toThrow();
    expect(engine.get("SURF-11")?.status).toBe("WORKING");
  });
});

describe("退出的 Agent 会被彻底清理", () => {
  it("过了保留期后从内存和 SQLite 里一起删除", async () => {
    const clock = new Clock();
    const store = await StateStore.open(":memory:");
    const engine = new StateEngine({ now: clock.now, store });
    engine.syncTree(buildTree(clock.value));
    expect(store.loadAll()).toHaveLength(3);

    const empty = buildTree(clock.value);
    empty.workspaces = [];
    engine.syncTree(empty);
    clock.advance(6 * 60 * 1000);
    engine.tick();

    expect(engine.list()).toHaveLength(0);
    expect(store.loadAll()).toHaveLength(0);
    store.close();
  });

  it("重启时不恢复上次已经退出的 Agent", async () => {
    const clock = new Clock();
    const store = await StateStore.open(":memory:");
    const first = new StateEngine({ now: clock.now, store });
    first.syncTree(buildTree(clock.value));
    const empty = buildTree(clock.value);
    empty.workspaces = [];
    first.syncTree(empty);
    expect(store.loadAll().every((row) => row.status === "CLOSED")).toBe(true);

    const revived = new StateEngine({ now: clock.now, store });
    expect(revived.list()).toHaveLength(0);
    expect(store.loadAll()).toHaveLength(0);
    store.close();
  });
});
