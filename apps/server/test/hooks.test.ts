import { describe, expect, it } from "vitest";
import { AgentEventSchema } from "@car/protocol";
import { claudeAdapter, codexAdapter, grokAdapter, normalizeHook } from "../src/hooks/index.ts";
import { classifyNotification, HookEnvelopeSchema } from "../src/hooks/types.ts";

const NOW = 1_700_000_000_000;

function envelope(event: string, payload: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return HookEnvelopeSchema.parse({
    event,
    payload,
    context: { surfaceId: "SURF-11", workspaceId: "WS-WORLD", pid: 5201, timestamp: NOW, ...context },
  });
}

describe("Hook Envelope", () => {
  it("容忍缺省字段与字符串数字", () => {
    const parsed = HookEnvelopeSchema.parse({ event: "Stop", context: { pid: "1234", timestamp: "17" } });
    expect(parsed.payload).toEqual({});
    expect(parsed.context.pid).toBe(1234);
    expect(parsed.context.timestamp).toBe(17);
  });

  it("拒绝没有事件名的请求", () => {
    expect(HookEnvelopeSchema.safeParse({ payload: {} }).success).toBe(false);
  });
});

describe("Claude Code Adapter", () => {
  it("UserPromptSubmit → turn_started", () => {
    const event = claudeAdapter.normalize(envelope("UserPromptSubmit", { session_id: "sess-1" }), NOW);
    expect(event).toMatchObject({ event: "turn_started", agent: "claude", sessionId: "sess-1" });
    expect(AgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("PreToolUse → activity，并带上工具信息", () => {
    const event = claudeAdapter.normalize(
      envelope("PreToolUse", { tool_name: "Bash", tool_input: { command: "pnpm test" } }),
      NOW,
    );
    expect(event).toMatchObject({ event: "activity", activity: "Bash: pnpm test" });
  });

  it("权限类 Notification → needs_approval", () => {
    const event = claudeAdapter.normalize(
      envelope("Notification", { message: "Claude needs your permission to use Bash" }),
      NOW,
    );
    expect(event?.event).toBe("needs_approval");
  });

  it("等待输入类 Notification → needs_input", () => {
    const event = claudeAdapter.normalize(
      envelope("Notification", { message: "Claude is waiting for your input" }),
      NOW,
    );
    expect(event?.event).toBe("needs_input");
  });

  it("Stop → turn_finished，SessionEnd → session_ended", () => {
    expect(claudeAdapter.normalize(envelope("Stop"), NOW)?.event).toBe("turn_finished");
    expect(claudeAdapter.normalize(envelope("SessionEnd"), NOW)?.event).toBe("session_ended");
  });

  it("不认识的事件返回 null，不影响主链路", () => {
    expect(claudeAdapter.normalize(envelope("SomethingNew"), NOW)).toBeNull();
  });
});

describe("Codex Adapter", () => {
  it("PermissionRequest → needs_approval", () => {
    const event = codexAdapter.normalize(
      envelope("PermissionRequest", { tool_name: "shell", tool_input: { command: "rm -rf build" } }),
      NOW,
    );
    expect(event).toMatchObject({ event: "needs_approval", agent: "codex" });
    expect(event?.activity).toContain("rm -rf build");
  });

  it("已经自动批准的 PermissionRequest 不打扰用户", () => {
    const event = codexAdapter.normalize(
      envelope("PermissionRequest", { tool_name: "shell", decision: "allow" }),
      NOW,
    );
    expect(event?.event).toBe("activity");
  });

  it("SubagentStart / PostCompact 归一成 activity", () => {
    expect(codexAdapter.normalize(envelope("SubagentStart"), NOW)?.event).toBe("activity");
    expect(codexAdapter.normalize(envelope("PostCompact"), NOW)?.event).toBe("activity");
  });

  it("失败事件 → failure", () => {
    const event = codexAdapter.normalize(envelope("TurnFailure", { error: "API 502" }), NOW);
    expect(event).toMatchObject({ event: "failure", activity: "API 502" });
  });
});

describe("Grok Adapter", () => {
  it("需要批准的 PreToolUse → needs_approval", () => {
    const event = grokAdapter.normalize(
      envelope("PreToolUse", { tool_name: "bash", requires_approval: true }),
      NOW,
    );
    expect(event?.event).toBe("needs_approval");
  });

  it("always-approve 模式下的 PreToolUse 只是 activity", () => {
    const event = grokAdapter.normalize(
      envelope("PreToolUse", { tool_name: "bash", approval_mode: "always-approve" }),
      NOW,
    );
    expect(event?.event).toBe("activity");
  });

  it("Notification 里的完成消息作为活动文案保留", () => {
    const event = grokAdapter.normalize(envelope("Notification", { message: "测试全部通过" }), NOW);
    expect(event).toMatchObject({ event: "activity", activity: "测试全部通过" });
  });

  it("Stop → turn_finished", () => {
    expect(grokAdapter.normalize(envelope("Stop"), NOW)?.event).toBe("turn_finished");
  });
});

describe("三家统一入口", () => {
  it("同一个语义在三家都归一成同一个事件", () => {
    const events = [
      normalizeHook("claude", envelope("Notification", { message: "needs your permission to use Bash" }), NOW),
      normalizeHook("codex", envelope("PermissionRequest", { tool_name: "shell" }), NOW),
      normalizeHook("grok", envelope("PreToolUse", { tool_name: "bash", requires_approval: true }), NOW),
    ];
    expect(events.map((e) => e?.event)).toEqual(["needs_approval", "needs_approval", "needs_approval"]);
    expect(events.map((e) => e?.agent)).toEqual(["claude", "codex", "grok"]);
  });

  it("事件名大小写 / 下划线不敏感", () => {
    expect(normalizeHook("claude", envelope("session_start"), NOW)?.event).toBe("session_started");
    expect(normalizeHook("codex", envelope("USER-PROMPT-SUBMIT"), NOW)?.event).toBe("turn_started");
  });

  it("context 里的 surfaceId / workspaceId 会带进统一事件", () => {
    const event = normalizeHook("claude", envelope("Stop"), NOW);
    expect(event).toMatchObject({ surfaceId: "SURF-11", workspaceId: "WS-WORLD", pid: 5201, timestamp: NOW });
  });
});

describe("通知文案分类", () => {
  it.each([
    ["Claude needs your permission to use Bash", "needs_approval"],
    ["是否允许执行 rm？", "needs_approval"],
    ["Waiting for your input", "needs_input"],
    ["需要你的输入", "needs_input"],
    ["Build finished", "activity"],
    [undefined, "activity"],
  ])("%s → %s", (message, expected) => {
    expect(classifyNotification(message as string | undefined)).toBe(expected);
  });
});
