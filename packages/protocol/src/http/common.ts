import { z } from "zod";

export const paginationQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const paginationMetaSchema = z.strictObject({
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
});

export type PaginationMeta = z.infer<typeof paginationMetaSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
