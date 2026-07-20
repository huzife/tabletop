import { seatIdSchema } from "@tabletop/protocol";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { defineGameSharedContractV1 } from "../shared/contract.js";
import { defineGameManifestV1 } from "../shared/manifest.js";
import {
  createTestActionContextV1,
  createTestCreateMatchContextV1,
  createTestProjectionContextV1,
  createTestSystemEventContextV1,
} from "../testing/context.js";
import { defineGameServerModuleV1 } from "./module.js";
import { registerServerGamesV1 } from "./registry.js";

function createTestModule(gameId: "test-alpha" | "test-beta" = "test-alpha") {
  const handleAction = vi.fn(
    (
      _context: unknown,
      state: Readonly<{ count: number; secret: string }>,
      action: { readonly type: "counter.add"; readonly amount: number },
    ) => ({
      kind: "applied" as const,
      state: { ...state, count: state.count + action.amount },
      events: [{ type: "counter.changed" as const, value: state.count + action.amount }],
    }),
  );
  const shared = defineGameSharedContractV1({
    manifest: defineGameManifestV1({
      apiVersion: 1,
      gameId,
      displayName: "Test",
      description: "",
      minPlayers: 2,
      maxPlayers: 2,
      interactionMode: "turn_based",
      capabilities: {
        spectators: true,
        midgameJoin: false,
        timers: false,
        hiddenInformation: true,
        bots: false,
        temporaryController: false,
        manualSeatReclaim: false,
      },
    }),
    settings: {
      schema: z.strictObject({ initial: z.number().int() }),
      defaultValue: { initial: 0 },
      summarize: ({ initial }) => [{ label: "Initial", value: String(initial) }],
    },
    actionSchema: z.strictObject({
      type: z.literal("counter.add"),
      amount: z.number().int().positive(),
    }),
    viewSchema: z.strictObject({ count: z.number().int() }),
    displayEventSchema: z.strictObject({
      type: z.literal("counter.changed"),
      value: z.number().int(),
    }),
  });

  const module = defineGameServerModuleV1({
    shared,
    createMatch: (_context, settings) => ({
      count: settings.initial,
      secret: "server-only",
    }),
    handleAction,
    projectView: (_context, state) => ({ count: state.count }),
    getDeadlines: () => [],
    handleDeadline: (_context, state) => ({ kind: "noop", state }),
    handleSystemEvent: (_context, state, event) =>
      event.type === "connection.lost"
        ? {
            kind: "applied",
            state,
            events: [],
            roomDirectives: [
              {
                type: "seat.setReclaimable",
                seatId: event.seatId,
                reclaimable: true,
              },
            ],
          }
        : { kind: "noop", state },
  });
  return { handleAction, module };
}

describe("game server registry", () => {
  it("hosts different modules through one generic registry", () => {
    const first = createTestModule("test-alpha");
    const second = createTestModule("test-beta");
    const registry = registerServerGamesV1([first.module, second.module]);
    const hosted = registry.require(first.module.shared.manifest.gameId);
    const state = hosted.createMatch(createTestCreateMatchContextV1(), {
      initial: 2,
    });
    const transition = hosted.handleAction(createTestActionContextV1(), state, {
      type: "counter.add",
      amount: 3,
    });
    expect(transition).toMatchObject({ kind: "applied" });
    expect(
      hosted.projectView(createTestProjectionContextV1(), transition.state, {
        kind: "player",
        seatId: seatIdSchema.parse("seat-1"),
      }),
    ).toEqual({ count: 5 });
    expect(registry.list()).toHaveLength(2);
  });

  it("validates opaque actions before invoking game rules", () => {
    const { handleAction, module } = createTestModule();
    const hosted = registerServerGamesV1([module]).list()[0];
    expect(hosted).toBeDefined();
    expect(() =>
      hosted?.handleAction(
        createTestActionContextV1(),
        {},
        {
          type: "different.action",
        },
      ),
    ).toThrow();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("validates generic directives and preserves no-op transitions", () => {
    const { module } = createTestModule();
    const hosted = registerServerGamesV1([module]).require(module.shared.manifest.gameId);
    const state = { count: 0, secret: "x" };
    expect(
      hosted.handleSystemEvent(createTestSystemEventContextV1(), state, {
        type: "connection.restored",
        seatId: "seat-1",
      }),
    ).toEqual({ kind: "noop", state });
    expect(
      hosted.handleSystemEvent(createTestSystemEventContextV1(), state, {
        type: "connection.lost",
        seatId: "seat-1",
        graceDeadlineMs: 30_000,
      }),
    ).toMatchObject({
      kind: "applied",
      roomDirectives: [{ type: "seat.setReclaimable" }],
    });
  });

  it("rejects duplicate ids and unsupported interaction modes", () => {
    const first = createTestModule();
    const duplicate = createTestModule();
    expect(() => registerServerGamesV1([first.module, duplicate.module])).toThrow(
      /duplicate game id/,
    );
    expect(() => registerServerGamesV1([first.module], [])).toThrow(/unsupported interaction mode/);
  });
});
