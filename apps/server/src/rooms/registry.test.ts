import { createRepositories, openDatabase } from "@tabletop/database";
import { createDefaultSeatDefinitionsV1, defineGameSharedContractV1 } from "@tabletop/game-sdk";
import {
  defineGameServerModuleV1,
  GameRuleError,
  registerServerGamesV1,
} from "@tabletop/game-sdk/server";
import { gameIdSchema, seatIdSchema, sessionIdSchema, type SeatId } from "@tabletop/protocol";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { GameAutomationExecutor } from "../automation/executor.js";
import { serverGameRegistry } from "../games/registry.js";
import { RoomPasswordService } from "./password.js";
import { RoomRegistry } from "./registry.js";
import type { RoomPublisher } from "./types.js";

const settingsSchema = z.strictObject({});
const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("test.move") }),
  z.strictObject({ type: z.literal("test.noop") }),
]);
const viewSchema = z.strictObject({ moves: z.number().int(), turn: seatIdSchema });
const eventSchema = z.strictObject({ type: z.literal("test.moved"), seatId: seatIdSchema });
const transientEventSchema = z.strictObject({
  type: z.literal("test.aim-preview"),
  power: z.number().min(1).max(100),
});

interface TestState {
  readonly moves: number;
  readonly turn: SeatId;
}

const shared = defineGameSharedContractV1({
  actionSchema,
  displayEventSchema: eventSchema,
  manifest: {
    apiVersion: 1,
    capabilities: {
      bots: true,
      hiddenInformation: false,
      manualSeatReclaim: false,
      midgameJoin: false,
      soloPractice: false,
      spectators: true,
      temporaryController: false,
      timers: false,
    },
    description: "房间运行时测试插件",
    displayName: "测试插件",
    gameId: gameIdSchema.parse("test-room"),
    interactionMode: "turn_based",
    maxPlayers: 2,
    minPlayers: 2,
  },
  settings: { defaultValue: {}, schema: settingsSchema, summarize: () => [] },
  transientEventSchema,
  viewSchema,
});

const testGame = defineGameServerModuleV1({
  shared,
  lobby: {
    getSeatDefinitions: () => createDefaultSeatDefinitionsV1(2),
    validateStart: () => ({ ok: true }),
  },
  createMatch: () => ({ moves: 0, turn: seatIdSchema.parse("seat-1") }),
  bot: {
    inputSchema: viewSchema,
    listProfiles: () => [
      {
        description: "房间运行时测试 AI",
        displayName: "测试 AI",
        profileId: "test",
        timeBudgetMs: 100,
      },
    ],
    createInput: (_context, state) => ({ moves: state.moves, turn: state.turn }),
    chooseAction: async () => ({ type: "test.move" }),
  },
  getActiveSeatIds: (state) => [state.turn],
  getDeadlines: () => [],
  handleAction: (context, state, action) => {
    if (context.actor.seatId !== state.turn) {
      throw new GameRuleError("NOT_YOUR_TURN");
    }
    if (action.type === "test.noop") {
      return { kind: "noop", state };
    }
    const nextTurn =
      state.turn === "seat-1" ? seatIdSchema.parse("seat-2") : seatIdSchema.parse("seat-1");
    return {
      events: [{ seatId: context.actor.seatId, type: "test.moved" }],
      kind: "applied",
      state: { moves: state.moves + 1, turn: nextTurn },
    };
  },
  handleDeadline: (_context, state) => ({ kind: "noop", state }),
  handleSystemEvent: (_context, state, event) =>
    event.type === "connection.grace_expired"
      ? {
          events: [],
          kind: "applied",
          roomDirectives: [{ seatId: event.seatId, type: "seat.release" }],
          state,
        }
      : { kind: "noop", state },
  projectView: (_context, state) => ({ moves: state.moves, turn: state.turn }),
});

function createBotlessTestGame(gameId: string, soloPractice: boolean) {
  const gameShared = defineGameSharedContractV1({
    actionSchema,
    displayEventSchema: eventSchema,
    manifest: {
      apiVersion: 1,
      capabilities: {
        bots: false,
        hiddenInformation: false,
        manualSeatReclaim: false,
        midgameJoin: false,
        soloPractice,
        spectators: true,
        temporaryController: false,
        timers: false,
      },
      description: "无 AI 房间运行时测试插件",
      displayName: "无 AI 测试插件",
      gameId: gameIdSchema.parse(gameId),
      interactionMode: "turn_based" as const,
      maxPlayers: 2,
      minPlayers: 2,
    },
    settings: { defaultValue: {}, schema: settingsSchema, summarize: () => [] },
    viewSchema,
  });

  return defineGameServerModuleV1({
    shared: gameShared,
    lobby: {
      getSeatDefinitions: () => createDefaultSeatDefinitionsV1(2),
      validateStart: ({ seats }) =>
        seats.some(({ occupant }) => occupant === "human") &&
        seats.every(({ occupant }) => occupant !== "bot")
          ? { ok: true }
          : { ok: false, ruleCode: "HUMAN_REQUIRED" },
    },
    createMatch: ({ seats }) => {
      const first = seats[0];
      if (!first) throw new GameRuleError("HUMAN_REQUIRED");
      return { moves: 0, turn: first.seatId };
    },
    getActiveSeatIds: (state) => [state.turn],
    getDeadlines: () => [],
    handleAction: (_context, state) => ({ kind: "noop", state }),
    handleDeadline: (_context, state) => ({ kind: "noop", state }),
    handleSystemEvent: (_context, state, event) =>
      soloPractice && event.type === "connection.grace_expired"
        ? {
            events: [],
            kind: "applied",
            roomDirectives: [{ seatId: event.seatId, type: "seat.release" }],
            state,
          }
        : { kind: "noop", state },
    projectView: (_context, state) => ({ moves: state.moves, turn: state.turn }),
  });
}

const soloPracticeGame = createBotlessTestGame("test-solo-practice", true);
const noPracticeGame = createBotlessTestGame("test-no-practice", false);

const pausedAutomation: GameAutomationExecutor = {
  chooseBotAction: () => new Promise(() => undefined),
  chooseFallbackAction: () => new Promise(() => undefined),
  close: () => Promise.resolve(),
};

type TestCloser = () => void;

