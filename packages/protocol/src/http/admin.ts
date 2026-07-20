import { z } from "zod";

import { accountIdSchema, gameIdSchema, utcDateTimeSchema } from "../ids.js";
import { jsonObjectSchema } from "../json.js";
import { passwordSchema, usernameSchema } from "./auth.js";
import { paginationMetaSchema, paginationQuerySchema } from "./common.js";

export const accountStatusSchema = z.enum(["enabled", "disabled"]);

export const adminAccountSchema = z.strictObject({
  id: accountIdSchema,
  username: usernameSchema,
  status: accountStatusSchema,
  online: z.boolean(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
});

export const adminAccountsQuerySchema = paginationQuerySchema.extend({
  status: accountStatusSchema.optional(),
  username: z.string().trim().max(32).optional(),
});

export const adminAccountsResponseSchema = z.strictObject({
  accounts: z.array(adminAccountSchema),
  pagination: paginationMetaSchema,
});

export const createAccountRequestSchema = z.strictObject({
  username: usernameSchema,
  password: passwordSchema,
});

export const updateAccountRequestSchema = z.strictObject({
  status: accountStatusSchema,
});

export const resetPasswordRequestSchema = z.strictObject({
  newPassword: passwordSchema,
});

export const accountMutationResponseSchema = z.strictObject({
  account: adminAccountSchema,
});

export const deleteAccountResponseSchema = z.undefined();

export const maintenanceMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), {
    message: "maintenance message contains unsupported control characters",
  });

export const siteServiceStatusSchema = z.strictObject({
  enabled: z.boolean(),
  maintenanceMessage: maintenanceMessageSchema,
  updatedAt: utcDateTimeSchema,
});

export const gameServiceStatusSchema = z.strictObject({
  gameId: gameIdSchema,
  displayName: z.string().min(1).max(80),
  enabled: z.boolean(),
  updatedAt: utcDateTimeSchema,
});

export const serviceStatusSchema = z.union([siteServiceStatusSchema, gameServiceStatusSchema]);

export const adminServicesResponseSchema = z.strictObject({
  site: siteServiceStatusSchema,
  games: z.array(gameServiceStatusSchema),
});

export const updateSiteServiceRequestSchema = z.strictObject({
  enabled: z.boolean(),
  maintenanceMessage: maintenanceMessageSchema.optional(),
});

export const updateGameServiceRequestSchema = z.strictObject({
  enabled: z.boolean(),
});

export const updateServiceStatusRequestSchema = z.union([
  updateSiteServiceRequestSchema,
  updateGameServiceRequestSchema,
]);

export const updateSiteServiceResponseSchema = z.strictObject({
  site: siteServiceStatusSchema,
});

export const updateGameServiceResponseSchema = z.strictObject({
  game: gameServiceStatusSchema,
});

export const updateServiceStatusResponseSchema = z.union([
  updateSiteServiceResponseSchema,
  updateGameServiceResponseSchema,
]);

export const auditResultSchema = z.enum(["success", "failure"]);

export const auditQuerySchema = paginationQuerySchema.extend({
  accountId: accountIdSchema.optional(),
  action: z.string().min(1).max(64).optional(),
  from: utcDateTimeSchema.optional(),
  result: auditResultSchema.optional(),
  to: utcDateTimeSchema.optional(),
});

export const auditEntrySchema = z.strictObject({
  id: z.string().min(1).max(128),
  createdAt: utcDateTimeSchema,
  actorAccountId: accountIdSchema.nullable(),
  actorUsername: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  targetType: z.string().min(1).max(64),
  targetId: z.string().max(128).nullable(),
  targetLabel: z.string().max(200).nullable(),
  result: auditResultSchema,
  sourceIp: z.string().min(1).max(128).nullable(),
  requestId: z.string().min(1).max(128),
  metadata: jsonObjectSchema,
});

export const auditResponseSchema = z.strictObject({
  logs: z.array(auditEntrySchema),
  pagination: paginationMetaSchema,
});

export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type AdminAccount = z.infer<typeof adminAccountSchema>;
export type AdminAccountsQuery = z.infer<typeof adminAccountsQuerySchema>;
export type AdminAccountsResponse = z.infer<typeof adminAccountsResponseSchema>;
export type AdminServicesResponse = z.infer<typeof adminServicesResponseSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type AuditResponse = z.infer<typeof auditResponseSchema>;
export type AuditResult = z.infer<typeof auditResultSchema>;
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;
export type GameServiceStatus = z.infer<typeof gameServiceStatusSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type SiteServiceStatus = z.infer<typeof siteServiceStatusSchema>;
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;
export type UpdateGameServiceRequest = z.infer<typeof updateGameServiceRequestSchema>;
export type UpdateServiceStatusRequest = z.infer<typeof updateServiceStatusRequestSchema>;
export type UpdateSiteServiceRequest = z.infer<typeof updateSiteServiceRequestSchema>;
