/**
 * single-flight：同一个 key 上并发的调用合并成一次真正执行。
 * 用来避免多个 WebSocket 客户端同时触发同一条 cmux CLI。
 */
export function createSingleFlight<T>() {
  const inflight = new Map<string, Promise<T>>();
  return function run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = (async () => fn())().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  };
}

/** 简单的 TTL 缓存。 */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
