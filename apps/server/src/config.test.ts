import { describe, expect, it } from "vitest";

import { readConfig } from "./config.js";

describe("readConfig", () => {
  it("parses production settings without implicit truthiness", () => {
    const config = readConfig({
      COOKIE_SECURE: "true",
      GAME_AI_WORKERS: "1",
      NODE_ENV: "production",
      SESSION_SECRET: "a".repeat(32),
      TRUST_PROXY: "loopback",
    });

    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.GAME_AI_WORKERS).toBe(1);
    expect(config.TRUST_PROXY).toBe("loopback");
  });

  it("rejects short session secrets", () => {
    expect(() => readConfig({ SESSION_SECRET: "short" })).toThrow();
  });
});
