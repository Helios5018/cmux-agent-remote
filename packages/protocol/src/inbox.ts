import { ATTENTION_PRIORITY, attentionGroupOf, type AgentState, type AttentionGroup, type Inbox, type InboxSummary } from "./agent.ts";

/** 前后端共用的注意力分组与汇总。 */
export function buildInbox(states: readonly AgentState[], now: number): Inbox {
    const agents = [...states].sort(compareByAttention);

    const groups: Array<{ group: AttentionGroup; agents: AgentState[] }> = [
      { group: "NEEDS_YOU", agents: [] },
      { group: "WORKING", agents: [] },
      { group: "IDLE", agents: [] },
    ];
    for (const agent of agents) {
      const group = groups.find((g) => g.group === attentionGroupOf(agent.status));
      group?.agents.push(agent);
    }

    const summary: InboxSummary = {
      needsYou: agents.filter(
        (a) => a.status === "NEEDS_APPROVAL" || a.status === "NEEDS_INPUT" || a.status === "RESPONDED_UNREAD",
      ).length,
      working: agents.filter((a) => a.status === "WORKING" || a.status === "POSSIBLY_STALE").length,
      error: agents.filter((a) => a.status === "ERROR").length,
      idle: agents.filter((a) => a.status === "IDLE" || a.status === "CLOSED").length,
      total: agents.length,
    };

    return { summary, groups: groups.filter((g) => g.agents.length > 0), generatedAt: now };
}

/** ERROR → NEEDS_APPROVAL → NEEDS_INPUT → RESPONDED_UNREAD → POSSIBLY_STALE → WORKING → IDLE */
export function compareByAttention(a: AgentState, b: AgentState): number {
  const byStatus = ATTENTION_PRIORITY[a.status] - ATTENTION_PRIORITY[b.status];
  if (byStatus !== 0) return byStatus;
  // 同状态里，最近有动静的排前面。
  return b.lastActivityAt - a.lastActivityAt;
}
