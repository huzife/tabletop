import {
  Body,
  Circle,
  ContactMaterial,
  GSSolver,
  Material,
  NaiveBroadphase,
  Plane,
  World,
} from "p2-es";

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
import { tableSpecFor, type BilliardsTableSpec } from "../shared/table.js";
import type { BilliardsBall } from "../shared/view.js";

const FIXED_STEP_SECONDS = 1 / 240;
const FRAME_STEP_INTERVAL = 4;
const MAX_STEPS = 4_800;
const MIN_REST_STEPS = 12;
const GRAVITY = 9.81;
const BASE_ROLLING_DECELERATION = 0.16;
const BASE_SIDE_SPIN_DAMPING = 0.72;
const BASE_CUSHION_FRICTION = 0.12;
const BASE_CUSHION_TANGENTIAL_RESPONSE = 0.075;
const BASE_CUSHION_ROLL_DISTURBANCE = 0.28;
const CUSHION_RESTITUTION_FRICTION_RESPONSE = 0.08;
const STOP_SPEED = 0.012;
const STOP_SURFACE_SPIN_SPEED = 0.012;
const POCKET_CAPTURE_HEIGHT_FACTOR = 0.35;
const CUSHION_NOSE_HEIGHT_FACTOR = 0.65;
const INTERNAL_QUANTUM = 1e-10;
const OUTPUT_QUANTUM = 1e-6;
const BALL_COLLISION_GROUP = 1;
const RAIL_COLLISION_GROUP = 2;

