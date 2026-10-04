import type { ServerMessage } from "@car/protocol";
import type { AppContext } from "../context.ts";
import { SESSION_COOKIE } from "../security/token.ts";
import type { HubClient } from "./hub.ts";

/**
 * 把 RealtimeHub 接到 Bun 的 WebSocket 上。
 * 只有这一层依赖 Bun；hub 本身是运行时无关的，可以在 Node 上单测。
 */

export interface BunWebSocket {
  data: { clientId?: string };
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function authenticateUpgrade(ctx: AppContext, request: Request, ip?: string) {
  const cookie = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const session = ctx.sessions.get(cookie);
  if (session) return session;

  // 兼容手动带 PIN 的客户端（例如脚本）。这条路同样要过限流，
  // 否则攻击者可以用 WebSocket 握手绕开 /api/auth/login 的锁定。
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return null;

  const forwarded = ctx.config.trustProxy
    ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    : undefined;
  const key = forwarded ?? ip ?? "local";
  if (!ctx.throttle.check(key).allowed) return null;

  const authenticated = ctx.sessions.login(token);
  if (authenticated) ctx.throttle.recordSuccess(key);
  else ctx.throttle.recordFailure(key);
  return authenticated;
}

export function createWebSocketHandlers(ctx: AppContext) {
  const clients = new Map<string, HubClient>();

  return {
    /** Bun.serve 的 websocket handler。 */
    websocket: {
      // 网格帧一帧 20~80 KB，且全是重复的空格与十六进制色值，压缩率极高。
      perMessageDeflate: true,
      open(ws: BunWebSocket) {
        const client = ctx.hub.add(
          (message: ServerMessage) => ws.send(JSON.stringify(message)),
          () => ws.close(),
        );
        ws.data.clientId = client.id;
        clients.set(client.id, client);
      },
      message(ws: BunWebSocket, raw: string | Uint8Array) {
        const clientId = ws.data.clientId;
        if (!clientId) return;
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        ctx.hub.handleMessage(clientId, text);
        // 订阅变化要同步给 State Engine（决定未读与刷新频率）。
        const client = clients.get(clientId);
        if (client) syncViewing(ctx, client);
      },
      close(ws: BunWebSocket) {
        const clientId = ws.data.clientId;
        if (!clientId) return;
        const client = clients.get(clientId);
        if (client?.viewing) ctx.engine.setViewing(client.viewing, ctx.hub.viewers(client.viewing).length > 1);
        ctx.hub.remove(clientId);
        clients.delete(clientId);
      },
    },
  };
}

function syncViewing(ctx: AppContext, client: HubClient): void {
  // 清掉这个客户端已经离开的 surface
  for (const surfaceId of ctx.engine.list().map((a) => a.surfaceId)) {
    const stillViewed = ctx.hub.viewers(surfaceId).length > 0;
    ctx.engine.setViewing(surfaceId, stillViewed);
  }
  if (client.viewing) {
    ctx.engine.setViewing(client.viewing, true);
    // 状态变化由 engine.onChange 推送
    ctx.engine.markViewed(client.viewing);
  }
}
