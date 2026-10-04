import { describe, expect, it, vi } from "vitest";
import { CmuxCliClient } from "../src/cmux/cli-client.ts";
import { CmuxError } from "../src/cmux/client.ts";
import {
  assertPaneTarget,
  assertSurfaceTarget,
  buildCloseSurfaceArgs,
  buildNewSurfaceArgs,
  buildRenameTabArgs,
  buildRenameWorkspaceArgs,
  buildKeyDeliveryArgs,
  buildSendKeyArgs,
  buildSendTextArgs,
  buildPasteTextArgs,
  buildTerminalInputArgs,
} from "../src/cmux/control.ts";
import type { CommandRunner } from "../src/cmux/exec.ts";
import { RAW_READ_SCREEN, RAW_TOP, RAW_TREE } from "./fixtures.ts";

function makeRunner(overrides: Partial<Record<string, string>> = {}) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (args) => {
    calls.push(args);
    const command = args[0] ?? "";
    if (overrides[command] !== undefined) {
      return { stdout: overrides[command] as string, stderr: "", code: 0 };
    }
    switch (command) {
      case "ping":
        return { stdout: "PONG\n", stderr: "", code: 0 };
      case "tree":
        return { stdout: JSON.stringify(RAW_TREE), stderr: "", code: 0 };
      case "top":
        return { stdout: JSON.stringify(RAW_TOP), stderr: "", code: 0 };
      case "read-screen":
        return { stdout: JSON.stringify(RAW_READ_SCREEN), stderr: "", code: 0 };
      default:
        return { stdout: "", stderr: "", code: 0 };
    }
  };
  return { runner, calls };
}

