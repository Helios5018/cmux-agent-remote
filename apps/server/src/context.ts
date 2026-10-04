import type { CmuxPane } from "@car/protocol";
import type { CmuxClient } from "./cmux/client.ts";
import type { Poller } from "./realtime/poller.ts";
import type { RealtimeHub } from "./realtime/hub.ts";
import type { SessionManager } from "./security/token.ts";
import type { LoginThrottle } from "./security/throttle.ts";
import type { StateEngine } from "./state/engine.ts";
import type { StateStore } from "./state/store.ts";
import type { ServerConfig } from "./config.ts";
import type { RuntimeDiagnostics } from "./diagnostics.ts";

/** 一次运行所需要的全部依赖，方便测试里整体替换。 */
export interface AppContext {
  config: ServerConfig;
  diagnostics: RuntimeDiagnostics;
  client: CmuxClient;
  engine: StateEngine;
  store: StateStore;
  sessions: SessionManager;
  /** 登录限流：短 PIN 能在公网用，全靠它。 */
  throttle: LoginThrottle;
  hub: RealtimeHub;
  poller?: Poller;
  /**
   * 新建 surface 时猜工作目录（从同 pane 已有进程反查）。
   * 默认走 lsof；--demo 和测试里换成不查真实进程的实现。
   */
  paneCwd?: (pane: CmuxPane) => Promise<string | null>;
  now: () => number;
}

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFIRM_REQUIRED"
  | "LAST_SURFACE"
  | "LAST_PANE"
  | "TOPOLOGY_CHANGED"
  | "TOO_MANY_ATTEMPTS"
  | "CMUX_UNAVAILABLE"
  | "INPUT_TEXT_WRITTEN_SUBMIT_UNKNOWN"
  | "INPUT_DELIVERY_UNKNOWN"
  | "INTERNAL";

export function apiError(code: ApiErrorCode, message: string) {
  return { error: { code, message } } as const;
}
