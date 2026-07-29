import type {
  ActionContextV1,
  CreateMatchContextV1,
  GameTransitionV1,
} from "@tabletop/game-sdk/server";
import { GameRuleError } from "@tabletop/game-sdk/server";
import type { SeatId } from "@tabletop/protocol";

import {
  canBeatDoudizhuPlay,
  classifyDoudizhuPlay,
  createDoudizhuDeck,
  sortDoudizhuCards,
  type DoudizhuAction,
  type DoudizhuCard,
  type DoudizhuDisplayEvent,
  type DoudizhuOutcomeView,
  type DoudizhuSettings,
} from "../shared/index.js";
import { cloneDoudizhuState, type DoudizhuState } from "./state.js";

export function createDoudizhuState(
  context: CreateMatchContextV1,
  settings: Readonly<DoudizhuSettings>,
): DoudizhuState {
  if (context.seats.length !== 3) throw new GameRuleError("DOUDIZHU_REQUIRES_THREE_PLAYERS");
  const seatOrder = context.seats.map(({ seatId }) => seatId) as [SeatId, SeatId, SeatId];
  if (new Set(seatOrder).size !== 3) throw new GameRuleError("DOUDIZHU_REQUIRES_THREE_PLAYERS");
  const startIndex = context.random.integer(0, 2, "doudizhu.initial-bidder");
  const state: DoudizhuState = {
    settings: { ...settings },
    phase: "bidding",
    dealNumber: 1,
    seatOrder,
    seats: context.seats.map(({ seatId, controller }) => ({
      seatId,
      controller: controller.kind === "bot" ? "bot" : "human",
      reclaimable: false,
    })),
    hands: {},
    bottomCards: [],
    activeSeatId: null,
    bid: {
      stage: "seeking",
      initialCallerSeatId: null,
      candidateSeatId: null,
      queue: [],
      robCount: 0,
      robbed: false,
    },
    landlordSeatId: null,
    openHand: false,
    doubleQueue: [],
    doubledBySeat: Object.fromEntries(seatOrder.map((seatId) => [seatId, false])),
    lastPlay: null,
    passedSeatIds: [],
    bombCount: 0,
    playTurnsBySeat: Object.fromEntries(seatOrder.map((seatId) => [seatId, 0])),
    outcome: null,
  };
  deal(state, context.random, startIndex);
  return state;
}

export function applyDoudizhuAction(
  context: ActionContextV1,
  state: Readonly<DoudizhuState>,
  action: DoudizhuAction,
): GameTransitionV1<DoudizhuState, DoudizhuDisplayEvent> {
  if (state.phase === "ended") throw new GameRuleError("DOUDIZHU_MATCH_ENDED");
  if (context.actor.seatId !== state.activeSeatId) {
    throw new GameRuleError("DOUDIZHU_NOT_YOUR_TURN");
  }
  const next = cloneDoudizhuState(state);
  switch (action.type) {
    case "doudizhu.bid.call":
    case "doudizhu.bid.rob":
    case "doudizhu.bid.pass":
      return applyBid(context, next, action.type);
    case "doudizhu.open-hand":
      return chooseOpenHand(next, context.actor.seatId, action.open);
    case "doudizhu.double":
      return chooseDouble(next, context.actor.seatId, action.double);
    case "doudizhu.play":
      return playCards(next, context.actor.seatId, action.cardIds);
    case "doudizhu.pass":
      return passTurn(next, context.actor.seatId);
  }
}

