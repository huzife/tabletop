import type { TabletopRepositories } from "@tabletop/database";

export const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export interface CleanupResult {
  readonly auditLogsDeleted: number;
  readonly sessionsDeleted: number;
}

export function runPersistentCleanup(
  repositories: TabletopRepositories,
  now = Date.now(),
): CleanupResult {
  const cutoff = now - RETENTION_WINDOW_MS;
  return repositories.transaction((transaction) => ({
    auditLogsDeleted: transaction.audit.deleteOlderThan(cutoff),
    sessionsDeleted: transaction.sessions.deleteExpiredOrRevoked(now, cutoff),
  }));
}
