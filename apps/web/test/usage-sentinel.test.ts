import type { CmuxWorkspace } from "@car/protocol";
import { describe, expect, it } from "vitest";
import { isUsageSentinel } from "../src/features/workspace/usage-sentinel.ts";

const workspace = (title: string, description?: string): CmuxWorkspace => ({
  id: "w", ref: "workspace:1", index: 0, title, description, selected: false, panes: [],
});

describe("用量表（hidden sentinel）判定", () => {
  it("认出各 provider 的用量表，含还没轮询过的裸 label", () => {
    for (const title of [
      "cx5h", "cx7d |30% (5d 1h)|████▏░░░░░░░░░", "grokcredits |88% (1d 1h)|",
      "go5h |6% (0h 49m)|", "go7d |10% (2d 19h)|", "go1m |5% (28d 15h)|",
      "5h |39% (4h 35m)|█████░░░░░░░░░", "7d", "spend |none|",
    ]) {
      expect(isUsageSentinel(workspace(title)), title).toBe(true);
    }
  });

  it("label 被改名后靠 sentinel-updated 戳兜底", () => {
    expect(isUsageSentinel(workspace("我的额度", "sentinel-updated:1790309114\n留空"))).toBe(true);
  });

  it("不误伤真实 workspace，也不认 tmux 侧栏的 carrier 标记", () => {
    expect(isUsageSentinel(workspace("grokcredits-cli"))).toBe(false);
    expect(isUsageSentinel(workspace("7days-retro"))).toBe(false);
    expect(isUsageSentinel(workspace("Agent-Remote", 'sentinel-tmux:{"layout":{}}'))).toBe(false);
    expect(isUsageSentinel(workspace("Agent-Remote"))).toBe(false);
  });
});
