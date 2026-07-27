use crate::api::CoreError;
use crate::geometry::{Aabb, CircularCushion, LinearCushion, PocketGeometry, TableGeometry};
use crate::math::{
    EPSILON, Vec2, clamp, normalize_rotation, quantize, roots_in_interval,
    smallest_root_in_interval,
};
use crate::model::{
    Ball, BallKind, CueStrikeDiagnostics, DynamicBall, MotionState, PHYSICS_VERSION,
    PredictShotInput, PredictedBallPath, PredictedPathPoint, Shot, ShotSimulationResult,
    SimulateShotInput, SimulationBallFrame, SimulationEvent, SimulationFrame, SurfaceParameters,
    TableSpec, TrajectoryPrediction,
};
use crate::replay::{legacy_checksum, state_hash};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const GRAVITY: f64 = 9.81;
const MAX_SHOT_SECONDS: f64 = 20.0;
const MAX_EVENTS: usize = 4_096;
const FRAME_INTERVAL_SECONDS: f64 = 1.0 / 60.0;
const JUMP_PROBE_INTERVAL_SECONDS: f64 = 1.0 / 480.0;
const EVENT_TIME_EPSILON: f64 = 2.0e-7;
const MIN_EVENT_TIME: f64 = 2.0e-8;
const INTERNAL_QUANTUM: f64 = 1.0e-10;
const OUTPUT_QUANTUM: f64 = 1.0e-6;
const CONTACT_SEPARATION: f64 = 1.0e-7;
const STOP_SPEED: f64 = 0.012;
const STOP_SURFACE_SPIN_SPEED: f64 = 0.012;
const RESTING_CONTACT_SPEED: f64 = 0.05;
const POCKET_CAPTURE_HEIGHT_FACTOR: f64 = 0.35;
const CUSHION_NOSE_HEIGHT_FACTOR: f64 = 0.65;
const BASE_ROLLING_DECELERATION: f64 = 0.16;
const BASE_SIDE_SPIN_DAMPING: f64 = 0.72;
const BASE_CUSHION_FRICTION: f64 = 0.12;
const BASE_CUSHION_TANGENTIAL_RESPONSE: f64 = 0.075;
const BASE_CUSHION_ROLL_DISTURBANCE: f64 = 0.28;
const CUSHION_RESTITUTION_FRICTION_RESPONSE: f64 = 0.08;
const BALL_RESTITUTION: f64 = 0.94;
const ROLLING_RESISTANCE_CALIBRATION: f64 = 1.0;
const BALL_FRICTION: f64 = 0.035;

#[derive(Clone, Copy, Debug)]
struct Kinematics {
    acceleration: Vec2,
    angular_acceleration: Vec2,
}

impl Kinematics {
    const ZERO: Self = Self {
        acceleration: Vec2::ZERO,
        angular_acceleration: Vec2::ZERO,
    };
}

#[derive(Clone, Debug)]
enum EventKind {
    Pocket {
        ball: usize,
        pocket: usize,
    },
    BallBall {
        first: usize,
        second: usize,
    },
    LinearCushion {
        ball: usize,
        cushion: usize,
    },
    CircularCushion {
        ball: usize,
        cushion: usize,
    },
    SafetyBoundary {
        ball: usize,
        normal: Vec2,
        id: &'static str,
    },
    Transition {
        ball: usize,
        from: MotionState,
    },
}

#[derive(Clone, Debug)]
struct CandidateEvent {
    time: f64,
    kind: EventKind,
}

impl CandidateEvent {
    fn priority(&self) -> u8 {
        match self.kind {
            EventKind::Pocket { .. } => 0,
            EventKind::BallBall { .. } => 1,
            EventKind::LinearCushion { .. } | EventKind::CircularCushion { .. } => 2,
            EventKind::SafetyBoundary { .. } => 3,
            EventKind::Transition { .. } => 4,
        }
    }

