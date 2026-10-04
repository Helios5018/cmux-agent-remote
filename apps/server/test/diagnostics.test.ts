import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsResponseSchema } from "@car/protocol";
import { RuntimeDiagnostics } from "../src/diagnostics.ts";
import { Poller } from "../src/realtime/poller.ts";
import { createHarness, TEST_HOOK_TOKEN } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

describe("运行诊断", () => {
  it("匿名只可读存活探针，诊断需登录且禁止缓存", async () => {
    const h = await createHarness();
    try {
      expect((await h.request("/api/diagnostics")).status).toBe(401);
      const health = await h.request("/api/health");
      expect(Object.keys(await health.json()).sort()).toEqual(["demo", "now", "ok", "version"]);
      expect(health.headers.get("cache-control")).toBe("no-store");
      const response = await h.request("/api/diagnostics", { cookie: await h.loginCookie() });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = DiagnosticsResponseSchema.parse(await response.json());
      expect(body.storage).toMatchObject({ persistent: false });
      expect(["bun", "node"]).toContain(body.storage.driver);
      expect(body.topology).toBeNull();
      expect(body.hooks.lastReceivedAt).toBeNull();
    } finally { h.store.close(); }
  });

  it("拓扑首次失败、成功、连续失败和恢复分别记录，失败不覆盖成功时间", async () => {
    const h = await createHarness();
    const poller = new Poller({ client: h.client, engine: h.engine, hub: h.ctx.hub,
      now: h.ctx.now, diagnostics: h.ctx.diagnostics });
    h.ctx.poller = poller;
    try {
      expect(poller.topologyDiagnostics().status).toBe("unknown");
      const tree = vi.spyOn(h.client, "getTree");
      tree.mockRejectedValueOnce(Object.assign(new Error("secret command /Users/private"), { code: "EACCES" }));
      await poller.refreshTree();
      expect(poller.topologyDiagnostics()).toMatchObject({ status: "degraded", lastSuccessAt: null, consecutiveFailures: 1 });
      h.clock.advance(1000);
      await poller.refreshTree();
      const success = h.clock.value;
      expect(poller.topologyDiagnostics()).toMatchObject({ status: "ok", lastSuccessAt: success, consecutiveFailures: 0 });
      tree.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
      h.clock.advance(1000);
      await poller.refreshTree();
      await poller.refreshTree();
      expect(poller.topologyDiagnostics()).toMatchObject({ lastAttemptAt: h.clock.value, lastSuccessAt: success, consecutiveFailures: 2 });
      await poller.refreshTree();
      expect(poller.topologyDiagnostics()).toMatchObject({ status: "ok", consecutiveFailures: 0 });
      h.clock.advance(10_001);
      expect(poller.topologyDiagnostics().status).toBe("stale");
      const body = DiagnosticsResponseSchema.parse(await (await h.request("/api/diagnostics", { cookie: await h.loginCookie() })).json());
      expect(body.topology?.status).toBe("stale");
      expect(body.recentErrors).toHaveLength(3);
      expect(body.recentErrors[2]).toMatchObject({ source: "topology", code: "EACCES" });
      expect(JSON.stringify(body)).not.toContain("secret command");
    } finally { h.store.close(); }
  });

  it("Hook 拒绝和非法 payload 不算有效接收，未关联事件不覆盖最后应用时间", async () => {
    const h = await createHarness();
    const post = (body: unknown, token = TEST_HOOK_TOKEN) => h.request("/api/hooks/codex", {
      method: "POST", ip: "127.0.0.1", headers: { "x-car-token": token }, body: JSON.stringify(body),
    });
    try {
      await post({ event: "Stop" }, "bad-token");
      await post({ event: "" });
      expect(h.ctx.diagnostics.snapshot().hooks.lastReceivedAt).toBeNull();
      await post({ event: "Stop", context: { surfaceId: "sf-11" }, payload: { secret: "do-not-store" } });
      const appliedAt = h.clock.value;
      expect(h.ctx.diagnostics.snapshot().hooks).toMatchObject({ lastAppliedAt: appliedAt, lastOutcome: "applied", lastAgent: "codex" });
      h.clock.advance(1000);
      await post({ event: "Stop" });
      expect(h.ctx.diagnostics.snapshot().hooks).toMatchObject({ lastReceivedAt: h.clock.value, lastAppliedAt: appliedAt, lastOutcome: "unresolved" });
      await post({ event: "UnknownEvent" });
      expect(h.ctx.diagnostics.snapshot().hooks.lastOutcome).toBe("ignored");
      expect(JSON.stringify(h.ctx.diagnostics.snapshot())).not.toContain("do-not-store");
    } finally { h.store.close(); }
  });

  it("错误缓存最多 20 条，只保留白名单代码和固定摘要，不带原文或堆栈", () => {
    let now = 1000;
    const diagnostics = new RuntimeDiagnostics(() => now++);
    for (let i = 0; i < 25; i++) diagnostics.recordError("api",
      Object.assign(new Error("PIN=1234 token=secret /Users/link/private"), { code: "secret-code" }));
    const snapshot = diagnostics.snapshot();
    expect(snapshot.recentErrors).toHaveLength(20);
    expect(snapshot.recentErrors[0]?.at).toBeGreaterThan(snapshot.recentErrors[19]!.at);
    expect(snapshot.recentErrors[0]).toMatchObject({ code: "UNKNOWN", message: "API 未处理异常" });
    expect(JSON.stringify(snapshot)).not.toMatch(/1234|secret|\/Users|stack/);
  });

  it("全局 API 异常进入诊断，但响应仍是通用错误", async () => {
    const h = await createHarness();
    try {
      const cookie = await h.loginCookie();
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(h.store, "recentAudit").mockImplementation(() => { throw new Error("private failure"); });
      const response = await h.request("/api/audit", { cookie });
      expect(response.status).toBe(500);
      expect(h.ctx.diagnostics.snapshot().recentErrors[0]?.source).toBe("api");
      expect(await response.text()).not.toContain("private failure");
    } finally { h.store.close(); }
  });
});
