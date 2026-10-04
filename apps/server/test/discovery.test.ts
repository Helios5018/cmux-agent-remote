import { describe, expect, it } from "vitest";
import { agentSurfaces, detectAgentInSurface, flattenSurfaces, parseTopJson, parseTree } from "../src/cmux/discovery.ts";
import { RAW_TOP, RAW_TREE } from "./fixtures.ts";

const NOW = 1_700_000_000_000;

describe("cmux Agent Process Discovery", () => {
  const processMap = parseTopJson(RAW_TOP);
  const tree = parseTree(RAW_TREE, processMap, NOW);

  it("解析出全部 workspace / pane / surface", () => {
    expect(tree.workspaces).toHaveLength(2);
    expect(tree.workspaces[0]?.title).toBe("世界模型 Demo");
    expect(tree.workspaces[0]?.panes).toHaveLength(2);
    expect(flattenSurfaces(tree)).toHaveLength(4);
  });

  it("surface 主键用 UUID，短 ref 只用于展示", () => {
    const surface = flattenSurfaces(tree).find((s) => s.ref === "surface:11");
    expect(surface?.id).toBe("SURF-11");
    expect(surface?.workspaceId).toBe("WS-WORLD");
    expect(surface?.paneRef).toBe("pane:7");
  });

  it("按进程名识别 Agent", () => {
    const surface = flattenSurfaces(tree).find((s) => s.id === "SURF-10");
    expect(surface?.agent).toBe("codex");
    // 取层级最浅的 agent 进程，而不是它 fork 出来的 node
    expect(surface?.agentPid).toBe(5101);
  });

  it("进程名被改写成版本号时，靠 cmux 的 coding_agents pid 列表识别", () => {
    const surface = flattenSurfaces(tree).find((s) => s.id === "SURF-11");
    expect(surface?.agent).toBe("codex");
    expect(surface?.agentPid).toBe(5201);

    const claude = flattenSurfaces(tree).find((s) => s.id === "SURF-20");
    expect(claude?.agent).toBe("claude");
    expect(claude?.agentPid).toBe(7001);
  });

  it("识别 cmux 原生分类和进程名里的 Pi", () => {
    const native = parseTopJson({
      coding_agents: [{ id: "pi", resources: { pids: [9001] } }],
    });
    expect(native.pidToAgent.get(9001)).toBe("pi");

    const fallback = detectAgentInSurface(
      {
        surfaceRef: "surface:pi",
        processes: [{ pid: 9002, name: "pi", path: "/opt/homebrew/bin/pi", children: [] }],
      },
      new Map(),
    );
    expect(fallback).toEqual({ kind: "pi", pid: 9002 });
  });

  it("纯 shell 的 surface 不算 Agent", () => {
    const shell = flattenSurfaces(tree).find((s) => s.id === "SURF-12");
    expect(shell?.agent).toBeNull();
    expect(agentSurfaces(tree).map((s) => s.id)).toEqual(["SURF-10", "SURF-11", "SURF-20"]);
  });

  it("建立 pid → surface 反查表，供 Hook 关联使用", () => {
    // 子进程也要能反查到（hook 脚本上报的是自己的 $PPID）
    expect(tree.pidIndex["5102"]).toBe("SURF-10");
    expect(tree.pidIndex["7002"]).toBe("SURF-20");
    expect(tree.pidIndex["4300"]).toBe("SURF-12");
  });

  it("top 拿不到时不崩，只是识别不出 Agent", () => {
    const emptyMap = parseTopJson({});
    const degraded = parseTree(RAW_TREE, emptyMap, NOW);
    expect(flattenSurfaces(degraded)).toHaveLength(4);
    expect(agentSurfaces(degraded)).toHaveLength(0);
  });
});
