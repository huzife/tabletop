import { and, asc, eq, gte, lt, type SQL } from "drizzle-orm";

import type { TabletopDatabase } from "../connection.js";
import { auditLogs, type AuditLog, type AuditResult } from "../schema.js";

import type { RepositoryDependencies } from "./types.js";

export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export interface AppendAuditLogInput {
  readonly actorAccountId: string | null;
  readonly actorUsername: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly targetLabel?: string | null;
  readonly result: AuditResult;
  readonly sourceIp?: string | null;
  readonly requestId: string;
  readonly metadata?: AuditMetadata;
  readonly id?: string;
  readonly now?: number;
}

export interface ListAuditLogsOptions {
  readonly from?: number;
  readonly to?: number;
  readonly actorAccountId?: string;
  readonly action?: string;
  readonly result?: AuditResult;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export function serializeAuditMetadata(metadata: AuditMetadata = {}): string {
  const sorted: Record<string, AuditMetadataValue> = {};

  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError(`审计 metadata 字段 ${key} 不是可序列化标量`);
    }
    sorted[key] = value;
  }

  return JSON.stringify(sorted);
}

export class AuditLogRepository {
  constructor(
    private readonly database: TabletopDatabase,
    private readonly dependencies: RepositoryDependencies,
  ) {}

  append(input: AppendAuditLogInput): AuditLog {
    const log = this.database
      .insert(auditLogs)
      .values({
        id: input.id ?? this.dependencies.createId(),
        createdAt: input.now ?? this.dependencies.clock(),
        actorAccountId: input.actorAccountId,
        actorUsername: input.actorUsername,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        result: input.result,
        sourceIp: input.sourceIp ?? null,
        requestId: input.requestId,
        metadataJson: serializeAuditMetadata(input.metadata),
      })
      .returning()
      .get();

    if (log === undefined) {
      throw new Error("写入审计日志后未返回记录");
    }
    return log;
  }

  list(options: ListAuditLogsOptions = {}): AuditLog[] {
    const conditions: SQL[] = [];
    if (options.from !== undefined) conditions.push(gte(auditLogs.createdAt, options.from));
    if (options.to !== undefined) conditions.push(lt(auditLogs.createdAt, options.to));
    if (options.actorAccountId !== undefined) {
      conditions.push(eq(auditLogs.actorAccountId, options.actorAccountId));
    }
    if (options.action !== undefined) conditions.push(eq(auditLogs.action, options.action));
    if (options.result !== undefined) conditions.push(eq(auditLogs.result, options.result));
    if (options.targetType !== undefined) {
      conditions.push(eq(auditLogs.targetType, options.targetType));
    }
    if (options.targetId !== undefined) conditions.push(eq(auditLogs.targetId, options.targetId));

    const query = this.database.select().from(auditLogs);
    const filtered = conditions.length === 0 ? query : query.where(and(...conditions));

    return filtered
      .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
      .limit(Math.max(1, Math.min(options.limit ?? 100, 100)))
      .offset(Math.max(options.offset ?? 0, 0))
      .all();
  }

  deleteOlderThan(cutoff: number): number {
    return this.database.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff)).run().changes;
  }
}
