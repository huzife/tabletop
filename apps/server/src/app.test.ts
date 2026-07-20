import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const config = {
  COOKIE_SECURE: false as const,
  LOG_LEVEL: "silent" as const,
  NODE_ENV: "test" as const,
  TRUST_PROXY: false as const,
};

describe("health endpoints", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("reports that the process is live", async () => {
    const app = await buildApp({ config, logger: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("reports a failing readiness dependency", async () => {
    const app = await buildApp({
      config,
      logger: false,
      readiness: async () => ({ checks: { database: "error" }, ready: false }),
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      checks: { database: "error" },
      status: "not_ready",
    });
  });

  it("preserves Fastify request parsing failures as safe client errors", async () => {
    const app = await buildApp({ config, logger: false });
    apps.push(app);
    app.post("/test/body", async () => ({ ok: true }));

    const malformed = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: "/test/body",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const oversized = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: JSON.stringify({ value: "x".repeat(65 * 1024) }),
      url: "/test/body",
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", message: "请求内容过大" },
    });

    const unsupported = await app.inject({
      headers: { "content-type": "application/xml" },
      method: "POST",
      payload: "<value />",
      url: "/test/body",
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });
});
