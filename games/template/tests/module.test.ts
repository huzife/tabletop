import { createHostedGameServerModuleV1 } from "@tabletop/game-sdk/server";
import { FakeGameClockV1, SequenceGameRandomV1 } from "@tabletop/game-sdk/testing";
import { matchIdSchema, seatIdSchema } from "@tabletop/protocol";
import { describe, expect, it } from "vitest";

import { templateServerModule } from "../server/module.js";

describe("template plugin", () => {
  it("runs an action through the hosted plugin adapter", () => {
    const game = createHostedGameServerModuleV1(templateServerModule);
    const clock = new FakeGameClockV1(100);
    const random = new SequenceGameRandomV1([]);
    const matchId = matchIdSchema.parse("match-template-test");
    const first = seatIdSchema.parse("seat-1");
    const second = seatIdSchema.parse("seat-2");
    const state = game.createMatch(
      {
        clock,
        matchId,
        random,
        seats: [
          { controller: { kind: "human" }, seatId: first },
          { controller: { kind: "human" }, seatId: second },
        ],
      },
      { targetScore: 2 },
    );

    const transition = game.handleAction(
      {
        actor: { kind: "human", seatId: first },
        clock,
        matchId,
        random,
        receivedAtMonotonicMs: 100,
        revision: 1,
      },
      state,
      { type: "template.score" },
    );

    expect(transition).toMatchObject({
      events: [{ score: 1, seatId: "seat-1", type: "template.scored" }],
      kind: "applied",
    });
  });
});
