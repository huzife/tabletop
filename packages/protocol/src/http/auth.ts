import { z } from "zod";

import { accountIdSchema, sessionIdSchema, utcDateTimeSchema } from "../ids.js";

const codePointLength = (value: string): number => Array.from(value).length;
const usernameCharacters = /^[\p{Script=Han}A-Za-z0-9_-]+$/u;

export const accountRoleSchema = z.enum(["admin", "user"]);
export const usernameSchema = z
  .string()
  .transform((value) => value.trim().normalize("NFKC"))
  .refine((value) => codePointLength(value) >= 3 && codePointLength(value) <= 32, {
    message: "username must contain 3 to 32 Unicode code points",
  })
  .refine((value) => usernameCharacters.test(value), {
    message: "username contains unsupported characters",
  });

export const loginUsernameSchema = z.string().refine((value) => codePointLength(value) <= 128, {
  message: "login username candidate must not exceed 128 Unicode code points",
});

export const passwordCandidateSchema = z.string().refine((value) => codePointLength(value) <= 128, {
  message: "password candidate must not exceed 128 Unicode code points",
});

export const passwordSchema = z
  .string()
  .refine((value) => codePointLength(value) >= 6, {
    message: "password must contain at least 6 Unicode code points",
  })
  .refine((value) => codePointLength(value) <= 128, {
    message: "password must not exceed 128 Unicode code points",
  });

export const accountSummarySchema = z.strictObject({
  id: accountIdSchema,
  role: accountRoleSchema,
  username: usernameSchema,
});

export const loginRequestSchema = z.strictObject({
  username: loginUsernameSchema,
  password: passwordCandidateSchema,
});

export const sessionResponseSchema = z.strictObject({
  account: accountSummarySchema,
  session: z.strictObject({
    id: sessionIdSchema,
    expiresAt: utcDateTimeSchema,
  }),
});

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: passwordCandidateSchema,
  newPassword: passwordSchema,
});

export const emptyResponseSchema = z.undefined();

export type AccountRole = z.infer<typeof accountRoleSchema>;
export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type PasswordCandidate = z.infer<typeof passwordCandidateSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