describe("CmuxCliClient", () => {
  it("ping 能识别 PONG", async () => {
    const { runner } = makeRunner();
    expect(await new CmuxCliClient({ runner }).ping()).toBe(true);
  });

  it("getTree 合并 tree + top，并缓存结果避免打爆 CLI", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner, treeTtlMs: 10_000 });

    const tree = await client.getTree();
    expect(tree.workspaces).toHaveLength(2);

    await client.getTree();
    // 两次 getTree 只应该真正执行一轮 tree + top
    expect(calls.filter((c) => c[0] === "tree")).toHaveLength(1);
    expect(calls.filter((c) => c[0] === "top")).toHaveLength(1);

    client.invalidateTree();
    await client.getTree();
    expect(calls.filter((c) => c[0] === "tree")).toHaveLength(2);
  });

  it("并发 getTree 合并成一次执行（single-flight）", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner, treeTtlMs: 0 });
    await Promise.all([client.getTree(), client.getTree(), client.getTree()]);
    expect(calls.filter((c) => c[0] === "tree")).toHaveLength(1);
  });

  it("tree 命令失败时抛 CmuxError", async () => {
    const runner: CommandRunner = async (args) =>
      args[0] === "tree"
        ? { stdout: "", stderr: "cmux: socket not found", code: 1 }
        : { stdout: "{}", stderr: "", code: 0 };
    await expect(new CmuxCliClient({ runner }).getTree()).rejects.toBeInstanceOf(CmuxError);
  });

  it("cmux 在 JSON 前打印提示行也能解析", async () => {
    const { runner } = makeRunner({
      tree: `cmux: 'tree' is now an alias...\n${JSON.stringify(RAW_TREE)}`,
    });
    const tree = await new CmuxCliClient({ runner }).getTree();
    expect(tree.workspaces).toHaveLength(2);
  });

  it("readSurface 用 base64 还原全屏内容并清洗 ANSI", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    const snapshot = await client.readSurface("SURF-11");

    expect(calls.at(-1)).toEqual(["read-screen", "--surface", "SURF-11", "--lines", "400", "--json"]);
    expect(snapshot.content).toContain("Running pnpm test...");
    expect(snapshot.content).toContain("14 tests passed");
    // ANSI 序列与行尾空格被清掉
    expect(snapshot.content).not.toMatch(/\[/);
    expect(snapshot.content).not.toMatch(/ \n/);
    // 连续空行被压缩
    expect(snapshot.content).not.toContain("\n\n\n");
    expect(snapshot.surfaceId).toBe("SURF-11");
  });

  it("内容不变时 revision 不变，变了才 +1", async () => {
    let text = "hello";
    const runner: CommandRunner = async (args) => {
      if (args[0] === "read-screen") {
        return { stdout: JSON.stringify({ surface_id: "S1", text }), stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const client = new CmuxCliClient({ runner });

    expect((await client.readSurface("S1")).revision).toBe(1);
    expect((await client.readSurface("S1")).revision).toBe(1);
    text = "hello world";
    expect((await client.readSurface("S1")).revision).toBe(2);
  });

  it("surface 不存在时给出 SURFACE_NOT_FOUND", async () => {
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "unknown surface: surface:99", code: 1 });
    const client = new CmuxCliClient({ runner });
    await expect(client.readSurface("surface:99")).rejects.toMatchObject({ code: "SURFACE_NOT_FOUND" });
  });

  it("rename-tab / rename-workspace 走参数数组，不经过 shell", async () => {
    expect(buildRenameTabArgs("SURF-11", "新名字", "WS-WORLD")).toEqual([
      "rename-tab",
      "--workspace",
      "WS-WORLD",
      "--surface",
      "SURF-11",
      "--title",
      "新名字",
    ]);
    expect(buildRenameWorkspaceArgs("ws-1", "评测")).toEqual([
      "rename-workspace",
      "--workspace",
      "ws-1",
      "--",
      "评测",
    ]);

    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    await client.renameSurface("SURF-11", "新名字");
    await client.renameWorkspace("ws-1", "评测");
    expect(calls.at(-2)).toEqual(["rename-tab", "--workspace", "WS-WORLD", "--surface", "SURF-11", "--title", "新名字"]);
    expect(calls.at(-1)).toEqual(["rename-workspace", "--workspace", "ws-1", "--", "评测"]);
  });

  it.each(["SURF-20", "surface:20"])("跨工作区重命名 %s 使用目标归属，不使用当前或调用方工作区", async (surfaceId) => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    await client.renameSurface(surfaceId, "评测新名称");
    expect(calls.at(-1)).toEqual([
      "rename-tab", "--workspace", "WS-EVAL", "--surface", surfaceId, "--title", "评测新名称",
    ]);
  });

  it("不存在的 surface 不执行改名", async () => {
    const { runner, calls } = makeRunner();
    await expect(new CmuxCliClient({ runner }).renameSurface("missing", "名称"))
      .rejects.toMatchObject({ code: "SURFACE_NOT_FOUND" });
    expect(calls.some((args) => args[0] === "rename-tab")).toBe(false);
  });

  it("查到 surface 后若标签页已关闭，将 cmux not_found 转成不存在错误", async () => {
    const { runner } = makeRunner();
    const client = new CmuxCliClient({ runner: async (args, options) => args[0] === "rename-tab"
      ? { stdout: "", stderr: "Error: not_found: 未找到标签页", code: 1 }
      : runner(args, options) });
    await expect(client.renameSurface("SURF-20", "名称")).rejects.toMatchObject({ code: "SURFACE_NOT_FOUND" });
  });

  it("sendText / sendKey 走参数数组，不经过 shell", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    await client.sendText("SURF-11", "继续修改；然后 $(rm -rf /) 重新运行测试");
    await client.sendKey("SURF-11", "enter");

    expect(calls.at(-2)).toEqual([
      "send",
      "--surface",
      "SURF-11",
      "--",
      "继续修改；然后 $(rm -rf /) 重新运行测试",
    ]);
    expect(calls.at(-1)).toEqual(["send-key", "--surface", "SURF-11", "--", "enter"]);
  });

  it("Ctrl 组合键通过 terminal.input 写入控制字节，不走 send-key", async () => {
    expect(buildKeyDeliveryArgs("SURF-11", "enter")).toEqual([
      "send-key",
      "--surface",
      "SURF-11",
      "--",
      "enter",
    ]);
    expect(buildTerminalInputArgs("SURF-11", "\x03")).toEqual([
      "rpc",
      "terminal.input",
      JSON.stringify({ terminal_id: "SURF-11", text: "\x03" }),
    ]);
    expect(buildTerminalInputArgs("SURF-PI", "\x10")).toEqual([
      "rpc",
      "terminal.input",
      JSON.stringify({ terminal_id: "SURF-PI", text: "\x10" }),
    ]);
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    await client.sendKey("SURF-11", "ctrl+c");
    await client.sendKey("SURF-PI", "ctrl+p");

    expect(calls.at(-2)).toEqual([
      "rpc",
      "terminal.input",
      JSON.stringify({ terminal_id: "SURF-11", text: "\x03" }),
    ]);
    expect(calls.at(-1)).toEqual([
      "rpc",
      "terminal.input",
      JSON.stringify({ terminal_id: "SURF-PI", text: "\x10" }),
    ]);
  });

  it("Option+↑ 发送原生组合键，不通过 terminal.input 注入会被拆成 Esc 的序列", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    await client.sendKey("SURF-CX", "alt+up");
    expect(calls).toEqual([["send-key", "--surface", "SURF-CX", "--", "alt+up"]]);
  });

  it("整段粘贴保留换行和字面转义，不自动提交", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    const text = "第一行\n第二行\r\n字面 \\n 和 \\t\t\"引号\" " + "长文本。".repeat(2000);
    await client.sendText("SURF-CX", text, { bracketedPaste: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["rpc", "terminal.paste"]);
    expect(JSON.parse(calls[0]![2]!)).toEqual({ terminal_id: "SURF-CX", text, submit_key: "none" });
  });

  it("翻页也是 send-key，但走独立入口", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    await client.scrollSurface("SURF-11", "pageup");
    expect(calls.at(-1)).toEqual(["send-key", "--surface", "SURF-11", "--", "pageup"]);
  });

  it("读历史带 --scrollback，且不动状态推断的基线", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    const before = (await client.readSurface("SURF-11")).revision;

    const text = await client.readHistory("SURF-11", 1500);
    expect(text.length).toBeGreaterThan(0);
    expect(calls.at(-1)).toEqual([
      "read-screen",
      "--surface",
      "SURF-11",
      "--lines",
      "1500",
      "--json",
      "--scrollback",
    ]);

    // 读历史如果进了 SnapshotTracker，这里的 revision 会被顶上去
    expect((await client.readSurface("SURF-11")).revision).toBe(before);
  });
});

