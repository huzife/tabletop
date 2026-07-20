import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tabletop/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
