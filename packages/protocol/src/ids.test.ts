import { describe, expect, it } from "vitest";

import { apiErrorResponseSchema } from "./errors.js";
import { gameIdSchema, requestIdSchema, utcDateTimeSchema } from "./ids.js";
import { gameCatalogEntrySchema } from "./http/games.js";
import { roomListQuerySchema } from "./http/rooms.js";

describe("protocol primitives", () => {
  it("accepts UUID and ULID correlation ids", () => {
    expect(requestIdSchema.parse("550e8400-e29b-41d4-a716-446655440000")).toBeTruthy();
    expect(requestIdSchema.parse("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeTruthy();
    expect(requestIdSchema.safeParse("not-an-id").success).toBe(false);
  });

  it("enforces stable game ids and timestamp syntax", () => {
    expect(gameIdSchema.safeParse("test-alpha").success).toBe(true);
    expect(gameIdSchema.safeParse("Test Alpha").success).toBe(false);
    expect(utcDateTimeSchema.safeParse("2026-07-16T10:00:00Z").success).toBe(true);
    expect(utcDateTimeSchema.safeParse("yesterday").success).toBe(false);
  });

  it("keeps HTTP errors JSON-safe and strict", () => {
    const error = {
      error: {
        code: "AUTH_SESSION_EXPIRED",
        message: "session expired",
        requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        details: { retry: false },
      },
    };
    expect(apiErrorResponseSchema.safeParse(error).success).toBe(true);
    expect(
      apiErrorResponseSchema.safeParse({
        ...error,
        error: { ...error.error, stack: "secret" },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid player ranges in catalog DTOs", () => {
    const result = gameCatalogEntrySchema.safeParse({
      gameId: "test-alpha",
      displayName: "Test",
      description: "",
      minPlayers: 4,
      maxPlayers: 2,
      interactionMode: "turn_based",
      capabilities: {
        spectators: true,
        midgameJoin: false,
        timers: false,
        hiddenInformation: false,
        bots: false,
        soloPractice: false,
        temporaryController: false,
        manualSeatReclaim: false,
      },
      enabled: true,
    });
    expect(result.success).toBe(false);
  });

  it("parses query booleans without treating false as truthy", () => {
    expect(roomListQuerySchema.parse({ joinable: "false" }).joinable).toBe(false);
    expect(roomListQuerySchema.parse({ joinable: "true" }).joinable).toBe(true);
  });
});
