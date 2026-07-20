import { z } from "zod";

import { LUDO_COLORS_CLOCKWISE, type LudoColor } from "./types.js";

export const BOARD_SIZE = 15;
// The shared ring has 52 traversable cells, but each color leaves it after its 50th cell.
export const MAIN_RING_LENGTH = 52;
export const MAIN_PATH_LENGTH = 50;
export const HOME_PATH_LENGTH = 6;
export const FINISH_PROGRESS = 55;
export const FLIGHT_ENTRY_PATH_INDEX = 17;
export const FLIGHT_EXIT_PATH_INDEX = 29;
export const FLIGHT_CROSSING_HOME_PATH_INDEX = 2;
export const HOME_ENTRY_PATH_INDEX = 49;
export const JUMP_DISTANCE = 4;

export const START_OFFSETS: Readonly<Record<LudoColor, number>> = {
  red: 0,
  yellow: 13,
  green: 26,
  blue: 39,
};

export const FLIGHT_CROSSING_COLORS: Readonly<Record<LudoColor, LudoColor>> = {
  red: "green",
  yellow: "blue",
  green: "red",
  blue: "yellow",
};

// Index 0 is the first main-route step after the off-board apron. Same-color cells begin at
// index 1, so a plane leaving the apron with a roll of two lands on its own color.
export const JUMP_PATH_INDICES = Object.freeze(
  Array.from(
    { length: Math.ceil(MAIN_PATH_LENGTH / JUMP_DISTANCE) },
    (_, index) => index * JUMP_DISTANCE + 1,
  ),
);

export const boardCoordinateSchema = z.strictObject({
  x: z
    .number()
    .int()
    .min(0)
    .max(BOARD_SIZE - 1),
  y: z
    .number()
    .int()
    .min(0)
    .max(BOARD_SIZE - 1),
});
export type BoardCoordinate = z.infer<typeof boardCoordinateSchema>;

export const boardCellPresentationSchema = z.strictObject({
  cellId: z.string().min(1).max(64),
  region: z.enum(["BASE", "APRON", "MAIN_PATH", "TURN", "HOME_PATH", "FINISH"]),
  coordinate: boardCoordinateSchema,
  color: z.enum(["red", "yellow", "green", "blue"]).nullable(),
  pathIndex: z.number().int().nonnegative().nullable(),
  jumpColor: z.enum(["red", "yellow", "green", "blue"]).nullable(),
  flight: z.enum(["entry", "exit"]).nullable(),
  homeEntry: z.enum(["red", "yellow", "green", "blue"]).nullable(),
});
export type BoardCellPresentation = z.infer<typeof boardCellPresentationSchema>;

export const flightRoutePresentationSchema = z.strictObject({
  color: z.enum(["red", "yellow", "green", "blue"]),
  entryCellId: z.string().min(1).max(64),
  crossingCellId: z.string().min(1).max(64),
  exitCellId: z.string().min(1).max(64),
});
export type FlightRoutePresentation = z.infer<typeof flightRoutePresentationSchema>;

export const boardPresentationSchema = z.strictObject({
  size: z.literal(BOARD_SIZE),
  cells: z.array(boardCellPresentationSchema),
  flightRoutes: z.array(flightRoutePresentationSchema).length(4),
});
export type BoardPresentation = z.infer<typeof boardPresentationSchema>;

const PHYSICAL_RING_COORDINATES: readonly BoardCoordinate[] = [
  { x: 0, y: 4 },
  { x: 1, y: 4 },
  { x: 2, y: 4 },
  { x: 3, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 3 },
  { x: 4, y: 2 },
  { x: 4, y: 1 },
  { x: 4, y: 0 },
  { x: 5, y: 0 },
  { x: 6, y: 0 },
  { x: 7, y: 0 },
  { x: 8, y: 0 },
  { x: 9, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 1 },
  { x: 10, y: 2 },
  { x: 10, y: 3 },
  { x: 10, y: 4 },
  { x: 11, y: 4 },
  { x: 12, y: 4 },
  { x: 13, y: 4 },
  { x: 14, y: 4 },
  { x: 14, y: 5 },
  { x: 14, y: 6 },
  { x: 14, y: 7 },
  { x: 14, y: 8 },
  { x: 14, y: 9 },
  { x: 14, y: 10 },
  { x: 13, y: 10 },
  { x: 12, y: 10 },
  { x: 11, y: 10 },
  { x: 10, y: 10 },
  { x: 10, y: 11 },
  { x: 10, y: 12 },
  { x: 10, y: 13 },
  { x: 10, y: 14 },
  { x: 9, y: 14 },
  { x: 8, y: 14 },
  { x: 7, y: 14 },
  { x: 6, y: 14 },
  { x: 5, y: 14 },
  { x: 4, y: 14 },
  { x: 4, y: 13 },
  { x: 4, y: 12 },
  { x: 4, y: 11 },
  { x: 4, y: 10 },
  { x: 3, y: 10 },
  { x: 2, y: 10 },
  { x: 1, y: 10 },
  { x: 0, y: 10 },
  { x: 0, y: 9 },
  { x: 0, y: 8 },
  { x: 0, y: 7 },
  { x: 0, y: 6 },
  { x: 0, y: 5 },
];

// Zero-based physical positions for the non-traversable gray cells 5, 19, 33, and 47.
const TURN_PHYSICAL_INDICES = new Set([4, 18, 32, 46]);
const MAIN_COORDINATES: readonly BoardCoordinate[] = PHYSICAL_RING_COORDINATES.filter(
  (_, index) => !TURN_PHYSICAL_INDICES.has(index),
);
const TURN_COORDINATES: readonly BoardCoordinate[] = PHYSICAL_RING_COORDINATES.filter((_, index) =>
  TURN_PHYSICAL_INDICES.has(index),
);

