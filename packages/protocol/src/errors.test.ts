import { describe, expect, it } from "vitest";

import { PLATFORM_ERROR_CODES, platformErrorCodeSchema } from "./errors.js";

const stableServerErrorCodes = [
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_SESSION_EXPIRED",
  "AUTH_ADMIN_REQUIRED",
  "AUTH_CSRF_INVALID",
  "AUTH_ORIGIN_INVALID",
  "AUTH_CURRENT_PASSWORD_INVALID",
  "AUTH_RATE_LIMITED",
  "ACCOUNT_USERNAME_EXISTS",
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_NOT_OFFLINE",
  "ADMIN_SELF_PROTECTED",
  "GAME_SERVICE_NOT_FOUND",
  "RATE_ADMIN_LIMIT",
  "RATE_ROOM_LIMIT",
  "VALIDATION_FAILED",
  "INTERNAL_ERROR",
] as const;

describe("platform error codes", () => {
  it("includes every stable error currently emitted by the HTTP server", () => {
    expect(PLATFORM_ERROR_CODES).toEqual(expect.arrayContaining([...stableServerErrorCodes]));
    for (const code of stableServerErrorCodes) {
      expect(platformErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });
});
