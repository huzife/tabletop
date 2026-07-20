import type { SeatId } from "@tabletop/game-sdk";
import {
  createTestActionContextV1,
  createTestCreateMatchContextV1,
  createTestDeadlineContextV1,
  FakeGameClockV1,
  SequenceGameRandomV1,
} from "@tabletop/game-sdk/testing";
import { describe, expect, it } from "vitest";

import { LUDO_SEAT_IDS } from "../shared/index.js";
import {
  createLudoState,
  ludoServerModule,
  requirePlane,
  type LudoState,
} from "../server/index.js";
import { createTwoPlayerState, planeId, setPlane } from "./helpers.js";

describe("ludo match state machine", () => {
  it("rerolls only tied opening leaders and rotates occupied colors clockwise", () => {
    const random = new SequenceGameRandomV1([6, 6, 3, 5]);
    const state = createLudoState(
      createTestCreateMatchContextV1({
        seats: [
          { seatId: LUDO_SEAT_IDS.red, controller: { kind: "human" } },
          { seatId: LUDO_SEAT_IDS.yellow, controller: { kind: "human" } },
        ],
        random,
      }),
      { phaseTimeSeconds: 30 },
    );

    expect(state.orderRolls.map(({ round, seatId, value }) => [round, seatId, value])).toEqual([
      [1, "red", 6],
      [1, "yellow", 6],
      [2, "red", 3],
      [2, "yellow", 5],
    ]);
    expect(state.seatOrder).toEqual(["yellow", "red"]);
    expect(state.currentSeatId).toBe("yellow");
    random.assertExhausted();
  });

  it("supports 2-4 occupied seats, requires a human, and requires readiness", () => {
    const definitions = ludoServerModule.lobby?.getSeatDefinitions({ phaseTimeSeconds: 30 });
    expect(definitions?.map((seat) => seat.seatId)).toEqual(["red", "yellow", "green", "blue"]);
    expect(
      ludoServerModule.lobby?.validateStart(
        {
          seats: [
            { seatId: LUDO_SEAT_IDS.red, occupant: "human", ready: true },
            { seatId: LUDO_SEAT_IDS.yellow, occupant: "bot", ready: true },
            { seatId: LUDO_SEAT_IDS.green, occupant: "empty", ready: false },
            { seatId: LUDO_SEAT_IDS.blue, occupant: "empty", ready: false },
          ],
        },
        { phaseTimeSeconds: 30 },
      ),
    ).toEqual({ ok: true });
    expect(
      ludoServerModule.lobby?.validateStart(
        {
          seats: [
            { seatId: LUDO_SEAT_IDS.red, occupant: "bot", ready: true },
            { seatId: LUDO_SEAT_IDS.yellow, occupant: "bot", ready: true },
          ],
        },
        { phaseTimeSeconds: 30 },
      ),
    ).toMatchObject({ ok: false, ruleCode: "LUDO_HUMAN_REQUIRED" });
  });

  it("launches on five, advances normally, and grants an extra roll on six", () => {
    const initial = createTwoPlayerState();
    const rolledFive = ludoServerModule.handleAction(
      actionContext(LUDO_SEAT_IDS.red, [5]),
      initial,
      { type: "roll" },
    );
    expect(rolledFive.kind).toBe("applied");
    if (rolledFive.kind !== "applied") return;
    expect(rolledFive.state.phase).toBe("selecting_plane");

    const launched = ludoServerModule.handleAction(
      actionContext(LUDO_SEAT_IDS.red),
      rolledFive.state,
      { type: "select_plane", planeId: planeId("red", 1) },
    );
    expect(launched.state.currentSeatId).toBe("yellow");
    expect(requirePlane(launched.state, planeId("red", 1)).position).toEqual({ region: "APRON" });

    const sixState = createTwoPlayerState();
    const rolledSix = ludoServerModule.handleAction(
      actionContext(LUDO_SEAT_IDS.red, [6]),
      sixState,
      { type: "roll" },
    );
    if (rolledSix.kind !== "applied") throw new Error("expected roll transition");
    const sixLaunch = ludoServerModule.handleAction(
      actionContext(LUDO_SEAT_IDS.red),
      rolledSix.state,
      { type: "select_plane", planeId: planeId("red", 1) },
    );
    expect(sixLaunch.state.currentSeatId).toBe("red");
    expect(sixLaunch.state.sixStreak).toBe(1);
    expect(sixLaunch.state.phase).toBe("waiting_roll");
  });

  it("applies the third-six penalty before selection and preserves finished planes", () => {
    const state = createTwoPlayerState();
    state.sixStreak = 2;
    setPlane(state, planeId("red", 1), { region: "APRON" });
    setPlane(state, planeId("red", 2), { region: "MAIN_PATH", pathIndex: 12 });
    setPlane(state, planeId("red", 3), { region: "HOME_PATH", pathIndex: 2 });
    setPlane(state, planeId("red", 4), { region: "FINISHED" });

    const transition = ludoServerModule.handleAction(actionContext(LUDO_SEAT_IDS.red, [6]), state, {
      type: "roll",
    });
    if (transition.kind !== "applied") throw new Error("expected applied transition");
    expect(transition.events).toContainEqual(
      expect.objectContaining({
        type: "three_sixes",
        returnedPlaneIds: ["red-plane-1", "red-plane-2", "red-plane-3"],
      }),
    );
    expect(
      transition.state.planes
        .filter((plane) => plane.color === "red")
        .map((plane) => plane.position.region),
    ).toEqual(["BASE", "BASE", "BASE", "FINISHED"]);
    expect(transition.state.currentSeatId).toBe("yellow");
    expect(transition.state.sixStreak).toBe(0);
  });

  it("automatically rolls and randomly selects on phase deadlines", () => {
    const clock = new FakeGameClockV1(30_000);
    const state = createTwoPlayerState();
    const rollDeadline = ludoServerModule.getDeadlines(state)[0];
    if (rollDeadline === undefined) throw new Error("missing roll deadline");
    const rolled = ludoServerModule.handleDeadline(
      createTestDeadlineContextV1({
        clock,
        firedAtMonotonicMs: 30_000,
        random: new SequenceGameRandomV1([5]),
      }),
      state,
      rollDeadline,
    );
    if (rolled.kind !== "applied") throw new Error("expected automatic roll");
    expect(rolled.state.phase).toBe("selecting_plane");

    const selectDeadline = ludoServerModule.getDeadlines(rolled.state)[0];
    if (selectDeadline === undefined) throw new Error("missing select deadline");
    clock.set(selectDeadline.dueAtMonotonicMs);
    const selected = ludoServerModule.handleDeadline(
      createTestDeadlineContextV1({
        clock,
        firedAtMonotonicMs: selectDeadline.dueAtMonotonicMs,
        random: new SequenceGameRandomV1([2]),
      }),
      rolled.state,
      selectDeadline,
    );
    if (selected.kind !== "applied") throw new Error("expected automatic selection");
    expect(requirePlane(selected.state, planeId("red", 3)).position.region).toBe("APRON");
    expect(selected.state.currentSeatId).toBe("yellow");
  });

  it("records the finisher and immediately assigns the last remaining rank", () => {
    const state = createTwoPlayerState();
    for (let number = 1; number <= 3; number += 1)
      setPlane(state, planeId("red", number), { region: "FINISHED" });
    setPlane(state, planeId("red", 4), { region: "HOME_PATH", pathIndex: 4 });
    state.phase = "selecting_plane";
    state.roll = 1;

    const transition = ludoServerModule.handleAction(actionContext(LUDO_SEAT_IDS.red), state, {
      type: "select_plane",
      planeId: planeId("red", 4),
    });
    if (transition.kind !== "applied") throw new Error("expected ranking transition");
    expect(transition.state.phase).toBe("ended");
    expect(transition.state.rankings).toEqual(["red", "yellow"]);
    expect(transition.outcome?.publicSummary).toEqual({ rankings: ["red", "yellow"] });
  });

  it("exposes only the current actionable seat to generic automation", () => {
    const state = createTwoPlayerState();
    expect(ludoServerModule.getActiveSeatIds?.(state)).toEqual(["red"]);
    state.phase = "resolving";
    expect(ludoServerModule.getActiveSeatIds?.(state)).toEqual([]);
  });
});

function actionContext(seatId: SeatId, randomValues: readonly number[] = []) {
  return createTestActionContextV1({
    actor: { kind: "human", seatId },
    random: new SequenceGameRandomV1(randomValues),
  });
}
