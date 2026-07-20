import { createRepositories, openDatabase } from "@tabletop/database";
import { afterEach, describe, expect, it } from "vitest";

import { RETENTION_WINDOW_MS, runPersistentCleanup } from "./maintenance.js";

describe("runPersistentCleanup", () => {
  const closers: Array<() => void> = [];

  afterEach(() => {
    closers
      .splice(0)
      .reverse()
      .forEach((close) => close());
  });

  it("removes expired sessions and audit records older than 30 days", () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const now = RETENTION_WINDOW_MS + 10_000;
    const repositories = createRepositories(connection.database);
    const account = repositories.accounts.create({
      now: 1,
      passwordHash: "hash",
      username: "清理测试员",
    });
    const expired = repositories.sessions.create({
      accountId: account.id,
      csrfSecretHash: Buffer.alloc(32, 1),
      expiresAt: now - 1,
      now: 1,
      tokenHash: Buffer.alloc(32, 2),
    });
    const active = repositories.sessions.create({
      accountId: account.id,
      csrfSecretHash: Buffer.alloc(32, 3),
      expiresAt: now + 10_000,
      now,
      tokenHash: Buffer.alloc(32, 4),
    });
    repositories.audit.append({
      action: "test.old",
      actorAccountId: account.id,
      actorUsername: account.username,
      now: now - RETENTION_WINDOW_MS - 1,
      requestId: "old-request",
      result: "success",
      targetType: "test",
    });
    repositories.audit.append({
      action: "test.current",
      actorAccountId: account.id,
      actorUsername: account.username,
      now,
      requestId: "current-request",
      result: "success",
      targetType: "test",
    });

    expect(runPersistentCleanup(repositories, now)).toEqual({
      auditLogsDeleted: 1,
      sessionsDeleted: 1,
    });
    expect(repositories.sessions.findById(expired.id)).toBeUndefined();
    expect(repositories.sessions.findById(active.id)).toBeDefined();
    expect(repositories.audit.list()).toHaveLength(1);
  });
});