function createTestRegistry(
  closers: TestCloser[],
  options: {
    readonly accountCount?: number;
    readonly automation?: GameAutomationExecutor;
    readonly passwords?: RoomPasswordService;
  } = {},
) {
  const connection = openDatabase(":memory:");
  closers.push(() => connection.close());
  const repositories = createRepositories(connection.database);
  const accounts = Array.from({ length: options.accountCount ?? 1 }, (_, index) =>
    repositories.accounts.create({
      passwordHash: "hash",
      username: `并发用户${index + 1}`,
    }),
  );
  const sessions = accounts.map((account, index) =>
    repositories.sessions.create({
      accountId: account.id,
      csrfSecretHash: Buffer.alloc(32, index + 41),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, index + 81),
    }),
  );
  const registry = new RoomRegistry({
    ...(options.automation === undefined ? {} : { automation: options.automation }),
    games: registerServerGamesV1([testGame, soloPracticeGame, noPracticeGame]),
    ...(options.passwords === undefined ? {} : { passwords: options.passwords }),
    repositories,
  });
  return { accounts, registry, repositories, sessions };
}

async function createStartedRealGameRoom(
  closers: TestCloser[],
  options: {
    readonly gameId: "gomoku" | "ludo";
    readonly seatIds: readonly string[];
    readonly settings: object;
  },
) {
  const connection = openDatabase(":memory:");
  closers.push(() => connection.close());
  const repositories = createRepositories(connection.database);
  const accounts = [
    repositories.accounts.create({ passwordHash: "hash", username: "边界用户甲" }),
    repositories.accounts.create({ passwordHash: "hash", username: "边界用户乙" }),
  ];
  const sessions = accounts.map((account, index) =>
    repositories.sessions.create({
      accountId: account.id,
      csrfSecretHash: Buffer.alloc(32, index + 1),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, index + 11),
    }),
  );
  const registry = new RoomRegistry({
    automation: pausedAutomation,
    games: serverGameRegistry,
    repositories,
  });
  const created = await registry.createRoom({
    account: accounts[0]!,
    gameId: options.gameId,
    name: `${options.gameId} 边界房间`,
    practice: false,
    session: sessions[0]!,
    settings: options.settings,
  });
  closers.push(() => created.room.destroy("host_closed", "测试结束"));

  const hostJoin = await registry.consumeJoinTicket(
    created.ticket.token,
    accounts[0]!,
    sessions[0]!,
  );
  const guestTicket = registry.issueInviteJoinTicket({
    inviteToken: created.room.state.inviteToken,
    session: sessions[1]!,
  });
  const guestJoin = await registry.consumeJoinTicket(guestTicket.token, accounts[1]!, sessions[1]!);
  const joins = [hostJoin, guestJoin] as const;
  const connectionIds = ["connection-host", "connection-guest"] as const;

  for (const [index, joined] of joins.entries()) {
    await created.room.attachConnection(joined.member.memberId, connectionIds[index]!);
    await created.room.claimSeat(
      joined.member.memberId,
      seatIdSchema.parse(options.seatIds[index]),
      created.room.state.revision,
    );
    await created.room.setReady(joined.member.memberId, true, created.room.state.revision);
  }
  await created.room.startMatch(hostJoin.member.memberId, created.room.state.revision);

  return {
    players: joins.map((joined, index) => ({
      account: accounts[index]!,
      connectionId: connectionIds[index]!,
      member: joined.member,
      seatId: seatIdSchema.parse(options.seatIds[index]),
      session: sessions[index]!,
    })),
    registry,
    repositories,
    room: created.room,
  };
}

