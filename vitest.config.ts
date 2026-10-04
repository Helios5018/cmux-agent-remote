import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@car/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@car/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["apps/server/test/**/*.test.ts", "apps/web/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
