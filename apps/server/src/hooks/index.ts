import type { AgentEvent, AgentKind } from "@car/protocol";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";
import type { HookAdapter, HookEnvelope } from "./types.ts";

export * from "./types.ts";
export { claudeAdapter } from "./claude.ts";
export { codexAdapter } from "./codex.ts";
export { grokAdapter } from "./grok.ts";

export const HOOK_ADAPTERS: Partial<Record<AgentKind, HookAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
};

/**
 * Agent Hook Adapter 总入口：
 * 把已接入 Hook 的 Agent 事件翻译成统一语言。
 */
export function normalizeHook(agent: AgentKind, envelope: HookEnvelope, now: number): AgentEvent | null {
  const adapter = HOOK_ADAPTERS[agent];
  if (!adapter) return null;
  return adapter.normalize(envelope, now);
}