describe("RoomRegistry and RoomRuntime", () => {
  const closers: Array<() => void> = [];

  afterEach(() => {
    closers
      .splice(0)
      .reverse()
      .forEach((close) => close());
    vi.useRealTimers();
  });

  it("runs a two-member authoritative room through the generic plugin host", async () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const account1 = repositories.accounts.create({ passwordHash: "hash", username: "房主用户" });
    const account2 = repositories.accounts.create({ passwordHash: "hash", username: "加入用户" });
    const session1 = repositories.sessions.create({
      accountId: account1.id,
      csrfSecretHash: Buffer.alloc(32, 1),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, 2),
    });
    const session2 = repositories.sessions.create({
      accountId: account2.id,
      csrfSecretHash: Buffer.alloc(32, 3),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, 4),
    });
    const registry = new RoomRegistry({
      games: registerServerGamesV1([testGame]),
      repositories,
    });
    let snapshotCount = 0;
    const publisher: RoomPublisher = {
      disconnectMember: () => undefined,
      publishClosed: () => undefined,
      publishSnapshot: () => {
        snapshotCount += 1;
      },
    };
    registry.setPublisher(publisher);

    const created = await registry.createRoom({
      account: account1,
      gameId: "test-room",
      name: "权威房间",
      practice: false,
      session: session1,
      settings: {},
    });
    const hostJoin = await registry.consumeJoinTicket(created.ticket.token, account1, session1);
    await created.room.attachConnection(hostJoin.member.memberId, `connection-${ulid()}`);
    await created.room.claimSeat(
      hostJoin.member.memberId,
      seatIdSchema.parse("seat-1"),
      created.room.state.revision,
    );

    const invite = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: session2,
    });
    const joined = await registry.consumeJoinTicket(invite.token, account2, session2);
    const guestConnectionId = `connection-${ulid()}`;
    await created.room.attachConnection(joined.member.memberId, guestConnectionId);
    await created.room.claimSeat(
      joined.member.memberId,
      seatIdSchema.parse("seat-2"),
      created.room.state.revision,
    );
    await created.room.setReady(hostJoin.member.memberId, true, created.room.state.revision);
    await created.room.setReady(joined.member.memberId, true, created.room.state.revision);
    await created.room.startMatch(hostJoin.member.memberId, created.room.state.revision);

    const revisionBeforeTransient = created.room.state.revision;
    await expect(
      created.room.gameTransient(
        hostJoin.member.memberId,
        { power: 64, type: "test.aim-preview" },
        created.room.state.match?.matchId ?? "missing",
      ),
    ).resolves.toEqual({
      event: { power: 64, type: "test.aim-preview" },
      senderSeatId: "seat-1",
    });
    expect(created.room.state.revision).toBe(revisionBeforeTransient);
    await expect(
      created.room.gameTransient(
        joined.member.memberId,
        { power: 64, type: "test.aim-preview" },
        created.room.state.match?.matchId ?? "missing",
      ),
    ).rejects.toMatchObject({ code: "ROOM_PERMISSION_DENIED" });
    await expect(
      created.room.gameTransient(
        hostJoin.member.memberId,
        { power: 101, type: "test.aim-preview" },
        created.room.state.match?.matchId ?? "missing",
      ),
    ).rejects.toBeInstanceOf(z.ZodError);

    const revisionBeforeMove = created.room.state.revision;
    await created.room.gameAction(
      hostJoin.member.memberId,
      { type: "test.move" },
      created.room.state.match?.matchId ?? "missing",
      revisionBeforeMove,
      1,
    );

    expect(created.room.state.revision).toBe(revisionBeforeMove + 1);
    expect(created.room.projectSnapshot(hostJoin.member.memberId)).toMatchObject({
      gameView: { moves: 1, turn: "seat-2" },
      room: { name: "权威房间", status: "playing" },
    });

    const revisionBeforeConcurrentCommands = created.room.state.revision;
    const chat = created.room.sendChat(hostJoin.member.memberId, "并发修订测试");
    const noop = created.room.gameAction(
      joined.member.memberId,
      { type: "test.noop" },
      created.room.state.match?.matchId ?? "missing",
      revisionBeforeConcurrentCommands + 1,
      2,
    );
    await chat;
    await expect(noop).resolves.toBe(false);
    expect(created.room.state.revision).toBe(revisionBeforeConcurrentCommands + 1);
    expect(snapshotCount).toBeGreaterThanOrEqual(8);
    const sameSessionRoom = await registry.createRoom({
      account: account1,
      gameId: "test-room",
      name: "同会话房间",
      practice: false,
      session: session1,
      settings: {},
    });
    expect(registry.bindingForSession(session1.id, created.room.state.roomId)).toMatchObject({
      memberId: hostJoin.member.memberId,
    });
    expect(
      registry.bindingForSession(session1.id, sameSessionRoom.room.state.roomId),
    ).toMatchObject({ memberId: sameSessionRoom.room.state.hostMemberId });
    sameSessionRoom.room.destroy("host_closed", "测试结束");
    expect(registry.bindingForSession(session1.id, created.room.state.roomId)).toMatchObject({
      memberId: hostJoin.member.memberId,
    });

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await created.room.connectionLost(
      joined.member.memberId,
      guestConnectionId,
      Date.now() - 30_001,
    );
    await vi.advanceTimersByTimeAsync(0);
    await created.room.queue.run(() => undefined);
    expect(created.room.state.members.has(joined.member.memberId)).toBe(false);
    expect(created.room.state.seats.find(({ seatId }) => seatId === "seat-2")?.occupant).toBeNull();
    expect(registry.bindingForSession(session2.id)).toBeUndefined();

    created.room.destroy("host_closed", "测试结束");
  });

  it("allows concurrent room creation for one session with independent bindings", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers);
    const account = accounts[0]!;
    const session = sessions[0]!;

    const createdRooms = await Promise.all([
      registry.createRoom({
        account,
        gameId: "test-room",
        name: "并发房间甲",
        practice: false,
        session,
        settings: {},
      }),
      registry.createRoom({
        account,
        gameId: "test-room",
        name: "并发房间乙",
        practice: false,
        session,
        settings: {},
      }),
    ]);

    expect(createdRooms).toHaveLength(2);
    expect(new Set(createdRooms.map(({ room }) => room.state.roomId)).size).toBe(2);
    expect(registry.listPublicRooms()).toHaveLength(2);
    for (const { room } of createdRooms) {
      expect(registry.bindingForSession(session.id, room.state.roomId)).toEqual({
        memberId: room.state.hostMemberId,
        roomId: room.state.roomId,
      });
    }
    createdRooms.forEach(({ room }) => room.destroy("host_closed", "测试结束"));
  });

  it("allows concurrent join ticket consumption for one session in different rooms", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers, { accountCount: 3 });
    const rooms = await Promise.all(
      [0, 1].map(async (index) => {
        const created = await registry.createRoom({
          account: accounts[index]!,
          gameId: "test-room",
          name: `票据房间${index + 1}`,
          practice: false,
          session: sessions[index]!,
          settings: {},
        });
        await registry.consumeJoinTicket(created.ticket.token, accounts[index]!, sessions[index]!);
        return created.room;
      }),
    );
    const tickets = rooms.map((room) =>
      registry.issueInviteJoinTicket({
        inviteToken: room.state.inviteToken,
        session: sessions[2]!,
      }),
    );

    const joins = await Promise.all(
      tickets.map((ticket) => registry.consumeJoinTicket(ticket.token, accounts[2]!, sessions[2]!)),
    );

    expect(joins).toHaveLength(2);
    expect(new Set(joins.map(({ member }) => member.memberId)).size).toBe(2);
    rooms.forEach((room, index) => {
      const joined = joins[index]!;
      expect(room.state.members.get(joined.member.memberId)).toBe(joined.member);
      expect(registry.bindingForSession(sessions[2]!.id, room.state.roomId)).toEqual({
        memberId: joined.member.memberId,
        roomId: room.state.roomId,
      });
    });
    rooms.forEach((room) => room.destroy("host_closed", "测试结束"));
  });

  it("keeps one member identity when a session consumes concurrent tickets for one room", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers, { accountCount: 2 });
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "同房票据并发",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    await registry.consumeJoinTicket(created.ticket.token, accounts[0]!, sessions[0]!);
    const tickets = [
      registry.issueInviteJoinTicket({
        inviteToken: created.room.state.inviteToken,
        session: sessions[1]!,
      }),
      registry.issueInviteJoinTicket({
        inviteToken: created.room.state.inviteToken,
        session: sessions[1]!,
      }),
    ];

    const results = await Promise.allSettled(
      tickets.map((ticket) => registry.consumeJoinTicket(ticket.token, accounts[1]!, sessions[1]!)),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "CONNECTION_ROOM_CONFLICT" }),
      }),
    ]);
    expect(
      [...created.room.state.members.values()].filter(
        ({ sessionId }) => sessionId === sessions[1]!.id,
      ),
    ).toHaveLength(1);
    expect(registry.bindingForSession(sessions[1]!.id, created.room.state.roomId)).toBeDefined();
    created.room.destroy("host_closed", "测试结束");
  });

  it("releases one room binding without affecting another binding for the same session", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers);
    const account = accounts[0]!;
    const session = sessions[0]!;
    const [first, second] = await Promise.all(
      ["待释放房间", "保留绑定房间"].map((name) =>
        registry.createRoom({
          account,
          gameId: "test-room",
          name,
          practice: false,
          session,
          settings: {},
        }),
      ),
    );
    if (!first || !second) throw new Error("测试未创建两个同会话房间");
    const firstJoin = await registry.consumeJoinTicket(first.ticket.token, account, session);
    const secondJoin = await registry.consumeJoinTicket(second.ticket.token, account, session);

    await first.room.leave(firstJoin.member.memberId);

    expect(first.room.destroyed).toBe(true);
    expect(registry.bindingForSession(session.id, first.room.state.roomId)).toBeUndefined();
    expect(registry.bindingForSession(session.id, second.room.state.roomId)).toEqual({
      memberId: secondJoin.member.memberId,
      roomId: second.room.state.roomId,
    });
    expect(second.room.destroyed).toBe(false);
    second.room.destroy("host_closed", "测试结束");
  });

  it("releases an unconnected room when its creation ticket expires", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { accounts, registry, sessions } = createTestRegistry(closers);
    const account = accounts[0]!;
    const session = sessions[0]!;
    const abandoned = await registry.createRoom({
      account,
      gameId: "test-room",
      name: "未连接房间",
      practice: false,
      session,
      settings: {},
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(abandoned.room.destroyed).toBe(true);
    expect(registry.bindingForSession(session.id)).toBeUndefined();
    expect(() => registry.require(abandoned.room.state.roomId)).toThrowError(
      expect.objectContaining({ code: "ROOM_NOT_FOUND" }),
    );
    const replacement = await registry.createRoom({
      account,
      gameId: "test-room",
      name: "重新创建房间",
      practice: false,
      session,
      settings: {},
    });
    expect(replacement.room.destroyed).toBe(false);
    replacement.room.destroy("host_closed", "测试结束");
  });

  it("uses resume to finish an initial attachment after an ambiguous join", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { accounts, registry, sessions } = createTestRegistry(closers);
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "首次连接恢复",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    const binding = registry.bindingForSession(sessions[0]!.id);
    if (!binding) throw new Error("测试房间没有预绑定成员");

    await created.room.resume(
      binding.memberId,
      sessionIdSchema.parse(sessions[0]!.id),
      "connection-initial-resume",
    );
    registry.confirmMemberAttached(binding.memberId);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(created.room.destroyed).toBe(false);
    expect(created.room.state.members.get(binding.memberId)).toMatchObject({
      connectionId: "connection-initial-resume",
      connectionStatus: "connected",
    });
    created.room.destroy("host_closed", "测试结束");
  });

  it("removes an unconnected creator without closing a room that already has a guest", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { accounts, registry, sessions } = createTestRegistry(closers, { accountCount: 2 });
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "访客已进入房间",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    const guestTicket = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: sessions[1]!,
    });
    const guest = await registry.consumeJoinTicket(guestTicket.token, accounts[1]!, sessions[1]!);
    await created.room.attachConnection(guest.member.memberId, "connection-early-guest");

    await vi.advanceTimersByTimeAsync(30_000);
    await created.room.queue.run(() => undefined);

    expect(created.room.destroyed).toBe(false);
    expect(created.room.state.members.size).toBe(1);
    expect(created.room.state.members.has(guest.member.memberId)).toBe(true);
    expect(created.room.state.hostMemberId).toBe(guest.member.memberId);
    expect(registry.bindingForSession(sessions[0]!.id)).toBeUndefined();
    expect(created.room.projectSnapshot(guest.member.memberId).room.name).toBe("访客已进入房间");
    created.room.destroy("host_closed", "测试结束");
  });

  it("keeps the last seated lobby member through reconnect grace and destroys at expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { accounts, registry, sessions } = createTestRegistry(closers);
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "大厅重连宽限",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    const joined = await registry.consumeJoinTicket(
      created.ticket.token,
      accounts[0]!,
      sessions[0]!,
    );
    await created.room.attachConnection(joined.member.memberId, "connection-lobby-host");
    await created.room.claimSeat(
      joined.member.memberId,
      seatIdSchema.parse("seat-1"),
      created.room.state.revision,
    );

    await created.room.connectionLost(joined.member.memberId, "connection-lobby-host");
    await vi.advanceTimersByTimeAsync(29_999);
    await created.room.queue.run(() => undefined);

    expect(created.room.destroyed).toBe(false);
    expect(joined.member).toMatchObject({ connectionStatus: "reconnecting" });
    expect(registry.bindingForSession(sessions[0]!.id, created.room.state.roomId)).toEqual({
      memberId: joined.member.memberId,
      roomId: created.room.state.roomId,
    });
    expect(registry.require(created.room.state.roomId)).toBe(created.room);

    await vi.advanceTimersByTimeAsync(1);
    await created.room.queue.run(() => undefined);

    expect(created.room.destroyed).toBe(true);
    expect(registry.bindingForSession(sessions[0]!.id, created.room.state.roomId)).toBeUndefined();
    expect(() => registry.require(created.room.state.roomId)).toThrowError(
      expect.objectContaining({ code: "ROOM_NOT_FOUND" }),
    );
  });

  it("waits for connected and reconnecting lobby members before destroying the room", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { accounts, registry, sessions } = createTestRegistry(closers, { accountCount: 2 });
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "多人大厅断线清理",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    const host = await registry.consumeJoinTicket(created.ticket.token, accounts[0]!, sessions[0]!);
    await created.room.attachConnection(host.member.memberId, "connection-lobby-host");
    await created.room.claimSeat(
      host.member.memberId,
      seatIdSchema.parse("seat-1"),
      created.room.state.revision,
    );
    const guestTicket = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: sessions[1]!,
    });
    const guest = await registry.consumeJoinTicket(guestTicket.token, accounts[1]!, sessions[1]!);
    await created.room.attachConnection(guest.member.memberId, "connection-lobby-guest");
    await created.room.claimSeat(
      guest.member.memberId,
      seatIdSchema.parse("seat-2"),
      created.room.state.revision,
    );

    await created.room.connectionLost(host.member.memberId, "connection-lobby-host");
    await vi.advanceTimersByTimeAsync(10_000);
    await created.room.queue.run(() => undefined);

    expect(created.room.destroyed).toBe(false);
    expect(guest.member.connectionStatus).toBe("connected");

    await created.room.connectionLost(guest.member.memberId, "connection-lobby-guest");
    await vi.advanceTimersByTimeAsync(20_000);
    await created.room.queue.run(() => undefined);

    expect(created.room.destroyed).toBe(false);
    expect(created.room.state.members.get(host.member.memberId)).toBe(host.member);
    expect(host.member.connectionStatus).toBe("offline");
    expect(guest.member.connectionStatus).toBe("reconnecting");
    expect(registry.bindingForSession(sessions[0]!.id, created.room.state.roomId)).toBeUndefined();
    expect(registry.bindingForSession(sessions[1]!.id, created.room.state.roomId)).toEqual({
      memberId: guest.member.memberId,
      roomId: created.room.state.roomId,
    });

    await vi.advanceTimersByTimeAsync(9_999);
    await created.room.queue.run(() => undefined);

    expect(created.room.destroyed).toBe(false);
    expect(guest.member.connectionStatus).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1);
    await created.room.queue.run(() => undefined);

    expect(created.room.destroyed).toBe(true);
    expect(registry.bindingForSession(sessions[1]!.id, created.room.state.roomId)).toBeUndefined();
    expect(() => registry.require(created.room.state.roomId)).toThrowError(
      expect.objectContaining({ code: "ROOM_NOT_FOUND" }),
    );
  });

  it("rechecks game availability after password hashing", async () => {
    const passwords = new RoomPasswordService();
    let finishHash: ((value: string) => void) | undefined;
    const hashStarted = new Promise<void>((resolve) => {
      vi.spyOn(passwords, "hash").mockImplementation(
        () =>
          new Promise<string>((finish) => {
            finishHash = finish;
            resolve();
          }),
      );
    });
    const { accounts, registry, repositories, sessions } = createTestRegistry(closers, {
      passwords,
    });
    const pending = registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "哈希中的房间",
      password: "secret",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    await hashStarted;
    repositories.services.updateGame("test-room", { enabled: false, updatedBy: null });
    finishHash?.("hashed-password");

    await expect(pending).rejects.toMatchObject({ code: "GAME_SERVICE_DISABLED" });
    expect(registry.listPublicRooms()).toHaveLength(0);
    expect(registry.bindingForSession(sessions[0]!.id)).toBeUndefined();
  });

  it("rechecks the account session after password hashing", async () => {
    const passwords = new RoomPasswordService();
    let finishHash: ((value: string) => void) | undefined;
    const hashStarted = new Promise<void>((resolve) => {
      vi.spyOn(passwords, "hash").mockImplementation(
        () =>
          new Promise<string>((finish) => {
            finishHash = finish;
            resolve();
          }),
      );
    });
    const { accounts, registry, repositories, sessions } = createTestRegistry(closers, {
      passwords,
    });
    const pending = registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "会话撤销中的房间",
      password: "secret",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    await hashStarted;
    repositories.sessions.revoke(sessions[0]!.id);
    finishHash?.("hashed-password");

    await expect(pending).rejects.toMatchObject({ code: "AUTH_SESSION_EXPIRED" });
    expect(registry.listPublicRooms()).toHaveLength(0);
    expect(registry.bindingForSession(sessions[0]!.id)).toBeUndefined();
  });

  it("rechecks room availability after password verification", async () => {
    const passwords = new RoomPasswordService();
    vi.spyOn(passwords, "hash").mockResolvedValue("hashed-password");
    let finishVerify: ((value: boolean) => void) | undefined;
    const verifyStarted = new Promise<void>((resolve) => {
      vi.spyOn(passwords, "verify").mockImplementation(
        () =>
          new Promise<boolean>((finish) => {
            finishVerify = finish;
            resolve();
          }),
      );
    });
    const { accounts, registry, sessions } = createTestRegistry(closers, {
      accountCount: 2,
      passwords,
    });
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "验证期间关闭房间",
      password: "secret",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    const pending = registry.issueListJoinTicket({
      password: "secret",
      roomId: created.room.state.roomId,
      session: sessions[1]!,
    });
    await verifyStarted;
    created.room.destroy("host_closed", "测试期间关闭");
    finishVerify?.(true);

    await expect(pending).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect(registry.bindingForSession(sessions[1]!.id)).toBeUndefined();
  });

  it("keeps one valid AI task while chat changes the room revision", async () => {
    let finishBotAction: ((action: { readonly type: "test.move" }) => void) | undefined;
    let failBotAction: ((error: Error) => void) | undefined;
    let botCalls = 0;
    const automation: GameAutomationExecutor = {
      chooseBotAction: () => {
        botCalls += 1;
        return new Promise((resolve, reject) => {
          finishBotAction = resolve;
          failBotAction = reject;
        });
      },
      chooseFallbackAction: () => Promise.reject(new Error("不应调用兜底控制器")),
      close: () => Promise.resolve(),
    };
    const { accounts, registry, sessions } = createTestRegistry(closers, { automation });
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "AI 调度房间",
      practice: true,
      session: sessions[0]!,
      settings: {},
    });
    expect(created.room.state.seats[1]?.occupant).toMatchObject({
      kind: "bot",
      profileId: "test",
    });
    const joined = await registry.consumeJoinTicket(
      created.ticket.token,
      accounts[0]!,
      sessions[0]!,
    );
    await created.room.attachConnection(joined.member.memberId, "connection-ai-host");
    await created.room.setReady(joined.member.memberId, true, created.room.state.revision);
    await created.room.startMatch(joined.member.memberId, created.room.state.revision);
    await created.room.gameAction(
      joined.member.memberId,
      { type: "test.move" },
      created.room.state.match?.matchId ?? "missing",
      created.room.state.revision,
      1,
    );
    expect(botCalls).toBe(1);

    for (let index = 0; index < 10; index += 1) {
      await created.room.sendChat(joined.member.memberId, `AI 思考期间消息 ${index + 1}`);
    }
    expect(botCalls).toBe(1);
    finishBotAction?.({ type: "test.move" });
    await vi.waitFor(() => {
      expect(created.room.projectSnapshot(joined.member.memberId).gameView).toMatchObject({
        moves: 2,
        turn: "seat-1",
      });
    });
    expect(botCalls).toBe(1);

    await created.room.gameAction(
      joined.member.memberId,
      { type: "test.move" },
      created.room.state.match?.matchId ?? "missing",
      created.room.state.revision,
      2,
    );
    expect(botCalls).toBe(2);
    failBotAction?.(new Error("模拟 Worker 暂时失败"));
    await vi.waitFor(() => expect(botCalls).toBe(3));
    const stateAtDestroy = created.room.state.match?.state;
    created.room.destroy("host_closed", "测试结束");
    finishBotAction?.({ type: "test.move" });
    await Promise.resolve();
    await created.room.queue.run(() => undefined);
    expect(created.room.state.match?.state).toBe(stateAtDestroy);
    expect(botCalls).toBe(3);
  });

  it("creates and starts a botless solo-practice room with one occupied seat", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers, { accountCount: 2 });
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-solo-practice",
      name: "无 AI 单人练习",
      practice: true,
      session: sessions[0]!,
      settings: {},
    });
    const joined = await registry.consumeJoinTicket(
      created.ticket.token,
      accounts[0]!,
      sessions[0]!,
    );
    const guestTicket = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: sessions[1]!,
    });
    const guest = await registry.consumeJoinTicket(guestTicket.token, accounts[1]!, sessions[1]!);

    expect(created.room.state.seats).toMatchObject([
      { controller: { kind: "human" }, occupant: { kind: "human" } },
      { controller: null, occupant: null },
    ]);
    expect(
      created.room.projectSnapshot(guest.member.memberId).permissions.claimableSeatIds,
    ).toEqual([]);
    await expect(
      created.room.claimSeat(
        guest.member.memberId,
        seatIdSchema.parse("seat-2"),
        created.room.state.revision,
      ),
    ).rejects.toMatchObject({ code: "ROOM_INVALID_STATE" });
    await created.room.setReady(joined.member.memberId, true, created.room.state.revision);
    await created.room.startMatch(joined.member.memberId, created.room.state.revision);

    expect(created.room.state.status).toBe("playing");
    expect(created.room.state.match?.state).toMatchObject({ moves: 0, turn: "seat-1" });
    await created.room.leave(joined.member.memberId);
    expect(created.room.destroyed).toBe(true);
    expect(registry.bindingForSession(sessions[1]!.id)).toBeUndefined();
    expect(() => registry.require(created.room.state.roomId)).toThrowError(
      expect.objectContaining({ code: "ROOM_NOT_FOUND" }),
    );
  });

  it("keeps a bot practice room for an invited spectator after its player leaves", async () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const accounts = [
      repositories.accounts.create({ passwordHash: "hash", username: "AI练习房主" }),
      repositories.accounts.create({ passwordHash: "hash", username: "AI练习观众" }),
    ];
    const sessions = accounts.map((account, index) =>
      repositories.sessions.create({
        accountId: account.id,
        csrfSecretHash: Buffer.alloc(32, index + 131),
        expiresAt: Date.now() + 60_000,
        tokenHash: Buffer.alloc(32, index + 141),
      }),
    );
    const registry = new RoomRegistry({
      automation: pausedAutomation,
      games: serverGameRegistry,
      repositories,
    });
    const created = await registry.createRoom({
      account: accounts[0]!,
      botProfileId: "easy",
      gameId: "gomoku",
      name: "保留的 AI 练习房",
      practice: true,
      session: sessions[0]!,
      settings: {
        moveTimeSeconds: 60,
        rule: "freestyle",
        timerEnabled: false,
        totalTimeMinutes: 10,
      },
    });
    closers.push(() => created.room.destroy("host_closed", "测试结束"));
    const host = await registry.consumeJoinTicket(created.ticket.token, accounts[0]!, sessions[0]!);
    await created.room.attachConnection(host.member.memberId, "connection-practice-host");
    const guestTicket = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: sessions[1]!,
    });
    const guest = await registry.consumeJoinTicket(guestTicket.token, accounts[1]!, sessions[1]!);
    await created.room.attachConnection(guest.member.memberId, "connection-practice-spectator");

    await created.room.setReady(host.member.memberId, true, created.room.state.revision);
    await created.room.startMatch(host.member.memberId, created.room.state.revision);
    await created.room.leave(host.member.memberId);

    expect(created.room.destroyed).toBe(false);
    expect(created.room.state.status).toBe("post_match");
    expect(created.room.state.hostMemberId).toBe(guest.member.memberId);
    expect(
      created.room.projectSnapshot(guest.member.memberId).permissions.claimableSeatIds,
    ).toEqual(["seat-1"]);
    await created.room.claimSeat(
      guest.member.memberId,
      seatIdSchema.parse("seat-1"),
      created.room.state.revision,
    );
    expect(created.room.state.seats[0]?.occupant).toMatchObject({ kind: "human" });
  });

  it("destroys solo practice after grace expiry releases its only player seat", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { accounts, registry, sessions } = createTestRegistry(closers, { accountCount: 2 });
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-solo-practice",
      name: "断线后的单人练习",
      practice: true,
      session: sessions[0]!,
      settings: {},
    });
    const joined = await registry.consumeJoinTicket(
      created.ticket.token,
      accounts[0]!,
      sessions[0]!,
    );
    await created.room.attachConnection(joined.member.memberId, "connection-solo-host");
    const guestTicket = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: sessions[1]!,
    });
    const guest = await registry.consumeJoinTicket(guestTicket.token, accounts[1]!, sessions[1]!);
    await created.room.attachConnection(guest.member.memberId, "connection-solo-spectator");
    await created.room.setReady(joined.member.memberId, true, created.room.state.revision);
    await created.room.startMatch(joined.member.memberId, created.room.state.revision);

    await created.room.connectionLost(
      joined.member.memberId,
      "connection-solo-host",
      Date.now() - 30_001,
    );
    await vi.advanceTimersByTimeAsync(0);
    await created.room.queue.run(() => undefined);

    expect(created.room.destroyed).toBe(true);
    expect(registry.bindingForSession(sessions[1]!.id)).toBeUndefined();
    expect(() => registry.require(created.room.state.roomId)).toThrowError(
      expect.objectContaining({ code: "ROOM_NOT_FOUND" }),
    );
  });

  it("retains manifest minimum players for normal rooms that support solo practice", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers);
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-solo-practice",
      name: "普通双人房",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    const joined = await registry.consumeJoinTicket(
      created.ticket.token,
      accounts[0]!,
      sessions[0]!,
    );
    await created.room.claimSeat(
      joined.member.memberId,
      seatIdSchema.parse("seat-1"),
      created.room.state.revision,
    );
    await created.room.setReady(joined.member.memberId, true, created.room.state.revision);

    await expect(
      created.room.startMatch(joined.member.memberId, created.room.state.revision),
    ).rejects.toMatchObject({ code: "ROOM_INVALID_STATE" });
    created.room.destroy("host_closed", "测试结束");
  });

  it("rejects practice rooms when the game supports neither bots nor solo practice", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers);

    await expect(
      registry.createRoom({
        account: accounts[0]!,
        gameId: "test-no-practice",
        name: "不支持练习",
        practice: true,
        session: sessions[0]!,
        settings: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(registry.bindingForSession(sessions[0]!.id)).toBeUndefined();
  });

  it("rejects an unknown practice AI profile", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers);

    await expect(
      registry.createRoom({
        account: accounts[0]!,
        botProfileId: "missing-profile",
        gameId: "test-room",
        name: "无效 AI 房间",
        practice: true,
        session: sessions[0]!,
        settings: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(registry.bindingForSession(sessions[0]!.id)).toBeUndefined();
  });

  it("rejects practice settings that the game plugin cannot start", async () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const account = repositories.accounts.create({
      passwordHash: "hash",
      username: "连珠练习用户",
    });
    const session = repositories.sessions.create({
      accountId: account.id,
      csrfSecretHash: Buffer.alloc(32, 121),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, 122),
    });
    const registry = new RoomRegistry({ games: serverGameRegistry, repositories });

    await expect(
      registry.createRoom({
        account,
        botProfileId: "hard",
        gameId: "gomoku",
        name: "连珠禁手练习",
        practice: true,
        session,
        settings: {
          moveTimeSeconds: 60,
          rule: "renju",
          timerEnabled: false,
          totalTimeMinutes: 10,
        },
      }),
    ).rejects.toMatchObject({
      code: "GAME_ILLEGAL_ACTION",
      details: { ruleCode: "BOTS_NOT_ALLOWED_IN_RENJU" },
    });
    expect(registry.bindingForSession(session.id)).toBeUndefined();
  });

  it("ends gomoku with a disconnect loss when the reconnect grace expires", async () => {
    const { players, registry, room } = await createStartedRealGameRoom(closers, {
      gameId: "gomoku",
      seatIds: ["seat-1", "seat-2"],
      settings: {
        moveTimeSeconds: 60,
        rule: "freestyle",
        timerEnabled: false,
        totalTimeMinutes: 10,
      },
    });
    const loser = players[0]!;
    const winner = players[1]!;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    await room.connectionLost(loser.member.memberId, loser.connectionId, Date.now() - 30_001);

    expect(loser.member).toMatchObject({ connectionStatus: "reconnecting" });
    expect(room.state.seats.find(({ seatId }) => seatId === loser.seatId)?.controller).toEqual({
      kind: "fallback",
      reason: "disconnect",
    });

    await vi.advanceTimersByTimeAsync(0);
    await room.queue.run(() => undefined);

    const snapshot = room.projectSnapshot(winner.member.memberId);
    expect(room.state.status).toBe("post_match");
    expect(loser.member).toMatchObject({ connectionStatus: "offline" });
    expect(registry.bindingForSession(loser.session.id)).toBeUndefined();
    expect(snapshot.gameView).toMatchObject({
      outcome: { reason: "disconnected", winnerSeatId: winner.seatId },
      phase: "ended",
    });
    expect(snapshot.displayEvents).toEqual([]);
  });

  it("keeps ludo under persistent AI control after grace expiry and lets the owner reclaim", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { players, registry, room } = await createStartedRealGameRoom(closers, {
      gameId: "ludo",
      seatIds: ["red", "yellow"],
      settings: { phaseTimeSeconds: 30 },
    });
    const initialView = room.projectSnapshot(players[0]!.member.memberId).gameView as {
      readonly currentSeatId: string;
    };
    const disconnected = players.find(({ seatId }) => seatId !== initialView.currentSeatId);
    const observer = players.find(({ seatId }) => seatId === initialView.currentSeatId);
    if (!disconnected || !observer) throw new Error("测试未找到飞行棋活动与非活动座位");

    await room.connectionLost(
      disconnected.member.memberId,
      disconnected.connectionId,
      Date.now() - 30_001,
    );
    expect(
      room.state.seats.find(({ seatId }) => seatId === disconnected.seatId)?.controller,
    ).toEqual({ kind: "fallback", reason: "disconnect" });

    await vi.advanceTimersByTimeAsync(0);
    await room.queue.run(() => undefined);

    const expiredSnapshot = room.projectSnapshot(observer.member.memberId);
    const expiredView = expiredSnapshot.gameView as {
      readonly seats: readonly {
        readonly controller: string;
        readonly reclaimable: boolean;
        readonly seatId: string;
      }[];
    };
    expect(disconnected.member.connectionStatus).toBe("offline");
    expect(registry.bindingForSession(disconnected.session.id)).toBeUndefined();
    expect(expiredView.seats.find(({ seatId }) => seatId === disconnected.seatId)).toMatchObject({
      controller: "persistent_ai",
      reclaimable: true,
    });

    const rejoinTicket = await registry.issueListJoinTicket({
      roomId: room.state.roomId,
      session: disconnected.session,
    });
    const rejoined = await registry.consumeJoinTicket(
      rejoinTicket.token,
      disconnected.account,
      disconnected.session,
    );
    expect(rejoined.member.memberId).toBe(disconnected.member.memberId);
    expect(
      [...room.state.members.values()].filter(
        ({ accountId }) => accountId === disconnected.account.id,
      ),
    ).toHaveLength(1);
    await room.attachConnection(rejoined.member.memberId, "connection-rejoined");

    const beforeReclaim = room.projectSnapshot(rejoined.member.memberId);
    expect(beforeReclaim.permissions.reclaimableSeatIds).toEqual([disconnected.seatId]);
    await room.reclaimSeat(rejoined.member.memberId, disconnected.seatId, room.state.revision);

    const reclaimed = room.projectSnapshot(rejoined.member.memberId);
    const reclaimedView = reclaimed.gameView as {
      readonly seats: readonly {
        readonly controller: string;
        readonly reclaimable: boolean;
        readonly seatId: string;
      }[];
    };
    expect(room.state.seats.find(({ seatId }) => seatId === disconnected.seatId)).toMatchObject({
      controller: { kind: "human" },
      occupant: {
        accountId: disconnected.account.id,
        memberId: rejoined.member.memberId,
      },
      reclaimable: false,
    });
    expect(reclaimedView.seats.find(({ seatId }) => seatId === disconnected.seatId)).toMatchObject({
      controller: "human",
      reclaimable: false,
    });
    expect(reclaimed.permissions.canSubmitGameAction).toBe(true);
    expect(reclaimed.permissions.reclaimableSeatIds).toEqual([]);
  });

  it("removes a seatless spectator after grace expiry so the spectator slot is reusable", async () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const hostAccount = repositories.accounts.create({
      passwordHash: "hash",
      username: "观战测试房主",
    });
    const spectatorAccount = repositories.accounts.create({
      passwordHash: "hash",
      username: "过期观众",
    });
    const hostSession = repositories.sessions.create({
      accountId: hostAccount.id,
      csrfSecretHash: Buffer.alloc(32, 21),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, 22),
    });
    const spectatorSession = repositories.sessions.create({
      accountId: spectatorAccount.id,
      csrfSecretHash: Buffer.alloc(32, 23),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, 24),
    });
    const registry = new RoomRegistry({
      games: registerServerGamesV1([testGame]),
      repositories,
    });
    const created = await registry.createRoom({
      account: hostAccount,
      gameId: "test-room",
      name: "观战位回收测试",
      practice: false,
      session: hostSession,
      settings: {},
    });
    closers.push(() => created.room.destroy("host_closed", "测试结束"));
    const host = await registry.consumeJoinTicket(created.ticket.token, hostAccount, hostSession);
    await created.room.attachConnection(host.member.memberId, "connection-host");
    await created.room.claimSeat(
      host.member.memberId,
      seatIdSchema.parse("seat-1"),
      created.room.state.revision,
    );
    const spectatorTicket = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: spectatorSession,
    });
    const spectator = await registry.consumeJoinTicket(
      spectatorTicket.token,
      spectatorAccount,
      spectatorSession,
    );
    await created.room.attachConnection(spectator.member.memberId, "connection-spectator");
    expect(registry.listPublicRooms()[0]).toMatchObject({ spectatorCount: 1 });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    await created.room.connectionLost(
      spectator.member.memberId,
      "connection-spectator",
      Date.now() - 30_001,
    );
    await vi.advanceTimersByTimeAsync(0);
    await created.room.queue.run(() => undefined);

    expect(created.room.state.members.has(spectator.member.memberId)).toBe(false);
    expect(registry.listPublicRooms()[0]).toMatchObject({ spectatorCount: 0 });
    expect(registry.bindingForSession(spectatorSession.id)).toBeUndefined();
  });

  it("transfers host control to a connected member when the host grace expires", async () => {
    const connection = openDatabase(":memory:");
    closers.push(() => connection.close());
    const repositories = createRepositories(connection.database);
    const hostAccount = repositories.accounts.create({
      passwordHash: "hash",
      username: "离线房主",
    });
    const guestAccount = repositories.accounts.create({
      passwordHash: "hash",
      username: "候补房主",
    });
    const hostSession = repositories.sessions.create({
      accountId: hostAccount.id,
      csrfSecretHash: Buffer.alloc(32, 31),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, 32),
    });
    const guestSession = repositories.sessions.create({
      accountId: guestAccount.id,
      csrfSecretHash: Buffer.alloc(32, 33),
      expiresAt: Date.now() + 60_000,
      tokenHash: Buffer.alloc(32, 34),
    });
    const registry = new RoomRegistry({
      games: registerServerGamesV1([testGame]),
      repositories,
    });
    const created = await registry.createRoom({
      account: hostAccount,
      gameId: "test-room",
      name: "房主转移测试",
      practice: false,
      session: hostSession,
      settings: {},
    });
    closers.push(() => created.room.destroy("host_closed", "测试结束"));
    const host = await registry.consumeJoinTicket(created.ticket.token, hostAccount, hostSession);
    await created.room.attachConnection(host.member.memberId, "connection-host");
    await created.room.claimSeat(
      host.member.memberId,
      seatIdSchema.parse("seat-1"),
      created.room.state.revision,
    );
    const guestTicket = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: guestSession,
    });
    const guest = await registry.consumeJoinTicket(guestTicket.token, guestAccount, guestSession);
    await created.room.attachConnection(guest.member.memberId, "connection-guest");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    await created.room.connectionLost(host.member.memberId, "connection-host", Date.now() - 30_001);
    await vi.advanceTimersByTimeAsync(0);
    await created.room.queue.run(() => undefined);

    expect(created.room.state.hostMemberId).toBe(guest.member.memberId);
    expect(created.room.projectSnapshot(guest.member.memberId).permissions).toMatchObject({
      canRenameRoom: true,
      canTransferHost: true,
      canUpdateSettings: true,
    });
  });

  it("transfers an expired offline host when a member connects later", async () => {
    const { accounts, registry, sessions } = createTestRegistry(closers, { accountCount: 2 });
    const created = await registry.createRoom({
      account: accounts[0]!,
      gameId: "test-room",
      name: "延迟房主转移",
      practice: false,
      session: sessions[0]!,
      settings: {},
    });
    const host = await registry.consumeJoinTicket(created.ticket.token, accounts[0]!, sessions[0]!);
    await created.room.attachConnection(host.member.memberId, "connection-expiring-host");
    await created.room.claimSeat(
      host.member.memberId,
      seatIdSchema.parse("seat-1"),
      created.room.state.revision,
    );
    const guestTicket = registry.issueInviteJoinTicket({
      inviteToken: created.room.state.inviteToken,
      session: sessions[1]!,
    });
    const guest = await registry.consumeJoinTicket(guestTicket.token, accounts[1]!, sessions[1]!);
    await created.room.attachConnection(guest.member.memberId, "connection-reconnecting-guest");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await created.room.connectionLost(guest.member.memberId, "connection-reconnecting-guest");
    await created.room.connectionLost(
      host.member.memberId,
      "connection-expiring-host",
      Date.now() - 30_001,
    );
    await vi.advanceTimersByTimeAsync(0);
    await created.room.queue.run(() => undefined);
    expect(created.room.destroyed).toBe(false);
    expect(host.member.connectionStatus).toBe("offline");
    expect(guest.member.connectionStatus).toBe("reconnecting");
    expect(created.room.state.hostMemberId).toBe(host.member.memberId);

    await created.room.attachConnection(guest.member.memberId, "connection-late-guest");

    expect(created.room.state.hostMemberId).toBe(guest.member.memberId);
    expect(created.room.projectSnapshot(guest.member.memberId).permissions).toMatchObject({
      canRenameRoom: true,
      canTransferHost: true,
      canUpdateSettings: true,
    });
    created.room.destroy("host_closed", "测试结束");
  });
});
