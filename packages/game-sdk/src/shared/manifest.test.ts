import { z } from "zod";
import { describe, expect, it } from "vitest";

import { defineGameSharedContractV1 } from "./contract.js";
import { defineGameManifestV1 } from "./manifest.js";

const capabilities = {
  spectators: true,
  midgameJoin: false,
  timers: false,
  hiddenInformation: false,
  bots: false,
  temporaryController: false,
  manualSeatReclaim: false,
} as const;

describe("game shared contracts", () => {
  it("validates manifest player ranges and ids", () => {
    expect(() =>
      defineGameManifestV1({
        apiVersion: 1,
        gameId: "Invalid Id",
        displayName: "Test",
        description: "",
        minPlayers: 2,
        maxPlayers: 4,
        interactionMode: "turn_based",
        capabilities,
      }),
    ).toThrow();
    expect(() =>
      defineGameManifestV1({
        apiVersion: 1,
        gameId: "test-alpha",
        displayName: "Test",
        description: "",
        minPlayers: 4,
        maxPlayers: 2,
        interactionMode: "turn_based",
        capabilities,
      }),
    ).toThrow();
  });

  it("rejects an invalid default setting at definition time", () => {
    expect(() =>
      defineGameSharedContractV1({
        manifest: defineGameManifestV1({
          apiVersion: 1,
          gameId: "test-alpha",
          displayName: "Test",
          description: "",
          minPlayers: 2,
          maxPlayers: 2,
          interactionMode: "turn_based",
          capabilities,
        }),
        settings: {
          schema: z.strictObject({ size: z.number().int().min(3) }),
          defaultValue: { size: 1 },
          summarize: ({ size }) => [{ label: "Size", value: String(size) }],
        },
        actionSchema: z.strictObject({ type: z.literal("turn.pass") }),
        viewSchema: z.strictObject({ value: z.number() }),
        displayEventSchema: z.strictObject({
          type: z.literal("turn.passed"),
        }),
      }),
    ).toThrow();
  });
});
