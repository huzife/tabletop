import { Readable } from "node:stream";

import type { Account, AuditResult } from "@tabletop/database";
import {
  accountMutationResponseSchema,
  adminAccountsQuerySchema,
  adminAccountsResponseSchema,
  adminServicesResponseSchema,
  auditQuerySchema,
  auditResponseSchema,
  createAccountRequestSchema,
  resetPasswordRequestSchema,
  updateAccountRequestSchema,
  updateGameServiceRequestSchema,
  updateGameServiceResponseSchema,
  updateSiteServiceRequestSchema,
  updateSiteServiceResponseSchema,
} from "@tabletop/protocol/http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { auditContext, requireAdmin } from "../auth/request.js";
import type { AuthService } from "../auth/service.js";
import { HttpError } from "../http/errors.js";
import { SlidingWindowRateLimiter } from "../lib/rate-limiter.js";
import { auditCsvHeader, auditLogToCsvRow } from "./csv.js";
import { AdminService, type AuditQuery } from "./service.js";

const accountIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const gameIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);

interface AdminRoutesOptions {
  readonly admin: AdminService;
  readonly auth: AuthService;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminRoutesOptions,
): Promise<void> {
  const { admin, auth } = options;
  const mutationLimiter = new SlidingWindowRateLimiter({ limit: 30, windowMs: 60_000 });
  const exportLimiter = new SlidingWindowRateLimiter({ limit: 5, windowMs: 60_000 });

  app.get("/api/v1/admin/accounts", async (request, reply) => {
    requireAdmin(auth, request);
    const query = adminAccountsQuerySchema.parse(request.query);
    const accounts = admin.listAccounts({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.username === undefined ? {} : { username: query.username }),
    });
    const offset = (query.page - 1) * query.pageSize;
    const response = adminAccountsResponseSchema.parse({
      accounts: accounts
        .slice(offset, offset + query.pageSize)
        .map((account) => accountDto(account, admin.isAccountOnline(account.id))),
      pagination: { page: query.page, pageSize: query.pageSize, total: accounts.length },
    });
    return reply.header("cache-control", "no-store").send(response);
  });

  app.post("/api/v1/admin/accounts", async (request, reply) => {
    const identity = requireAdmin(auth, request, true);
    enforceAdminRateLimit(mutationLimiter, identity.session.id);
    const body = createAccountRequestSchema.parse(request.body);
    const account = await admin.createAccount(identity.account, body, auditContext(request));
    return reply.code(201).send(
      accountMutationResponseSchema.parse({
        account: accountDto(account, admin.isAccountOnline(account.id)),
      }),
    );
  });

  app.patch("/api/v1/admin/accounts/:accountId", async (request) => {
    const identity = requireAdmin(auth, request, true);
    enforceAdminRateLimit(mutationLimiter, identity.session.id);
    const accountId = readAccountId(request);
    const body = updateAccountRequestSchema.parse(request.body);
    const account = await admin.updateAccountStatus(
      identity.account,
      accountId,
      body.status,
      auditContext(request),
    );
    return accountMutationResponseSchema.parse({
      account: accountDto(account, admin.isAccountOnline(account.id)),
    });
  });

  app.post("/api/v1/admin/accounts/:accountId/reset-password", async (request, reply) => {
    const identity = requireAdmin(auth, request, true);
    enforceAdminRateLimit(mutationLimiter, identity.session.id);
    const accountId = readAccountId(request);
    const body = resetPasswordRequestSchema.parse(request.body);
    await admin.resetPassword(identity.account, accountId, body.newPassword, auditContext(request));
    return reply.code(204).send();
  });

  app.delete("/api/v1/admin/accounts/:accountId", async (request, reply) => {
    const identity = requireAdmin(auth, request, true);
    enforceAdminRateLimit(mutationLimiter, identity.session.id);
    await admin.deleteAccount(identity.account, readAccountId(request), auditContext(request));
    return reply.code(204).send();
  });

  app.get("/api/v1/admin/services", async (request, reply) => {
    requireAdmin(auth, request);
    const services = admin.getServices();
    return reply.header("cache-control", "no-store").send(
      adminServicesResponseSchema.parse({
        games: services.games.map((game) => ({
          displayName: game.displayName,
          enabled: game.enabled,
          gameId: game.gameId,
          updatedAt: new Date(game.updatedAt).toISOString(),
        })),
        site: {
          enabled: services.site.enabled,
          maintenanceMessage: services.site.maintenanceMessage,
          updatedAt: new Date(services.site.updatedAt).toISOString(),
        },
      }),
    );
  });

  app.put("/api/v1/admin/services/site", async (request) => {
    const identity = requireAdmin(auth, request, true);
    enforceAdminRateLimit(mutationLimiter, identity.session.id);
    const body = updateSiteServiceRequestSchema.parse(request.body);
    const site = await admin.updateSite(
      identity.account,
      {
        enabled: body.enabled,
        ...(body.maintenanceMessage === undefined
          ? {}
          : { maintenanceMessage: body.maintenanceMessage }),
      },
      auditContext(request),
    );
    return updateSiteServiceResponseSchema.parse({
      site: {
        enabled: site.enabled,
        maintenanceMessage: site.maintenanceMessage,
        updatedAt: new Date(site.updatedAt).toISOString(),
      },
    });
  });

  app.put("/api/v1/admin/services/games/:gameId", async (request) => {
    const identity = requireAdmin(auth, request, true);
    enforceAdminRateLimit(mutationLimiter, identity.session.id);
    const gameId = gameIdSchema.parse((request.params as { gameId?: unknown }).gameId);
    const body = updateGameServiceRequestSchema.parse(request.body);
    const game = await admin.updateGame(
      identity.account,
      gameId,
      body.enabled,
      auditContext(request),
    );
    return updateGameServiceResponseSchema.parse({
      game: {
        displayName: game.displayName,
        enabled: game.enabled,
        gameId: game.gameId,
        updatedAt: new Date(game.updatedAt).toISOString(),
      },
    });
  });

  app.get("/api/v1/admin/audit", async (request, reply) => {
    requireAdmin(auth, request);
    const parsed = auditQuerySchema.parse(request.query);
    const query = toAuditQuery(parsed);
    const total = admin.listAllAudit(toAuditFilter(parsed)).length;
    const response = auditResponseSchema.parse({
      logs: admin.listAudit(query).map(auditDto),
      pagination: { page: parsed.page, pageSize: parsed.pageSize, total },
    });
    return reply.header("cache-control", "no-store").send(response);
  });

  app.get("/api/v1/admin/audit.csv", async (request, reply) => {
    const identity = requireAdmin(auth, request);
    enforceAdminRateLimit(exportLimiter, identity.session.id);
    const parsed = auditQuerySchema.parse(request.query);
    const query = toAuditFilter(parsed);
    admin.recordAuditExport(identity.account, auditContext(request));
    const stream = Readable.from(
      (function* () {
        yield auditCsvHeader();
        for (const log of admin.iterateAllAudit(query)) {
          yield auditLogToCsvRow(log);
        }
      })(),
    );
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", 'attachment; filename="tabletop-audit.csv"')
      .type("text/csv; charset=utf-8")
      .send(stream);
  });
}

