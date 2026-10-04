import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * 滑到边界再继续滑 → 翻一屏。
 *
 * 为什么是「翻页」而不是跟手连续滚动：cmux 没有按行滚动的接口。
 * `terminal.replay` 对全屏 TUI 永远只给当前一屏，`terminal.scroll` / `terminal.mouse`
 * 是不校验参数、画面也不动的空壳，滚轮事件转发不过去 —— 能用的只有 pageup / pagedown。
 * 所以这里把整屏跳变包装成翻页手势：拖动时画面跟手位移，松手才真的翻，
 * 至少让「跳了一屏」这件事是用户自己按出来的，而不是画面莫名其妙闪一下。
 */

export type PageDirection = "up" | "down";

/** 滚轮累计多少像素算一次翻页（触控板一格 ~10px，鼠标滚轮一档 ~100px）。 */
export const WHEEL_THRESHOLD = 110;
/** 手指在边界继续拖多远算一次翻页。 */
export const DRAG_THRESHOLD = 64;
/** 跟手位移的上限，再拖也只是橡皮筋。 */
const MAX_DRAG = 96;
/** 两次翻页的最小间隔：一次翻页要一个来回，连发只会把 TUI 冲过头。 */
const MIN_INTERVAL_MS = 280;
/** 判定「已经到边」的容差，亚像素滚动位置不该算没到底。 */
const EDGE_SLACK = 2;

/** 跟手位移的阻尼：一开始跟手，越拖越沉。 */
export function dampDrag(distance: number): number {
  return Math.sign(distance) * Math.min(MAX_DRAG, Math.abs(distance) ** 0.82);
}

/**
 * 累计滚轮位移 → 这一下要不要翻页。
 *
 * 换方向立刻清零：否则「往上滚两下、再往下滚一下」会攒出一次莫名其妙的翻页。
 */
export function accumulateWheel(
  current: number,
  deltaY: number,
): { accum: number; page: PageDirection | null } {
  const sameWay = current === 0 || Math.sign(current) === Math.sign(deltaY);
  const accum = sameWay ? current + deltaY : deltaY;
  if (accum <= -WHEEL_THRESHOLD) return { accum: 0, page: "up" };
  if (accum >= WHEEL_THRESHOLD) return { accum: 0, page: "down" };
  return { accum, page: null };
}

function atTop(element: HTMLElement): boolean {
  return element.scrollTop <= EDGE_SLACK;
}

function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= EDGE_SLACK;
}

export interface PageGestureState {
  /** 当前跟手位移，px；0 表示没在拖。 */
  dragOffset: number;
  /** 已经拖过阈值、松手就会翻的方向。 */
  armed: PageDirection | null;
}

export function usePageGesture({
  scrollerRef,
  enabled,
  busy,
  onPage,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  /** 只对「一屏就是全部」的全屏 TUI 开；普通屏有真回滚，交给浏览器原生滚动。 */
  enabled: boolean;
  busy: boolean;
  onPage: (direction: PageDirection) => void;
}): PageGestureState {
  const [dragOffset, setDragOffset] = useState(0);
  const [armed, setArmed] = useState<PageDirection | null>(null);

  // 事件监听只绑一次，最新的 props 靠 ref 读
  const enabledRef = useRef(enabled);
  const busyRef = useRef(busy);
  const onPageRef = useRef(onPage);
  const armedRef = useRef<PageDirection | null>(null);
  enabledRef.current = enabled;
  busyRef.current = busy;
  onPageRef.current = onPage;

  useEffect(() => {
    if (!enabled) {
      setDragOffset(0);
      setArmed(null);
      armedRef.current = null;
    }
  }, [enabled]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;

    let wheelAccum = 0;
    let lastFire = 0;
    let startY = 0;
    let startedAtTop = false;
    let startedAtBottom = false;
    let tracking = false;

    const fire = (direction: PageDirection): boolean => {
      const now = performance.now();
      if (busyRef.current || now - lastFire < MIN_INTERVAL_MS) return false;
      lastFire = now;
      onPageRef.current(direction);
      return true;
    };

    const setArmedState = (next: PageDirection | null) => {
      if (armedRef.current === next) return;
      armedRef.current = next;
      setArmed(next);
    };

    const onWheel = (event: WheelEvent) => {
      if (!enabledRef.current) return;
      const towardsUp = event.deltaY < 0;
      // 容器里还有内容没看完就交给浏览器，滚到边了才轮到翻页
      if (towardsUp ? !atTop(element) : !atBottom(element)) {
        wheelAccum = 0;
        return;
      }
      const { accum, page } = accumulateWheel(wheelAccum, event.deltaY);
      wheelAccum = accum;
      if (page) fire(page);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (!enabledRef.current || event.touches.length !== 1) {
        tracking = false;
        return;
      }
      startY = event.touches[0]?.clientY ?? 0;
      startedAtTop = atTop(element);
      startedAtBottom = atBottom(element);
      tracking = true;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || !enabledRef.current) return;
      const distance = (event.touches[0]?.clientY ?? 0) - startY;
      // 手指下拉 = 想看上面的内容
      const towardsUp = distance > 0;
      if (towardsUp ? !startedAtTop : !startedAtBottom) return;
      // 拦下来自己处理，不然 iOS 会去弹整页
      if (event.cancelable) event.preventDefault();
      setDragOffset(dampDrag(distance));
      setArmedState(Math.abs(distance) >= DRAG_THRESHOLD ? (towardsUp ? "up" : "down") : null);
    };

    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      const direction = armedRef.current;
      setDragOffset(0);
      setArmedState(null);
      if (direction) fire(direction);
    };

    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [scrollerRef]);

  return { dragOffset, armed };
}
