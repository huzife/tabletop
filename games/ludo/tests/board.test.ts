import { describe, expect, it } from "vitest";

import {
  BOARD_SIZE,
  FLIGHT_CROSSING_COLORS,
  FLIGHT_CROSSING_HOME_PATH_INDEX,
  FLIGHT_ENTRY_PATH_INDEX,
  FLIGHT_EXIT_PATH_INDEX,
  globalMainIndex,
  HOME_ENTRY_PATH_INDEX,
  LUDO_BOARD_PRESENTATION,
  LUDO_COLORS_CLOCKWISE,
  MAIN_PATH_LENGTH,
  MAIN_RING_LENGTH,
} from "../shared/index.js";
import { cellIdForProgress, positionFromProgress, progressFromPosition } from "../server/index.js";

const PHYSICAL_COLORS = [
  "blue",
  "red",
  "yellow",
  "green",
  null,
  "blue",
  "red",
  "yellow",
  "green",
  "blue",
  "red",
  "yellow",
  "green",
  "blue",
  "red",
  "yellow",
  "green",
  "blue",
  null,
  "red",
  "yellow",
  "green",
  "blue",
  "red",
  "yellow",
  "green",
  "blue",
  "red",
  "yellow",
  "green",
  "blue",
  "red",
  null,
  "yellow",
  "green",
  "blue",
  "red",
  "yellow",
  "green",
  "blue",
  "red",
  "yellow",
  "green",
  "blue",
  "red",
  "yellow",
  null,
  "green",
  "blue",
  "red",
  "yellow",
  "green",
  "blue",
  "red",
  "yellow",
  "green",
] as const;

const BASE_COORDINATES = {
  red: [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
  ],
  yellow: [
    { x: 12, y: 1 },
    { x: 13, y: 1 },
    { x: 12, y: 2 },
    { x: 13, y: 2 },
  ],
  green: [
    { x: 12, y: 12 },
    { x: 13, y: 12 },
    { x: 12, y: 13 },
    { x: 13, y: 13 },
  ],
  blue: [
    { x: 1, y: 12 },
    { x: 2, y: 12 },
    { x: 1, y: 13 },
    { x: 2, y: 13 },
  ],
} as const;

const APRON_COORDINATES = {
  red: { x: 0, y: 3 },
  yellow: { x: 11, y: 0 },
  green: { x: 14, y: 11 },
  blue: { x: 3, y: 14 },
} as const;

