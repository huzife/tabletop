import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";

import type { TabletopDatabase } from "../connection.js";
import { accounts, sessions, type Account, type Session } from "../schema.js";

import type { RepositoryDependencies } from "./types.js";

export interface CreateSessionInput {
  readonly accountId: string;
  readonly tokenHash: Buffer;
  readonly csrfSecretHash: Buffer;
  readonly expiresAt: number;
  readonly id?: string;
  readonly now?: number;
}

export interface ActiveSession {
  readonly session: Session;
  readonly account: Account;
}

export class SessionRepository {
  constructor(
    private readonly database: TabletopDatabase,
    private readonly dependencies: RepositoryDependencies,
  ) {}

  create(input: CreateSessionInput): Session {
    const now = input.now ?? this.dependencies.clock();
    const session = this.database
      .insert(sessions)
      .values({
        id: input.id ?? this.dependencies.createId(),
        accountId: input.accountId,
        tokenHash: input.tokenHash,
        csrfSecretHash: input.csrfSecretHash,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: input.expiresAt,
        revokedAt: null,
      })
      .returning()
      .get();

    if (session === undefined) {
      throw new Error("创建会话后未返回记录");
    }
    return session;
  }

  findById(id: string): Session | undefined {
    return this.database.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  findActiveByTokenHash(
    tokenHash: Buffer,
    now = this.dependencies.clock(),
  ): ActiveSession | undefined {
    return this.database
      .select({ session: sessions, account: accounts })
      .from(sessions)
      .innerJoin(accounts, eq(accounts.id, sessions.accountId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          eq(accounts.status, "enabled"),
        ),
      )
      .get();
  }

  touch(id: string, expiresAt: number, now = this.dependencies.clock()): Session | undefined {
    return this.database
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .returning()
      .get();
  }

  revoke(id: string, revokedAt = this.dependencies.clock()): boolean {
    return (
      this.database
        .update(sessions)
        .set({ revokedAt })
        .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
        .run().changes > 0
    );
  }

  revokeAllForAccount(accountId: string, revokedAt = this.dependencies.clock()): number {
    return this.database
      .update(sessions)
      .set({ revokedAt })
      .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)))
      .run().changes;
  }

  deleteExpiredOrRevoked(now: number, revokedBefore: number): number {
    return this.database
      .delete(sessions)
      .where(
        or(
          lte(sessions.expiresAt, now),
          and(isNotNull(sessions.revokedAt), lte(sessions.revokedAt, revokedBefore)),
        ),
      )
      .run().changes;
  }
}
