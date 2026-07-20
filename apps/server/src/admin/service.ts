import {
  normalizeUsername,
  type Account,
  type AccountStatus,
  type AuditLog,
  type AuditResult,
  type ListAuditLogsOptions,
  type TabletopRepositories,
} from "@tabletop/database";

import { PasswordService } from "../auth/password.js";
import { accountLockKey, type RequestAuditContext, usernameLockKey } from "../auth/service.js";
import { HttpError } from "../http/errors.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";

export interface RegisteredGameSummary {
  readonly displayName: string;
  readonly gameId: string;
}

export interface AdminRuntimeHooks {
  readonly closeAllRooms: (reason: "site_disabled") => Promise<void> | void;
  readonly closeGameRooms: (gameId: string, reason: "game_disabled") => Promise<void> | void;
  readonly disconnectAccount: (accountId: string) => Promise<void> | void;
  readonly isAccountOffline: (accountId: string) => Promise<boolean> | boolean;
  readonly isAccountOnline: (accountId: string) => boolean;
}

const defaultRuntimeHooks: AdminRuntimeHooks = {
  closeAllRooms: () => undefined,
  closeGameRooms: () => undefined,
  disconnectAccount: () => undefined,
  isAccountOffline: () => true,
  isAccountOnline: () => false,
};

export interface AuditQuery {
  readonly accountId?: string;
  readonly action?: string;
  readonly from?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly result?: AuditResult;
  readonly to?: number;
}

export class AdminService {
  readonly #accountLocks: KeyedMutex<string>;
  readonly #games: ReadonlyMap<string, RegisteredGameSummary>;
  readonly #hooks: AdminRuntimeHooks;
  readonly #passwords: PasswordService;
  readonly #repositories: TabletopRepositories;

  constructor(options: {
    readonly accountLocks?: KeyedMutex<string>;
    readonly games?: readonly RegisteredGameSummary[];
    readonly hooks?: Partial<AdminRuntimeHooks>;
    readonly passwords?: PasswordService;
    readonly repositories: TabletopRepositories;
  }) {
    this.#accountLocks = options.accountLocks ?? new KeyedMutex<string>();
    this.#games = new Map((options.games ?? []).map((game) => [game.gameId, game]));
    this.#hooks = { ...defaultRuntimeHooks, ...options.hooks };
    this.#passwords = options.passwords ?? new PasswordService();
    this.#repositories = options.repositories;
    this.#repositories.services.syncRegisteredGames([...this.#games.keys()]);
  }

  listAccounts(options: { status?: AccountStatus; username?: string } = {}): Account[] {
    const username = options.username?.trim().normalize("NFKC").toLowerCase();
    return this.#repositories.accounts
      .list({ limit: 100, ...(options.status ? { status: options.status } : {}) })
      .filter((account) => account.role === "user")
      .filter((account) => (username ? account.usernameNormalized.includes(username) : true));
  }

  isAccountOnline(accountId: string): boolean {
    return this.#hooks.isAccountOnline(accountId);
  }

