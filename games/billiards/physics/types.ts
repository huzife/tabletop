import type { BilliardsShot } from "../shared/actions.js";
import {
  BILLIARDS_SPIN_CONVERGENCE_DEFAULT,
  BILLIARDS_SPIN_CONVERGENCE_MAX,
  BILLIARDS_SPIN_CONVERGENCE_MIN,
  BILLIARDS_TABLE_FRICTION_DEFAULT,
  BILLIARDS_TABLE_FRICTION_MAX,
  BILLIARDS_TABLE_FRICTION_MIN,
  type BilliardsMode,
} from "../shared/settings.js";
import type { BilliardsTableSpec } from "../shared/table.js";
import type { BilliardsBall } from "../shared/view.js";

const BASE_ROLLING_DECELERATION = 0.16;
const BASE_SIDE_SPIN_DAMPING = 0.72;
const BASE_CUSHION_FRICTION = 0.12;
const BASE_CUSHION_TANGENTIAL_RESPONSE = 0.075;
const BASE_CUSHION_ROLL_DISTURBANCE = 0.28;
const CUSHION_RESTITUTION_FRICTION_RESPONSE = 0.08;

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
  /** Multiplies cloth friction only while planar spin converges to pure rolling. */
  readonly spinConvergence?: number;
  /**
   * The room's cloth-and-cushion friction coefficient. Omitted calls retain
   * the standard 0.20 table so historical replays remain deterministic.
   */
  readonly tableFriction?: number;
}

export interface PredictBilliardsTrajectoryInput {
  readonly balls: readonly BilliardsBall[];
  readonly maxFrames?: number;
  readonly mode: BilliardsMode;
  readonly shot: BilliardsShot;
  readonly spinConvergence?: number;
  readonly tableFriction?: number;
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

export interface BilliardsSurfaceParameters {
  readonly cushionFriction: number;
  readonly cushionRestitution: number;
  readonly cushionRollDisturbance: number;
  readonly cushionTangentialResponse: number;
  readonly rollingDeceleration: number;
  readonly sideSpinDamping: number;
  readonly slidingFriction: number;
  readonly spinConvergence: number;
}

/**
 * Preserves the existing room-setting mapping used by the UI and tests. The
 * Rust core applies the same coefficients during simulation.
 */
export function billiardsSurfaceParameters(
  table: Readonly<BilliardsTableSpec>,
  tableFriction = BILLIARDS_TABLE_FRICTION_DEFAULT,
  spinConvergence = BILLIARDS_SPIN_CONVERGENCE_DEFAULT,
): BilliardsSurfaceParameters {
  const slidingFriction = clamp(
    finiteOr(tableFriction, BILLIARDS_TABLE_FRICTION_DEFAULT),
    BILLIARDS_TABLE_FRICTION_MIN,
    BILLIARDS_TABLE_FRICTION_MAX,
  );
  const scale = slidingFriction / BILLIARDS_TABLE_FRICTION_DEFAULT;
  return {
    cushionFriction: BASE_CUSHION_FRICTION * scale,
    cushionRestitution: clamp(
      table.cushionRestitution + (1 - scale) * CUSHION_RESTITUTION_FRICTION_RESPONSE,
      0.7,
      0.9,
    ),
    cushionRollDisturbance: BASE_CUSHION_ROLL_DISTURBANCE * scale,
    cushionTangentialResponse: BASE_CUSHION_TANGENTIAL_RESPONSE * scale,
    rollingDeceleration: BASE_ROLLING_DECELERATION * scale,
    sideSpinDamping: BASE_SIDE_SPIN_DAMPING * scale,
    slidingFriction,
    spinConvergence: clamp(
      finiteOr(spinConvergence, BILLIARDS_SPIN_CONVERGENCE_DEFAULT),
      BILLIARDS_SPIN_CONVERGENCE_MIN,
      BILLIARDS_SPIN_CONVERGENCE_MAX,
    ),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}
