import {
  changePasswordRequestSchema,
  loginRequestSchema,
  sessionResponseSchema,
} from "@tabletop/protocol/http";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import { HttpError } from "../http/errors.js";
import { SlidingWindowRateLimiter } from "../lib/rate-limiter.js";
import {
  clearSessionCookies,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  setSessionCookies,
} from "./cookies.js";
import { auditContext, requireSession, requireUnsafeSession } from "./request.js";
import {
  AuthService,
  type AuthenticatedSession,
  type IssuedSession,
  type SessionResolution,
} from "./service.js";

interface AuthRoutesOptions {
  readonly auth: AuthService;
  readonly cookieSecure: AppConfig["COOKIE_SECURE"];
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const { auth, cookieSecure } = options;
  const passwordChangeLimiter = new SlidingWindowRateLimiter({
    limit: 5,
    windowMs: 15 * 60_000,
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const issued = await auth.login(body.username, body.password, auditContext(request));
    applyIssuedCookies(reply, issued, cookieSecure);
    return reply.header("cache-control", "no-store").send(sessionDto(issued));
  });

  app.get("/api/v1/auth/session", async (request, reply) => {
    const resolution = requireSession(auth, request);
    if (resolution.refreshed) {
      const sessionToken = request.cookies[SESSION_COOKIE_NAME];
      const csrfToken = request.cookies[CSRF_COOKIE_NAME];
      if (sessionToken && csrfToken) {
        setSessionCookies(
          reply,
          { csrfToken, expiresAt: resolution.session.expiresAt, sessionToken },
          cookieSecure,
        );
      }
    }
    return reply.header("cache-control", "no-store").send(sessionDto(resolution));
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    let resolution: SessionResolution | undefined;
    try {
      resolution = requireUnsafeSession(auth, request);
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== "AUTH_SESSION_EXPIRED") {
        throw error;
      }
    }

    auth.logout(resolution?.session.id);
    clearSessionCookies(reply, cookieSecure);
    return reply.code(204).send();
  });

  app.post("/api/v1/auth/change-password", async (request, reply) => {
    const resolution = requireUnsafeSession(auth, request);
    enforceRateLimit(passwordChangeLimiter, resolution.account.id);
    const body = changePasswordRequestSchema.parse(request.body);
    const issued = await auth.changePassword(
      resolution,
      body.currentPassword,
      body.newPassword,
      auditContext(request),
    );
    applyIssuedCookies(reply, issued, cookieSecure);
    return reply.header("cache-control", "no-store").send(sessionDto(issued));
  });
}

function enforceRateLimit(limiter: SlidingWindowRateLimiter, key: string): void {
  const result = limiter.consume(key);
  if (!result.allowed) {
    throw new HttpError(429, "AUTH_RATE_LIMITED", "操作过于频繁，请稍后重试", {
      retryAfterSeconds: Math.ceil(result.retryAfterMs / 1_000),
    });
  }
}

function applyIssuedCookies(
  reply: Parameters<typeof setSessionCookies>[0],
  issued: IssuedSession,
  secure: boolean,
): void {
  setSessionCookies(
    reply,
    {
      csrfToken: issued.csrfToken,
      expiresAt: issued.session.expiresAt,
      sessionToken: issued.sessionToken,
    },
    secure,
  );
}

function sessionDto(identity: AuthenticatedSession) {
  return sessionResponseSchema.parse({
    account: {
      id: identity.account.id,
      role: identity.account.role,
      username: identity.account.username,
    },
    session: {
      expiresAt: new Date(identity.session.expiresAt).toISOString(),
      id: identity.session.id,
    },
  });
}
