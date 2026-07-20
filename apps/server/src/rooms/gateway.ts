import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";

import type { Account, Session } from "@tabletop/database";
import {
  clientCommandSchema,
  connectionIdSchema,
  memberIdSchema,
  requestIdSchema,
  serverMessageSchema,
  type ClientCommand,
  type JsonObject,
  type MemberId,
  type RequestId,
} from "@tabletop/protocol";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import WebSocket, { WebSocketServer } from "ws";
import { ZodError } from "zod";

import type { AppConfig } from "../config.js";
import { HttpError } from "../http/errors.js";
import { SlidingWindowRateLimiter } from "../lib/rate-limiter.js";
import { SESSION_COOKIE_NAME } from "../auth/cookies.js";
import type { AuthService, AuthenticatedSession } from "../auth/service.js";
import { RoomRegistry } from "./registry.js";
import type { RoomRuntime } from "./room-runtime.js";
import type { RoomPublisher, RoomRuntimeLike } from "./types.js";

interface GatewayConnection {
  readonly connectionId: string;
  readonly rateLimiter: SlidingWindowRateLimiter;
  readonly seenRequests: Map<RequestId, true>;
  readonly sessionToken: string;
  readonly socket: WebSocket;
  alive: boolean;
  identity: AuthenticatedSession;
  memberId?: MemberId;
  roomId?: string;
  pongTimer?: NodeJS.Timeout;
}

export class RoomWebSocketGateway implements RoomPublisher {
  readonly #app: FastifyInstance;
  readonly #auth: AuthService;
  readonly #config: Pick<AppConfig, "COOKIE_SECURE">;
  readonly #connections = new Map<string, GatewayConnection>();
  readonly #rooms: RoomRegistry;
  readonly #wss = new WebSocketServer({ maxPayload: 64 * 1024, noServer: true });
  #heartbeatTimer?: NodeJS.Timeout;

  constructor(options: {
    readonly app: FastifyInstance;
    readonly auth: AuthService;
    readonly config: Pick<AppConfig, "COOKIE_SECURE">;
    readonly rooms: RoomRegistry;
  }) {
    this.#app = options.app;
    this.#auth = options.auth;
    this.#config = options.config;
    this.#rooms = options.rooms;
  }

