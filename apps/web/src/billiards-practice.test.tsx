import { cleanup, render, screen } from "@testing-library/react";
import { seatIdSchema } from "@tabletop/protocol";
import { billiardsViewSchema, type BilliardsView } from "@tabletop/game-billiards";
import {
  createBilliardsMatch,
  handleBilliardsAction,
  projectBilliardsView,
} from "@tabletop/game-billiards/server";
import { BilliardsGameView } from "@tabletop/game-billiards/web";
import {
  createTestActionContextV1,
  createTestCreateMatchContextV1,
  createTestProjectionContextV1,
} from "@tabletop/game-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("billiards solo practice view", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows one practice player without resigning or snooker nomination", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const rendered = render(
      <BilliardsGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={vi.fn()}
        displayEvents={[]}
        readOnly={false}
        view={practiceView()}
      />,
    );

    expect(screen.getByText(/斯诺克 · 单人练习/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "练习统计" })).toBeInTheDocument();
    expect(rendered.container.querySelectorAll(".billiards-player")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "出杆" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "认输" })).not.toBeInTheDocument();
    expect(screen.queryByText("目标彩球")).not.toBeInTheDocument();
  });
});

function practiceView(): BilliardsView {
  const seatId = seatIdSchema.parse("seat-1");
  const initial = createBilliardsMatch(
    createTestCreateMatchContextV1({
      seats: [{ controller: { kind: "human" }, seatId }],
    }),
    { mode: "snooker" },
  );
  const cue = initial.balls.find(({ kind }) => kind === "cue");
  if (!cue) throw new Error("practice fixture is missing its cue ball");

  const placed = handleBilliardsAction(
    createTestActionContextV1({ actor: { kind: "human", seatId } }),
    initial,
    { type: "billiards.place-cue", x: cue.x, y: cue.y },
  );
  const view = projectBilliardsView(createTestProjectionContextV1(), placed.state, {
    kind: "player",
    seatId,
  });
  return billiardsViewSchema.parse(view);
}
