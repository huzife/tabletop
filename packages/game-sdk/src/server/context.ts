import type { JsonValue, MatchId, SeatId } from "@tabletop/protocol";

export interface GameRandomV1 {
  integer(minInclusive: number, maxInclusive: number, label: string): number;
  pick<T>(items: readonly T[], label: string): T;
}

export interface GameClockV1 {
  monotonicMs(): number;
}

export type MatchSeatControllerV1 =
  { readonly kind: "human" } | { readonly kind: "bot"; readonly profileId: string };

export interface MatchSeatV1 {
  readonly seatId: SeatId;
  readonly controller: MatchSeatControllerV1;
}

export interface PreviousMatchSummaryV1 {
  readonly matchId: MatchId;
  readonly publicSummary?: JsonValue;
}

export interface CreateMatchContextV1 {
  readonly matchId: MatchId;
  readonly seats: readonly MatchSeatV1[];
  readonly previousSummary?: PreviousMatchSummaryV1;
  readonly clock: GameClockV1;
  readonly random: GameRandomV1;
}

export type GameActionActorV1 =
  | { readonly kind: "human"; readonly seatId: SeatId }
  | {
      readonly kind: "bot";
      readonly seatId: SeatId;
      readonly profileId: string;
    }
  | {
      readonly kind: "fallback";
      readonly seatId: SeatId;
      readonly reason: "disconnect" | "timeout";
    };

export interface ActionContextV1 {
  readonly matchId: MatchId;
  readonly revision: number;
  readonly actor: GameActionActorV1;
  readonly receivedAtMonotonicMs: number;
  readonly clock: GameClockV1;
  readonly random: GameRandomV1;
}

export interface ProjectionContextV1 {
  readonly matchId: MatchId;
  readonly revision: number;
  readonly clock: GameClockV1;
}

export interface DeadlineContextV1 {
  readonly matchId: MatchId;
  readonly revision: number;
  readonly firedAtMonotonicMs: number;
  readonly clock: GameClockV1;
  readonly random: GameRandomV1;
}

export interface SystemEventContextV1 {
  readonly matchId: MatchId;
  readonly revision: number;
  readonly clock: GameClockV1;
  readonly random: GameRandomV1;
}

export interface AutomationInputContextV1 {
  readonly matchId: MatchId;
  readonly revision: number;
  readonly clock: GameClockV1;
}

export type ViewerV1 =
  | { readonly kind: "player"; readonly seatId: SeatId }
  | { readonly kind: "spectator" }
  | { readonly kind: "bot"; readonly seatId: SeatId };
