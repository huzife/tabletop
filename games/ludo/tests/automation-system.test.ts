import { createTestSystemEventContextV1 } from "@tabletop/game-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LUDO_SEAT_IDS } from "../shared/index.js";
import {
  ludoBotProvider,
  LUDO_BOT_ACTION_DELAY_MS,
  ludoFallbackController,
  ludoServerModule,
  requireSeat,
} from "../server/index.js";
import { createTwoPlayerState, planeId, setPlane } from "./helpers.js";

describe("ludo automation and connection policy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scores an exact finish above other legal moves", async () => {
    vi.useFakeTimers();
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "HOME_PATH", pathIndex: 4 });
    setPlane(state, planeId("red", 2), { region: "MAIN_PATH", pathIndex: 10 });
    state.phase = "selecting_plane";
    state.roll = 1;
    const input = ludoBotProvider.createInput(
      { matchId: "match-test" as never, revision: 0, clock: { monotonicMs: () => 0 } },
      state,
      LUDO_SEAT_IDS.red,
    );
    const actionPromise = ludoBotProvider.chooseAction({
      seatId: LUDO_SEAT_IDS.red,
      input,
      revision: 0,
      hardDeadlineMonotonicMs: 100,
      decisionSeed: "seed",
      profileId: "standard",
    });
    let completed = false;
    void actionPromise.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(LUDO_BOT_ACTION_DELAY_MS - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(actionPromise).resolves.toEqual({
      type: "select_plane",
      planeId: "red-plane-1",
    });
  });

  it("uses the same legal rule controller for fallback rolls", async () => {
    const state = createTwoPlayerState();
    const input = ludoFallbackController.createInput(
      { matchId: "match-test" as never, revision: 0, clock: { monotonicMs: () => 0 } },
      state,
      LUDO_SEAT_IDS.red,
    );
    await expect(
      ludoFallbackController.chooseFallbackAction(
        {
          seatId: LUDO_SEAT_IDS.red,
          input,
          revision: 0,
          hardDeadlineMonotonicMs: 100,
          decisionSeed: "fallback",
        },
        "disconnect",
      ),
    ).resolves.toEqual({ type: "roll" });
  });

  it("temporarily hands control to AI and restores it within the grace window", () => {
    const state = createTwoPlayerState();
    const lost = ludoServerModule.handleSystemEvent(createTestSystemEventContextV1(), state, {
      type: "connection.lost",
      seatId: LUDO_SEAT_IDS.red,
      graceDeadlineMs: 30_000,
    });
    if (lost.kind !== "applied") throw new Error("expected lost transition");
    expect(requireSeat(lost.state, LUDO_SEAT_IDS.red).controller).toBe("temporary_ai");
    expect(lost.roomDirectives).toEqual([{ type: "seat.useFallbackController", seatId: "red" }]);

    const restored = ludoServerModule.handleSystemEvent(
      createTestSystemEventContextV1(),
      lost.state,
      {
        type: "connection.restored",
        seatId: LUDO_SEAT_IDS.red,
      },
    );
    if (restored.kind !== "applied") throw new Error("expected restore transition");
    expect(requireSeat(restored.state, LUDO_SEAT_IDS.red).controller).toBe("human");
    expect(restored.roomDirectives).toEqual([{ type: "seat.returnHumanControl", seatId: "red" }]);
  });

  it("keeps persistent AI reclaimable only by the platform-validated owner", () => {
    const state = createTwoPlayerState();
    const lost = ludoServerModule.handleSystemEvent(createTestSystemEventContextV1(), state, {
      type: "connection.lost",
      seatId: LUDO_SEAT_IDS.red,
      graceDeadlineMs: 30_000,
    });
    if (lost.kind !== "applied") throw new Error("expected lost transition");
    const expired = ludoServerModule.handleSystemEvent(
      createTestSystemEventContextV1(),
      lost.state,
      {
        type: "connection.grace_expired",
        seatId: LUDO_SEAT_IDS.red,
      },
    );
    if (expired.kind !== "applied") throw new Error("expected expiry transition");
    expect(requireSeat(expired.state, LUDO_SEAT_IDS.red)).toMatchObject({
      controller: "persistent_ai",
      reclaimable: true,
    });

    const reclaimed = ludoServerModule.handleSystemEvent(
      createTestSystemEventContextV1(),
      expired.state,
      {
        type: "seat.reclaim_requested",
        seatId: LUDO_SEAT_IDS.red,
      },
    );
    if (reclaimed.kind !== "applied") throw new Error("expected reclaim transition");
    expect(requireSeat(reclaimed.state, LUDO_SEAT_IDS.red)).toMatchObject({
      controller: "human",
      reclaimable: false,
    });
    expect(reclaimed.roomDirectives).toEqual([
      { type: "seat.returnHumanControl", seatId: "red" },
      { type: "seat.setReclaimable", seatId: "red", reclaimable: false },
    ]);
  });

  it("turns an active leave into non-reclaimable persistent AI", () => {
    const state = createTwoPlayerState();
    const left = ludoServerModule.handleSystemEvent(createTestSystemEventContextV1(), state, {
      type: "member.left",
      seatId: LUDO_SEAT_IDS.red,
    });
    if (left.kind !== "applied") throw new Error("expected leave transition");
    expect(requireSeat(left.state, LUDO_SEAT_IDS.red)).toMatchObject({
      controller: "persistent_ai",
      reclaimable: false,
    });
  });
});
