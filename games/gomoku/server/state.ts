import type { SeatId } from "@tabletop/game-sdk";

import type { GomokuSettings } from "../shared/settings.js";
import type { GomokuCell, GomokuColor, GomokuCoordinate, GomokuEndReason } from "../shared/view.js";

export interface GomokuMove extends GomokuCoordinate {
  readonly color: GomokuColor;
  readonly seatId: SeatId;
  readonly moveNumber: number;
}

export type GomokuClockState =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly remainingTotalMs: Readonly<Record<string, number>>;
      readonly turnStartedAtMonotonicMs: number | null;
      readonly stepRemainingAtStartMs: number;
    };

export interface GomokuPendingOffer {
  readonly kind: "undo" | "draw";
  readonly requesterSeatId: SeatId;
  readonly responderSeatId: SeatId;
  readonly expiresAtMonotonicMs: number;
  readonly token: number;
}

export interface GomokuMatchState {
  readonly settings: GomokuSettings;
  readonly phase: "playing" | "undo_pending" | "ended";
  readonly board: readonly GomokuCell[];
  readonly turn: GomokuColor;
  readonly seatByColor: Readonly<{ black: SeatId; white: SeatId }>;
  readonly botSeatIds: readonly SeatId[];
  readonly moves: readonly GomokuMove[];
  readonly clock: GomokuClockState;
  readonly pendingOffer: GomokuPendingOffer | null;
  readonly undoRequestedAtPositions: readonly number[];
  readonly drawOfferHistory: readonly string[];
  readonly positionVersion: number;
  readonly sequence: number;
  readonly forbiddenMoves: readonly GomokuCoordinate[];
  readonly winningCells: readonly GomokuCoordinate[];
  readonly winnerSeatId: SeatId | null;
  readonly endReason: GomokuEndReason | null;
}
