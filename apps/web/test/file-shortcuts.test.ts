import { expect, it } from "vitest";
import { supportsFileShortcuts } from "../src/hooks/useDesktopInput.ts";
it("桌面是否启用快捷键与窗口宽度无关；手机和 iPad 即使有鼠标也不启用", () => {
  expect(supportsFileShortcuts({userAgent:"Macintosh",platform:"MacIntel",maxTouchPoints:0},true)).toBe(true);
  expect(supportsFileShortcuts({userAgent:"Windows NT",platform:"Win32",maxTouchPoints:10},true)).toBe(true);
  expect(supportsFileShortcuts({userAgent:"iPhone",platform:"iPhone",maxTouchPoints:5},true)).toBe(false);
  expect(supportsFileShortcuts({userAgent:"Android",platform:"Linux",maxTouchPoints:5},true)).toBe(false);
  expect(supportsFileShortcuts({userAgent:"Macintosh",platform:"MacIntel",maxTouchPoints:5},true)).toBe(false);
  expect(supportsFileShortcuts({userAgent:"Macintosh",platform:"MacIntel",maxTouchPoints:0},false)).toBe(false);
});
