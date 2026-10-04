import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "@car/protocol";
import { AUDIT_CLEANUP_INTERVAL_MS, StateStore } from "../src/state/store.ts";
import { openDatabase } from "../src/state/db.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "car-store-"));
  dirs.push(dir);
  return join(dir, "state.db");
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE: AgentState = {
  id: "SURF-11",
  agent: "codex",
  sessionId: "sess-1",
  workspaceId: "WS-WORLD",
  paneId: "PANE-7",
  surfaceId: "SURF-11",
  surfaceRef: "surface:11",
  pid: 5201,
  status: "RESPONDED_UNREAD",
  currentActivity: "Running tests",
  lastActivityAt: 1000,
  statusChangedAt: 1000,
  hookConnected: true,
  outputRevision: 3,
};

describe("StateStore（SQLite）", () => {
  it("能在真实 SQLite 上落盘并读回", async () => {
    const path = tempDb();
    const store = await StateStore.open(path);
    expect(["bun", "node"]).toContain(store.driver);
    expect(store.persistent).toBe(true);

    store.save(SAMPLE, 2000);
    store.close();

    const reopened = await StateStore.open(path);
    const rows = reopened.loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surfaceId: "SURF-11",
      agent: "codex",
      status: "RESPONDED_UNREAD",
      hookConnected: true,
      pid: 5201,
    });
    reopened.close();
  });

  it("同一 surface 重复保存是 upsert，不会产生重复行", async () => {
    const store = await StateStore.open(tempDb());
    store.save(SAMPLE, 1);
    store.save({ ...SAMPLE, status: "IDLE" }, 2);
    const rows = store.loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("IDLE");
    store.close();
  });

  it("审计日志按时间倒序返回，且截断过长内容", async () => {
    const store = await StateStore.open(tempDb());
    store.audit({ at: 1, action: "surface.input", surfaceId: "S1", detail: "len=10 submit=true" });
    store.audit({ at: 2, action: "surface.key", surfaceId: "S1", detail: "x".repeat(1000) });

    const entries = store.recentAudit(10);
    expect(entries[0]?.action).toBe("surface.key");
    expect(entries[0]?.detail?.length).toBe(500);
    expect(entries[1]?.action).toBe("surface.input");
    store.close();
  });

  it("不保存终端内容：活动文案最多 200 字", async () => {
    const store = await StateStore.open(tempDb());
    store.save({ ...SAMPLE, currentActivity: "终".repeat(1000) }, 1);
    expect(store.loadAll()[0]?.currentActivity?.length).toBe(200);
    store.close();
  });

  it("settings 可读写", async () => {
    const store = await StateStore.open(tempDb());
    expect(store.getSetting("theme")).toBeUndefined();
    store.setSetting("theme", "dark");
    store.setSetting("theme", "light");
    expect(store.getSetting("theme")).toBe("light");
    store.close();
  });

  it("显式无持久化测试驱动不会抛异常", () => {
    const store = StateStore.inMemory();
    expect(() => store.save(SAMPLE, 1)).not.toThrow();
    expect(store.loadAll()).toEqual([]);
    expect(store.persistent).toBe(false);
  });
});

describe("审计保留策略", () => {
  it("时间与条数共同限制，同时间戳优先保留后插入记录，清理不影响其它表", async () => {
    const store = await StateStore.open(tempDb(), { now: () => 10_000, auditMaxAgeMs: 1000, auditMaxRows: 3 });
    try {
      store.setSetting("keep", "yes");
      store.save(SAMPLE, 1);
      for (const [at, action] of [[8999, "expired"], [9000, "boundary"], [9500, "tie-1"], [9500, "tie-2"], [9500, "tie-3"]] as const) {
        store.audit({ at, action });
      }
      store.cleanupAudit();
      expect(store.recentAudit(100).map(entry => entry.action)).toEqual(["tie-3", "tie-2", "tie-1"]);
      expect(store.getSetting("keep")).toBe("yes");
      expect(store.loadAll()).toHaveLength(1);
    } finally { store.close(); }
  });

  it("启动清理已有日志，保留恰好位于时间边界的记录", async () => {
    const path = tempDb();
    const initial = await StateStore.open(path, { now: () => 1000 });
    initial.audit({ at: 8999, action: "expired" });
    initial.audit({ at: 9000, action: "boundary" });
    initial.close();
    const store = await StateStore.open(path, { now: () => 10_000, auditMaxAgeMs: 1000 });
    try {
      expect(store.recentAudit().map(entry => entry.action)).toEqual(["boundary"]);
      expect(store.auditDiagnostics().lastSuccessAt).toBe(10_000);
    } finally { store.close(); }
  });

  it("写入达到批次时自动裁剪，乱序时间戳按事件时间保留", async () => {
    const store = await StateStore.open(tempDb(), { now: () => 10_000, auditMaxRows: 2 });
    try {
      for (const at of [9000, 9500, 8000, 9400]) store.audit({ at, action: String(at) });
      expect(store.recentAudit().map(entry => entry.at)).toEqual([9500, 9400]);
    } finally { store.close(); }
  });

  it("空闲时也会定期清理，重复启动和关闭不会留下定时器", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = await StateStore.open(tempDb(), { auditMaxAgeMs: 1000 });
    const timers = vi.getTimerCount();
    try {
      store.audit({ at: 10_000, action: "old" });
      store.startAuditCleanup();
      store.startAuditCleanup();
      expect(vi.getTimerCount()).toBe(timers + 1);
      vi.advanceTimersByTime(AUDIT_CLEANUP_INTERVAL_MS);
      expect(store.recentAudit()).toEqual([]);
    } finally {
      store.close();
      const remaining = vi.getTimerCount();
      vi.useRealTimers();
      expect(remaining).toBe(timers);
    }
  });

  it("清理失败不影响已写审计，记录失败并在下次成功后恢复", async () => {
    const db = await openDatabase(tempDb());
    const onCleanupError = vi.fn();
    const store = new StateStore(db, { now: () => 10_000, auditMaxRows: 1, onCleanupError });
    const run = db.run.bind(db);
    const spy = vi.spyOn(db, "run").mockImplementation((sql, params) => {
      if (sql.startsWith("DELETE")) throw Object.assign(new Error("locked"), { code: "SQLITE_BUSY" });
      run(sql, params);
    });
    try {
      expect(() => store.audit({ at: 10_000, action: "sent" })).not.toThrow();
      expect(store.recentAudit()).toHaveLength(1);
      expect(store.auditDiagnostics().consecutiveFailures).toBe(1);
      expect(onCleanupError).toHaveBeenCalledOnce();
      spy.mockRestore();
      store.cleanupAudit();
      expect(store.auditDiagnostics().consecutiveFailures).toBe(0);
    } finally { spy.mockRestore(); store.close(); }
  });
});

describe("持久化不可用", () => {
  it("打不开数据目录时明确失败，不静默退化为无持久化", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "car-db-test-"));
    try {
      await expect(StateStore.open(join(directory, "missing", "state.db"))).rejects.toThrow("SQLite");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
