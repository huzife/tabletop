import type { FastifyReply } from "fastify";

export const SESSION_COOKIE_NAME = "tt_session";
export const CSRF_COOKIE_NAME = "tt_csrf";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface SessionCookieValues {
  readonly csrfToken: string;
  readonly expiresAt: number;
  readonly sessionToken: string;
}

export function setSessionCookies(
  reply: FastifyReply,
  values: SessionCookieValues,
  secure: boolean,
): void {
  const common = {
    expires: new Date(values.expiresAt),
    maxAge: Math.max(0, Math.floor((values.expiresAt - Date.now()) / 1_000)),
    path: "/",
    sameSite: "lax" as const,
    secure,
  };

  void reply.setCookie(SESSION_COOKIE_NAME, values.sessionToken, {
    ...common,
    httpOnly: true,
  });
  void reply.setCookie(CSRF_COOKIE_NAME, values.csrfToken, {
    ...common,
    httpOnly: false,
  });
}

export function clearSessionCookies(reply: FastifyReply, secure: boolean): void {
  const common = { path: "/", sameSite: "lax" as const, secure };
  void reply.clearCookie(SESSION_COOKIE_NAME, { ...common, httpOnly: true });
  void reply.clearCookie(CSRF_COOKIE_NAME, { ...common, httpOnly: false });
}
