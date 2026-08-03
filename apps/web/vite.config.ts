import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

interface FilingConfig {
  readonly icpFilingNumber: string;
  readonly publicSecurityFilingCode: string;
  readonly publicSecurityFilingNumber: string;
}

const filingConfigPath = new URL("./filing/filing.config.json", import.meta.url);

function loadFilingConfig(): FilingConfig | null {
  if (!existsSync(filingConfigPath)) return null;

  try {
    const candidate = JSON.parse(readFileSync(filingConfigPath, "utf8")) as Record<string, unknown>;
    const publicSecurityFilingNumber =
      typeof candidate.publicSecurityFilingNumber === "string"
        ? candidate.publicSecurityFilingNumber.trim()
        : "";
    const icpFilingNumber =
      typeof candidate.icpFilingNumber === "string" ? candidate.icpFilingNumber.trim() : "";
    const publicSecurityMatch = /^[\p{Script=Han}]+公网安备(\d+)号$/u.exec(
      publicSecurityFilingNumber,
    );
    const publicSecurityFilingCode = publicSecurityMatch?.[1];
    const hasValidIcpFilingNumber = /^[\p{Script=Han}]+ICP备\d+号(?:-\d+)?$/u.test(icpFilingNumber);

    if (!publicSecurityFilingCode || !hasValidIcpFilingNumber) return null;

    return {
      icpFilingNumber,
      publicSecurityFilingCode,
      publicSecurityFilingNumber,
    };
  } catch {
    return null;
  }
}

export default defineConfig({
  define: {
    __FILING_CONFIG__: JSON.stringify(loadFilingConfig()),
  },
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
