import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const ACCOUNT_ROLES = ["admin", "user"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const ACCOUNT_STATUSES = ["enabled", "disabled"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const AUDIT_RESULTS = ["success", "failure"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    usernameNormalized: text("username_normalized").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ACCOUNT_ROLES }).notNull(),
    status: text("status", { enum: ACCOUNT_STATUSES }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    passwordChangedAt: integer("password_changed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("accounts_username_normalized_unique").on(table.usernameNormalized),
    uniqueIndex("accounts_single_admin_unique")
      .on(table.role)
      .where(sql`${table.role} = 'admin'`),
    index("accounts_status_idx").on(table.status),
    check("accounts_id_ulid_check", sql`length(${table.id}) = 26`),
    check("accounts_username_length_check", sql`length(${table.username}) BETWEEN 3 AND 32`),
    check(
      "accounts_username_normalized_length_check",
      sql`length(${table.usernameNormalized}) BETWEEN 3 AND 32`,
    ),
    check("accounts_password_hash_not_empty_check", sql`length(${table.passwordHash}) > 0`),
    check("accounts_role_check", sql`${table.role} IN ('admin', 'user')`),
    check("accounts_status_check", sql`${table.status} IN ('enabled', 'disabled')`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: blob("token_hash", { mode: "buffer" }).notNull(),
    csrfSecretHash: blob("csrf_secret_hash", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "number" }).notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_account_id_idx").on(table.accountId),
    index("sessions_expires_at_idx").on(table.expiresAt),
    index("sessions_revoked_at_idx")
      .on(table.revokedAt)
      .where(sql`${table.revokedAt} IS NOT NULL`),
    check("sessions_id_ulid_check", sql`length(${table.id}) = 26`),
    check("sessions_token_hash_length_check", sql`length(${table.tokenHash}) = 32`),
    check("sessions_csrf_secret_hash_length_check", sql`length(${table.csrfSecretHash}) = 32`),
    check("sessions_expiry_order_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const siteSettings = sqliteTable(
  "site_settings",
  {
    singletonId: integer("singleton_id", { mode: "number" }).primaryKey(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    maintenanceMessage: text("maintenance_message").notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    updatedBy: text("updated_by").references(() => accounts.id, { onDelete: "set null" }),
  },
  (table) => [
    check("site_settings_singleton_check", sql`${table.singletonId} = 1`),
    check("site_settings_enabled_check", sql`${table.enabled} IN (0, 1)`),
    check(
      "site_settings_maintenance_message_length_check",
      sql`length(${table.maintenanceMessage}) BETWEEN 1 AND 200`,
    ),
  ],
);

export const gameServiceSettings = sqliteTable(
  "game_service_settings",
  {
    gameId: text("game_id").primaryKey(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    updatedBy: text("updated_by").references(() => accounts.id, { onDelete: "set null" }),
  },
  (table) => [
    check(
      "game_service_settings_game_id_length_check",
      sql`length(${table.gameId}) BETWEEN 1 AND 64`,
    ),
    check("game_service_settings_enabled_check", sql`${table.enabled} IN (0, 1)`),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    actorAccountId: text("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actorUsername: text("actor_username").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    result: text("result", { enum: AUDIT_RESULTS }).notNull(),
    sourceIp: text("source_ip"),
    requestId: text("request_id").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (table) => [
    index("audit_logs_created_at_idx").on(table.createdAt, table.id),
    index("audit_logs_actor_created_at_idx").on(table.actorAccountId, table.createdAt),
    index("audit_logs_action_created_at_idx").on(table.action, table.createdAt),
    index("audit_logs_target_created_at_idx").on(table.targetType, table.targetId, table.createdAt),
    check("audit_logs_id_ulid_check", sql`length(${table.id}) = 26`),
    check("audit_logs_actor_username_not_empty_check", sql`length(${table.actorUsername}) > 0`),
    check("audit_logs_action_not_empty_check", sql`length(${table.action}) > 0`),
    check("audit_logs_target_type_not_empty_check", sql`length(${table.targetType}) > 0`),
    check("audit_logs_result_check", sql`${table.result} IN ('success', 'failure')`),
    check("audit_logs_request_id_not_empty_check", sql`length(${table.requestId}) > 0`),
    check("audit_logs_metadata_json_check", sql`json_valid(${table.metadataJson})`),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SiteSettings = typeof siteSettings.$inferSelect;
export type GameServiceSettings = typeof gameServiceSettings.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
