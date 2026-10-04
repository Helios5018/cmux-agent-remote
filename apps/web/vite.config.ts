import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const target = process.env.CAR_SERVER ?? "http://127.0.0.1:4318";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@car/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@car/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 4319,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/ws": { target, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
