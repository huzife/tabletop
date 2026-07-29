import { z } from "zod";

export const doudizhuRankSchema = z.enum([
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
  "2",
  "small-joker",
  "big-joker",
]);
export type DoudizhuRank = z.infer<typeof doudizhuRankSchema>;

export const doudizhuSuitSchema = z.enum(["clubs", "diamonds", "hearts", "spades"]);
export type DoudizhuSuit = z.infer<typeof doudizhuSuitSchema>;

export const doudizhuCardSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(32)
    .regex(/^(?:clubs|diamonds|hearts|spades)-(?:3|4|5|6|7|8|9|10|J|Q|K|A|2)|joker-(?:small|big)$/),
  rank: doudizhuRankSchema,
  suit: doudizhuSuitSchema.nullable(),
});
export type DoudizhuCard = z.infer<typeof doudizhuCardSchema>;

export const PLAY_PATTERN_KINDS = [
  "single",
  "pair",
  "triple",
  "triple_single",
  "triple_pair",
  "straight",
  "pair_straight",
  "airplane",
  "airplane_singles",
  "airplane_pairs",
  "four_two_singles",
  "four_two_pairs",
  "bomb",
  "rocket",
] as const;
export const doudizhuPlayKindSchema = z.enum(PLAY_PATTERN_KINDS);
export type DoudizhuPlayKind = z.infer<typeof doudizhuPlayKindSchema>;

export const doudizhuPlayPatternSchema = z.strictObject({
  kind: doudizhuPlayKindSchema,
  mainRank: doudizhuRankSchema,
  cardCount: z.number().int().min(1).max(20),
  sequenceLength: z.number().int().positive(),
});
export type DoudizhuPlayPattern = z.infer<typeof doudizhuPlayPatternSchema>;

export const RANKS_ASCENDING: readonly DoudizhuRank[] = [
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
  "2",
  "small-joker",
  "big-joker",
];

const SEQUENCE_RANKS = RANKS_ASCENDING.slice(0, 12);
const SUITS: readonly DoudizhuSuit[] = ["clubs", "diamonds", "hearts", "spades"];

export function createDoudizhuDeck(): DoudizhuCard[] {
  const cards: DoudizhuCard[] = SEQUENCE_RANKS.concat("2").flatMap((rank) =>
    SUITS.map((suit) => ({ id: `${suit}-${rank}`, rank, suit })),
  );
  cards.push(
    { id: "joker-small", rank: "small-joker", suit: null },
    { id: "joker-big", rank: "big-joker", suit: null },
  );
  return cards;
}

export function rankStrength(rank: DoudizhuRank): number {
  return RANKS_ASCENDING.indexOf(rank);
}

export function sortDoudizhuCards(cards: readonly DoudizhuCard[]): DoudizhuCard[] {
  const suitOrder: Readonly<Record<DoudizhuSuit, number>> = {
    spades: 0,
    hearts: 1,
    clubs: 2,
    diamonds: 3,
  };
  return [...cards].sort(
    (left, right) =>
      rankStrength(right.rank) - rankStrength(left.rank) ||
      (left.suit === null ? 4 : suitOrder[left.suit]) -
        (right.suit === null ? 4 : suitOrder[right.suit]),
  );
}

