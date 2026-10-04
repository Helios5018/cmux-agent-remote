/**
 * 登录限流与锁定。
 *
 * 4 位 PIN 只有 1 万种组合，只要允许无限次尝试，几秒钟就会被爆破。
 * 让短 PIN 在公网可用的前提，就是这里的指数级锁定：
 *
 *   前 5 次失败免费 → 第 5 次起锁 60s，之后每失败一次翻倍，上限 1 小时；
 *   失败计数要 6 小时没有新失败才清零；
 *   另有一个跨来源的全局闸门，防止攻击者换 IP 绕过单 IP 计数。
 *
 * 效果：稳定期每天最多 ~24 次尝试，穷举 1 万种组合要以年计。
 * 长期挂公网仍然建议用 6 位以上 PIN，或在前面再套一层 Tunnel 鉴权。
 */

export interface ThrottleConfig {
  /** 连续失败多少次开始锁定。 */
  failuresBeforeLock: number;
  /** 首次锁定时长。 */
  baseLockMs: number;
  /** 锁定时长上限。 */
  maxLockMs: number;
  /** 多久没有新的失败就把计数清零。 */
  decayMs: number;
  /** 全局失败阈值（所有来源合计），防 IP 轮换。 */
  globalFailuresBeforeLock: number;
  /** 全局锁定时长。 */
  globalLockMs: number;
}

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  failuresBeforeLock: 5,
  baseLockMs: 60_000,
  maxLockMs: 60 * 60_000,
  // 衰减窗口必须明显长于最长锁定时间，否则攻击者一等锁定结束
  // 计数就清零，指数退避会被重置成「每小时十几次」。
  decayMs: 6 * 60 * 60_000,
  globalFailuresBeforeLock: 20,
  globalLockMs: 15 * 60_000,
};

/** 全局闸门在内部借用这个 key。 */
export const GLOBAL_KEY = "*";

export interface ThrottleEntry {
  key: string;
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface ThrottlePersistence {
  load(): ThrottleEntry[];
  save(entry: ThrottleEntry): void;
  remove(key: string): void;
}

export interface ThrottleDecision {
  allowed: boolean;
  /** 还要等多久才能再试。 */
  retryAfterMs: number;
  /** 锁定前还剩几次机会。 */
  remainingAttempts: number;
  /** 是被单个来源的规则挡住，还是被全局闸门挡住。 */
  scope?: "key" | "global";
}

export interface LoginThrottleOptions {
  config?: Partial<ThrottleConfig>;
  now?: () => number;
  persistence?: ThrottlePersistence;
  /** 触发锁定时回调，用于在服务端终端打印告警。 */
  onLock?: (entry: ThrottleEntry, scope: "key" | "global") => void;
}

export class LoginThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();
  private readonly now: () => number;
  private readonly persistence?: ThrottlePersistence;
  private readonly onLock?: (entry: ThrottleEntry, scope: "key" | "global") => void;
  readonly config: ThrottleConfig;

  constructor(options: LoginThrottleOptions = {}) {
    this.config = { ...DEFAULT_THROTTLE_CONFIG, ...options.config };
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
    this.onLock = options.onLock;
    for (const entry of this.persistence?.load() ?? []) {
      this.entries.set(entry.key, entry);
    }
  }

  private entry(key: string): ThrottleEntry {
    return this.entries.get(key) ?? { key, failures: 0, lastFailureAt: 0, lockedUntil: 0 };
  }

  /** 计数过期就清零，避免昨天的失败一直挂着。 */
  private decayed(entry: ThrottleEntry, now: number): ThrottleEntry {
    if (entry.failures === 0) return entry;
    if (entry.lockedUntil > now) return entry;
    if (now - entry.lastFailureAt >= this.config.decayMs) {
      return { key: entry.key, failures: 0, lastFailureAt: 0, lockedUntil: 0 };
    }
    return entry;
  }

  /** 登录前调用：现在允不允许尝试。 */
  check(key: string): ThrottleDecision {
    const now = this.now();
    const scoped = this.decayed(this.entry(key), now);
    const global = this.decayed(this.entry(GLOBAL_KEY), now);

    if (global.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterMs: global.lockedUntil - now,
        remainingAttempts: 0,
        scope: "global",
      };
    }
    if (scoped.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterMs: scoped.lockedUntil - now,
        remainingAttempts: 0,
        scope: "key",
      };
    }
    return {
      allowed: true,
      retryAfterMs: 0,
      remainingAttempts: Math.max(0, this.config.failuresBeforeLock - scoped.failures),
    };
  }

  /** 密码错误时调用。 */
  recordFailure(key: string): ThrottleDecision {
    const now = this.now();
    const scoped = this.bump(this.decayed(this.entry(key), now), now, {
      threshold: this.config.failuresBeforeLock,
      baseMs: this.config.baseLockMs,
      maxMs: this.config.maxLockMs,
      scope: "key",
    });
    const global = this.bump(this.decayed(this.entry(GLOBAL_KEY), now), now, {
      threshold: this.config.globalFailuresBeforeLock,
      baseMs: this.config.globalLockMs,
      maxMs: this.config.maxLockMs,
      scope: "global",
    });

    const lockedUntil = Math.max(scoped.lockedUntil, global.lockedUntil);
    return {
      allowed: false,
      retryAfterMs: Math.max(0, lockedUntil - now),
      remainingAttempts: Math.max(0, this.config.failuresBeforeLock - scoped.failures),
      scope: global.lockedUntil > scoped.lockedUntil ? "global" : "key",
    };
  }

  private bump(
    entry: ThrottleEntry,
    now: number,
    rule: { threshold: number; baseMs: number; maxMs: number; scope: "key" | "global" },
  ): ThrottleEntry {
    const failures = entry.failures + 1;
    const overflow = failures - rule.threshold;
    const lockedUntil =
      overflow >= 0 ? now + Math.min(rule.baseMs * 2 ** overflow, rule.maxMs) : entry.lockedUntil;

    const next: ThrottleEntry = { key: entry.key, failures, lastFailureAt: now, lockedUntil };
    this.entries.set(next.key, next);
    this.persistence?.save(next);
    if (overflow >= 0) this.onLock?.(next, rule.scope);
    return next;
  }

  /** 登录成功时调用：清掉这个来源的失败计数与全局计数。 */
  recordSuccess(key: string): void {
    this.entries.delete(key);
    this.entries.delete(GLOBAL_KEY);
    this.persistence?.remove(key);
    this.persistence?.remove(GLOBAL_KEY);
  }

  /** 机主在本机手动解锁。 */
  unlock(key?: string): void {
    if (key) {
      this.entries.delete(key);
      this.persistence?.remove(key);
      this.entries.delete(GLOBAL_KEY);
      this.persistence?.remove(GLOBAL_KEY);
      return;
    }
    for (const existing of [...this.entries.keys()]) {
      this.entries.delete(existing);
      this.persistence?.remove(existing);
    }
  }

  /** 当前处于锁定状态的来源，用于展示与告警。 */
  lockedKeys(): ThrottleEntry[] {
    const now = this.now();
    return [...this.entries.values()].filter((entry) => entry.lockedUntil > now);
  }
}
