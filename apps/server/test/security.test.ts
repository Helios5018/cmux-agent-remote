import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/config.ts";
import {
  generatePin,
  generateToken,
  isValidPin,
  resolveAccessPin,
  resolveHookToken,
  safeCompare,
  SessionManager,
  type SessionPersistence,
} from "../src/security/token.ts";
import { LoginThrottle, type ThrottleEntry } from "../src/security/throttle.ts";
import { StateStore } from "../src/state/store.ts";

describe("Access PIN", () => {
  it("默认生成 4 位纯数字", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generatePin()).toMatch(/^\d{4}$/);
    }
  });

  it("可以生成更长的 PIN，长度被夹在 4-12 之间", () => {
    expect(generatePin(6)).toMatch(/^\d{6}$/);
    expect(generatePin(1)).toMatch(/^\d{4}$/);
    expect(generatePin(99)).toMatch(/^\d{12}$/);
  });

  it("分布上不是固定值", () => {
    expect(new Set(Array.from({ length: 200 }, () => generatePin())).size).toBeGreaterThan(50);
  });

  it("只接受 4-12 位纯数字", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123456789012")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("1234567890123")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
    expect(isValidPin("")).toBe(false);
  });

  it("比较是定长的，且长度不同直接判否", () => {
    expect(safeCompare("1234", "1234")).toBe(true);
    expect(safeCompare("1234", "1235")).toBe(false);
    expect(safeCompare("1234", "12345")).toBe(false);
  });
});

describe("PIN 与 Hook 密钥是两把钥匙", () => {
  it("PIN 首次生成后保存复用，Hook 密钥是长随机串", async () => {
    const store = await StateStore.open(":memory:");
    const pin = resolveAccessPin(store);
    const hookToken = resolveHookToken(store);

    expect(pin).toMatch(/^\d{4}$/);
    expect(hookToken.length).toBeGreaterThanOrEqual(24);
    expect(hookToken).not.toBe(pin);

    // 重启复用
    expect(resolveAccessPin(store)).toBe(pin);
    expect(resolveHookToken(store)).toBe(hookToken);
    store.close();
  });

  it("换 PIN 不会连累 Hook 密钥", async () => {
    const store = await StateStore.open(":memory:");
    const pin = resolveAccessPin(store);
    const hookToken = resolveHookToken(store);

    const rotated = resolveAccessPin(store, { rotate: true });
    expect(rotated).not.toBe(pin);
    expect(resolveHookToken(store)).toBe(hookToken);
    store.close();
  });

  it("--rotate-pin 会作废所有已登录设备", async () => {
    const store = await StateStore.open(":memory:");
    resolveAccessPin(store);
    store.saveSession({ id: "s1", createdAt: 1, lastSeenAt: 1 });

    resolveAccessPin(store, { rotate: true });
    expect(store.loadSessions()).toHaveLength(0);
    store.close();
  });

  it("显式 PIN 优先；变化时踢掉旧设备，不变则保留", async () => {
    const store = await StateStore.open(":memory:");
    resolveAccessPin(store);
    store.saveSession({ id: "s1", createdAt: 1, lastSeenAt: 1 });

    expect(resolveAccessPin(store, { explicit: "8642" })).toBe("8642");
    expect(store.loadSessions()).toHaveLength(0);

    store.saveSession({ id: "s2", createdAt: 1, lastSeenAt: 1 });
    resolveAccessPin(store, { explicit: "8642" });
    expect(store.loadSessions()).toHaveLength(1);
    store.close();
  });

  it("非数字 PIN 直接报错，不会静默降级", async () => {
    const store = await StateStore.open(":memory:");
    expect(() => resolveAccessPin(store, { explicit: "hunter2" })).toThrow(/4-12 位数字/);
    expect(() => resolveAccessPin(store, { explicit: "123" })).toThrow();
    store.close();
  });

  it("旧版本存的字母 token 会被换成数字 PIN", async () => {
    const store = await StateStore.open(":memory:");
    store.setSetting("access_pin", "OLDLETTERTOKEN");
    expect(resolveAccessPin(store)).toMatch(/^\d{4}$/);
    store.close();
  });

  it("generateToken 仍用于 Hook 等机器场景", () => {
    expect(generateToken()).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
  });
});