export function classifyDoudizhuPlay(cards: readonly DoudizhuCard[]): DoudizhuPlayPattern | null {
  if (cards.length === 0 || new Set(cards.map(({ id }) => id)).size !== cards.length) return null;
  const counts = countRanks(cards);
  const entries = [...counts.entries()].sort(
    ([left], [right]) => rankStrength(left) - rankStrength(right),
  );
  const sameRank = entries.length === 1 ? entries[0]?.[0] : undefined;

  if (cards.length === 1) return pattern("single", cards[0]?.rank ?? "3", 1, 1);
  if (cards.length === 2 && counts.get("small-joker") === 1 && counts.get("big-joker") === 1) {
    return pattern("rocket", "big-joker", 2, 1);
  }
  if (cards.length === 2 && sameRank !== undefined && !sameRank.endsWith("joker")) {
    return pattern("pair", sameRank, 2, 1);
  }
  if (cards.length === 3 && sameRank !== undefined && !sameRank.endsWith("joker")) {
    return pattern("triple", sameRank, 3, 1);
  }
  if (cards.length === 4 && sameRank !== undefined && !sameRank.endsWith("joker")) {
    return pattern("bomb", sameRank, 4, 1);
  }
  if (cards.length === 4) {
    const triple = entries.find(([, count]) => count === 3);
    if (triple) return pattern("triple_single", triple[0], 4, 1);
  }
  if (cards.length === 5) {
    const triple = entries.find(([, count]) => count === 3);
    const pairEntry = entries.find(([, count]) => count === 2);
    if (triple && pairEntry) return pattern("triple_pair", triple[0], 5, 1);
  }

  if (
    cards.length >= 5 &&
    entries.every(([, count]) => count === 1) &&
    isConsecutive(entries.map(([rank]) => rank))
  ) {
    return pattern("straight", entries.at(-1)?.[0] ?? "3", cards.length, cards.length);
  }
  if (
    cards.length >= 6 &&
    cards.length % 2 === 0 &&
    entries.length >= 3 &&
    entries.every(([, count]) => count === 2) &&
    isConsecutive(entries.map(([rank]) => rank))
  ) {
    return pattern("pair_straight", entries.at(-1)?.[0] ?? "3", cards.length, entries.length);
  }
  if (
    cards.length >= 6 &&
    cards.length % 3 === 0 &&
    entries.length >= 2 &&
    entries.every(([, count]) => count === 3) &&
    isConsecutive(entries.map(([rank]) => rank))
  ) {
    return pattern("airplane", entries.at(-1)?.[0] ?? "3", cards.length, entries.length);
  }

  if (cards.length % 4 === 0 && cards.length / 4 >= 2) {
    const core = findAirplaneCore(counts, cards.length / 4, "singles");
    if (core) {
      return pattern("airplane_singles", core.at(-1) ?? "3", cards.length, core.length);
    }
  }
  if (cards.length % 5 === 0 && cards.length / 5 >= 2) {
    const core = findAirplaneCore(counts, cards.length / 5, "pairs");
    if (core) return pattern("airplane_pairs", core.at(-1) ?? "3", cards.length, core.length);
  }

  if (cards.length === 6) {
    const four = entries.find(([, count]) => count === 4);
    if (four) {
      const remainder = cards.filter(({ rank }) => rank !== four[0]);
      if (!isRocket(remainder)) return pattern("four_two_singles", four[0], 6, 1);
    }
  }
  if (cards.length === 8) {
    const four = entries.find(([, count]) => count === 4);
    if (four) {
      const remainder = entries.filter(([rank]) => rank !== four[0]);
      if (remainder.length === 2 && remainder.every(([, count]) => count === 2)) {
        return pattern("four_two_pairs", four[0], 8, 1);
      }
    }
  }
  return null;
}

export function canBeatDoudizhuPlay(
  candidate: DoudizhuPlayPattern,
  previous: DoudizhuPlayPattern,
): boolean {
  if (candidate.kind === "rocket") return previous.kind !== "rocket";
  if (previous.kind === "rocket") return false;
  if (candidate.kind === "bomb" && previous.kind !== "bomb") return true;
  if (previous.kind === "bomb" && candidate.kind !== "bomb") return false;
  return (
    candidate.kind === previous.kind &&
    candidate.cardCount === previous.cardCount &&
    candidate.sequenceLength === previous.sequenceLength &&
    rankStrength(candidate.mainRank) > rankStrength(previous.mainRank)
  );
}

