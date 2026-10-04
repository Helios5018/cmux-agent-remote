import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeConnection, type RealtimeSocket } from "../src/realtime/connection.ts";

function setup() {
  vi.useFakeTimers();
  const sockets: RealtimeSocket[] = [];
  const onState = vi.fn();
  const onMessage = vi.fn();
  const connection = new RealtimeConnection({
    createSocket: () => {
      const socket: RealtimeSocket = {
        readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
        send: vi.fn(), close: vi.fn(),
      };
      sockets.push(socket);
      return socket;
    }, onState, onMessage,
  });
  connection.connect();
  return { connection, sockets, onState, onMessage };
}
afterEach(() => vi.useRealTimers());

describe("连接生命周期", () => {
  it("销毁后旧 close/open/message 事件不能重连或更新状态", () => {
    const { connection, sockets, onState, onMessage } = setup();
    const socket = sockets[0]!;
    connection.dispose();
    onState.mockClear();
    socket.onclose?.(new Event("close") as CloseEvent); socket.onopen?.(new Event("open"));
    socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "pong", now: 1 }) }));
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(onState).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("断线退避重连并恢复当前订阅，前台唤醒不会重复建连接", () => {
    const { connection, sockets } = setup();
    connection.subscribe("surface-a");
    sockets[0]!.onopen?.(new Event("open")); sockets[0]!.onclose?.(new Event("close") as CloseEvent);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    connection.resume();
    sockets[1]!.onopen?.(new Event("open"));
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "subscribe", surfaceId: "surface-a" }));
    // 旧连接迟到的关闭事件不能关闭新连接。
    sockets[0]!.onclose?.(new Event("close") as CloseEvent);
    expect(sockets[1]!.close).not.toHaveBeenCalled();
    connection.dispose();
  });

  it("心跳无响应时关闭半开连接，有 pong 时保持连接", () => {
    const { connection, sockets } = setup();
    sockets[0]!.onopen?.(new Event("open"));
    vi.advanceTimersByTime(30_000);
    expect(sockets[0]!.send).toHaveBeenCalledWith('{"type":"ping"}');
    sockets[0]!.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "pong", now: Date.now() }) }));
    vi.advanceTimersByTime(30_000);
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_500);
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(2);
    connection.dispose();
  });
});
