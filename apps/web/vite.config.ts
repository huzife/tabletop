import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        changeOrigin: false,
        target: "http://127.0.0.1:3000",
      },
      "/ws": {
        changeOrigin: false,
        target: "ws://127.0.0.1:3000",
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
