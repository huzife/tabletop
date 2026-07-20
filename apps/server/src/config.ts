import { z } from "zod";

const booleanFromEnvironment = z.enum(["true", "false"]).transform((value) => value === "true");

const trustProxySchema = z.union([booleanFromEnvironment, z.literal("loopback")]).default(false);

const environmentSchema = z.object({
  COOKIE_SECURE: booleanFromEnvironment.default(false),
  DATABASE_PATH: z.string().min(1).default("./var/tabletop.db"),
  GAME_AI_WORKERS: z.coerce.number().int().min(0).max(1).default(1),
  HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SESSION_SECRET: z.string().min(32),
  TRUST_PROXY: trustProxySchema,
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return environmentSchema.parse(environment);
}