  async createAccount(
    actor: Account,
    input: { password: string; username: string },
    context: RequestAuditContext,
    now = Date.now(),
  ): Promise<Account> {
    const normalized = normalizeUsername(input.username);
    const passwordHash = await this.#passwords.hash(input.password);

    return this.#accountLocks.run(usernameLockKey(normalized.normalized), async () => {
      if (this.#repositories.accounts.findByUsername(normalized.display)) {
        throw new HttpError(409, "ACCOUNT_USERNAME_EXISTS", "用户名已存在");
      }

      try {
        return this.#repositories.transaction((repositories) => {
          const account = repositories.accounts.create({
            now,
            passwordHash,
            username: normalized.display,
          });
          appendAccountAudit(repositories, actor, account, "account.create", context, now);
          return account;
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HttpError(409, "ACCOUNT_USERNAME_EXISTS", "用户名已存在");
        }
        throw error;
      }
    });
  }

  async updateAccountStatus(
    actor: Account,
    accountId: string,
    status: AccountStatus,
    context: RequestAuditContext,
    now = Date.now(),
  ): Promise<Account> {
    const account = await this.#accountLocks.run(accountLockKey(accountId), async () => {
      const target = this.#requireMutableUser(accountId);
      return this.#repositories.transaction((repositories) => {
        const updated = repositories.accounts.updateStatus(target.id, status, now);
        if (!updated) {
          throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
        }
        if (status === "disabled") {
          repositories.sessions.revokeAllForAccount(target.id, now);
        }
        appendAccountAudit(repositories, actor, updated, "account.status.change", context, now, {
          status,
        });
        return updated;
      });
    });

    if (status === "disabled") {
      await this.#hooks.disconnectAccount(account.id);
    }
    return account;
  }

  async resetPassword(
    actor: Account,
    accountId: string,
    newPassword: string,
    context: RequestAuditContext,
    now = Date.now(),
  ): Promise<void> {
    const passwordHash = await this.#passwords.hash(newPassword);
    await this.#accountLocks.run(accountLockKey(accountId), async () => {
      const target = this.#requireMutableUser(accountId);
      this.#repositories.transaction((repositories) => {
        const updated = repositories.accounts.updatePasswordHash(target.id, passwordHash, now);
        if (!updated) {
          throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
        }
        repositories.sessions.revokeAllForAccount(target.id, now);
        appendAccountAudit(repositories, actor, updated, "account.password.reset", context, now);
      });
    });
    await this.#hooks.disconnectAccount(accountId);
  }

  async deleteAccount(
    actor: Account,
    accountId: string,
    context: RequestAuditContext,
    now = Date.now(),
  ): Promise<void> {
    await this.#accountLocks.run(accountLockKey(accountId), async () => {
      const target = this.#requireMutableUser(accountId);
      if (!(await this.#hooks.isAccountOffline(accountId))) {
        throw new HttpError(409, "ACCOUNT_NOT_OFFLINE", "账号在线或仍在房间中，不能删除");
      }

      this.#repositories.transaction((repositories) => {
        appendAccountAudit(repositories, actor, target, "account.delete", context, now);
        if (!repositories.accounts.delete(target.id)) {
          throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
        }
      });
    });
  }

  getServices() {
    const site = this.#repositories.services.initializeSite();
    const settingsByGame = new Map(
      this.#repositories.services
        .listRegisteredGames([...this.#games.keys()])
        .map((settings) => [settings.gameId, settings]),
    );

    return {
      games: [...this.#games.values()].map((game) => {
        const settings = settingsByGame.get(game.gameId);
        if (!settings) {
          throw new Error(`游戏服务开关缺失: ${game.gameId}`);
        }
        return { ...game, ...settings };
      }),
      site,
    };
  }

  async updateSite(
    actor: Account,
    input: { enabled: boolean; maintenanceMessage?: string },
    context: RequestAuditContext,
    now = Date.now(),
  ) {
    const previous = this.#repositories.services.initializeSite();
    const updated = this.#repositories.transaction((repositories) => {
      const result = repositories.services.updateSite({
        enabled: input.enabled,
        now,
        updatedBy: actor.id,
        ...(input.maintenanceMessage === undefined
          ? {}
          : { maintenanceMessage: input.maintenanceMessage }),
      });
      if (!result) {
        throw new Error("全站服务开关不存在");
      }
      repositories.audit.append({
        action: "service.site.update",
        actorAccountId: actor.id,
        actorUsername: actor.username,
        metadata: { changed: previous.enabled !== result.enabled, enabled: result.enabled },
        now,
        requestId: context.requestId,
        result: "success",
        sourceIp: context.sourceIp,
        targetId: "site",
        targetLabel: "全站服务",
        targetType: "site",
      });
      return result;
    });

    if (!updated.enabled) {
      await this.#hooks.closeAllRooms("site_disabled");
    }
    return updated;
  }

  async updateGame(
    actor: Account,
    gameId: string,
    enabled: boolean,
    context: RequestAuditContext,
    now = Date.now(),
  ) {
    const game = this.#games.get(gameId);
    if (!game) {
      throw new HttpError(404, "GAME_SERVICE_NOT_FOUND", "游戏服务不存在");
    }
    const previous = this.#repositories.services.findGame(gameId);
    if (!previous) {
      throw new Error(`游戏服务开关缺失: ${gameId}`);
    }

    const updated = this.#repositories.transaction((repositories) => {
      const result = repositories.services.updateGame(gameId, {
        enabled,
        now,
        updatedBy: actor.id,
      });
      if (!result) {
        throw new Error(`游戏服务开关缺失: ${gameId}`);
      }
      repositories.audit.append({
        action: "service.game.update",
        actorAccountId: actor.id,
        actorUsername: actor.username,
        metadata: { changed: previous.enabled !== result.enabled, enabled: result.enabled, gameId },
        now,
        requestId: context.requestId,
        result: "success",
        sourceIp: context.sourceIp,
        targetId: gameId,
        targetLabel: game.displayName,
        targetType: "game",
      });
      return result;
    });

    if (!updated.enabled) {
      await this.#hooks.closeGameRooms(gameId, "game_disabled");
    }
    return { ...game, ...updated };
  }

  listAudit(query: AuditQuery = {}): AuditLog[] {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    if (!query.accountId) {
      return this.#repositories.audit.list({
        limit,
        offset,
        ...auditRepositoryFilters(query),
      });
    }

    const matches: AuditLog[] = [];
    let rawOffset = 0;
    for (;;) {
      const page = this.#repositories.audit.list({
        limit: 100,
        offset: rawOffset,
        ...auditRepositoryFilters(query),
      });
      for (const log of page) {
        if (
          log.actorAccountId === query.accountId ||
          (log.targetType === "account" && log.targetId === query.accountId)
        ) {
          matches.push(log);
          if (matches.length >= offset + limit) {
            return matches.slice(offset, offset + limit);
          }
        }
      }
      if (page.length < 100) {
        return matches.slice(offset, offset + limit);
      }
      rawOffset += 100;
    }
  }

  listAllAudit(query: Omit<AuditQuery, "limit" | "offset"> = {}): AuditLog[] {
    return [...this.iterateAllAudit(query)];
  }

  *iterateAllAudit(query: Omit<AuditQuery, "limit" | "offset"> = {}): Generator<AuditLog, void> {
    let offset = 0;
    for (;;) {
      const page = this.#repositories.audit.list({
        limit: 100,
        offset,
        ...auditRepositoryFilters(query),
      });
      for (const log of page) {
        if (
          !query.accountId ||
          log.actorAccountId === query.accountId ||
          (log.targetType === "account" && log.targetId === query.accountId)
        ) {
          yield log;
        }
      }
      if (page.length < 100) {
        return;
      }
      offset += 100;
    }
  }

  recordAuditExport(actor: Account, context: RequestAuditContext, now = Date.now()): void {
    this.#repositories.audit.append({
      action: "audit.export",
      actorAccountId: actor.id,
      actorUsername: actor.username,
      metadata: {},
      now,
      requestId: context.requestId,
      result: "success",
      sourceIp: context.sourceIp,
      targetId: null,
      targetLabel: "审计日志",
      targetType: "audit",
    });
  }

  #requireMutableUser(accountId: string): Account {
    const account = this.#repositories.accounts.findById(accountId);
    if (!account) {
      throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
    }
    if (account.role === "admin") {
      throw new HttpError(403, "ADMIN_SELF_PROTECTED", "唯一管理员账号不能执行该操作");
    }
    return account;
  }
}

function appendAccountAudit(
  repositories: TabletopRepositories,
  actor: Account,
  target: Account,
  action: string,
  context: RequestAuditContext,
  now: number,
  metadata: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  repositories.audit.append({
    action,
    actorAccountId: actor.id,
    actorUsername: actor.username,
    metadata,
    now,
    requestId: context.requestId,
    result: "success",
    sourceIp: context.sourceIp,
    targetId: target.id,
    targetLabel: target.username,
    targetType: "account",
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function auditRepositoryFilters(query: AuditQuery): ListAuditLogsOptions {
  return {
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.result === undefined ? {} : { result: query.result }),
    ...(query.to === undefined ? {} : { to: query.to }),
  };
}
