import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createRoomSnapshotPayloadSchema } from "./room-snapshot.js";
import { serverMessageSchema } from "./server-messages.js";

const messageId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const requestId = "550e8400-e29b-41d4-a716-446655440000";
const serverTime = "2026-07-16T10:00:00Z";

const snapshot = {
  gameId: "test-alpha",
  room: {
    roomId: "room-test",
    name: "room",
    status: "playing",
    hostMemberId: "member-1",
    hasPassword: false,
    maxSpectators: 10,
  },
  members: [
    {
      memberId: "member-1",
      accountId: "account-1",
      displayName: "user",
      role: "player",
      connectionStatus: "reconnecting",
      reconnectUntil: "2026-07-16T10:00:30Z",
    },
  ],
  seats: [
    {
      seatId: "seat-1",
      displayName: "Seat 1",
      occupant: {
        kind: "human",
        memberId: "member-1",
        accountId: "account-1",
        displayName: "user",
        ready: true,
      },
      controller: { kind: "fallback", reason: "disconnect" },
    },
  ],
  chat: [],
  settings: { boardSize: 11 },
  gameView: { board: [] },
  displayEvents: [{ type: "turn.changed" }],
  permissions: {
    canRenameRoom: false,
    canUpdateSettings: false,
    claimableSeatIds: [],
    reclaimableSeatIds: [],
    canReleaseSeat: false,
    botAddableSeatIds: [],
    botRemovableSeatIds: [],
    canSetReady: false,
    canTransferHost: true,
    kickableMemberIds: [],
    canStartMatch: false,
    canSendChat: true,
    canSubmitGameAction: true,
  },
} as const;

describe("server message schemas", () => {
  it("accepts an acknowledgement for a state-changing command", () => {
    expect(
      serverMessageSchema.parse({
        causedBy: requestId,
        messageId,
        payload: { stateChanged: true },
        protocol: 1,
        revision: 4,
        roomId: "room-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        serverTime,
        type: "command.ack",
      }),
    ).toMatchObject({ payload: { stateChanged: true }, revision: 4 });
  });
  it("parses all generic server message variants", () => {
    const base = { protocol: 1, messageId, serverTime } as const;
    const messages = [
      {
        ...base,
        type: "connection.ready",
        payload: {
          connectionId: "connection-1",
          heartbeatIntervalMs: 20_000,
          pongTimeoutMs: 10_000,
        },
      },
      {
        ...base,
        causedBy: requestId,
        type: "connection.pong",
        payload: {},
      },
      {
        ...base,
        type: "command.ack",
        causedBy: requestId,
        payload: { stateChanged: false },
      },
      {
        ...base,
        type: "command.error",
        causedBy: requestId,
        payload: {
          code: "REVISION_STALE",
          message: "stale",
          details: {},
          resyncRequired: true,
        },
      },
      {
        ...base,
        type: "room.snapshot",
        roomId: "room-test",
        matchId: "match-test",
        revision: 5,
        payload: snapshot,
      },
      {
        ...base,
        type: "room.closed",
        roomId: "room-test",
        payload: { reason: "game_disabled", message: "closed" },
      },
      {
        ...base,
        type: "room.connection.changed",
        roomId: "room-test",
        revision: 6,
        payload: {
          seatId: "seat-1",
          connectionStatus: "connected",
          controller: { kind: "human" },
        },
      },
      {
        ...base,
        type: "game.transient",
        roomId: "room-test",
        matchId: "match-test",
        payload: {
          senderSeatId: "seat-1",
          event: { type: "aim.preview", power: 42 },
        },
      },
      {
        ...base,
        type: "service.status.changed",
        payload: { scope: "game", gameId: "test-alpha", enabled: false },
      },
    ];

    for (const message of messages) {
      expect(serverMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
  });

  it("binds a snapshot to dynamically selected plugin schemas", () => {
    const schema = createRoomSnapshotPayloadSchema({
      settingsSchema: z.strictObject({ boardSize: z.literal(11) }),
      viewSchema: z.strictObject({ board: z.array(z.string()) }),
      displayEventSchema: z.strictObject({ type: z.literal("turn.changed") }),
    });
    expect(schema.safeParse(snapshot).success).toBe(true);
    expect(
      schema.safeParse({
        ...snapshot,
        gameView: { board: [], hiddenSecret: "must not cross boundary" },
      }).success,
    ).toBe(false);
  });

  it("requires snapshot routing and revision metadata", () => {
    expect(
      serverMessageSchema.safeParse({
        protocol: 1,
        messageId,
        serverTime,
        type: "room.snapshot",
        payload: snapshot,
      }).success,
    ).toBe(false);
  });
});