describe("ludo board topology", () => {
  it("defines the requested 56-position physical ring", () => {
    expect(LUDO_BOARD_PRESENTATION.size).toBe(BOARD_SIZE);
    expect(BOARD_SIZE).toBe(15);
    expect(MAIN_RING_LENGTH).toBe(52);
    expect(MAIN_PATH_LENGTH).toBe(50);

    const ring = LUDO_BOARD_PRESENTATION.cells.filter(
      (cell) => cell.region === "MAIN_PATH" || cell.region === "TURN",
    );
    expect(ring).toHaveLength(56);
    expect(new Set(ring.map((cell) => `${cell.coordinate.x},${cell.coordinate.y}`))).toHaveLength(
      56,
    );

    const physical = [...ring].sort((left, right) => physicalIndex(left) - physicalIndex(right));
    expect(physical.map((cell) => cell.color)).toEqual(PHYSICAL_COLORS);
    expect(physical.map((cell) => (cell.region === "TURN" ? "turn" : "path"))).toEqual(
      PHYSICAL_COLORS.map((color) => (color === null ? "turn" : "path")),
    );
  });

  it("assigns every rendered board cell a unique coordinate", () => {
    const coordinates = LUDO_BOARD_PRESENTATION.cells.map(
      (cell) => `${cell.coordinate.x},${cell.coordinate.y}`,
    );
    expect(new Set(coordinates)).toHaveLength(coordinates.length);
  });

  it("uses compact symmetric bases and places every apron beside its first route cell", () => {
    for (const color of LUDO_COLORS_CLOCKWISE) {
      const bases = LUDO_BOARD_PRESENTATION.cells.filter((cell) =>
        cell.cellId.startsWith(`base-${color}`),
      );
      const apron = requireCell(`apron-${color}`);
      const firstRouteCell = requireCell(cellIdForProgress(color, 0));

      expect(bases.map((cell) => cell.coordinate)).toEqual(BASE_COORDINATES[color]);
      expect(apron.coordinate).toEqual(APRON_COORDINATES[color]);
      expect(
        Math.abs(apron.coordinate.x - firstRouteCell.coordinate.x) +
          Math.abs(apron.coordinate.y - firstRouteCell.coordinate.y),
      ).toBe(1);
    }
  });

  it("marks the four flight cells and four home-entry cells by physical number", () => {
    expect(markedPhysicalNumbers("flight", "entry")).toEqual([6, 20, 34, 48]);
    expect(markedPhysicalNumbers("homeEntry")).toEqual([12, 26, 40, 54]);

    expect(requirePhysicalCell(6)).toMatchObject({ color: "blue", flight: "entry" });
    expect(requirePhysicalCell(20)).toMatchObject({ color: "red", flight: "entry" });
    expect(requirePhysicalCell(34)).toMatchObject({ color: "yellow", flight: "entry" });
    expect(requirePhysicalCell(48)).toMatchObject({ color: "green", flight: "entry" });
    expect(requirePhysicalCell(12)).toMatchObject({ color: "yellow", homeEntry: "yellow" });
    expect(requirePhysicalCell(26)).toMatchObject({ color: "green", homeEntry: "green" });
    expect(requirePhysicalCell(40)).toMatchObject({ color: "blue", homeEntry: "blue" });
    expect(requirePhysicalCell(54)).toMatchObject({ color: "red", homeEntry: "red" });
  });

  it("skips the gray turn cell when red enters the public route", () => {
    const firstFiveSteps = Array.from({ length: 5 }, (_, progress) =>
      requireCell(cellIdForProgress("red", progress)),
    );

    expect(firstFiveSteps.map(physicalIndex)).toEqual([1, 2, 3, 4, 6]);
    expect(firstFiveSteps.at(-1)).toMatchObject({ color: "blue", flight: "entry" });
  });

  it("maps every color route onto the shared ring and its private finish lane", () => {
    expect(globalMainIndex("red", 0)).toBe(0);
    expect(globalMainIndex("yellow", 0)).toBe(13);
    expect(globalMainIndex("green", 0)).toBe(26);
    expect(globalMainIndex("blue", 0)).toBe(39);
    expect(cellIdForProgress("red", -1)).toBe("apron-red");
    expect(cellIdForProgress("red", 55)).toBe("home-red-5");

    for (const progress of [-1, 0, 49, 50, 54, 55]) {
      expect(progressFromPosition(positionFromProgress(progress))).toBe(progress);
    }

    for (const color of LUDO_COLORS_CLOCKWISE) {
      expect(
        LUDO_BOARD_PRESENTATION.cells.filter((cell) => cell.cellId.startsWith(`base-${color}`)),
      ).toHaveLength(4);
      expect(
        LUDO_BOARD_PRESENTATION.cells.filter((cell) => cell.cellId.startsWith(`home-${color}`)),
      ).toHaveLength(6);
    }
  });

  it("keeps logical flight endpoints and home entry on their own colored cells", () => {
    for (const color of LUDO_COLORS_CLOCKWISE) {
      const entry = requireCell(cellIdForProgress(color, FLIGHT_ENTRY_PATH_INDEX));
      const exit = requireCell(cellIdForProgress(color, FLIGHT_EXIT_PATH_INDEX));
      const homeEntry = requireCell(cellIdForProgress(color, HOME_ENTRY_PATH_INDEX));

      expect(entry).toMatchObject({ color, flight: "entry", jumpColor: color });
      expect(exit).toMatchObject({ color, flight: null, jumpColor: color });
      expect(homeEntry).toMatchObject({ color, homeEntry: color });
    }
  });

  it("routes every flight through the opposite home lane's third cell", () => {
    for (const route of LUDO_BOARD_PRESENTATION.flightRoutes) {
      const crossingColor = FLIGHT_CROSSING_COLORS[route.color];
      expect(route).toEqual({
        color: route.color,
        entryCellId: cellIdForProgress(route.color, FLIGHT_ENTRY_PATH_INDEX),
        crossingCellId: `home-${crossingColor}-${FLIGHT_CROSSING_HOME_PATH_INDEX}`,
        exitCellId: cellIdForProgress(route.color, FLIGHT_EXIT_PATH_INDEX),
      });
      expect(requireCell(route.crossingCellId)).toMatchObject({
        color: crossingColor,
        region: "HOME_PATH",
        pathIndex: FLIGHT_CROSSING_HOME_PATH_INDEX,
      });
    }
  });
});

function requireCell(cellId: string) {
  const cell = LUDO_BOARD_PRESENTATION.cells.find((candidate) => candidate.cellId === cellId);
  if (cell === undefined) throw new Error(`missing board cell: ${cellId}`);
  return cell;
}

function requirePhysicalCell(number: number) {
  const cell = LUDO_BOARD_PRESENTATION.cells.find(
    (candidate) =>
      (candidate.region === "MAIN_PATH" || candidate.region === "TURN") &&
      physicalIndex(candidate) === number,
  );
  if (cell === undefined) throw new Error(`missing physical cell: ${number}`);
  return cell;
}

function markedPhysicalNumbers(property: "flight" | "homeEntry", value?: "entry"): number[] {
  return LUDO_BOARD_PRESENTATION.cells
    .filter((cell) => (property === "flight" ? cell.flight === value : cell.homeEntry !== null))
    .map(physicalIndex)
    .sort((left, right) => left - right);
}

function physicalIndex(cell: {
  readonly coordinate: { readonly x: number; readonly y: number };
}): number {
  const { x, y } = cell.coordinate;
  if (y === 4 && x <= 4) return x + 1;
  if (x === 4 && y < 4) return 9 - y;
  if (y === 0 && x >= 5) return x + 5;
  if (x === 10 && y > 0 && y <= 4) return y + 15;
  if (y === 4 && x > 10) return x + 9;
  if (x === 14 && y > 4) return y + 19;
  if (y === 10 && x < 14 && x >= 10) return 43 - x;
  if (x === 10 && y > 10) return y + 23;
  if (y === 14 && x < 10 && x >= 4) return 47 - x;
  if (x === 4 && y < 14 && y >= 10) return 57 - y;
  if (y === 10 && x < 4) return 51 - x;
  if (x === 0 && y < 10 && y >= 5) return 61 - y;
  throw new Error(`coordinate is not on the physical ring: ${x},${y}`);
}
