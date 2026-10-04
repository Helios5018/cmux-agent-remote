import { buildInbox, type AgentState, type CmuxSurface, type CmuxTree, type CmuxWorkspace, type Inbox } from "@car/protocol";

export function patchAgent(inbox: Inbox | null, agent: AgentState): Inbox {
  const agents = (inbox?.groups.flatMap(group => group.agents) ?? []).filter(item => item.surfaceId !== agent.surfaceId);
  return buildInbox([...agents, agent], inbox?.generatedAt ?? agent.statusChangedAt);
}

/** 从 Inbox 里找一个 Agent。 */
export function findAgent(inbox: Inbox | null, surfaceId: string): AgentState | undefined {
  if (!inbox) return undefined;
  for (const group of inbox.groups) {
    const hit = group.agents.find((agent) => agent.surfaceId === surfaceId);
    if (hit) return hit;
  }
  return undefined;
}

/** surfaceId → { surface, workspace }，用于给没有 Agent 的 surface 也标出归属。 */
export function findSurface(
  tree: CmuxTree | null,
  surfaceId: string,
): { surface: CmuxSurface; workspace: CmuxWorkspace } | undefined {
  if (!tree) return undefined;
  for (const workspace of tree.workspaces) {
    for (const pane of workspace.panes) {
      const surface = pane.surfaces.find((item) => item.id === surfaceId);
      if (surface) return { surface, workspace };
    }
  }
  return undefined;
}

/** 把 Inbox 摊平成 surfaceId → AgentState，树视图逐行查状态用。 */
export function agentsBySurface(inbox: Inbox | null): Map<string, AgentState> {
  const map = new Map<string, AgentState>();
  for (const group of inbox?.groups ?? []) {
    for (const agent of group.agents) map.set(agent.surfaceId, agent);
  }
  return map;
}
