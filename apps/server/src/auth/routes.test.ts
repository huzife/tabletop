import { createRepositories, openDatabase } from "@tabletop/database";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { PasswordService } from "./password.js";
import { AuthService } from "./service.js";

const config = {
  COOKIE_SECURE: false as const,
  LOG_LEVEL: "silent" as const,
  NODE_ENV: "test" as const,
  TRUST_PROXY: false as const,
};

function cookiesFrom(response: {
  headers: Record<string, number | string | string[] | undefined>;
}) {
  const values = response.headers["set-cookie"];
  const cookieLines = (Array.isArray(values) ? values : values === undefined ? [] : [values]).map(
    String,
  );
  const pairs = cookieLines.map((line) => line.split(";", 1)[0]).filter(Boolean) as string[];
  const valuesByName = Object.fromEntries(
    pairs.map((pair) => {
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );

  return {
    header: pairs.join("; "),
    lines: cookieLines,
    values: valuesByName,
  };
}

describe("authentication routes", () => {
  const closeCallbacks: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const close of closeCallbacks.splice(0).reverse()) {
      await close();
    }
  });

  it("supports login, CSRF protection, password rotation and session revocation", async () => {
    const connection = openDatabase(":memory:");
    closeCallbacks.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const passwords = new PasswordService(1);
    repositories.accounts.create({
      passwordHash: await passwords.hash("initial-password"),
      role: "admin",
      username: "管理员01",
    });

    const app = await buildApp({
      auth: new AuthService(repositories, "s".repeat(32), passwords),
      config,
      logger: false,
    });
    closeCallbacks.push(async () => app.close());

    const login = await app.inject({
      method: "POST",
      payload: { password: "initial-password", username: "管理员01" },
      url: "/api/v1/auth/login",
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      account: { role: "admin", username: "管理员01" },
    });
    expect(login.body).not.toContain("passwordHash");
    const firstCookies = cookiesFrom(login);
    expect(firstCookies.lines.find((line) => line.startsWith("tt_session="))).toContain("HttpOnly");
    expect(firstCookies.lines.find((line) => line.startsWith("tt_csrf="))).not.toContain(
      "HttpOnly",
    );
    expect(firstCookies.lines.every((line) => line.includes("SameSite=Lax"))).toBe(true);

    const session = await app.inject({
      headers: { cookie: firstCookies.header },
      method: "GET",
      url: "/api/v1/auth/session",
    });
    expect(session.statusCode).toBe(200);

    const rejectedChange = await app.inject({
      headers: { cookie: firstCookies.header },
      method: "POST",
      payload: { currentPassword: "initial-password", newPassword: "changed-password" },
      url: "/api/v1/auth/change-password",
    });
    expect(rejectedChange.statusCode).toBe(403);
    expect(rejectedChange.json()).toMatchObject({ error: { code: "AUTH_ORIGIN_INVALID" } });

    const changed = await app.inject({
      headers: {
        cookie: firstCookies.header,
        host: "tabletop.test",
        origin: "http://tabletop.test",
        "x-csrf-token": firstCookies.values.tt_csrf,
      },
      method: "POST",
      payload: { currentPassword: "initial-password", newPassword: "changed-password" },
      url: "/api/v1/auth/change-password",
    });
    expect(changed.statusCode).toBe(200);
    const changedCookies = cookiesFrom(changed);
    expect(changedCookies.values.tt_session).not.toBe(firstCookies.values.tt_session);

    const revokedSession = await app.inject({
      headers: { cookie: firstCookies.header },
      method: "GET",
      url: "/api/v1/auth/session",
    });
    expect(revokedSession.statusCode).toBe(401);

    const oldPassword = await app.inject({
      method: "POST",
      payload: { password: "initial-password", username: "管理员01" },
      url: "/api/v1/auth/login",
    });
    const newPassword = await app.inject({
      method: "POST",
      payload: { password: "changed-password", username: "管理员01" },
      url: "/api/v1/auth/login",
    });
    expect(oldPassword.statusCode).toBe(401);
    expect(newPassword.statusCode).toBe(200);

    const logout = await app.inject({
      headers: {
        cookie: changedCookies.header,
        host: "tabletop.test",
        origin: "http://tabletop.test",
        "x-csrf-token": changedCookies.values.tt_csrf,
      },
      method: "POST",
      url: "/api/v1/auth/logout",
    });
    expect(logout.statusCode).toBe(204);
  }, 30_000);
});
