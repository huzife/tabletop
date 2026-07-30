import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  roomConnectionOpenResponseSchema,
  roomConnectionPollResponseSchema,
  seatIdSchema,
  serverMessageSchema,
  type ServerMessage,
} from "@tabletop/protocol";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ZodError } from "zod";

import { PasswordService } from "../auth/password.js";
import type { AppConfig } from "../config.js";
import { serverGameRegistry } from "../games/registry.js";
import { SlidingWindowRateLimiter } from "../lib/rate-limiter.js";
import { createRuntime } from "../runtime.js";

type TestRuntime = Awaited<ReturnType<typeof createRuntime>>;
type TestCleanup = () => Promise<void> | void;

function cookiesFrom(headers: Record<string, number | string | string[] | undefined>) {
  const raw = headers["set-cookie"];
  const lines = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
  const pairs = lines.map((line) => line.split(";", 1)[0] ?? "").filter(Boolean);
  const values = Object.fromEntries(
    pairs.map((pair) => {
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
  return { header: pairs.join("; "), values };
}

async function startTestRuntime(cleanups: TestCleanup[]) {
  const directory = mkdtempSync(join(tmpdir(), "tabletop-gateway-"));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  const config: AppConfig = {
    COOKIE_SECURE: false,
    DATABASE_PATH: join(directory, "tabletop.db"),
    GAME_AI_WORKERS: 0,
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
    PORT: 0,
    SESSION_SECRET: "s".repeat(32),
    TRUST_PROXY: false,
  };
  const runtime = await createRuntime(config, serverGameRegistry);
  cleanups.push(async () => runtime.app.close());
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, runtime, wsUrl: `ws://127.0.0.1:${address.port}/ws?protocol=1` };
}

async function login(runtime: TestRuntime, username: string, password: string) {
  const response = await runtime.app.inject({
    method: "POST",
    payload: { password, username },
    url: "/api/v1/auth/login",
  });
  expect(response.statusCode).toBe(200);
  return cookiesFrom(response.headers);
}

function unsafeHeaders(
  cookies: ReturnType<typeof cookiesFrom>,
  origin: string,
): Record<string, string> {
  const csrf = cookies.values.tt_csrf;
  if (!csrf) throw new Error("测试登录响应缺少 CSRF Cookie");
  return {
    cookie: cookies.header,
    host: new URL(origin).host,
    origin,
    "x-csrf-token": csrf,
  };
}

function waitForServerMessage(
  socket: WebSocket,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 5_000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket 在等待服务端消息时关闭"));
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const message = serverMessageSchema.parse(JSON.parse(data.toString("utf8")));
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 WebSocket 消息超过 ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

async function waitForSnapshot(
  socket: WebSocket,
  roomId: string,
  predicate: (message: Extract<ServerMessage, { type: "room.snapshot" }>) => boolean = () => true,
) {
  const message = await waitForServerMessage(
    socket,
    (candidate) =>
      candidate.type === "room.snapshot" && candidate.roomId === roomId && predicate(candidate),
  );
  if (message.type !== "room.snapshot") throw new Error("未收到房间快照");
  return message;
}

async function waitForRoomClosed(socket: WebSocket, roomId: string) {
  const message = await waitForServerMessage(
    socket,
    (candidate) => candidate.type === "room.closed" && candidate.roomId === roomId,
  );
  if (message.type !== "room.closed") throw new Error("未收到房间关闭消息");
  return message;
}

async function waitForCommandAck(socket: WebSocket, requestId: string) {
  const message = await waitForServerMessage(
    socket,
    (candidate) => candidate.type === "command.ack" && candidate.causedBy === requestId,
  );
  if (message.type !== "command.ack") throw new Error("未收到命令确认");
  return message;
}

function waitForSocketClose(socket: WebSocket, timeoutMs = 5_000) {
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("close", onClose);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString("utf8") });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 WebSocket 关闭超过 ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("close", onClose);
  });
}

async function openSocket(
  wsUrl: string,
  origin: string,
  cookies: ReturnType<typeof cookiesFrom>,
  cleanups: TestCleanup[],
) {
  const socket = new WebSocket(wsUrl, {
    headers: { Cookie: cookies.header },
    origin,
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once("close", () => resolve());
        socket.close();
      }),
  );
  const ready = waitForServerMessage(socket, (message) => message.type === "connection.ready");
  await once(socket, "open");
  expect(await ready).toMatchObject({ type: "connection.ready" });
  return socket;
}

function send(socket: WebSocket, command: object): void {
  socket.send(JSON.stringify(command));
}

