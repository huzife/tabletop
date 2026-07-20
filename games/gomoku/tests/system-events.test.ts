import { describe, expect, it } from "vitest";

import {
  handleGomokuAction,
  handleGomokuSystemEvent,
  projectGomokuView,
} from "../server/engine.js";
import {
  actionContext,
  createState,
  projectionContext,
  seat1,
  seat2,
  systemContext,
} from "./helpers.js";

describe("gomoku connection policy", () => {
  it("keeps the clock running while fallback takes over and restores human control", () => {
    const state = createState({ timerEnabled: true, totalTimeMinutes: 1, moveTimeSeconds: 5 });
    const lost = handleGomokuSystemEvent(systemContext(2_000), state, {
      type: "connection.lost",
      seatId: seat1,
      graceDeadlineMs: 32_000,
    });
    if (lost.kind !== "applied") throw new Error("expected connection loss to apply");

    expect(lost.state).toBe(state);
    expect(lost.roomDirectives).toEqual([{ type: "seat.useFallbackController", seatId: seat1 }]);
    const view = projectGomokuView(projectionContext(2_000), lost.state, {
      kind: "player",
      seatId: seat1,
    });
    expect(view.moveRemainingMs).toBe(3_000);
    expect(view.players.find(({ seatId }) => seatId === seat1)?.totalRemainingMs).toBe(58_000);

    const restored = handleGomokuSystemEvent(systemContext(2_500), lost.state, {
      type: "connection.restored",
      seatId: seat1,
    });
    if (restored.kind !== "applied") throw new Error("expected restoration to apply");
    expect(restored.state).toBe(state);
    expect(restored.roomDirectives).toEqual([{ type: "seat.returnHumanControl", seatId: seat1 }]);
  });

  it("ends with a disconnect loss when the grace period expires", () => {
    const state = createState();
    const transition = handleGomokuSystemEvent(systemContext(30_000), state, {
      type: "connection.grace_expired",
      seatId: seat1,
    });
    if (transition.kind !== "applied") throw new Error("expected grace expiry to apply");

    expect(transition.state).toMatchObject({
      phase: "ended",
      winnerSeatId: seat2,
      endReason: "disconnected",
    });
    expect(transition.roomDirectives).toBeUndefined();
    expect(transition.outcome?.publicSummary).toMatchObject({
      winnerSeatId: seat2,
      endReason: "disconnected",
    });
  });

  it("treats an explicit member departure as an immediate loss", () => {
    const state = createState();
    const transition = handleGomokuSystemEvent(systemContext(1_000), state, {
      type: "member.left",
      seatId: seat2,
    });
    if (transition.kind !== "applied") throw new Error("expected departure to apply");

    expect(transition.state).toMatchObject({
      phase: "ended",
      winnerSeatId: seat1,
      endReason: "left",
    });
    expect(transition.events).toContainEqual({
      type: "gomoku.matchEnded",
      winnerSeatId: seat1,
      reason: "left",
    });
  });

  it("does not return control after fallback has already ended the match", () => {
    const state = createState();
    const resigned = handleGomokuAction(actionContext(seat1), state, {
      type: "gomoku.resign",
    });
    if (resigned.kind !== "applied") throw new Error("expected resignation to apply");

    expect(
      handleGomokuSystemEvent(systemContext(1_000), resigned.state, {
        type: "connection.restored",
        seatId: seat1,
      }),
    ).toEqual({ kind: "noop", state: resigned.state });
  });
});