describe("登录限流（短 PIN 的安全前提）", () => {
  function makeThrottle(overrides = {}) {
    let clock = 1_000_000;
    const throttle = new LoginThrottle({
      now: () => clock,
      config: {
        failuresBeforeLock: 5,
        baseLockMs: 60_000,
        maxLockMs: 3_600_000,
        decayMs: 6 * 3_600_000,
        ...overrides,
      },
    });
    return { throttle, advance: (ms: number) => (clock += ms), now: () => clock };
  }

  it("前几次失败只扣次数，不锁定", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < 4; i += 1) {
      const result = throttle.recordFailure("1.2.3.4");
      expect(result.retryAfterMs).toBe(0);
      expect(result.remainingAttempts).toBe(4 - i);
    }
    expect(throttle.check("1.2.3.4").allowed).toBe(true);
  });

  it("第 5 次失败开始锁定，且锁定期间直接拒绝", () => {
    const { throttle, advance } = makeThrottle();
    for (let i = 0; i < 5; i += 1) throttle.recordFailure("1.2.3.4");

    const blocked = throttle.check("1.2.3.4");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(60_000);

    advance(60_001);
    expect(throttle.check("1.2.3.4").allowed).toBe(true);
  });

  it("锁定时间指数增长，并有上限", () => {
    const { throttle, advance } = makeThrottle();
    const waits: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const result = throttle.recordFailure("1.2.3.4");
      if (result.retryAfterMs > 0) waits.push(result.retryAfterMs);
      advance(result.retryAfterMs + 1);
    }
    expect(waits.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(Math.max(...waits)).toBe(3_600_000);
  });

  it("穷举 4 位 PIN 在这个策略下不可行", () => {
    const { throttle, advance } = makeThrottle();
    let attempts = 0;
    let elapsed = 0;
    // 模拟一整天不停地试
    while (elapsed < 24 * 60 * 60 * 1000) {
      const gate = throttle.check("attacker");
      if (gate.allowed) {
        attempts += 1;
        const failure = throttle.recordFailure("attacker");
        advance(1000);
        elapsed += 1000;
        if (failure.retryAfterMs > 0) {
          advance(failure.retryAfterMs);
          elapsed += failure.retryAfterMs;
        }
      } else {
        advance(gate.retryAfterMs);
        elapsed += gate.retryAfterMs;
      }
    }
    // 一天顶多几十次尝试：穷举 1 万种组合要一年以上
    expect(attempts).toBeLessThan(40);
    expect(10_000 / attempts).toBeGreaterThan(300);
  });

  it("换 IP 也绕不过去：全局闸门会接管", () => {
    const { throttle } = makeThrottle({ globalFailuresBeforeLock: 10, globalLockMs: 900_000 });
    for (let i = 0; i < 10; i += 1) throttle.recordFailure(`10.0.0.${i}`);
    // 一个全新的 IP 同样被挡住
    const fresh = throttle.check("203.0.113.7");
    expect(fresh.allowed).toBe(false);
    expect(fresh.scope).toBe("global");
  });

  it("登录成功清空计数", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < 4; i += 1) throttle.recordFailure("1.2.3.4");
    throttle.recordSuccess("1.2.3.4");
    expect(throttle.check("1.2.3.4").remainingAttempts).toBe(5);
  });

  it("长时间没有新失败，计数自然衰减", () => {
    const { throttle, advance } = makeThrottle({ decayMs: 30 * 60_000 });
    for (let i = 0; i < 4; i += 1) throttle.recordFailure("1.2.3.4");
    advance(31 * 60_000);
    expect(throttle.check("1.2.3.4").remainingAttempts).toBe(5);
  });

  it("衰减窗口比最长锁定还长，攻击者等不回免费次数", () => {
    const { throttle, advance } = makeThrottle();
    // 一路打到锁定上限
    for (let i = 0; i < 12; i += 1) {
      const result = throttle.recordFailure("1.2.3.4");
      advance(result.retryAfterMs + 1);
    }
    // 锁一到期就再试，计数不会因为「等过了」而清零
    expect(throttle.check("1.2.3.4").remainingAttempts).toBe(0);
    expect(throttle.recordFailure("1.2.3.4").retryAfterMs).toBe(3_600_000);
  });

  it("机主可以手动解锁", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < 6; i += 1) throttle.recordFailure("1.2.3.4");
    expect(throttle.check("1.2.3.4").allowed).toBe(false);
    throttle.unlock();
    expect(throttle.check("1.2.3.4").allowed).toBe(true);
    expect(throttle.lockedKeys()).toHaveLength(0);
  });

  it("锁定状态可持久化：重启服务不会把攻击者计数清零", () => {
    const rows: ThrottleEntry[] = [];
    const persistence = {
      load: () => rows,
      save: (entry: ThrottleEntry) => {
        const index = rows.findIndex((row) => row.key === entry.key);
        if (index >= 0) rows[index] = entry;
        else rows.push(entry);
      },
      remove: (key: string) => {
        const index = rows.findIndex((row) => row.key === key);
        if (index >= 0) rows.splice(index, 1);
      },
    };
    const now = () => 1_000_000;

    const first = new LoginThrottle({ now, persistence });
    for (let i = 0; i < 5; i += 1) first.recordFailure("1.2.3.4");
    expect(first.check("1.2.3.4").allowed).toBe(false);

    const restarted = new LoginThrottle({ now, persistence });
    expect(restarted.check("1.2.3.4").allowed).toBe(false);
  });

  it("触发锁定时会回调告警（服务端终端可见）", () => {
    const onLock = vi.fn();
    const throttle = new LoginThrottle({ now: () => 1_000_000, onLock });
    for (let i = 0; i < 5; i += 1) throttle.recordFailure("1.2.3.4");
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(onLock.mock.calls[0]?.[1]).toBe("key");
  });
});

