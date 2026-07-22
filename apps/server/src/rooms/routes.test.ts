import { createRepositories, openDatabase } from "@tabletop/database";
import { gamesResponseSchema } from "@tabletop/protocol/http";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { PasswordService } from "../auth/password.js";
import { AuthService } from "../auth/service.js";
import { serverGameRegistry } from "../games/registry.js";
import { RoomRegistry } from "./registry.js";

const config = {
  COOKIE_SECURE: false as const,
  LOG_LEVEL: "silent" as const,
  NODE_ENV: "test" as const,
  TRUST_PROXY: false as const,
};

function cookiesFrom(headers: Record<string, number | string | string[] | undefined>) {
  const raw = headers["set-cookie"];
  const pairs = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .map(String)
    .map((line) => line.split(";", 1)[0])
    .filter(Boolean) as string[];
  const values = Object.fromEntries(
    pairs.map((pair) => {
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
  return { header: pairs.join("; "), values };
}

describe("room HTTP routes", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it("returns the registered game catalog through the strict public contract", async () => {
    const connection = openDatabase(":memory:");
    cleanups.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const passwords = new PasswordService(1);
    repositories.accounts.create({
      passwordHash: await passwords.hash("catalog-password"),
      username: "目录测试用户",
    });
    const auth = new AuthService(repositories, "s".repeat(32), passwords);
    const rooms = new RoomRegistry({ games: serverGameRegistry, repositories });
    const app = await buildApp({ auth, config, logger: false, rooms });
    cleanups.push(async () => app.close());
    const login = await app.inject({
      method: "POST",
      payload: { password: "catalog-password", username: "目录测试用户" },
      url: "/api/v1/auth/login",
    });

    const cookies = cookiesFrom(login.headers);
    const response = await app.inject({
      headers: { cookie: cookies.header },
      method: "GET",
      url: "/api/v1/games",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const catalog = gamesResponseSchema.parse(response.json());
    expect(catalog.games).toHaveLength(3);
    expect(catalog.games).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiVersion: 1,
          botProfiles: [],
          enabled: true,
          gameId: "billiards",
        }),
        expect.objectContaining({
          apiVersion: 1,
          botProfiles: expect.arrayContaining([expect.objectContaining({ profileId: "hard" })]),
          enabled: true,
          gameId: "gomoku",
        }),
        expect.objectContaining({
          apiVersion: 1,
          botProfiles: expect.arrayContaining([expect.objectContaining({ profileId: "standard" })]),
          enabled: true,
          gameId: "ludo",
        }),
      ]),
    );

    const createResponses = [];
    for (let index = 0; index < 6; index += 1) {
      createResponses.push(
        await app.inject({
          headers: {
            cookie: cookies.header,
            host: "tabletop.test",
            origin: "http://tabletop.test",
            "x-csrf-token": cookies.values.tt_csrf,
          },
          method: "POST",
          payload: {
            gameId: "gomoku",
            name: `目录测试房间${index + 1}`,
            practice: false,
            settings: {
              moveTimeSeconds: 60,
              rule: "freestyle",
              timerEnabled: false,
              totalTimeMinutes: 10,
            },
          },
          url: "/api/v1/rooms",
        }),
      );
    }
    expect(createResponses.slice(0, 5).map(({ statusCode }) => statusCode)).toEqual([
      201, 201, 201, 201, 201,
    ]);
    expect(createResponses[0]?.headers["cache-control"]).toBe("no-store");
    expect(createResponses[5]?.statusCode).toBe(429);
    expect(createResponses[5]?.json()).toMatchObject({ error: { code: "RATE_ROOM_LIMIT" } });
  }, 30_000);
});
