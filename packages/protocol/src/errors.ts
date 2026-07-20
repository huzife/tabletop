import { z } from "zod";

import { jsonObjectSchema } from "./json.js";
import { requestIdSchema } from "./ids.js";

export const PLATFORM_ERROR_CODES = [
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_SESSION_EXPIRED",
  "AUTH_ADMIN_REQUIRED",
  "AUTH_CSRF_INVALID",
  "AUTH_ORIGIN_INVALID",
  "AUTH_CURRENT_PASSWORD_INVALID",
  "AUTH_RATE_LIMITED",
  "AUTH_FORBIDDEN",
  "ACCOUNT_USERNAME_EXISTS",
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_NOT_OFFLINE",
  "ADMIN_SELF_PROTECTED",
  "SITE_DISABLED",
  "GAME_SERVICE_DISABLED",
  "GAME_SERVICE_NOT_FOUND",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ROOM_PASSWORD_INVALID",
  "ROOM_PERMISSION_DENIED",
  "ROOM_INVALID_STATE",
  "CONNECTION_ROOM_CONFLICT",
  "REVISION_STALE",
  "GAME_ILLEGAL_ACTION",
  "RATE_ADMIN_LIMIT",
  "RATE_CHAT_LIMIT",
  "RATE_COMMAND_LIMIT",
  "RATE_ROOM_LIMIT",
  "VALIDATION_FAILED",
  "INTERNAL_ROOM_ABORTED",
  "INTERNAL_ERROR",
] as const;

export const platformErrorCodeSchema = z.enum(PLATFORM_ERROR_CODES);
export const errorCodeSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/);

export const apiErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1).max(500),
  requestId: requestIdSchema,
  details: jsonObjectSchema,
});

export const apiErrorResponseSchema = z.strictObject({
  error: apiErrorSchema,
});

export const commandErrorPayloadSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1).max(500),
  details: jsonObjectSchema,
  resyncRequired: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().safe().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type CommandErrorPayload = z.infer<typeof commandErrorPayloadSchema>;
export type PlatformErrorCode = z.infer<typeof platformErrorCodeSchema>;