describe("SessionManager", () => {
  const now = () => 1_000_000;

  it("PIN 正确才发 Session", () => {
    const sessions = new SessionManager({ token: "4271", now });
    expect(sessions.login("0000")).toBeNull();
    const session = sessions.login("4271");
    expect(session).not.toBeNull();
    expect(sessions.get(session?.id)).toBe(session);
  });

  it("登出后 Session 立即失效", () => {
    const sessions = new SessionManager({ token: "4271", now });
    const session = sessions.login("4271")!;
    sessions.logout(session.id);
    expect(sessions.get(session.id)).toBeNull();
  });

  it("Session 可持久化，重启后不用重新输 PIN", () => {
    const rows: Array<{ id: string; createdAt: number; lastSeenAt: number }> = [];
    const persistence: SessionPersistence = {
      load: () => rows,
      save: (session) => {
        const index = rows.findIndex((row) => row.id === session.id);
        if (index >= 0) rows[index] = session;
        else rows.push(session);
      },
      remove: (id) => {
        const index = rows.findIndex((row) => row.id === id);
        if (index >= 0) rows.splice(index, 1);
      },
    };

    const first = new SessionManager({ token: "4271", now, persistence });
    const session = first.login("4271")!;
    expect(rows).toHaveLength(1);

    const restarted = new SessionManager({ token: "4271", now, persistence });
    const restored = restarted.get(session.id);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe(session.id);
  });

  it("过期很久的 Session 不会被恢复", () => {
    const rows = [{ id: "old", createdAt: 0, lastSeenAt: 0 }];
    const removed: string[] = [];
    const manager = new SessionManager({
      token: "4271",
      now: () => 400 * 24 * 60 * 60 * 1000,
      persistence: {
        load: () => rows,
        save: () => {},
        remove: (id) => removed.push(id),
      },
    });
    expect(manager.get("old")).toBeNull();
    expect(removed).toEqual(["old"]);
  });
});

describe("命令行参数", () => {
  it("审计保留策略支持环境变量，非法值回落默认值", () => {
    expect(parseArgs([], { CAR_AUDIT_MAX_AGE_DAYS: "7", CAR_AUDIT_MAX_ROWS: "500" }).config)
      .toMatchObject({ auditMaxAgeDays: 7, auditMaxRows: 500 });
    for (const value of ["", "0", "-1", "abc", "Infinity", "1.5", "9007199254740992"]) {
      expect(parseArgs([], { CAR_AUDIT_MAX_AGE_DAYS: value, CAR_AUDIT_MAX_ROWS: value }).config)
        .toMatchObject({ auditMaxAgeDays: 30, auditMaxRows: 100_000 });
    }
  });
  it("默认监听 127.0.0.1:4318，不信任代理", () => {
    const { config } = parseArgs([], {});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4318);
    expect(config.trustProxy).toBe(false);
  });

  it("--lan 才对局域网开放", () => {
    expect(parseArgs(["--lan"], {}).config.host).toBe("0.0.0.0");
  });

  it("解析 PIN / 端口 / demo / 各种轮换开关", () => {
    const result = parseArgs(
      ["--port", "5000", "--pin", "8888", "--demo", "--rotate-pin", "--rotate-hook-token", "--unlock", "--trust-proxy"],
      {},
    );
    expect(result.config.port).toBe(5000);
    expect(result.config.pin).toBe("8888");
    expect(result.config.demo).toBe(true);
    expect(result.config.trustProxy).toBe(true);
    expect(result.pinProvided).toBe(true);
    expect(result.rotatePin).toBe(true);
    expect(result.rotateHookToken).toBe(true);
    expect(result.unlock).toBe(true);
  });

  it("--pin-length 控制自动生成的位数", () => {
    expect(parseArgs(["--pin-length", "6"], {}).config.pinLength).toBe(6);
  });

  it("非法端口回落到默认值", () => {
    expect(parseArgs(["--port", "abc"], {}).config.port).toBe(4318);
  });

  it("环境变量也能配置", () => {
    const { config, pinProvided } = parseArgs([], { CAR_PORT: "6000", CAR_PIN: "1357", CAR_TRUST_PROXY: "1" });
    expect(config.port).toBe(6000);
    expect(config.pin).toBe("1357");
    expect(config.trustProxy).toBe(true);
    expect(pinProvided).toBe(true);
  });
});
