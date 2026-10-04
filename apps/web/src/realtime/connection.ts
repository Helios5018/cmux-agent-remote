import { ServerMessageSchema, type ServerMessage } from "@car/protocol";

export type ConnectionState = "connecting" | "open" | "closed";
export interface RealtimeSocket {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

/** 独立于 React 的连接生命周期，销毁后任何旧回调都不能重新连接。 */
export class RealtimeConnection {
  private socket: RealtimeSocket | null = null;
  private disposed = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastPong = 0;
  private viewing: string | null = null;

  constructor(private readonly options: {
    createSocket: () => RealtimeSocket;
    onState: (state: ConnectionState) => void;
    onMessage: (message: ServerMessage) => void;
    now?: () => number;
  }) {}

  connect = (): void => {
    if (this.disposed || this.socket) return;
    clearTimeout(this.retry);
    this.options.onState("connecting");
    let socket: RealtimeSocket;
    try {
      socket = this.options.createSocket();
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    const active = () => !this.disposed && this.socket === socket;
    socket.onopen = () => {
      if (!active()) return;
      this.attempt = 0;
      this.lastPong = this.now();
      this.options.onState("open");
      this.subscribe(this.viewing);
      this.heartbeat = setInterval(() => {
        if (!active()) return;
        if (this.now() - this.lastPong >= 45_000) this.disconnect(socket);
        else this.send({ type: "ping" });
      }, 15_000);
    };
    socket.onmessage = (event) => {
      if (!active()) return;
      let parsed;
      try {
        parsed = ServerMessageSchema.safeParse(JSON.parse(String(event.data)));
      } catch { return; }
      if (!parsed.success) return;
      if (parsed.data.type === "pong") this.lastPong = this.now();
      this.options.onMessage(parsed.data);
    };
    socket.onclose = () => { if (active()) this.disconnect(socket); };
    socket.onerror = () => { if (active()) this.disconnect(socket); };
  };

  subscribe(surfaceId: string | null): void {
    this.viewing = surfaceId;
    this.send({ type: "subscribe", surfaceId });
  }

  /** 切回前台时立即恢复；半开连接由心跳超时处理。 */
  resume = (): void => {
    if (this.socket && this.now() - this.lastPong >= 45_000) this.disconnect(this.socket);
    this.attempt = 0;
    this.connect();
  };

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private send(message: object): void {
    const socket = this.socket;
    if (socket?.readyState !== 1) return;
    try { socket.send(JSON.stringify(message)); }
    catch { this.disconnect(socket); }
  }

  private disconnect(socket: RealtimeSocket): void {
    this.socket = null;
    clearInterval(this.heartbeat);
    socket.close();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.disposed) return;
    this.options.onState("closed");
    clearTimeout(this.retry);
    this.retry = setTimeout(this.connect, Math.min(500 * 2 ** Math.min(this.attempt++, 6), 15_000));
  }
}
