import { describe, expect, it, vi } from "vitest";
import { buildInbox, type AgentState, type SurfaceGrid } from "@car/protocol";
import { patchAgent } from "../src/stores/selectors.ts";
import { SurfaceCache } from "../src/stores/surface-cache.ts";

const agent: AgentState = { id: "s", surfaceId: "s", workspaceId: "w", agent: "codex", status: "NEEDS_INPUT", lastActivityAt: 1, statusChangedAt: 1, hookConnected: true, outputRevision: 0 };

describe("局部 Agent 更新", () => {
  it("跨分组时更新统计、移除空组；未知 Agent 可加入列表", () => {
    const initial = buildInbox([agent], 1);
    const updated = patchAgent(initial, { ...agent, status: "IDLE" });
    expect(updated.summary).toMatchObject({ needsYou: 0, idle: 1, total: 1 });
    expect(updated.groups.map(g => g.group)).toEqual(["IDLE"]);
    expect(patchAgent(updated, { ...agent, id: "other", surfaceId: "other", status: "ERROR" }).summary).toMatchObject({ error: 1, total: 2 });
  });
});

describe("按 surface 订阅的网格缓存", () => {
  it("只通知目标订阅，关闭、外部消失及登出会释放画面", () => {
    const cache = new SurfaceCache();
    const a = vi.fn(); const b = vi.fn();
    const unsubscribe = cache.subscribe("a", a);
    cache.subscribe("b", b);
    const grid = { revision: 1 } as SurfaceGrid;
    cache.set("a", grid); cache.set("a", grid);
    expect(a).toHaveBeenCalledOnce(); expect(b).not.toHaveBeenCalled();
    cache.set("b", grid);
    cache.retain(new Set(["a"]));
    expect(cache.get("b")).toBeUndefined();
    expect(b).toHaveBeenCalledTimes(2);
    unsubscribe(); cache.clear();
    expect(cache.get("a")).toBeUndefined(); expect(a).toHaveBeenCalledOnce();
  });
});
