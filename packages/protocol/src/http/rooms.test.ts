import { describe, expect, it } from "vitest";

import {
  createRoomRequestSchema,
  roomSummarySchema,
  roomConnectionOpenRequestSchema,
  roomConnectionOpenResponseSchema,
  roomConnectionPollResponseSchema,
} from "./rooms.js";

describe("room HTTP schemas", () => {
  const baseRoom = {
    gameId: "gomoku",
    name: "测试房间",
    settings: {},
  };

  it("allows a bot profile only for practice room creation", () => {
    expect(
      createRoomRequestSchema.parse({
        ...baseRoom,
        botProfileId: "hard",
        practice: true,
      }),
    ).toMatchObject({ botProfileId: "hard", practice: true });

    expect(() =>
      createRoomRequestSchema.parse({
        ...baseRoom,
        botProfileId: "hard",
        practice: false,
      }),
    ).toThrow();
  });

  it("exposes whether the current session can resume a room", () => {
    expect(
      roomSummarySchema.parse({
        gameId: "gomoku",
        hasPassword: false,
        hostName: "测试房主",
        joinable: true,
        maxPlayers: 2,
        maxSpectators: 10,
        name: "测试房间",
        occupiedSeats: 2,
        resumeAvailable: true,
        roomId: "room-test",
        spectatorCount: 0,
        status: "playing",
      }),
    ).toMatchObject({ resumeAvailable: true });
  });

  it("validates long-polling connection responses with protocol messages", () => {
    const ready = {
      messageId: "00000000-0000-4000-8000-000000000001",
      payload: {
        connectionId: "connection-test",
        heartbeatIntervalMs: 20_000,
        pongTimeoutMs: 10_000,
      },
      protocol: 1,
      serverTime: "2026-01-01T00:00:00.000Z",
      type: "connection.ready",
    };

    expect(roomConnectionOpenRequestSchema.parse({ protocol: 1 })).toEqual({ protocol: 1 });
    expect(
      roomConnectionOpenResponseSchema.parse({
        connectionId: "connection-test",
        messages: [ready],
      }),
    ).toMatchObject({ connectionId: "connection-test" });
    expect(
      roomConnectionPollResponseSchema.parse({
        close: { code: 4_004, reason: "session expired" },
        messages: [],
      }),
    ).toMatchObject({ close: { code: 4_004 } });
  });
});