function applyBid(
  context: ActionContextV1,
  state: DoudizhuState,
  actionType: "doudizhu.bid.call" | "doudizhu.bid.rob" | "doudizhu.bid.pass",
): GameTransitionV1<DoudizhuState, DoudizhuDisplayEvent> {
  if (state.phase !== "bidding") throw new GameRuleError("DOUDIZHU_BID_NOT_AVAILABLE");
  const seatId = context.actor.seatId;
  const eventDecision =
    actionType === "doudizhu.bid.pass"
      ? "pass"
      : state.bid.stage === "counter"
        ? "counter"
        : state.bid.stage === "robbing"
          ? "rob"
          : "call";
  const bidEvent: DoudizhuDisplayEvent = {
    type: "doudizhu.bid.changed",
    seatId,
    decision: eventDecision,
    robCount: state.bid.robCount,
  };
  if (state.bid.stage === "seeking" && actionType === "doudizhu.bid.rob") {
    throw new GameRuleError("DOUDIZHU_CALL_REQUIRED");
  }
  if (state.bid.stage !== "seeking" && actionType === "doudizhu.bid.call") {
    throw new GameRuleError("DOUDIZHU_ROB_REQUIRED");
  }

  if (state.bid.stage === "seeking") {
    if (actionType === "doudizhu.bid.call") {
      state.bid.initialCallerSeatId = seatId;
      state.bid.candidateSeatId = seatId;
      state.bid.stage = "robbing";
      state.bid.queue = nextSeats(state, seatId);
      state.activeSeatId = state.bid.queue[0] ?? null;
    } else {
      state.bid.queue.shift();
      if (state.bid.queue.length === 0) {
        state.dealNumber += 1;
        const startIndex = context.random.integer(
          0,
          2,
          `doudizhu.redeal-starter.${state.dealNumber}`,
        );
        deal(state, context.random, startIndex);
        return {
          kind: "applied",
          state,
          events: [
            { type: "doudizhu.bid.changed", seatId, decision: "pass", robCount: 0 },
            { type: "doudizhu.dealt", dealNumber: state.dealNumber },
          ],
        };
      }
      state.activeSeatId = state.bid.queue[0] ?? null;
    }
  } else if (state.bid.stage === "robbing") {
    if (actionType === "doudizhu.bid.rob") {
      state.bid.candidateSeatId = seatId;
      state.bid.robbed = true;
      state.bid.robCount += 1;
    }
    bidEvent.robCount = state.bid.robCount;
    state.bid.queue.shift();
    if (state.bid.queue.length > 0) {
      state.activeSeatId = state.bid.queue[0] ?? null;
    } else if (state.bid.robbed) {
      state.bid.stage = "counter";
      state.activeSeatId = state.bid.initialCallerSeatId;
    } else {
      return selectLandlord(state, bidEvent);
    }
  } else {
    if (actionType === "doudizhu.bid.rob") {
      state.bid.candidateSeatId = seatId;
      state.bid.robCount += 1;
    }
    return selectLandlord(state, {
      type: "doudizhu.bid.changed",
      seatId,
      decision: eventDecision,
      robCount: state.bid.robCount,
    });
  }

  return {
    kind: "applied",
    state,
    events: [{ ...bidEvent, robCount: state.bid.robCount }],
  };
}

function selectLandlord(
  state: DoudizhuState,
  precedingEvent?: DoudizhuDisplayEvent,
): GameTransitionV1<DoudizhuState, DoudizhuDisplayEvent> {
  const landlordSeatId = state.bid.candidateSeatId;
  if (landlordSeatId === null) throw new GameRuleError("DOUDIZHU_LANDLORD_MISSING");
  state.landlordSeatId = landlordSeatId;
  state.hands[landlordSeatId] = sortDoudizhuCards([
    ...(state.hands[landlordSeatId] ?? []),
    ...state.bottomCards,
  ]);
  state.phase = "open_hand";
  state.activeSeatId = landlordSeatId;
  return {
    kind: "applied",
    state,
    events: [
      ...(precedingEvent ? [precedingEvent] : []),
      {
        type: "doudizhu.landlord.selected",
        seatId: landlordSeatId,
        bottomCards: state.bottomCards.map((card) => ({ ...card })),
      },
    ],
  };
}

function chooseOpenHand(
  state: DoudizhuState,
  seatId: SeatId,
  open: boolean,
): GameTransitionV1<DoudizhuState, DoudizhuDisplayEvent> {
  if (state.phase !== "open_hand" || seatId !== state.landlordSeatId) {
    throw new GameRuleError("DOUDIZHU_OPEN_HAND_NOT_AVAILABLE");
  }
  state.openHand = open;
  state.phase = "doubling";
  state.doubleQueue = orderedFrom(state, seatId);
  state.activeSeatId = state.doubleQueue[0] ?? null;
  return {
    kind: "applied",
    state,
    events: [{ type: "doudizhu.hand.revealed", seatId, open }],
  };
}

