import { ulid } from "ulid";

import type { TabletopDatabase } from "../connection.js";

import { AccountRepository } from "./accounts.js";
import { AuditLogRepository } from "./audit.js";
import { ServiceSettingsRepository } from "./services.js";
import { SessionRepository } from "./sessions.js";
import type { RepositoryDependencies, RepositoryOptions } from "./types.js";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export class TabletopRepositories {
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly services: ServiceSettingsRepository;
  readonly audit: AuditLogRepository;

  private readonly dependencies: RepositoryDependencies;

  constructor(
    readonly database: TabletopDatabase,
    options: RepositoryOptions = {},
  ) {
    this.dependencies = {
      clock: options.clock ?? Date.now,
      createId: options.createId ?? ulid,
    };
    this.accounts = new AccountRepository(database, this.dependencies);
    this.sessions = new SessionRepository(database, this.dependencies);
    this.services = new ServiceSettingsRepository(database, this.dependencies);
    this.audit = new AuditLogRepository(database, this.dependencies);
  }

  transaction<T>(work: (repositories: TabletopRepositories) => T): T {
    return this.database.transaction((transaction) => {
      const result = work(
        new TabletopRepositories(transaction as unknown as TabletopDatabase, this.dependencies),
      );
      if (isPromiseLike(result)) {
        throw new TypeError("SQLite 事务回调必须同步完成");
      }
      return result;
    });
  }
}

export function createRepositories(
  database: TabletopDatabase,
  options: RepositoryOptions = {},
): TabletopRepositories {
  return new TabletopRepositories(database, options);
}

export type { CreateAccountInput, ListAccountsOptions } from "./accounts.js";
export type {
  AppendAuditLogInput,
  AuditMetadata,
  AuditMetadataValue,
  ListAuditLogsOptions,
} from "./audit.js";
export { serializeAuditMetadata } from "./audit.js";
export {
  DEFAULT_MAINTENANCE_MESSAGE,
  type UpdateGameServiceInput,
  type UpdateSiteSettingsInput,
} from "./services.js";
export type { ActiveSession, CreateSessionInput } from "./sessions.js";
export type { RepositoryOptions } from "./types.js";
