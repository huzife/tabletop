import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { ulid } from "ulid";

import { registerAdminRoutes } from "./admin/routes.js";
import type { AdminService } from "./admin/service.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { AuthService } from "./auth/service.js";
import type { AppConfig } from "./config.js";
import { registerErrorHandling } from "./http/errors.js";
import { registerRoomRoutes } from "./rooms/routes.js";
import type { RoomRegistry } from "./rooms/registry.js";

export interface ReadinessResult {
  readonly checks?: Readonly<Record<string, "ok" | "error">>;
  readonly ready: boolean;
}

export interface BuildAppOptions {
  readonly admin?: AdminService;
  readonly auth?: AuthService;
  readonly config: Pick<AppConfig, "COOKIE_SECURE" | "LOG_LEVEL" | "NODE_ENV" | "TRUST_PROXY">;
  readonly logger?: FastifyBaseLogger | boolean;
  readonly readiness?: () => Promise<ReadinessResult>;
  readonly rooms?: RoomRegistry;
}

const defaultReadiness = async (): Promise<ReadinessResult> => ({ ready: true });

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 64 * 1024,
    genReqId: () => ulid(),
    logger: options.logger ?? { level: options.config.LOG_LEVEL },
    trustProxy: options.config.TRUST_PROXY,
  });

  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    origin: options.config.NODE_ENV === "development" ? true : false,
  });

  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  registerErrorHandling(app);

  if (options.auth) {
    await registerAuthRoutes(app, {
      auth: options.auth,
      cookieSecure: options.config.COOKIE_SECURE,
    });
  }
  if (options.admin && options.auth) {
    await registerAdminRoutes(app, { admin: options.admin, auth: options.auth });
  } else if (options.admin) {
    throw new TypeError("Admin routes require an authentication service");
  }
  if (options.rooms && options.auth) {
    await registerRoomRoutes(app, { auth: options.auth, rooms: options.rooms });
  } else if (options.rooms) {
    throw new TypeError("Room routes require an authentication service");
  }

  app.get("/health/live", async (_request, reply) => {
    return reply.header("cache-control", "no-store").send({ status: "ok" });
  });

  app.get("/health/ready", async (_request, reply) => {
    const result = await (options.readiness ?? defaultReadiness)();
    const statusCode = result.ready ? 200 : 503;

    return reply
      .code(statusCode)
      .header("cache-control", "no-store")
      .send({ checks: result.checks, status: result.ready ? "ready" : "not_ready" });
  });

  app.get("/api/v1", async () => ({ name: "tabletop", version: 1 }));

  return app;
}