describe("RoomConnectionGateway", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it("answers application-level WebSocket heartbeats", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("heartbeat-password"),
      username: "心跳测试用户",
    });
    const cookies = await login(runtime, "心跳测试用户", "heartbeat-password");
    const socket = await openSocket(wsUrl, origin, cookies, cleanups);
    const requestId = ulid();
    const pong = waitForServerMessage(
      socket,
      (message) => message.type === "connection.pong" && message.causedBy === requestId,
    );

    send(socket, {
      payload: {},
      protocol: 1,
      requestId,
      type: "connection.ping",
    });

    await expect(pong).resolves.toMatchObject({
      causedBy: requestId,
      payload: {},
      type: "connection.pong",
    });
  });

  it("lets a new same-session connection take over a stale room connection", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("takeover-password"),
      username: "连接接管用户",
    });
    const cookies = await login(runtime, "连接接管用户", "takeover-password");
    const createdResponse = await runtime.app.inject({
      headers: unsafeHeaders(cookies, origin),
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "连接接管测试房",
        practice: false,
        settings: {
          moveTimeSeconds: 60,
          rule: "freestyle",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      },
      url: "/api/v1/rooms",
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as { joinTicket: string; roomId: string };

    const staleSocket = await openSocket(wsUrl, origin, cookies, cleanups);
    const joined = waitForSnapshot(staleSocket, created.roomId);
    send(staleSocket, {
      payload: { joinTicket: created.joinTicket },
      protocol: 1,
      requestId: ulid(),
      type: "room.join",
    });
    await joined;

    const replacementSocket = await openSocket(wsUrl, origin, cookies, cleanups);
    const staleClosed = waitForSocketClose(staleSocket);
    const resumed = waitForSnapshot(replacementSocket, created.roomId, (message) =>
      message.payload.members.some(({ connectionStatus }) => connectionStatus === "connected"),
    );
    send(replacementSocket, {
      payload: { roomId: created.roomId },
      protocol: 1,
      requestId: ulid(),
      type: "room.resume",
    });

    await expect(staleClosed).resolves.toMatchObject({
      code: 4001,
      reason: "连接已由同一设备接管",
    });
    await expect(resumed).resolves.toMatchObject({
      roomId: created.roomId,
      type: "room.snapshot",
    });
    expect(replacementSocket.readyState).toBe(WebSocket.OPEN);
  });

  it("joins and runs revisioned commands through the HTTP long-polling fallback", async () => {
    const { origin, runtime } = await startTestRuntime(cleanups);
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("polling-password"),
      username: "长轮询用户",
    });
    const cookies = await login(runtime, "长轮询用户", "polling-password");
    const headers = unsafeHeaders(cookies, origin);
    const createdResponse = await runtime.app.inject({
      headers,
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "长轮询测试房",
        practice: false,
        settings: {
          moveTimeSeconds: 60,
          rule: "freestyle",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      },
      url: "/api/v1/rooms",
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as { joinTicket: string; roomId: string };

    const openedResponse = await runtime.app.inject({
      headers,
      method: "POST",
      payload: { protocol: 1 },
      url: "/api/v1/room-connections",
    });
    expect(openedResponse.statusCode).toBe(201);
    expect(openedResponse.headers["cache-control"]).toBe("no-store");
    expect(openedResponse.headers["x-accel-buffering"]).toBe("no");
    const opened = roomConnectionOpenResponseSchema.parse(openedResponse.json());
    expect(opened.messages).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ connectionId: opened.connectionId }),
        type: "connection.ready",
      }),
    ]);

    const joinRequestId = ulid();
    const joinedResponse = await runtime.app.inject({
      headers,
      method: "POST",
      payload: {
        payload: { joinTicket: created.joinTicket },
        protocol: 1,
        requestId: joinRequestId,
        type: "room.join",
      },
      url: `/api/v1/room-connections/${opened.connectionId}/commands`,
    });
    expect(joinedResponse.statusCode).toBe(202);
    const joinedPoll = roomConnectionPollResponseSchema.parse(
      (
        await runtime.app.inject({
          headers,
          method: "POST",
          payload: {},
          url: `/api/v1/room-connections/${opened.connectionId}/poll`,
        })
      ).json(),
    );
    const joinedSnapshot = joinedPoll.messages.find(
      (message) => message.type === "room.snapshot" && message.roomId === created.roomId,
    );
    expect(joinedSnapshot).toMatchObject({ type: "room.snapshot" });
    expect(joinedPoll.messages).toContainEqual(
      expect.objectContaining({ causedBy: joinRequestId, type: "command.ack" }),
    );
    if (joinedSnapshot?.type !== "room.snapshot") throw new Error("长轮询未返回房间快照");

    const claimRequestId = ulid();
    const claimedResponse = await runtime.app.inject({
      headers,
      method: "POST",
      payload: {
        expectedRevision: joinedSnapshot.revision,
        payload: { seatId: "seat-1" },
        protocol: 1,
        requestId: claimRequestId,
        roomId: created.roomId,
        type: "room.seat.claim",
      },
      url: `/api/v1/room-connections/${opened.connectionId}/commands`,
    });
    expect(claimedResponse.statusCode).toBe(202);
    const claimedPoll = roomConnectionPollResponseSchema.parse(
      (
        await runtime.app.inject({
          headers,
          method: "POST",
          payload: {},
          url: `/api/v1/room-connections/${opened.connectionId}/poll`,
        })
      ).json(),
    );
    expect(claimedPoll.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          revision: joinedSnapshot.revision + 1,
          type: "room.snapshot",
        }),
        expect.objectContaining({ causedBy: claimRequestId, type: "command.ack" }),
      ]),
    );

    const closedResponse = await runtime.app.inject({
      headers,
      method: "DELETE",
      url: `/api/v1/room-connections/${opened.connectionId}`,
    });
    expect(closedResponse.statusCode).toBe(204);
  });

  it("keeps two long-polling connections from one session isolated across rooms", async () => {
    const { origin, runtime } = await startTestRuntime(cleanups);
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("multi-room-polling-password"),
      username: "多房间轮询用户",
    });
    const cookies = await login(runtime, "多房间轮询用户", "multi-room-polling-password");
    const headers = unsafeHeaders(cookies, origin);

    const createRoom = async (name: string) => {
      const response = await runtime.app.inject({
        headers,
        method: "POST",
        payload: {
          gameId: "gomoku",
          name,
          practice: false,
          settings: {
            moveTimeSeconds: 60,
            rule: "freestyle",
            timerEnabled: false,
            totalTimeMinutes: 10,
          },
        },
        url: "/api/v1/rooms",
      });
      expect(response.statusCode).toBe(201);
      return response.json() as { joinTicket: string; roomId: string };
    };
    const openConnection = async () => {
      const response = await runtime.app.inject({
        headers,
        method: "POST",
        payload: { protocol: 1 },
        url: "/api/v1/room-connections",
      });
      expect(response.statusCode).toBe(201);
      return roomConnectionOpenResponseSchema.parse(response.json());
    };
    const postCommand = async (connectionId: string, command: object) => {
      const response = await runtime.app.inject({
        headers,
        method: "POST",
        payload: command,
        url: `/api/v1/room-connections/${connectionId}/commands`,
      });
      expect(response.statusCode).toBe(202);
    };
    const poll = async (connectionId: string) => {
      const response = await runtime.app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/api/v1/room-connections/${connectionId}/poll`,
      });
      expect(response.statusCode).toBe(200);
      return roomConnectionPollResponseSchema.parse(response.json());
    };

    const firstRoom = await createRoom("多连接第一房间");
    const firstConnection = await openConnection();
    const firstJoinRequestId = ulid();
    await postCommand(firstConnection.connectionId, {
      payload: { joinTicket: firstRoom.joinTicket },
      protocol: 1,
      requestId: firstJoinRequestId,
      type: "room.join",
    });
    const firstJoinPoll = await poll(firstConnection.connectionId);
    const firstJoined = firstJoinPoll.messages.find(
      (message) => message.type === "room.snapshot" && message.roomId === firstRoom.roomId,
    );
    expect(firstJoined).toMatchObject({ roomId: firstRoom.roomId, type: "room.snapshot" });
    expect(firstJoinPoll.messages).toContainEqual(
      expect.objectContaining({
        causedBy: firstJoinRequestId,
        roomId: firstRoom.roomId,
        type: "command.ack",
      }),
    );
    if (firstJoined?.type !== "room.snapshot") throw new Error("第一房间未返回加入快照");

    const secondRoom = await createRoom("多连接第二房间");
    expect(secondRoom.roomId).not.toBe(firstRoom.roomId);
    const secondConnection = await openConnection();
    expect(secondConnection.connectionId).not.toBe(firstConnection.connectionId);
    const secondJoinRequestId = ulid();
    await postCommand(secondConnection.connectionId, {
      payload: { joinTicket: secondRoom.joinTicket },
      protocol: 1,
      requestId: secondJoinRequestId,
      type: "room.join",
    });
    const secondJoinPoll = await poll(secondConnection.connectionId);
    const secondJoined = secondJoinPoll.messages.find(
      (message) => message.type === "room.snapshot" && message.roomId === secondRoom.roomId,
    );
    expect(secondJoined).toMatchObject({ roomId: secondRoom.roomId, type: "room.snapshot" });
    expect(secondJoinPoll.messages).toContainEqual(
      expect.objectContaining({
        causedBy: secondJoinRequestId,
        roomId: secondRoom.roomId,
        type: "command.ack",
      }),
    );
    expect(
      secondJoinPoll.messages.every(
        (message) => !("roomId" in message) || message.roomId === secondRoom.roomId,
      ),
    ).toBe(true);
    if (secondJoined?.type !== "room.snapshot") throw new Error("第二房间未返回加入快照");

    const firstClaimRequestId = ulid();
    await postCommand(firstConnection.connectionId, {
      expectedRevision: firstJoined.revision,
      payload: { seatId: "seat-1" },
      protocol: 1,
      requestId: firstClaimRequestId,
      roomId: firstRoom.roomId,
      type: "room.seat.claim",
    });
    const firstClaimPoll = await poll(firstConnection.connectionId);
    expect(firstClaimPoll.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          revision: firstJoined.revision + 1,
          roomId: firstRoom.roomId,
          type: "room.snapshot",
        }),
        expect.objectContaining({
          causedBy: firstClaimRequestId,
          roomId: firstRoom.roomId,
          type: "command.ack",
        }),
      ]),
    );
    expect(
      firstClaimPoll.messages.every(
        (message) => !("roomId" in message) || message.roomId === firstRoom.roomId,
      ),
    ).toBe(true);

    const secondClaimRequestId = ulid();
    await postCommand(secondConnection.connectionId, {
      expectedRevision: secondJoined.revision,
      payload: { seatId: "seat-2" },
      protocol: 1,
      requestId: secondClaimRequestId,
      roomId: secondRoom.roomId,
      type: "room.seat.claim",
    });
    const secondClaimPoll = await poll(secondConnection.connectionId);
    expect(secondClaimPoll.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          revision: secondJoined.revision + 1,
          roomId: secondRoom.roomId,
          type: "room.snapshot",
        }),
        expect.objectContaining({
          causedBy: secondClaimRequestId,
          roomId: secondRoom.roomId,
          type: "command.ack",
        }),
      ]),
    );
    expect(
      secondClaimPoll.messages.every(
        (message) => !("roomId" in message) || message.roomId === secondRoom.roomId,
      ),
    ).toBe(true);

    for (const connection of [firstConnection, secondConnection]) {
      const response = await runtime.app.inject({
        headers,
        method: "DELETE",
        url: `/api/v1/room-connections/${connection.connectionId}`,
      });
      expect(response.statusCode).toBe(204);
    }
  }, 30_000);

  it("requires a session, same-origin request and CSRF token for long polling", async () => {
    const { origin, runtime } = await startTestRuntime(cleanups);
    const anonymous = await runtime.app.inject({
      method: "POST",
      payload: { protocol: 1 },
      url: "/api/v1/room-connections",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: "AUTH_SESSION_EXPIRED" } });

    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("polling-auth-password"),
      username: "轮询鉴权用户",
    });
    const cookies = await login(runtime, "轮询鉴权用户", "polling-auth-password");
    const withoutOrigin = await runtime.app.inject({
      headers: { cookie: cookies.header },
      method: "POST",
      payload: { protocol: 1 },
      url: "/api/v1/room-connections",
    });
    expect(withoutOrigin.statusCode).toBe(403);
    expect(withoutOrigin.json()).toMatchObject({ error: { code: "AUTH_ORIGIN_INVALID" } });

    const withoutCsrf = await runtime.app.inject({
      headers: { cookie: cookies.header, host: new URL(origin).host, origin },
      method: "POST",
      payload: { protocol: 1 },
      url: "/api/v1/room-connections",
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(withoutCsrf.json()).toMatchObject({ error: { code: "AUTH_CSRF_INVALID" } });
  });

  it("uses a safe correlation ID when a raw request ID is invalid", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("request-id-password"),
      username: "请求标识测试",
    });
    const cookies = await login(runtime, "请求标识测试", "request-id-password");
    const socket = await openSocket(wsUrl, origin, cookies, cleanups);

    const malformedErrorPromise = waitForServerMessage(
      socket,
      (message) => message.type === "command.error",
    );
    send(socket, {
      payload: { roomId: "room-request-id" },
      protocol: 1,
      requestId: "not-a-request-id",
      type: "room.resume",
    });
    const malformedError = await malformedErrorPromise;
    expect(malformedError).toMatchObject({
      payload: { code: "VALIDATION_FAILED" },
      type: "command.error",
    });
    if (malformedError.type !== "command.error") throw new Error("未收到命令错误");
    expect(malformedError.causedBy).not.toBe("not-a-request-id");

    const validRequestId = ulid();
    const validErrorPromise = waitForServerMessage(
      socket,
      (message) => message.type === "command.error" && message.causedBy === validRequestId,
    );
    send(socket, {
      payload: { roomId: "room-request-id" },
      protocol: 1,
      requestId: validRequestId,
      type: "room.resume",
    });
    expect(await validErrorPromise).toMatchObject({
      causedBy: validRequestId,
      payload: { code: "ROOM_PERMISSION_DENIED" },
      type: "command.error",
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("does not misreport a downstream schema failure as a malformed command", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("downstream-error-password"),
      username: "下游错误分类测试",
    });
    const cookies = await login(runtime, "下游错误分类测试", "downstream-error-password");
    const createdResponse = await runtime.app.inject({
      headers: unsafeHeaders(cookies, origin),
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "下游错误分类测试房",
        practice: false,
        settings: {
          moveTimeSeconds: 60,
          rule: "freestyle",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      },
      url: "/api/v1/rooms",
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as { joinTicket: string; roomId: string };
    const socket = await openSocket(wsUrl, origin, cookies, cleanups);
    const joinedPromise = waitForSnapshot(socket, created.roomId);
    send(socket, {
      payload: { joinTicket: created.joinTicket },
      protocol: 1,
      requestId: ulid(),
      type: "room.join",
    });
    const joined = await joinedPromise;
    vi.spyOn(runtime.rooms.require(created.roomId), "rename").mockRejectedValue(new ZodError([]));

    const requestId = ulid();
    const errorPromise = waitForServerMessage(
      socket,
      (message) => message.type === "command.error" && message.causedBy === requestId,
    );
    send(socket, {
      expectedRevision: joined.revision,
      payload: { name: "合法的新房间名" },
      protocol: 1,
      requestId,
      roomId: created.roomId,
      type: "room.rename",
    });

    expect(await errorPromise).toMatchObject({
      causedBy: requestId,
      payload: {
        code: "INTERNAL_ROOM_ABORTED",
        message: "房间命令处理失败",
      },
      type: "command.error",
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("silently limits malformed and binary frame floods before validation", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("frame-limit-password"),
      username: "帧限流测试",
    });
    const cookies = await login(runtime, "帧限流测试", "frame-limit-password");
    const socket = await openSocket(wsUrl, origin, cookies, cleanups);
    const received: ServerMessage[] = [];
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      received.push(serverMessageSchema.parse(JSON.parse(data.toString("utf8"))));
    };
    socket.on("message", onMessage);

    const frameCount = 256;
    const pong = once(socket, "pong");
    for (let index = 0; index < frameCount; index += 1) {
      if (index % 2 === 0) {
        socket.send("{");
      } else {
        socket.send(Buffer.from([index]));
      }
    }
    socket.ping("frame-limit-barrier");
    await pong;
    socket.off("message", onMessage);

    const errors = received.filter((message) => message.type === "command.error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThan(frameCount);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ code: "VALIDATION_FAILED" }),
          type: "command.error",
        }),
      ]),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("cleans a disconnected lobby member and allows a fresh join without stale binding", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    const passwordHash = await new PasswordService(1).hash("entry-ack-password");
    const hostAccount = runtime.repositories.accounts.create({
      passwordHash,
      username: "确认房主",
    });
    const guestAccount = runtime.repositories.accounts.create({
      passwordHash,
      username: "确认访客",
    });
    const hostCookies = await login(runtime, hostAccount.username, "entry-ack-password");
    const guestCookies = await login(runtime, guestAccount.username, "entry-ack-password");
    const createdResponse = await runtime.app.inject({
      headers: unsafeHeaders(hostCookies, origin),
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "入口确认测试房",
        practice: false,
        settings: {
          moveTimeSeconds: 60,
          rule: "freestyle",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      },
      url: "/api/v1/rooms",
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as { joinTicket: string; roomId: string };
    const guestTicketResponse = await runtime.app.inject({
      headers: unsafeHeaders(guestCookies, origin),
      method: "POST",
      payload: {},
      url: `/api/v1/rooms/${created.roomId}/join-ticket`,
    });
    expect(guestTicketResponse.statusCode).toBe(200);
    const guestTicket = guestTicketResponse.json() as { joinTicket: string };

    const hostSocket = await openSocket(wsUrl, origin, hostCookies, cleanups);
    const guestSocket = await openSocket(wsUrl, origin, guestCookies, cleanups);
    const hostJoinRequestId = ulid();
    const hostJoinSnapshotPromise = waitForSnapshot(hostSocket, created.roomId);
    const hostJoinAckPromise = waitForCommandAck(hostSocket, hostJoinRequestId);
    send(hostSocket, {
      payload: { joinTicket: created.joinTicket },
      protocol: 1,
      requestId: hostJoinRequestId,
      type: "room.join",
    });
    const [hostJoined, hostJoinAck] = await Promise.all([
      hostJoinSnapshotPromise,
      hostJoinAckPromise,
    ]);
    expect(hostJoinAck).toMatchObject({
      causedBy: hostJoinRequestId,
      payload: { stateChanged: true },
      revision: hostJoined.revision,
      roomId: created.roomId,
    });

    const guestJoinRequestId = ulid();
    const guestJoinSnapshotPromise = waitForSnapshot(guestSocket, created.roomId);
    const guestJoinAckPromise = waitForCommandAck(guestSocket, guestJoinRequestId);
    send(guestSocket, {
      payload: { joinTicket: guestTicket.joinTicket },
      protocol: 1,
      requestId: guestJoinRequestId,
      type: "room.join",
    });
    const [guestJoined, guestJoinAck] = await Promise.all([
      guestJoinSnapshotPromise,
      guestJoinAckPromise,
    ]);
    expect(guestJoinAck).toMatchObject({
      causedBy: guestJoinRequestId,
      payload: { stateChanged: true },
      revision: guestJoined.revision,
      roomId: created.roomId,
    });

    const duplicateSnapshotPromise = waitForSnapshot(
      guestSocket,
      created.roomId,
      (message) => message.causedBy === guestJoinRequestId,
    );
    send(guestSocket, {
      payload: { joinTicket: guestTicket.joinTicket },
      protocol: 1,
      requestId: guestJoinRequestId,
      type: "room.join",
    });
    expect(await duplicateSnapshotPromise).toMatchObject({
      causedBy: guestJoinRequestId,
      revision: guestJoined.revision,
    });

    const removedPromise = waitForSnapshot(hostSocket, created.roomId, (message) =>
      message.payload.members.every((member) => member.accountId !== guestAccount.id),
    );
    const guestClosedPromise = once(guestSocket, "close");
    guestSocket.close();
    await guestClosedPromise;
    await removedPromise;

    const freshTicketResponse = await runtime.app.inject({
      headers: unsafeHeaders(guestCookies, origin),
      method: "POST",
      payload: {},
      url: `/api/v1/rooms/${created.roomId}/join-ticket`,
    });
    expect(freshTicketResponse.statusCode).toBe(200);
    const freshTicket = freshTicketResponse.json() as { joinTicket: string };
    const rejoinedSocket = await openSocket(wsUrl, origin, guestCookies, cleanups);
    const rejoinRequestId = ulid();
    const rejoinSnapshotPromise = waitForSnapshot(rejoinedSocket, created.roomId);
    const rejoinAckPromise = waitForCommandAck(rejoinedSocket, rejoinRequestId);
    send(rejoinedSocket, {
      payload: { joinTicket: freshTicket.joinTicket },
      protocol: 1,
      requestId: rejoinRequestId,
      type: "room.join",
    });
    const [rejoined, rejoinAck] = await Promise.all([rejoinSnapshotPromise, rejoinAckPromise]);
    expect(rejoinAck).toMatchObject({
      causedBy: rejoinRequestId,
      payload: { stateChanged: true },
      revision: rejoined.revision,
      roomId: created.roomId,
    });

    const leaveRequestId = ulid();
    const hostAfterLeavePromise = waitForSnapshot(hostSocket, created.roomId, (message) =>
      message.payload.members.every((member) => member.accountId !== guestAccount.id),
    );
    const leaveAckPromise = waitForCommandAck(rejoinedSocket, leaveRequestId);
    send(rejoinedSocket, {
      payload: {},
      protocol: 1,
      requestId: leaveRequestId,
      roomId: created.roomId,
      type: "room.leave",
    });
    const [hostAfterLeave, leaveAck] = await Promise.all([hostAfterLeavePromise, leaveAckPromise]);
    expect(leaveAck).toMatchObject({
      causedBy: leaveRequestId,
      payload: { stateChanged: true },
      revision: hostAfterLeave.revision,
      roomId: created.roomId,
    });
    expect(rejoinedSocket.readyState).toBe(WebSocket.OPEN);
  }, 30_000);

  it("closes established sockets after logout, password rotation or session expiry", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    const passwordHash = await new PasswordService(1).hash("session-check-password");
    const logoutAccount = runtime.repositories.accounts.create({
      passwordHash,
      username: "会话登出测试",
    });
    const passwordAccount = runtime.repositories.accounts.create({
      passwordHash,
      username: "会话改密测试",
    });
    const expiryAccount = runtime.repositories.accounts.create({
      passwordHash,
      username: "会话过期测试",
    });
    const logoutCookies = await login(runtime, logoutAccount.username, "session-check-password");
    const passwordCookies = await login(
      runtime,
      passwordAccount.username,
      "session-check-password",
    );
    const expiryCookies = await login(runtime, expiryAccount.username, "session-check-password");
    const logoutSocket = await openSocket(wsUrl, origin, logoutCookies, cleanups);
    const passwordSocket = await openSocket(wsUrl, origin, passwordCookies, cleanups);
    const expirySocket = await openSocket(wsUrl, origin, expiryCookies, cleanups);

    const logoutClosePromise = waitForSocketClose(logoutSocket);
    const logoutResponse = await runtime.app.inject({
      headers: unsafeHeaders(logoutCookies, origin),
      method: "POST",
      url: "/api/v1/auth/logout",
    });
    expect(logoutResponse.statusCode).toBe(204);
    send(logoutSocket, {
      payload: { roomId: "room-session-check" },
      protocol: 1,
      requestId: ulid(),
      type: "room.resume",
    });
    expect(await logoutClosePromise).toMatchObject({ code: 4004, reason: "登录状态已失效" });

    const passwordClosePromise = waitForSocketClose(passwordSocket);
    const passwordResponse = await runtime.app.inject({
      headers: unsafeHeaders(passwordCookies, origin),
      method: "POST",
      payload: {
        currentPassword: "session-check-password",
        newPassword: "rotated-session-password",
      },
      url: "/api/v1/auth/change-password",
    });
    expect(passwordResponse.statusCode).toBe(200);
    send(passwordSocket, {
      payload: { roomId: "room-session-check" },
      protocol: 1,
      requestId: ulid(),
      type: "room.resume",
    });
    expect(await passwordClosePromise).toMatchObject({ code: 4004, reason: "登录状态已失效" });

    const sessionResponse = await runtime.app.inject({
      headers: { cookie: expiryCookies.header },
      method: "GET",
      url: "/api/v1/auth/session",
    });
    expect(sessionResponse.statusCode).toBe(200);
    const sessionId = (sessionResponse.json() as { session: { id: string } }).session.id;
    runtime.connection.sqlite
      .prepare("UPDATE sessions SET expires_at = created_at + 1 WHERE id = ?")
      .run(sessionId);

    const expiryClosePromise = waitForSocketClose(expirySocket);
    send(expirySocket, {
      payload: { roomId: "room-session-check" },
      protocol: 1,
      requestId: ulid(),
      type: "room.resume",
    });
    expect(await expiryClosePromise).toMatchObject({ code: 4004, reason: "登录状态已失效" });
  }, 30_000);

  it("runs two HTTP-authenticated users through WS seating, play, fallback and resume", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    const passwordHash = await new PasswordService(1).hash("gateway-password");
    const hostAccount = runtime.repositories.accounts.create({
      passwordHash,
      role: "admin",
      username: "联机房主",
    });
    const guestAccount = runtime.repositories.accounts.create({
      passwordHash,
      username: "联机玩家",
    });
    const hostCookies = await login(runtime, hostAccount.username, "gateway-password");
    const guestCookies = await login(runtime, guestAccount.username, "gateway-password");

    const createdResponse = await runtime.app.inject({
      headers: unsafeHeaders(hostCookies, origin),
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "双人联机房",
        practice: false,
        settings: {
          moveTimeSeconds: 60,
          rule: "freestyle",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      },
      url: "/api/v1/rooms",
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as { joinTicket: string; roomId: string };
    const guestTicketResponse = await runtime.app.inject({
      headers: unsafeHeaders(guestCookies, origin),
      method: "POST",
      payload: {},
      url: `/api/v1/rooms/${created.roomId}/join-ticket`,
    });
    expect(guestTicketResponse.statusCode).toBe(200);
    const guestTicket = guestTicketResponse.json() as { joinTicket: string };

    const hostSocket = await openSocket(wsUrl, origin, hostCookies, cleanups);
    const guestSocket = await openSocket(wsUrl, origin, guestCookies, cleanups);
    const hostJoin = waitForSnapshot(hostSocket, created.roomId);
    send(hostSocket, {
      payload: { joinTicket: created.joinTicket },
      protocol: 1,
      requestId: ulid(),
      type: "room.join",
    });
    await hostJoin;
    const guestJoin = waitForSnapshot(guestSocket, created.roomId);
    send(guestSocket, {
      payload: { joinTicket: guestTicket.joinTicket },
      protocol: 1,
      requestId: ulid(),
      type: "room.join",
    });
    const joined = await guestJoin;

    const hostClaim = waitForSnapshot(
      hostSocket,
      created.roomId,
      ({ revision }) => revision > joined.revision,
    );
    send(hostSocket, {
      expectedRevision: joined.revision,
      payload: { seatId: "seat-1" },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "room.seat.claim",
    });
    const hostClaimed = await hostClaim;

    const guestClaim = waitForSnapshot(
      guestSocket,
      created.roomId,
      ({ revision }) => revision > hostClaimed.revision,
    );
    send(guestSocket, {
      expectedRevision: hostClaimed.revision,
      payload: { seatId: "seat-2" },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "room.seat.claim",
    });
    const guestClaimed = await guestClaim;

    const hostReady = waitForSnapshot(
      hostSocket,
      created.roomId,
      ({ revision }) => revision > guestClaimed.revision,
    );
    send(hostSocket, {
      expectedRevision: guestClaimed.revision,
      payload: { ready: true },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "room.ready.set",
    });
    const hostReadied = await hostReady;

    const guestReady = waitForSnapshot(
      guestSocket,
      created.roomId,
      ({ revision }) => revision > hostReadied.revision,
    );
    send(guestSocket, {
      expectedRevision: hostReadied.revision,
      payload: { ready: true },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "room.ready.set",
    });
    const guestReadied = await guestReady;

    const matchStarted = waitForSnapshot(
      hostSocket,
      created.roomId,
      ({ revision }) => revision > guestReadied.revision,
    );
    send(hostSocket, {
      expectedRevision: guestReadied.revision,
      payload: {},
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "room.match.start",
    });
    const started = await matchStarted;
    expect(started).toMatchObject({ matchId: expect.any(String) as string });
    expect(started.payload).toMatchObject({
      members: [
        { accountId: hostAccount.id, connectionStatus: "connected", role: "player" },
        { accountId: guestAccount.id, connectionStatus: "connected", role: "player" },
      ],
      room: { status: "playing" },
      seats: [
        { occupant: { accountId: hostAccount.id, ready: true }, seatId: "seat-1" },
        { occupant: { accountId: guestAccount.id, ready: true }, seatId: "seat-2" },
      ],
    });

    const additionalRoomResponse = await runtime.app.inject({
      headers: unsafeHeaders(hostCookies, origin),
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "同设备第二房",
        practice: false,
        settings: {
          moveTimeSeconds: 60,
          rule: "freestyle",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      },
      url: "/api/v1/rooms",
    });
    expect(additionalRoomResponse.statusCode).toBe(201);
    const additionalRoom = additionalRoomResponse.json() as { roomId: string };
    expect(additionalRoom.roomId).not.toBe(created.roomId);

    const startedView = started.payload.gameView as {
      readonly players: readonly { readonly color: string; readonly seatId: string }[];
      readonly turn: string;
    };
    const activeSeatId = startedView.players.find(
      ({ color }) => color === startedView.turn,
    )?.seatId;
    if (!activeSeatId || !started.matchId) throw new Error("五子棋开局快照缺少行动方或对局 ID");
    const inactiveSeatId = activeSeatId === "seat-1" ? "seat-2" : "seat-1";
    const activeSocket = activeSeatId === "seat-1" ? hostSocket : guestSocket;
    const inactiveSocket = inactiveSeatId === "seat-1" ? hostSocket : guestSocket;
    const inactiveCookies = inactiveSeatId === "seat-1" ? hostCookies : guestCookies;
    const inactiveAccount = inactiveSeatId === "seat-1" ? hostAccount : guestAccount;

    const connectionLost = waitForSnapshot(
      activeSocket,
      created.roomId,
      (message) =>
        message.payload.members.some(
          ({ accountId, connectionStatus }) =>
            accountId === inactiveAccount.id && connectionStatus === "reconnecting",
        ) &&
        message.payload.seats.some(
          ({ controller, seatId }) => seatId === inactiveSeatId && controller?.kind === "fallback",
        ),
    );
    const inactiveClosed = once(inactiveSocket, "close");
    inactiveSocket.close();
    await inactiveClosed;
    const lost = await connectionLost;

    const lobbyResponse = await runtime.app.inject({
      headers: { cookie: inactiveCookies.header },
      method: "GET",
      url: "/api/v1/rooms?gameId=gomoku",
    });
    expect(lobbyResponse.statusCode).toBe(200);
    const lobbyRooms = (lobbyResponse.json() as { rooms: Record<string, unknown>[] }).rooms;
    expect(lobbyRooms.find(({ roomId }) => roomId === created.roomId)).toMatchObject({
      resumeAvailable: true,
      roomId: created.roomId,
    });
    const conflictingTicketResponse = await runtime.app.inject({
      headers: unsafeHeaders(inactiveCookies, origin),
      method: "POST",
      payload: {},
      url: `/api/v1/rooms/${created.roomId}/join-ticket`,
    });
    expect(conflictingTicketResponse.statusCode).toBe(409);
    expect(conflictingTicketResponse.json()).toMatchObject({
      error: {
        code: "CONNECTION_ROOM_CONFLICT",
        details: { resumeAvailable: true, roomId: created.roomId },
      },
    });

    const fallbackMoved = waitForSnapshot(
      activeSocket,
      created.roomId,
      (message) =>
        Array.isArray((message.payload.gameView as { readonly moves?: unknown[] }).moves) &&
        (message.payload.gameView as { readonly moves: unknown[] }).moves.length >= 2,
    );
    send(activeSocket, {
      expectedRevision: lost.revision,
      matchId: started.matchId,
      payload: { type: "gomoku.place", x: 7, y: 7 },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "game.action",
    });
    const latest = await fallbackMoved;
    const latestMoveCount = (latest.payload.gameView as { readonly moves: readonly unknown[] })
      .moves.length;

    const resumedSocket = await openSocket(wsUrl, origin, inactiveCookies, cleanups);
    const resumeSnapshot = waitForSnapshot(
      resumedSocket,
      created.roomId,
      (message) =>
        message.payload.members.some(
          ({ accountId, connectionStatus }) =>
            accountId === inactiveAccount.id && connectionStatus === "connected",
        ) &&
        message.payload.seats.some(
          ({ controller, seatId }) => seatId === inactiveSeatId && controller?.kind === "human",
        ),
    );
    send(resumedSocket, {
      payload: { roomId: created.roomId },
      protocol: 1,
      requestId: ulid(),
      type: "room.resume",
    });
    const resumed = await resumeSnapshot;
    expect((resumed.payload.gameView as { readonly moves: readonly unknown[] }).moves).toHaveLength(
      latestMoveCount,
    );
    expect(resumed.revision).toBeGreaterThan(latest.revision);
  }, 30_000);

  it("forwards validated transient game events only from the active seat", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    const passwordHash = await new PasswordService(1).hash("transient-password");
    const hostAccount = runtime.repositories.accounts.create({
      passwordHash,
      username: "临时事件房主",
    });
    const guestAccount = runtime.repositories.accounts.create({
      passwordHash,
      username: "临时事件玩家",
    });
    const hostCookies = await login(runtime, hostAccount.username, "transient-password");
    const guestCookies = await login(runtime, guestAccount.username, "transient-password");
    const createdResponse = await runtime.app.inject({
      headers: unsafeHeaders(hostCookies, origin),
      method: "POST",
      payload: {
        gameId: "billiards",
        name: "临时瞄准同步房",
        practice: false,
        settings: { mode: "chinese-eight-ball" },
      },
      url: "/api/v1/rooms",
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as { joinTicket: string; roomId: string };
    const guestTicketResponse = await runtime.app.inject({
      headers: unsafeHeaders(guestCookies, origin),
      method: "POST",
      payload: {},
      url: `/api/v1/rooms/${created.roomId}/join-ticket`,
    });
    expect(guestTicketResponse.statusCode).toBe(200);
    const guestTicket = guestTicketResponse.json() as { joinTicket: string };

    const hostSocket = await openSocket(wsUrl, origin, hostCookies, cleanups);
    const guestSocket = await openSocket(wsUrl, origin, guestCookies, cleanups);
    const hostJoinedPromise = waitForSnapshot(hostSocket, created.roomId);
    send(hostSocket, {
      payload: { joinTicket: created.joinTicket },
      protocol: 1,
      requestId: ulid(),
      type: "room.join",
    });
    await hostJoinedPromise;
    const guestJoinedPromise = waitForSnapshot(guestSocket, created.roomId);
    send(guestSocket, {
      payload: { joinTicket: guestTicket.joinTicket },
      protocol: 1,
      requestId: ulid(),
      type: "room.join",
    });
    const guestJoined = await guestJoinedPromise;
    const hostMember = guestJoined.payload.members.find(
      ({ accountId }) => accountId === hostAccount.id,
    );
    const guestMember = guestJoined.payload.members.find(
      ({ accountId }) => accountId === guestAccount.id,
    );
    if (!hostMember || !guestMember) throw new Error("双人房间缺少已连接成员");

    const room = runtime.rooms.require(created.roomId);
    await room.claimSeat(hostMember.memberId, seatIdSchema.parse("seat-1"), room.state.revision);
    await room.claimSeat(guestMember.memberId, seatIdSchema.parse("seat-2"), room.state.revision);
    await room.setReady(hostMember.memberId, true, room.state.revision);
    await room.setReady(guestMember.memberId, true, room.state.revision);
    await room.startMatch(hostMember.memberId, room.state.revision);
    const matchId = room.state.match?.matchId;
    if (matchId === undefined) throw new Error("台球对局未创建");

    const previewRequestId = ulid();
    const receivedPromise = waitForServerMessage(
      guestSocket,
      (message) => message.type === "game.transient" && message.matchId === matchId,
    );
    send(hostSocket, {
      matchId,
      payload: {
        angle: Math.PI / 4,
        elevation: 12,
        power: 68,
        shotNumber: 0,
        tip: { x: 0.25, y: -0.15 },
        type: "billiards.aim-preview",
      },
      protocol: 1,
      requestId: previewRequestId,
      roomId: created.roomId,
      type: "game.transient",
    });
    await expect(receivedPromise).resolves.toMatchObject({
      payload: {
        event: { elevation: 12, power: 68, type: "billiards.aim-preview" },
        senderSeatId: "seat-1",
      },
      type: "game.transient",
    });

    const duplicateMessages: ServerMessage[] = [];
    const collectDuplicate = (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        duplicateMessages.push(serverMessageSchema.parse(JSON.parse(data.toString("utf8"))));
      }
    };
    hostSocket.on("message", collectDuplicate);
    guestSocket.on("message", collectDuplicate);
    const duplicateBarrier = waitForSnapshot(guestSocket, created.roomId, (message) =>
      message.payload.chat.some(({ text }) => text === "临时事件去重屏障"),
    );
    send(hostSocket, {
      matchId,
      payload: {
        angle: Math.PI / 4,
        elevation: 12,
        power: 68,
        shotNumber: 0,
        tip: { x: 0.25, y: -0.15 },
        type: "billiards.aim-preview",
      },
      protocol: 1,
      requestId: previewRequestId,
      roomId: created.roomId,
      type: "game.transient",
    });
    send(hostSocket, {
      payload: { text: "临时事件去重屏障" },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "chat.send",
    });
    await duplicateBarrier;
    hostSocket.off("message", collectDuplicate);
    guestSocket.off("message", collectDuplicate);
    expect(
      duplicateMessages.some(
        (message) =>
          (message.type === "room.snapshot" && message.causedBy === previewRequestId) ||
          (message.type === "game.transient" && message.payload.event.power === 68),
      ),
    ).toBe(false);

    const authoritativeRequestId = ulid();
    const authoritativeText = "权威请求去重隔离";
    const authoritativeCreated = waitForSnapshot(hostSocket, created.roomId, (message) =>
      message.payload.chat.some(({ text }) => text === authoritativeText),
    );
    send(hostSocket, {
      payload: { text: authoritativeText },
      protocol: 1,
      requestId: authoritativeRequestId,
      roomId: created.roomId,
      type: "chat.send",
    });
    await authoritativeCreated;

    const rateLimit = vi
      .spyOn(SlidingWindowRateLimiter.prototype, "consume")
      .mockReturnValue({ allowed: true, remaining: 1, retryAfterMs: 0 });
    cleanups.push(() => rateLimit.mockRestore());
    const lastFloodPreview = waitForServerMessage(
      guestSocket,
      (message) =>
        message.type === "game.transient" && message.payload.event.angle === Math.PI / 129,
    );
    for (let index = 1; index <= 129; index += 1) {
      send(hostSocket, {
        matchId,
        payload: {
          angle: Math.PI / index,
          elevation: 0,
          power: 50,
          shotNumber: 0,
          tip: { x: 0, y: 0 },
          type: "billiards.aim-preview",
        },
        protocol: 1,
        requestId: ulid(),
        roomId: created.roomId,
        type: "game.transient",
      });
    }
    await lastFloodPreview;

    const replayBarrierText = "权威请求重放屏障";
    const replayBarrier = waitForSnapshot(hostSocket, created.roomId, (message) =>
      message.payload.chat.some(({ text }) => text === replayBarrierText),
    );
    send(hostSocket, {
      payload: { text: authoritativeText },
      protocol: 1,
      requestId: authoritativeRequestId,
      roomId: created.roomId,
      type: "chat.send",
    });
    send(hostSocket, {
      payload: { text: replayBarrierText },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "chat.send",
    });
    const afterReplay = await replayBarrier;
    expect(afterReplay.payload.chat.filter(({ text }) => text === authoritativeText)).toHaveLength(
      1,
    );

    const deniedPromise = waitForServerMessage(
      guestSocket,
      (message) => message.type === "command.error",
    );
    send(guestSocket, {
      matchId,
      payload: {
        angle: 0,
        elevation: 0,
        power: 50,
        shotNumber: 0,
        tip: { x: 0, y: 0 },
        type: "billiards.aim-preview",
      },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "game.transient",
    });
    await expect(deniedPromise).resolves.toMatchObject({
      payload: { code: "ROOM_PERMISSION_DENIED" },
      type: "command.error",
    });

    const bufferedAmount = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockImplementation(function (this: WebSocket) {
        return (this as WebSocket & { readonly _isServer?: boolean })._isServer ? 1024 * 1024 : 0;
      });
    cleanups.push(() => bufferedAmount.mockRestore());
    const backloggedMessages: ServerMessage[] = [];
    const onBackloggedMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      backloggedMessages.push(serverMessageSchema.parse(JSON.parse(data.toString("utf8"))));
    };
    guestSocket.on("message", onBackloggedMessage);
    const authoritativeSnapshot = waitForSnapshot(guestSocket, created.roomId, (message) =>
      message.payload.chat.some(({ text }) => text === "权威消息背压验证"),
    );
    send(hostSocket, {
      matchId,
      payload: {
        angle: Math.PI / 3,
        elevation: 18,
        power: 72,
        shotNumber: 0,
        tip: { x: -0.2, y: 0.1 },
        type: "billiards.aim-preview",
      },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "game.transient",
    });
    send(hostSocket, {
      payload: { text: "权威消息背压验证" },
      protocol: 1,
      requestId: ulid(),
      roomId: created.roomId,
      type: "chat.send",
    });
    await expect(authoritativeSnapshot).resolves.toMatchObject({ type: "room.snapshot" });
    guestSocket.off("message", onBackloggedMessage);
    expect(
      backloggedMessages.some(
        (message) => message.type === "game.transient" && message.payload.event.power === 72,
      ),
    ).toBe(false);
  }, 30_000);

  it("destroys only matching rooms on game shutdown and every room on site shutdown", async () => {
    const { origin, runtime, wsUrl } = await startTestRuntime(cleanups);
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("service-password"),
      role: "admin",
      username: "服务管理员",
    });
    const gomokuCookies = await login(runtime, "服务管理员", "service-password");
    const ludoCookies = await login(runtime, "服务管理员", "service-password");

    const gomokuCreated = await runtime.app.inject({
      headers: unsafeHeaders(gomokuCookies, origin),
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "待关闭五子棋",
        practice: false,
        settings: {
          moveTimeSeconds: 60,
          rule: "freestyle",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      },
      url: "/api/v1/rooms",
    });
    const ludoCreated = await runtime.app.inject({
      headers: unsafeHeaders(ludoCookies, origin),
      method: "POST",
      payload: {
        gameId: "ludo",
        name: "待关闭飞行棋",
        practice: false,
        settings: { phaseTimeSeconds: 30 },
      },
      url: "/api/v1/rooms",
    });
    expect(gomokuCreated.statusCode).toBe(201);
    expect(ludoCreated.statusCode).toBe(201);
    const gomoku = gomokuCreated.json() as { joinTicket: string; roomId: string };
    const ludo = ludoCreated.json() as { joinTicket: string; roomId: string };
    const gomokuSocket = await openSocket(wsUrl, origin, gomokuCookies, cleanups);
    const ludoSocket = await openSocket(wsUrl, origin, ludoCookies, cleanups);
    const gomokuJoin = waitForSnapshot(gomokuSocket, gomoku.roomId);
    send(gomokuSocket, {
      payload: { joinTicket: gomoku.joinTicket },
      protocol: 1,
      requestId: ulid(),
      type: "room.join",
    });
    await gomokuJoin;
    const ludoJoin = waitForSnapshot(ludoSocket, ludo.roomId);
    send(ludoSocket, {
      payload: { joinTicket: ludo.joinTicket },
      protocol: 1,
      requestId: ulid(),
      type: "room.join",
    });
    await ludoJoin;

    const gomokuClosed = waitForRoomClosed(gomokuSocket, gomoku.roomId);
    const gameDisabled = await runtime.app.inject({
      headers: unsafeHeaders(gomokuCookies, origin),
      method: "PUT",
      payload: { enabled: false },
      url: "/api/v1/admin/services/games/gomoku",
    });
    expect(gameDisabled.statusCode).toBe(200);
    expect(await gomokuClosed).toMatchObject({
      payload: { reason: "game_disabled" },
    });
    expect(() => runtime.rooms.require(gomoku.roomId)).toThrowError(
      expect.objectContaining({ code: "ROOM_NOT_FOUND" }),
    );
    expect(runtime.rooms.require(ludo.roomId).destroyed).toBe(false);

    const ludoClosed = waitForRoomClosed(ludoSocket, ludo.roomId);
    const siteDisabled = await runtime.app.inject({
      headers: unsafeHeaders(gomokuCookies, origin),
      method: "PUT",
      payload: { enabled: false, maintenanceMessage: "维护测试" },
      url: "/api/v1/admin/services/site",
    });
    expect(siteDisabled.statusCode).toBe(200);
    expect(await ludoClosed).toMatchObject({
      payload: { reason: "site_disabled" },
    });
    expect(() => runtime.rooms.require(ludo.roomId)).toThrowError(
      expect.objectContaining({ code: "ROOM_NOT_FOUND" }),
    );
  }, 30_000);

  it("authenticates, joins a room and dispatches revisioned commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tabletop-gateway-"));
    cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
    const config: AppConfig = {
      COOKIE_SECURE: false,
      DATABASE_PATH: join(directory, "tabletop.db"),
      GAME_AI_WORKERS: 0,
      HOST: "127.0.0.1",
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
      PORT: 0,
      SESSION_SECRET: "s".repeat(32),
      TRUST_PROXY: false,
    };
    const runtime = await createRuntime(config, serverGameRegistry);
    cleanups.push(async () => runtime.app.close());
    runtime.repositories.accounts.create({
      passwordHash: await new PasswordService(1).hash("gateway-password"),
      role: "admin",
      username: "网关管理员",
    });
    await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const address = runtime.app.server.address();
    if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
    const origin = `http://127.0.0.1:${address.port}`;

    const login = await runtime.app.inject({
      method: "POST",
      payload: { password: "gateway-password", username: "网关管理员" },
      url: "/api/v1/auth/login",
    });
    expect(login.statusCode).toBe(200);
    const cookies = cookiesFrom(login.headers);
    const created = await runtime.app.inject({
      headers: {
        cookie: cookies.header,
        host: `127.0.0.1:${address.port}`,
        origin,
        "x-csrf-token": cookies.values.tt_csrf,
      },
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "网关联调房",
        practice: false,
        settings: {
          moveTimeSeconds: 60,
          rule: "freestyle",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      },
      url: "/api/v1/rooms",
    });
    expect(created.statusCode).toBe(201);
    const room = created.json() as { joinTicket: string; roomId: string };

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?protocol=1`, {
      headers: { Cookie: cookies.header },
      origin,
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          socket.once("close", () => resolve());
          socket.close();
        }),
    );
    const readyMessage = once(socket, "message");
    await once(socket, "open");
    expect(serverMessageSchema.parse(JSON.parse(String((await readyMessage)[0])))).toMatchObject({
      type: "connection.ready",
    });

    const joinRequestId = ulid();
    const joinSnapshot = waitForSnapshot(socket, room.roomId);
    const joinAck = waitForCommandAck(socket, joinRequestId);
    socket.send(
      JSON.stringify({
        payload: { joinTicket: room.joinTicket },
        protocol: 1,
        requestId: joinRequestId,
        type: "room.join",
      }),
    );
    const [joined] = await Promise.all([joinSnapshot, joinAck]);
    expect(joined).toMatchObject({ roomId: room.roomId, type: "room.snapshot" });

    const claimRequestId = ulid();
    const claimedSnapshot = waitForSnapshot(
      socket,
      room.roomId,
      ({ revision }) => revision === joined.revision + 1,
    );
    const claimAck = waitForCommandAck(socket, claimRequestId);
    socket.send(
      JSON.stringify({
        expectedRevision: joined.revision,
        payload: { seatId: "seat-1" },
        protocol: 1,
        requestId: claimRequestId,
        roomId: room.roomId,
        type: "room.seat.claim",
      }),
    );
    const [claimed] = await Promise.all([claimedSnapshot, claimAck]);
    expect(claimed).toMatchObject({ revision: joined.revision + 1, type: "room.snapshot" });

    const duplicateSnapshot = waitForSnapshot(
      socket,
      room.roomId,
      ({ revision }) => revision === joined.revision + 1,
    );
    socket.send(
      JSON.stringify({
        expectedRevision: joined.revision,
        payload: { seatId: "seat-1" },
        protocol: 1,
        requestId: claimRequestId,
        roomId: room.roomId,
        type: "room.seat.claim",
      }),
    );
    const duplicate = await duplicateSnapshot;
    expect(duplicate).toMatchObject({ revision: joined.revision + 1, type: "room.snapshot" });
  }, 30_000);
});
