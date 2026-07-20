import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { migrate } from "./migrations.js";
import * as schema from "./schema.js";

const REQUIRED_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_SYNCHRONOUS_NORMAL = 1;

export type TabletopDatabase = BetterSQLite3Database<typeof schema>;

export interface SqlitePragmaState {
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
  readonly synchronous: number;
}

export class SqliteConfigurationError extends Error {
  readonly actual: SqlitePragmaState;

  constructor(message: string, actual: SqlitePragmaState) {
    super(message);
    this.name = "SqliteConfigurationError";
    this.actual = actual;
  }
}

export interface OpenDatabaseOptions {
  readonly migrate?: boolean;
  readonly migrationsFolder?: string;
}

export interface DatabaseConnection {
  readonly sqlite: BetterSqlite3.Database;
  readonly database: TabletopDatabase;
  close(): void;
}

function readPragmaNumber(sqlite: BetterSqlite3.Database, pragma: string): number {
  return Number(sqlite.pragma(pragma, { simple: true }));
}

export function readSqlitePragmas(sqlite: BetterSqlite3.Database): SqlitePragmaState {
  return {
    journalMode: String(sqlite.pragma("journal_mode", { simple: true })).toLowerCase(),
    foreignKeys: readPragmaNumber(sqlite, "foreign_keys") === 1,
    busyTimeoutMs: readPragmaNumber(sqlite, "busy_timeout"),
    synchronous: readPragmaNumber(sqlite, "synchronous"),
  };
}

export function configureSqlite(sqlite: BetterSqlite3.Database): SqlitePragmaState {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma(`busy_timeout = ${REQUIRED_BUSY_TIMEOUT_MS}`);
  sqlite.pragma("synchronous = NORMAL");

  return verifySqlitePragmas(sqlite);
}

export function verifySqlitePragmas(sqlite: BetterSqlite3.Database): SqlitePragmaState {
  const actual = readSqlitePragmas(sqlite);
  const expectedJournalMode = sqlite.name === ":memory:" ? "memory" : "wal";
  const failures: string[] = [];

  if (actual.journalMode !== expectedJournalMode) {
    failures.push(`journal_mode=${actual.journalMode}`);
  }
  if (!actual.foreignKeys) {
    failures.push("foreign_keys=0");
  }
  if (actual.busyTimeoutMs !== REQUIRED_BUSY_TIMEOUT_MS) {
    failures.push(`busy_timeout=${actual.busyTimeoutMs}`);
  }
  if (actual.synchronous !== SQLITE_SYNCHRONOUS_NORMAL) {
    failures.push(`synchronous=${actual.synchronous}`);
  }

  if (failures.length > 0) {
    throw new SqliteConfigurationError(`SQLite 配置不符合要求: ${failures.join(", ")}`, actual);
  }

  return actual;
}

export function openDatabase(
  filename: string,
  options: OpenDatabaseOptions = {},
): DatabaseConnection {
  const sqlite = new BetterSqlite3(filename);

  try {
    configureSqlite(sqlite);
    const database = drizzle(sqlite, { schema });

    if (options.migrate !== false) {
      if (options.migrationsFolder === undefined) {
        migrate(database);
      } else {
        migrate(database, options.migrationsFolder);
      }
    }

    return {
      sqlite,
      database,
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
