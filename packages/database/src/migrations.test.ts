import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

import { readSqlitePragmas, SqliteConfigurationError, verifySqlitePragmas } from "./connection.js";
import { migrate } from "./migrations.js";
import { createRepositories } from "./repositories/index.js";
import { withTestDatabase } from "../test/test-database.js";

describe("database migrations and configuration", () => {
  it("migrates an empty file database and verifies required pragmas", () => {
    withTestDatabase(({ sqlite }) => {
      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(tables).toEqual(
        expect.arrayContaining([
          "__drizzle_migrations",
          "accounts",
          "audit_logs",
          "game_service_settings",
          "sessions",
          "site_settings",
        ]),
      );
      expect(readSqlitePragmas(sqlite)).toEqual({
        journalMode: "wal",
        foreignKeys: true,
        busyTimeoutMs: 5_000,
        synchronous: 1,
      });
      expect(
        sqlite.prepare("SELECT enabled FROM site_settings WHERE singleton_id = 1").get(),
      ).toEqual({ enabled: 1 });
    });
  });

  it("can run the same migration set repeatedly", () => {
    withTestDatabase(({ database, sqlite }) => {
      migrate(database);
      migrate(database);

      expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({
        count: 1,
      });
    });
  });

  it("reports a changed required pragma", () => {
    withTestDatabase(({ sqlite }) => {
      sqlite.pragma("busy_timeout = 1");
      expect(() => verifySqlitePragmas(sqlite)).toThrowError(SqliteConfigurationError);
      sqlite.pragma("busy_timeout = 5000");
    });
  });
});

describe("database constraints", () => {
  it("enforces normalized username uniqueness and a single admin", () => {
    withTestDatabase(({ database }) => {
      const repositories = createRepositories(database);
      repositories.accounts.create({
        id: ulid(),
        username: "Admin",
        passwordHash: "encoded-hash",
        role: "admin",
      });

      expect(() =>
        repositories.accounts.create({
          id: ulid(),
          username: "admin",
          passwordHash: "encoded-hash",
        }),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        repositories.accounts.create({
          id: ulid(),
          username: "OtherAdmin",
          passwordHash: "encoded-hash",
          role: "admin",
        }),
      ).toThrow(/UNIQUE constraint failed/);
    });
  });

  it("enforces enum, singleton, hash-length and foreign-key constraints", () => {
    withTestDatabase(({ database, sqlite }) => {
      const repositories = createRepositories(database);
      const account = repositories.accounts.create({
        username: "user-01",
        passwordHash: "encoded-hash",
      });

      expect(() =>
        sqlite
          .prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(ulid(), "bad-role", "bad-role", "hash", "owner", "enabled", 1, 1, 1),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO site_settings (singleton_id, enabled, maintenance_message, updated_at) VALUES (2, 1, 'x', 1)",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        repositories.sessions.create({
          accountId: account.id,
          tokenHash: Buffer.alloc(31),
          csrfSecretHash: Buffer.alloc(32),
          expiresAt: Date.now() + 1_000,
        }),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        repositories.sessions.create({
          accountId: ulid(),
          tokenHash: Buffer.alloc(32, 1),
          csrfSecretHash: Buffer.alloc(32, 2),
          expiresAt: Date.now() + 1_000,
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  it("cascades sessions and preserves an audit actor snapshot", () => {
    withTestDatabase(({ database }) => {
      const repositories = createRepositories(database);
      const actor = repositories.accounts.create({
        username: "actor-01",
        passwordHash: "encoded-hash",
      });
      const session = repositories.sessions.create({
        accountId: actor.id,
        tokenHash: Buffer.alloc(32, 1),
        csrfSecretHash: Buffer.alloc(32, 2),
        expiresAt: Date.now() + 10_000,
      });
      const audit = repositories.audit.append({
        actorAccountId: actor.id,
        actorUsername: actor.username,
        action: "account.delete",
        targetType: "account",
        targetId: actor.id,
        targetLabel: actor.username,
        result: "success",
        requestId: ulid(),
      });

      expect(repositories.accounts.delete(actor.id)).toBe(true);
      expect(repositories.sessions.findById(session.id)).toBeUndefined();
      expect(repositories.audit.list().find((row) => row.id === audit.id)).toMatchObject({
        actorAccountId: null,
        actorUsername: "actor-01",
        targetId: actor.id,
        targetLabel: "actor-01",
      });
    });
  });
});
