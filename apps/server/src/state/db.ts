/**
 * 极薄的 SQLite 驱动抽象。
 *
 * 服务运行在 Bun 上（bun:sqlite），测试跑在 Node 上（node:sqlite），
 * 两边 API 略有差别，这里统一成一个接口。打开失败显式报错，
 * 测试需通过 createMemoryDatabase 显式选择无持久化模式。
 */
export interface SqlDatabase {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  close(): void;
  readonly driver: "bun" | "node" | "memory";
  readonly persistent: boolean;
}

export async function openDatabase(path: string): Promise<SqlDatabase> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    try {
      // 变量化模块名，避免 TS / 打包器在非 Bun 环境下解析 bun:sqlite。
      const moduleName = "bun:sqlite";
      const { Database } = (await import(/* @vite-ignore */ moduleName)) as unknown as {
        Database: new (path: string, options?: unknown) => BunDb;
      };
      const db = new Database(path, { create: true });
      return wrapBun(db, path !== ":memory:" && path !== "");
    } catch (cause) {
      throw new Error("无法打开 SQLite 数据库，请检查数据目录与文件权限", { cause });
    }
  }

  try {
    // 用 createRequire 而不是 import()：打包器（vite/vitest）会重写动态 import，
    // 把 node:sqlite 解析成不存在的文件；require 则原样交给 Node。
    const { createRequire } = await import("node:module");
    const nodeRequire = createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => NodeDb;
    };
    return wrapNode(new DatabaseSync(path), path !== ":memory:" && path !== "");
  } catch (cause) {
    throw new Error("无法打开 SQLite 数据库，需要可用的 SQLite 驱动与数据目录", { cause });
  }
}

interface BunDb {
  run(sql: string, params?: unknown[]): void;
  query(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
}

function wrapBun(db: BunDb, persistent: boolean): SqlDatabase {
  return {
    driver: "bun",
    persistent,
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      db.run(sql, params);
    },
    all: <T>(sql: string, params: unknown[] = []) => db.query(sql).all(...params) as T[],
    get: <T>(sql: string, params: unknown[] = []) => (db.query(sql).get(...params) ?? undefined) as T | undefined,
    close: () => db.close(),
  };
}

interface NodeDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

function wrapNode(db: NodeDb, persistent: boolean): SqlDatabase {
  return {
    driver: "node",
    persistent,
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      db.prepare(sql).run(...params);
    },
    all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: unknown[] = []) => (db.prepare(sql).get(...params) ?? undefined) as T | undefined,
    close: () => db.close(),
  };
}

/** 显式测试替身：什么都不存；生产打开失败不会自动选用此驱动。 */
export function createMemoryDatabase(): SqlDatabase {
  return {
    driver: "memory",
    persistent: false,
    exec: () => {},
    run: () => {},
    all: <T>() => [] as T[],
    get: <T>() => undefined as T | undefined,
    close: () => {},
  };
}