describe("写操作必须显式指定 surface", () => {
  it("空 surface 直接拒绝", () => {
    expect(() => assertSurfaceTarget("")).toThrow();
    expect(() => assertSurfaceTarget(undefined)).toThrow();
    expect(() => buildSendTextArgs("", "hi")).toThrow();
    expect(() => buildPasteTextArgs("", "hi")).toThrow();
    expect(() => buildSendKeyArgs("   ", "enter")).toThrow();
  });

  it("以 - 开头的 prompt 不会被当成 flag", () => {
    expect(buildSendTextArgs("S1", "--help")).toEqual(["send", "--surface", "S1", "--", "--help"]);
    expect(buildPasteTextArgs("S1", "--help")).toEqual([
      "rpc", "terminal.paste", JSON.stringify({ terminal_id: "S1", text: "--help", submit_key: "none" }),
    ]);
  });
});

describe("新建 surface", () => {
  const NEW_SURFACE_JSON = JSON.stringify({
    pane_id: "PANE-UUID",
    pane_ref: "pane:27",
    surface_id: "SURFACE-UUID",
    surface_ref: "surface:275",
    type: "terminal",
    workspace_id: "WS-UUID",
    workspace_ref: "workspace:15",
  });

  /** args[0] 是全局选项，makeRunner 按不了子命令，这里自己认。 */
  function newSurfaceRunner(stdout = NEW_SURFACE_JSON) {
    const calls: string[][] = [];
    const runner: CommandRunner = async (args) => {
      calls.push(args);
      if (args.includes("new-surface")) return { stdout, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    return { runner, calls };
  }

  it("--id-format both 必须在子命令前面，否则拿不到 UUID", () => {
    expect(buildNewSurfaceArgs({ paneId: "P1", workspaceId: "W1", cwd: "/tmp/a b" })).toEqual([
      "--id-format",
      "both",
      "new-surface",
      "--json",
      "--type",
      "terminal",
      "--pane",
      "P1",
      "--focus",
      "false",
      "--workspace",
      "W1",
      "--working-directory",
      "/tmp/a b",
    ]);
  });

  it("必须显式指定 pane", () => {
    expect(() => assertPaneTarget("")).toThrow();
    expect(() => buildNewSurfaceArgs({ paneId: "   " })).toThrow();
  });

  it("返回 UUID，并发一次回车唤醒懒启动的 tab", async () => {
    const { runner, calls } = newSurfaceRunner();
    const client = new CmuxCliClient({ runner });

    const created = await client.createSurface({ paneId: "PANE-UUID", cwd: "/tmp" });
    expect(created).toEqual({
      surfaceId: "SURFACE-UUID",
      surfaceRef: "surface:275",
      paneId: "PANE-UUID",
      workspaceId: "WS-UUID",
    });
    // 不唤醒的话新 tab 没有 tty，会话页读画面会直接报错
    expect(calls).toContainEqual(["send-key", "--surface", "SURFACE-UUID", "--", "enter"]);
  });

  it("cmux 没给 UUID 就报错，不拿短引用凑数", async () => {
    const { runner } = newSurfaceRunner(JSON.stringify({ surface_ref: "surface:275" }));
    const client = new CmuxCliClient({ runner });
    await expect(client.createSurface({ paneId: "P1" })).rejects.toBeInstanceOf(CmuxError);
  });

  it("pane 不存在时给出 PANE_NOT_FOUND", async () => {
    const runner: CommandRunner = async () => ({
      stdout: "",
      stderr: "Error: invalid_params: Pane not found",
      code: 1,
    });
    const client = new CmuxCliClient({ runner });
    await expect(client.createSurface({ paneId: "pane:999" })).rejects.toMatchObject({
      code: "PANE_NOT_FOUND",
    });
  });
});

describe("关闭 surface", () => {
  it("必须显式指定 surface，并带上 workspace 上下文", () => {
    expect(() => buildCloseSurfaceArgs("")).toThrow();
    expect(buildCloseSurfaceArgs("SF-UUID", "WS-UUID")).toEqual([
      "close-surface",
      "--surface",
      "SF-UUID",
      "--workspace",
      "WS-UUID",
    ]);
  });

  it("成功后清掉快照缓存", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    await client.closeSurface("SF-UUID", "WS-UUID");
    expect(calls).toContainEqual(["close-surface", "--surface", "SF-UUID", "--workspace", "WS-UUID"]);
  });

  it("最后一个 surface 映射成 LAST_SURFACE", async () => {
    const runner: CommandRunner = async () => ({
      stdout: "",
      stderr: "Error: invalid_state: Cannot close the last surface",
      code: 1,
    });
    const client = new CmuxCliClient({ runner });
    await expect(client.closeSurface("SF-UUID")).rejects.toMatchObject({ code: "LAST_SURFACE" });
  });
});

describe("超时与异常", () => {
  it("runner 抛异常时向上冒泡，不会静默成功", async () => {
    const runner = vi.fn(async () => {
      throw new Error("boom");
    });
    const client = new CmuxCliClient({ runner: runner as unknown as CommandRunner });
    await expect(client.getTree()).rejects.toThrow("boom");
  });
});

describe("创建拓扑", () => {
  it("workspace 走结构化 RPC，分屏显式指定来源，且只唤醒新终端", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async args => {
      calls.push(args);
      return { code: 0, stderr: "", stdout: JSON.stringify({
        workspace_id: "new-workspace", surface_id: "new-surface", pane_id: "new-pane",
      }) };
    };
    const client = new CmuxCliClient({ runner });
    expect(await client.createWorkspace("window:1")).toMatchObject({ workspaceId: "new-workspace" });
    expect(JSON.parse(calls[0]![2]!)).toEqual({ window_id: "window:1", focus: false });
    await client.createPane("target-workspace", "source-surface");
    expect(calls[2]).toEqual(["--id-format", "both", "new-split", "right", "--workspace",
      "target-workspace", "--surface", "source-surface", "--focus", "false", "--json"]);
    expect(calls[1]).toEqual(["send-key", "--surface", "new-surface", "--", "enter"]);
    expect(calls[3]).toEqual(calls[1]);
    await expect(client.createPane("", "source")).rejects.toThrow();
    await expect(client.createPane("target", "")).rejects.toThrow();
  });

  it("cmux 创建失败时向上报告", async () => {
    const client = new CmuxCliClient({ runner: async () => ({ code: 1, stderr: "split limit", stdout: "" }) });
    await expect(client.createPane("workspace", "surface")).rejects.toThrow("split limit");
  });
});

describe("关闭 workspace CLI", () => {
  it("必须明确目标，并调用整体关闭命令", async () => {
    const { runner, calls } = makeRunner();
    const client = new CmuxCliClient({ runner });
    await expect(client.closeWorkspace("")).rejects.toThrow();
    await client.closeWorkspace("WS-WORLD");
    expect(calls).toContainEqual(["close-workspace", "--workspace", "WS-WORLD"]);
  });
});
