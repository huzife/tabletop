import { act, cleanup, render } from "@testing-library/react";
import {
  LUDO_BOARD_PRESENTATION,
  LUDO_SEAT_IDS,
  type LudoDisplayStep,
  type LudoView,
} from "@tabletop/game-ludo";
import { LudoGameView } from "@tabletop/game-ludo/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emptyEvents: readonly LudoDisplayStep[] = [];
const movementEvents: readonly LudoDisplayStep[] = [
  {
    type: "move",
    direction: "forward",
    fromCellId: "main-0",
    planeId: "red-plane-1",
    toCellId: "main-1",
  },
];

describe("Ludo movement animation lifecycle", () => {
  let requestAnimationFrameMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", createMatchMediaStub());
    requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("moves one overlay, hides the authoritative plane, and does not replay one event batch", () => {
    const dispatchAction = vi.fn();
    const initialView = createView("main-0", 0, 30_000);
    const movedView = createView("main-1", 1, 29_000);
    const rendered = render(
      <LudoGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={dispatchAction}
        displayEvents={emptyEvents}
        readOnly={false}
        view={initialView}
      />,
    );

    expect(rendered.container.querySelector(".tt-ludo-animated-plane")).toBeNull();
    const board = requireElement<HTMLElement>(rendered.container, ".tt-ludo-board");
    expect(board.style.getPropertyValue("--ludo-board-size")).toBe("15");
    expect(rendered.container.querySelectorAll(".tt-ludo-cell.is-turn")).toHaveLength(4);
    expect(rendered.container.querySelectorAll(".tt-ludo-cell-flight")).toHaveLength(4);
    expect(rendered.container.querySelectorAll(".tt-ludo-cell-home-entry")).toHaveLength(4);
    expect(rendered.container.querySelectorAll(".tt-ludo-flight-route")).toHaveLength(4);
    expect(
      [...rendered.container.querySelectorAll(".tt-ludo-flight-crossing")].map((element) =>
        element.getAttribute("data-cell-id"),
      ),
    ).toEqual(["home-green-2", "home-blue-2", "home-red-2", "home-yellow-2"]);

    rendered.rerender(
      <LudoGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={dispatchAction}
        displayEvents={movementEvents}
        readOnly={false}
        view={movedView}
      />,
    );

    expect(rendered.container.querySelectorAll(".tt-ludo-animated-plane")).toHaveLength(1);
    expect(
      rendered.container.querySelectorAll(".tt-ludo-animation-layer .tt-ludo-plane"),
    ).toHaveLength(1);
    const sourceOverlay = requireElement<HTMLElement>(
      rendered.container,
      ".tt-ludo-animated-plane",
    );
    expect(sourceOverlay).not.toHaveClass("is-moving");
    expect(sourceOverlay.style.getPropertyValue("--ludo-x")).toBe(
      String(requireCell("main-0").coordinate.x),
    );
    expect(sourceOverlay.style.getPropertyValue("--ludo-y")).toBe(
      String(requireCell("main-0").coordinate.y),
    );

    const staticPlane = requireElement<HTMLButtonElement>(
      rendered.container,
      'button[aria-label="\u7ea2\u65b9 1 \u53f7\u98de\u673a"]',
    );
    expect(staticPlane).toHaveClass("is-animation-source");
    expect(staticPlane).toHaveAttribute("aria-hidden", "true");
    expect(staticPlane).toBeDisabled();

    act(() => vi.advanceTimersByTime(32));

    const movingOverlay = requireElement<HTMLElement>(
      rendered.container,
      ".tt-ludo-animated-plane",
    );
    expect(movingOverlay).toHaveClass("is-moving");
    expect(movingOverlay.style.getPropertyValue("--ludo-x")).toBe(
      String(requireCell("main-1").coordinate.x),
    );
    expect(movingOverlay.style.getPropertyValue("--ludo-y")).toBe(
      String(requireCell("main-1").coordinate.y),
    );
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);

    rendered.rerender(
      <LudoGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={dispatchAction}
        displayEvents={movementEvents}
        readOnly={false}
        view={{ ...movedView, deadlineRemainingMs: 28_000 }}
      />,
    );

    expect(rendered.container.querySelectorAll(".tt-ludo-animated-plane")).toHaveLength(1);
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(140));

    expect(rendered.container.querySelector(".tt-ludo-animated-plane")).toBeNull();
    const settledPlane = requireElement<HTMLButtonElement>(
      rendered.container,
      'button[aria-label="\u7ea2\u65b9 1 \u53f7\u98de\u673a"]',
    );
    expect(settledPlane).not.toHaveClass("is-animation-source");
    expect(settledPlane).not.toHaveAttribute("aria-hidden");

    rendered.rerender(
      <LudoGameView
        actionPending={false}
        connectionState="connected"
        dispatchAction={dispatchAction}
        displayEvents={movementEvents}
        readOnly={false}
        view={{ ...movedView, deadlineRemainingMs: 27_000 }}
      />,
    );

    expect(rendered.container.querySelector(".tt-ludo-animated-plane")).toBeNull();
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createView(cellId: "main-0" | "main-1", pathIndex: 0 | 1, deadline: number): LudoView {
  return {
    board: LUDO_BOARD_PRESENTATION,
    canRoll: false,
    canSelectPlane: true,
    currentSeatId: LUDO_SEAT_IDS.red,
    deadlineRemainingMs: deadline,
    lastSteps: [],
    legalPlaneIds: ["red-plane-1"],
    orderRolls: [],
    phase: "selecting_plane",
    phaseTimeSeconds: 30,
    planes: [
      {
        cellId,
        color: "red",
        number: 1,
        planeId: "red-plane-1",
        position: { pathIndex, region: "MAIN_PATH" },
        selectable: true,
      },
    ],
    rankings: [],
    roll: 1,
    seatOrder: [LUDO_SEAT_IDS.red],
    seats: [
      {
        active: true,
        color: "red",
        controller: "human",
        finishedPlanes: 0,
        rank: null,
        reclaimable: false,
        seatId: LUDO_SEAT_IDS.red,
      },
    ],
    sixStreak: 0,
    viewerController: "human",
    viewerSeatId: LUDO_SEAT_IDS.red,
  };
}

function createMatchMediaStub() {
  return vi.fn(
    (query: string) =>
      ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

function requireCell(cellId: string) {
  const cell = LUDO_BOARD_PRESENTATION.cells.find((candidate) => candidate.cellId === cellId);
  if (cell === undefined) throw new Error(`Missing Ludo board cell ${cellId}`);
  return cell;
}

function requireElement<T extends Element>(container: HTMLElement, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing element ${selector}`);
  return element;
}
