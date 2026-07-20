import { asc, eq } from "drizzle-orm";

import type { TabletopDatabase } from "../connection.js";
import { accounts, type Account, type AccountRole, type AccountStatus } from "../schema.js";
import { normalizeUsername } from "../username.js";

import type { RepositoryDependencies } from "./types.js";

export interface CreateAccountInput {
  readonly username: string;
  readonly passwordHash: string;
  readonly role?: AccountRole;
  readonly status?: AccountStatus;
  readonly id?: string;
  readonly now?: number;
}

export interface ListAccountsOptions {
  readonly status?: AccountStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export class AccountRepository {
  constructor(
    private readonly database: TabletopDatabase,
    private readonly dependencies: RepositoryDependencies,
  ) {}

  create(input: CreateAccountInput): Account {
    const username = normalizeUsername(input.username);
    const now = input.now ?? this.dependencies.clock();
    const account = this.database
      .insert(accounts)
      .values({
        id: input.id ?? this.dependencies.createId(),
        username: username.display,
        usernameNormalized: username.normalized,
        passwordHash: input.passwordHash,
        role: input.role ?? "user",
        status: input.status ?? "enabled",
        createdAt: now,
        updatedAt: now,
        passwordChangedAt: now,
      })
      .returning()
      .get();

    if (account === undefined) {
      throw new Error("创建账号后未返回记录");
    }
    return account;
  }

  findById(id: string): Account | undefined {
    return this.database.select().from(accounts).where(eq(accounts.id, id)).get();
  }

  findByUsername(username: string): Account | undefined {
    const { normalized } = normalizeUsername(username);
    return this.database
      .select()
      .from(accounts)
      .where(eq(accounts.usernameNormalized, normalized))
      .get();
  }

  list(options: ListAccountsOptions = {}): Account[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
    const offset = Math.max(options.offset ?? 0, 0);
    const query = this.database.select().from(accounts);

    if (options.status === undefined) {
      return query
        .orderBy(asc(accounts.createdAt), asc(accounts.id))
        .limit(limit)
        .offset(offset)
        .all();
    }

    return query
      .where(eq(accounts.status, options.status))
      .orderBy(asc(accounts.createdAt), asc(accounts.id))
      .limit(limit)
      .offset(offset)
      .all();
  }

  updateStatus(
    id: string,
    status: AccountStatus,
    now = this.dependencies.clock(),
  ): Account | undefined {
    return this.database
      .update(accounts)
      .set({ status, updatedAt: now })
      .where(eq(accounts.id, id))
      .returning()
      .get();
  }

  updatePasswordHash(
    id: string,
    passwordHash: string,
    now = this.dependencies.clock(),
  ): Account | undefined {
    return this.database
      .update(accounts)
      .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
      .where(eq(accounts.id, id))
      .returning()
      .get();
  }

  delete(id: string): boolean {
    return this.database.delete(accounts).where(eq(accounts.id, id)).run().changes > 0;
  }
}
