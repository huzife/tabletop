import {
  accountMutationResponseSchema,
  adminAccountsResponseSchema,
  adminServicesResponseSchema,
  auditResponseSchema,
  changePasswordRequestSchema,
  createAccountRequestSchema,
  createRoomRequestSchema,
  createRoomResponseSchema,
  emptyResponseSchema,
  gamesResponseSchema,
  joinTicketResponseSchema,
  loginRequestSchema,
  resetPasswordRequestSchema,
  roomsResponseSchema,
  sessionResponseSchema,
  updateAccountRequestSchema,
  updateGameServiceRequestSchema,
  updateGameServiceResponseSchema,
  updateSiteServiceRequestSchema,
  updateSiteServiceResponseSchema,
  type AdminAccountsResponse,
  type AdminServicesResponse,
  type AuditResponse,
  type CreateRoomRequest,
  type GamesResponse,
  type RoomsResponse,
  type SessionResponse,
} from "@tabletop/protocol/http";
import { apiErrorResponseSchema } from "@tabletop/protocol";
import type { z } from "zod";

const API_PREFIX = "/api/v1";

export class ApiClientError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
  readonly status: number;

  constructor(options: {
    readonly code: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly message: string;
    readonly requestId?: string;
    readonly status: number;
  }) {
    super(options.message);
    this.name = "ApiClientError";
    this.code = options.code;
    this.details = options.details ?? {};
    if (options.requestId !== undefined) this.requestId = options.requestId;
    this.status = options.status;
  }
}

async function request<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  options: RequestInit = {},
): Promise<z.output<TSchema>> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase())) {
    const csrf = readCookie("tt_csrf");
    if (csrf) headers.set("x-csrf-token", csrf);
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  if (response.status === 204) {
    return schema.parse(undefined);
  }
  return schema.parse(await response.json());
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    credentials: "include",
    headers: { accept: "text/csv" },
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return response.blob();
}

async function responseError(response: Response): Promise<ApiClientError> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  const parsed = apiErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    return new ApiClientError({
      code: parsed.data.error.code,
      details: parsed.data.error.details,
      message: parsed.data.error.message,
      ...(parsed.data.error.requestId === undefined
        ? {}
        : { requestId: parsed.data.error.requestId }),
      status: response.status,
    });
  }
  return new ApiClientError({
    code: "HTTP_ERROR",
    message: "服务器暂时无法处理请求",
    status: response.status,
  });
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function queryString(
  values: Readonly<Record<string, boolean | number | string | undefined>>,
): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") parameters.set(key, String(value));
  }
  const query = parameters.toString();
  return query ? `?${query}` : "";
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

export const authApi = {
  changePassword(input: { currentPassword: string; newPassword: string }) {
    const body = changePasswordRequestSchema.parse(input);
    return request("/auth/change-password", sessionResponseSchema, {
      body: jsonBody(body),
      method: "POST",
    });
  },
  login(input: { password: string; username: string }) {
    const body = loginRequestSchema.parse(input);
    return request("/auth/login", sessionResponseSchema, {
      body: jsonBody(body),
      method: "POST",
    });
  },
  logout() {
    return request("/auth/logout", emptyResponseSchema, {
      method: "POST",
    });
  },
  session() {
    return request("/auth/session", sessionResponseSchema);
  },
};

export const lobbyApi = {
  createRoom(input: CreateRoomRequest) {
    const body = createRoomRequestSchema.parse(input);
    return request("/rooms", createRoomResponseSchema, {
      body: jsonBody(body),
      method: "POST",
    });
  },
  games(): Promise<GamesResponse> {
    return request("/games", gamesResponseSchema);
  },
  inviteJoinTicket(inviteToken: string) {
    return request(
      `/invites/${encodeURIComponent(inviteToken)}/join-ticket`,
      joinTicketResponseSchema,
      {
        body: "{}",
        method: "POST",
      },
    );
  },
  roomJoinTicket(roomId: string, password?: string) {
    return request(`/rooms/${encodeURIComponent(roomId)}/join-ticket`, joinTicketResponseSchema, {
      body: jsonBody(password === undefined ? {} : { password }),
      method: "POST",
    });
  },
  rooms(
    filters: { gameId?: string; joinable?: boolean; status?: string } = {},
  ): Promise<RoomsResponse> {
    return request(`/rooms${queryString(filters)}`, roomsResponseSchema);
  },
};

export const adminApi = {
  accounts(
    filters: {
      page?: number;
      pageSize?: number;
      status?: "disabled" | "enabled";
      username?: string;
    } = {},
  ): Promise<AdminAccountsResponse> {
    return request(`/admin/accounts${queryString(filters)}`, adminAccountsResponseSchema);
  },
  audit(
    filters: {
      accountId?: string;
      action?: string;
      from?: string;
      page?: number;
      pageSize?: number;
      result?: "failure" | "success";
      to?: string;
    } = {},
  ): Promise<AuditResponse> {
    return request(`/admin/audit${queryString(filters)}`, auditResponseSchema);
  },
  auditCsvUrl(filters: Readonly<Record<string, string | undefined>> = {}) {
    return `${API_PREFIX}/admin/audit.csv${queryString(filters)}`;
  },
  downloadAuditCsv(
    filters: {
      accountId?: string;
      action?: string;
      from?: string;
      result?: "failure" | "success";
      to?: string;
    } = {},
  ) {
    return requestBlob(`/admin/audit.csv${queryString(filters)}`);
  },
  createAccount(input: { password: string; username: string }) {
    const body = createAccountRequestSchema.parse(input);
    return request("/admin/accounts", accountMutationResponseSchema, {
      body: jsonBody(body),
      method: "POST",
    });
  },
  deleteAccount(accountId: string) {
    return request(`/admin/accounts/${encodeURIComponent(accountId)}`, emptyResponseSchema, {
      method: "DELETE",
    });
  },
  resetPassword(accountId: string, newPassword: string) {
    const body = resetPasswordRequestSchema.parse({ newPassword });
    return request(
      `/admin/accounts/${encodeURIComponent(accountId)}/reset-password`,
      emptyResponseSchema,
      {
        body: jsonBody(body),
        method: "POST",
      },
    );
  },
  services(): Promise<AdminServicesResponse> {
    return request("/admin/services", adminServicesResponseSchema);
  },
  updateAccount(accountId: string, status: "disabled" | "enabled") {
    const body = updateAccountRequestSchema.parse({ status });
    return request(
      `/admin/accounts/${encodeURIComponent(accountId)}`,
      accountMutationResponseSchema,
      {
        body: jsonBody(body),
        method: "PATCH",
      },
    );
  },
  updateGame(gameId: string, enabled: boolean) {
    const body = updateGameServiceRequestSchema.parse({ enabled });
    return request(
      `/admin/services/games/${encodeURIComponent(gameId)}`,
      updateGameServiceResponseSchema,
      { body: jsonBody(body), method: "PUT" },
    );
  },
  updateSite(enabled: boolean, maintenanceMessage?: string) {
    const body = updateSiteServiceRequestSchema.parse({
      enabled,
      ...(maintenanceMessage === undefined ? {} : { maintenanceMessage }),
    });
    return request("/admin/services/site", updateSiteServiceResponseSchema, {
      body: jsonBody(body),
      method: "PUT",
    });
  },
};

export type { SessionResponse };
