import type { CmuxWorkspace } from "@car/protocol";

/**
 * cmux-sentinel 的用量表（hidden sentinel）判定。
 *
 * 每个用量表都是一个真实 cmux workspace，身份挂在标题前缀上；cmux 自带侧栏
 * （~/.config/cmux/sidebars/workspaces.swift 的 isUsageMeter）会把它们从 workspace
 * 列表里摘出去、单独渲染成 USAGE 面板。远端只有 cmux 的原始拓扑，所以在 UI 这一侧
 * 用同样的规则过滤，免得这些表看着像普通 workspace。
 *
 * 两条判据互补：
 * 1. 标题前缀命中 label —— 刚建出来、还没轮询过的表只有这条成立；
 * 2. description 里的 `sentinel-updated:` 戳 —— 只有 sidebar_metadata.stamp() 按
 *    label 匹配之后才会写，所以 label 被改过（usage-sentinels.env 里可覆盖）也不会漏。
 *
 * 故意不看 `sentinel-tmux:`：cmux-sentinel 的 tmux 侧栏在没有 meter 可用时会把这条
 * 元数据写进第一个普通 workspace，只看它会误伤真实会话。
 */
const USAGE_SENTINEL_LABELS = [
  "5h", "7d", "m7d", "spend", // Claude
  "cx5h", "cx7d", // Codex
  "grokcredits", // Grok
  "go5h", "go7d", "go1m", // OpenCode Go
  "ampu", "ampo", // Amp
];

const UPDATED_MARKER = "sentinel-updated:";

export function isUsageSentinel(workspace: CmuxWorkspace): boolean {
  const title = workspace.title ?? "";
  if (USAGE_SENTINEL_LABELS.some((label) => title === label || title.startsWith(`${label} `))) return true;
  return (workspace.description ?? "").includes(UPDATED_MARKER);
}
