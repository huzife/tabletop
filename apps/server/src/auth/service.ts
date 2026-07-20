import {
  normalizeUsername,
  type Account,
  type Session,
  type TabletopRepositories,
  UsernameValidationError,
} from "@tabletop/database";

import { HttpError } from "../http/errors.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { SlidingWindowRateLimiter } from "../lib/rate-limiter.js";
import { SESSION_REFRESH_INTERVAL_MS, SESSION_TTL_MS } from "./cookies.js";
import { PasswordService, passwordSchema } from "./password.js";
import { createSecretToken, hashSecretToken, secretTokenMatches } from "./session-token.js";

export interface RequestAuditContext {
  readonly requestId: string;
  readonly sourceIp: string | null;
}

export interface AuthenticatedSession {
  readonly account: Account;
  readonly session: Session;
}

export interface IssuedSession extends AuthenticatedSession {
  readonly csrfToken: string;
  readonly sessionToken: string;
}

export interface SessionResolution extends AuthenticatedSession {
  readonly refreshed: boolean;
}

const INVALID_CREDENTIALS = new HttpError(401, "AUTH_INVALID_CREDENTIALS", "用户名或密码错误");

export class AuthService {
  readonly #accountLocks: KeyedMutex<string>;
  readonly #dummyHash: Promise<string>;
  readonly #ipLoginLimiter = new SlidingWindowRateLimiter({ limit: 20, windowMs: 5 * 60_000 });
  readonly #passwords: PasswordService;
  readonly #repositories: TabletopRepositories;
  readonly #sessionSecret: string;
  readonly #usernameLoginLimiter = new SlidingWindowRateLimiter({
    limit: 10,
    windowMs: 5 * 60_000,
  });

  constructor(
    repositories: TabletopRepositories,
    sessionSecret: string,
    passwords = new PasswordService(),
    accountLocks = new KeyedMutex<string>(),
  ) {
    if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
      throw new TypeError("session secret must contain at least 32 bytes");
    }
    this.#repositories = repositories;
    this.#sessionSecret = sessionSecret;
    this.#passwords = passwords;
    this.#accountLocks = accountLocks;
    this.#dummyHash = passwords.hash("tabletop-dummy-password");
  }

  async login(
    usernameInput: string,
    password: string,
    context: RequestAuditContext,
    now = Date.now(),
  ): Promise<IssuedSession> {
    const usernameKey = safeUsernameKey(usernameInput);
    this.#enforceLoginRateLimits(usernameKey, context.sourceIp, now);

    let candidateAccount: Account | undefined;
    try {
      candidateAccount = this.#repositories.accounts.findByUsername(usernameInput);
    } catch (error) {
      if (!(error instanceof UsernameValidationError)) {
        throw error;
      }
    }
    const lockKey = candidateAccount
      ? accountLockKey(candidateAccount.id)
      : usernameLockKey(usernameKey);

    return this.#accountLocks.run(lockKey, async () => {
      let account: Account | undefined;
      try {
        account = this.#repositories.accounts.findByUsername(usernameInput);
      } catch (error) {
        if (!(error instanceof UsernameValidationError)) {
          throw error;
        }
      }

      const passwordHash = account?.passwordHash ?? (await this.#dummyHash);
      const passwordMatches = await this.#passwords.verify(passwordHash, password);
      if (!account || account.status !== "enabled" || !passwordMatches) {
        this.#appendLoginFailure(usernameInput, context);
        throw INVALID_CREDENTIALS;
      }

      return this.#issueSession(account, now);
    });
  }

  resolveSession(sessionToken: string | undefined, now = Date.now()): SessionResolution {
    if (!sessionToken) {
      throw new HttpError(401, "AUTH_SESSION_EXPIRED", "登录状态已失效，请重新登录");
    }

    const active = this.#repositories.sessions.findActiveByTokenHash(
      hashSecretToken(sessionToken, this.#sessionSecret),
      now,
    );
    if (!active) {
      throw new HttpError(401, "AUTH_SESSION_EXPIRED", "登录状态已失效，请重新登录");
    }

    if (now - active.session.lastSeenAt < SESSION_REFRESH_INTERVAL_MS) {
      return { ...active, refreshed: false };
    }

    const refreshedSession = this.#repositories.sessions.touch(
      active.session.id,
      now + SESSION_TTL_MS,
      now,
    );
    if (!refreshedSession) {
      throw new HttpError(401, "AUTH_SESSION_EXPIRED", "登录状态已失效，请重新登录");
    }

    return { account: active.account, refreshed: true, session: refreshedSession };
  }

  verifyCsrf(
    session: Session,
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
  ): void {
    if (
      !csrfCookie ||
      !csrfHeader ||
      csrfCookie !== csrfHeader ||
      !secretTokenMatches(session.csrfSecretHash, csrfHeader, this.#sessionSecret)
    ) {
      throw new HttpError(403, "AUTH_CSRF_INVALID", "请求验证已失效，请刷新页面后重试");
    }
  }

  logout(sessionId: string | undefined, now = Date.now()): void {
    if (sessionId) {
      this.#repositories.sessions.revoke(sessionId, now);
    }
  }

  async changePassword(
    identity: AuthenticatedSession,
    currentPassword: string,
    newPassword: string,
    context: RequestAuditContext,
    now = Date.now(),
  ): Promise<IssuedSession> {
    passwordSchema.parse(newPassword);

    return this.#accountLocks.run(accountLockKey(identity.account.id), async () => {
      const account = this.#repositories.accounts.findById(identity.account.id);
      if (!account || account.status !== "enabled") {
        throw new HttpError(401, "AUTH_SESSION_EXPIRED", "登录状态已失效，请重新登录");
      }

      if (!(await this.#passwords.verify(account.passwordHash, currentPassword))) {
        throw new HttpError(400, "AUTH_CURRENT_PASSWORD_INVALID", "当前密码不正确");
      }

      const passwordHash = await this.#passwords.hash(newPassword);
      const sessionToken = createSecretToken(this.#sessionSecret);
      const csrfToken = createSecretToken(this.#sessionSecret);
      const expiresAt = now + SESSION_TTL_MS;

      const result = this.#repositories.transaction((repositories) => {
        const updatedAccount = repositories.accounts.updatePasswordHash(
          account.id,
          passwordHash,
          now,
        );
        if (!updatedAccount) {
          throw new Error("修改密码时账号不存在");
        }

        repositories.sessions.revokeAllForAccount(account.id, now);
        const session = repositories.sessions.create({
          accountId: account.id,
          csrfSecretHash: csrfToken.hash,
          expiresAt,
          now,
          tokenHash: sessionToken.hash,
        });
        repositories.audit.append({
          action: "account.password.change",
          actorAccountId: account.id,
          actorUsername: updatedAccount.username,
          metadata: {},
          now,
          requestId: context.requestId,
          result: "success",
          sourceIp: context.sourceIp,
          targetId: account.id,
          targetLabel: updatedAccount.username,
          targetType: "account",
        });

        return { account: updatedAccount, session };
      });

      return {
        ...result,
        csrfToken: csrfToken.value,
        sessionToken: sessionToken.value,
      };
    });
  }

  #appendLoginFailure(attemptedUsername: string, context: RequestAuditContext): void {
    const targetLabel = attemptedUsername.trim().normalize("NFKC").slice(0, 64);
    this.#repositories.audit.append({
      action: "auth.login",
      actorAccountId: null,
      actorUsername: "anonymous",
      metadata: { reason: "credentials_invalid" },
      requestId: context.requestId,
      result: "failure",
      sourceIp: context.sourceIp,
      targetLabel,
      targetType: "account",
    });
  }

  #enforceLoginRateLimits(usernameKey: string, sourceIp: string | null, now: number): void {
    const usernameResult = this.#usernameLoginLimiter.consume(usernameKey, now);
    const ipResult = this.#ipLoginLimiter.consume(sourceIp ?? "unknown", now);
    if (!usernameResult.allowed || !ipResult.allowed) {
      throw new HttpError(429, "AUTH_RATE_LIMITED", "登录尝试过于频繁，请稍后重试", {
        retryAfterSeconds: Math.ceil(
          Math.max(usernameResult.retryAfterMs, ipResult.retryAfterMs) / 1_000,
        ),
      });
    }
  }

  #issueSession(account: Account, now: number): IssuedSession {
    const sessionToken = createSecretToken(this.#sessionSecret);
    const csrfToken = createSecretToken(this.#sessionSecret);
    const session = this.#repositories.sessions.create({
      accountId: account.id,
      csrfSecretHash: csrfToken.hash,
      expiresAt: now + SESSION_TTL_MS,
      now,
      tokenHash: sessionToken.hash,
    });

    return {
      account,
      csrfToken: csrfToken.value,
      session,
      sessionToken: sessionToken.value,
    };
  }
}

function safeUsernameKey(username: string): string {
  try {
    return normalizeUsername(username).normalized;
  } catch (error) {
    if (error instanceof UsernameValidationError) {
      return username.trim().normalize("NFKC").toLowerCase().slice(0, 64);
    }
    throw error;
  }
}

export function accountLockKey(accountId: string): string {
  return `account:${accountId}`;
}

export function usernameLockKey(normalizedUsername: string): string {
  return `username:${normalizedUsername}`;
}
