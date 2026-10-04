import type { AgentState, AgentStatus } from "@car/protocol";

/**
 * 时间 / 进程维度的状态修正。
 * 这里只做「提示」，不自动认为 Agent 已卡死。
 */

export interface StaleConfig {
  /** 标记为 WORKING 但这么久没有任何活动 → POSSIBLY_STALE。默认 10 分钟。 */
  staleAfterMs: number;
  /**
   * 没有 hook 的 Agent：输出静止这么久就认为一个回合结束。
   * 有 hook 时以 hook 为准，不走这条。
   */
  inferredIdleAfterMs: number;
}

export const DEFAULT_STALE_CONFIG: StaleConfig = {
  staleAfterMs: 10 * 60 * 1000,
  inferredIdleAfterMs: 15 * 1000,
};

/** WORKING 超时 → POSSIBLY_STALE；恢复活动后由调用方改回 WORKING。 */
export function applyStaleRule(state: AgentState, now: number, config: StaleConfig): AgentStatus {
  if (state.status !== "WORKING") return state.status;
  if (now - state.lastActivityAt >= config.staleAfterMs) return "POSSIBLY_STALE";
  return state.status;
}

/** POSSIBLY_STALE 时展示的说明文案：No activity for 12m。 */
export function staleReason(state: AgentState, now: number): string | undefined {
  if (state.status !== "POSSIBLY_STALE") return undefined;
  const minutes = Math.floor((now - state.lastActivityAt) / 60_000);
  return `No activity for ${minutes}m`;
}

/**
 * 没有 hook 上报的 Agent：只能靠输出变化推断。
 * - 输出在动 → WORKING
 * - 输出静止超过阈值 → 上一轮如果在 WORKING，认为回合结束（未读）；否则 IDLE
 */
export function inferStatusFromOutput(
  current: AgentStatus,
  outputChanged: boolean,
  lastOutputChangeAt: number | undefined,
  now: number,
  config: StaleConfig,
): AgentStatus {
  if (outputChanged) return "WORKING";
  if (lastOutputChangeAt === undefined) return current;
  const quietFor = now - lastOutputChangeAt;
  if (quietFor < config.inferredIdleAfterMs) return current;
  if (current === "WORKING") return "RESPONDED_UNREAD";
  return current === "POSSIBLY_STALE" ? "IDLE" : current;
}
