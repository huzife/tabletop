import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { seatIdSchema } from "@tabletop/protocol";
import {
  billiardsSettings,
  billiardsViewSchema,
  type BilliardsView,
} from "@tabletop/game-billiards";
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

  it("shows the opponent's live direction, cue tip, power and elevation", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { activeSeatId, view } = competitiveView("seat-2");

    render(
      <BilliardsGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={vi.fn()}
        displayEvents={[]}
        readOnly={false}
        transientEvent={{
          event: {
            angle: Math.PI / 3,
            elevation: 18,
            power: 72,
            shotNumber: view.shotNumber,
            tip: { x: 0.35, y: -0.2 },
            type: "billiards.aim-preview",
          },
          senderSeatId: activeSeatId,
          serverTime: "2026-01-01T00:00:00.000Z",
        }}
        view={view}
      />,
    );

    expect(screen.getByRole("region", { name: "对手击球参数" })).toBeInTheDocument();
    expect(screen.getByText("对手正在瞄准")).toBeInTheDocument();
    expect(screen.getByText("方向 60°")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getByText("18°")).toBeInTheDocument();
    expect(screen.getByRole("application", { name: /右塞，低杆/ })).toBeDisabled();
  });

  it("publishes the active player's initial aim preview", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const publish = vi.fn();
    const { view } = competitiveView("seat-1");

    render(
      <BilliardsGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={vi.fn()}
        dispatchTransientEvent={publish}
        displayEvents={[]}
        readOnly={false}
        view={view}
      />,
    );

    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          elevation: 0,
          power: 58,
          shotNumber: view.shotNumber,
          tip: { x: 0, y: 0 },
          type: "billiards.aim-preview",
        }),
      ),
    );
  });

  it("broadcasts reset controls as the first preview of a new shot", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const publish = vi.fn();
    const { view } = competitiveView("seat-1");
    const rendered = render(
      <BilliardsGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={vi.fn()}
        dispatchTransientEvent={publish}
        displayEvents={[]}
        readOnly={false}
        view={view}
      />,
    );

    await waitFor(() => expect(publish).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("slider", { name: "力度" }), { target: { value: "84" } });
    await waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ power: 84 })),
    );
    publish.mockClear();

    rendered.rerender(
      <BilliardsGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={vi.fn()}
        dispatchTransientEvent={publish}
        displayEvents={[]}
        readOnly={false}
        view={{ ...view, shotNumber: view.shotNumber + 1 }}
      />,
    );

    await waitFor(() => expect(publish).toHaveBeenCalled());
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      elevation: 0,
      power: 58,
      shotNumber: view.shotNumber + 1,
      tip: { x: 0, y: 0 },
      type: "billiards.aim-preview",
    });
  });
});

function competitiveView(viewerSeat: "seat-1" | "seat-2") {
  const firstSeat = seatIdSchema.parse("seat-1");
  const secondSeat = seatIdSchema.parse("seat-2");
  const initial = createBilliardsMatch(
    createTestCreateMatchContextV1({
      seats: [
        { controller: { kind: "human" }, seatId: firstSeat },
        { controller: { kind: "human" }, seatId: secondSeat },
      ],
    }),
    billiardsSettings.defaultValue,
  );
  const cue = initial.balls.find(({ kind }) => kind === "cue");
  if (!cue) throw new Error("competitive fixture is missing its cue ball");
  const placed = handleBilliardsAction(
    createTestActionContextV1({ actor: { kind: "human", seatId: firstSeat } }),
    initial,
    { type: "billiards.place-cue", x: cue.x, y: cue.y },
  );
  const view = billiardsViewSchema.parse(
    projectBilliardsView(createTestProjectionContextV1(), placed.state, {
      kind: "player",
      seatId: seatIdSchema.parse(viewerSeat),
    }),
  );
  return { activeSeatId: firstSeat, view };
}

function practiceView(): BilliardsView {
  const seatId = seatIdSchema.parse("seat-1");
  const initial = createBilliardsMatch(
    createTestCreateMatchContextV1({
      seats: [{ controller: { kind: "human" }, seatId }],
    }),
    { ...billiardsSettings.defaultValue, mode: "snooker" },
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
