import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * 安全设计。
 *
 * 这个系统本质上拥有远程控制终端的能力，所以第一版就必须：
 * - 有 Access Token
 * - 登录后即可读写（PIN + 限流兜底）
 */

export const SESSION_COOKIE = "car_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** PIN 允许的长度范围：4 位够短到能记住，靠限流兜底；更长更安全。 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 12;

/**
 * 生成纯数字 PIN。
 *
 * 4 位只有 1 万种组合，本身很弱 —— 它能用的前提是
 * LoginThrottle 的指数级锁定（见 throttle.ts）。
 */
export function generatePin(digits = MIN_PIN_LENGTH): string {
  const length = Math.min(MAX_PIN_LENGTH, Math.max(MIN_PIN_LENGTH, Math.floor(digits)));
  let pin = "";
  for (let i = 0; i < length; i += 1) pin += String(randomInt(0, 10));
  return pin;
}

export function isValidPin(value: string): boolean {
  return new RegExp(`^\\d{${MIN_PIN_LENGTH},${MAX_PIN_LENGTH}}$`).test(value);
}

/** 生成人可抄写的 token（去掉容易混淆的字符）；用于机器对机器的 Hook 密钥。 */
export function generateToken(bytes = 12): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const raw = randomBytes(bytes);
  let out = "";
  for (const byte of raw) out += alphabet[byte % alphabet.length];
  return out;
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface Session {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Session 的持久化钩子。
 * 重启服务后手机端不用重新输 PIN。
 */
export interface SessionPersistence {
  load(): Array<{ id: string; createdAt: number; lastSeenAt: number }>;
  save(session: { id: string; createdAt: number; lastSeenAt: number }): void;
  remove(id: string): void;
}

export interface SessionManagerOptions {
  token: string;
  now?: () => number;
  persistence?: SessionPersistence;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly persistence?: SessionPersistence;
  readonly token: string;

  constructor(options: SessionManagerOptions) {
    this.token = options.token;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
    this.restore();
  }

  private restore(): void {
    if (!this.persistence) return;
    const now = this.now();
    for (const row of this.persistence.load()) {
      if (now - row.lastSeenAt > SESSION_TTL_MS) {
        this.persistence.remove(row.id);
        continue;
      }
      this.sessions.set(row.id, { ...row });
    }
  }

  /** 用 Access Token 换 Session。 */
  login(token: string): Session | null {
    if (!safeCompare(token.trim(), this.token)) return null;
    const now = this.now();
    const session: Session = {
      id: randomBytes(24).toString("base64url"),
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(session.id, session);
    this.persistence?.save(session);
    return session;
  }

  get(sessionId: string | undefined): Session | null {
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const now = this.now();
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
      this.sessions.delete(sessionId);
      this.persistence?.remove(sessionId);
      return null;
    }
    session.lastSeenAt = now;
    return session;
  }

  logout(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.persistence?.remove(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/**
 * 凭据解析。
 *
 * 系统里有两把钥匙，故意分开：
 *   - Access PIN：人输入的，短（默认 4 位数字），靠限流保护。
 *   - Hook Token：机器用的，长随机串，只走本机回环，人永远不用输。
 * 这样即使 PIN 很短，Hook 接口也不会因此变得可伪造。
 */
export interface TokenStore {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  clearSessions(): void;
}

export const ACCESS_PIN_SETTING = "access_pin";
export const HOOK_TOKEN_SETTING = "hook_token";

export function resolveAccessPin(
  store: TokenStore,
  options: { explicit?: string; rotate?: boolean; digits?: number } = {},
): string {
  const saved = store.getSetting(ACCESS_PIN_SETTING);

  if (options.explicit) {
    if (!isValidPin(options.explicit)) {
      throw new Error(`PIN 必须是 ${MIN_PIN_LENGTH}-${MAX_PIN_LENGTH} 位数字`);
    }
    if (saved !== options.explicit) {
      store.setSetting(ACCESS_PIN_SETTING, options.explicit);
      store.clearSessions();
    }
    return options.explicit;
  }

  // 老版本存的是字母 token，长度/字符集不符就当作需要重新生成。
  if (saved && isValidPin(saved) && !options.rotate) return saved;

  const generated = generatePin(options.digits ?? MIN_PIN_LENGTH);
  store.setSetting(ACCESS_PIN_SETTING, generated);
  store.clearSessions();
  return generated;
}

/** Hook 密钥：一旦生成就长期复用，除非显式轮换。 */
export function resolveHookToken(store: TokenStore, options: { rotate?: boolean } = {}): string {
  const saved = store.getSetting(HOOK_TOKEN_SETTING);
  if (saved && saved.length >= 16 && !options.rotate) return saved;
  const generated = randomBytes(24).toString("base64url");
  store.setSetting(HOOK_TOKEN_SETTING, generated);
  return generated;
}
