import { createRepositories, openDatabase } from "@tabletop/database";
import { afterEach, describe, expect, it } from "vitest";

import { AdminService } from "./service.js";

describe("AdminService audit queries", () => {
  const closers: Array<() => void> = [];

  afterEach(() => {
    closers
      .splice(0)
      .reverse()
      .forEach((close) => close());
  });

  it("finds account audit records beyond the first raw page", () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const actor = repositories.accounts.create({
      passwordHash: "hash",
      role: "admin",
      username: "审计管理员",
    });
    const target = repositories.accounts.create({
      passwordHash: "hash",
      username: "审计目标用户",
    });

    for (let index = 0; index < 100; index += 1) {
      repositories.audit.append({
        action: "test.unrelated",
        actorAccountId: actor.id,
        actorUsername: actor.username,
        now: index,
        requestId: `request-${index}`,
        result: "success",
        targetId: `other-${index}`,
        targetType: "account",
      });
    }
    repositories.audit.append({
      action: "test.target",
      actorAccountId: actor.id,
      actorUsername: actor.username,
      now: 101,
      requestId: "request-target",
      result: "success",
      targetId: target.id,
      targetType: "account",
    });

    const service = new AdminService({ repositories });
    expect(service.listAudit({ accountId: target.id, limit: 10 })).toMatchObject([
      { action: "test.target", targetId: target.id },
    ]);
  });
});
