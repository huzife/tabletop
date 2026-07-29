import type { SeatId } from "@tabletop/protocol";

import type {
  DoudizhuCard,
  DoudizhuController,
  DoudizhuOutcomeView,
  DoudizhuPhase,
  DoudizhuPlayPattern,
  DoudizhuSettings,
} from "../shared/index.js";

export type DoudizhuBidStage = "seeking" | "robbing" | "counter";

export interface DoudizhuSeatState {
  seatId: SeatId;
  controller: DoudizhuController;
  reclaimable: boolean;
}

export interface DoudizhuBidState {
  stage: DoudizhuBidStage;
  initialCallerSeatId: SeatId | null;
  candidateSeatId: SeatId | null;
  queue: SeatId[];
  robCount: number;
  robbed: boolean;
}

export interface DoudizhuPublicPlay {
  seatId: SeatId;
  cards: DoudizhuCard[];
  pattern: DoudizhuPlayPattern;
}

export interface DoudizhuState {
  settings: DoudizhuSettings;
  phase: DoudizhuPhase;
  dealNumber: number;
  seatOrder: [SeatId, SeatId, SeatId];
  seats: DoudizhuSeatState[];
  hands: Record<string, DoudizhuCard[]>;
  bottomCards: DoudizhuCard[];
  activeSeatId: SeatId | null;
  bid: DoudizhuBidState;
  landlordSeatId: SeatId | null;
  openHand: boolean;
  doubleQueue: SeatId[];
  doubledBySeat: Record<string, boolean>;
  lastPlay: DoudizhuPublicPlay | null;
  passedSeatIds: SeatId[];
  bombCount: number;
  playTurnsBySeat: Record<string, number>;
  outcome: DoudizhuOutcomeView | null;
}

export function cloneDoudizhuState(state: Readonly<DoudizhuState>): DoudizhuState {
  return {
    ...state,
    settings: { ...state.settings },
    seatOrder: [...state.seatOrder] as [SeatId, SeatId, SeatId],
    seats: state.seats.map((seat) => ({ ...seat })),
    hands: Object.fromEntries(
      Object.entries(state.hands).map(([seatId, cards]) => [
        seatId,
        cards.map((card) => ({ ...card })),
      ]),
    ),
    bottomCards: state.bottomCards.map((card) => ({ ...card })),
    bid: { ...state.bid, queue: [...state.bid.queue] },
    doubleQueue: [...state.doubleQueue],
    doubledBySeat: { ...state.doubledBySeat },
    lastPlay:
      state.lastPlay === null
        ? null
        : {
            seatId: state.lastPlay.seatId,
            cards: state.lastPlay.cards.map((card) => ({ ...card })),
            pattern: { ...state.lastPlay.pattern },
          },
    passedSeatIds: [...state.passedSeatIds],
    playTurnsBySeat: { ...state.playTurnsBySeat },
    outcome:
      state.outcome === null
        ? null
        : {
            ...state.outcome,
            scores: state.outcome.scores.map((score) => ({ ...score })),
          },
  };
}
