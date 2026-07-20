import { performance } from "node:perf_hooks";

import { gameIdSchema, seatIdSchema } from "@tabletop/protocol";
import { describe, expect, it } from "vitest";

import { serverGameRegistry } from "../games/registry.js";
import { SingleWorkerAutomationExecutor } from "./executor.js";

describe("SingleWorkerAutomationExecutor", () => {
  it("runs a plugin AI action outside the room event loop", async () => {
    const executor = new SingleWorkerAutomationExecutor();
    const game = serverGameRegistry.require(gameIdSchema.parse("gomoku"));
    const seatId = seatIdSchema.parse("seat-1");

    try {
      const action = await executor.chooseBotAction(
        "gomoku",
        game,
        {
          decisionSeed: "worker-test-seed",
          hardDeadlineMonotonicMs: performance.now() + 2_000,
          input: {
            board: Array<number>(225).fill(0),
            color: "black",
            legalMoves: [{ x: 7, y: 7 }],
            rule: "freestyle",
          },
          profileId: "easy",
          revision: 1,
          seatId,
        },
        2_000,
      );

      expect(action).toEqual({ type: "gomoku.place", x: 7, y: 7 });
    } finally {
      await executor.close();
    }
  }, 10_000);
});
