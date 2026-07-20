import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DatabaseConnection } from "../src/connection.js";

export function withTestDatabase<T>(work: (connection: DatabaseConnection) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "tabletop-database-"));
  const connection = openDatabase(join(directory, "tabletop.db"));

  try {
    return work(connection);
  } finally {
    connection.close();
    rmSync(directory, { force: true, recursive: true });
  }
}
