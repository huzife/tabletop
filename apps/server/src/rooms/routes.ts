import {
  createRoomRequestSchema,
  createRoomResponseSchema,
  gamesResponseSchema,
  joinTicketRequestSchema,
  joinTicketResponseSchema,
  roomListQuerySchema,
  roomsResponseSchema,
} from "@tabletop/protocol/http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireSession, requireUnsafeSession } from "../auth/request.js";
import type { AuthService } from "../auth/service.js";
import { HttpError } from "../http/errors.js";
import { SlidingWindowRateLimiter } from "../lib/rate-limiter.js";
import { RoomRegistry } from "./registry.js";

interface RoomRoutesOptions {
  readonly auth: AuthService;
  readonly rooms: RoomRegistry;
}

export async function registerRoomRoutes(
  app: FastifyInstance,
  options: RoomRoutesOptions,
): Promise<void> {
  const { auth, rooms } = options;
  const createLimiter = new SlidingWindowRateLimiter({ limit: 5, windowMs: 60_000 });
  const joinTicketLimiter = new SlidingWindowRateLimiter({ limit: 30, windowMs: 60_000 });
  const passwordLimiter = new SlidingWindowRateLimiter({ limit: 10, windowMs: 60_000 });

  app.get("/api/v1/games", async (request, reply) => {
    const identity = requireSession(auth, request);
    const site = rooms.getSiteStatus();
    if (!site.enabled && identity.account.role !== "admin") {
      throw new HttpError(503, "SITE_DISABLED", site.maintenanceMessage);
    }
    return reply
      .header("cache-control", "no-store")
      .send(gamesResponseSchema.parse({ games: rooms.listGames() }));
  });

  app.get("/api/v1/rooms", async (request, reply) => {
    requireSession(auth, request);
    const query = roomListQuerySchema.parse(request.query);
    const roomsResponse = rooms
      .listPublicRooms()
      .filter((room) => (query.gameId ? room.gameId === query.gameId : true))
      .filter((room) => (query.status ? room.status === query.status : true))
      .filter((room) => (query.joinable === undefined ? true : room.joinable === query.joinable));
    return reply
      .header("cache-control", "no-store")
      .send(roomsResponseSchema.parse({ rooms: roomsResponse }));
  });

  app.post("/api/v1/rooms", async (request, reply) => {
    const identity = requireUnsafeSession(auth, request);
    enforceRoomRateLimit(createLimiter, identity.session.id);
    const body = createRoomRequestSchema.parse(request.body);
    const created = await rooms.createRoom({
      account: identity.account,
      ...(body.botProfileId === undefined ? {} : { botProfileId: body.botProfileId }),
      gameId: body.gameId,
      isCancelled: () => request.raw.aborted,
      name: body.name,
      ...(body.password === undefined ? {} : { password: body.password }),
      practice: body.practice,
      session: identity.session,
      settings: body.settings,
    });
    const origin = requestOrigin(request);
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .send(
        createRoomResponseSchema.parse({
          inviteUrl: `${origin}/invite/${created.room.state.inviteToken}`,
          joinTicket: created.ticket.token,
          joinTicketExpiresAt: new Date(created.ticket.expiresAt).toISOString(),
          roomId: created.room.state.roomId,
        }),
      );
  });

  app.post("/api/v1/rooms/:roomId/join-ticket", async (request, reply) => {
    const identity = requireUnsafeSession(auth, request);
    enforceRoomRateLimit(joinTicketLimiter, identity.session.id);
    const body = joinTicketRequestSchema.parse(request.body ?? {});
    if (body.password !== undefined) {
      enforceRoomRateLimit(passwordLimiter, identity.session.id);
    }
    const ticket = await rooms.issueListJoinTicket({
      ...(body.password === undefined ? {} : { password: body.password }),
      roomId: readPathParameter(request, "roomId"),
      session: identity.session,
    });
    return reply.header("cache-control", "no-store").send(
      joinTicketResponseSchema.parse({
        expiresAt: new Date(ticket.expiresAt).toISOString(),
        joinTicket: ticket.token,
        roomId: ticket.roomId,
      }),
    );
  });

  app.post("/api/v1/invites/:inviteToken/join-ticket", async (request, reply) => {
    const identity = requireUnsafeSession(auth, request);
    enforceRoomRateLimit(joinTicketLimiter, identity.session.id);
    const ticket = rooms.issueInviteJoinTicket({
      inviteToken: readPathParameter(request, "inviteToken"),
      session: identity.session,
    });
    return reply.header("cache-control", "no-store").send(
      joinTicketResponseSchema.parse({
        expiresAt: new Date(ticket.expiresAt).toISOString(),
        joinTicket: ticket.token,
        roomId: ticket.roomId,
      }),
    );
  });
}

function enforceRoomRateLimit(limiter: SlidingWindowRateLimiter, sessionId: string): void {
  const result = limiter.consume(sessionId);
  if (!result.allowed) {
    throw new HttpError(429, "RATE_ROOM_LIMIT", "房间操作过于频繁，请稍后重试", {
      retryAfterSeconds: Math.ceil(result.retryAfterMs / 1_000),
    });
  }
}

function readPathParameter(request: FastifyRequest, name: string): string {
  return z
    .string()
    .min(1)
    .max(256)
    .parse((request.params as Record<string, unknown>)[name]);
}

function requestOrigin(request: FastifyRequest): string {
  const host = request.headers.host;
  if (!host) {
    throw new HttpError(400, "VALIDATION_FAILED", "请求缺少 Host");
  }
  return `${request.protocol}://${host}`;
}
