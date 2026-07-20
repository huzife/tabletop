import { describe, expect, it } from "vitest";

import { clientCommandSchema, gameActionCommandSchema } from "./client-commands.js";

const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const common = { protocol: 1, requestId } as const;
const room = { ...common, roomId: "room-test" } as const;
const revisioned = { ...room, expectedRevision: 4 } as const;

describe("client command schemas", () => {
  it("covers every v1 room and game command", () => {
    const commands = [
      { ...common, type: "room.join", payload: { joinTicket: "a".repeat(22) } },
      { ...common, type: "room.resume", payload: { roomId: "room-test" } },
      { ...room, type: "room.leave", payload: {} },
      { ...revisioned, type: "room.rename", payload: { name: "room" } },
      {
        ...revisioned,
        type: "room.settings.update",
        payload: { settings: { mode: "custom" } },
      },
      { ...revisioned, type: "room.seat.claim", payload: { seatId: "a" } },
      {
        ...revisioned,
        type: "room.seat.reclaim",
        payload: { seatId: "a" },
      },
      { ...revisioned, type: "room.seat.release", payload: {} },
      {
        ...revisioned,
        type: "room.bot.add",
        payload: { seatId: "a", profileId: "normal" },
      },
      { ...revisioned, type: "room.bot.remove", payload: { seatId: "a" } },
      { ...revisioned, type: "room.ready.set", payload: { ready: true } },
      {
        ...revisioned,
        type: "room.host.transfer",
        payload: { accountId: "account-2" },
      },
      {
        ...revisioned,
        type: "room.member.kick",
        payload: { memberId: "member-2" },
      },
      { ...revisioned, type: "room.match.start", payload: {} },
      { ...room, type: "chat.send", payload: { text: "hello" } },
      {
        ...revisioned,
        matchId: "match-test",
        type: "game.action",
        payload: { type: "turn.choose", deeply: { custom: [1, true] } },
      },
    ];

    for (const command of commands) {
      expect(clientCommandSchema.safeParse(command).success, command.type).toBe(true);
    }
  });

  it("requires routing fields for authoritative actions", () => {
    expect(
      gameActionCommandSchema.safeParse({
        ...common,
        type: "game.action",
        payload: { type: "turn.choose" },
      }).success,
    ).toBe(false);
  });

  it("leaves game payload details opaque and rejects server-owned fields", () => {
    const first = {
      ...revisioned,
      matchId: "match-test",
      type: "game.action",
      payload: { type: "grid.place", row: 3, column: 7 },
    };
    const second = {
      ...revisioned,
      matchId: "match-test",
      type: "game.action",
      payload: { type: "phase.commit", cards: ["x", "y"] },
    };
    expect(gameActionCommandSchema.safeParse(first).success).toBe(true);
    expect(gameActionCommandSchema.safeParse(second).success).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        ...first,
        accountId: "spoofed-account",
      }).success,
    ).toBe(false);
  });

  it("enforces chat text boundaries", () => {
    const command = { ...room, type: "chat.send" };
    expect(clientCommandSchema.safeParse({ ...command, payload: { text: " " } }).success).toBe(
      false,
    );
    expect(
      clientCommandSchema.safeParse({
        ...command,
        payload: { text: "a".repeat(500) },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        ...command,
        payload: { text: "a".repeat(501) },
      }).success,
    ).toBe(false);
  });
});
