import type { CmuxPane, CmuxSurface, CmuxWorkspace, AttentionGroup } from "@car/protocol";

export interface VisiblePane {
  pane: CmuxPane;
  key: string;
  surfaces: CmuxSurface[];
}

export interface VisibleWorkspace {
  workspace: CmuxWorkspace;
  panes: VisiblePane[];
  counts: Record<AttentionGroup, number>;
  /** 被「只看 Agent」藏起来的 surface 数量。 */
  hidden: number;
}