function chooseDouble(
  state: DoudizhuState,
  seatId: SeatId,
  doubled: boolean,
): GameTransitionV1<DoudizhuState, DoudizhuDisplayEvent> {
  if (state.phase !== "doubling" || state.doubleQueue[0] !== seatId) {
    throw new GameRuleError("DOUDIZHU_DOUBLE_NOT_AVAILABLE");
  }
  state.doubledBySeat[seatId] = doubled;
  state.doubleQueue.shift();
  if (state.doubleQueue.length === 0) {
    state.phase = "playing";
    state.activeSeatId = state.landlordSeatId;
  } else {
    state.activeSeatId = state.doubleQueue[0] ?? null;
  }
  return {
    kind: "applied",
    state,
    events: [{ type: "doudizhu.double.selected", seatId, doubled }],
  };
}

function playCards(
  state: DoudizhuState,
  seatId: SeatId,
  cardIds: readonly string[],
): GameTransitionV1<DoudizhuState, DoudizhuDisplayEvent> {
  if (state.phase !== "playing") throw new GameRuleError("DOUDIZHU_PLAY_NOT_AVAILABLE");
  if (new Set(cardIds).size !== cardIds.length) throw new GameRuleError("DOUDIZHU_DUPLICATE_CARD");
  const hand = state.hands[seatId] ?? [];
  const selected = cardIds.map((cardId) => hand.find(({ id }) => id === cardId));
  if (selected.some((card) => card === undefined)) {
    throw new GameRuleError("DOUDIZHU_CARD_NOT_OWNED");
  }
  const cards = selected as DoudizhuCard[];
  const playPattern = classifyDoudizhuPlay(cards);
  if (playPattern === null) throw new GameRuleError("DOUDIZHU_INVALID_PATTERN");
  if (state.lastPlay !== null && !canBeatDoudizhuPlay(playPattern, state.lastPlay.pattern)) {
    throw new GameRuleError("DOUDIZHU_PLAY_TOO_SMALL");
  }
  const selectedIds = new Set(cardIds);
  state.hands[seatId] = hand.filter(({ id }) => !selectedIds.has(id));
  state.lastPlay = { seatId, cards: sortDoudizhuCards(cards), pattern: playPattern };
  state.passedSeatIds = [];
  state.playTurnsBySeat[seatId] = (state.playTurnsBySeat[seatId] ?? 0) + 1;
  if (playPattern.kind === "bomb" || playPattern.kind === "rocket") state.bombCount += 1;

  const playEvent: DoudizhuDisplayEvent = {
    type: "doudizhu.cards.played",
    seatId,
    cards: sortDoudizhuCards(cards),
    patternKind: playPattern.kind,
  };
  if (state.hands[seatId]?.length === 0) {
    finishMatch(state, seatId);
    return {
      kind: "applied",
      state,
      events: [
        playEvent,
        {
          type: "doudizhu.match.completed",
          winnerSide: state.outcome?.winnerSide ?? "farmers",
          commonMultiplier: state.outcome?.commonMultiplier ?? 1,
        },
      ],
      outcome: {
        kind: "completed",
        publicSummary: {
          winnerSide: state.outcome?.winnerSide ?? "farmers",
          commonMultiplier: state.outcome?.commonMultiplier ?? 1,
          scores: state.outcome?.scores ?? [],
        },
      },
    };
  }
  state.activeSeatId = nextSeat(state, seatId);
  return { kind: "applied", state, events: [playEvent] };
}

function passTurn(
  state: DoudizhuState,
  seatId: SeatId,
): GameTransitionV1<DoudizhuState, DoudizhuDisplayEvent> {
  if (state.phase !== "playing" || state.lastPlay === null) {
    throw new GameRuleError("DOUDIZHU_CANNOT_PASS");
  }
  state.passedSeatIds.push(seatId);
  if (state.passedSeatIds.length >= 2) {
    const leader = state.lastPlay.seatId;
    state.lastPlay = null;
    state.passedSeatIds = [];
    state.activeSeatId = leader;
  } else {
    state.activeSeatId = nextSeat(state, seatId);
  }
  return {
    kind: "applied",
    state,
    events: [{ type: "doudizhu.turn.passed", seatId }],
  };
}

