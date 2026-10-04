const paths = {
  "page-up": "m6 14 6-6 6 6",
  "page-down": "m6 10 6 6 6-6",
  bottom: "M12 4v12m-5-5 5 5 5-5M5 20h14",
  "zoom-out": "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6M7 10h6",
  "zoom-in": "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6M7 10h6m-3-3v6",
  auto: "M4 8V4h4m8 0h4v4m0 8v4h-4M8 20H4v-4m8-9 1.5 3.5L17 12l-3.5 1.5L12 17l-1.5-3.5L7 12l3.5-1.5Z",
  fit: "M4 4v16m16-16v16M7 12h10m-7-3-3 3 3 3m4-6 3 3-3 3",
  flow: "M4 6h16M4 11h12a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M4 16h3",
  expand: "M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5",
  collapse: "M9 4v5H4m16 0h-5V4m0 16v-5h5M4 15h5v5",
  refresh: "M20 4v6h-6m6-1a8 8 0 1 0 0 6",
};

/** 工具栏只绘制图形；功能名称由按钮的 aria-label 和 title 提供。 */
export function SessionToolIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={paths[name]} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