    fn stable_key(&self, balls: &[DynamicBall], geometry: &TableGeometry) -> String {
        match &self.kind {
            EventKind::Pocket { ball, pocket } => {
                format!(
                    "0:{}:{}",
                    balls[*ball].source.id, geometry.pockets[*pocket].id
                )
            }
            EventKind::BallBall { first, second } => {
                let mut ids = [
                    balls[*first].source.id.as_str(),
                    balls[*second].source.id.as_str(),
                ];
                ids.sort_unstable();
                format!("1:{}:{}", ids[0], ids[1])
            }
            EventKind::LinearCushion { ball, cushion } => format!(
                "2:{}:{}",
                balls[*ball].source.id, geometry.linear_cushions[*cushion].id
            ),
            EventKind::CircularCushion { ball, cushion } => format!(
                "2:{}:{}",
                balls[*ball].source.id, geometry.circular_cushions[*cushion].id
            ),
            EventKind::SafetyBoundary { ball, id, .. } => {
                format!("3:{}:{id}", balls[*ball].source.id)
            }
            EventKind::Transition { ball, from } => {
                format!("4:{}:{from:?}", balls[*ball].source.id)
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ContactBody {
    Ball(usize),
    Static,
}

#[derive(Clone, Debug)]
struct ContactConstraint {
    first: usize,
    second: ContactBody,
    static_geometry: Option<StaticContactGeometry>,
    normal: Vec2,
    restitution: f64,
    friction: f64,
    stable_key: String,
}

#[derive(Clone, Copy, Debug)]
enum StaticContactGeometry {
    Linear {
        start: Vec2,
        inward_normal: Vec2,
        offset: f64,
    },
    Circular {
        center: Vec2,
        contact_radius: f64,
    },
}

#[derive(Default)]
struct JumpTracker {
    approaches: HashMap<String, Vec2>,
    jumped: BTreeSet<String>,
}

pub fn surface_parameters(
    table: &TableSpec,
    table_friction: Option<f64>,
    spin_convergence: Option<f64>,
) -> SurfaceParameters {
    let sliding_friction = clamp(table_friction.unwrap_or(0.2), 0.12, 0.28);
    let scale = sliding_friction / 0.2;
    SurfaceParameters {
        cushion_friction: BASE_CUSHION_FRICTION * scale,
        cushion_restitution: clamp(
            table.cushion_restitution + (1.0 - scale) * CUSHION_RESTITUTION_FRICTION_RESPONSE,
            0.7,
            0.9,
        ),
        cushion_roll_disturbance: BASE_CUSHION_ROLL_DISTURBANCE * scale,
        cushion_tangential_response: BASE_CUSHION_TANGENTIAL_RESPONSE * scale,
        rolling_deceleration: BASE_ROLLING_DECELERATION * scale,
        side_spin_damping: BASE_SIDE_SPIN_DAMPING * scale,
        sliding_friction,
        spin_convergence: clamp(spin_convergence.unwrap_or(1.0), 0.5, 2.0),
    }
}

pub fn simulate_shot(input: SimulateShotInput) -> Result<ShotSimulationResult, CoreError> {
    simulate_shot_with_event_limit(input, MAX_EVENTS)
}

fn simulate_shot_with_event_limit(
    input: SimulateShotInput,
    event_limit: usize,
) -> Result<ShotSimulationResult, CoreError> {
    validate_input(&input)?;
    let geometry = TableGeometry::for_mode(input.mode);
    let surface = surface_parameters(
        &geometry.table,
        input.table_friction,
        input.spin_convergence,
    );
    let radius = geometry.table.ball_diameter * 0.5;
    let (mut balls, indices_by_id) = dynamic_balls(&input.balls, &geometry.table);
    let cue_index = balls
        .iter()
        .position(|ball| ball.source.kind == BallKind::Cue && ball.active())
        .ok_or_else(|| {
            CoreError::invalid(
                "CUE_BALL_NOT_ON_TABLE",
                "the cue ball must be placed before a shot",
            )
        })?;
    let cue_strike = apply_cue_strike(&mut balls[cue_index], &input.shot, radius);

    let mut frames = input
        .capture_frames
        .then(|| vec![make_frame(0, &input.balls, &balls, &indices_by_id)]);
    let mut next_frame_time = FRAME_INTERVAL_SECONDS;
    let mut events = Vec::new();
    let mut pocketed_ball_ids = Vec::new();
    let mut rail_contact_ball_ids = Vec::new();
    let mut rail_contact_set = HashSet::new();
    let mut post_contact_rail_ball_ids = Vec::new();
    let mut post_contact_rail_set = HashSet::new();
    let mut first_contact_ball_ids = Vec::new();
    let mut physically_contacted_by_cue = HashSet::new();
    let mut jump_tracker = JumpTracker::default();
    let mut current_time = 0.0;

    let mut event_budget_exhausted = true;
    for _ in 0..event_limit {
        if all_at_rest(&balls, radius) {
            settle_all(&mut balls);
            event_budget_exhausted = false;
            break;
        }

        let remaining = MAX_SHOT_SECONDS - current_time;
        if remaining <= EVENT_TIME_EPSILON {
            settle_all(&mut balls);
            current_time = MAX_SHOT_SECONDS;
            event_budget_exhausted = false;
            break;
        }

        let mut candidates =
            predict_candidates(&balls, &geometry, &surface, radius, cue_strike, remaining);
        if candidates.is_empty() {
            settle_all(&mut balls);
            event_budget_exhausted = false;
            break;
        }
        candidates.sort_by(|first, second| {
            first
                .time
                .total_cmp(&second.time)
                .then_with(|| first.priority().cmp(&second.priority()))
                .then_with(|| {
                    first
                        .stable_key(&balls, &geometry)
                        .cmp(&second.stable_key(&balls, &geometry))
                })
        });
        let next_time = candidates[0].time.clamp(MIN_EVENT_TIME, remaining);
        let simultaneous: Vec<CandidateEvent> = candidates
            .into_iter()
            .take_while(|candidate| (candidate.time - next_time).abs() <= EVENT_TIME_EPSILON)
            .collect();

        if let Some(captured) = frames.as_mut() {
            record_frames_between(
                captured,
                &mut next_frame_time,
                current_time,
                next_time,
                &input.balls,
                &balls,
                &indices_by_id,
                &surface,
                radius,
                cue_strike,
            );
        }
        record_jump_crossings(
            &mut jump_tracker,
            cue_index,
            &balls,
            next_time,
            &surface,
            radius,
            cue_strike,
            &physically_contacted_by_cue,
        );
        evolve_all(&mut balls, next_time, &surface, radius, cue_strike);
        current_time += next_time;

        resolve_events(
            simultaneous,
            current_time,
            &mut balls,
            &geometry,
            &surface,
            radius,
            cue_index,
            &mut events,
            &mut pocketed_ball_ids,
            &mut rail_contact_ball_ids,
            &mut rail_contact_set,
            &mut post_contact_rail_ball_ids,
            &mut post_contact_rail_set,
            &mut first_contact_ball_ids,
            &mut physically_contacted_by_cue,
        );
        sanitize_all(&mut balls, &geometry.table);
    }

    if event_budget_exhausted && !all_at_rest(&balls, radius) {
        return Err(CoreError::internal(
            "PHYSICS_EVENT_LIMIT_EXCEEDED",
            "the shot exceeded the deterministic physics event budget",
        ));
    }

    settle_all(&mut balls);
    let duration_ms = (current_time * 1_000.0).round().clamp(0.0, 20_000.0) as u32;
    if let Some(captured) = frames.as_mut() {
        let last_at = captured.last().map_or(u32::MAX, |frame| frame.at_ms);
        if last_at != duration_ms {
            captured.push(make_frame(
                duration_ms,
                &input.balls,
                &balls,
                &indices_by_id,
            ));
        } else if let Some(last) = captured.last_mut() {
            *last = make_frame(duration_ms, &input.balls, &balls, &indices_by_id);
        }
    }

    let final_balls = final_balls(&input.balls, &balls, &indices_by_id);
    let cue_ball_potted = final_balls
        .iter()
        .find(|ball| ball.kind == BallKind::Cue)
        .is_some_and(|ball| ball.pocketed);
    first_contact_ball_ids.sort();
    first_contact_ball_ids.dedup();
    let first_contact_ball_id = first_contact_ball_ids.first().cloned();
    let jumped_ball_ids: Vec<String> = jump_tracker.jumped.into_iter().collect();
    let canonical = json!({
        "balls": final_balls
            .iter()
            .map(|ball| json!([ball.id, ball.pocketed, ball.rotation, ball.x, ball.y]))
            .collect::<Vec<_>>(),
        "cueBallPotted": cue_ball_potted,
        "durationMs": duration_ms,
        "firstContactBallId": first_contact_ball_id,
        "firstContactBallIds": first_contact_ball_ids,
        "jumpedBallIds": jumped_ball_ids,
        "pocketedBallIds": pocketed_ball_ids,
        "postContactRailBallIds": post_contact_rail_ball_ids,
        "railContactBallIds": rail_contact_ball_ids,
    })
    .to_string();
    let checksum = legacy_checksum(&canonical);
    let state_hash = state_hash(&final_balls, duration_ms, &events, &pocketed_ball_ids);

    Ok(ShotSimulationResult {
        balls: final_balls,
        checksum,
        cue_ball_potted,
        cue_strike,
        duration_ms,
        events,
        first_contact_ball_id,
        first_contact_ball_ids,
        frames,
        jumped_ball_ids,
        physics_version: PHYSICS_VERSION,
        pocketed_ball_ids,
        post_contact_rail_ball_ids,
        rail_contact_ball_ids,
        state_hash,
    })
}

pub fn predict_shot(input: PredictShotInput) -> Result<TrajectoryPrediction, CoreError> {
    let max_frames = input.max_frames.clamp(2, 1_200);
    let result = simulate_shot(SimulateShotInput {
        balls: input.balls,
        capture_frames: true,
        mode: input.mode,
        shot: input.shot,
        spin_convergence: input.spin_convergence,
        table_friction: input.table_friction,
    })?;
    let frames = result.frames.as_deref().unwrap_or_default();
    let sample_count = frames.len().min(max_frames);
    let mut paths_by_id: BTreeMap<String, Vec<PredictedPathPoint>> = BTreeMap::new();
    for sample_index in 0..sample_count {
        let frame_index = if sample_count <= 1 {
            0
        } else {
            sample_index * (frames.len() - 1) / (sample_count - 1)
        };
        let frame = &frames[frame_index];
        for ball in &frame.balls {
            paths_by_id
                .entry(ball.id.clone())
                .or_default()
                .push(PredictedPathPoint {
                    at_ms: frame.at_ms,
                    state: ball.state,
                    x: ball.x,
                    y: ball.y,
                    z: ball.z,
                });
        }
    }
    Ok(TrajectoryPrediction {
        checksum: result.checksum,
        first_contact_ball_ids: result.first_contact_ball_ids,
        paths: paths_by_id
            .into_iter()
            .map(|(id, points)| PredictedBallPath { id, points })
            .collect(),
        physics_version: PHYSICS_VERSION,
        pocketed_ball_ids: result.pocketed_ball_ids,
        state_hash: result.state_hash,
    })
}

fn validate_input(input: &SimulateShotInput) -> Result<(), CoreError> {
    if input.balls.is_empty() || input.balls.len() > 32 {
        return Err(CoreError::invalid(
            "INVALID_BALL_COUNT",
            "a shot must contain between one and thirty-two balls",
        ));
    }
    let mut ids = HashSet::new();
    let mut cue_count = 0;
    for ball in &input.balls {
        if ball.id.is_empty() || !ids.insert(ball.id.as_str()) {
            return Err(CoreError::invalid(
                "INVALID_BALL_ID",
                "ball IDs must be non-empty and unique",
            ));
        }
        if ball.kind == BallKind::Cue {
            cue_count += 1;
        }
        if ![ball.x, ball.y, ball.rotation]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err(CoreError::invalid(
                "NON_FINITE_BALL_STATE",
                "ball state must contain finite values",
            ));
        }
    }
    if cue_count != 1 {
        return Err(CoreError::invalid(
            "INVALID_CUE_BALL_COUNT",
            "exactly one cue ball is required",
        ));
    }
    let shot = &input.shot;
    if ![
        shot.angle,
        shot.elevation,
        shot.power,
        shot.tip.x,
        shot.tip.y,
    ]
    .into_iter()
    .all(f64::is_finite)
    {
        return Err(CoreError::invalid(
            "NON_FINITE_SHOT",
            "shot values must be finite",
        ));
    }
    if !(-std::f64::consts::PI..=std::f64::consts::PI).contains(&shot.angle)
        || !(0.0..=90.0).contains(&shot.elevation)
        || !(1.0..=100.0).contains(&shot.power)
        || shot.tip.x * shot.tip.x + shot.tip.y * shot.tip.y > 0.95 * 0.95 + EPSILON
    {
        return Err(CoreError::invalid(
            "SHOT_OUT_OF_RANGE",
            "shot values are outside the supported calibration range",
        ));
    }
    Ok(())
}

fn dynamic_balls(source: &[Ball], table: &TableSpec) -> (Vec<DynamicBall>, HashMap<String, usize>) {
    let radius = table.ball_diameter * 0.5;
    let mut balls = Vec::with_capacity(source.len());
    let mut indices = HashMap::new();
    for ball in source {
        let index = balls.len();
        indices.insert(ball.id.clone(), index);
        balls.push(DynamicBall {
            source: ball.clone(),
            position: Vec2::new(
                clamp(ball.x, -radius, table.width + radius),
                clamp(ball.y, -radius, table.height + radius),
            ),
            z: 0.0,
            velocity: Vec2::ZERO,
            vertical_velocity: 0.0,
            spin: [0.0; 3],
            rotation: ball.rotation,
            state: if ball.pocketed {
                MotionState::Pocketed
            } else {
                MotionState::Stationary
            },
            pocketed: ball.pocketed,
        });
    }
    (balls, indices)
}

fn apply_cue_strike(ball: &mut DynamicBall, shot: &Shot, radius: f64) -> CueStrikeDiagnostics {
    let elevation = clamp(shot.elevation, 0.0, 90.0).to_radians();
    let elevation_factor = elevation.sin();
    let planar_factor = elevation.cos().max(0.0).powf(0.55);
    let power = clamp(shot.power, 1.0, 100.0) / 100.0;
    let cue_speed = 0.12 + 7.08 * power.powf(1.2);
    let planar_speed = cue_speed * planar_factor;
    let direction = Vec2::new(shot.angle.cos(), shot.angle.sin());
    let normal = direction.perpendicular();
    let tip = Vec2::new(
        clamp(shot.tip.x, -0.95, 0.95),
        clamp(shot.tip.y, -0.95, 0.95),
    );
    let tip_radius = tip.length();
    let miscue = tip_radius > 0.94;
    let grip = if miscue { 0.72 } else { 1.0 };
    let squirt_radians = -tip.x * (0.008 + 0.018 * power) * grip;
    let actual_direction = Vec2::new(
        (shot.angle + squirt_radians).cos(),
        (shot.angle + squirt_radians).sin(),
    );
    ball.velocity = actual_direction * (planar_speed * grip);

    let longitudinal_spin = tip.y * planar_speed * 2.35 / radius;
    ball.spin[0] = normal.x * longitudinal_spin * grip;
    ball.spin[1] = normal.y * longitudinal_spin * grip;
    ball.spin[2] = -tip.x * planar_speed * (3.4 + elevation_factor * 1.6) / radius * grip;

    let jump_tip_factor = clamp(0.45 + tip.y * 0.55, 0.0, 1.0);
    let jump_speed = clamp(
        cue_speed * elevation_factor * jump_tip_factor * grip,
        0.0,
        2.2,
    );
    ball.vertical_velocity = jump_speed;
    ball.state = if jump_speed > STOP_SPEED {
        MotionState::Airborne
    } else {
        classify_surface_motion(ball, radius)
    };
    CueStrikeDiagnostics {
        cue_speed: quantize(cue_speed, OUTPUT_QUANTUM),
        jump_speed: quantize(jump_speed, OUTPUT_QUANTUM),
        miscue,
        squirt_radians: quantize(squirt_radians, OUTPUT_QUANTUM),
    }
}

fn classify_surface_motion(ball: &DynamicBall, radius: f64) -> MotionState {
    if ball.pocketed {
        return MotionState::Pocketed;
    }
    if ball.z > EPSILON || ball.vertical_velocity.abs() > STOP_SPEED {
        return MotionState::Airborne;
    }
    let slip = slip_velocity(ball, radius).length();
    if slip >= STOP_SPEED {
        return MotionState::Sliding;
    }
    if ball.velocity.length() >= STOP_SPEED {
        return MotionState::Rolling;
    }
    if ball.spin[2].abs() * radius >= STOP_SURFACE_SPIN_SPEED {
        return MotionState::Spinning;
    }
    MotionState::Stationary
}

fn slip_velocity(ball: &DynamicBall, radius: f64) -> Vec2 {
    Vec2::new(
        ball.velocity.x - radius * ball.spin[1],
        ball.velocity.y + radius * ball.spin[0],
    )
}

fn kinematics(
    ball: &DynamicBall,
    surface: &SurfaceParameters,
    radius: f64,
    cue_strike: CueStrikeDiagnostics,
) -> Kinematics {
    match ball.state {
        MotionState::Sliding => {
            let slip = slip_velocity(ball, radius);
            let slip_direction = slip.normalized();
            let cloth_acceleration = -slip_direction * (surface.sliding_friction * GRAVITY);
            let angular_acceleration = Vec2::new(slip_direction.y, -slip_direction.x)
                * (2.5 * surface.sliding_friction * GRAVITY / radius);
            let speed = ball.velocity.length();
            let side_acceleration = if speed > STOP_SPEED && ball.spin[2].abs() > EPSILON {
                let curve_factor = 0.045
                    + 0.5 * (cue_strike.jump_speed / cue_strike.cue_speed.max(EPSILON)).powf(1.6);
                ball.velocity.normalized().perpendicular()
                    * clamp(ball.spin[2] * radius * curve_factor, -3.2, 3.2)
            } else {
                Vec2::ZERO
            };
            Kinematics {
                acceleration: cloth_acceleration + side_acceleration,
                angular_acceleration,
            }
        }
        MotionState::Rolling => {
            let direction = ball.velocity.normalized();
            let acceleration =
                -direction * (surface.rolling_deceleration * ROLLING_RESISTANCE_CALIBRATION);
            Kinematics {
                acceleration,
                angular_acceleration: Vec2::ZERO,
            }
        }
        MotionState::Airborne => {
            let speed = ball.velocity.length();
            let side = if speed > STOP_SPEED && ball.spin[2].abs() > EPSILON {
                ball.velocity.normalized().perpendicular()
                    * clamp(ball.spin[2] * radius * 0.02, -0.25, 0.25)
            } else {
                Vec2::ZERO
            };
            Kinematics {
                acceleration: side,
                angular_acceleration: Vec2::ZERO,
            }
        }
        MotionState::Stationary | MotionState::Spinning | MotionState::Pocketed => Kinematics::ZERO,
    }
}

fn transition_time(ball: &DynamicBall, surface: &SurfaceParameters, radius: f64) -> Option<f64> {
    let time = match ball.state {
        MotionState::Sliding => {
            let slip = slip_velocity(ball, radius).length();
            2.0 * slip / (7.0 * surface.sliding_friction * surface.spin_convergence * GRAVITY)
        }
        MotionState::Rolling => {
            ball.velocity.length() / (surface.rolling_deceleration * ROLLING_RESISTANCE_CALIBRATION)
        }
        MotionState::Spinning => {
            let surface_speed = ball.spin[2].abs() * radius;
            if surface_speed <= STOP_SURFACE_SPIN_SPEED {
                0.0
            } else {
                (surface_speed / STOP_SURFACE_SPIN_SPEED).ln() / surface.side_spin_damping
            }
        }
        MotionState::Airborne => {
            let discriminant =
                ball.vertical_velocity * ball.vertical_velocity + 2.0 * GRAVITY * ball.z.max(0.0);
            (ball.vertical_velocity + discriminant.sqrt()) / GRAVITY
        }
        MotionState::Stationary | MotionState::Pocketed => return None,
    };
    Some(time.max(MIN_EVENT_TIME))
}

fn predict_candidates(
    balls: &[DynamicBall],
    geometry: &TableGeometry,
    surface: &SurfaceParameters,
    radius: f64,
    cue_strike: CueStrikeDiagnostics,
    remaining: f64,
) -> Vec<CandidateEvent> {
    let mut candidates = Vec::new();
    let mut horizon = remaining;
    let mut transitions = Vec::new();
    for (index, ball) in balls.iter().enumerate() {
        if !ball.active() {
            continue;
        }
        if let Some(time) = transition_time(ball, surface, radius)
            && time <= remaining + EVENT_TIME_EPSILON
        {
            horizon = horizon.min(time);
            transitions.push(CandidateEvent {
                time,
                kind: EventKind::Transition {
                    ball: index,
                    from: ball.state,
                },
            });
        }
    }
    candidates.extend(
        transitions
            .into_iter()
            .filter(|event| event.time <= horizon + EVENT_TIME_EPSILON),
    );
    horizon = horizon.max(MIN_EVENT_TIME);

    let accelerations: Vec<Vec2> = balls
        .iter()
        .map(|ball| kinematics(ball, surface, radius, cue_strike).acceleration)
        .collect();
    let swept: Vec<Aabb> = balls
        .iter()
        .enumerate()
        .map(|(index, ball)| {
            Aabb::from_motion(
                ball.position,
                ball.velocity,
                accelerations[index],
                horizon,
                radius,
            )
        })
        .collect();

    let mut order: Vec<usize> = balls
        .iter()
        .enumerate()
        .filter_map(|(index, ball)| ball.active().then_some(index))
        .collect();
    order.sort_by(|first, second| {
        swept[*first]
            .minimum
            .x
            .total_cmp(&swept[*second].minimum.x)
            .then_with(|| balls[*first].source.id.cmp(&balls[*second].source.id))
    });
    for (position, first) in order.iter().copied().enumerate() {
        for second in order.iter().copied().skip(position + 1) {
            if swept[second].minimum.x > swept[first].maximum.x + EPSILON {
                break;
            }
            if !swept[first].overlaps(swept[second]) {
                continue;
            }
            if let Some(time) = ball_ball_time(
                &balls[first],
                accelerations[first],
                &balls[second],
                accelerations[second],
                radius * 2.0,
                horizon,
            ) {
                candidates.push(CandidateEvent {
                    time,
                    kind: EventKind::BallBall { first, second },
                });
            }
        }
    }

    for (ball_index, ball) in balls.iter().enumerate() {
        if !ball.active()
            || (ball.velocity.length() <= EPSILON
                && ball.vertical_velocity.abs() <= EPSILON
                && accelerations[ball_index].length() <= EPSILON)
        {
            continue;
        }
        let ball_swept = swept[ball_index];
        for (pocket_index, pocket) in geometry.pockets.iter().enumerate() {
            if !ball_swept.overlaps(pocket.aabb) {
                continue;
            }
            if let Some(time) =
                pocket_time(ball, accelerations[ball_index], pocket, radius, horizon)
            {
                candidates.push(CandidateEvent {
                    time,
                    kind: EventKind::Pocket {
                        ball: ball_index,
                        pocket: pocket_index,
                    },
                });
            }
        }
        for (cushion_index, cushion) in geometry.linear_cushions.iter().enumerate() {
            let padded = Aabb {
                minimum: cushion.aabb.minimum - Vec2::new(radius, radius),
                maximum: cushion.aabb.maximum + Vec2::new(radius, radius),
            };
            if !ball_swept.overlaps(padded) {
                continue;
            }
            if let Some(time) = linear_cushion_time(
                ball,
                accelerations[ball_index],
                cushion,
                radius,
                geometry.table.ball_diameter,
                horizon,
            ) {
                candidates.push(CandidateEvent {
                    time,
                    kind: EventKind::LinearCushion {
                        ball: ball_index,
                        cushion: cushion_index,
                    },
                });
            }
        }
        for (cushion_index, cushion) in geometry.circular_cushions.iter().enumerate() {
            let padded = Aabb {
                minimum: cushion.aabb.minimum - Vec2::new(radius, radius),
                maximum: cushion.aabb.maximum + Vec2::new(radius, radius),
            };
            if !ball_swept.overlaps(padded) {
                continue;
            }
            if let Some(time) = circular_cushion_time(
                ball,
                accelerations[ball_index],
                cushion,
                radius,
                geometry.table.ball_diameter,
                horizon,
            ) {
                candidates.push(CandidateEvent {
                    time,
                    kind: EventKind::CircularCushion {
                        ball: ball_index,
                        cushion: cushion_index,
                    },
                });
            }
        }
        candidates.extend(safety_boundary_times(
            ball_index,
            ball,
            accelerations[ball_index],
            &geometry.table,
            radius,
            horizon,
        ));
    }
    candidates
}

fn ball_ball_time(
    first: &DynamicBall,
    first_acceleration: Vec2,
    second: &DynamicBall,
    second_acceleration: Vec2,
    diameter: f64,
    horizon: f64,
) -> Option<f64> {
    let position = first.position - second.position;
    let velocity = first.velocity - second.velocity;
    let acceleration = first_acceleration - second_acceleration;
    let z = first.z - second.z;
    let vertical_velocity = first.vertical_velocity - second.vertical_velocity;
    let vertical_acceleration = if first.state == MotionState::Airborne {
        -GRAVITY
    } else {
        0.0
    } - if second.state == MotionState::Airborne {
        -GRAVITY
    } else {
        0.0
    };
    let coefficients = distance_polynomial_3d(
        position,
        velocity,
        acceleration,
        z,
        vertical_velocity,
        vertical_acceleration,
        diameter,
    );
    approaching_root(&coefficients, horizon)
}

fn pocket_time(
    ball: &DynamicBall,
    acceleration: Vec2,
    pocket: &PocketGeometry,
    radius: f64,
    horizon: f64,
) -> Option<f64> {
    let position = ball.position - pocket.center;
    if position.length() <= pocket.capture_radius + EPSILON
        && ball.z <= radius * POCKET_CAPTURE_HEIGHT_FACTOR
    {
        return Some(MIN_EVENT_TIME);
    }
    let coefficients =
        distance_polynomial_2d(position, ball.velocity, acceleration, pocket.capture_radius);
    for root in roots_in_interval(&coefficients, MIN_EVENT_TIME, horizon) {
        if derivative(&coefficients, root) >= 1.0e-8 {
            continue;
        }
        let z = vertical_position(ball, root);
        if z <= radius * POCKET_CAPTURE_HEIGHT_FACTOR + EPSILON {
            return Some(root.max(MIN_EVENT_TIME));
        }
    }
    None
}

fn linear_cushion_time(
    ball: &DynamicBall,
    acceleration: Vec2,
    cushion: &LinearCushion,
    radius: f64,
    ball_diameter: f64,
    horizon: f64,
) -> Option<f64> {
    let distance = (ball.position - cushion.start).dot(cushion.inward_normal);
    let velocity = ball.velocity.dot(cushion.inward_normal);
    let normal_acceleration = acceleration.dot(cushion.inward_normal);
    let coefficients = [distance - radius, velocity, 0.5 * normal_acceleration];
    for root in roots_in_interval(&coefficients, MIN_EVENT_TIME, horizon) {
        if derivative(&coefficients, root) >= -1.0e-8 {
            continue;
        }
        let position = planar_position(ball, acceleration, root);
        if cushion.contains_projection(position, 1.0e-5)
            && vertical_position(ball, root) <= ball_diameter * CUSHION_NOSE_HEIGHT_FACTOR + EPSILON
        {
            return Some(root.max(MIN_EVENT_TIME));
        }
    }
    None
}

fn circular_cushion_time(
    ball: &DynamicBall,
    acceleration: Vec2,
    cushion: &CircularCushion,
    radius: f64,
    ball_diameter: f64,
    horizon: f64,
) -> Option<f64> {
    let coefficients = distance_polynomial_2d(
        ball.position - cushion.center,
        ball.velocity,
        acceleration,
        radius + cushion.radius,
    );
    for root in roots_in_interval(&coefficients, MIN_EVENT_TIME, horizon) {
        if derivative(&coefficients, root) >= -1.0e-8 {
            continue;
        }
        if vertical_position(ball, root) <= ball_diameter * CUSHION_NOSE_HEIGHT_FACTOR + EPSILON {
            return Some(root.max(MIN_EVENT_TIME));
        }
    }
    None
}

fn safety_boundary_times(
    ball_index: usize,
    ball: &DynamicBall,
    acceleration: Vec2,
    table: &TableSpec,
    radius: f64,
    horizon: f64,
) -> Vec<CandidateEvent> {
    let boundaries = [
        (
            ball.position.x + radius,
            ball.velocity.x,
            acceleration.x,
            Vec2::new(1.0, 0.0),
            "outer-left",
        ),
        (
            table.width + radius - ball.position.x,
            -ball.velocity.x,
            -acceleration.x,
            Vec2::new(-1.0, 0.0),
            "outer-right",
        ),
        (
            ball.position.y + radius,
            ball.velocity.y,
            acceleration.y,
            Vec2::new(0.0, 1.0),
            "outer-top",
        ),
        (
            table.height + radius - ball.position.y,
            -ball.velocity.y,
            -acceleration.y,
            Vec2::new(0.0, -1.0),
            "outer-bottom",
        ),
    ];
    let mut result = Vec::new();
    for (distance, velocity, axis_acceleration, normal, id) in boundaries {
        let coefficients = [distance, velocity, 0.5 * axis_acceleration];
        if let Some(time) = smallest_root_in_interval(&coefficients, MIN_EVENT_TIME, horizon)
            && derivative(&coefficients, time) < -1.0e-8
        {
            result.push(CandidateEvent {
                time,
                kind: EventKind::SafetyBoundary {
                    ball: ball_index,
                    normal,
                    id,
                },
            });
        }
    }
    result
}

fn distance_polynomial_2d(
    position: Vec2,
    velocity: Vec2,
    acceleration: Vec2,
    distance: f64,
) -> [f64; 5] {
    [
        position.length_squared() - distance * distance,
        2.0 * position.dot(velocity),
        velocity.length_squared() + position.dot(acceleration),
        velocity.dot(acceleration),
        0.25 * acceleration.length_squared(),
    ]
}

fn distance_polynomial_3d(
    position: Vec2,
    velocity: Vec2,
    acceleration: Vec2,
    z: f64,
    vertical_velocity: f64,
    vertical_acceleration: f64,
    distance: f64,
) -> [f64; 5] {
    let mut coefficients = distance_polynomial_2d(position, velocity, acceleration, distance);
    coefficients[0] += z * z;
    coefficients[1] += 2.0 * z * vertical_velocity;
    coefficients[2] += vertical_velocity * vertical_velocity + z * vertical_acceleration;
    coefficients[3] += vertical_velocity * vertical_acceleration;
    coefficients[4] += 0.25 * vertical_acceleration * vertical_acceleration;
    coefficients
}

fn approaching_root(coefficients: &[f64], horizon: f64) -> Option<f64> {
    if coefficients[0] <= 1.0e-9 && derivative(coefficients, 0.0) < -1.0e-8 {
        return Some(MIN_EVENT_TIME);
    }
    roots_in_interval(coefficients, MIN_EVENT_TIME, horizon)
        .into_iter()
        .find(|root| derivative(coefficients, *root) < -1.0e-8)
        .map(|root| root.max(MIN_EVENT_TIME))
}

fn derivative(coefficients: &[f64], time: f64) -> f64 {
    coefficients
        .iter()
        .enumerate()
        .skip(1)
        .rev()
        .fold(0.0, |value, (power, coefficient)| {
            value * time + *coefficient * power as f64
        })
}

fn planar_position(ball: &DynamicBall, acceleration: Vec2, time: f64) -> Vec2 {
    ball.position + ball.velocity * time + acceleration * (0.5 * time * time)
}

fn vertical_position(ball: &DynamicBall, time: f64) -> f64 {
    if ball.state != MotionState::Airborne {
        return ball.z;
    }
    (ball.z + ball.vertical_velocity * time - 0.5 * GRAVITY * time * time).max(0.0)
}

#[allow(clippy::too_many_arguments)]
fn resolve_events(
    mut candidates: Vec<CandidateEvent>,
    current_time: f64,
    balls: &mut [DynamicBall],
    geometry: &TableGeometry,
    surface: &SurfaceParameters,
    radius: f64,
    cue_index: usize,
    events: &mut Vec<SimulationEvent>,
    pocketed_ball_ids: &mut Vec<String>,
    rail_contact_ball_ids: &mut Vec<String>,
    rail_contact_set: &mut HashSet<String>,
    post_contact_rail_ball_ids: &mut Vec<String>,
    post_contact_rail_set: &mut HashSet<String>,
    first_contact_ball_ids: &mut Vec<String>,
    physically_contacted_by_cue: &mut HashSet<String>,
) {
    candidates.sort_by(|first, second| {
        first.priority().cmp(&second.priority()).then_with(|| {
            first
                .stable_key(balls, geometry)
                .cmp(&second.stable_key(balls, geometry))
        })
    });

    let mut cue_contacts: Vec<String> = candidates
        .iter()
        .filter_map(|candidate| match candidate.kind {
            EventKind::BallBall { first, second } if first == cue_index => {
                Some(balls[second].source.id.clone())
            }
            EventKind::BallBall { first, second } if second == cue_index => {
                Some(balls[first].source.id.clone())
            }
            _ => None,
        })
        .collect();
    cue_contacts.sort();
    cue_contacts.dedup();
    if !cue_contacts.is_empty() {
        for id in &cue_contacts {
            physically_contacted_by_cue.insert(id.clone());
        }
        if first_contact_ball_ids.is_empty() {
            first_contact_ball_ids.extend(cue_contacts);
        }
    }

    for candidate in candidates
        .iter()
        .filter(|candidate| matches!(candidate.kind, EventKind::Pocket { .. }))
    {
        let EventKind::Pocket { ball, pocket } = candidate.kind else {
            continue;
        };
        if !balls[ball].active() {
            continue;
        }
        let pocket = &geometry.pockets[pocket];
        balls[ball].position = pocket.center;
        balls[ball].z = 0.0;
        balls[ball].velocity = Vec2::ZERO;
        balls[ball].vertical_velocity = 0.0;
        balls[ball].spin = [0.0; 3];
        balls[ball].state = MotionState::Pocketed;
        balls[ball].pocketed = true;
        pocketed_ball_ids.push(balls[ball].source.id.clone());
        events.push(SimulationEvent {
            at_seconds: quantize(current_time, INTERNAL_QUANTUM),
            kind: "ball_pocket".to_owned(),
            ball_ids: vec![balls[ball].source.id.clone()],
            geometry_id: Some(pocket.id.clone()),
        });
    }

    let mut constraints = Vec::new();
    for candidate in &candidates {
        match candidate.kind {
            EventKind::BallBall { first, second }
                if balls[first].active() && balls[second].active() =>
            {
                let delta = balls[first].position - balls[second].position;
                let normal = if delta.length() <= EPSILON {
                    if balls[first].source.id < balls[second].source.id {
                        Vec2::new(-1.0, 0.0)
                    } else {
                        Vec2::new(1.0, 0.0)
                    }
                } else {
                    delta.normalized()
                };
                let mut ids = [
                    balls[first].source.id.as_str(),
                    balls[second].source.id.as_str(),
                ];
                ids.sort_unstable();
                constraints.push(ContactConstraint {
                    first,
                    second: ContactBody::Ball(second),
                    static_geometry: None,
                    normal,
                    restitution: BALL_RESTITUTION,
                    friction: BALL_FRICTION,
                    stable_key: format!("ball:{}:{}", ids[0], ids[1]),
                });
                events.push(SimulationEvent {
                    at_seconds: quantize(current_time, INTERNAL_QUANTUM),
                    kind: "ball_ball".to_owned(),
                    ball_ids: vec![ids[0].to_owned(), ids[1].to_owned()],
                    geometry_id: None,
                });
            }
            EventKind::LinearCushion { ball, cushion } if balls[ball].active() => {
                let cushion = &geometry.linear_cushions[cushion];
                constraints.push(ContactConstraint {
                    first: ball,
                    second: ContactBody::Static,
                    static_geometry: Some(StaticContactGeometry::Linear {
                        start: cushion.start,
                        inward_normal: cushion.inward_normal,
                        offset: radius,
                    }),
                    normal: cushion.inward_normal,
                    restitution: surface.cushion_restitution,
                    friction: surface.cushion_friction,
                    stable_key: format!("linear:{}:{}", balls[ball].source.id, cushion.id),
                });
                record_rail_contact(
                    ball,
                    &cushion.id,
                    current_time,
                    balls,
                    events,
                    rail_contact_ball_ids,
                    rail_contact_set,
                    post_contact_rail_ball_ids,
                    post_contact_rail_set,
                    !first_contact_ball_ids.is_empty(),
                );
            }
            EventKind::CircularCushion { ball, cushion } if balls[ball].active() => {
                let cushion = &geometry.circular_cushions[cushion];
                let delta = balls[ball].position - cushion.center;
                let normal = if delta.length() <= EPSILON {
                    Vec2::new(1.0, 0.0)
                } else {
                    delta.normalized()
                };
                constraints.push(ContactConstraint {
                    first: ball,
                    second: ContactBody::Static,
                    static_geometry: Some(StaticContactGeometry::Circular {
                        center: cushion.center,
                        contact_radius: radius + cushion.radius,
                    }),
                    normal,
                    restitution: surface.cushion_restitution,
                    friction: surface.cushion_friction,
                    stable_key: format!("circular:{}:{}", balls[ball].source.id, cushion.id),
                });
                record_rail_contact(
                    ball,
                    &cushion.id,
                    current_time,
                    balls,
                    events,
                    rail_contact_ball_ids,
                    rail_contact_set,
                    post_contact_rail_ball_ids,
                    post_contact_rail_set,
                    !first_contact_ball_ids.is_empty(),
                );
            }
            _ => {}
        }
    }
    constraints.sort_by(|first, second| first.stable_key.cmp(&second.stable_key));
    solve_contacts(
        &constraints,
        balls,
        geometry.table.ball_mass,
        radius,
        surface,
    );

    for candidate in candidates
        .iter()
        .filter(|candidate| matches!(candidate.kind, EventKind::SafetyBoundary { .. }))
    {
        let EventKind::SafetyBoundary { ball, normal, id } = candidate.kind else {
            continue;
        };
        if !balls[ball].active() {
            continue;
        }
        let incoming = balls[ball].velocity.dot(normal);
        if incoming < 0.0 {
            let high = balls[ball].z > geometry.table.ball_diameter * CUSHION_NOSE_HEIGHT_FACTOR;
            let restitution = if high { 0.45 } else { 0.62 };
            balls[ball].velocity -= normal * ((1.0 + restitution) * incoming);
            if high {
                balls[ball].spin[0] = -balls[ball].velocity.y / radius;
                balls[ball].spin[1] = balls[ball].velocity.x / radius;
            }
            events.push(SimulationEvent {
                at_seconds: quantize(current_time, INTERNAL_QUANTUM),
                kind: if high {
                    "safety_boundary".to_owned()
                } else {
                    "ball_off_table".to_owned()
                },
                ball_ids: vec![balls[ball].source.id.clone()],
                geometry_id: Some(id.to_owned()),
            });
        }
    }

    for candidate in candidates
        .iter()
        .filter(|candidate| matches!(candidate.kind, EventKind::Transition { .. }))
    {
        let EventKind::Transition { ball, from } = candidate.kind else {
            continue;
        };
        if !balls[ball].active() || balls[ball].state != from {
            continue;
        }
        apply_transition(&mut balls[ball], from, radius);
        events.push(SimulationEvent {
            at_seconds: quantize(current_time, INTERNAL_QUANTUM),
            kind: transition_name(from, balls[ball].state).to_owned(),
            ball_ids: vec![balls[ball].source.id.clone()],
            geometry_id: None,
        });
    }

    for constraint in constraints {
        balls[constraint.first].state = classify_surface_motion(&balls[constraint.first], radius);
        if let ContactBody::Ball(second) = constraint.second {
            balls[second].state = classify_surface_motion(&balls[second], radius);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn record_rail_contact(
    ball: usize,
    geometry_id: &str,
    current_time: f64,
    balls: &[DynamicBall],
    events: &mut Vec<SimulationEvent>,
    rail_contact_ball_ids: &mut Vec<String>,
    rail_contact_set: &mut HashSet<String>,
    post_contact_rail_ball_ids: &mut Vec<String>,
    post_contact_rail_set: &mut HashSet<String>,
    post_contact: bool,
) {
    let id = balls[ball].source.id.clone();
    if rail_contact_set.insert(id.clone()) {
        rail_contact_ball_ids.push(id.clone());
    }
    if post_contact && post_contact_rail_set.insert(id.clone()) {
        post_contact_rail_ball_ids.push(id.clone());
    }
    events.push(SimulationEvent {
        at_seconds: quantize(current_time, INTERNAL_QUANTUM),
        kind: "ball_cushion".to_owned(),
        ball_ids: vec![id],
        geometry_id: Some(geometry_id.to_owned()),
    });
}

fn solve_contacts(
    constraints: &[ContactConstraint],
    balls: &mut [DynamicBall],
    mass: f64,
    radius: f64,
    surface: &SurfaceParameters,
) {
    if constraints.is_empty() {
        return;
    }
    let inverse_mass = 1.0 / mass;
    let inertia = 0.4 * mass * radius * radius;
    let mut accumulated_normal = vec![0.0_f64; constraints.len()];
    let mut accumulated_tangent = vec![0.0_f64; constraints.len()];
    let restitution_targets: Vec<f64> = constraints
        .iter()
        .map(|constraint| {
            let first_velocity = balls[constraint.first].velocity;
            let second_velocity = match constraint.second {
                ContactBody::Ball(index) => balls[index].velocity,
                ContactBody::Static => Vec2::ZERO,
            };
            let closing_speed = -(first_velocity - second_velocity)
                .dot(constraint.normal)
                .min(0.0);
            if closing_speed >= RESTING_CONTACT_SPEED {
                constraint.restitution * closing_speed
            } else {
                0.0
            }
        })
        .collect();
    for _ in 0..24 {
        for (constraint_index, constraint) in constraints.iter().enumerate() {
            let first_velocity = balls[constraint.first].velocity;
            let second_velocity = match constraint.second {
                ContactBody::Ball(index) => balls[index].velocity,
                ContactBody::Static => Vec2::ZERO,
            };
            let relative = first_velocity - second_velocity;
            let normal_velocity = relative.dot(constraint.normal);
            let second_inverse_mass = match constraint.second {
                ContactBody::Ball(_) => inverse_mass,
                ContactBody::Static => 0.0,
            };
            let desired = restitution_targets[constraint_index];
            let delta_normal = (desired - normal_velocity) / (inverse_mass + second_inverse_mass);
            let new_normal = (accumulated_normal[constraint_index] + delta_normal).max(0.0);
            let applied_normal = new_normal - accumulated_normal[constraint_index];
            accumulated_normal[constraint_index] = new_normal;
            apply_linear_impulse(
                balls,
                constraint.first,
                constraint.second,
                constraint.normal * applied_normal,
                inverse_mass,
                second_inverse_mass,
            );

            let tangent = constraint.normal.perpendicular();
            let first_surface = balls[constraint.first].velocity.dot(tangent)
                - balls[constraint.first].spin[2] * radius;
            let (second_surface, rotational_terms) = match constraint.second {
                ContactBody::Ball(index) => (
                    balls[index].velocity.dot(tangent) + balls[index].spin[2] * radius,
                    2.0 * radius * radius / inertia,
                ),
                ContactBody::Static => (0.0, radius * radius / inertia),
            };
            let tangent_velocity = first_surface - second_surface;
            let tangent_mass = inverse_mass + second_inverse_mass + rotational_terms;
            let delta_tangent = -tangent_velocity / tangent_mass;
            let maximum_tangent = constraint.friction * accumulated_normal[constraint_index];
            let new_tangent = clamp(
                accumulated_tangent[constraint_index] + delta_tangent,
                -maximum_tangent,
                maximum_tangent,
            );
            let applied_tangent = new_tangent - accumulated_tangent[constraint_index];
            accumulated_tangent[constraint_index] = new_tangent;
            let impulse = tangent * applied_tangent;
            apply_linear_impulse(
                balls,
                constraint.first,
                constraint.second,
                impulse,
                inverse_mass,
                second_inverse_mass,
            );
            balls[constraint.first].spin[2] -= applied_tangent * radius / inertia;
            if let ContactBody::Ball(second) = constraint.second {
                balls[second].spin[2] -= applied_tangent * radius / inertia;
            } else {
                let inward_roll = balls[constraint.first].spin[0] * constraint.normal.x
                    + balls[constraint.first].spin[1] * constraint.normal.y;
                balls[constraint.first].spin[0] -=
                    constraint.normal.x * inward_roll * surface.cushion_roll_disturbance / 24.0;
                balls[constraint.first].spin[1] -=
                    constraint.normal.y * inward_roll * surface.cushion_roll_disturbance / 24.0;
            }
        }
    }

    for constraint in constraints {
        if let ContactBody::Ball(second) = constraint.second {
            let separating_speed =
                (balls[constraint.first].velocity - balls[second].velocity).dot(constraint.normal);
            if separating_speed <= RESTING_CONTACT_SPEED {
                stabilize_slow_contact_spin(
                    &mut balls[constraint.first],
                    constraint.normal,
                    radius,
                );
                stabilize_slow_contact_spin(&mut balls[second], -constraint.normal, radius);
            }
        } else {
            if balls[constraint.first].velocity.dot(constraint.normal) <= RESTING_CONTACT_SPEED {
                stabilize_slow_contact_spin(
                    &mut balls[constraint.first],
                    constraint.normal,
                    radius,
                );
            }
            if balls[constraint.first].velocity.length() < STOP_SPEED * 1.25 {
                balls[constraint.first].velocity = Vec2::ZERO;
            }
        }
    }
    separate_contact_manifold(constraints, balls, radius);
}

fn separate_contact_manifold(
    constraints: &[ContactConstraint],
    balls: &mut [DynamicBall],
    radius: f64,
) {
    // Resolving one member of a simultaneous jaw/knuckle manifold can push the
    // ball back into another member. Re-project the complete manifold in its
    // deterministic constraint order instead of relying on a fixed nudge.
    for _ in 0..8 {
        let mut corrected = false;
        for constraint in constraints {
            match constraint.second {
                ContactBody::Ball(second) => {
                    let delta = balls[constraint.first].position - balls[second].position;
                    let distance = delta.length();
                    let target = radius * 2.0 + CONTACT_SEPARATION;
                    if distance >= target {
                        continue;
                    }
                    let normal = if distance <= EPSILON {
                        constraint.normal
                    } else {
                        delta / distance
                    };
                    let correction = normal * ((target - distance) * 0.5);
                    balls[constraint.first].position += correction;
                    balls[second].position -= correction;
                    corrected = true;
                }
                ContactBody::Static => match constraint.static_geometry {
                    Some(StaticContactGeometry::Linear {
                        start,
                        inward_normal,
                        offset,
                    }) => {
                        let distance =
                            (balls[constraint.first].position - start).dot(inward_normal);
                        let target = offset + CONTACT_SEPARATION;
                        if distance < target {
                            balls[constraint.first].position += inward_normal * (target - distance);
                            corrected = true;
                        }
                    }
                    Some(StaticContactGeometry::Circular {
                        center,
                        contact_radius,
                    }) => {
                        let delta = balls[constraint.first].position - center;
                        let distance = delta.length();
                        let target = contact_radius + CONTACT_SEPARATION;
                        if distance < target {
                            let normal = if distance <= EPSILON {
                                constraint.normal
                            } else {
                                delta / distance
                            };
                            balls[constraint.first].position += normal * (target - distance);
                            corrected = true;
                        }
                    }
                    None => {}
                },
            }
        }
        if !corrected {
            break;
        }
    }
}

fn stabilize_slow_contact_spin(ball: &mut DynamicBall, normal: Vec2, radius: f64) {
    // A collision changes the centre velocity before cloth evolution resumes.
    // At resting-contact speeds, retaining the incoming rolling axis verbatim
    // can leave the cloth contact-point slip aimed along the separating normal,
    // so cloth friction points straight back into the collider and creates an
    // artificial micro-bounce loop.
    //
    // Remove only that inward slip component. Tangential slip and side spin are
    // preserved, so running/check side still evolves after the rebound.
    let slip = slip_velocity(ball, radius);
    let inward_slip = slip.dot(normal);
    if inward_slip <= 0.0 {
        return;
    }
    let stabilized_slip = slip - normal * inward_slip;
    ball.spin[0] = (stabilized_slip.y - ball.velocity.y) / radius;
    ball.spin[1] = (ball.velocity.x - stabilized_slip.x) / radius;
}

fn apply_linear_impulse(
    balls: &mut [DynamicBall],
    first: usize,
    second: ContactBody,
    impulse: Vec2,
    first_inverse_mass: f64,
    second_inverse_mass: f64,
) {
    balls[first].velocity += impulse * first_inverse_mass;
    if let ContactBody::Ball(index) = second {
        balls[index].velocity -= impulse * second_inverse_mass;
    }
}

fn apply_transition(ball: &mut DynamicBall, from: MotionState, radius: f64) {
    match from {
        MotionState::Sliding => {
            ball.spin[0] = -ball.velocity.y / radius;
            ball.spin[1] = ball.velocity.x / radius;
            ball.state = if ball.velocity.length() >= STOP_SPEED {
                MotionState::Rolling
            } else if ball.spin[2].abs() * radius >= STOP_SURFACE_SPIN_SPEED {
                MotionState::Spinning
            } else {
                MotionState::Stationary
            };
        }
        MotionState::Rolling => {
            ball.velocity = Vec2::ZERO;
            ball.spin[0] = 0.0;
            ball.spin[1] = 0.0;
            ball.state = if ball.spin[2].abs() * radius >= STOP_SURFACE_SPIN_SPEED {
                MotionState::Spinning
            } else {
                ball.spin[2] = 0.0;
                MotionState::Stationary
            };
        }
        MotionState::Spinning => {
            ball.spin[2] = 0.0;
            ball.state = MotionState::Stationary;
        }
        MotionState::Airborne => {
            ball.z = 0.0;
            if ball.vertical_velocity < -0.45 {
                ball.vertical_velocity = -ball.vertical_velocity * 0.12;
                ball.state = MotionState::Airborne;
            } else {
                ball.vertical_velocity = 0.0;
                ball.state = classify_surface_motion(ball, radius);
            }
        }
        MotionState::Stationary | MotionState::Pocketed => {}
    }
}

fn transition_name(from: MotionState, to: MotionState) -> &'static str {
    match (from, to) {
        (MotionState::Sliding, MotionState::Rolling) => "sliding_rolling",
        (MotionState::Rolling, MotionState::Spinning) => "rolling_spinning",
        (MotionState::Rolling, MotionState::Stationary) => "rolling_stationary",
        (MotionState::Spinning, MotionState::Stationary) => "spinning_stationary",
        (MotionState::Airborne, MotionState::Airborne) => "ball_table_bounce",
        (MotionState::Airborne, _) => "airborne_surface",
        _ => "motion_transition",
    }
}

fn evolve_all(
    balls: &mut [DynamicBall],
    time: f64,
    surface: &SurfaceParameters,
    radius: f64,
    cue_strike: CueStrikeDiagnostics,
) {
    for ball in balls {
        evolve_ball(ball, time, surface, radius, cue_strike);
    }
}

fn evolve_ball(
    ball: &mut DynamicBall,
    time: f64,
    surface: &SurfaceParameters,
    radius: f64,
    cue_strike: CueStrikeDiagnostics,
) {
    if !ball.active() || time <= 0.0 {
        return;
    }
    let motion = kinematics(ball, surface, radius, cue_strike);
    let initial_velocity = ball.velocity;
    ball.position += initial_velocity * time + motion.acceleration * (0.5 * time * time);
    ball.velocity += motion.acceleration * time;
    ball.spin[0] += motion.angular_acceleration.x * time;
    ball.spin[1] += motion.angular_acceleration.y * time;
    ball.spin[2] *= (-surface.side_spin_damping * time).exp();
    if ball.state == MotionState::Rolling {
        if ball.velocity.dot(initial_velocity) <= 0.0 {
            ball.velocity = Vec2::ZERO;
        }
        ball.spin[0] = -ball.velocity.y / radius;
        ball.spin[1] = ball.velocity.x / radius;
    }
    if ball.state == MotionState::Airborne {
        ball.z += ball.vertical_velocity * time - 0.5 * GRAVITY * time * time;
        ball.vertical_velocity -= GRAVITY * time;
        ball.z = ball.z.max(0.0);
    }
    let average_velocity = (initial_velocity + ball.velocity) * 0.5;
    let speed = average_velocity.length();
    let rolling_rate = if speed > EPSILON {
        (-ball.spin[0] * average_velocity.y + ball.spin[1] * average_velocity.x) / speed
    } else {
        0.0
    };
    ball.rotation += (rolling_rate + ball.spin[2] * 0.14) * time;
}

fn all_at_rest(balls: &[DynamicBall], radius: f64) -> bool {
    balls.iter().all(|ball| {
        !ball.active()
            || (ball.z <= EPSILON
                && ball.vertical_velocity.abs() < STOP_SPEED
                && ball.velocity.length() < STOP_SPEED
                && slip_velocity(ball, radius).length() < STOP_SPEED
                && ball.spin[2].abs() * radius < STOP_SURFACE_SPIN_SPEED)
    })
}

fn settle_all(balls: &mut [DynamicBall]) {
    for ball in balls {
        if !ball.active() {
            continue;
        }
        ball.velocity = Vec2::ZERO;
        ball.vertical_velocity = 0.0;
        ball.spin = [0.0; 3];
        ball.z = 0.0;
        ball.state = MotionState::Stationary;
    }
}

fn sanitize_all(balls: &mut [DynamicBall], table: &TableSpec) {
    let radius = table.ball_diameter * 0.5;
    for ball in balls {
        if !ball.active() {
            continue;
        }
        ball.position.x = quantize(
            clamp(ball.position.x, -radius, table.width + radius),
            INTERNAL_QUANTUM,
        );
        ball.position.y = quantize(
            clamp(ball.position.y, -radius, table.height + radius),
            INTERNAL_QUANTUM,
        );
        ball.velocity.x = quantize(clamp(ball.velocity.x, -12.0, 12.0), INTERNAL_QUANTUM);
        ball.velocity.y = quantize(clamp(ball.velocity.y, -12.0, 12.0), INTERNAL_QUANTUM);
        ball.vertical_velocity =
            quantize(clamp(ball.vertical_velocity, -5.0, 5.0), INTERNAL_QUANTUM);
        ball.z = quantize(clamp(ball.z, 0.0, 0.5), INTERNAL_QUANTUM);
        for spin in &mut ball.spin {
            *spin = quantize(clamp(*spin, -1_500.0, 1_500.0), INTERNAL_QUANTUM);
        }
        ball.rotation = quantize(ball.rotation, INTERNAL_QUANTUM);
    }
}

fn make_frame(
    at_ms: u32,
    source: &[Ball],
    balls: &[DynamicBall],
    indices_by_id: &HashMap<String, usize>,
) -> SimulationFrame {
    SimulationFrame {
        at_ms,
        balls: source
            .iter()
            .map(|ball| {
                indices_by_id
                    .get(&ball.id)
                    .and_then(|index| balls.get(*index))
                    .map(frame_ball)
                    .unwrap_or_else(|| SimulationBallFrame {
                        id: ball.id.clone(),
                        pocketed: ball.pocketed,
                        rotation: normalize_rotation(ball.rotation),
                        spin_x: 0.0,
                        spin_y: 0.0,
                        spin_z: 0.0,
                        state: if ball.pocketed {
                            MotionState::Pocketed
                        } else {
                            MotionState::Stationary
                        },
                        x: quantize(ball.x, OUTPUT_QUANTUM),
                        y: quantize(ball.y, OUTPUT_QUANTUM),
                        z: 0.0,
                    })
            })
            .collect(),
    }
}

fn frame_ball(ball: &DynamicBall) -> SimulationBallFrame {
    SimulationBallFrame {
        id: ball.source.id.clone(),
        pocketed: ball.pocketed,
        rotation: normalize_rotation(ball.rotation),
        spin_x: quantize(ball.spin[0], OUTPUT_QUANTUM),
        spin_y: quantize(ball.spin[1], OUTPUT_QUANTUM),
        spin_z: quantize(ball.spin[2], OUTPUT_QUANTUM),
        state: ball.state,
        x: quantize(ball.position.x, OUTPUT_QUANTUM),
        y: quantize(ball.position.y, OUTPUT_QUANTUM),
        z: quantize(ball.z, OUTPUT_QUANTUM),
    }
}

#[allow(clippy::too_many_arguments)]
fn record_frames_between(
    frames: &mut Vec<SimulationFrame>,
    next_frame_time: &mut f64,
    current_time: f64,
    duration: f64,
    source: &[Ball],
    balls: &[DynamicBall],
    indices_by_id: &HashMap<String, usize>,
    surface: &SurfaceParameters,
    radius: f64,
    cue_strike: CueStrikeDiagnostics,
) {
    let event_time = current_time + duration;
    while *next_frame_time <= event_time + EVENT_TIME_EPSILON {
        let offset = (*next_frame_time - current_time).clamp(0.0, duration);
        let mut sampled = balls.to_vec();
        evolve_all(&mut sampled, offset, surface, radius, cue_strike);
        frames.push(make_frame(
            (*next_frame_time * 1_000.0).round() as u32,
            source,
            &sampled,
            indices_by_id,
        ));
        *next_frame_time += FRAME_INTERVAL_SECONDS;
    }
}

fn final_balls(
    source: &[Ball],
    balls: &[DynamicBall],
    indices_by_id: &HashMap<String, usize>,
) -> Vec<Ball> {
    source
        .iter()
        .map(|ball| {
            let Some(dynamic) = indices_by_id
                .get(&ball.id)
                .and_then(|index| balls.get(*index))
            else {
                return ball.clone();
            };
            Ball {
                id: ball.id.clone(),
                kind: ball.kind,
                number: ball.number,
                pocketed: dynamic.pocketed,
                rotation: normalize_rotation(dynamic.rotation),
                value: ball.value,
                x: quantize(clamp(dynamic.position.x, 0.0, 4.0), OUTPUT_QUANTUM),
                y: quantize(clamp(dynamic.position.y, 0.0, 2.0), OUTPUT_QUANTUM),
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn record_jump_crossings(
    tracker: &mut JumpTracker,
    cue_index: usize,
    balls: &[DynamicBall],
    duration: f64,
    surface: &SurfaceParameters,
    radius: f64,
    cue_strike: CueStrikeDiagnostics,
    contacted: &HashSet<String>,
) {
    if duration <= 0.0 || !balls[cue_index].active() {
        return;
    }
    let steps = (duration / JUMP_PROBE_INTERVAL_SECONDS).ceil().max(1.0) as usize;
    for step in 1..=steps {
        let time = duration * step as f64 / steps as f64;
        let mut sampled = balls.to_vec();
        evolve_all(&mut sampled, time, surface, radius, cue_strike);
        update_jump_tracker(tracker, cue_index, &sampled, radius, contacted);
    }
}

fn update_jump_tracker(
    tracker: &mut JumpTracker,
    cue_index: usize,
    balls: &[DynamicBall],
    radius: f64,
    contacted: &HashSet<String>,
) {
    let cue = &balls[cue_index];
    if cue.z <= 0.0 || !cue.active() {
        tracker.approaches.clear();
        return;
    }
    let diameter = radius * 2.0;
    let diameter_squared = diameter * diameter;
    for target in balls {
        if target.source.kind == BallKind::Cue
            || !target.active()
            || contacted.contains(&target.source.id)
        {
            tracker.approaches.remove(&target.source.id);
            continue;
        }
        let delta = cue.position - target.position;
        let projected = delta.length_squared();
        if projected >= diameter_squared || cue.z <= target.z {
            tracker.approaches.remove(&target.source.id);
            continue;
        }
        let approach = tracker
            .approaches
            .entry(target.source.id.clone())
            .or_insert_with(|| -delta.normalized());
        let reached_far_side = delta.dot(*approach) >= 0.0;
        let vertical = cue.z - target.z;
        let physically_separated =
            projected + vertical * vertical > diameter_squared + INTERNAL_QUANTUM;
        if reached_far_side && physically_separated {
            tracker.jumped.insert(target.source.id.clone());
            tracker.approaches.remove(&target.source.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::BilliardsMode;

    fn ball(id: &str, kind: BallKind, x: f64, y: f64) -> Ball {
        Ball {
            id: id.to_owned(),
            kind,
            number: None,
            pocketed: false,
            rotation: 0.0,
            value: 1,
            x,
            y,
        }
    }

    fn shot() -> Shot {
        Shot {
            angle: 0.0,
            elevation: 0.0,
            nominated_color: None,
            power: 55.0,
            tip: crate::model::CueTip { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn deterministic_ball_contact() {
        let input = SimulateShotInput {
            balls: vec![
                ball("cue", BallKind::Cue, 0.45, 0.63),
                ball("one", BallKind::Solid, 0.92, 0.63),
            ],
            capture_frames: true,
            mode: BilliardsMode::ChineseEightBall,
            shot: shot(),
            spin_convergence: None,
            table_friction: None,
        };
        let first = simulate_shot(input.clone()).expect("simulation should succeed");
        let second = simulate_shot(input).expect("simulation should succeed");
        assert_eq!(first, second);
        assert_eq!(first.first_contact_ball_ids, ["one"]);
    }

    #[test]
    fn dense_rack_break_finishes_without_contact_chatter() {
        let mut balls =
            crate::rules::create_chinese_eight_ball_rack().expect("rack should be available");
        let cue = balls
            .iter_mut()
            .find(|ball| ball.kind == BallKind::Cue)
            .expect("rack should contain a cue ball");
        cue.x = 0.635;
        cue.y = 0.63;
        cue.pocketed = false;

        let result = simulate_shot(SimulateShotInput {
            balls,
            capture_frames: false,
            mode: BilliardsMode::ChineseEightBall,
            shot: Shot {
                power: 80.0,
                ..shot()
            },
            spin_convergence: None,
            table_friction: None,
        })
        .expect("a dense rack break must finish within the event budget");

        assert!(
            result.events.len() < 1_000,
            "dense rack break produced {} events",
            result.events.len()
        );
        assert!(
            result.pocketed_ball_ids.len() <= 4,
            "standard straight break pocketed {:?}",
            result.pocketed_ball_ids
        );
        assert_eq!(result.first_contact_ball_ids, ["1"]);

        let geometry = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        let circular_ids: HashSet<&str> = geometry
            .circular_cushions
            .iter()
            .map(|cushion| cushion.id.as_str())
            .collect();
        let mut last_circular_contact = HashMap::<(String, String), f64>::new();
        for event in &result.events {
            let Some(geometry_id) = event.geometry_id.as_deref() else {
                continue;
            };
            if event.kind != "ball_cushion" || !circular_ids.contains(geometry_id) {
                continue;
            }
            let Some(ball_id) = event.ball_ids.first() else {
                continue;
            };
            let key = (ball_id.clone(), geometry_id.to_owned());
            if let Some(previous) = last_circular_contact.insert(key.clone(), event.at_seconds) {
                assert!(
                    event.at_seconds - previous >= 0.001,
                    "circular contact {key:?} repeated after {} seconds",
                    event.at_seconds - previous
                );
            }
        }
    }

    #[test]
    fn touching_ball_chain_does_not_micro_bounce_to_the_event_limit() {
        let diameter = 0.05715;
        let result = simulate_shot(SimulateShotInput {
            balls: vec![
                ball("cue", BallKind::Cue, 0.4, 0.63),
                ball("one", BallKind::Solid, 0.8, 0.63),
                ball("nine", BallKind::Stripe, 0.8 + diameter, 0.63),
                ball("two", BallKind::Solid, 0.8 + diameter * 2.0, 0.63),
            ],
            capture_frames: false,
            mode: BilliardsMode::ChineseEightBall,
            shot: Shot {
                power: 45.0,
                ..shot()
            },
            spin_convergence: None,
            table_friction: None,
        })
        .expect("a touching contact chain must settle deterministically");

        assert!(
            result.events.len() < 100,
            "touching contact chain produced {} events",
            result.events.len()
        );
        assert_eq!(result.first_contact_ball_ids, ["one"]);
    }

    #[test]
    fn event_budget_exhaustion_is_a_stable_error() {
        let error = simulate_shot_with_event_limit(
            SimulateShotInput {
                balls: vec![
                    ball("cue", BallKind::Cue, 0.45, 0.63),
                    ball("one", BallKind::Solid, 0.92, 0.63),
                ],
                capture_frames: false,
                mode: BilliardsMode::ChineseEightBall,
                shot: shot(),
                spin_convergence: None,
                table_friction: None,
            },
            1,
        )
        .expect_err("one event is insufficient to finish the shot");

        assert_eq!(error.code, "PHYSICS_EVENT_LIMIT_EXCEEDED");
    }

    #[test]
    fn side_spin_curves_in_opposite_directions() {
        let make = |tip_x| SimulateShotInput {
            balls: vec![ball("cue", BallKind::Cue, 0.55, 0.63)],
            capture_frames: true,
            mode: BilliardsMode::ChineseEightBall,
            shot: Shot {
                tip: crate::model::CueTip { x: tip_x, y: 0.0 },
                ..shot()
            },
            spin_convergence: None,
            table_friction: None,
        };
        let left = simulate_shot(make(-0.8)).expect("left simulation");
        let right = simulate_shot(make(0.8)).expect("right simulation");
        let left_y = left.frames.as_ref().unwrap()[20].balls[0].y;
        let right_y = right.frames.as_ref().unwrap()[20].balls[0].y;
        assert!(left_y > right_y);
    }
}
