import { describe, expect, it } from "vitest";

import { createRoomRequestSchema } from "./rooms.js";

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
});
