/**
 * 纯文本输出清洗：用于后台活动推断与早期历史显示。
 * 会话主画面独立使用 cmux 渲染网格，不经过这里丢弃颜色。
 */

const ESC = "\u001b";
const BEL = "\u0007";

// OSC ... BEL 或 OSC ... ST（必须先于 CSI 处理）
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
// CSI / SGR / 私有模式等
const ANSI_CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
// 单字符转义（ESC( / ESC) / ESC= 等）
const ANSI_SIMPLE = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");
// 其余控制字符（保留 \n \t）
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// 纯装饰性的框线行
const BOX_DRAWING_ONLY = /^[\s─-╿▀-▟■-◿]+$/u;

export function stripAnsi(input: string): string {
  return input
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_SIMPLE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_CHARS, "");
}

/** 去掉行尾空白，并把连续 3 行以上空行压成 2 行。 */
export function tidyTerminalText(input: string): string {
  const cleaned = stripAnsi(input)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  return cleaned.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

/** 只保留最后 n 行，避免手机端渲染过长内容。 */
export function lastLines(input: string, n: number): string {
  if (n <= 0) return "";
  const lines = input.split("\n");
  if (lines.length <= n) return input;
  return lines.slice(lines.length - n).join("\n");
}

/**
 * 内容指纹：用于判断 surface 输出是否变化。
 * 内容没变化时不推送给浏览器。
 */
export function fingerprint(input: string): string {
  // FNV-1a 32bit，够用且无依赖。
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${input.length.toString(36)}-${hash.toString(36)}`;
}

/** 从终端尾部提取一句可读摘要，用于 Inbox 的活动文案兜底。 */
export function summarizeTail(input: string, maxLen = 80): string {
  const lines = tidyTerminalText(input)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !BOX_DRAWING_ONLY.test(l));
  const last = lines[lines.length - 1] ?? "";
  return last.length > maxLen ? `${last.slice(0, maxLen - 1)}…` : last;
}
