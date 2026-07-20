import { createRepositories, openDatabase } from "@tabletop/database";
import { afterEach, describe, expect, it } from "vitest";

import { PasswordService } from "../auth/password.js";
import { AdminAlreadyExistsError, bootstrapAdmin } from "./bootstrap.js";

describe("bootstrapAdmin", () => {
  const closers: Array<() => void> = [];

  afterEach(() => {
    closers
      .splice(0)
      .reverse()
      .forEach((close) => close());
  });

  it("creates exactly one administrator with an audit record", async () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const repositories = createRepositories(connection.database, { clock: () => 1_000 });
    const passwords = new PasswordService(1);

    const account = await bootstrapAdmin({
      now: 1_000,
      password: "admin-password",
      passwords,
      repositories,
      username: "核心管理员",
    });

    expect(account.role).toBe("admin");
    await expect(passwords.verify(account.passwordHash, "admin-password")).resolves.toBe(true);
    expect(repositories.audit.list()).toMatchObject([
      {
        action: "system.admin.bootstrap",
        actorAccountId: account.id,
        result: "success",
      },
    ]);

    await expect(
      bootstrapAdmin({
        password: "another-password",
        passwords,
        repositories,
        username: "其他管理员",
      }),
    ).rejects.toBeInstanceOf(AdminAlreadyExistsError);
  }, 30_000);
});
