import type { AgentKind } from "@car/protocol";

export type DiagnosticSource = "topology" | "surface.grid" | "surface.text" | "api" | "audit.cleanup";

const SUMMARIES: Record<DiagnosticSource, string> = {
  topology: "拓扑刷新失败",
  "surface.grid": "终端网格读取失败",
  "surface.text": "终端文本读取失败",
  api: "API 未处理异常",
  "audit.cleanup": "审计日志清理失败",
};
const SAFE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "SQLITE_BUSY", "SQLITE_FULL", "SQLITE_READONLY", "SQLITE_IOERR", "CMUX_UNAVAILABLE"]);

/** 仅保留本次进程的诊断元数据，不保留异常原文、命令、路径或 Hook payload。 */
export class RuntimeDiagnostics {
  readonly startedAt: number;
  private hook = {
    lastReceivedAt: null as number | null,
    lastAppliedAt: null as number | null,
    lastAgent: null as AgentKind | null,
    lastOutcome: null as "applied" | "ignored" | "unresolved" | null,
  };
  private errors: Array<{ at: number; source: DiagnosticSource; code: string; message: string }> = [];

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  hookReceived(agent: AgentKind): void {
    this.hook.lastReceivedAt = this.now();
    this.hook.lastAgent = agent;
    this.hook.lastOutcome = null;
  }

  hookFinished(outcome: "applied" | "ignored" | "unresolved"): void {
    this.hook.lastOutcome = outcome;
    if (outcome === "applied") this.hook.lastAppliedAt = this.now();
  }

  recordError(source: DiagnosticSource, error: unknown): void {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    this.errors.unshift({ at: this.now(), source,
      code: typeof code === "string" && SAFE_CODES.has(code) ? code : "UNKNOWN",
      message: SUMMARIES[source] });
    this.errors.length = Math.min(this.errors.length, 20);
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, this.now() - this.startedAt),
      hooks: { ...this.hook },
      recentErrors: this.errors.map(error => ({ ...error })),
    };
  }
}
