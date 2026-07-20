import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createRepositories, openDatabase } from "@tabletop/database";
import { registerServerGamesV1, type GameServerRegistryV1 } from "@tabletop/game-sdk/server";

import { AdminService } from "./admin/service.js";
import { buildApp } from "./app.js";
import { PasswordService } from "./auth/password.js";
import { AuthService } from "./auth/service.js";
import type { AppConfig } from "./config.js";
import {
  InProcessAutomationExecutor,
  SingleWorkerAutomationExecutor,
} from "./automation/executor.js";
import { KeyedMutex } from "./lib/keyed-mutex.js";
import { MAINTENANCE_INTERVAL_MS, runPersistentCleanup } from "./maintenance.js";
import { RoomRegistry } from "./rooms/registry.js";
import { RoomWebSocketGateway } from "./rooms/gateway.js";

export async function createRuntime(
  config: AppConfig,
  games: GameServerRegistryV1 = registerServerGamesV1([]),
) {
  const databasePath = resolve(config.DATABASE_PATH);
  mkdirSync(dirname(databasePath), { recursive: true });

  const connection = openDatabase(databasePath);
  const repositories = createRepositories(connection.database);
  repositories.services.initializeSite();
  runPersistentCleanup(repositories);
  const accountLocks = new KeyedMutex<string>();
  const passwords = new PasswordService();
  const auth = new AuthService(repositories, config.SESSION_SECRET, passwords, accountLocks);
  const automation =
    config.GAME_AI_WORKERS === 1
      ? new SingleWorkerAutomationExecutor()
      : new InProcessAutomationExecutor();
  const rooms = new RoomRegistry({ automation, games, repositories });
  let gateway: RoomWebSocketGateway | undefined;
  const admin = new AdminService({
    accountLocks,
    games: games.list().map(({ manifest }) => ({
      displayName: manifest.displayName,
      gameId: manifest.gameId,
    })),
    hooks: {
      closeAllRooms: () => rooms.closeAll(),
      closeGameRooms: (gameId) => rooms.closeGame(gameId),
      disconnectAccount: async (accountId) => {
        await rooms.removeAccount(accountId);
        gateway?.disconnectAccount(accountId);
      },
      isAccountOffline: (accountId) =>
        !rooms.hasAccountMembership(accountId) && !gateway?.isAccountConnected(accountId),
      isAccountOnline: (accountId) =>
        rooms.isAccountOnline(accountId) || gateway?.isAccountConnected(accountId) === true,
    },
    passwords,
    repositories,
  });

  const app = await buildApp({
    admin,
    auth,
    config,
    readiness: async () => {
      try {
        connection.sqlite.prepare("SELECT 1").get();
        return { checks: { database: "ok" }, ready: true };
      } catch {
        return { checks: { database: "error" }, ready: false };
      }
    },
    rooms,
  });
  gateway = new RoomWebSocketGateway({ app, auth, config, rooms });
  rooms.setPublisher(gateway);
  gateway.start();

  const maintenanceTimer = setInterval(() => {
    try {
      const result = runPersistentCleanup(repositories);
      app.log.info(result, "persistent maintenance completed");
    } catch (error) {
      app.log.error({ err: error }, "persistent maintenance failed");
    }
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();

  app.addHook("onClose", async () => {
    rooms.closeAll("internal_error", "服务正在关闭");
    await gateway.stop();
    await automation.close();
    clearInterval(maintenanceTimer);
    connection.close();
  });

  return { app, automation, connection, games, gateway, repositories, rooms };
}