const HOME_COORDINATES: Readonly<Record<LudoColor, readonly BoardCoordinate[]>> = {
  red: Array.from({ length: HOME_PATH_LENGTH }, (_, index) => ({ x: index + 1, y: 7 })),
  yellow: Array.from({ length: HOME_PATH_LENGTH }, (_, index) => ({ x: 7, y: index + 1 })),
  green: Array.from({ length: HOME_PATH_LENGTH }, (_, index) => ({ x: 13 - index, y: 7 })),
  blue: Array.from({ length: HOME_PATH_LENGTH }, (_, index) => ({ x: 7, y: 13 - index })),
};

const APRON_COORDINATES: Readonly<Record<LudoColor, BoardCoordinate>> = {
  red: { x: 0, y: 3 },
  yellow: { x: 11, y: 0 },
  green: { x: 14, y: 11 },
  blue: { x: 3, y: 14 },
};

const BASE_COORDINATES: Readonly<Record<LudoColor, readonly BoardCoordinate[]>> = {
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
};

function colorAtPathCell(globalIndex: number): LudoColor {
  return LUDO_COLORS_CLOCKWISE[(globalIndex + 3) % LUDO_COLORS_CLOCKWISE.length]!;
}

function jumpColorAtCell(globalIndex: number): LudoColor | null {
  for (const color of LUDO_COLORS_CLOCKWISE) {
    const relative = (globalIndex - START_OFFSETS[color] + MAIN_RING_LENGTH) % MAIN_RING_LENGTH;
    if (JUMP_PATH_INDICES.includes(relative) && relative + JUMP_DISTANCE < MAIN_PATH_LENGTH) {
      return color;
    }
  }
  return null;
}

function flightAtCell(globalIndex: number): "entry" | "exit" | null {
  for (const color of LUDO_COLORS_CLOCKWISE) {
    const relative = (globalIndex - START_OFFSETS[color] + MAIN_RING_LENGTH) % MAIN_RING_LENGTH;
    if (relative === FLIGHT_ENTRY_PATH_INDEX) return "entry";
  }
  return null;
}

function homeEntryAtCell(globalIndex: number): LudoColor | null {
  for (const color of LUDO_COLORS_CLOCKWISE) {
    const relative = (globalIndex - START_OFFSETS[color] + MAIN_RING_LENGTH) % MAIN_RING_LENGTH;
    if (relative === HOME_ENTRY_PATH_INDEX) return color;
  }
  return null;
}

function createBoardPresentation(): BoardPresentation {
  const cells: BoardCellPresentation[] = MAIN_COORDINATES.map((coordinate, index) => ({
    cellId: `main-${index}`,
    region: "MAIN_PATH",
    coordinate,
    color: colorAtPathCell(index),
    pathIndex: index,
    jumpColor: jumpColorAtCell(index),
    flight: flightAtCell(index),
    homeEntry: homeEntryAtCell(index),
  }));

  TURN_COORDINATES.forEach((coordinate, index) => {
    cells.push({
      cellId: `turn-${index}`,
      region: "TURN",
      coordinate,
      color: null,
      pathIndex: null,
      jumpColor: null,
      flight: null,
      homeEntry: null,
    });
  });

  for (const color of LUDO_COLORS_CLOCKWISE) {
    cells.push({
      cellId: `apron-${color}`,
      region: "APRON",
      coordinate: APRON_COORDINATES[color],
      color,
      pathIndex: null,
      jumpColor: null,
      flight: null,
      homeEntry: null,
    });
    BASE_COORDINATES[color].forEach((coordinate, index) => {
      cells.push({
        cellId: `base-${color}-${index + 1}`,
        region: "BASE",
        coordinate,
        color,
        pathIndex: index,
        jumpColor: null,
        flight: null,
        homeEntry: null,
      });
    });
    HOME_COORDINATES[color].forEach((coordinate, index) => {
      cells.push({
        cellId: `home-${color}-${index}`,
        region: index === HOME_PATH_LENGTH - 1 ? "FINISH" : "HOME_PATH",
        coordinate,
        color,
        pathIndex: index,
        jumpColor: null,
        flight: null,
        homeEntry: null,
      });
    });
  }

  const flightRoutes: FlightRoutePresentation[] = LUDO_COLORS_CLOCKWISE.map((color) => ({
    color,
    entryCellId: mainCellId(color, FLIGHT_ENTRY_PATH_INDEX),
    crossingCellId: flightCrossingCellId(color),
    exitCellId: mainCellId(color, FLIGHT_EXIT_PATH_INDEX),
  }));

  return boardPresentationSchema.parse({ size: BOARD_SIZE, cells, flightRoutes });
}

export const LUDO_BOARD_PRESENTATION = Object.freeze(createBoardPresentation());

export function globalMainIndex(color: LudoColor, pathIndex: number): number {
  return (START_OFFSETS[color] + pathIndex) % MAIN_RING_LENGTH;
}

export function mainCellId(color: LudoColor, pathIndex: number): string {
  return `main-${globalMainIndex(color, pathIndex)}`;
}

export function homeCellId(color: LudoColor, pathIndex: number): string {
  return `home-${color}-${pathIndex}`;
}

export function flightCrossingCellId(color: LudoColor): string {
  return homeCellId(FLIGHT_CROSSING_COLORS[color], FLIGHT_CROSSING_HOME_PATH_INDEX);
}
