import type { SeatId } from "@tabletop/game-sdk";

import type {
  ControllerKind,
  LudoColor,
  LudoDisplayStep,
  LudoPhase,
  LudoSettings,
  OrderRoll,
  PlaneId,
  PlanePosition,
} from "../../shared/index.js";

export interface LudoPlane {
  readonly planeId: PlaneId;
  readonly color: LudoColor;
  readonly number: number;
  position: PlanePosition;
}

export interface LudoSeatState {
  readonly seatId: SeatId;
  readonly color: LudoColor;
  controller: ControllerKind;
  readonly botProfileId: string | null;
  reclaimable: boolean;
}

export interface LudoState {
  readonly settings: LudoSettings;
  phase: LudoPhase;
  readonly seats: LudoSeatState[];
  readonly seatOrder: SeatId[];
  currentSeatId: SeatId | null;
  sixStreak: number;
  roll: number | null;
  readonly planes: LudoPlane[];
  readonly rankings: SeatId[];
  readonly orderRolls: OrderRoll[];
  actionDeadlineMs: number | null;
  deadlineNonce: number;
  rollSequence: number;
  lastSteps: LudoDisplayStep[];
}

export function cloneLudoState(state: Readonly<LudoState>): LudoState {
  return {
    settings: { ...state.settings },
    phase: state.phase,
    seats: state.seats.map((seat) => ({ ...seat })),
    seatOrder: [...state.seatOrder],
    currentSeatId: state.currentSeatId,
    sixStreak: state.sixStreak,
    roll: state.roll,
    planes: state.planes.map((plane) => ({ ...plane, position: { ...plane.position } })),
    rankings: [...state.rankings],
    orderRolls: state.orderRolls.map((roll) => ({ ...roll })),
    actionDeadlineMs: state.actionDeadlineMs,
    deadlineNonce: state.deadlineNonce,
    rollSequence: state.rollSequence,
    lastSteps: state.lastSteps.map((step) => ({ ...step })),
  };
}

export function requireSeat(state: Readonly<LudoState>, seatId: SeatId): LudoSeatState {
  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  if (seat === undefined) throw new RangeError(`unknown ludo seat: ${seatId}`);
  return seat;
}

export function requirePlane(state: Readonly<LudoState>, planeId: PlaneId): LudoPlane {
  const plane = state.planes.find((candidate) => candidate.planeId === planeId);
  if (plane === undefined) throw new RangeError(`unknown ludo plane: ${planeId}`);
  return plane;
}
