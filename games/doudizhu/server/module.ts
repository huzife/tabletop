import type { SeatId } from "@tabletop/protocol";
import {
  defineGameServerModuleV1,
  type GameRoomDirectiveV1,
  type GameSystemEventV1,
  type GameTransitionV1,
  type ProjectionContextV1,
  type SystemEventContextV1,
  type ViewerV1,
} from "@tabletop/game-sdk/server";

import {
  doudizhuShared,
  type DoudizhuDisplayEvent,
  type DoudizhuRole,
  type DoudizhuView,
} from "../shared/index.js";
import { doudizhuBotProvider, doudizhuFallbackController } from "./ai.js";
import { applyDoudizhuAction, createDoudizhuState } from "./rules.js";
import { cloneDoudizhuState, type DoudizhuState } from "./state.js";

const SEAT_NAMES = ["一号位", "二号位", "三号位"] as const;

export const doudizhuServerModule = defineGameServerModuleV1({
  shared: doudizhuShared,
  lobby: {
    getSeatDefinitions: () =>
      SEAT_NAMES.map((displayName, index) => ({
        seatId: `seat-${index + 1}` as SeatId,
        displayName,
      })),
    validateStart({ seats }) {
      if (seats.length !== 3 || seats.some(({ occupant }) => occupant === "empty")) {
        return { ok: false, ruleCode: "DOUDIZHU_REQUIRES_THREE_PLAYERS" };
      }
      if (!seats.some(({ occupant }) => occupant === "human")) {
        return { ok: false, ruleCode: "DOUDIZHU_HUMAN_REQUIRED" };
      }
      if (seats.some(({ occupant, ready }) => occupant === "human" && !ready)) {
        return { ok: false, ruleCode: "DOUDIZHU_NOT_ALL_READY" };
      }
      return { ok: true };
    },
  },
  createMatch: createDoudizhuState,
  handleAction: applyDoudizhuAction,
  projectView: projectDoudizhuView,
  getDeadlines: () => [],
  handleDeadline: (_context, state) => ({ kind: "noop", state: cloneDoudizhuState(state) }),
  handleSystemEvent: applySystemEvent,
  getActiveSeatIds: (state) => (state.activeSeatId === null ? [] : [state.activeSeatId]),
  bot: doudizhuBotProvider,
  fallbackController: doudizhuFallbackController,
});

