import type { TabletopRepositories } from "@tabletop/database";

import type { PasswordService } from "../auth/password.js";

export class AdminAlreadyExistsError extends Error {
  constructor() {
    super("管理员账号已经存在");
    this.name = "AdminAlreadyExistsError";
  }
}

export async function bootstrapAdmin(options: {
  readonly now?: number;
  readonly password: string;
  readonly passwords: PasswordService;
  readonly repositories: TabletopRepositories;
  readonly username: string;
}) {
  const { passwords, repositories, username } = options;
  const now = options.now ?? Date.now();
  if (repositories.accounts.list({ limit: 100 }).some((account) => account.role === "admin")) {
    throw new AdminAlreadyExistsError();
  }

  const passwordHash = await passwords.hash(options.password);

  return repositories.transaction((transaction) => {
    if (transaction.accounts.list({ limit: 100 }).some((account) => account.role === "admin")) {
      throw new AdminAlreadyExistsError();
    }

    const account = transaction.accounts.create({
      now,
      passwordHash,
      role: "admin",
      username,
    });
    transaction.audit.append({
      action: "system.admin.bootstrap",
      actorAccountId: account.id,
      actorUsername: account.username,
      metadata: {},
      now,
      requestId: `bootstrap-${account.id}`,
      result: "success",
      sourceIp: null,
      targetId: account.id,
      targetLabel: account.username,
      targetType: "account",
    });

    return account;
  });
}
