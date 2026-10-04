import type { ScrollAction } from "@car/protocol";

/** 翻页后视线落在新一屏的哪一头。 */
export type ScrollAlign = "top" | "bottom";

/**
 * 翻完停在哪儿 —— 两个方向是反的，接缝不在同一头。
 *
 * `pageup` 换来的是更早的一屏，它的**底部**才接着你刚看到的第一行；
 * `pagedown` 换来的是更新的一屏，它的**顶部**才接着你刚看到的最后一行。
 * 一律贴底的话，往下翻会直接落到那一屏的末尾，中间整屏都被跳过。
 */
export function alignAfterScroll(action: ScrollAction): ScrollAlign {
  return action === "pagedown" ? "top" : "bottom";
}

