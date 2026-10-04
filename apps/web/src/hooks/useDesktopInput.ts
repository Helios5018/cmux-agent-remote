import { useEffect, useState } from "react";
export function supportsFileShortcuts(device: { userAgent: string; platform: string; maxTouchPoints: number }, finePointer: boolean) {
  const mobile = /Android|iPhone|iPad|iPod/i.test(device.userAgent) || (device.platform === "MacIntel" && device.maxTouchPoints > 1);
  return finePointer && !mobile;
}
export function useDesktopInput() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const pointer = matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setDesktop(supportsFileShortcuts(navigator, pointer.matches));
    update(); pointer.addEventListener("change", update);
    return () => pointer.removeEventListener("change", update);
  }, []);
  return desktop;
}
