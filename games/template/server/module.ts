import { createDefaultSeatDefinitionsV1 } from "@tabletop/game-sdk";
import { defineGameServerModuleV1, GameRuleError } from "@tabletop/game-sdk/server";
import type { SeatId } from "@tabletop/protocol";

import type { TemplateAction } from "../shared/actions.js";
import { templateShared } from "../shared/contract.js";
import type { TemplateSettings } from "../shared/settings.js";
import type { TemplateDisplayEvent, TemplateView } from "../shared/view.js";

interface TemplateState {
  readonly settings: Readonly<TemplateSettings>;
  readonly seatIds: readonly [SeatId, SeatId];
  readonly scores: Readonly<Record<string, number>>;
  readonly activeSeatId: SeatId | null;
  readonly winnerSeatId: SeatId | null;
}

export const templateServerModule = defineGameServerModuleV1<
  TemplateSettings,
  TemplateState,
  TemplateAction,
  TemplateView,
  TemplateDisplayEvent
>({
  shared: templateShared,
  lobby: {
    getSeatDefinitions: () => createDefaultSeatDefinitionsV1(2),
    validateStart: ({ seats }) =>
      seats.length === 2 && seats.every(({ occupant }) => occupant !== "empty")
        ? { ok: true }
        : { ok: false, ruleCode: "REQUIRES_TWO_PLAYERS" },
  },
  createMatch: ({ seats }, settings) => {
    const first = seats[0]?.seatId;
    const second = seats[1]?.seatId;
    if (!first || !second) throw new GameRuleError("REQUIRES_TWO_PLAYERS");
    return {
      activeSeatId: first,
      scores: { [first]: 0, [second]: 0 },
      seatIds: [first, second] as const,
      settings,
      winnerSeatId: null,
    };
  },
  getActiveSeatIds: (state) => (state.activeSeatId ? [state.activeSeatId] : []),
  getDeadlines: () => [],
  handleAction: (context, state) => {
    if (!state.activeSeatId || state.winnerSeatId) throw new GameRuleError("MATCH_ENDED");
    if (context.actor.seatId !== state.activeSeatId) throw new GameRuleError("NOT_YOUR_TURN");
    const score = (state.scores[context.actor.seatId] ?? 0) + 1;
    const won = score >= state.settings.targetScore;
    const nextSeatId = state.seatIds.find((seatId) => seatId !== context.actor.seatId) ?? null;
    return {
      events: [{ score, seatId: context.actor.seatId, type: "template.scored" }],
      kind: "applied",
      ...(won ? { outcome: { kind: "completed" as const } } : {}),
      state: {
        ...state,
        activeSeatId: won ? null : nextSeatId,
        scores: { ...state.scores, [context.actor.seatId]: score },
        winnerSeatId: won ? context.actor.seatId : null,
      },
    };
  },
  handleDeadline: (_context, state) => ({ kind: "noop", state }),
  handleSystemEvent: (_context, state, event) => {
    if (
      (event.type !== "connection.grace_expired" && event.type !== "member.left") ||
      state.winnerSeatId
    ) {
      return { kind: "noop", state };
    }
    const winnerSeatId = state.seatIds.find((seatId) => seatId !== event.seatId) ?? null;
    return {
      events: [],
      kind: "applied",
      outcome: { kind: "completed" },
      state: { ...state, activeSeatId: null, winnerSeatId },
    };
  },
  projectView: (_context, state, viewer) => ({
    activeSeatId: state.activeSeatId,
    canScore: viewer.kind === "player" && viewer.seatId === state.activeSeatId,
    scores: state.seatIds.map((seatId) => ({ score: state.scores[seatId] ?? 0, seatId })),
    targetScore: state.settings.targetScore,
    viewerSeatId: viewer.kind === "player" ? viewer.seatId : null,
    winnerSeatId: state.winnerSeatId,
  }),
});
