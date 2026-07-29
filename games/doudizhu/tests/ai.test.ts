import { seatIdSchema } from "@tabletop/protocol";
import { describe, expect, it } from "vitest";

import {
  doudizhuBotProvider,
  handStrength,
  type DoudizhuAutomationInput,
} from "../server/index.js";
import { createDoudizhuDeck } from "../shared/index.js";

const seat1 = seatIdSchema.parse("seat-1");

describe("doudizhu standard AI", () => {
  it("calls with an obviously strong hand and passes a weak hand", async () => {
    const deck = createDoudizhuDeck();
    const strong = deck.filter(
      ({ rank }) => rank === "2" || rank.endsWith("joker") || rank === "A",
    );
    const weak = deck.filter(({ rank }) => ["3", "4", "5"].includes(rank)).slice(0, 6);
    expect(handStrength(strong)).toBeGreaterThan(handStrength(weak));
    await expect(choose({ ...input(strong), bidMode: "call" })).resolves.toEqual({
      type: "doudizhu.bid.call",
    });
    await expect(choose({ ...input(weak), bidMode: "call" })).resolves.toEqual({
      type: "doudizhu.bid.pass",
    });
  });

  it("only uses cards present in its projected hand", async () => {
    const hand = createDoudizhuDeck().filter(({ rank }) => ["3", "4", "5"].includes(rank));
    const action = await choose({ ...input(hand), phase: "playing", bidMode: null });
    if (action.type !== "doudizhu.play") throw new Error("expected a lead");
    expect(action.cardIds.every((id) => hand.some((card) => card.id === id))).toBe(true);
    expect(new Set(action.cardIds).size).toBe(action.cardIds.length);
  });
});

function input(hand = createDoudizhuDeck().slice(0, 17)): DoudizhuAutomationInput {
  return {
    seatId: seat1,
    phase: "bidding",
    bidMode: "call",
    hand,
    lastPlay: null,
    landlordSeatId: null,
    seatOrder: ["seat-1", "seat-2", "seat-3"],
    cardCounts: [
      { seatId: "seat-1", cardCount: hand.length },
      { seatId: "seat-2", cardCount: 17 },
      { seatId: "seat-3", cardCount: 17 },
    ],
  };
}

async function choose(input: DoudizhuAutomationInput) {
  return doudizhuBotProvider.chooseAction({
    seatId: seat1,
    input,
    revision: 0,
    hardDeadlineMonotonicMs: 1_000,
    decisionSeed: "stable-seed",
    profileId: "standard",
  });
}
