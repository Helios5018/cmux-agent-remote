import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { clientKey } from "../api/auth.ts";
import { apiError, type AppContext } from "../context.ts";
import { SESSION_COOKIE, safeCompare, type Session } from "./token.ts";

export type Env = {
  Variables: {
    session: Session;
  };
};

/**
 * 登录校验：首次用 Access PIN 换 Session Cookie，之后都认 Cookie。
 * 为了方便脚本/调试，也接受 Authorization: Bearer <pin>，
 * 但这条路同样走限流 —— 否则 4 位 PIN 就等于没有保护。
 */
export function requireAuth(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c: Context<Env>, next: Next) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    let session = ctx.sessions.get(cookie);

    if (!session) {
      const header = c.req.header("authorization");
      const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
      const headerToken = bearer ?? c.req.header("x-car-token");
      if (headerToken) {
        const key = clientKey(ctx, c);
        const gate = ctx.throttle.check(key);
        if (!gate.allowed) {
          return c.json(apiError("TOO_MANY_ATTEMPTS", "尝试次数过多，请稍后再试"), 429, {
            "retry-after": String(Math.ceil(gate.retryAfterMs / 1000)),
          });
        }
        session = ctx.sessions.login(headerToken);
        if (session) ctx.throttle.recordSuccess(key);
        else ctx.throttle.recordFailure(key);
      }
    }

    if (!session) {
      return c.json(apiError("UNAUTHORIZED", "需要先用 Access PIN 登录"), 401);
    }
    c.set("session", session);
    await next();
  };
}

/**
 * 请求是不是本机直连。
 * 带 X-Forwarded-For 说明经过了代理 / Tunnel，一律不算本机。
 */
export function isLoopbackRequest(c: Context): boolean {
  if (c.req.header("x-forwarded-for")) return false;
  const ip = (c.env as { ip?: string } | undefined)?.ip;
  if (!ip) return true;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Hook 接收端：不用 Session，只认独立的 Hook 密钥，而且只接受本机回环请求。
 *
 * 两点很关键：
 * 1. Hook 密钥和人用的 PIN 是两把钥匙 —— PIN 短不会连累 Hook 接口。
 * 2. Hook 永远来自本机 Agent 进程，公网打进来的一律拒绝。
 */
export function requireHookToken(ctx: AppContext): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // 故意返回 200：Hook 失效绝不能影响 Agent 本身运行。
    if (!isLoopbackRequest(c)) {
      return c.json({ ok: false, ignored: "remote origin" }, 200);
    }
    const token = c.req.header("x-car-token") ?? c.req.query("token") ?? "";
    if (!token || !safeCompare(token, ctx.config.hookToken)) {
      return c.json({ ok: false, ignored: "bad token" }, 200);
    }
    await next();
  };
}
