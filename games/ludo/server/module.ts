import type { SeatId } from "@tabletop/game-sdk";
import {
  defineGameServerModuleV1,
  type GameRoomDirectiveV1,
  type GameSystemEventV1,
  type GameTransitionV1,
  type SystemEventContextV1,
} from "@tabletop/game-sdk/server";

import {
  LUDO_BOARD_PRESENTATION,
  LUDO_COLORS_CLOCKWISE,
  LUDO_SEAT_IDS,
  ludoShared,
  type LudoDisplayStep,
  type LudoSettings,
  type LudoView,
} from "../shared/index.js";
import { ludoBotProvider, ludoFallbackController } from "./ai/index.js";
import { cellIdForPlane } from "./board/index.js";
import {
  activeLudoSeatIds,
  applyLudoAction,
  applyLudoDeadline,
  cloneLudoState,
  createLudoState,
  getLudoDeadlines,
  getLegalPlaneIds,
  requireSeat,
  type LudoState,
} from "./rules/index.js";

const COLOR_NAMES = {
  red: "红方",
  yellow: "黄方",
  green: "绿方",
  blue: "蓝方",
} as const;

export const ludoServerModule = defineGameServerModuleV1({
  shared: ludoShared,
  lobby: {
    getSeatDefinitions: () =>
      LUDO_COLORS_CLOCKWISE.map((color) => ({
        seatId: LUDO_SEAT_IDS[color],
        displayName: COLOR_NAMES[color],
      })),
    validateStart(context) {
      const occupied = context.seats.filter((seat) => seat.occupant !== "empty");
      if (occupied.length < 2 || occupied.length > 4) {
        return {
          ok: false,
          ruleCode: "LUDO_PLAYER_COUNT_INVALID",
          publicDetails: { minimum: 2, maximum: 4 },
        };
      }
      if (!occupied.some((seat) => seat.occupant === "human")) {
        return { ok: false, ruleCode: "LUDO_HUMAN_REQUIRED" };
      }
      if (occupied.some((seat) => !seat.ready)) {
        return { ok: false, ruleCode: "LUDO_NOT_ALL_READY" };
      }
      return { ok: true };
    },
  },
  createMatch: createLudoState,
  handleAction: applyLudoAction,
  projectView(context, state, viewer): LudoView {
    const viewerSeatId = viewer.kind === "spectator" ? null : viewer.seatId;
    const viewerSeat =
      viewerSeatId === null ? undefined : state.seats.find((seat) => seat.seatId === viewerSeatId);
    const legalPlaneIds =
      state.phase === "selecting_plane" && state.currentSeatId !== null && state.roll !== null
        ? getLegalPlaneIds(state, state.currentSeatId, state.roll)
        : [];
    const viewerCanAct =
      viewer.kind === "player" &&
      viewerSeat?.controller === "human" &&
      state.currentSeatId === viewer.seatId;

    return {
      phase: state.phase,
      board: LUDO_BOARD_PRESENTATION,
      seats: state.seats.map((seat) => ({
        seatId: seat.seatId,
        color: seat.color,
        controller: seat.controller,
        reclaimable: seat.reclaimable,
        rank: rankOf(state, seat.seatId),
        finishedPlanes: state.planes.filter(
          (plane) => plane.color === seat.color && plane.position.region === "FINISHED",
        ).length,
        active: state.currentSeatId === seat.seatId,
      })),
      planes: state.planes.map((plane) => ({
        planeId: plane.planeId,
        color: plane.color,
        number: plane.number,
        position: { ...plane.position },
        cellId: cellIdForPlane(plane),
        selectable:
          viewerCanAct &&
          state.phase === "selecting_plane" &&
          legalPlaneIds.includes(plane.planeId),
      })),
      seatOrder: [...state.seatOrder],
      currentSeatId: state.currentSeatId,
      sixStreak: state.sixStreak,
      roll: state.roll,
      rankings: [...state.rankings],
      orderRolls: state.orderRolls.map((roll) => ({ ...roll })),
      legalPlaneIds: viewerCanAct ? legalPlaneIds : [],
      canRoll: viewerCanAct && state.phase === "waiting_roll",
      canSelectPlane: viewerCanAct && state.phase === "selecting_plane",
      deadlineRemainingMs:
        state.actionDeadlineMs === null
          ? null
          : Math.max(0, state.actionDeadlineMs - context.clock.monotonicMs()),
      phaseTimeSeconds: state.settings.phaseTimeSeconds,
      viewerSeatId,
      viewerController: viewerSeat?.controller ?? null,
      lastSteps: state.lastSteps.map((step) => ({ ...step })),
    };
  },
  getDeadlines: getLudoDeadlines,
  handleDeadline: applyLudoDeadline,
  handleSystemEvent: applySystemEvent,
  getActiveSeatIds: activeLudoSeatIds,
  bot: ludoBotProvider,
  fallbackController: ludoFallbackController,
});

function applySystemEvent(
  _context: SystemEventContextV1,
  state: Readonly<LudoState>,
  event: GameSystemEventV1,
): GameTransitionV1<LudoState, LudoDisplayStep> {
  const seat = state.seats.find((candidate) => candidate.seatId === event.seatId);
  if (seat === undefined || seat.controller === "bot") {
    return { kind: "noop", state: cloneLudoState(state) };
  }

  const next = cloneLudoState(state);
  const mutableSeat = requireSeat(next, event.seatId);
  const directives: GameRoomDirectiveV1[] = [];

  switch (event.type) {
    case "connection.lost":
      if (mutableSeat.controller !== "human") return { kind: "noop", state: next };
      mutableSeat.controller = "temporary_ai";
      mutableSeat.reclaimable = false;
      directives.push({ type: "seat.useFallbackController", seatId: event.seatId });
      break;
    case "connection.restored":
      if (mutableSeat.controller !== "temporary_ai") return { kind: "noop", state: next };
      mutableSeat.controller = "human";
      mutableSeat.reclaimable = false;
      directives.push({ type: "seat.returnHumanControl", seatId: event.seatId });
      break;
    case "connection.grace_expired":
      if (mutableSeat.controller !== "temporary_ai") return { kind: "noop", state: next };
      mutableSeat.controller = "persistent_ai";
      mutableSeat.reclaimable = true;
      directives.push({ type: "seat.setReclaimable", seatId: event.seatId, reclaimable: true });
      break;
    case "seat.reclaim_requested":
      if (mutableSeat.controller !== "persistent_ai" || !mutableSeat.reclaimable) {
        return { kind: "noop", state: next };
      }
      mutableSeat.controller = "human";
      mutableSeat.reclaimable = false;
      directives.push(
        { type: "seat.returnHumanControl", seatId: event.seatId },
        { type: "seat.setReclaimable", seatId: event.seatId, reclaimable: false },
      );
      break;
    case "member.left":
      mutableSeat.controller = "persistent_ai";
      mutableSeat.reclaimable = false;
      directives.push(
        { type: "seat.useFallbackController", seatId: event.seatId },
        { type: "seat.setReclaimable", seatId: event.seatId, reclaimable: false },
      );
      break;
  }

  return {
    kind: "applied",
    state: next,
    events: [],
    roomDirectives: directives,
  };
}

function rankOf(state: Readonly<LudoState>, seatId: SeatId): number | null {
  const index = state.rankings.indexOf(seatId);
  return index < 0 ? null : index + 1;
}

export type { LudoSettings, LudoState };
