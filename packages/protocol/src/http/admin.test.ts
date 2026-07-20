import { describe, expect, it } from "vitest";

import {
  accountMutationResponseSchema,
  adminAccountsQuerySchema,
  adminAccountsResponseSchema,
  adminServicesResponseSchema,
  auditQuerySchema,
  auditResponseSchema,
  createAccountRequestSchema,
  deleteAccountResponseSchema,
  updateAccountRequestSchema,
  updateGameServiceResponseSchema,
  updateSiteServiceRequestSchema,
  updateSiteServiceResponseSchema,
} from "./admin.js";

const account = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  username: "普通用户01",
  status: "enabled",
  online: true,
  createdAt: "2026-07-16T10:00:00.000Z",
  updatedAt: "2026-07-16T10:00:00.000Z",
} as const;

const pagination = { page: 1, pageSize: 20, total: 1 } as const;

describe("admin HTTP schemas", () => {
  it("matches paginated account DTOs without exposing account internals", () => {
    expect(adminAccountsResponseSchema.safeParse({ accounts: [account], pagination }).success).toBe(
      true,
    );
    expect(accountMutationResponseSchema.safeParse({ account }).success).toBe(true);
    expect(
      adminAccountsResponseSchema.safeParse({
        accounts: [{ ...account, role: "user" }],
        pagination,
      }).success,
    ).toBe(false);
    expect(
      adminAccountsResponseSchema.safeParse({
        accounts: [{ ...account, online: undefined }],
        pagination,
      }).success,
    ).toBe(false);
  });

  it("coerces and bounds account pagination while using status-based filters", () => {
    expect(
      adminAccountsQuerySchema.parse({
        page: "2",
        pageSize: "50",
        status: "disabled",
        username: "  用户  ",
      }),
    ).toEqual({ page: 2, pageSize: 50, status: "disabled", username: "用户" });
    expect(adminAccountsQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(adminAccountsQuerySchema.safeParse({ enabled: "true" }).success).toBe(false);
  });

  it("applies persisted username and new-password rules to account creation", () => {
    expect(
      createAccountRequestSchema.safeParse({ username: "用户001", password: "安全密码12" }).success,
    ).toBe(true);
    expect(
      createAccountRequestSchema.safeParse({ username: "用户", password: "安全密码12" }).success,
    ).toBe(false);
    expect(
      createAccountRequestSchema.safeParse({ username: "用户001", password: "12345" }).success,
    ).toBe(false);
    expect(updateAccountRequestSchema.safeParse({ status: "disabled" }).success).toBe(true);
    expect(updateAccountRequestSchema.safeParse({ enabled: false }).success).toBe(false);
  });

  it("matches site and game service route DTOs", () => {
    const site = {
      enabled: false,
      maintenanceMessage: "系统维护中",
      updatedAt: "2026-07-16T10:00:00.000Z",
    };
    const game = {
      gameId: "test-game",
      displayName: "测试游戏",
      enabled: true,
      updatedAt: "2026-07-16T10:00:00.000Z",
    };

    expect(adminServicesResponseSchema.safeParse({ site, games: [game] }).success).toBe(true);
    expect(updateSiteServiceResponseSchema.safeParse({ site }).success).toBe(true);
    expect(updateGameServiceResponseSchema.safeParse({ game }).success).toBe(true);
    expect(
      updateSiteServiceRequestSchema.parse({
        enabled: false,
        maintenanceMessage: "  系统维护中  ",
      }),
    ).toEqual({ enabled: false, maintenanceMessage: "系统维护中" });
    expect(
      adminServicesResponseSchema.safeParse({
        site: { enabled: false, updatedAt: site.updatedAt },
        games: [game],
      }).success,
    ).toBe(false);
    expect(
      adminServicesResponseSchema.safeParse({
        site,
        games: [{ ...game, displayName: undefined }],
      }).success,
    ).toBe(false);
  });

  it("supports anonymous and deleted audit actors in paginated responses", () => {
    const common = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      createdAt: "2026-07-16T10:00:00.000Z",
      actorAccountId: null,
      action: "auth.login",
      targetType: "account",
      targetId: null,
      targetLabel: "unknown-user",
      result: "failure",
      sourceIp: null,
      requestId: "bootstrap-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      metadata: { reason: "credentials_invalid" },
    } as const;
    const response = {
      logs: [
        { ...common, actorUsername: "anonymous" },
        {
          ...common,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          actorUsername: "已删除用户01",
          result: "success",
          sourceIp: "127.0.0.1",
        },
      ],
      pagination: { page: 2, pageSize: 20, total: 25 },
    };

    expect(auditResponseSchema.safeParse(response).success).toBe(true);
    expect(
      auditResponseSchema.safeParse({
        entries: response.logs,
        pagination: response.pagination,
      }).success,
    ).toBe(false);
  });

  it("parses audit filters and models no-content deletion", () => {
    expect(auditQuerySchema.parse({ page: "3", pageSize: "25", result: "failure" })).toEqual({
      page: 3,
      pageSize: 25,
      result: "failure",
    });
    expect(auditQuerySchema.safeParse({ result: "unknown" }).success).toBe(false);
    expect(deleteAccountResponseSchema.safeParse(undefined).success).toBe(true);
    expect(deleteAccountResponseSchema.safeParse({ deleted: true }).success).toBe(false);
  });
});
