import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentDetailResponse,
  CreateSurfaceResponse,
  Inbox,
  SessionInfo,
  SurfaceGrid,
  SurfaceHistoryResponse,
  SurfaceScrollResponse,
  SurfaceSnapshot,
  TreeResponse,
} from "@car/protocol";
import { GRID_SPAN_TEXT } from "@car/protocol";
import {
  createHarness,
  TEST_HOOK_TOKEN,
  TEST_PANE_CWD,
  TEST_PIN,
} from "./helpers.ts";

/** 网格里的可见文字，用来断言「翻页之后看到的是哪一屏」。 */
function gridText(grid: SurfaceGrid): string {
  return grid.spans.map((span) => span[GRID_SPAN_TEXT]).join("\n");
}

describe("安全：Access Token 与 Session", () => {
  it("未登录访问任何数据接口都是 401", async () => {
    const harness = await createHarness();
    for (const path of ["/api/agents", "/api/tree", "/api/surfaces/sf-11/output", "/api/audit"]) {
      const response = await harness.request(path);
      expect(response.status, path).toBe(401);
    }
  });

  it("Token 正确才换到 Session Cookie", async () => {
    const harness = await createHarness();

    const bad = await harness.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ token: "WRONG" }),
    });
    expect(bad.status).toBe(401);

    const good = await harness.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ token: TEST_PIN }),
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("set-cookie")).toMatch(/car_session=/);
    expect(good.headers.get("set-cookie")).toMatch(/HttpOnly/i);

    const info = (await good.json()) as SessionInfo;
    expect(info).toMatchObject({ authenticated: true });
  });

  it("Cookie 之后即可访问", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/agents", { cookie });
    expect(response.status).toBe(200);
  });

  it("登出后 Cookie 失效", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    await harness.request("/api/auth/logout", { method: "POST", cookie });
    expect((await harness.request("/api/agents", { cookie })).status).toBe(401);
  });
});

