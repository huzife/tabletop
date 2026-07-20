#!/usr/bin/env node

import { chmodSync } from "node:fs";
import { resolve } from "node:path";

import { openDatabase } from "../packages/database/dist/index.js";

process.umask(0o077);

const databaseArgument = process.argv[2] ?? process.env.DATABASE_PATH;

if (!databaseArgument) {
  process.stderr.write("Usage: migrate-db.mjs <database-path>\n");
  process.exitCode = 2;
} else {
  const databasePath = resolve(databaseArgument);
  const connection = openDatabase(databasePath);

  try {
    const result = connection.sqlite.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`SQLite integrity check failed: ${String(result)}`);
    }
  } finally {
    connection.close();
  }
  chmodSync(databasePath, 0o600);
  process.stdout.write(`Database migration complete: ${databasePath}\n`);
}
