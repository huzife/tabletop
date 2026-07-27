import type { BilliardsMode } from "./settings.js";

export interface TablePocketSpec {
  /** Stable geometry identifier shared with the native collision events. */
  readonly id: string;
  /** The nominal pocket position on the cushion-nose rectangle. */
  readonly x: number;
  readonly y: number;
  readonly kind: "corner" | "side";
  /** Clear opening measured at the cushion noses. */
  readonly mouthWidth: number;
  /** Authoritative point-of-no-return circle used by the simulator. */
  readonly captureX: number;
  readonly captureY: number;
  readonly captureRadius: number;
}

export interface TableLinearCushionSpec {
  readonly id: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface TableCircularCushionSpec {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface TableSpotSpec {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * A serialized projection of the native table geometry. The Rust core creates
 * this object from the same cushions and capture circles used by simulation.
 */
export interface BilliardsTableSpec {
  readonly mode: BilliardsMode;
  readonly width: number;
  readonly height: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly cushionWidth: number;
  readonly ballDiameter: number;
  readonly ballMass: number;
  readonly baulkLineX: number | null;
  readonly dRadius: number | null;
  readonly pockets: readonly TablePocketSpec[];
  readonly linearCushions: readonly TableLinearCushionSpec[];
  readonly circularCushions: readonly TableCircularCushionSpec[];
  readonly spots: readonly TableSpotSpec[];
}
