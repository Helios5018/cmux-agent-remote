import type { AgentState, ServerMessage } from "@car/protocol";
import { SERVER_VERSION } from "@car/protocol";
import { ClientMessageSchema } from "@car/protocol";

/**
 * Module 5：Realtime Engine。
 *
 * 这里刻意与具体的 WebSocket 实现解耦：hub 只知道 "怎么把消息发出去"，
 * 由 websocket.ts 负责把 Bun 的 WebSocket 接进来。这样 hub 可以在 Node 上单测。
 */

export interface HubClient {
  id: string;
  /** 当前正在查看的 surface；决定高频刷新目标。 */
  viewing: string | null;
  send(message: ServerMessage): void;
  close(): void;
}

export interface RealtimeHubOptions {
  now?: () => number;
  /** 有人开始/停止查看某个 surface 时通知上层（用于调整轮询频率与未读）。 */
  onViewingChanged?: (surfaceId: string | null, viewing: boolean) => void;
}

export class RealtimeHub {
  private readonly clients = new Map<string, HubClient>();
  private nextId = 1;
  private readonly now: () => number;
  private readonly onViewingChanged?: (surfaceId: string | null, viewing: boolean) => void;

  constructor(options: RealtimeHubOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onViewingChanged = options.onViewingChanged;
  }

  add(send: (message: ServerMessage) => void, close: () => void = () => {}): HubClient {
    const client: HubClient = {
      id: `c${this.nextId++}`,
      viewing: null,
      send,
      close,
    };
    this.clients.set(client.id, client);
    try {
      client.send({ type: "hello", serverVersion: SERVER_VERSION, now: this.now() });
    } catch {
      // 连接刚建立就断了，交给上层的 close 流程处理
    }
    return client;
  }

  remove(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    // 先摘掉自己，再判断是否还有别人在看这个 surface
    this.clients.delete(clientId);
    if (client.viewing) this.notifyViewing(client.viewing, false);
  }

  /** 处理浏览器发来的消息。 */
  handleMessage(clientId: string, raw: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      client.send({ type: "error", code: "BAD_MESSAGE", message: "消息不是合法 JSON" });
      return;
    }
    const parsed = ClientMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      client.send({ type: "error", code: "BAD_MESSAGE", message: "未知消息类型" });
      return;
    }

    if (parsed.data.type === "ping") {
      client.send({ type: "pong", now: this.now() });
      return;
    }

    const previous = client.viewing;
    const next = parsed.data.surfaceId;
    if (previous === next) return;
    client.viewing = next;
    if (previous) this.notifyViewing(previous, false);
    if (next) this.notifyViewing(next, true);
  }

  private notifyViewing(surfaceId: string, viewing: boolean): void {
    // 只有当没有其它客户端还在看这个 surface 时，才算真正停止查看。
    if (!viewing && this.viewers(surfaceId).length > 0) return;
    this.onViewingChanged?.(surfaceId, viewing);
  }

  viewers(surfaceId: string): HubClient[] {
    return [...this.clients.values()].filter((client) => client.viewing === surfaceId);
  }

  /** 当前有人在看的所有 surface。 */
  viewedSurfaces(): string[] {
    const set = new Set<string>();
    for (const client of this.clients.values()) {
      if (client.viewing) set.add(client.viewing);
    }
    return [...set];
  }

  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) {
      try {
        client.send(message);
      } catch {
        // 单个客户端发送失败不影响其它人。
      }
    }
  }

  /** 只推给正在看这个 surface 的客户端（内容更新不需要广播给所有人）。 */
  sendToViewers(surfaceId: string, message: ServerMessage): void {
    for (const client of this.viewers(surfaceId)) {
      try {
        client.send(message);
      } catch {
        // 忽略
      }
    }
  }

  broadcastStatus(state: AgentState): void {
    this.broadcast({
      type: "agent.status_changed",
      surfaceId: state.surfaceId,
      status: state.status,
      agent: state,
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.close();
      } catch {
        // 忽略
      }
    }
    this.clients.clear();
  }
}
