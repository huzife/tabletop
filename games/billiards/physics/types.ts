import type { BilliardsShot } from "../shared/actions.js";
import type { BilliardsMode } from "../shared/settings.js";
import type { BilliardsBall } from "../shared/view.js";

export type BilliardsMotionState =
  "airborne" | "pocketed" | "rolling" | "sliding" | "spinning" | "stationary";

export interface BilliardsSimulationBallFrame {
  readonly id: string;
  readonly pocketed: boolean;
  readonly rotation: number;
  readonly spinX: number;
  readonly spinY: number;
  readonly spinZ: number;
  readonly state: BilliardsMotionState;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BilliardsSimulationFrame {
  readonly atMs: number;
  readonly balls: readonly BilliardsSimulationBallFrame[];
}

export interface BilliardsSimulationEvent {
  readonly atSeconds: number;
  readonly ballIds: readonly string[];
  readonly geometryId?: string;
  readonly kind: string;
}

export interface BilliardsCueStrikeDiagnostics {
  readonly cueSpeed: number;
  readonly jumpSpeed: number;
  readonly miscue: boolean;
  readonly squirtRadians: number;
}

export interface ShotSimulationResult {
  readonly balls: readonly BilliardsBall[];
  readonly checksum: string;
  readonly cueBallPotted: boolean;
  readonly cueStrike: BilliardsCueStrikeDiagnostics;
  readonly durationMs: number;
  readonly events: readonly BilliardsSimulationEvent[];
  readonly firstContactBallId: string | null;
  readonly firstContactBallIds: readonly string[];
  readonly frames?: readonly BilliardsSimulationFrame[];
  readonly jumpedBallIds: readonly string[];
  readonly physicsVersion: string;
  readonly pocketedBallIds: readonly string[];
  readonly postContactRailBallIds: readonly string[];
  readonly railContactBallIds: readonly string[];
  readonly stateHash: string;
}

export interface SimulateBilliardsShotInput {
  readonly balls: readonly BilliardsBall[];
  readonly captureFrames?: boolean;
  readonly mode: BilliardsMode;
  readonly shot: BilliardsShot;
}

export interface PredictBilliardsTrajectoryInput {
  readonly balls: readonly BilliardsBall[];
  readonly maxFrames?: number;
  readonly mode: BilliardsMode;
  readonly shot: BilliardsShot;
}

/** @deprecated Use `PredictBilliardsTrajectoryInput`. */
export type PredictBilliardsShotInput = PredictBilliardsTrajectoryInput;

export interface BilliardsPredictedPathPoint {
  readonly atMs: number;
  readonly state: BilliardsMotionState;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BilliardsPredictedBallPath {
  readonly id: string;
  readonly points: readonly BilliardsPredictedPathPoint[];
}

export interface BilliardsTrajectoryPrediction {
  readonly checksum: string;
  readonly firstContactBallIds: readonly string[];
  readonly paths: readonly BilliardsPredictedBallPath[];
  readonly physicsVersion: string;
  readonly pocketedBallIds: readonly string[];
  readonly stateHash: string;
}

export interface BilliardsCoreInfo {
  readonly physicsVersion: string;
  readonly rulesVersion: string;
}
