import { safeJson } from "./http.ts";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { LoginRequestSchema, type SessionInfo } from "@car/protocol";
import { SERVER_VERSION } from "@car/protocol";
import { apiError, type AppContext } from "../context.ts";
import { SESSION_COOKIE, type Session } from "../security/token.ts";

export function sessionInfo(session: Session | null): SessionInfo {
  return {
    authenticated: session !== null,
    serverVersion: SERVER_VERSION,
  };
}

/**
 * 限流维度：优先用真实来源 IP。
 * 只有显式 --trust-proxy 时才信任 X-Forwarded-For，
 * 否则任何人都能靠伪造这个头绕开限流。
 */
export function clientKey(ctx: AppContext, c: Context): string {
  if (ctx.config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  const direct = (c.env as { ip?: string } | undefined)?.ip;
  return direct ?? "local";
}

/** Tunnel 后面是 HTTPS 时，Cookie 必须带 Secure。 */
function isSecureRequest(ctx: AppContext, c: Context): boolean {
  if (ctx.config.trustProxy && c.req.header("x-forwarded-proto") === "https") return true;
  return new URL(c.req.url).protocol === "https:";
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}

export function createAuthRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/session", (c) => {
    const session = ctx.sessions.get(getCookie(c, SESSION_COOKIE));
    return c.json(sessionInfo(session));
  });

  app.post("/login", async (c) => {
    const key = clientKey(ctx, c);

    // 先看限流闸门，再比对 PIN —— 顺序反了就等于没限流。
    const gate = ctx.throttle.check(key);
    if (!gate.allowed) {
      ctx.store.audit({
        at: ctx.now(),
        action: "auth.login_blocked",
        detail: `${key} scope=${gate.scope} wait=${Math.ceil(gate.retryAfterMs / 1000)}s`,
      });
      return c.json(
        apiError("TOO_MANY_ATTEMPTS", `尝试次数过多，请 ${formatWait(gate.retryAfterMs)}后再试`),
        429,
        { "retry-after": String(Math.ceil(gate.retryAfterMs / 1000)) },
      );
    }

    const body = await safeJson(c.req.raw);
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) return c.json(apiError("BAD_REQUEST", "缺少 PIN"), 400);

    const session = ctx.sessions.login(parsed.data.token);
    if (!session) {
      const after = ctx.throttle.recordFailure(key);
      ctx.store.audit({ at: ctx.now(), action: "auth.login_failed", detail: key });
      if (after.retryAfterMs > 0) {
        return c.json(
          apiError("TOO_MANY_ATTEMPTS", `PIN 不正确，已锁定 ${formatWait(after.retryAfterMs)}`),
          429,
          { "retry-after": String(Math.ceil(after.retryAfterMs / 1000)) },
        );
      }
      return c.json(
        apiError("UNAUTHORIZED", `PIN 不正确，还可以再试 ${after.remainingAttempts} 次`),
        401,
      );
    }

    ctx.throttle.recordSuccess(key);
    setCookie(c, SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: "Lax",
      secure: isSecureRequest(ctx, c),
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    ctx.store.audit({ at: ctx.now(), action: "auth.login", detail: key });
    return c.json(sessionInfo(session));
  });

  app.post("/logout", (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) ctx.sessions.logout(cookie);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json(sessionInfo(null));
  });

  return app;
}

