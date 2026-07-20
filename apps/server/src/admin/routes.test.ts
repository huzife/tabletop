import { createRepositories, openDatabase } from "@tabletop/database";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { PasswordService } from "../auth/password.js";
import { AuthService } from "../auth/service.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { AdminService } from "./service.js";

const config = {
  COOKIE_SECURE: false as const,
  LOG_LEVEL: "silent" as const,
  NODE_ENV: "test" as const,
  TRUST_PROXY: false as const,
};

function readCookies(headers: Record<string, number | string | string[] | undefined>) {
  const setCookie = headers["set-cookie"];
  const lines = (
    Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]
  ).map(String);
  const pairs = lines.map((line) => line.split(";", 1)[0]).filter(Boolean) as string[];
  const values = Object.fromEntries(
    pairs.map((pair) => {
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
  return { header: pairs.join("; "), values };
}

describe("administrator routes", () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) {
      await close();
    }
  });

  it("manages accounts, service switches and audit without exposing room administration", async () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const passwords = new PasswordService(1);
    const accountLocks = new KeyedMutex<string>();
    repositories.accounts.create({
      passwordHash: await passwords.hash("administrator-password"),
      role: "admin",
      username: "平台管理员",
    });

    let gameRoomsClosed = 0;
    let siteRoomsClosed = 0;
    let accountOffline = false;
    const auth = new AuthService(repositories, "s".repeat(32), passwords, accountLocks);
    const admin = new AdminService({
      accountLocks,
      games: [{ displayName: "测试游戏", gameId: "test-game" }],
      hooks: {
        closeAllRooms: () => {
          siteRoomsClosed += 1;
        },
        closeGameRooms: () => {
          gameRoomsClosed += 1;
        },
        isAccountOffline: () => accountOffline,
      },
      passwords,
      repositories,
    });
    const app = await buildApp({ admin, auth, config, logger: false });
    closers.push(async () => app.close());

    const login = await app.inject({
      method: "POST",
      payload: { password: "administrator-password", username: "平台管理员" },
      url: "/api/v1/auth/login",
    });
    expect(login.statusCode).toBe(200);
    const adminCookies = readCookies(login.headers);
    const unsafeHeaders = {
      cookie: adminCookies.header,
      host: "tabletop.test",
      origin: "http://tabletop.test",
      "x-csrf-token": adminCookies.values.tt_csrf,
    };

    const csrfRejected = await app.inject({
      headers: { cookie: adminCookies.header },
      method: "POST",
      payload: { password: "user-password", username: "普通用户01" },
      url: "/api/v1/admin/accounts",
    });
    expect(csrfRejected.statusCode).toBe(403);

    const invalidUsername = await app.inject({
      headers: unsafeHeaders,
      method: "POST",
      payload: { password: "user-password", username: "invalid@name" },
      url: "/api/v1/admin/accounts",
    });
    expect(invalidUsername.statusCode).toBe(400);

    const created = await app.inject({
      headers: unsafeHeaders,
      method: "POST",
      payload: { password: "user-password", username: "普通用户01" },
      url: "/api/v1/admin/accounts",
    });
    expect(created.statusCode).toBe(201);
    const userId = (created.json() as { account: { id: string } }).account.id;

    const listed = await app.inject({
      headers: { cookie: adminCookies.header },
      method: "GET",
      url: "/api/v1/admin/accounts",
    });
    expect(listed.json()).toMatchObject({
      accounts: [{ id: userId, status: "enabled", username: "普通用户01" }],
    });

    const userLogin = await app.inject({
      method: "POST",
      payload: { password: "user-password", username: "普通用户01" },
      url: "/api/v1/auth/login",
    });
    expect(userLogin.statusCode).toBe(200);
    const userCookies = readCookies(userLogin.headers);

    const disabled = await app.inject({
      headers: unsafeHeaders,
      method: "PATCH",
      payload: { status: "disabled" },
      url: `/api/v1/admin/accounts/${userId}`,
    });
    expect(disabled.statusCode).toBe(200);
    const invalidated = await app.inject({
      headers: { cookie: userCookies.header },
      method: "GET",
      url: "/api/v1/auth/session",
    });
    expect(invalidated.statusCode).toBe(401);

    const services = await app.inject({
      headers: { cookie: adminCookies.header },
      method: "GET",
      url: "/api/v1/admin/services",
    });
    expect(services.json()).toMatchObject({
      games: [{ enabled: true, gameId: "test-game" }],
      site: { enabled: true },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        headers: unsafeHeaders,
        method: "PUT",
        payload: { enabled: false },
        url: "/api/v1/admin/services/games/test-game",
      });
      expect(response.statusCode).toBe(200);
    }
    expect(gameRoomsClosed).toBe(2);

    const siteDisabled = await app.inject({
      headers: unsafeHeaders,
      method: "PUT",
      payload: { enabled: false, maintenanceMessage: "维护测试" },
      url: "/api/v1/admin/services/site",
    });
    expect(siteDisabled.statusCode).toBe(200);
    expect(siteRoomsClosed).toBe(1);

    const notOffline = await app.inject({
      headers: unsafeHeaders,
      method: "DELETE",
      url: `/api/v1/admin/accounts/${userId}`,
    });
    expect(notOffline.statusCode).toBe(409);
    accountOffline = true;
    const deleted = await app.inject({
      headers: unsafeHeaders,
      method: "DELETE",
      url: `/api/v1/admin/accounts/${userId}`,
    });
    expect(deleted.statusCode).toBe(204);

    const audit = await app.inject({
      headers: { cookie: adminCookies.header },
      method: "GET",
      url: "/api/v1/admin/audit?pageSize=100",
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as { logs: unknown[] }).logs.length).toBeGreaterThanOrEqual(5);

    const csv = await app.inject({
      headers: { cookie: adminCookies.header },
      method: "GET",
      url: "/api/v1/admin/audit.csv?pageSize=100",
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["cache-control"]).toBe("no-store");
    expect(csv.body).toContain("account.create");
    expect(app.hasRoute({ method: "GET", url: "/api/v1/admin/rooms" })).toBe(false);
  }, 45_000);
});
