import type { FastifyRequest } from "fastify";

import { HttpError } from "../http/errors.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "./cookies.js";
import { AuthService, type RequestAuditContext, type SessionResolution } from "./service.js";

export function requireSession(auth: AuthService, request: FastifyRequest): SessionResolution {
  return auth.resolveSession(request.cookies[SESSION_COOKIE_NAME]);
}

export function requireUnsafeSession(
  auth: AuthService,
  request: FastifyRequest,
): SessionResolution {
  const resolution = requireSession(auth, request);
  requireSameOrigin(request);
  auth.verifyCsrf(
    resolution.session,
    request.cookies[CSRF_COOKIE_NAME],
    readSingleHeader(request.headers["x-csrf-token"]),
  );
  return resolution;
}

export function requireAdmin(
  auth: AuthService,
  request: FastifyRequest,
  unsafe = false,
): SessionResolution {
  const resolution = unsafe ? requireUnsafeSession(auth, request) : requireSession(auth, request);
  if (resolution.account.role !== "admin") {
    throw new HttpError(403, "AUTH_ADMIN_REQUIRED", "需要管理员权限");
  }
  return resolution;
}

export function auditContext(request: FastifyRequest): RequestAuditContext {
  return { requestId: request.id, sourceIp: request.ip || null };
}

function requireSameOrigin(request: FastifyRequest): void {
  const origin = readSingleHeader(request.headers.origin);
  const host = request.headers.host;
  if (!origin || !host || origin !== `${request.protocol}://${host}`) {
    throw new HttpError(403, "AUTH_ORIGIN_INVALID", "请求来源验证失败");
  }
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}