export function enumerateDoudizhuPlays(
  hand: readonly DoudizhuCard[],
  previous: DoudizhuPlayPattern | null = null,
): readonly { readonly cards: readonly DoudizhuCard[]; readonly pattern: DoudizhuPlayPattern }[] {
  const groups = groupCards(hand);
  const candidates: DoudizhuCard[][] = [];
  const add = (cards: readonly DoudizhuCard[]) => candidates.push([...cards]);
  const ranked = [...groups.entries()].sort(
    ([left], [right]) => rankStrength(left) - rankStrength(right),
  );

  for (const [, cards] of ranked) {
    add(cards.slice(0, 1));
    if (cards.length >= 2) add(cards.slice(0, 2));
    if (cards.length >= 3) add(cards.slice(0, 3));
    if (cards.length === 4) add(cards);
  }
  const small = groups.get("small-joker")?.[0];
  const big = groups.get("big-joker")?.[0];
  if (small && big) add([small, big]);

  const triples = ranked.filter(([, cards]) => cards.length >= 3);
  for (const [tripleRank, tripleCards] of triples) {
    for (const [wingRank, wingCards] of ranked) {
      if (wingRank === tripleRank) continue;
      add([...tripleCards.slice(0, 3), wingCards[0] as DoudizhuCard]);
      if (wingCards.length >= 2 && !wingRank.endsWith("joker")) {
        add([...tripleCards.slice(0, 3), ...wingCards.slice(0, 2)]);
      }
    }
  }

  addSequences(
    ranked,
    1,
    5,
    (sequence) => sequence.map(([, cards]) => cards[0] as DoudizhuCard),
    add,
  );
  addSequences(ranked, 2, 3, (sequence) => sequence.flatMap(([, cards]) => cards.slice(0, 2)), add);
  addSequences(ranked, 3, 2, (sequence) => sequence.flatMap(([, cards]) => cards.slice(0, 3)), add);

  const airplaneRuns = consecutiveRuns(ranked.filter(([, cards]) => cards.length >= 3));
  for (const run of airplaneRuns) {
    for (let length = 2; length <= run.length; length += 1) {
      for (let start = 0; start + length <= run.length; start += 1) {
        const core = run.slice(start, start + length);
        const coreRanks = new Set(core.map(([rank]) => rank));
        const coreCards = core.flatMap(([, cards]) => cards.slice(0, 3));
        const eligibleSingles = ranked
          .filter(([rank, cards]) => !coreRanks.has(rank) && cards.length < 4)
          .flatMap(([, cards]) => cards);
        for (const wings of combinations(eligibleSingles, length, 256)) {
          if (!isRocket(wings)) add([...coreCards, ...wings]);
        }
        const eligiblePairs = ranked.filter(
          ([rank, cards]) => !coreRanks.has(rank) && cards.length >= 2 && cards.length < 4,
        );
        for (const pairRanks of combinations(eligiblePairs, length, 128)) {
          add([...coreCards, ...pairRanks.flatMap(([, cards]) => cards.slice(0, 2))]);
        }
      }
    }
  }

  for (const [fourRank, fourCards] of ranked.filter(([, cards]) => cards.length === 4)) {
    const eligibleSingles = ranked
      .filter(([rank, cards]) => rank !== fourRank && cards.length < 4)
      .flatMap(([, cards]) => cards);
    for (const wings of combinations(eligibleSingles, 2, 128)) {
      if (!isRocket(wings)) add([...fourCards, ...wings]);
    }
    const eligiblePairs = ranked.filter(
      ([rank, cards]) => rank !== fourRank && cards.length >= 2 && cards.length < 4,
    );
    for (const pairs of combinations(eligiblePairs, 2, 128)) {
      add([...fourCards, ...pairs.flatMap(([, cards]) => cards.slice(0, 2))]);
    }
  }

  const unique = new Map<
    string,
    { readonly cards: readonly DoudizhuCard[]; readonly pattern: DoudizhuPlayPattern }
  >();
  for (const cards of candidates) {
    const playPattern = classifyDoudizhuPlay(cards);
    if (!playPattern || (previous && !canBeatDoudizhuPlay(playPattern, previous))) continue;
    const sorted = sortDoudizhuCards(cards);
    unique.set(
      sorted
        .map(({ id }) => id)
        .sort()
        .join("|"),
      { cards: sorted, pattern: playPattern },
    );
  }
  return [...unique.values()];
}

function pattern(
  kind: DoudizhuPlayKind,
  mainRank: DoudizhuRank,
  cardCount: number,
  sequenceLength: number,
): DoudizhuPlayPattern {
  return { kind, mainRank, cardCount, sequenceLength };
}

