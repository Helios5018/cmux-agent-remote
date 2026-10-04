import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && window.location.protocol !== "http:") {
  // 只在 https / localhost 下注册，局域网 http 访问时跳过（浏览器也不允许）
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
} else if ("serviceWorker" in navigator && window.location.hostname === "localhost") {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