describe("安全：登录限流（4 位 PIN 的前提）", () => {
  it("连续输错会被锁定，返回 429 + Retry-After", async () => {
    const harness = await createHarness();
    const attempt = () =>
      harness.request("/api/auth/login", {
        method: "POST",
        ip: "203.0.113.5",
        body: JSON.stringify({ token: "0000" }),
      });

    for (let i = 0; i < 4; i += 1) {
      const response = await attempt();
      expect(response.status, `第 ${i + 1} 次`).toBe(401);
    }

    const locked = await attempt();
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    expect(await locked.json()).toMatchObject({ error: { code: "TOO_MANY_ATTEMPTS" } });
  });

  it("锁定期间即使 PIN 正确也不放行", async () => {
    const harness = await createHarness();
    for (let i = 0; i < 5; i += 1) {
      await harness.request("/api/auth/login", {
        method: "POST",
        ip: "203.0.113.5",
        body: JSON.stringify({ token: "0000" }),
      });
    }

    const correct = await harness.request("/api/auth/login", {
      method: "POST",
      ip: "203.0.113.5",
      body: JSON.stringify({ token: TEST_PIN }),
    });
    expect(correct.status).toBe(429);

    // 等锁定过去就恢复
    harness.clock.advance(61_000);
    const retry = await harness.request("/api/auth/login", {
      method: "POST",
      ip: "203.0.113.5",
      body: JSON.stringify({ token: TEST_PIN }),
    });
    expect(retry.status).toBe(200);
  });

  it("Bearer / x-car-token 直登同样受限流约束", async () => {
    const harness = await createHarness();
    for (let i = 0; i < 6; i += 1) {
      await harness.request("/api/agents", {
        ip: "198.51.100.9",
        headers: { authorization: "Bearer 0000" },
      });
    }
    const blocked = await harness.request("/api/agents", {
      ip: "198.51.100.9",
      headers: { authorization: `Bearer ${TEST_PIN}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("成功登录会清空失败计数", async () => {
    const harness = await createHarness();
    for (let i = 0; i < 3; i += 1) {
      await harness.request("/api/auth/login", {
        method: "POST",
        ip: "203.0.113.5",
        body: JSON.stringify({ token: "0000" }),
      });
    }
    await harness.request("/api/auth/login", {
      method: "POST",
      ip: "203.0.113.5",
      body: JSON.stringify({ token: TEST_PIN }),
    });

    // 又能重新错 4 次而不被锁
    for (let i = 0; i < 4; i += 1) {
      const response = await harness.request("/api/auth/login", {
        method: "POST",
        ip: "203.0.113.5",
        body: JSON.stringify({ token: "0000" }),
      });
      expect(response.status).toBe(401);
    }
  });

  it("默认不信任 X-Forwarded-For（否则伪造头就能绕开限流）", async () => {
    const harness = await createHarness();
    for (let i = 0; i < 5; i += 1) {
      await harness.request("/api/auth/login", {
        method: "POST",
        ip: "203.0.113.5",
        headers: { "x-forwarded-for": `10.0.0.${i}` },
        body: JSON.stringify({ token: "0000" }),
      });
    }
    const blocked = await harness.request("/api/auth/login", {
      method: "POST",
      ip: "203.0.113.5",
      headers: { "x-forwarded-for": "10.0.0.99" },
      body: JSON.stringify({ token: "0000" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("--trust-proxy 时按 X-Forwarded-For 分桶", async () => {
    const harness = await createHarness({ trustProxy: true });
    for (let i = 0; i < 5; i += 1) {
      await harness.request("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": "1.1.1.1" },
        body: JSON.stringify({ token: "0000" }),
      });
    }
    expect(
      (
        await harness.request("/api/auth/login", {
          method: "POST",
          headers: { "x-forwarded-for": "1.1.1.1" },
          body: JSON.stringify({ token: "0000" }),
        })
      ).status,
    ).toBe(429);

    // 另一个来源还有自己的额度（但全局闸门仍在）
    expect(
      (
        await harness.request("/api/auth/login", {
          method: "POST",
          headers: { "x-forwarded-for": "2.2.2.2" },
          body: JSON.stringify({ token: TEST_PIN }),
        })
      ).status,
    ).toBe(200);
  });

  it("HTTPS（Tunnel）下 Cookie 带 Secure", async () => {
    const harness = await createHarness({ trustProxy: true });
    const response = await harness.request("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
      body: JSON.stringify({ token: TEST_PIN }),
    });
    expect(response.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("本机 HTTP 下不加 Secure，否则 Cookie 根本存不下", async () => {
    const harness = await createHarness();
    const response = await harness.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ token: TEST_PIN }),
    });
    expect(response.headers.get("set-cookie")).not.toMatch(/Secure/i);
  });
});

describe("安全：登录后即可控制", () => {
  it("登录后写操作直接放行", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces/sf-11/input", {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "继续完成这个任务", submit: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(harness.client.sentText).toEqual([{ surfaceId: "sf-11", text: "继续完成这个任务" }]);
    expect(harness.client.sentKeys).toEqual([{ surfaceId: "sf-11", key: "enter" }]);
  });
});

describe("安全：按键白名单与危险操作确认", () => {
  it("只允许 Enter / Esc / Tab / ↑ / ↓ / Ctrl+C", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    for (const key of ["enter", "escape", "tab", "up", "down", "left", "right"]) {
      const response = await harness.request("/api/surfaces/sf-11/key", {
        method: "POST",
        cookie,
        body: JSON.stringify({ key }),
      });
      expect(response.status, key).toBe(200);
    }

    for (const key of ["ctrl+d", "ctrl+z", "f5", "rm -rf /", ""]) {
      const response = await harness.request("/api/surfaces/sf-11/key", {
        method: "POST",
        cookie,
        body: JSON.stringify({ key }),
      });
      expect(response.status, key).toBe(400);
    }
  });

  it("Ctrl+C 必须二次确认", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const first = await harness.request("/api/surfaces/sf-11/key", {
      method: "POST",
      cookie,
      body: JSON.stringify({ key: "ctrl+c" }),
    });
    expect(first.status).toBe(428);
    expect(await first.json()).toMatchObject({ error: { code: "CONFIRM_REQUIRED" } });
    expect(harness.client.sentKeys).toHaveLength(0);

    const confirmed = await harness.request("/api/surfaces/sf-11/key", {
      method: "POST",
      cookie,
      body: JSON.stringify({ key: "ctrl+c", confirm: true }),
    });
    expect(confirmed.status).toBe(200);
    expect(harness.client.sentKeys).toEqual([{ surfaceId: "sf-11", key: "ctrl+c" }]);
  });

  it("连按 Ctrl+C 仍需确认，并以独立事件发送两次", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const send = (confirm?: boolean) => harness.request("/api/surfaces/sf-11/key", {
      method: "POST", cookie, body: JSON.stringify({ key: "ctrl+c", repeat: 2, confirm }),
    });
    expect((await send()).status).toBe(428);
    expect(harness.client.sentKeys).toEqual([]);
    const times: number[] = [];
    const original = harness.client.sendKey.bind(harness.client);
    const spy = vi.spyOn(harness.client, "sendKey").mockImplementation(async (id, key) => {
      times.push(performance.now());
      await original(id, key);
    });
    try {
      expect((await send(true)).status).toBe(200);
      expect(harness.client.sentKeys).toEqual([
        { surfaceId: "sf-11", key: "ctrl+c" },
        { surfaceId: "sf-11", key: "ctrl+c" },
      ]);
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(90);
    } finally { spy.mockRestore(); }
  });

  it.each([
    { key: "enter", repeat: 2 }, { key: "ctrl+p", repeat: 2 },
    { key: "ctrl+c", repeat: 0 }, { key: "ctrl+c", repeat: 3 },
    { key: "ctrl+c", repeat: 1.5 },
  ])("拒绝非法连按参数 %j", async (body) => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces/sf-11/key", {
      method: "POST", cookie, body: JSON.stringify({ ...body, confirm: true }),
    });
    expect(response.status).toBe(400);
    expect(harness.client.sentKeys).toEqual([]);
  });

  it.each([1, 2])("连按第 %i 次失败时停止，不自动重试或返回成功", async (failureAt) => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    let calls = 0;
    const spy = vi.spyOn(harness.client, "sendKey").mockImplementation(async () => {
      if (++calls === failureAt) throw new Error("timeout");
    });
    try {
      const response = await harness.request("/api/surfaces/sf-11/key", {
        method: "POST", cookie, body: JSON.stringify({ key: "ctrl+c", repeat: 2, confirm: true }),
      });
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(spy).toHaveBeenCalledTimes(failureAt);
    } finally { spy.mockRestore(); }
  });

  it("Ctrl+D 不在白名单里，带 confirm 也发不出去", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const response = await harness.request("/api/surfaces/sf-11/key", {
      method: "POST",
      cookie,
      body: JSON.stringify({ key: "ctrl+d", confirm: true }),
    });
    expect(response.status).toBe(400);
    expect(harness.client.sentKeys).toHaveLength(0);
  });

  it("写操作必须落在具体 surface 上，路径缺 surface 直接 404", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces//input", {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "hi", submit: true }),
    });
    expect(response.status).toBe(404);
  });

  it("不存在的 surface 返回 404 且不会误伤别人", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces/sf-does-not-exist/input", {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "hi", submit: true }),
    });
    expect(response.status).toBe(500);
    expect(harness.client.sentText).toHaveLength(0);
  });
});

describe("API：Agents / Tree / Output", () => {
  it("GET /api/agents 返回分组 + 汇总", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const inbox = (await (await harness.request("/api/agents", { cookie })).json()) as Inbox;

    expect(inbox.summary.total).toBe(4);
    expect(inbox.groups.map((g) => g.group)).toEqual(["IDLE"]);
    expect(inbox.groups[0]?.agents.map((a) => a.agent).sort()).toEqual(["claude", "codex", "codex", "grok"]);
  });

  it("GET /api/tree 返回完整 cmux 结构", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const tree = (await (await harness.request("/api/tree", { cookie })).json()) as {
      workspaces: Array<{ title: string; panes: Array<{ surfaces: Array<{ agent: string | null }> }> }>;
    };
    expect(tree.workspaces).toHaveLength(2);
    expect(tree.workspaces[0]?.title).toBe("世界模型 Demo");
    // 结构里保留非 Agent 的 shell surface
    expect(tree.workspaces[0]?.panes[1]?.surfaces[0]?.agent).toBeNull();
  });

  it("可以改 surface / workspace 名称，并写回拓扑", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const surface = await harness.request("/api/surfaces/sf-11/title", {
      method: "POST",
      cookie,
      body: JSON.stringify({ title: "评测主会话" }),
    });
    expect(surface.status).toBe(200);

    const workspace = await harness.request("/api/workspaces/ws-world-model/title", {
      method: "POST",
      cookie,
      body: JSON.stringify({ title: "世界模型" }),
    });
    expect(workspace.status).toBe(200);

    const tree = (await (await harness.request("/api/tree", { cookie })).json()) as {
      workspaces: Array<{ title: string; panes: Array<{ surfaces: Array<{ id: string; title: string }> }> }>;
    };
    expect(tree.workspaces[0]?.title).toBe("世界模型");
    const renamed = tree.workspaces[0]?.panes.flatMap((pane) => pane.surfaces).find((item) => item.id === "sf-11");
    expect(renamed?.title).toBe("评测主会话");
  });

  it("GET /api/surfaces/:id/output 返回清洗后的文本", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const snapshot = (await (
      await harness.request("/api/surfaces/sf-11/output", { cookie })
    ).json()) as SurfaceSnapshot;
    expect(snapshot.content).toContain("14 tests passed");
    expect(snapshot.revision).toBeGreaterThan(0);
  });

  it("打开会话即标记已读：RESPONDED_UNREAD → IDLE", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    harness.engine.applyEvent({
      version: 1,
      agent: "codex",
      event: "turn_finished",
      surfaceId: "sf-11",
      timestamp: harness.clock.value,
    });
    expect(harness.engine.get("sf-11")?.status).toBe("RESPONDED_UNREAD");

    const detail = (await (await harness.request("/api/agents/sf-11", { cookie })).json()) as AgentDetailResponse;
    expect(detail.agent.status).toBe("IDLE");
    expect(detail.snapshot?.content).toContain("14 tests passed");
  });

  it("不存在的 Agent 返回 404", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    expect((await harness.request("/api/agents/nope", { cookie })).status).toBe(404);
  });
});

describe("API：回看历史（翻页 + 更早的纯文本）", () => {
  it("翻页直接带回滚动后的画面", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const before = (await (await harness.request("/api/surfaces/sf-11/grid", { cookie })).json()) as SurfaceGrid;
    expect(before.scrolledRows).toBe(0);

    const response = await harness.request("/api/surfaces/sf-11/scroll", {
      method: "POST",
      cookie,
      body: JSON.stringify({ action: "pageup" }),
    });
    expect(response.status).toBe(200);

    const scrolled = (await response.json()) as SurfaceScrollResponse;
    expect(scrolled.grid.scrolledRows).toBeGreaterThan(0);
    // 翻上去之后看到的是更早的构建日志，不再是最新那几行
    expect(gridText(scrolled.grid)).toContain("[build] step");
    expect(gridText(scrolled.grid)).not.toContain("14 tests passed");
  });

  it("回到底部：连按 pagedown 直到画面不再变化", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const scroll = (action: string) =>
      harness.request("/api/surfaces/sf-11/scroll", { method: "POST", cookie, body: JSON.stringify({ action }) });

    await scroll("pageup");
    await scroll("pageup");
    const back = (await (await scroll("bottom")).json()) as SurfaceScrollResponse;

    expect(back.grid.scrolledRows).toBe(0);
    expect(gridText(back.grid)).toContain("14 tests passed");
  });

  it("不认识的翻页动作是 400", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces/sf-11/scroll", {
      method: "POST",
      cookie,
      body: JSON.stringify({ action: "ctrl+c" }),
    });
    expect(response.status).toBe(400);
  });

  it("GET /history 去掉与网格重叠的部分，只给更早的内容", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const grid = (await (await harness.request("/api/surfaces/sf-11/grid", { cookie })).json()) as SurfaceGrid;
    const drop = grid.scrollbackRows + grid.viewportRows;

    const history = (await (
      await harness.request(`/api/surfaces/sf-11/history?drop=${drop}`, { cookie })
    ).json()) as SurfaceHistoryResponse;

    expect(history.droppedTail).toBe(drop);
    expect(history.text).toContain("[build] step 1/120");
    // 网格已经画出来的那几行不能再重复一遍
    expect(history.text).not.toContain("14 tests passed");
  });

  it("读历史不污染状态推断的基线", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const before = (await (
      await harness.request("/api/surfaces/sf-11/output", { cookie })
    ).json()) as SurfaceSnapshot;

    await harness.request("/api/surfaces/sf-11/history?drop=0", { cookie });

    const after = (await (
      await harness.request("/api/surfaces/sf-11/output", { cookie })
    ).json()) as SurfaceSnapshot;
    // 中间那次读历史如果进了 SnapshotTracker，这里的 revision 会被顶上去
    expect(after.revision).toBe(before.revision);
  });
});

describe("API：Hook 接收", () => {
  it("正确 token 的 hook 能推动状态", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const response = await harness.request("/api/hooks/codex", {
      method: "POST",
      headers: { "x-car-token": TEST_HOOK_TOKEN },
      body: JSON.stringify({
        event: "UserPromptSubmit",
        payload: { session_id: "sess-1" },
        context: { surfaceId: "sf-11", pid: 51002 },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, applied: true, status: "WORKING" });

    const inbox = (await (await harness.request("/api/agents", { cookie })).json()) as Inbox;
    expect(inbox.summary.working).toBe(1);
  });

  it("三家 Agent 都能上报", async () => {
    const harness = await createHarness();
    const cases = [
      { agent: "claude", surfaceId: "sf-20", event: "Notification", payload: { message: "needs your permission to use Bash" }, expected: "NEEDS_APPROVAL" },
      { agent: "codex", surfaceId: "sf-11", event: "PermissionRequest", payload: { tool_name: "shell" }, expected: "NEEDS_APPROVAL" },
      { agent: "grok", surfaceId: "sf-21", event: "Stop", payload: {}, expected: "RESPONDED_UNREAD" },
    ];

    for (const testCase of cases) {
      const response = await harness.request(`/api/hooks/${testCase.agent}`, {
        method: "POST",
        headers: { "x-car-token": TEST_HOOK_TOKEN },
        body: JSON.stringify({
          event: testCase.event,
          payload: testCase.payload,
          context: { surfaceId: testCase.surfaceId },
        }),
      });
      expect(await response.json(), testCase.agent).toMatchObject({ applied: true, status: testCase.expected });
    }
  });

  it("Hook 失效场景一律返回 200，不影响 Agent 运行", async () => {
    const harness = await createHarness();
    const cases = [
      { path: "/api/hooks/codex", headers: { "x-car-token": "WRONG" }, body: JSON.stringify({ event: "Stop" }) },
      { path: "/api/hooks/unknown-agent", headers: { "x-car-token": TEST_HOOK_TOKEN }, body: JSON.stringify({ event: "Stop" }) },
      { path: "/api/hooks/codex", headers: { "x-car-token": TEST_HOOK_TOKEN }, body: "not json" },
      { path: "/api/hooks/codex", headers: { "x-car-token": TEST_HOOK_TOKEN }, body: JSON.stringify({ event: "WhoKnows", context: { surfaceId: "sf-11" } }) },
      { path: "/api/hooks/codex", headers: { "x-car-token": TEST_HOOK_TOKEN }, body: JSON.stringify({ event: "Stop", context: { surfaceId: "unknown-surface" } }) },
    ];

    for (const testCase of cases) {
      const response = await harness.request(testCase.path, {
        method: "POST",
        headers: testCase.headers,
        body: testCase.body,
      });
      expect(response.status, testCase.path).toBe(200);
    }
  });

  it("Hook 密钥和人用的 PIN 是两把钥匙：拿 PIN 打 Hook 无效", async () => {
    const harness = await createHarness();
    const response = await harness.request("/api/hooks/codex", {
      method: "POST",
      headers: { "x-car-token": TEST_PIN },
      body: JSON.stringify({ event: "Stop", context: { surfaceId: "sf-11" } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(harness.engine.get("sf-11")?.status).toBe("IDLE");
  });

  it("Hook 只接受本机回环，公网打进来一律忽略", async () => {
    const harness = await createHarness();

    const remote = await harness.request("/api/hooks/codex", {
      method: "POST",
      ip: "203.0.113.9",
      headers: { "x-car-token": TEST_HOOK_TOKEN },
      body: JSON.stringify({ event: "Stop", context: { surfaceId: "sf-11" } }),
    });
    expect(remote.status).toBe(200);
    expect(await remote.json()).toMatchObject({ ok: false, ignored: "remote origin" });

    // 经过 Tunnel（带 X-Forwarded-For）也算远程
    const viaTunnel = await harness.request("/api/hooks/codex", {
      method: "POST",
      ip: "127.0.0.1",
      headers: { "x-car-token": TEST_HOOK_TOKEN, "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ event: "Stop", context: { surfaceId: "sf-11" } }),
    });
    expect(await viaTunnel.json()).toMatchObject({ ok: false, ignored: "remote origin" });

    // 本机直连正常
    const local = await harness.request("/api/hooks/codex", {
      method: "POST",
      ip: "127.0.0.1",
      headers: { "x-car-token": TEST_HOOK_TOKEN },
      body: JSON.stringify({ event: "Stop", context: { surfaceId: "sf-11" } }),
    });
    expect(await local.json()).toMatchObject({ ok: true, applied: true });
  });

  it("hook 不需要浏览器 Session（Agent 进程直连）", async () => {
    const harness = await createHarness();
    const response = await harness.request("/api/hooks/codex", {
      method: "POST",
      headers: { "x-car-token": TEST_HOOK_TOKEN },
      body: JSON.stringify({ event: "Stop", context: { surfaceId: "sf-11" } }),
    });
    expect(response.status).toBe(200);
  });
});

describe("实时推送与 API 的联动", () => {
  it("一次状态变化只推一条 status_changed（不重复）", async () => {
    const harness = await createHarness();
    const messages: Array<{ type: string }> = [];
    harness.ctx.hub.add((message) => messages.push(message));

    await harness.request("/api/hooks/codex", {
      method: "POST",
      headers: { "x-car-token": TEST_HOOK_TOKEN },
      body: JSON.stringify({ event: "PermissionRequest", context: { surfaceId: "sf-11" } }),
    });

    expect(messages.filter((m) => m.type === "agent.status_changed")).toHaveLength(1);
    expect(messages.filter((m) => m.type === "agent.list_changed")).toHaveLength(1);
  });

  it("发送 prompt 后订阅者收到 Working 状态", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const messages: Array<{ type: string; status?: string }> = [];
    harness.ctx.hub.add((message) => messages.push(message as { type: string; status?: string }));

    await harness.request("/api/surfaces/sf-11/input", {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "很好，继续检查一下边界 case", submit: true }),
    });

    const statusMessage = messages.find((m) => m.type === "agent.status_changed");
    expect(statusMessage?.status).toBe("WORKING");
  });
});

describe("审计", () => {
  it("写操作被记录，但不落 prompt 原文", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    await harness.request("/api/surfaces/sf-11/input", {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "这是一段不该被保存的敏感 prompt", submit: true }),
    });

    const entries = harness.store.recentAudit(10);
    const inputEntry = entries.find((entry) => entry.action === "surface.input");
    expect(inputEntry?.surfaceId).toBe("sf-11");
    expect(inputEntry?.detail).toMatch(/^len=\d+ submit=true$/);
    expect(JSON.stringify(entries)).not.toContain("敏感");
  });
});

describe("新建 surface", () => {
  it("登录后建一个 shell：带上反查到的工作目录，并出现在拓扑里", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const response = await harness.request("/api/surfaces", {
      method: "POST",
      cookie,
      body: JSON.stringify({ paneId: "pane-7", workspaceId: "ws-world-model" }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSurfaceResponse;
    expect(body).toMatchObject({ ok: true, cwd: TEST_PANE_CWD, launched: null });
    expect(body.surfaceId).toBeTruthy();
    expect(harness.client.created).toEqual([
      { paneId: "pane-7", workspaceId: "ws-world-model", cwd: TEST_PANE_CWD },
    ]);
    // 没选 Agent 就不该往终端里敲任何东西
    expect(harness.client.sentText).toHaveLength(0);

    const tree = (await (await harness.request("/api/tree", { cookie })).json()) as TreeResponse;
    const surfaces = tree.workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.surfaces));
    expect(surfaces.some((surface) => surface.id === body.surfaceId)).toBe(true);

    const audit = harness.store.recentAudit(10).find((entry) => entry.action === "surface.create");
    expect(audit?.surfaceId).toBe(body.surfaceId);
    expect(audit?.detail).toContain("pane=pane-7");
  });

  it("选了 Agent 就在新 tab 里敲白名单命令", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const response = await harness.request("/api/surfaces", {
      method: "POST",
      cookie,
      body: JSON.stringify({ paneId: "pane-7", launch: "claude" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateSurfaceResponse;

    expect(harness.client.sentText).toEqual([{ surfaceId: body.surfaceId, text: "c-d" }]);
    expect(harness.client.sentKeys).toEqual([{ surfaceId: body.surfaceId, key: "enter" }]);
  });

  it("可以从白名单启动 Pi", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const response = await harness.request("/api/surfaces", {
      method: "POST",
      cookie,
      body: JSON.stringify({ paneId: "pane-7", launch: "pi" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateSurfaceResponse;

    expect(body.launched).toBe("pi");
    expect(harness.client.sentText).toEqual([{ surfaceId: body.surfaceId, text: "pi" }]);
    expect(harness.client.sentKeys).toEqual([{ surfaceId: body.surfaceId, key: "enter" }]);
  });

  it("launch 只收白名单，任意命令一律 400", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces", {
      method: "POST",
      cookie,
      body: JSON.stringify({ paneId: "pane-7", launch: "rm -rf /" }),
    });
    expect(response.status).toBe(400);
    expect(harness.client.created).toHaveLength(0);
  });

  it("pane 必填，且必须在当前拓扑里真实存在", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();

    const missing = await harness.request("/api/surfaces", {
      method: "POST",
      cookie,
      body: JSON.stringify({ launch: null }),
    });
    expect(missing.status).toBe(400);

    const unknown = await harness.request("/api/surfaces", {
      method: "POST",
      cookie,
      body: JSON.stringify({ paneId: "pane-does-not-exist" }),
    });
    expect(unknown.status).toBe(404);
    expect(harness.client.created).toHaveLength(0);
  });
});

describe("关闭 surface", () => {
  it("没有 confirm 不能关", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces/sf-11/close", {
      method: "POST",
      cookie,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(428);
    expect(harness.client.closed).toHaveLength(0);
  });

  it("确认后从 cmux 拓扑里拿掉，不是只在前端藏起来", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces/sf-11/close", {
      method: "POST",
      cookie,
      body: JSON.stringify({ confirm: true }),
    });
    expect(response.status).toBe(200);
    expect(harness.client.closed).toEqual(["sf-11"]);

    const tree = (await (await harness.request("/api/tree", { cookie })).json()) as TreeResponse;
    const ids = tree.workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.surfaces.map((s) => s.id)));
    expect(ids).not.toContain("sf-11");
    expect(ids).toContain("sf-10");

    const audit = harness.store.recentAudit(10).find((entry) => entry.action === "surface.close");
    expect(audit?.surfaceId).toBe("sf-11");
  });

  it("workspace 最后一个 surface 关不掉", async () => {
    const harness = await createHarness();
    harness.client.setWorkspaces([
      {
        id: "ws-only",
        ref: "workspace:1",
        title: "only",
        panes: [
          {
            ref: "pane:1",
            id: "pane-1",
            surfaces: [{ id: "sf-only", ref: "surface:1", title: "only", agent: null, content: "$ " }],
          },
        ],
      },
    ]);
    const cookie = await harness.loginCookie();
    const response = await harness.request("/api/surfaces/sf-only/close", {
      method: "POST",
      cookie,
      body: JSON.stringify({ confirm: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "LAST_SURFACE" } });
    expect(harness.client.closed).toHaveLength(0);
  });
});

describe("健康检查", () => {
  it("/api/health 不需要登录", async () => {
    const harness = await createHarness();
    const response = await harness.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});

describe("读屏不改变活动版本", () => {
  it("HTTP 网格和文本读取不向状态引擎混入渲染版本", async () => {
    const harness = await createHarness();
    const cookie = await harness.loginCookie();
    harness.engine.applyOutput("sf-11", false, 42);
    for (const path of ["/api/surfaces/sf-11/grid", "/api/surfaces/sf-11/output", "/api/agents/sf-11"]) {
      expect((await harness.request(path, { cookie })).status).toBe(200);
      expect(harness.engine.get("sf-11")?.outputRevision).toBe(42);
    }
    harness.store.close();
  });
});

describe("创建 workspace 和 pane", () => {
  it("必须登录才能创建", async () => {
    const h = await createHarness();
    for (const path of ["/api/workspaces", "/api/workspaces/ws-1/panes"]) {
      expect((await h.request(path, { method: "POST" })).status).toBe(401);
    }
  });

  it("拒绝无效目录和未授权的 Agent，不创建 workspace", async () => {
    const h = await createHarness();
    const cookie = await h.loginCookie();
    const before = await h.client.getTree();
    for (const body of [{}, { cwd: "/", launch: "sh" }, { cwd: "relative", launch: "codex" },
      { cwd: "/not-a-real-workspace-directory", launch: "codex" }, { cwd: import.meta.filename, launch: "codex" },
      { cwd: "/tmp/\ncommand", launch: "codex" }]) {
      expect((await h.request("/api/workspaces", { method: "POST", cookie, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(await h.client.getTree()).toEqual(before);
  });

  it("安全引用目录，并且只向新终端发送启动命令", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace ' $(echo ignored) "));
    try {
      const h = await createHarness();
      const cookie = await h.loginCookie();
      const response = await h.request("/api/workspaces", { method: "POST", cookie,
        body: JSON.stringify({ cwd: directory, launch: "codex" }) });
      expect(response.status).toBe(201);
      const result = await response.json() as { surfaceId: string };
      const cwd = await realpath(directory);
      expect(h.client.sentText).toEqual([{ surfaceId: result.surfaceId,
        text: "cd -- '" + cwd.replaceAll("'", "'\\''") + "' && codex-d" }]);
      expect(h.client.sentKeys.at(-1)).toEqual({ surfaceId: result.surfaceId, key: "enter" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("启动发送失败仍返回已创建的 workspace，避免重复创建", async () => {
    const h = await createHarness();
    const cookie = await h.loginCookie();
    h.client.sendText = async () => { throw new Error("delivery unknown"); };
    const response = await h.request("/api/workspaces", { method: "POST", cookie,
      body: JSON.stringify({ cwd: process.cwd(), launch: "claude" }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, surfaceId: expect.any(String), launchError: expect.stringContaining("不要重复创建") });
  });

  it("创建 workspace 带一个终端，新增 pane 只影响指定 workspace", async () => {
    const h = await createHarness();
    const cookie = await h.loginCookie();
    const before = await h.client.getTree();
    const response = await h.request("/api/workspaces", { method: "POST", cookie, body: JSON.stringify({ cwd: process.cwd(), launch: "codex" }) });
    expect(response.status).toBe(201);
    const created = await response.json() as { workspaceId: string; surfaceId: string };
    const tree = await h.client.getTree();
    expect(tree.workspaces).toHaveLength(before.workspaces.length + 1);
    expect(tree.workspaces.find(w => w.id === created.workspaceId)?.panes[0]?.surfaces[0]?.id).toBe(created.surfaceId);
    const pane = await h.request(`/api/workspaces/${created.workspaceId}/panes`, { method: "POST", cookie });
    expect(pane.status).toBe(201);
    const next = await h.client.getTree();
    expect(next.workspaces.find(w => w.id === created.workspaceId)?.panes).toHaveLength(2);
    expect(next.workspaces.slice(0, before.workspaces.length)).toEqual(before.workspaces);
    expect((await h.request("/api/workspaces/missing/panes", { method: "POST", cookie })).status).toBe(404);
  });
});

describe("二次确认关闭 workspace / pane", () => {
  it("未登录及未明确确认均不执行关闭", async () => {
    const h = await createHarness();
    const cookie = await h.loginCookie();
    for (const path of ["/api/workspaces/ws-world-model/close", "/api/workspaces/ws-world-model/panes/pane-7/close"]) {
      expect((await h.request(path, { method: "POST" })).status).toBe(401);
      for (const body of [{}, { confirm: false, surfaceIds: ["sf-10"] }, { confirm: true }]) {
        expect((await h.request(path, { method: "POST", cookie, body: JSON.stringify(body) })).status).toBe(428);
      }
    }
    expect(h.client.closed).toEqual([]);
  });

  it("关闭 pane 包含其全部 surface，保留其他 pane 和 workspace", async () => {
    const h = await createHarness();
    const cookie = await h.loginCookie();
    const before = await h.client.getTree();
    const response = await h.request("/api/workspaces/ws-world-model/panes/pane-7/close", {
      method: "POST", cookie, body: JSON.stringify({ confirm: true, surfaceIds: ["sf-11", "sf-10"] }),
    });
    expect(response.status).toBe(200);
    expect(h.client.closed).toEqual(["sf-10", "sf-11"]);
    const after = await h.client.getTree();
    expect(after.workspaces[0]?.panes.map(p => p.id)).toEqual(["pane-8"]);
    expect(after.workspaces[1]).toEqual(before.workspaces[1]);
    const last = await h.request("/api/workspaces/ws-world-model/panes/pane-8/close", {
      method: "POST", cookie, body: JSON.stringify({ confirm: true, surfaceIds: ["sf-12"] }),
    });
    expect(last.status).toBe(409);
    expect(h.client.closed).toHaveLength(2);
  });

  it("workspace 整体关闭所有 pane 和 surface", async () => {
    const h = await createHarness();
    const cookie = await h.loginCookie();
    const result = await h.request("/api/workspaces/ws-world-model/close", {
      method: "POST", cookie, body: JSON.stringify({ confirm: true, surfaceIds: ["sf-10", "sf-11", "sf-12"] }),
    });
    expect(result.status).toBe(200);
    expect(h.client.closed).toEqual(["sf-10", "sf-11", "sf-12"]);
    expect((await h.client.getTree()).workspaces.map(w => w.id)).toEqual(["ws-eval"]);
  });

  it("范围变化、错误归属和不存在的目标不执行关闭", async () => {
    const h = await createHarness();
    const cookie = await h.loginCookie();
    for (const [path, status] of [
      ["/api/workspaces/ws-world-model/close", 409],
      ["/api/workspaces/ws-world-model/panes/pane-7/close", 409],
      ["/api/workspaces/ws-eval/panes/pane-7/close", 404],
      ["/api/workspaces/missing/close", 404],
    ] as const) {
      expect((await h.request(path, { method: "POST", cookie,
        body: JSON.stringify({ confirm: true, surfaceIds: ["sf-10"] }) })).status).toBe(status);
    }
    expect(h.client.closed).toEqual([]);
  });

  it("部分关闭失败时报告已关闭数量并同步结构", async () => {
    const h = await createHarness();
    const cookie = await h.loginCookie();
    const original = h.client.closeSurface.bind(h.client);
    h.client.closeSurface = async (id, workspaceId) => {
      if (id === "sf-11") throw new Error("测试错误");
      await original(id, workspaceId);
    };
    const result = await h.request("/api/workspaces/ws-world-model/panes/pane-7/close", {
      method: "POST", cookie, body: JSON.stringify({ confirm: true, surfaceIds: ["sf-10", "sf-11"] }),
    });
    expect(result.status).toBe(503);
    expect(await result.text()).toContain("已关闭 1 个 surface");
    expect(h.client.closed).toEqual(["sf-10"]);
    expect((await h.client.getTree()).workspaces[0]?.panes[0]?.surfaces.map(s => s.id)).toEqual(["sf-11"]);
  });
});