function enforceAdminRateLimit(limiter: SlidingWindowRateLimiter, sessionId: string): void {
  const result = limiter.consume(sessionId);
  if (!result.allowed) {
    throw new HttpError(429, "RATE_ADMIN_LIMIT", "后台操作过于频繁，请稍后重试", {
      retryAfterSeconds: Math.ceil(result.retryAfterMs / 1_000),
    });
  }
}

function readAccountId(request: FastifyRequest): string {
  return accountIdSchema.parse((request.params as { accountId?: unknown }).accountId);
}

function toAuditQuery(parsed: z.infer<typeof auditQuerySchema>): AuditQuery {
  return {
    limit: parsed.pageSize,
    offset: (parsed.page - 1) * parsed.pageSize,
    ...(parsed.accountId === undefined ? {} : { accountId: parsed.accountId }),
    ...(parsed.action === undefined ? {} : { action: parsed.action }),
    ...(parsed.from === undefined ? {} : { from: Date.parse(parsed.from) }),
    ...(parsed.result === undefined ? {} : { result: parsed.result as AuditResult }),
    ...(parsed.to === undefined ? {} : { to: Date.parse(parsed.to) }),
  };
}

function toAuditFilter(
  parsed: z.infer<typeof auditQuerySchema>,
): Omit<AuditQuery, "limit" | "offset"> {
  const { limit: _limit, offset: _offset, ...query } = toAuditQuery(parsed);
  return query;
}

function accountDto(account: Account, online: boolean) {
  return {
    createdAt: new Date(account.createdAt).toISOString(),
    id: account.id,
    online,
    status: account.status,
    updatedAt: new Date(account.updatedAt).toISOString(),
    username: account.username,
  };
}

function auditDto(log: ReturnType<AdminService["listAudit"]>[number]) {
  return {
    action: log.action,
    actorAccountId: log.actorAccountId,
    actorUsername: log.actorUsername,
    createdAt: new Date(log.createdAt).toISOString(),
    id: log.id,
    metadata: JSON.parse(log.metadataJson) as unknown,
    requestId: log.requestId,
    result: log.result,
    sourceIp: log.sourceIp,
    targetId: log.targetId,
    targetLabel: log.targetLabel,
    targetType: log.targetType,
  };
}
