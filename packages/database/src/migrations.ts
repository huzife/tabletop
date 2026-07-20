import { fileURLToPath } from "node:url";

import { migrate as runDrizzleMigrations } from "drizzle-orm/better-sqlite3/migrator";

import type { TabletopDatabase } from "./connection.js";

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export function migrate(
  database: TabletopDatabase,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): void {
  runDrizzleMigrations(database, { migrationsFolder });
}