  start(): void {
    this.#app.server.on("upgrade", this.#handleUpgrade);
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), 20_000);
    this.#heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    this.#app.server.off("upgrade", this.#handleUpgrade);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    for (const connection of this.#connections.values()) {
      if (connection.pongTimer) clearTimeout(connection.pongTimer);
      connection.socket.close(1001, "服务正在关闭");
    }
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  publishSnapshot(
    room: RoomRuntimeLike,
    events: readonly import("@tabletop/protocol").JsonValue[],
  ): void {
    const runtime = room as RoomRuntime;
    for (const connection of this.#connections.values()) {
      if (
        connection.roomId !== runtime.state.roomId ||
        connection.memberId === undefined ||
        !runtime.state.members.has(connection.memberId) ||
        connection.socket.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      this.#sendSnapshot(connection, runtime, events);
    }
  }

  publishClosed(
    roomId: import("@tabletop/protocol").RoomId,
    reason: string,
    message: string,
  ): void {
    for (const connection of this.#connections.values()) {
      if (connection.roomId !== roomId) continue;
      this.#send(connection, {
        messageId: ulid(),
        payload: { message, reason },
        protocol: 1,
        roomId,
        serverTime: new Date().toISOString(),
        type: "room.closed",
      });
      delete connection.memberId;
      delete connection.roomId;
    }
  }

  disconnectMember(memberId: MemberId, code: number, reason: string): void {
    const connection = [...this.#connections.values()].find(
      (candidate) => candidate.memberId === memberId,
    );
    connection?.socket.close(code, reason.slice(0, 120));
  }

  isAccountConnected(accountId: string): boolean {
    return [...this.#connections.values()].some(
      (connection) => connection.identity.account.id === accountId,
    );
  }

  disconnectAccount(accountId: string, reason = "账号会话已失效"): void {
    for (const connection of this.#connections.values()) {
      if (connection.identity.account.id === accountId) {
        connection.socket.close(4004, reason.slice(0, 120));
      }
    }
  }

  readonly #handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void this.#authenticateUpgrade(request)
      .then((authentication) => {
        this.#wss.handleUpgrade(request, socket, head, (webSocket) => {
          this.#acceptConnection(webSocket, authentication);
        });
      })
      .catch((error: unknown) => {
        const status = error instanceof HttpError ? error.statusCode : 401;
        socket.write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      });
  };

  async #authenticateUpgrade(request: IncomingMessage): Promise<{
    readonly identity: AuthenticatedSession;
    readonly sessionToken: string;
  }> {
    const host = request.headers.host;
    const url = new URL(
      request.url ?? "/",
      `${this.#config.COOKIE_SECURE ? "https" : "http"}://${host ?? "localhost"}`,
    );
    if (url.pathname !== "/ws" || url.searchParams.get("protocol") !== "1") {
      throw new HttpError(400, "VALIDATION_FAILED", "WebSocket 协议版本不受支持");
    }
    const expectedOrigin = `${this.#config.COOKIE_SECURE ? "https" : "http"}://${host}`;
    if (request.headers.origin !== expectedOrigin) {
      throw new HttpError(403, "AUTH_ORIGIN_INVALID", "WebSocket 来源验证失败");
    }
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE_NAME];
    if (sessionToken === undefined) {
      throw new HttpError(401, "AUTH_SESSION_EXPIRED", "登录状态已失效，请重新登录");
    }
    const identity = this.#auth.resolveSession(sessionToken);
    if (!this.#rooms.getSiteStatus().enabled) {
      throw new HttpError(503, "SITE_DISABLED", "网站正在维护");
    }
    return { identity, sessionToken };
  }

  #acceptConnection(
    socket: WebSocket,
    authentication: { readonly identity: AuthenticatedSession; readonly sessionToken: string },
  ): void {
    const connectionId = connectionIdSchema.parse(`connection-${ulid()}`);
    const connection: GatewayConnection = {
      alive: true,
      connectionId,
      identity: authentication.identity,
      rateLimiter: new SlidingWindowRateLimiter({ limit: 60, windowMs: 5_000 }),
      seenRequests: new Map(),
      sessionToken: authentication.sessionToken,
      socket,
    };
    this.#connections.set(connectionId, connection);

    socket.on("pong", () => {
      connection.alive = true;
      if (connection.pongTimer) clearTimeout(connection.pongTimer);
      delete connection.pongTimer;
    });
    socket.on("message", (data, isBinary) => {
      void this.#handleMessage(connection, isBinary ? undefined : data.toString("utf8")).catch(
        (error: unknown) => this.#handleConnectionFailure(connection, error),
      );
    });
    socket.on("close", () => {
      void this.#handleClose(connection).catch((error: unknown) => {
        this.#app.log.error(
          { connectionId: connection.connectionId, err: error },
          "websocket close handling failed",
        );
      });
    });
    socket.on("error", (error) => {
      this.#app.log.debug({ connectionId, err: error }, "websocket connection error");
    });

    this.#send(connection, {
      messageId: ulid(),
      payload: { connectionId, heartbeatIntervalMs: 20_000, pongTimeoutMs: 10_000 },
      protocol: 1,
      serverTime: new Date().toISOString(),
      type: "connection.ready",
    });
  }

  async #handleMessage(connection: GatewayConnection, raw: string | undefined): Promise<void> {
    let requestId = requestIdSchema.parse(ulid());
    const rate = connection.rateLimiter.consume("commands");
    if (!rate.allowed) {
      this.#sendCommandError(
        connection,
        requestId,
        new HttpError(429, "RATE_COMMAND_LIMIT", "房间命令发送过于频繁", {
          retryAfterMs: rate.retryAfterMs,
        }),
      );
      return;
    }
    if (!this.#refreshIdentity(connection)) return;

    try {
      if (raw === undefined) {
        throw new HttpError(400, "VALIDATION_FAILED", "不支持二进制 WebSocket 消息");
      }
      const parsedJson = JSON.parse(raw) as unknown;
      if (
        typeof parsedJson === "object" &&
        parsedJson !== null &&
        "requestId" in parsedJson &&
        typeof parsedJson.requestId === "string"
      ) {
        const parsedRequestId = requestIdSchema.safeParse(parsedJson.requestId);
        if (parsedRequestId.success) requestId = parsedRequestId.data;
      }
      const command = clientCommandSchema.parse(parsedJson);
      requestId = command.requestId;
      if (connection.seenRequests.has(requestId)) {
        if (connection.roomId && connection.memberId) {
          this.#sendSnapshot(connection, this.#rooms.require(connection.roomId), [], requestId);
        }
        return;
      }
      this.#rememberRequest(connection, requestId);
      await this.#dispatchCommand(connection, command, performance.now());
    } catch (error) {
      this.#sendCommandError(connection, requestId, error);
    }
  }

  async #dispatchCommand(
    connection: GatewayConnection,
    command: ClientCommand,
    receivedAtMonotonicMs: number,
  ): Promise<void> {
    if (command.type === "room.join") {
      if (connection.roomId) {
        throw new HttpError(409, "CONNECTION_ROOM_CONFLICT", "当前连接已经加入房间");
      }
      const joined = await this.#rooms.consumeJoinTicket(
        command.payload.joinTicket,
        connection.identity.account as Account,
        connection.identity.session as Session,
      );
      connection.memberId = joined.member.memberId;
      connection.roomId = joined.room.state.roomId;
      if (connection.socket.readyState !== WebSocket.OPEN) return;
      await joined.room.attachConnection(joined.member.memberId, connection.connectionId);
      this.#rooms.confirmMemberAttached(joined.member.memberId);
      this.#sendCommandAck(connection, command.requestId, joined.room, true);
      return;
    }

    if (command.type === "room.resume") {
      const binding = this.#rooms.bindingForSession(connection.identity.session.id);
      if (!binding || binding.roomId !== command.payload.roomId) {
        throw new HttpError(403, "ROOM_PERMISSION_DENIED", "当前会话没有可恢复的房间");
      }
      const room = this.#rooms.require(binding.roomId);
      connection.memberId = binding.memberId;
      connection.roomId = binding.roomId;
      if (connection.socket.readyState !== WebSocket.OPEN) return;
      await room.resume(
        binding.memberId,
        connection.identity.session.id as import("@tabletop/protocol").SessionId,
        connection.connectionId,
      );
      this.#rooms.confirmMemberAttached(binding.memberId);
      this.#sendCommandAck(connection, command.requestId, room, true);
      return;
    }

    const { memberId, room } = this.#requireBoundRoom(connection, command.roomId);
    let stateChanged = true;
    switch (command.type) {
      case "room.leave":
        await room.leave(memberId);
        delete connection.memberId;
        delete connection.roomId;
        break;
      case "room.rename":
        await room.rename(memberId, command.payload.name, command.expectedRevision);
        break;
      case "room.settings.update":
        await room.updateSettings(memberId, command.payload.settings, command.expectedRevision);
        break;
      case "room.seat.claim":
        await room.claimSeat(memberId, command.payload.seatId, command.expectedRevision);
        break;
      case "room.seat.reclaim":
        await room.reclaimSeat(memberId, command.payload.seatId, command.expectedRevision);
        break;
      case "room.seat.release":
        await room.releaseSeat(memberId, command.expectedRevision);
        break;
      case "room.bot.add":
        await room.addBot(
          memberId,
          command.payload.seatId,
          command.payload.profileId,
          command.expectedRevision,
        );
        break;
      case "room.bot.remove":
        await room.removeBot(memberId, command.payload.seatId, command.expectedRevision);
        break;
      case "room.ready.set":
        await room.setReady(memberId, command.payload.ready, command.expectedRevision);
        break;
      case "room.host.transfer":
        await room.transferHost(memberId, command.payload.accountId, command.expectedRevision);
        break;
      case "room.member.kick":
        await room.kickMember(memberId, command.payload.memberId, command.expectedRevision);
        break;
      case "room.match.start":
        await room.startMatch(memberId, command.expectedRevision);
        break;
      case "chat.send":
        await room.sendChat(memberId, command.payload.text);
        break;
      case "game.action":
        stateChanged = await room.gameAction(
          memberId,
          command.payload,
          command.matchId,
          command.expectedRevision,
          receivedAtMonotonicMs,
        );
        break;
    }

    this.#sendCommandAck(connection, command.requestId, room, stateChanged);
  }

  #requireBoundRoom(connection: GatewayConnection, commandRoomId: string | undefined) {
    if (
      !connection.roomId ||
      !connection.memberId ||
      !commandRoomId ||
      connection.roomId !== commandRoomId
    ) {
      throw new HttpError(403, "ROOM_PERMISSION_DENIED", "当前连接没有加入该房间");
    }
    return { memberId: connection.memberId, room: this.#rooms.require(connection.roomId) };
  }

  #sendSnapshot(
    connection: GatewayConnection,
    room: RoomRuntime,
    events: readonly import("@tabletop/protocol").JsonValue[],
    causedBy?: RequestId,
  ): void {
    if (!connection.memberId || !room.state.members.has(connection.memberId)) return;
    this.#send(connection, {
      ...(causedBy === undefined ? {} : { causedBy }),
      messageId: ulid(),
      ...(room.state.match === undefined ? {} : { matchId: room.state.match.matchId }),
      payload: room.projectSnapshot(connection.memberId, events),
      protocol: 1,
      revision: room.state.revision,
      roomId: room.state.roomId,
      serverTime: new Date().toISOString(),
      type: "room.snapshot",
    });
  }

  #sendCommandAck(
    connection: GatewayConnection,
    requestId: RequestId,
    room: RoomRuntime,
    stateChanged: boolean,
  ): void {
    this.#send(connection, {
      causedBy: requestId,
      messageId: ulid(),
      ...(room.state.match === undefined ? {} : { matchId: room.state.match.matchId }),
      payload: { stateChanged },
      protocol: 1,
      revision: room.state.revision,
      roomId: room.state.roomId,
      serverTime: new Date().toISOString(),
      type: "command.ack",
    });
  }

  #sendCommandError(connection: GatewayConnection, requestId: RequestId, error: unknown): void {
    const httpError =
      error instanceof HttpError
        ? error
        : error instanceof ZodError || error instanceof SyntaxError
          ? new HttpError(400, "VALIDATION_FAILED", "命令格式不符合要求")
          : new HttpError(500, "INTERNAL_ROOM_ABORTED", "房间命令处理失败");
    if (httpError.statusCode >= 500) {
      this.#app.log.error(
        { connectionId: connection.connectionId, err: error },
        "websocket command failed",
      );
    }
    let room: RoomRuntime | undefined;
    if (connection.roomId) {
      try {
        room = this.#rooms.require(connection.roomId);
      } catch {
        room = undefined;
      }
    }
    this.#send(connection, {
      causedBy: requestId,
      messageId: ulid(),
      ...(room?.state.match === undefined ? {} : { matchId: room.state.match.matchId }),
      payload: {
        code: httpError.code,
        details: httpError.details,
        message: httpError.message,
        resyncRequired: httpError.code === "REVISION_STALE",
      },
      protocol: 1,
      ...(room === undefined ? {} : { revision: room.state.revision, roomId: room.state.roomId }),
      serverTime: new Date().toISOString(),
      type: "command.error",
    });
  }

  #send(connection: GatewayConnection, message: unknown): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(JSON.stringify(serverMessageSchema.parse(message)));
  }

  async #handleClose(connection: GatewayConnection): Promise<void> {
    this.#connections.delete(connection.connectionId);
    if (connection.pongTimer) clearTimeout(connection.pongTimer);
    if (connection.roomId && connection.memberId) {
      try {
        const room = this.#rooms.require(connection.roomId);
        await room.connectionLost(connection.memberId, connection.connectionId);
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== "ROOM_NOT_FOUND") {
          throw error;
        }
      }
    }
  }

  #heartbeat(): void {
    for (const connection of this.#connections.values()) {
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      try {
        if (!this.#refreshIdentity(connection)) continue;
      } catch (error) {
        this.#handleConnectionFailure(connection, error);
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
      if (connection.pongTimer) clearTimeout(connection.pongTimer);
      connection.pongTimer = setTimeout(() => {
        if (!connection.alive) connection.socket.terminate();
      }, 10_000);
      connection.pongTimer.unref();
    }
  }

  #refreshIdentity(connection: GatewayConnection): boolean {
    try {
      connection.identity = this.#auth.resolveSession(connection.sessionToken);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.code === "AUTH_SESSION_EXPIRED") {
        connection.socket.close(4004, "登录状态已失效");
        return false;
      }
      throw error;
    }
  }

  #handleConnectionFailure(connection: GatewayConnection, error: unknown): void {
    this.#app.log.error(
      { connectionId: connection.connectionId, err: error },
      "websocket message handling failed",
    );
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    try {
      connection.socket.close(1011, "房间连接处理失败");
    } catch (closeError) {
      this.#app.log.error(
        { connectionId: connection.connectionId, err: closeError },
        "websocket failure close failed",
      );
      connection.socket.terminate();
    }
  }

  #rememberRequest(connection: GatewayConnection, requestId: RequestId): void {
    connection.seenRequests.set(requestId, true);
    if (connection.seenRequests.size > 128) {
      const oldest = connection.seenRequests.keys().next().value;
      if (oldest) connection.seenRequests.delete(oldest);
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}
