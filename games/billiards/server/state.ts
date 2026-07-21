import type { SeatId } from "@tabletop/protocol";

import type {
  BilliardsBreakChoice,
  BilliardsDecidingBlackChoice,
  BilliardsSelectableGroup,
  BilliardsShot,
} from "../shared/actions.js";
import type { BilliardsMode, BilliardsSettings } from "../shared/settings.js";
import type { BilliardsBall, EightBallGroup, SnookerOn } from "../shared/view.js";

export type BilliardsPhase = "aiming" | "ball_in_hand" | "decision" | "ended";
export type BallInHandZone = "anywhere" | "behind-line" | "d";
export type BilliardsEndReason =
  "eight-ball" | "final-black" | "resigned" | "disconnected" | "left";

export interface BilliardsPlayerState {
  readonly seatId: SeatId;
  readonly group: EightBallGroup | null;
  readonly score: number;
}

export interface BilliardsLastShot {
  readonly foulCode: string | null;
  readonly points: number;
  readonly pottedBallIds: readonly string[];
  readonly seatId: SeatId;
}

export interface BilliardsOutcome {
  readonly reason: BilliardsEndReason;
  readonly winnerSeatId: SeatId;
}

export type BilliardsPendingDecision =
  | {
      readonly type: "break-choice";
      readonly reason: "illegal-break" | "break-foul" | "eight-on-break" | "eight-on-break-foul";
      readonly breakerSeatId: SeatId;
      readonly chooserSeatId: SeatId;
      readonly choices: readonly BilliardsBreakChoice[];
    }
  | {
      readonly type: "choose-group";
      readonly chooserSeatId: SeatId;
      readonly groups: readonly BilliardsSelectableGroup[];
    }
  | {
      readonly type: "deciding-black-choice";
      readonly chooserSeatId: SeatId;
      readonly choices: readonly BilliardsDecidingBlackChoice[];
    };

export interface BilliardsMatchState {
  readonly settings: Readonly<BilliardsSettings>;
  readonly seatIds: readonly [SeatId, SeatId];
  readonly activeSeatId: SeatId | null;
  readonly ballInHandZone: BallInHandZone | null;
  readonly balls: readonly BilliardsBall[];
  readonly breakShot: boolean;
  readonly decidingBlack: boolean;
  readonly lastShot: BilliardsLastShot | null;
  readonly outcome: BilliardsOutcome | null;
  readonly pendingDecision: BilliardsPendingDecision | null;
  readonly phase: BilliardsPhase;
  readonly players: readonly [BilliardsPlayerState, BilliardsPlayerState];
  readonly shotNumber: number;
  readonly snookerOn: SnookerOn | null;
}

/** The deterministic summary emitted by the local physics simulator. */
export interface BilliardsSimulationResult {
  readonly balls: readonly BilliardsBall[];
  readonly checksum: string;
  readonly cueBallPotted: boolean;
  readonly durationMs: number;
  readonly firstContactBallId: string | null;
  readonly firstContactBallIds: readonly string[];
  readonly jumpedBallIds: readonly string[];
  readonly pocketedBallIds: readonly string[];
  readonly postContactRailBallIds: readonly string[];
  readonly railContactBallIds: readonly string[];
}

export interface AdjudicatedBilliardsShot {
  readonly foulCode: string | null;
  readonly points: number;
  readonly state: BilliardsMatchState;
}

export interface ShotAdjudicationInput {
  readonly actorSeatId: SeatId;
  readonly shot: Readonly<BilliardsShot>;
  readonly simulation: Readonly<BilliardsSimulationResult>;
  readonly state: Readonly<BilliardsMatchState>;
}

export function modeOf(state: Readonly<BilliardsMatchState>): BilliardsMode {
  return state.settings.mode;
}
