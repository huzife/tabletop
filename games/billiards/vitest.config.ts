import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tabletop/game-sdk/server": fileURLToPath(
        new URL("../../packages/game-sdk/src/server/index.ts", import.meta.url),
      ),
      "@tabletop/game-sdk/testing": fileURLToPath(
        new URL("../../packages/game-sdk/src/testing/index.ts", import.meta.url),
      ),
      "@tabletop/game-sdk/web": fileURLToPath(
        new URL("../../packages/game-sdk/src/web/index.ts", import.meta.url),
      ),
      "@tabletop/game-sdk": fileURLToPath(
        new URL("../../packages/game-sdk/src/index.ts", import.meta.url),
      ),
      "@tabletop/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url),
      ),
      "@tabletop/scene": fileURLToPath(
        new URL("../../packages/scene/src/index.ts", import.meta.url),
      ),
      "@tabletop/ui": fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
    },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] },
});
