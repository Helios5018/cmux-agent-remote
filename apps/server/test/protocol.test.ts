import { describe, expect, it } from "vitest";
import {
  AgentEventSchema,
  AGENT_DISPLAY_NAME,
  AGENT_KINDS,
  ALLOWED_KEYS,
  ATTENTION_PRIORITY,
  attentionGroupOf,
  DANGEROUS_KEY_HINT,
  DANGEROUS_KEYS,
  isDangerousKey,
  normalizeKey,
  SurfaceInputRequestSchema,
  SurfaceKeyRequestSchema,
  type AgentStatus,
} from "@car/protocol";
import { fingerprint, formatAgo, formatDuration, lastLines, stripAnsi, tidyTerminalText } from "@car/shared";

describe("统一状态模型", () => {
  it("Attention 优先级顺序与文档一致", () => {
    const ordered = (Object.keys(ATTENTION_PRIORITY) as AgentStatus[]).sort(
      (a, b) => ATTENTION_PRIORITY[a] - ATTENTION_PRIORITY[b],
    );
    expect(ordered).toEqual([
      "ERROR",
      "NEEDS_APPROVAL",
      "NEEDS_INPUT",
      "RESPONDED_UNREAD",
      "POSSIBLY_STALE",
      "WORKING",
      "IDLE",
      "CLOSED",
    ]);
  });

  it("状态分组：NEEDS YOU / WORKING / IDLE", () => {
    expect(attentionGroupOf("NEEDS_APPROVAL")).toBe("NEEDS_YOU");
    expect(attentionGroupOf("RESPONDED_UNREAD")).toBe("NEEDS_YOU");
    expect(attentionGroupOf("ERROR")).toBe("NEEDS_YOU");
    expect(attentionGroupOf("WORKING")).toBe("WORKING");
    expect(attentionGroupOf("POSSIBLY_STALE")).toBe("WORKING");
    expect(attentionGroupOf("IDLE")).toBe("IDLE");
    expect(attentionGroupOf("CLOSED")).toBe("IDLE");
  });
});

describe("统一事件", () => {
  it("支持四种 Agent，包括 Pi", () => {
    expect([...AGENT_KINDS]).toEqual(["claude", "codex", "grok", "pi"]);
    expect(AGENT_DISPLAY_NAME.pi).toBe("Pi");
  });

  it("接受完整事件", () => {
    const parsed = AgentEventSchema.safeParse({
      version: 1,
      agent: "codex",
      event: "needs_approval",
      timestamp: 1,
      surfaceId: "SURF-1",
    });
    expect(parsed.success).toBe(true);
  });

  it("拒绝未知 agent 与未知事件", () => {
    expect(AgentEventSchema.safeParse({ version: 1, agent: "cursor", event: "activity", timestamp: 1 }).success).toBe(
      false,
    );
    expect(AgentEventSchema.safeParse({ version: 1, agent: "codex", event: "explode", timestamp: 1 }).success).toBe(
      false,
    );
  });
});

describe("按键白名单", () => {
  it("白名单里的键都是 cmux send-key 实际支持的", () => {
    expect([...ALLOWED_KEYS]).toEqual([
      "enter",
      "escape",
      "tab",
      "up",
      "down",
      "left",
      "right",
      "ctrl+c",
      "ctrl+p",
      "alt+up",
    ]);
  });

  it("Codex 专属的 Option+↑ 只在白名单里加这一个组合键", () => {
    expect(ALLOWED_KEYS.filter((key) => key.startsWith("alt+"))).toEqual(["alt+up"]);
    expect(SurfaceKeyRequestSchema.safeParse({ key: "alt+down" }).success).toBe(false);
  });

  it("Ctrl 组合键支持中断和 Pi 模型切换，但不提供会关闭 surface 的 Ctrl+D", () => {
    expect(ALLOWED_KEYS.filter((key) => key.startsWith("ctrl+"))).toEqual(["ctrl+c", "ctrl+p"]);
    expect(SurfaceKeyRequestSchema.safeParse({ key: "ctrl+d" }).success).toBe(false);
    expect(normalizeKey("Ctrl-D")).toBeNull();
  });

  it("常见别名能归一", () => {
    expect(normalizeKey("Esc")).toBe("escape");
    expect(normalizeKey("ArrowUp")).toBe("up");
    expect(normalizeKey("ArrowLeft")).toBe("left");
    expect(normalizeKey("ArrowRight")).toBe("right");
    expect(normalizeKey(" Ctrl-C ")).toBe("ctrl+c");
    expect(normalizeKey("Ctrl-P")).toBe("ctrl+p");
    expect(normalizeKey("ctrlp")).toBe("ctrl+p");
    expect(normalizeKey("Alt+Up")).toBe("alt+up");
    expect(normalizeKey("alt-up")).toBe("alt+up");
    expect(normalizeKey("F5")).toBeNull();
  });

  it("只有 Ctrl+C 需要二次确认", () => {
    expect(isDangerousKey("ctrl+c")).toBe(true);
    expect(isDangerousKey("ctrl+p")).toBe(false);
    expect(isDangerousKey("left")).toBe(false);
    expect(isDangerousKey("enter")).toBe(false);
  });

  it("危险键都有后果说明", () => {
    for (const key of DANGEROUS_KEYS) {
      expect(DANGEROUS_KEY_HINT[key]).toBeTruthy();
    }
  });

  it("请求体校验", () => {
    expect(SurfaceKeyRequestSchema.safeParse({ key: "enter" }).success).toBe(true);
    expect(SurfaceKeyRequestSchema.safeParse({ key: "ctrl+z" }).success).toBe(false);
    expect(SurfaceInputRequestSchema.parse({ text: "hi" }).submit).toBe(true);
    expect(SurfaceInputRequestSchema.safeParse({ text: "x".repeat(20001) }).success).toBe(false);
  });
});

describe("终端文本清洗", () => {
  it("去掉 ANSI 与控制字符", () => {
    const raw = "\u001b[31mRed\u001b[0m\u001b]0;title\u0007 text\r\nline2";
    expect(stripAnsi(raw)).toBe("Red text\nline2");
  });

  it("压缩空行、去掉行尾空格", () => {
    expect(tidyTerminalText("a   \n\n\n\n b \n\n")).toBe("a\n\n b");
  });

  it("只保留最后 n 行", () => {
    expect(lastLines("1\n2\n3\n4", 2)).toBe("3\n4");
    expect(lastLines("1\n2", 5)).toBe("1\n2");
  });

  it("指纹用于判断内容是否变化", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
  });
});

describe("时间展示", () => {
  it("formatAgo", () => {
    const now = 1_000_000;
    expect(formatAgo(now - 18_000, now)).toBe("18s ago");
    expect(formatAgo(now - 120_000, now)).toBe("2m ago");
    expect(formatAgo(now - 7_200_000, now)).toBe("2h ago");
  });

  it("formatDuration", () => {
    expect(formatDuration(32_000)).toBe("32s");
    expect(formatDuration(272_000)).toBe("4m 32s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
  });
});
