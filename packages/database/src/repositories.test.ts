import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

import { createRepositories, serializeAuditMetadata } from "./repositories/index.js";
import { withTestDatabase } from "../test/test-database.js";

const NOW = 1_750_000_000_000;

describe("repositories", () => {
  it("uses the same username normalization for creation and lookup", () => {
    withTestDatabase(({ database }) => {
      const repositories = createRepositories(database, { clock: () => NOW });
      const account = repositories.accounts.create({
        username: "  Ａlice-张  ",
        passwordHash: "encoded-hash",
      });

      expect(account).toMatchObject({ username: "Alice-张", usernameNormalized: "alice-张" });
      expect(repositories.accounts.findByUsername("ALICE-张")?.id).toBe(account.id);
    });
  });

  it("commits successful synchronous transactions and rolls back failures", () => {
    withTestDatabase(({ database }) => {
      const repositories = createRepositories(database, { clock: () => NOW });

      expect(() =>
        repositories.transaction((transaction) => {
          const account = transaction.accounts.create({
            username: "rollback-user",
            passwordHash: "encoded-hash",
          });
          transaction.audit.append({
            actorAccountId: account.id,
            actorUsername: account.username,
            action: "account.create",
            targetType: "account",
            targetId: account.id,
            result: "success",
            requestId: ulid(),
          });
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(repositories.accounts.findByUsername("rollback-user")).toBeUndefined();
      expect(repositories.audit.list()).toHaveLength(0);

      const committed = repositories.transaction((transaction) =>
        transaction.accounts.create({
          username: "commit-user",
          passwordHash: "encoded-hash",
        }),
      );
      expect(repositories.accounts.findById(committed.id)).toBeDefined();
    });
  });

  it("rejects asynchronous transaction callbacks before commit", () => {
    withTestDatabase(({ database }) => {
      const repositories = createRepositories(database);

      expect(() =>
        repositories.transaction(async (transaction) => {
          transaction.accounts.create({
            username: "async-user",
            passwordHash: "encoded-hash",
          });
        }),
      ).toThrow("SQLite 事务回调必须同步完成");
      expect(repositories.accounts.findByUsername("async-user")).toBeUndefined();
    });
  });

  it("returns only enabled, unexpired and unrevoked sessions", () => {
    withTestDatabase(({ database }) => {
      let now = NOW;
      const repositories = createRepositories(database, { clock: () => now });
      const account = repositories.accounts.create({
        username: "session-user",
        passwordHash: "encoded-hash",
      });
      const tokenHash = Buffer.alloc(32, 1);
      const session = repositories.sessions.create({
        accountId: account.id,
        tokenHash,
        csrfSecretHash: Buffer.alloc(32, 2),
        expiresAt: NOW + 10_000,
      });

      expect(repositories.sessions.findActiveByTokenHash(tokenHash)?.session.id).toBe(session.id);
      repositories.accounts.updateStatus(account.id, "disabled");
      expect(repositories.sessions.findActiveByTokenHash(tokenHash)).toBeUndefined();
      repositories.accounts.updateStatus(account.id, "enabled");
      repositories.sessions.revoke(session.id);
      expect(repositories.sessions.findActiveByTokenHash(tokenHash)).toBeUndefined();

      now = NOW + 20_000;
      expect(repositories.sessions.deleteExpiredOrRevoked(now, now)).toBe(1);
    });
  });

  it("adds new game switches without overwriting existing or stale records", () => {
    withTestDatabase(({ database }) => {
      const repositories = createRepositories(database, { clock: () => NOW });

      expect(repositories.services.getSite()).toMatchObject({
        singletonId: 1,
        enabled: true,
      });
      expect(
        repositories.services.syncRegisteredGames(["test-alpha", "test-beta", "test-alpha"]),
      ).toBe(2);
      repositories.services.updateGame("test-alpha", { enabled: false, updatedBy: null });
      expect(repositories.services.syncRegisteredGames(["test-alpha", "test-beta"])).toBe(0);
      expect(repositories.services.findGame("test-alpha")?.enabled).toBe(false);
      expect(repositories.services.listRegisteredGames(["test-beta"])).toHaveLength(1);
      expect(repositories.services.listGames().map((game) => game.gameId)).toEqual([
        "test-alpha",
        "test-beta",
      ]);
    });
  });

  it("serializes safe scalar audit metadata deterministically and cleans by age", () => {
    expect(serializeAuditMetadata({ z: 2, a: 1 })).toBe('{"a":1,"z":2}');
    expect(() => serializeAuditMetadata({ invalid: Number.NaN })).toThrow(TypeError);

    withTestDatabase(({ database }) => {
      const repositories = createRepositories(database);
      repositories.audit.append({
        actorAccountId: null,
        actorUsername: "anonymous",
        action: "auth.login",
        targetType: "account",
        result: "failure",
        requestId: ulid(),
        metadata: { reasonCode: "INVALID_CREDENTIALS" },
        now: NOW - 1,
      });
      repositories.audit.append({
        actorAccountId: null,
        actorUsername: "anonymous",
        action: "auth.login",
        targetType: "account",
        result: "failure",
        requestId: ulid(),
        now: NOW,
      });

      expect(repositories.audit.deleteOlderThan(NOW)).toBe(1);
      expect(repositories.audit.list()).toHaveLength(1);
    });
  });
});
