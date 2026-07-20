import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serverMessageSchema, type ServerMessage } from "@tabletop/protocol";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { PasswordService } from "../auth/password.js";
import type { AppConfig } from "../config.js";
import { serverGameRegistry } from "../games/registry.js";
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

describe("RoomWebSocketGateway", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
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

  it("acknowledges join, resume and non-final leave while deduplicating entry commands", async () => {
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

    const reconnectingPromise = waitForSnapshot(hostSocket, created.roomId, (message) =>
      message.payload.members.some(
        (member) =>
          member.accountId === guestAccount.id && member.connectionStatus === "reconnecting",
      ),
    );
    const guestClosedPromise = once(guestSocket, "close");
    guestSocket.close();
    await guestClosedPromise;
    await reconnectingPromise;

    const resumedSocket = await openSocket(wsUrl, origin, guestCookies, cleanups);
    const resumeRequestId = ulid();
    const resumeSnapshotPromise = waitForSnapshot(resumedSocket, created.roomId);
    const resumeAckPromise = waitForCommandAck(resumedSocket, resumeRequestId);
    send(resumedSocket, {
      payload: { roomId: created.roomId },
      protocol: 1,
      requestId: resumeRequestId,
      type: "room.resume",
    });
    const [resumed, resumeAck] = await Promise.all([resumeSnapshotPromise, resumeAckPromise]);
    expect(resumeAck).toMatchObject({
      causedBy: resumeRequestId,
      payload: { stateChanged: true },
      revision: resumed.revision,
      roomId: created.roomId,
    });

    const leaveRequestId = ulid();
    const hostAfterLeavePromise = waitForSnapshot(hostSocket, created.roomId, (message) =>
      message.payload.members.every((member) => member.accountId !== guestAccount.id),
    );
    const leaveAckPromise = waitForCommandAck(resumedSocket, leaveRequestId);
    send(resumedSocket, {
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
    expect(resumedSocket.readyState).toBe(WebSocket.OPEN);
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

    const conflictingRoom = await runtime.app.inject({
      headers: unsafeHeaders(hostCookies, origin),
      method: "POST",
      payload: {
        gameId: "gomoku",
        name: "同设备冲突房",
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
    expect(conflictingRoom.statusCode).toBe(409);
    expect(conflictingRoom.json()).toMatchObject({
      error: { code: "CONNECTION_ROOM_CONFLICT" },
    });

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
