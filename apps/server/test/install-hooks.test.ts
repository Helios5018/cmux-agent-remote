import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOOK_MARKER,
  HOOK_TARGETS,
  installHooks,
  mergeHooks,
  removeHooks,
  uninstallHooks,
} from "../../../scripts/hooks-config.ts";

const homes: string[] = [];

function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), "car-home-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

const SCRIPT = "/opt/cmux-agent-remote/scripts/cmux-agent-web-hook";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Hook 安装（三家 Agent）", () => {
  it("为 claude / codex / grok 各写一份配置", () => {
    const home = sandboxHome();
    const results = installHooks({ home, scriptPath: SCRIPT, force: true, timestamp: "T" });

    expect(results.map((r) => r.agent)).toEqual(["claude", "codex", "grok"]);
    expect(results.every((r) => r.action === "installed")).toBe(true);

    expect(existsSync(join(home, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(home, ".codex/hooks.json"))).toBe(true);
    expect(existsSync(join(home, ".grok/hooks/cmux-agent-remote.json"))).toBe(true);
  });

  it("每个事件都指向同一个 cmux-agent-web-hook，并带 agent 与事件名", () => {
    const home = sandboxHome();
    installHooks({ home, scriptPath: SCRIPT, force: true });

    const claude = readJson(join(home, ".claude/settings.json"));
    const hooks = claude["hooks"] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(Object.keys(hooks).sort()).toEqual([
      "Notification",
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(hooks["Stop"]?.[0]?.hooks[0]?.command).toBe(`${SCRIPT} claude Stop`);
    expect(hooks["PreToolUse"]?.[0]).toMatchObject({ matcher: "*" });

    const codex = readJson(join(home, ".codex/hooks.json"));
    const codexHooks = codex["hooks"] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(codexHooks["PermissionRequest"]?.[0]?.hooks[0]?.command).toBe(`${SCRIPT} codex PermissionRequest`);
  });

  it("保留用户 / cmux 已有的 hook，不覆盖", () => {
    const home = sandboxHome();
    mkdirSync(join(home, ".grok/hooks"), { recursive: true });
    const cmuxHooks = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/Applications/cmux.app/... hooks grok stop", timeout: 5 }] }],
      },
    };
    writeFileSync(join(home, ".grok/hooks/cmux-session.json"), JSON.stringify(cmuxHooks));

    // 我们写的是独立文件，cmux 自己那份完全不动
    installHooks({ home, scriptPath: SCRIPT, force: true, only: ["grok"] });
    expect(readJson(join(home, ".grok/hooks/cmux-session.json"))).toEqual(cmuxHooks);
  });

  it("同一个文件里已有用户 hook 时做合并", () => {
    const existing = {
      model: "opus",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "my-own-notify.sh" }] }],
      },
    };
    const target = HOOK_TARGETS.find((t) => t.agent === "claude")!;
    const merged = mergeHooks(existing, target, SCRIPT) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    expect(merged.model).toBe("opus");
    expect(merged.hooks["Stop"]).toHaveLength(2);
    expect(merged.hooks["Stop"]?.[0]?.hooks[0]?.command).toBe("my-own-notify.sh");
    expect(merged.hooks["Stop"]?.[1]?.hooks[0]?.command).toContain(HOOK_MARKER);
  });

  it("重复安装不会堆积重复条目", () => {
    const home = sandboxHome();
    installHooks({ home, scriptPath: SCRIPT, force: true, only: ["codex"] });
    installHooks({ home, scriptPath: SCRIPT, force: true, only: ["codex"] });

    const codex = readJson(join(home, ".codex/hooks.json"));
    const hooks = codex["hooks"] as Record<string, unknown[]>;
    expect(hooks["Stop"]).toHaveLength(1);
  });

  it("写入前会生成时间戳备份", () => {
    const home = sandboxHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/hooks.json"), JSON.stringify({ hooks: {} }));

    const results = installHooks({ home, scriptPath: SCRIPT, force: true, only: ["codex"], timestamp: "STAMP" });
    expect(results[0]?.backup).toBe(join(home, ".codex/hooks.json.STAMP.bak"));
    expect(existsSync(join(home, ".codex/hooks.json.STAMP.bak"))).toBe(true);
  });

  it("没装对应 CLI 时跳过", () => {
    const home = sandboxHome();
    const results = installHooks({
      home,
      scriptPath: SCRIPT,
      hasBinary: (binary) => binary === "claude",
    });
    expect(results.find((r) => r.agent === "claude")?.action).toBe("installed");
    expect(results.find((r) => r.agent === "codex")?.action).toBe("skipped");
    expect(existsSync(join(home, ".codex/hooks.json"))).toBe(false);
  });

  it("dry-run 不写任何文件", () => {
    const home = sandboxHome();
    installHooks({ home, scriptPath: SCRIPT, force: true, dryRun: true });
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
  });
});

describe("Hook 卸载", () => {
  it("只删自己的，保留别人的", () => {
    const home = sandboxHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude/settings.json"),
      JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-notify.sh" }] }] },
      }),
    );

    installHooks({ home, scriptPath: SCRIPT, force: true, only: ["claude"] });
    uninstallHooks({ home, scriptPath: SCRIPT, only: ["claude"] });

    const after = readJson(join(home, ".claude/settings.json")) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(after.model).toBe("opus");
    expect(after.hooks["Stop"]).toHaveLength(1);
    expect(after.hooks["Stop"]?.[0]?.hooks[0]?.command).toBe("my-own-notify.sh");
    expect(JSON.stringify(after)).not.toContain(HOOK_MARKER);
  });

  it("我们是唯一 hook 时，hooks 字段被清掉但其它配置保留", () => {
    const cleaned = removeHooks({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: `${SCRIPT} claude Stop` }] }] },
    });
    expect(cleaned).toEqual({ model: "opus" });
  });

  it("配置文件不存在时安静跳过", () => {
    const home = sandboxHome();
    const results = uninstallHooks({ home, scriptPath: SCRIPT });
    expect(results.every((r) => r.action === "skipped")).toBe(true);
  });

  it("卸载后再卸载是幂等的", () => {
    const home = sandboxHome();
    installHooks({ home, scriptPath: SCRIPT, force: true, only: ["grok"] });
    expect(uninstallHooks({ home, scriptPath: SCRIPT, only: ["grok"] })[0]?.action).toBe("removed");
    expect(uninstallHooks({ home, scriptPath: SCRIPT, only: ["grok"] })[0]?.action).toBe("unchanged");
  });
});
