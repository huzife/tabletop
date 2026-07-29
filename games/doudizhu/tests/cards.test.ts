import { describe, expect, it } from "vitest";

import {
  canBeatDoudizhuPlay,
  classifyDoudizhuPlay,
  createDoudizhuDeck,
  enumerateDoudizhuPlays,
  type DoudizhuCard,
  type DoudizhuRank,
} from "../shared/index.js";

describe("doudizhu card patterns", () => {
  it.each([
    [["3"], "single"],
    [["4", "4"], "pair"],
    [["5", "5", "5"], "triple"],
    [["6", "6", "6", "9"], "triple_single"],
    [["7", "7", "7", "Q", "Q"], "triple_pair"],
    [["3", "4", "5", "6", "7"], "straight"],
    [["3", "3", "4", "4", "5", "5"], "pair_straight"],
    [["3", "3", "3", "4", "4", "4"], "airplane"],
    [["3", "3", "3", "4", "4", "4", "8", "8"], "airplane_singles"],
    [["3", "3", "3", "4", "4", "4", "8", "8", "9", "9"], "airplane_pairs"],
    [["9", "9", "9", "9", "3", "3"], "four_two_singles"],
    [["9", "9", "9", "9", "3", "3", "4", "4"], "four_two_pairs"],
    [["2", "2", "2", "2"], "bomb"],
    [["small-joker", "big-joker"], "rocket"],
  ] as const)("classifies %j as %s", (ranks, kind) => {
    expect(classifyDoudizhuPlay(cards(...ranks))?.kind).toBe(kind);
  });

  it("rejects malformed sequences and forbidden wings", () => {
    expect(classifyDoudizhuPlay(cards("10", "J", "Q", "K", "A"))?.kind).toBe("straight");
    expect(classifyDoudizhuPlay(cards("J", "Q", "K", "A", "2"))).toBeNull();
    expect(
      classifyDoudizhuPlay(cards("3", "3", "3", "4", "4", "4", "small-joker", "big-joker")),
    ).toBeNull();
    expect(classifyDoudizhuPlay(cards("3", "3", "3", "3", "4", "4", "4", "4"))).toBeNull();
  });

  it("compares equal-shape plays and bomb overrides", () => {
    const pair4 = requiredPattern(cards("4", "4"));
    const pair5 = requiredPattern(cards("5", "5"));
    const triple5 = requiredPattern(cards("5", "5", "5"));
    const bomb3 = requiredPattern(cards("3", "3", "3", "3"));
    const rocket = requiredPattern(cards("small-joker", "big-joker"));
    expect(canBeatDoudizhuPlay(pair5, pair4)).toBe(true);
    expect(canBeatDoudizhuPlay(triple5, pair4)).toBe(false);
    expect(canBeatDoudizhuPlay(bomb3, pair5)).toBe(true);
    expect(canBeatDoudizhuPlay(rocket, bomb3)).toBe(true);
    expect(canBeatDoudizhuPlay(bomb3, rocket)).toBe(false);
  });

  it("enumerates legal responses without duplicate physical cards", () => {
    const hand = cards("3", "3", "4", "4", "5", "5", "6", "6", "small-joker", "big-joker");
    const responses = enumerateDoudizhuPlays(hand, requiredPattern(cards("4", "4")));
    expect(
      responses.some(({ pattern }) => pattern.kind === "pair" && pattern.mainRank === "5"),
    ).toBe(true);
    expect(responses.some(({ pattern }) => pattern.kind === "rocket")).toBe(true);
    expect(
      responses.every(
        ({ cards: candidate }) => new Set(candidate.map(({ id }) => id)).size === candidate.length,
      ),
    ).toBe(true);
  });
});

function cards(...ranks: readonly DoudizhuRank[]): DoudizhuCard[] {
  const deck = createDoudizhuDeck();
  const used = new Set<string>();
  return ranks.map((rank) => {
    const card = deck.find((candidate) => candidate.rank === rank && !used.has(candidate.id));
    if (!card) throw new Error(`missing card for rank ${rank}`);
    used.add(card.id);
    return card;
  });
}

function requiredPattern(cards: readonly DoudizhuCard[]) {
  const pattern = classifyDoudizhuPlay(cards);
  if (!pattern) throw new Error("expected a valid pattern");
  return pattern;
}