function countRanks(cards: readonly DoudizhuCard[]): Map<DoudizhuRank, number> {
  const counts = new Map<DoudizhuRank, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

function groupCards(cards: readonly DoudizhuCard[]): Map<DoudizhuRank, DoudizhuCard[]> {
  const groups = new Map<DoudizhuRank, DoudizhuCard[]>();
  for (const card of sortDoudizhuCards(cards).reverse()) {
    const group = groups.get(card.rank) ?? [];
    group.push(card);
    groups.set(card.rank, group);
  }
  return groups;
}

function isConsecutive(ranks: readonly DoudizhuRank[]): boolean {
  if (ranks.some((rank) => !SEQUENCE_RANKS.includes(rank))) return false;
  return ranks.every(
    (rank, index) =>
      index === 0 || rankStrength(rank) === rankStrength(ranks[index - 1] as DoudizhuRank) + 1,
  );
}

function findAirplaneCore(
  counts: ReadonlyMap<DoudizhuRank, number>,
  length: number,
  wings: "pairs" | "singles",
): DoudizhuRank[] | null {
  for (let start = SEQUENCE_RANKS.length - length; start >= 0; start -= 1) {
    const core = SEQUENCE_RANKS.slice(start, start + length);
    if (!core.every((rank) => (counts.get(rank) ?? 0) >= 3)) continue;
    const remainder = new Map(counts);
    for (const rank of core) remainder.set(rank, (remainder.get(rank) ?? 0) - 3);
    if (core.some((rank) => (remainder.get(rank) ?? 0) > 0)) continue;
    for (const [rank, count] of [...remainder]) if (count === 0) remainder.delete(rank);
    if ([...remainder.values()].some((count) => count === 4)) continue;
    const remainderCards = [...remainder.values()].reduce((sum, count) => sum + count, 0);
    if (remainderCards !== (wings === "singles" ? length : length * 2)) continue;
    if ((remainder.get("small-joker") ?? 0) + (remainder.get("big-joker") ?? 0) === 2) continue;
    if (
      wings === "pairs" &&
      (remainder.size !== length || [...remainder.values()].some((count) => count !== 2))
    ) {
      continue;
    }
    return core;
  }
  return null;
}

function isRocket(cards: readonly DoudizhuCard[]): boolean {
  return (
    cards.length === 2 &&
    cards.some(({ rank }) => rank === "small-joker") &&
    cards.some(({ rank }) => rank === "big-joker")
  );
}

function addSequences(
  ranked: readonly [DoudizhuRank, DoudizhuCard[]][],
  requiredCount: number,
  minimumLength: number,
  select: (sequence: readonly [DoudizhuRank, DoudizhuCard[]][]) => DoudizhuCard[],
  add: (cards: readonly DoudizhuCard[]) => void,
): void {
  const runs = consecutiveRuns(ranked.filter(([, cards]) => cards.length >= requiredCount));
  for (const run of runs) {
    for (let length = minimumLength; length <= run.length; length += 1) {
      for (let start = 0; start + length <= run.length; start += 1) {
        add(select(run.slice(start, start + length)));
      }
    }
  }
}

function consecutiveRuns(
  ranked: readonly [DoudizhuRank, DoudizhuCard[]][],
): [DoudizhuRank, DoudizhuCard[]][][] {
  const runs: [DoudizhuRank, DoudizhuCard[]][][] = [];
  let current: [DoudizhuRank, DoudizhuCard[]][] = [];
  for (const entry of ranked) {
    if (!SEQUENCE_RANKS.includes(entry[0])) continue;
    const previous = current.at(-1);
    if (previous && rankStrength(entry[0]) !== rankStrength(previous[0]) + 1) {
      if (current.length > 0) runs.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function combinations<T>(items: readonly T[], size: number, limit: number): T[][] {
  const output: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (output.length >= limit) return;
    if (selected.length === size) {
      output.push([...selected]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      selected.push(item);
      visit(index + 1, selected);
      selected.pop();
      if (output.length >= limit) return;
    }
  };
  visit(0, []);
  return output;
}
