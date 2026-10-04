import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMessage } from "@car/protocol";
import { RealtimeConnection, type ConnectionState } from "../realtime/connection.ts";
export type { ConnectionState } from "../realtime/connection.ts";

export interface RealtimeOptions {
  enabled: boolean;
  onMessage: (message: ServerMessage) => void;
}

/** React 只负责挂载和浏览器事件，连接与重试由独立生命周期管理。 */
export function useRealtime({ enabled, onMessage }: RealtimeOptions) {
  const [state, setState] = useState<ConnectionState>("closed");
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const viewingRef = useRef<string | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!enabled) { setState("closed"); return; }
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const connection = new RealtimeConnection({
      createSocket: () => new WebSocket(`${protocol}://${window.location.host}/ws`),
      onState: setState,
      onMessage: (message) => handlerRef.current(message),
    });
    connectionRef.current = connection;
    connection.subscribe(viewingRef.current);
    connection.connect();
    const resume = () => { if (document.visibilityState === "visible") connection.resume(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      connection.dispose();
      connectionRef.current = null;
    };
  }, [enabled]);

  const subscribe = useCallback((surfaceId: string | null) => {
    viewingRef.current = surfaceId;
    connectionRef.current?.subscribe(surfaceId);
  }, []);
  return { state, subscribe };
}