function projectDoudizhuView(
  context: ProjectionContextV1,
  state: Readonly<DoudizhuState>,
  viewer: ViewerV1,
): DoudizhuView {
  const viewerSeatId = viewer.kind === "spectator" ? null : viewer.seatId;
  const viewerSeat = state.seats.find(({ seatId }) => seatId === viewerSeatId);
  const viewerCanAct =
    viewer.kind === "player" &&
    viewerSeat?.controller === "human" &&
    state.activeSeatId === viewer.seatId &&
    state.phase !== "ended";
  const roleFor = (seatId: SeatId): DoudizhuRole | null =>
    state.landlordSeatId === null ? null : state.landlordSeatId === seatId ? "landlord" : "farmer";
  const visibleHands = state.seatOrder
    .filter(
      (seatId) =>
        seatId !== viewerSeatId &&
        (state.phase === "ended" || (state.openHand && seatId === state.landlordSeatId)),
    )
    .map((seatId) => ({
      seatId,
      cards: (state.hands[seatId] ?? []).map((card) => ({ ...card })),
    }));
  const common = commonMultiplier(state);
  return {
    phase: state.phase,
    revision: context.revision,
    dealNumber: state.dealNumber,
    activeSeatId: state.activeSeatId,
    viewerSeatId,
    landlordSeatId: state.landlordSeatId,
    initialCallerSeatId: state.bid.initialCallerSeatId,
    seats: state.seats.map((seat) => ({
      seatId: seat.seatId,
      role: roleFor(seat.seatId),
      controller: seat.controller,
      reclaimable: seat.reclaimable,
      cardCount: state.hands[seat.seatId]?.length ?? 0,
      isCurrent: state.activeSeatId === seat.seatId,
      doubled: state.doubledBySeat[seat.seatId] ?? false,
    })),
    viewerHand:
      viewerSeatId === null ? [] : (state.hands[viewerSeatId] ?? []).map((card) => ({ ...card })),
    visibleHands,
    bottomCards:
      state.landlordSeatId === null ? [] : state.bottomCards.map((card) => ({ ...card })),
    lastPlay:
      state.lastPlay === null
        ? null
        : {
            seatId: state.lastPlay.seatId,
            cards: state.lastPlay.cards.map((card) => ({ ...card })),
            pattern: { ...state.lastPlay.pattern },
          },
    passedSeatIds: [...state.passedSeatIds],
    multiplier: {
      common,
      robCount: state.bid.robCount,
      openHand: state.openHand,
      bombCount: state.bombCount,
      spring: state.outcome?.spring ?? null,
    },
    legalActions: {
      canCall: viewerCanAct && state.phase === "bidding" && state.bid.stage === "seeking",
      canRob: viewerCanAct && state.phase === "bidding" && state.bid.stage !== "seeking",
      canPassBid: viewerCanAct && state.phase === "bidding",
      canChooseOpenHand: viewerCanAct && state.phase === "open_hand",
      canDouble: viewerCanAct && state.phase === "doubling",
      canPlay: viewerCanAct && state.phase === "playing",
      canPass: viewerCanAct && state.phase === "playing" && state.lastPlay !== null,
    },
    outcome:
      state.outcome === null
        ? null
        : {
            ...state.outcome,
            scores: state.outcome.scores.map((score) => ({ ...score })),
          },
  };
}

function applySystemEvent(
  _context: SystemEventContextV1,
  state: Readonly<DoudizhuState>,
  event: GameSystemEventV1,
): GameTransitionV1<DoudizhuState, DoudizhuDisplayEvent> {
  if (state.phase === "ended") return { kind: "noop", state: cloneDoudizhuState(state) };
  const next = cloneDoudizhuState(state);
  const seat = next.seats.find(({ seatId }) => seatId === event.seatId);
  if (!seat || seat.controller === "bot") return { kind: "noop", state: next };
  const directives: GameRoomDirectiveV1[] = [];
  switch (event.type) {
    case "connection.lost":
    case "connection.restored":
      return { kind: "noop", state: next };
    case "connection.grace_expired":
      if (seat.controller !== "human") return { kind: "noop", state: next };
      seat.controller = "persistent_ai";
      seat.reclaimable = false;
      directives.push(
        { type: "seat.useFallbackController", seatId: event.seatId },
        { type: "seat.setReclaimable", seatId: event.seatId, reclaimable: false },
      );
      break;
    case "seat.reclaim_requested":
      if (seat.controller !== "persistent_ai" || !seat.reclaimable) {
        return { kind: "noop", state: next };
      }
      seat.controller = "human";
      seat.reclaimable = false;
      directives.push(
        { type: "seat.returnHumanControl", seatId: event.seatId },
        { type: "seat.setReclaimable", seatId: event.seatId, reclaimable: false },
      );
      break;
    case "member.left":
      seat.controller = "persistent_ai";
      seat.reclaimable = false;
      directives.push(
        { type: "seat.useFallbackController", seatId: event.seatId },
        { type: "seat.setReclaimable", seatId: event.seatId, reclaimable: false },
      );
      break;
  }
  return { kind: "applied", state: next, events: [], roomDirectives: directives };
}

function commonMultiplier(state: Readonly<DoudizhuState>): number {
  if (state.outcome !== null) return state.outcome.commonMultiplier;
  return 2 ** (state.bid.robCount + (state.openHand ? 1 : 0) + state.bombCount);
}

export type { DoudizhuState };