export interface BilliardsSimulationBallFrame {
  readonly id: string;
  readonly pocketed: boolean;
  readonly rotation: number;
  readonly spinX: number;
  readonly spinY: number;
  readonly spinZ: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BilliardsSimulationFrame {
  readonly atMs: number;
  readonly balls: readonly BilliardsSimulationBallFrame[];
}

export interface ShotSimulationResult {
  readonly balls: readonly BilliardsBall[];
  readonly checksum: string;
  readonly cueBallPotted: boolean;
  readonly durationMs: number;
  readonly firstContactBallId: string | null;
  readonly firstContactBallIds: readonly string[];
  readonly frames?: readonly BilliardsSimulationFrame[];
  readonly jumpedBallIds: readonly string[];
  readonly pocketedBallIds: readonly string[];
  readonly postContactRailBallIds: readonly string[];
  readonly railContactBallIds: readonly string[];
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

interface ActiveBallState {
  readonly body: Body;
  readonly initial: BilliardsBall;
  readonly shape: Circle;
  pocketed: boolean;
  rotation: number;
  spinX: number;
  spinY: number;
  vz: number;
  z: number;
}

interface Rail {
  readonly normalX: number;
  readonly normalY: number;
}

interface RailEffect {
  readonly ball: ActiveBallState;
  readonly rail: Rail;
}

interface JumpCrossing {
  readonly approachX: number;
  readonly approachY: number;
}

interface ShotContext {
  readonly elevationFactor: number;
  readonly radius: number;
  readonly sideCurveFactor: number;
}

/**
 * Converts the single room setting into the coefficients used by the 2.5D
 * simulator. At the standard 0.20 setting every value is the legacy value.
 * Increasing friction shortens rolling travel, accelerates slip-to-roll transfer,
 * damps english sooner, increases cushion grip, and makes rebounds modestly deader.
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

function quantize(value: number, quantum = OUTPUT_QUANTUM): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const rounded = Math.round(value / quantum) * quantum;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const turn = Math.PI * 2;
  const normalized = ((((value + Math.PI) % turn) + turn) % turn) - Math.PI;
  return quantize(normalized);
}

function bodyX(body: Body): number {
  return finiteOr(body.position[0], 0);
}

function bodyY(body: Body): number {
  return finiteOr(body.position[1], 0);
}

function velocityX(body: Body): number {
  return finiteOr(body.velocity[0], 0);
}

function velocityY(body: Body): number {
  return finiteOr(body.velocity[1], 0);
}

function setBodyPosition(body: Body, x: number, y: number): void {
  body.position[0] = x;
  body.position[1] = y;
  body.aabbNeedsUpdate = true;
}

function setBodyVelocity(body: Body, x: number, y: number): void {
  body.velocity[0] = x;
  body.velocity[1] = y;
}

function addRail(
  world: World,
  material: Material,
  railsByBody: Map<Body, Rail>,
  x: number,
  y: number,
  angle: number,
  normalX: number,
  normalY: number,
): void {
  const body = new Body({ mass: 0, position: [x, y] });
  body.addShape(
    new Plane({
      collisionGroup: RAIL_COLLISION_GROUP,
      collisionMask: BALL_COLLISION_GROUP,
      material,
    }),
    undefined,
    angle,
  );
  world.addBody(body);
  railsByBody.set(body, { normalX, normalY });
}

function createWorld(
  table: BilliardsTableSpec,
  surface: Readonly<BilliardsSurfaceParameters>,
): {
  readonly ballMaterial: Material;
  readonly railsByBody: Map<Body, Rail>;
  readonly world: World;
} {
  const solver = new GSSolver({ frictionIterations: 8, iterations: 18, tolerance: 1e-9 });
  const world = new World({
    broadphase: new NaiveBroadphase(),
    gravity: [0, 0],
    islandSplit: false,
    solver,
  });
  world.applyDamping = false;
  world.frictionGravity = GRAVITY;
  world.sleepMode = World.NO_SLEEPING;

  const ballMaterial = new Material();
  const railMaterial = new Material();
  world.addContactMaterial(
    new ContactMaterial(ballMaterial, ballMaterial, {
      friction: 0.035,
      relaxation: 3,
      restitution: 0.94,
      stiffness: 1e8,
    }),
  );
  world.addContactMaterial(
    new ContactMaterial(ballMaterial, railMaterial, {
      friction: surface.cushionFriction,
      relaxation: 3,
      restitution: surface.cushionRestitution,
      stiffness: 1e8,
    }),
  );

  const railsByBody = new Map<Body, Rail>();
  addRail(world, railMaterial, railsByBody, 0, 0, -Math.PI / 2, 1, 0);
  addRail(world, railMaterial, railsByBody, table.width, 0, Math.PI / 2, -1, 0);
  addRail(world, railMaterial, railsByBody, 0, 0, 0, 0, 1);
  addRail(world, railMaterial, railsByBody, 0, table.height, Math.PI, 0, -1);

  return { ballMaterial, railsByBody, world };
}

function createActiveBalls(
  balls: readonly BilliardsBall[],
  table: BilliardsTableSpec,
  world: World,
  ballMaterial: Material,
): {
  readonly active: ActiveBallState[];
  readonly byBody: Map<Body, ActiveBallState>;
  readonly byId: Map<string, ActiveBallState>;
} {
  const radius = table.ballDiameter / 2;
  const active: ActiveBallState[] = [];
  const byBody = new Map<Body, ActiveBallState>();
  const byId = new Map<string, ActiveBallState>();

  for (const ball of balls) {
    if (ball.pocketed) {
      continue;
    }

    const x = clamp(finiteOr(ball.x, table.width / 2), radius, table.width - radius);
    const y = clamp(finiteOr(ball.y, table.height / 2), radius, table.height - radius);
    const body = new Body({
      allowSleep: false,
      angularDamping: 0,
      ccdIterations: 12,
      ccdSpeedThreshold: 0.4,
      damping: 0,
      mass: table.ballMass,
      position: [x, y],
    });
    const shape = new Circle({
      collisionGroup: BALL_COLLISION_GROUP,
      collisionMask: BALL_COLLISION_GROUP | RAIL_COLLISION_GROUP,
      material: ballMaterial,
      radius,
    });
    body.addShape(shape);
    world.addBody(body);

    const state: ActiveBallState = {
      body,
      initial: ball,
      pocketed: false,
      rotation: finiteOr(ball.rotation, 0),
      shape,
      spinX: 0,
      spinY: 0,
      vz: 0,
      z: 0,
    };
    active.push(state);
    byBody.set(body, state);
    byId.set(ball.id, state);
  }

  return { active, byBody, byId };
}

function applyCueImpulse(
  cue: ActiveBallState | undefined,
  shot: BilliardsShot,
  radius: number,
): ShotContext {
  const elevation = (clamp(finiteOr(shot.elevation, 0), 0, 90) * Math.PI) / 180;
  const elevationFactor = Math.sin(elevation);
  const planarFactor = Math.pow(Math.max(0, Math.cos(elevation)), 0.55);
  const power = clamp(finiteOr(shot.power, 1), 1, 100) / 100;
  const cueSpeed = 0.12 + 7.08 * Math.pow(power, 1.2);
  const planarSpeed = cueSpeed * planarFactor;
  const angle = clamp(finiteOr(shot.angle, 0), -Math.PI, Math.PI);
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  const normalX = -directionY;
  const normalY = directionX;
  const tipX = clamp(finiteOr(shot.tip.x, 0), -0.95, 0.95);
  const tipY = clamp(finiteOr(shot.tip.y, 0), -0.95, 0.95);

  if (cue !== undefined) {
    setBodyVelocity(cue.body, directionX * planarSpeed, directionY * planarSpeed);

    // A centre-ball strike starts mostly sliding. Vertical tip displacement supplies
    // forward or backward horizontal-axis spin, then cloth friction converges it to roll.
    const longitudinalSpin = (tipY * planarSpeed * 2.35) / radius;
    cue.spinX = normalX * longitudinalSpin;
    cue.spinY = normalY * longitudinalSpin;

    // Side tip displacement rotates around the table normal. Elevation strengthens masse.
    cue.body.angularVelocity = (-tipX * planarSpeed * (3.4 + elevationFactor * 1.6)) / radius;

    // A legal jump is produced by driving down through the upper half of the
    // cue ball. Lower-face contact must not create the inverse "scoop" jump.
    const jumpTipFactor = clamp(0.45 + tipY * 0.55, 0, 1);
    cue.vz = clamp(cueSpeed * elevationFactor * jumpTipFactor, 0, 2.2);
  }

  return {
    elevationFactor,
    radius,
    sideCurveFactor: 0.045 + 0.5 * Math.pow(elevationFactor, 1.6),
  };
}

function applyClothAndSpin(
  state: ActiveBallState,
  context: ShotContext,
  surface: Readonly<BilliardsSurfaceParameters>,
): void {
  const body = state.body;
  const radius = context.radius;
  let vx = velocityX(body);
  let vy = velocityY(body);
  const airborneFactor = state.z > 0 ? 0.08 : 1;

  const slipX = vx - radius * state.spinY;
  const slipY = vy + radius * state.spinX;
  const slipSpeed = Math.hypot(slipX, slipY);

  if (slipSpeed > 0.002 && airborneFactor > 0.1) {
    const maximumVelocityChange =
      surface.slidingFriction * surface.spinConvergence * GRAVITY * FIXED_STEP_SECONDS;
    const velocityChange = Math.min(maximumVelocityChange, slipSpeed / 3.5);
    const deltaVx = (-slipX / slipSpeed) * velocityChange;
    const deltaVy = (-slipY / slipSpeed) * velocityChange;
    vx += deltaVx;
    vy += deltaVy;
    state.spinX += (2.5 * deltaVy) / radius;
    state.spinY -= (2.5 * deltaVx) / radius;
  } else if (airborneFactor > 0.1) {
    const speed = Math.hypot(vx, vy);
    if (speed > 0) {
      const nextSpeed = Math.max(0, speed - surface.rollingDeceleration * FIXED_STEP_SECONDS);
      const scale = nextSpeed / speed;
      vx *= scale;
      vy *= scale;
      state.spinX = -vy / radius;
      state.spinY = vx / radius;
    }
  }

  const speed = Math.hypot(vx, vy);
  const spinZ = finiteOr(body.angularVelocity, 0);
  if (speed > 0.01 && Math.abs(spinZ) > 0.01) {
    const perpendicularX = -vy / speed;
    const perpendicularY = vx / speed;
    const sideSurfaceSpeed = spinZ * radius;
    const curveAcceleration = clamp(
      sideSurfaceSpeed * context.sideCurveFactor * (state.z > 0 ? 0.15 : 1),
      -3.2,
      3.2,
    );
    vx += perpendicularX * curveAcceleration * FIXED_STEP_SECONDS;
    vy += perpendicularY * curveAcceleration * FIXED_STEP_SECONDS;
  }

  setBodyVelocity(body, vx, vy);
  body.angularVelocity = spinZ * Math.exp(-surface.sideSpinDamping * FIXED_STEP_SECONDS);

  const rollingAxisRate =
    speed > 0 ? (-state.spinX * vy + state.spinY * vx) / Math.max(speed, Number.EPSILON) : 0;
  state.rotation += (rollingAxisRate + body.angularVelocity * 0.14) * FIXED_STEP_SECONDS;
}

function integrateVerticalMotion(state: ActiveBallState, maximumHeight: number): void {
  if (state.z <= 0 && state.vz <= 0) {
    state.z = 0;
    state.vz = 0;
    return;
  }

  state.vz -= GRAVITY * FIXED_STEP_SECONDS;
  state.z += state.vz * FIXED_STEP_SECONDS;
  if (state.z > maximumHeight) {
    state.z = maximumHeight;
    state.vz = Math.min(0, state.vz);
  }
  if (state.z <= 0) {
    state.z = 0;
    if (state.vz < -0.45) {
      state.vz = -state.vz * 0.12;
    } else {
      state.vz = 0;
    }
  }
}

function updateProjectedCollisionMask(state: ActiveBallState, table: BilliardsTableSpec): void {
  // Once the bottom of the airborne sphere clears a full ball diameter, omit
  // ball pairs from the 2D broadphase as well as the solver. This prevents P2's
  // CCD pass from stopping a jump at the target's projected silhouette.
  state.shape.collisionMask =
    RAIL_COLLISION_GROUP | (state.z < table.ballDiameter ? BALL_COLLISION_GROUP : 0);
}

function applyRailSpin(
  effect: RailEffect,
  radius: number,
  surface: Readonly<BilliardsSurfaceParameters>,
): void {
  const { body } = effect.ball;
  if (effect.ball.pocketed) {
    return;
  }

  const tangentX = -effect.rail.normalY;
  const tangentY = effect.rail.normalX;
  const vx = velocityX(body);
  const vy = velocityY(body);
  const tangentialSpeed = vx * tangentX + vy * tangentY;
  const spinZ = finiteOr(body.angularVelocity, 0);
  const relativeSurfaceSpeed = tangentialSpeed - spinZ * radius;
  const tangentialChange = clamp(
    -relativeSurfaceSpeed * surface.cushionTangentialResponse,
    -0.42,
    0.42,
  );

  setBodyVelocity(body, vx + tangentX * tangentialChange, vy + tangentY * tangentialChange);
  body.angularVelocity = spinZ - (2.5 * tangentialChange) / radius;

  // Cushion compression also disturbs the horizontal rolling axis. This creates the
  // expected running/check side response without making successive rails gain energy.
  const inwardRoll =
    effect.ball.spinX * effect.rail.normalX + effect.ball.spinY * effect.rail.normalY;
  effect.ball.spinX -= effect.rail.normalX * inwardRoll * surface.cushionRollDisturbance;
  effect.ball.spinY -= effect.rail.normalY * inwardRoll * surface.cushionRollDisturbance;
}

function findPocket(
  state: ActiveBallState,
  table: BilliardsTableSpec,
): BilliardsTableSpec["pockets"][number] | undefined {
  const radius = table.ballDiameter / 2;
  if (state.z > radius * POCKET_CAPTURE_HEIGHT_FACTOR) {
    return undefined;
  }

  const x = bodyX(state.body);
  const y = bodyY(state.body);
  return table.pockets.find((pocket) => {
    const dx = x - pocket.x;
    const dy = y - pocket.y;
    return dx * dx + dy * dy <= pocket.captureRadius * pocket.captureRadius;
  });
}

function capturePocketedBalls(
  active: readonly ActiveBallState[],
  table: BilliardsTableSpec,
  world: World,
  pocketedBallIds: string[],
): void {
  for (const state of active) {
    if (state.pocketed) {
      continue;
    }

    const pocket = findPocket(state, table);
    if (pocket === undefined) {
      continue;
    }

    state.pocketed = true;
    state.z = 0;
    state.vz = 0;
    state.spinX = 0;
    state.spinY = 0;
    state.body.angularVelocity = 0;
    setBodyPosition(state.body, pocket.x, pocket.y);
    setBodyVelocity(state.body, 0, 0);
    world.removeBody(state.body);
    pocketedBallIds.push(state.initial.id);
  }
}

function recordJumpedBalls(
  cue: ActiveBallState | undefined,
  active: readonly ActiveBallState[],
  table: BilliardsTableSpec,
  contactedBallIds: ReadonlySet<string>,
  crossings: Map<string, JumpCrossing>,
  jumped: Set<string>,
): void {
  if (cue === undefined || cue.pocketed || cue.z <= 0) {
    crossings.clear();
    return;
  }
  const diameterSquared = table.ballDiameter * table.ballDiameter;
  for (const target of active) {
    if (target === cue || target.pocketed || contactedBallIds.has(target.initial.id)) {
      crossings.delete(target.initial.id);
      continue;
    }
    const dx = bodyX(cue.body) - bodyX(target.body);
    const dy = bodyY(cue.body) - bodyY(target.body);
    const projectedDistanceSquared = dx * dx + dy * dy;
    if (projectedDistanceSquared >= diameterSquared || cue.z <= target.z) {
      crossings.delete(target.initial.id);
      continue;
    }

    let crossing = crossings.get(target.initial.id);
    if (crossing === undefined) {
      const projectedDistance = Math.sqrt(projectedDistanceSquared);
      if (projectedDistance <= Number.EPSILON) continue;
      crossing = {
        approachX: -dx / projectedDistance,
        approachY: -dy / projectedDistance,
      };
      crossings.set(target.initial.id, crossing);
    }

    const reachedFarSide = dx * crossing.approachX + dy * crossing.approachY >= 0;
    const dz = cue.z - target.z;
    const physicallySeparated =
      projectedDistanceSquared + dz * dz > diameterSquared + INTERNAL_QUANTUM;
    if (reachedFarSide && physicallySeparated) {
      jumped.add(target.initial.id);
      crossings.delete(target.initial.id);
    }
  }
}

function sanitizeState(state: ActiveBallState, table: BilliardsTableSpec): void {
  if (state.pocketed) {
    return;
  }

  const radius = table.ballDiameter / 2;
  const fallbackX = clamp(finiteOr(state.initial.x, table.width / 2), radius, table.width - radius);
  const fallbackY = clamp(
    finiteOr(state.initial.y, table.height / 2),
    radius,
    table.height - radius,
  );
  const x = clamp(finiteOr(state.body.position[0], fallbackX), -radius, table.width + radius);
  const y = clamp(finiteOr(state.body.position[1], fallbackY), -radius, table.height + radius);
  const vx = clamp(finiteOr(state.body.velocity[0], 0), -12, 12);
  const vy = clamp(finiteOr(state.body.velocity[1], 0), -12, 12);

  setBodyPosition(state.body, quantize(x, INTERNAL_QUANTUM), quantize(y, INTERNAL_QUANTUM));
  setBodyVelocity(state.body, quantize(vx, INTERNAL_QUANTUM), quantize(vy, INTERNAL_QUANTUM));
  state.body.angularVelocity = quantize(
    clamp(finiteOr(state.body.angularVelocity, 0), -1_500, 1_500),
    INTERNAL_QUANTUM,
  );
  state.spinX = quantize(clamp(finiteOr(state.spinX, 0), -1_500, 1_500), INTERNAL_QUANTUM);
  state.spinY = quantize(clamp(finiteOr(state.spinY, 0), -1_500, 1_500), INTERNAL_QUANTUM);
  state.rotation = quantize(finiteOr(state.rotation, 0), INTERNAL_QUANTUM);
  state.z = quantize(clamp(finiteOr(state.z, 0), 0, 0.5), INTERNAL_QUANTUM);
  state.vz = quantize(clamp(finiteOr(state.vz, 0), -5, 5), INTERNAL_QUANTUM);
}

function isAtRest(state: ActiveBallState, radius: number): boolean {
  if (state.pocketed) {
    return true;
  }

  const speed = Math.hypot(velocityX(state.body), velocityY(state.body));
  const contactSlip = Math.hypot(
    velocityX(state.body) - radius * state.spinY,
    velocityY(state.body) + radius * state.spinX,
  );
  const sideSurfaceSpeed = Math.abs(state.body.angularVelocity) * radius;
  return (
    state.z === 0 &&
    state.vz === 0 &&
    speed < STOP_SPEED &&
    contactSlip < STOP_SPEED &&
    sideSurfaceSpeed < STOP_SURFACE_SPIN_SPEED
  );
}

function settleRestingState(state: ActiveBallState, radius: number): void {
  if (!isAtRest(state, radius) || state.pocketed) {
    return;
  }

  setBodyVelocity(state.body, 0, 0);
  state.body.angularVelocity = 0;
  state.spinX = 0;
  state.spinY = 0;
  state.vz = 0;
  state.z = 0;
}

function frameBall(
  ball: BilliardsBall,
  state: ActiveBallState | undefined,
): BilliardsSimulationBallFrame {
  if (state === undefined) {
    return {
      id: ball.id,
      pocketed: ball.pocketed,
      rotation: normalizeRotation(ball.rotation),
      spinX: 0,
      spinY: 0,
      spinZ: 0,
      x: quantize(ball.x),
      y: quantize(ball.y),
      z: 0,
    };
  }

  return {
    id: ball.id,
    pocketed: state.pocketed,
    rotation: normalizeRotation(state.rotation),
    spinX: quantize(state.spinX),
    spinY: quantize(state.spinY),
    spinZ: quantize(state.body.angularVelocity),
    x: quantize(bodyX(state.body)),
    y: quantize(bodyY(state.body)),
    z: quantize(state.z),
  };
}

function makeFrame(
  atMs: number,
  balls: readonly BilliardsBall[],
  statesById: ReadonlyMap<string, ActiveBallState>,
): BilliardsSimulationFrame {
  return {
    atMs,
    balls: balls.map((ball) => frameBall(ball, statesById.get(ball.id))),
  };
}

function makeFinalBalls(
  balls: readonly BilliardsBall[],
  statesById: ReadonlyMap<string, ActiveBallState>,
): readonly BilliardsBall[] {
  return balls.map((ball) => {
    const state = statesById.get(ball.id);
    if (state === undefined) {
      return { ...ball };
    }

    return {
      ...ball,
      pocketed: state.pocketed,
      rotation: normalizeRotation(state.rotation),
      x: quantize(clamp(bodyX(state.body), 0, 4)),
      y: quantize(clamp(bodyY(state.body), 0, 2)),
    };
  });
}

function checksumFor(result: Omit<ShotSimulationResult, "checksum" | "frames">): string {
  const canonical = JSON.stringify({
    balls: result.balls.map((ball) => [ball.id, ball.pocketed, ball.rotation, ball.x, ball.y]),
    cueBallPotted: result.cueBallPotted,
    durationMs: result.durationMs,
    firstContactBallId: result.firstContactBallId,
    firstContactBallIds: result.firstContactBallIds,
    jumpedBallIds: result.jumpedBallIds,
    pocketedBallIds: result.pocketedBallIds,
    postContactRailBallIds: result.postContactRailBallIds,
    railContactBallIds: result.railContactBallIds,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministically simulates one complete shot with a fixed 240 Hz physics step.
 * p2-es resolves rigid ball and cushion contacts; cloth rolling, sliding and three-axis
 * spin are integrated explicitly so the same module can replay a server-authoritative shot.
 */
export function simulateBilliardsShot(input: SimulateBilliardsShotInput): ShotSimulationResult {
  const table = tableSpecFor(input.mode);
  const surface = billiardsSurfaceParameters(table, input.tableFriction, input.spinConvergence);
  const radius = table.ballDiameter / 2;
  const { ballMaterial, railsByBody, world } = createWorld(table, surface);
  const { active, byBody, byId } = createActiveBalls(input.balls, table, world, ballMaterial);
  const cue = active.find((state) => state.initial.kind === "cue");
  const context = applyCueImpulse(cue, input.shot, radius);
  const pocketedBallIds: string[] = [];
  const jumpedBallIds = new Set<string>();
  const jumpCrossings = new Map<string, JumpCrossing>();
  const cueContactBallIds = new Set<string>();
  const railContactBallIds: string[] = [];
  const postContactRailBallIds: string[] = [];
  const railContacts = new Set<string>();
  const postContactRailContacts = new Set<string>();
  const pendingRailEffects: RailEffect[] = [];
  const frames: BilliardsSimulationFrame[] = [];
  let firstContactBallId: string | null = null;
  let firstContactBallIds: readonly string[] = [];
  let completedSteps = 0;

  world.on("beginContact", (event) => {
    const ballA = byBody.get(event.bodyA);
    const ballB = byBody.get(event.bodyB);

    if (ballA !== undefined && ballB !== undefined) {
      return;
    }

    const ball = ballA ?? ballB;
    const railBody = ballA === undefined ? event.bodyA : event.bodyB;
    const rail = railsByBody.get(railBody);
    if (ball === undefined || rail === undefined || ball.pocketed) {
      return;
    }

    // P2's planes also serve as a closed safety boundary for the 2.5D model.
    // A ball above the cushion nose still rebounds into the playable area, but
    // that containment event is not a physical cushion contact for rules.
    if (ball.z > table.ballDiameter * CUSHION_NOSE_HEIGHT_FACTOR) {
      return;
    }

    if (!railContacts.has(ball.initial.id)) {
      railContacts.add(ball.initial.id);
      railContactBallIds.push(ball.initial.id);
    }
    pendingRailEffects.push({ ball, rail });
  });

  world.on("preSolve", (event) => {
    // P2 resolves projected 2D circles. Disable a projected contact until the
    // corresponding 3D spheres actually overlap, allowing elevated shots to
    // clear a ball instead of hitting its invisible vertical column.
    for (const equation of event.contactEquations) {
      const ballA = byBody.get(equation.bodyA);
      const ballB = byBody.get(equation.bodyB);
      if (ballA === undefined || ballB === undefined) continue;

      const dx = bodyX(ballA.body) - bodyX(ballB.body);
      const dy = bodyY(ballA.body) - bodyY(ballB.body);
      const dz = ballA.z - ballB.z;
      equation.enabled =
        dx * dx + dy * dy + dz * dz <= table.ballDiameter * table.ballDiameter + INTERNAL_QUANTUM;
      if (equation.enabled && ballA.initial.kind === "cue" && ballB.initial.kind !== "cue") {
        cueContactBallIds.add(ballB.initial.id);
      }
      if (equation.enabled && ballB.initial.kind === "cue" && ballA.initial.kind !== "cue") {
        cueContactBallIds.add(ballA.initial.id);
      }
    }
    for (const equation of event.frictionEquations) {
      if (equation.contactEquations.length > 0) {
        equation.enabled = equation.contactEquations.some((contact) => contact.enabled);
      }
    }

    // Establish the first valid object-ball contact before classifying new
    // cushion contacts from this same physics step.
    if (firstContactBallIds.length === 0) {
      const contacts = new Set<string>();
      for (const equation of event.contactEquations) {
        if (!equation.enabled) continue;
        const ballA = byBody.get(equation.bodyA);
        const ballB = byBody.get(equation.bodyB);
        if (ballA === undefined || ballB === undefined) continue;
        if (ballA.initial.kind === "cue" && ballB.initial.kind !== "cue") {
          contacts.add(ballB.initial.id);
        }
        if (ballB.initial.kind === "cue" && ballA.initial.kind !== "cue") {
          contacts.add(ballA.initial.id);
        }
      }
      if (contacts.size > 0) {
        firstContactBallIds = [...contacts].sort();
        firstContactBallId = firstContactBallIds[0] ?? null;
      }
    }

    if (firstContactBallId !== null) {
      for (const { ball } of pendingRailEffects) {
        if (!postContactRailContacts.has(ball.initial.id)) {
          postContactRailContacts.add(ball.initial.id);
          postContactRailBallIds.push(ball.initial.id);
        }
      }
    }
  });

  if (input.captureFrames === true) {
    frames.push(makeFrame(0, input.balls, byId));
  }

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    for (const state of active) {
      if (!state.pocketed) {
        applyClothAndSpin(state, context, surface);
        integrateVerticalMotion(state, table.ballDiameter * 1.5);
        updateProjectedCollisionMask(state, table);
      }
    }

    pendingRailEffects.length = 0;
    world.step(FIXED_STEP_SECONDS);
    recordJumpedBalls(cue, active, table, cueContactBallIds, jumpCrossings, jumpedBallIds);
    for (const effect of pendingRailEffects) {
      applyRailSpin(effect, radius, surface);
    }
    for (const state of active) {
      sanitizeState(state, table);
    }
    capturePocketedBalls(active, table, world, pocketedBallIds);

    completedSteps = step;
    const atMs = Math.round(step * FIXED_STEP_SECONDS * 1_000);
    if (input.captureFrames === true && step % FRAME_STEP_INTERVAL === 0) {
      frames.push(makeFrame(atMs, input.balls, byId));
    }

    if (step >= MIN_REST_STEPS && active.every((state) => isAtRest(state, radius))) {
      for (const state of active) {
        settleRestingState(state, radius);
      }
      break;
    }
  }

  const durationMs = Math.round(completedSteps * FIXED_STEP_SECONDS * 1_000);
  if (input.captureFrames === true) {
    const lastFrame = frames.at(-1);
    if (lastFrame?.atMs !== durationMs) {
      frames.push(makeFrame(durationMs, input.balls, byId));
    } else if (lastFrame !== undefined) {
      frames[frames.length - 1] = makeFrame(durationMs, input.balls, byId);
    }
  }

  const balls = makeFinalBalls(input.balls, byId);
  const cueBallPotted = cue?.pocketed === true;
  const resultWithoutChecksum = {
    balls,
    cueBallPotted,
    durationMs,
    firstContactBallId,
    firstContactBallIds,
    jumpedBallIds: [...jumpedBallIds].sort(),
    pocketedBallIds,
    postContactRailBallIds,
    railContactBallIds,
  } satisfies Omit<ShotSimulationResult, "checksum" | "frames">;
  const result: ShotSimulationResult = {
    ...resultWithoutChecksum,
    checksum: checksumFor(resultWithoutChecksum),
    ...(input.captureFrames === true ? { frames } : {}),
  };
  return result;
}
