import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
