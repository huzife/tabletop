import { describe, expect, it } from "vitest";

import {
  changePasswordRequestSchema,
  emptyResponseSchema,
  loginRequestSchema,
  passwordSchema,
  sessionResponseSchema,
  usernameSchema,
} from "./auth.js";

describe("authentication HTTP schemas", () => {
  it("normalizes and validates persisted usernames", () => {
    expect(usernameSchema.parse("  Ａlice-张_1  ")).toBe("Alice-张_1");
    expect(usernameSchema.safeParse("张三").success).toBe(false);
    expect(usernameSchema.safeParse("张".repeat(32)).success).toBe(true);
    expect(usernameSchema.safeParse("张".repeat(33)).success).toBe(false);
    expect(usernameSchema.safeParse("user.name").success).toBe(false);
  });

  it("counts password limits in Unicode code points", () => {
    expect(passwordSchema.safeParse("密".repeat(6)).success).toBe(true);
    expect(passwordSchema.safeParse("🔐".repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse("🔐".repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse("short").success).toBe(false);
  });

  it("accepts bounded login candidates without applying account-creation rules", () => {
    expect(loginRequestSchema.safeParse({ username: "?", password: "" }).success).toBe(true);
    expect(
      loginRequestSchema.safeParse({ username: "🔐".repeat(128), password: "🔐".repeat(128) })
        .success,
    ).toBe(true);
    expect(
      loginRequestSchema.safeParse({ username: "🔐".repeat(129), password: "candidate" }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.safeParse({ username: "candidate", password: "🔐".repeat(129) }).success,
    ).toBe(false);
  });

  it("uses candidate rules only for the current password", () => {
    expect(
      changePasswordRequestSchema.safeParse({ currentPassword: "", newPassword: "new密码12" })
        .success,
    ).toBe(true);
    expect(
      changePasswordRequestSchema.safeParse({ currentPassword: "old", newPassword: "12345" })
        .success,
    ).toBe(false);
  });

  it("matches the nested session wire DTO exactly", () => {
    const response = {
      account: { id: "account-1", role: "user", username: "用户001" },
      session: { id: "session-1", expiresAt: "2026-08-15T10:00:00.000Z" },
    };

    expect(sessionResponseSchema.safeParse(response).success).toBe(true);
    expect(
      sessionResponseSchema.safeParse({
        account: { accountId: "account-1", role: "user", username: "用户001" },
        expiresAt: response.session.expiresAt,
      }).success,
    ).toBe(false);
    expect(
      sessionResponseSchema.safeParse({
        ...response,
        session: { ...response.session, csrfToken: "must-not-leak" },
      }).success,
    ).toBe(false);
  });

  it("represents HTTP 204 as no response body", () => {
    expect(emptyResponseSchema.safeParse(undefined).success).toBe(true);
    expect(emptyResponseSchema.safeParse({}).success).toBe(false);
  });
});