function finishMatch(state: DoudizhuState, winningSeatId: SeatId): void {
  const landlordSeatId = state.landlordSeatId;
  if (landlordSeatId === null) throw new GameRuleError("DOUDIZHU_LANDLORD_MISSING");
  const landlordWon = winningSeatId === landlordSeatId;
  const farmerSeatIds = state.seatOrder.filter((seatId) => seatId !== landlordSeatId);
  const landlordSpring =
    landlordWon && farmerSeatIds.every((seatId) => (state.playTurnsBySeat[seatId] ?? 0) === 0);
  const farmerSpring = !landlordWon && (state.playTurnsBySeat[landlordSeatId] ?? 0) === 1;
  const spring = landlordSpring ? "landlord" : farmerSpring ? "farmers" : null;
  const commonMultiplier =
    2 ** (state.bid.robCount + (state.openHand ? 1 : 0) + state.bombCount + (spring ? 1 : 0));
  const landlordDouble = state.doubledBySeat[landlordSeatId] ? 2 : 1;
  const scoreBySeat = new Map<SeatId, { score: number; relationMultiplier: number }>();
  let landlordScore = 0;
  for (const farmerSeatId of farmerSeatIds) {
    const relationMultiplier =
      commonMultiplier * landlordDouble * (state.doubledBySeat[farmerSeatId] ? 2 : 1);
    const farmerScore = landlordWon ? -relationMultiplier : relationMultiplier;
    landlordScore -= farmerScore;
    scoreBySeat.set(farmerSeatId, { score: farmerScore, relationMultiplier });
  }
  scoreBySeat.set(landlordSeatId, {
    score: landlordScore,
    relationMultiplier: commonMultiplier * landlordDouble,
  });
  const outcome: DoudizhuOutcomeView = {
    winnerSide: landlordWon ? "landlord" : "farmers",
    winningSeatId,
    spring,
    commonMultiplier,
    scores: state.seatOrder.map((seatId) => ({
      seatId,
      ...(scoreBySeat.get(seatId) ?? { score: 0, relationMultiplier: commonMultiplier }),
    })),
  };
  state.outcome = outcome;
  state.phase = "ended";
  state.activeSeatId = null;
}

function deal(
  state: DoudizhuState,
  random: CreateMatchContextV1["random"],
  startIndex: number,
): void {
  const deck = createDoudizhuDeck();
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = random.integer(0, index, `doudizhu.shuffle.${state.dealNumber}.${index}`);
    [deck[index], deck[swap]] = [deck[swap] as DoudizhuCard, deck[index] as DoudizhuCard];
  }
  state.hands = Object.fromEntries(
    state.seatOrder.map((seatId, seatIndex) => [
      seatId,
      sortDoudizhuCards(
        Array.from(
          { length: 17 },
          (_, cardIndex) => deck[cardIndex * 3 + seatIndex] as DoudizhuCard,
        ),
      ),
    ]),
  );
  state.bottomCards = deck.slice(51).map((card) => ({ ...card }));
  state.phase = "bidding";
  state.landlordSeatId = null;
  state.openHand = false;
  state.doubleQueue = [];
  state.doubledBySeat = Object.fromEntries(state.seatOrder.map((seatId) => [seatId, false]));
  state.lastPlay = null;
  state.passedSeatIds = [];
  state.bombCount = 0;
  state.playTurnsBySeat = Object.fromEntries(state.seatOrder.map((seatId) => [seatId, 0]));
  state.outcome = null;
  const queue = rotate(state.seatOrder, startIndex);
  state.bid = {
    stage: "seeking",
    initialCallerSeatId: null,
    candidateSeatId: null,
    queue,
    robCount: 0,
    robbed: false,
  };
  state.activeSeatId = queue[0] ?? null;
}

function orderedFrom(state: Readonly<DoudizhuState>, seatId: SeatId): SeatId[] {
  return rotate(state.seatOrder, state.seatOrder.indexOf(seatId));
}

function nextSeats(state: Readonly<DoudizhuState>, seatId: SeatId): SeatId[] {
  return orderedFrom(state, seatId).slice(1);
}

function nextSeat(state: Readonly<DoudizhuState>, seatId: SeatId): SeatId {
  const index = state.seatOrder.indexOf(seatId);
  const next = state.seatOrder[(index + 1) % state.seatOrder.length];
  if (!next) throw new GameRuleError("DOUDIZHU_SEAT_ORDER_INVALID");
  return next;
}

function rotate<T>(items: readonly T[], startIndex: number): T[] {
  return [...items.slice(startIndex), ...items.slice(0, startIndex)];
}
