use crate::api::CoreError;
use crate::geometry::{Aabb, CircularCushion, CushionDirection, LinearCushion, TableGeometry};
use crate::math::{EPSILON, Vec2, Vec3, clamp, normalize_rotation, quantize, roots_in_interval};
use crate::model::{
    Ball, BallKind, BallParameters, BilliardsMode, CueStrikeDiagnostics, DynamicBall, MotionState,
    PHYSICS_VERSION, PredictShotInput, PredictedBallPath, PredictedPathPoint, Shot,
    ShotSimulationResult, SimulateShotInput, SimulationBallFrame, SimulationEvent, SimulationFrame,
    TableSpec, TrajectoryPrediction,
};
use crate::replay::{legacy_checksum, state_hash};
use crate::stronge;
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};

const FRAME_INTERVAL_SECONDS: f64 = 1.0 / 60.0;
const MAX_EVENTS: usize = 50_000;
const MIN_DIST: f64 = 1.0e-6;
const OUTPUT_QUANTUM: f64 = 1.0e-6;
const EVENT_QUANTUM: f64 = 1.0e-10;
const ROOT_HORIZON_PAD: f64 = 1.0e-10;
const CUE_SPEED_AT_HALF_POWER: f64 = 2.0;
const CUSHION_OMEGA_RATIO: f64 = 1.8;

#[derive(Clone, Copy, Debug)]
struct CueParameters {
    mass: f64,
    // Stored by Pooltool's cue specs. The fixed InstantaneousPoint2D solver at
    // the pinned revision does not apply tip-radius contact scaling.
    #[allow(dead_code)]
    tip_radius: f64,
    end_mass: f64,
}

impl CueParameters {
    fn for_mode(mode: BilliardsMode) -> Self {
        match mode {
            BilliardsMode::ChineseEightBall => Self {
                mass: 0.567,
                tip_radius: 0.010_604_5,
                end_mass: 0.170_097 / 30.0,
            },
            BilliardsMode::Snooker => Self {
                mass: 0.478,
                tip_radius: 0.010_604_5,
                end_mass: 0.140 / 30.0,
            },
        }
    }
}

pub fn ball_parameters(mode: BilliardsMode) -> BallParameters {
    let (mass, radius, sliding_friction, cushion_friction) = match mode {
        BilliardsMode::ChineseEightBall => (0.170_097, 0.028_575, 0.2, 0.2),
        BilliardsMode::Snooker => (0.140, 0.026_193_75, 0.5, 0.5),
    };
    BallParameters {
        mass,
        radius,
        sliding_friction,
        rolling_friction: 0.01,
        spinning_friction: (4.0 / 9.0) * radius,
        ball_restitution: 0.95,
        table_restitution: 0.5,
        cushion_restitution: 0.85,
        cushion_friction,
        gravity: 9.81,
    }
}

#[derive(Clone, Copy, Debug)]
struct Kinematics {
    velocity: Vec3,
    acceleration: Vec3,
}

#[derive(Clone, Copy, Debug)]
enum TransitionKind {
    SlidingRolling,
    RollingSpinning,
    RollingStationary,
    SpinningStationary,
}

impl TransitionKind {
    fn name(self) -> &'static str {
        match self {
            Self::SlidingRolling => "sliding_rolling",
            Self::RollingSpinning => "rolling_spinning",
            Self::RollingStationary => "rolling_stationary",
            Self::SpinningStationary => "spinning_stationary",
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum EventKind {
    Transition {
        ball: usize,
        transition: TransitionKind,
    },
    Pocket {
        ball: usize,
        pocket: usize,
    },
    LinearCushion {
        ball: usize,
        cushion: usize,
    },
    CircularCushion {
        ball: usize,
        cushion: usize,
    },
    BallBall {
        first: usize,
        second: usize,
    },
    BallTable {
        ball: usize,
    },
}

#[derive(Clone, Copy, Debug)]
struct CandidateEvent {
    time: f64,
    kind: EventKind,
}

impl CandidateEvent {
    fn tier(self) -> u8 {
        match self.kind {
            EventKind::Transition { .. } | EventKind::Pocket { .. } => 2,
            EventKind::LinearCushion { .. }
            | EventKind::CircularCushion { .. }
            | EventKind::BallBall { .. }
            | EventKind::BallTable { .. } => 3,
        }
    }

    fn energy(self, balls: &[DynamicBall], params: BallParameters) -> f64 {
        match self.kind {
            EventKind::BallBall { first, second } => {
                (balls[first].velocity - balls[second].velocity).length_squared()
            }
            EventKind::Transition { ball, .. }
            | EventKind::Pocket { ball, .. }
            | EventKind::LinearCushion { ball, .. }
            | EventKind::CircularCushion { ball, .. }
            | EventKind::BallTable { ball } => ball_energy(&balls[ball], params),
        }
    }
}

pub fn simulate_shot(input: SimulateShotInput) -> Result<ShotSimulationResult, CoreError> {
    validate_input(&input)?;
    let geometry = TableGeometry::for_mode(input.mode);
    let parameters = ball_parameters(input.mode);
    let (mut balls, indices_by_id) = dynamic_balls(&input.balls, &geometry.table, parameters);
    let cue_index = balls
        .iter()
        .position(|ball| ball.source.kind == BallKind::Cue && ball.active())
        .ok_or_else(|| {
            CoreError::invalid(
                "CUE_BALL_NOT_ON_TABLE",
                "the cue ball must be placed before a shot",
            )
        })?;
    let cue_strike = apply_cue_strike(&mut balls[cue_index], &input.shot, input.mode, parameters);

    let mut events = vec![SimulationEvent {
        at_seconds: 0.0,
        kind: "stick_ball".to_owned(),
        ball_ids: vec![balls[cue_index].source.id.clone()],
        geometry_id: Some("cue_stick".to_owned()),
    }];
    let mut frames = input.capture_frames.then(|| {
        vec![make_frame(
            0,
            &input.balls,
            &balls,
            &indices_by_id,
            parameters,
        )]
    });
    let mut next_frame_time = FRAME_INTERVAL_SECONDS;
    let mut current_time = 0.0;
    let mut pocketed_ball_ids = Vec::new();
    let mut rail_contact_ball_ids = Vec::new();
    let mut rail_contact_set = HashSet::new();
    let mut post_contact_rail_ball_ids = Vec::new();
    let mut post_contact_rail_set = HashSet::new();
    let mut first_contact_ball_ids = Vec::new();
    let mut first_contact_time = None;

    let mut completed = false;
    for _ in 0..MAX_EVENTS {
        let Some(candidate) = predict_next_event(&balls, &geometry, parameters) else {
            completed = true;
            break;
        };
        if !candidate.time.is_finite() || candidate.time < 0.0 {
            return Err(CoreError::internal(
                "INVALID_EVENT_TIME",
                "the event detector produced an invalid time",
            ));
        }

        if let Some(captured) = frames.as_mut() {
            record_frames_between(
                captured,
                &mut next_frame_time,
                current_time,
                candidate.time,
                &input.balls,
                &balls,
                &indices_by_id,
                parameters,
            );
        }
        evolve_all(&mut balls, candidate.time, parameters);
        current_time += candidate.time;
        resolve_event(
            candidate.kind,
            current_time,
            &mut balls,
            &geometry,
            parameters,
            cue_index,
            &mut events,
            &mut pocketed_ball_ids,
            &mut rail_contact_ball_ids,
            &mut rail_contact_set,
            &mut post_contact_rail_ball_ids,
            &mut post_contact_rail_set,
            &mut first_contact_ball_ids,
            &mut first_contact_time,
        );
    }
    if !completed {
        return Err(CoreError::internal(
            "PHYSICS_EVENT_LIMIT_EXCEEDED",
            "the shot exceeded the deterministic physics event budget",
        ));
    }

    let duration_ms = (current_time * 1_000.0).round().clamp(0.0, u32::MAX as f64) as u32;
    if let Some(captured) = frames.as_mut() {
        let final_frame = make_frame(
            duration_ms,
            &input.balls,
            &balls,
            &indices_by_id,
            parameters,
        );
        if captured
            .last()
            .is_some_and(|frame| frame.at_ms == duration_ms)
        {
            if let Some(last) = captured.last_mut() {
                *last = final_frame;
            }
        } else {
            captured.push(final_frame);
        }
    }

    let final_balls = final_balls(&input.balls, &balls, &indices_by_id);
    let cue_ball_potted = final_balls
        .iter()
        .find(|ball| ball.kind == BallKind::Cue)
        .is_some_and(|ball| ball.pocketed);
    let first_contact_ball_id = first_contact_ball_ids.first().cloned();
    let jumped_ball_ids = Vec::new();
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
        || shot.tip.x * shot.tip.x + shot.tip.y * shot.tip.y > 0.95_f64.powi(2) + EPSILON
    {
        return Err(CoreError::invalid(
            "SHOT_OUT_OF_RANGE",
            "shot values are outside the supported calibration range",
        ));
    }
    Ok(())
}

fn dynamic_balls(
    source: &[Ball],
    table: &TableSpec,
    params: BallParameters,
) -> (Vec<DynamicBall>, HashMap<String, usize>) {
    let mut balls = Vec::with_capacity(source.len());
    let mut indices = HashMap::new();
    for ball in source {
        indices.insert(ball.id.clone(), balls.len());
        balls.push(DynamicBall {
            source: ball.clone(),
            position: Vec3::new(
                clamp(ball.x, -params.radius, table.width + params.radius),
                clamp(ball.y, -params.radius, table.height + params.radius),
                if ball.pocketed {
                    -params.radius
                } else {
                    params.radius
                },
            ),
            velocity: Vec3::ZERO,
            spin: Vec3::ZERO,
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

fn apply_cue_strike(
    ball: &mut DynamicBall,
    shot: &Shot,
    mode: BilliardsMode,
    params: BallParameters,
) -> CueStrikeDiagnostics {
    let cue = CueParameters::for_mode(mode);
    let cue_speed = CUE_SPEED_AT_HALF_POWER * shot.power / 50.0;
    let theta = shot.elevation.to_radians();
    let a = shot.tip.x;
    let b = shot.tip.y;
    let cue_c = (1.0 - a * a - b * b).max(0.0).sqrt();
    let ball_a = a;
    let ball_c = theta.cos() * cue_c - theta.sin() * b;
    let ball_b = theta.sin() * cue_c + theta.cos() * b;
    let contact = Vec3::new(ball_a, ball_c, ball_b) * params.radius;

    let inertia_over_mass = 2.0 / 5.0 * params.radius.powi(2);
    let temp =
        contact.x.powi(2) + (contact.z * theta.cos()).powi(2) + (contact.y * theta.sin()).powi(2)
            - 2.0 * contact.z * contact.y * theta.cos() * theta.sin();
    let speed = 2.0 * cue_speed / (1.0 + params.mass / cue.mass + temp / inertia_over_mass);
    let velocity_ball = Vec3::new(0.0, -speed * theta.cos(), -speed * theta.sin());
    let spin_ball = Vec3::new(
        -contact.y * theta.sin() + contact.z * theta.cos(),
        contact.x * theta.sin(),
        -contact.x * theta.cos(),
    ) * (speed / inertia_over_mass);
    let rotation = shot.angle + std::f64::consts::FRAC_PI_2;
    let squirt_radians = squirt_angle(params.mass, cue.end_mass, ball_a);

    ball.velocity = velocity_ball.rotate_z(rotation).rotate_z(squirt_radians);
    // Pooltool's default resolver is InstantaneousPoint2D.
    ball.velocity.z = 0.0;
    ball.spin = spin_ball.rotate_z(rotation);
    ball.state = MotionState::Sliding;

    CueStrikeDiagnostics {
        cue_speed: quantize(cue_speed, OUTPUT_QUANTUM),
        jump_speed: 0.0,
        // Pooltool has no separate miscue resolver. Keep this product-level
        // diagnostic without altering the Pooltool strike equations.
        miscue: (a * a + b * b).sqrt() > 0.94,
        squirt_radians: quantize(squirt_radians, OUTPUT_QUANTUM),
    }
}

fn squirt_angle(ball_mass: f64, cue_end_mass: f64, a: f64) -> f64 {
    let remaining = 1.0 - a * a;
    -(2.5 * a * remaining.max(0.0).sqrt()).atan2(1.0 + ball_mass / cue_end_mass + 2.5 * remaining)
}

fn relative_cloth_velocity(ball: &DynamicBall, radius: f64) -> Vec3 {
    ball.velocity + ball.spin.cross(Vec3::new(0.0, 0.0, -radius))
}

fn transition_for(ball: &DynamicBall, params: BallParameters) -> Option<(f64, TransitionKind)> {
    match ball.state {
        MotionState::Sliding => {
            let time = 2.0 * relative_cloth_velocity(ball, params.radius).length()
                / (7.0 * params.sliding_friction * params.gravity);
            Some((time, TransitionKind::SlidingRolling))
        }
        MotionState::Rolling => {
            let roll_time = ball.velocity.length() / (params.rolling_friction * params.gravity);
            let spin_time = ball.spin.z.abs() * 2.0 / 5.0 * params.radius
                / params.spinning_friction
                / params.gravity;
            Some((
                roll_time,
                if spin_time > roll_time {
                    TransitionKind::RollingSpinning
                } else {
                    TransitionKind::RollingStationary
                },
            ))
        }
        MotionState::Spinning => Some((
            ball.spin.z.abs() * 2.0 / 5.0 * params.radius
                / params.spinning_friction
                / params.gravity,
            TransitionKind::SpinningStationary,
        )),
        MotionState::Stationary | MotionState::Airborne | MotionState::Pocketed => None,
    }
}

fn kinematics(ball: &DynamicBall, params: BallParameters) -> Kinematics {
    let acceleration = match ball.state {
        MotionState::Sliding => {
            -relative_cloth_velocity(ball, params.radius).normalized()
                * (params.sliding_friction * params.gravity)
        }
        MotionState::Rolling => {
            -ball.velocity.normalized() * (params.rolling_friction * params.gravity)
        }
        MotionState::Airborne => Vec3::new(0.0, 0.0, -params.gravity),
        MotionState::Stationary | MotionState::Spinning | MotionState::Pocketed => Vec3::ZERO,
    };
    Kinematics {
        velocity: ball.velocity,
        acceleration,
    }
}

fn evolve_all(balls: &mut [DynamicBall], time: f64, params: BallParameters) {
    for ball in balls {
        evolve_ball(ball, time, params);
    }
}

fn evolve_ball(ball: &mut DynamicBall, time: f64, params: BallParameters) {
    if time == 0.0 {
        return;
    }
    let initial_position = ball.position;
    match ball.state {
        MotionState::Stationary | MotionState::Pocketed => {}
        MotionState::Airborne => {
            ball.position +=
                ball.velocity * time + Vec3::new(0.0, 0.0, -params.gravity) * (0.5 * time * time);
            ball.velocity += Vec3::new(0.0, 0.0, -params.gravity * time);
        }
        MotionState::Sliding => {
            let slip_direction = relative_cloth_velocity(ball, params.radius).normalized();
            let acceleration = -slip_direction * (params.sliding_friction * params.gravity);
            ball.position += ball.velocity * time + acceleration * (0.5 * time * time);
            ball.velocity += acceleration * time;
            ball.spin -= slip_direction.cross(Vec3::Z)
                * (2.5 / params.radius * params.sliding_friction * params.gravity * time);
            ball.spin.z = decayed_vertical_spin(ball.spin.z, time, params);
            ball.position.z = params.radius;
            ball.velocity.z = 0.0;
        }
        MotionState::Rolling => {
            let direction = ball.velocity.normalized();
            let acceleration = -direction * (params.rolling_friction * params.gravity);
            ball.position += ball.velocity * time + acceleration * (0.5 * time * time);
            ball.velocity += acceleration * time;
            let vertical_spin = decayed_vertical_spin(ball.spin.z, time, params);
            ball.spin = Vec3::new(
                -ball.velocity.y / params.radius,
                ball.velocity.x / params.radius,
                vertical_spin,
            );
            ball.position.z = params.radius;
            ball.velocity.z = 0.0;
        }
        MotionState::Spinning => {
            ball.spin.z = decayed_vertical_spin(ball.spin.z, time, params);
        }
    }
    let travel = (ball.position.xy() - initial_position.xy()).length();
    ball.rotation += travel / params.radius;
}

fn decayed_vertical_spin(spin: f64, time: f64, params: BallParameters) -> f64 {
    if spin.abs() < EPSILON {
        return spin;
    }
    let alpha = 5.0 * params.spinning_friction * params.gravity / (2.0 * params.radius);
    let duration = time.min(spin.abs() / alpha);
    spin - spin.signum() * alpha * duration
}

fn predict_next_event(
    balls: &[DynamicBall],
    geometry: &TableGeometry,
    params: BallParameters,
) -> Option<CandidateEvent> {
    let transition = next_transition(balls, params);
    let horizon = transition.map_or(f64::INFINITY, |candidate| candidate.time) + ROOT_HORIZON_PAD;
    let linear = next_linear_cushion(balls, geometry, params, horizon);
    let circular = next_circular_cushion(balls, geometry, params, horizon);
    let pocket = next_pocket(balls, geometry, params, horizon);
    let ball_ball = next_ball_ball(balls, params, horizon);
    let ball_table = next_ball_table(balls, params, horizon);

    let mut candidates = [transition, linear, circular, pocket, ball_ball, ball_table]
        .into_iter()
        .flatten();
    let mut best = candidates.next()?;
    for candidate in candidates {
        if candidate.time < best.time {
            best = candidate;
        } else if candidate.time == best.time {
            let candidate_key = (candidate.tier(), -candidate.energy(balls, params));
            let best_key = (best.tier(), -best.energy(balls, params));
            if candidate_key < best_key {
                best = candidate;
            }
        }
    }
    Some(best)
}

fn next_transition(balls: &[DynamicBall], params: BallParameters) -> Option<CandidateEvent> {
    let mut best = None;
    for (index, ball) in balls.iter().enumerate() {
        let Some((time, transition)) = transition_for(ball, params) else {
            continue;
        };
        if time < 0.0 || !time.is_finite() {
            continue;
        }
        replace_if_earlier(
            &mut best,
            CandidateEvent {
                time,
                kind: EventKind::Transition {
                    ball: index,
                    transition,
                },
            },
        );
    }
    best
}

fn next_ball_ball(
    balls: &[DynamicBall],
    params: BallParameters,
    horizon: f64,
) -> Option<CandidateEvent> {
    let mut best = None;
    for first in 0..balls.len() {
        if !balls[first].active() {
            continue;
        }
        let first_motion = kinematics(&balls[first], params);
        let first_box = motion_aabb(&balls[first], first_motion, horizon, params.radius);
        for second in first + 1..balls.len() {
            if !balls[second].active()
                || (matches!(
                    balls[first].state,
                    MotionState::Stationary | MotionState::Spinning
                ) && matches!(
                    balls[second].state,
                    MotionState::Stationary | MotionState::Spinning
                ))
            {
                continue;
            }
            let second_motion = kinematics(&balls[second], params);
            let second_box = motion_aabb(&balls[second], second_motion, horizon, params.radius);
            if !first_box.overlaps(second_box) {
                continue;
            }
            if (balls[first].position - balls[second].position).length() < 2.0 * params.radius {
                replace_if_earlier(
                    &mut best,
                    CandidateEvent {
                        time: 0.0,
                        kind: EventKind::BallBall { first, second },
                    },
                );
                continue;
            }
            let coefficients = distance_polynomial(
                balls[first].position.xy() - balls[second].position.xy(),
                first_motion.velocity.xy() - second_motion.velocity.xy(),
                first_motion.acceleration.xy() - second_motion.acceleration.xy(),
                2.0 * params.radius,
            );
            if let Some(time) = event_root_allow_zero(&coefficients, horizon) {
                replace_if_earlier(
                    &mut best,
                    CandidateEvent {
                        time,
                        kind: EventKind::BallBall { first, second },
                    },
                );
            }
        }
    }
    best
}

fn next_linear_cushion(
    balls: &[DynamicBall],
    geometry: &TableGeometry,
    params: BallParameters,
    horizon: f64,
) -> Option<CandidateEvent> {
    let mut best = None;
    for (ball_index, ball) in balls.iter().enumerate() {
        if !ball.active()
            || matches!(
                ball.state,
                MotionState::Stationary | MotionState::Spinning | MotionState::Airborne
            )
        {
            continue;
        }
        let motion = kinematics(ball, params);
        let motion_box = motion_aabb(ball, motion, horizon, params.radius);
        for (cushion_index, cushion) in geometry.linear_cushions.iter().enumerate() {
            let cushion_box = Aabb {
                minimum: cushion.aabb.minimum - Vec2::new(params.radius, params.radius),
                maximum: cushion.aabb.maximum + Vec2::new(params.radius, params.radius),
            };
            if !motion_box.overlaps(cushion_box) {
                continue;
            }
            let norm = (cushion.lx * cushion.lx + cushion.ly * cushion.ly).sqrt();
            let side = match cushion.direction {
                CushionDirection::Side1 => params.radius * norm,
                CushionDirection::Side2 => -params.radius * norm,
            };
            let coefficients = [
                cushion.l0 + cushion.lx * ball.position.x + cushion.ly * ball.position.y + side,
                cushion.lx * motion.velocity.x + cushion.ly * motion.velocity.y,
                0.5 * (cushion.lx * motion.acceleration.x + cushion.ly * motion.acceleration.y),
            ];
            for time in event_roots(&coefficients, horizon) {
                let position = position_at(ball, motion, time);
                if cushion.contains_projection(position.xy()) {
                    replace_if_earlier(
                        &mut best,
                        CandidateEvent {
                            time,
                            kind: EventKind::LinearCushion {
                                ball: ball_index,
                                cushion: cushion_index,
                            },
                        },
                    );
                    break;
                }
            }
        }
    }
    best
}

fn next_circular_cushion(
    balls: &[DynamicBall],
    geometry: &TableGeometry,
    params: BallParameters,
    horizon: f64,
) -> Option<CandidateEvent> {
    let mut best = None;
    for (ball_index, ball) in balls.iter().enumerate() {
        if !ball.active()
            || matches!(
                ball.state,
                MotionState::Stationary | MotionState::Spinning | MotionState::Airborne
            )
        {
            continue;
        }
        let motion = kinematics(ball, params);
        let motion_box = motion_aabb(ball, motion, horizon, params.radius);
        for (cushion_index, cushion) in geometry.circular_cushions.iter().enumerate() {
            let target = params.radius + cushion.radius;
            let cushion_box = Aabb {
                minimum: cushion.aabb.minimum - Vec2::new(params.radius, params.radius),
                maximum: cushion.aabb.maximum + Vec2::new(params.radius, params.radius),
            };
            if !motion_box.overlaps(cushion_box) {
                continue;
            }
            let coefficients = distance_polynomial(
                ball.position.xy() - cushion.center.xy(),
                motion.velocity.xy(),
                motion.acceleration.xy(),
                target,
            );
            if let Some(time) = event_root_allow_zero(&coefficients, horizon) {
                replace_if_earlier(
                    &mut best,
                    CandidateEvent {
                        time,
                        kind: EventKind::CircularCushion {
                            ball: ball_index,
                            cushion: cushion_index,
                        },
                    },
                );
            }
        }
    }
    best
}

fn next_pocket(
    balls: &[DynamicBall],
    geometry: &TableGeometry,
    params: BallParameters,
    horizon: f64,
) -> Option<CandidateEvent> {
    let mut best = None;
    for (ball_index, ball) in balls.iter().enumerate() {
        if !ball.active() || matches!(ball.state, MotionState::Stationary | MotionState::Spinning) {
            continue;
        }
        let motion = kinematics(ball, params);
        let motion_box = motion_aabb(ball, motion, horizon, 0.0);
        for (pocket_index, pocket) in geometry.pockets.iter().enumerate() {
            if !motion_box.overlaps(pocket.aabb) {
                continue;
            }
            let time = if ball.state == MotionState::Airborne {
                airborne_pocket_time(ball, pocket.center.xy(), pocket.radius, params)
            } else {
                event_root_allow_zero(
                    &distance_polynomial(
                        ball.position.xy() - pocket.center.xy(),
                        motion.velocity.xy(),
                        motion.acceleration.xy(),
                        pocket.radius,
                    ),
                    horizon,
                )
            };
            if let Some(time) = time.filter(|time| *time <= horizon) {
                replace_if_earlier(
                    &mut best,
                    CandidateEvent {
                        time,
                        kind: EventKind::Pocket {
                            ball: ball_index,
                            pocket: pocket_index,
                        },
                    },
                );
            }
        }
    }
    best
}

fn next_ball_table(
    balls: &[DynamicBall],
    params: BallParameters,
    horizon: f64,
) -> Option<CandidateEvent> {
    let mut best = None;
    for (index, ball) in balls.iter().enumerate() {
        if ball.state != MotionState::Airborne {
            continue;
        }
        let roots = quadratic_roots(
            -0.5 * params.gravity,
            ball.velocity.z,
            ball.position.z - params.radius,
        );
        let time = roots
            .into_iter()
            .filter(|time| *time >= 0.0 && *time <= horizon)
            .max_by(f64::total_cmp);
        if let Some(time) = time {
            replace_if_earlier(
                &mut best,
                CandidateEvent {
                    time,
                    kind: EventKind::BallTable { ball: index },
                },
            );
        }
    }
    best
}

fn replace_if_earlier(best: &mut Option<CandidateEvent>, candidate: CandidateEvent) {
    if best.is_none_or(|current| candidate.time < current.time) {
        *best = Some(candidate);
    }
}

fn motion_aabb(ball: &DynamicBall, motion: Kinematics, horizon: f64, pad: f64) -> Aabb {
    let time = if horizon.is_finite() {
        horizon.max(0.0)
    } else {
        0.0
    };
    Aabb::from_motion(
        ball.position.xy(),
        motion.velocity.xy(),
        motion.acceleration.xy(),
        time,
        pad,
    )
}

fn position_at(ball: &DynamicBall, motion: Kinematics, time: f64) -> Vec3 {
    ball.position + motion.velocity * time + motion.acceleration * (0.5 * time * time)
}

fn distance_polynomial(
    delta_position: Vec2,
    delta_velocity: Vec2,
    delta_acceleration: Vec2,
    distance: f64,
) -> [f64; 5] {
    [
        delta_position.length_squared() - distance * distance,
        2.0 * delta_position.dot(delta_velocity),
        delta_velocity.length_squared() + delta_position.dot(delta_acceleration),
        delta_velocity.dot(delta_acceleration),
        0.25 * delta_acceleration.length_squared(),
    ]
}

fn event_root_allow_zero(coefficients: &[f64], horizon: f64) -> Option<f64> {
    if !horizon.is_finite() || horizon < 0.0 {
        return None;
    }
    let mut roots = roots_in_interval(coefficients, 0.0, horizon);
    roots.sort_by(f64::total_cmp);
    roots.into_iter().find(|root| *root >= 0.0)
}

fn event_roots(coefficients: &[f64], horizon: f64) -> Vec<f64> {
    if !horizon.is_finite() || horizon <= EPSILON {
        return Vec::new();
    }
    let mut roots = roots_in_interval(coefficients, EPSILON, horizon);
    roots.retain(|root| *root > EPSILON);
    roots.sort_by(f64::total_cmp);
    roots
}

fn quadratic_roots(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a.abs() <= EPSILON {
        if b.abs() <= EPSILON {
            return Vec::new();
        }
        return vec![-c / b];
    }
    let discriminant = b * b - 4.0 * a * c;
    if discriminant < 0.0 {
        return Vec::new();
    }
    let root = discriminant.sqrt();
    vec![(-b - root) / (2.0 * a), (-b + root) / (2.0 * a)]
}

fn airborne_pocket_time(
    ball: &DynamicBall,
    center: Vec2,
    radius: f64,
    params: BallParameters,
) -> Option<f64> {
    let landing = quadratic_roots(
        -0.5 * params.gravity,
        ball.velocity.z,
        ball.position.z - params.radius,
    )
    .into_iter()
    .max_by(f64::total_cmp)?;
    let landing_xy = ball.position.xy() + ball.velocity.xy() * landing;
    if (landing_xy - center).length_squared() < radius * radius {
        return Some((landing - EPSILON).max(EPSILON));
    }
    let relative = ball.position.xy() - center;
    let roots = quadratic_roots(
        ball.velocity.xy().length_squared(),
        2.0 * relative.dot(ball.velocity.xy()),
        relative.length_squared() - radius * radius,
    );
    if roots.len() != 2 {
        return None;
    }
    let mut roots = roots;
    roots.sort_by(f64::total_cmp);
    let (entry, exit) = (roots[0], roots[1]);
    if entry < 0.0 {
        return None;
    }
    let height =
        |time: f64| ball.position.z + ball.velocity.z * time - 0.5 * params.gravity * time * time;
    if height(entry) < params.radius || height(exit) > 7.0 / 5.0 * params.radius {
        None
    } else {
        Some((entry + exit) / 2.0)
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_event(
    kind: EventKind,
    current_time: f64,
    balls: &mut [DynamicBall],
    geometry: &TableGeometry,
    params: BallParameters,
    cue_index: usize,
    events: &mut Vec<SimulationEvent>,
    pocketed_ball_ids: &mut Vec<String>,
    rail_contact_ball_ids: &mut Vec<String>,
    rail_contact_set: &mut HashSet<String>,
    post_contact_rail_ball_ids: &mut Vec<String>,
    post_contact_rail_set: &mut HashSet<String>,
    first_contact_ball_ids: &mut Vec<String>,
    first_contact_time: &mut Option<f64>,
) {
    match kind {
        EventKind::Transition { ball, transition } => {
            resolve_transition(&mut balls[ball], transition);
            events.push(SimulationEvent {
                at_seconds: quantize(current_time, EVENT_QUANTUM),
                kind: transition.name().to_owned(),
                ball_ids: vec![balls[ball].source.id.clone()],
                geometry_id: None,
            });
        }
        EventKind::Pocket { ball, pocket } => {
            let pocket = &geometry.pockets[pocket];
            balls[ball].position = Vec3::new(pocket.center.x, pocket.center.y, -pocket.depth);
            balls[ball].velocity = Vec3::ZERO;
            balls[ball].spin = Vec3::ZERO;
            balls[ball].state = MotionState::Pocketed;
            balls[ball].pocketed = true;
            let id = balls[ball].source.id.clone();
            pocketed_ball_ids.push(id.clone());
            events.push(SimulationEvent {
                at_seconds: quantize(current_time, EVENT_QUANTUM),
                kind: "ball_pocket".to_owned(),
                ball_ids: vec![id],
                geometry_id: Some(pocket.id.clone()),
            });
        }
        EventKind::BallBall { first, second } => {
            let object = if first == cue_index {
                Some(second)
            } else if second == cue_index {
                Some(first)
            } else {
                None
            };
            if let Some(object) = object {
                let id = balls[object].source.id.clone();
                if first_contact_time.is_none() {
                    *first_contact_time = Some(current_time);
                    first_contact_ball_ids.push(id);
                } else if *first_contact_time == Some(current_time)
                    && !first_contact_ball_ids.contains(&id)
                {
                    first_contact_ball_ids.push(id);
                }
            }
            resolve_ball_ball(balls, first, second, params);
            let mut ids = [
                balls[first].source.id.clone(),
                balls[second].source.id.clone(),
            ];
            ids.sort();
            events.push(SimulationEvent {
                at_seconds: quantize(current_time, EVENT_QUANTUM),
                kind: "ball_ball".to_owned(),
                ball_ids: ids.into(),
                geometry_id: None,
            });
        }
        EventKind::LinearCushion { ball, cushion } => {
            resolve_linear_cushion(&mut balls[ball], &geometry.linear_cushions[cushion], params);
            record_rail_contact(
                ball,
                &geometry.linear_cushions[cushion].id,
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
        EventKind::CircularCushion { ball, cushion } => {
            resolve_circular_cushion(
                &mut balls[ball],
                &geometry.circular_cushions[cushion],
                params,
            );
            record_rail_contact(
                ball,
                &geometry.circular_cushions[cushion].id,
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
        EventKind::BallTable { ball } => {
            resolve_ball_table(&mut balls[ball], params);
            events.push(SimulationEvent {
                at_seconds: quantize(current_time, EVENT_QUANTUM),
                kind: "ball_table".to_owned(),
                ball_ids: vec![balls[ball].source.id.clone()],
                geometry_id: Some("table".to_owned()),
            });
        }
    }
}

fn resolve_transition(ball: &mut DynamicBall, transition: TransitionKind) {
    match transition {
        TransitionKind::SlidingRolling => {
            ball.state = MotionState::Rolling;
        }
        TransitionKind::RollingSpinning => {
            ball.state = MotionState::Spinning;
            ball.velocity = Vec3::ZERO;
            ball.spin.x = 0.0;
            ball.spin.y = 0.0;
        }
        TransitionKind::RollingStationary | TransitionKind::SpinningStationary => {
            ball.state = MotionState::Stationary;
            ball.velocity = Vec3::ZERO;
            ball.spin = Vec3::ZERO;
        }
    }
}

fn resolve_ball_ball(
    balls: &mut [DynamicBall],
    first: usize,
    second: usize,
    params: BallParameters,
) {
    let (ball1, ball2) = two_mut(balls, first, second);
    make_kiss_ball_ball(ball1, ball2, params.radius);

    let normal = (ball2.position - ball1.position).normalized();
    let tangent_surface = |ball: &DynamicBall, direction: Vec3| {
        ball.velocity - direction * ball.velocity.dot(direction)
            + ball.spin.cross(direction * params.radius)
    };
    let relative_surface_speed =
        (tangent_surface(ball1, normal) - tangent_surface(ball2, -normal)).length();
    let friction = 0.009_951 + 0.108 * (-1.088 * relative_surface_speed).exp();

    let theta = (ball2.position.y - ball1.position.y).atan2(ball2.position.x - ball1.position.x);
    let mut v1 = ball1.velocity.rotate_z(-theta);
    let mut w1 = ball1.spin.rotate_z(-theta);
    let mut v2 = ball2.velocity.rotate_z(-theta);
    let mut w2 = ball2.spin.rotate_z(-theta);
    let v1_normal_final =
        0.5 * ((1.0 - params.ball_restitution) * v1.x + (1.0 + params.ball_restitution) * v2.x);
    let v2_normal_final =
        0.5 * ((1.0 + params.ball_restitution) * v1.x + (1.0 - params.ball_restitution) * v2.x);
    let delta_normal = (v2_normal_final - v1_normal_final).abs();
    let w1_normal = w1.x;
    let w2_normal = w2.x;
    v1.x = 0.0;
    v2.x = 0.0;
    w1.x = 0.0;
    w2.x = 0.0;

    let surface = |velocity: Vec3, spin: Vec3, direction: Vec3| {
        velocity + spin.cross(direction * params.radius)
    };
    let relative = surface(v1, w1, Vec3::X) - surface(v2, w2, -Vec3::X);
    let has_relative = relative.length() > EPSILON;
    let mut final_v1;
    let mut final_w1;
    let mut final_v2;
    let mut final_w2;
    let mut use_no_slip = !has_relative;
    if has_relative {
        let tangent_delta = -relative.normalized() * (friction * delta_normal);
        let spin_delta = Vec3::X.cross(tangent_delta) * (2.5 / params.radius);
        final_v1 = v1 + tangent_delta;
        final_w1 = w1 + spin_delta;
        final_v2 = v2 - tangent_delta;
        final_w2 = w2 + spin_delta;
        let relative_after =
            surface(final_v1, final_w1, Vec3::X) - surface(final_v2, final_w2, -Vec3::X);
        use_no_slip = relative.dot(relative_after) <= 0.0;
    } else {
        final_v1 = v1;
        final_w1 = w1;
        final_v2 = v2;
        final_w2 = w2;
    }
    if use_no_slip {
        let tangent_delta = -(v1 - v2 + (w1 + w2).cross(Vec3::X) * params.radius) / 7.0;
        let spin_delta = -(Vec3::X.cross(v1 - v2) / params.radius + w1 + w2) * (5.0 / 14.0);
        final_v1 = v1 + tangent_delta;
        final_w1 = w1 + spin_delta;
        final_v2 = v2 - tangent_delta;
        final_w2 = w2 + spin_delta;
    }
    final_v1.x = v1_normal_final;
    final_v2.x = v2_normal_final;
    final_w1.x = w1_normal;
    final_w2.x = w2_normal;
    ball1.velocity = final_v1.rotate_z(theta);
    ball2.velocity = final_v2.rotate_z(theta);
    ball1.velocity.z = 0.0;
    ball2.velocity.z = 0.0;
    ball1.spin = final_w1.rotate_z(theta);
    ball2.spin = final_w2.rotate_z(theta);
    ball1.state = MotionState::Sliding;
    ball2.state = MotionState::Sliding;
    resolve_continually_touching(ball1, ball2);
}

fn make_kiss_ball_ball(ball1: &mut DynamicBall, ball2: &mut DynamicBall, radius: f64) {
    let r1 = ball1.position;
    let r2 = ball2.position;
    let v1 = ball1.velocity;
    let v2 = ball2.velocity;
    let target = 2.0 * radius + MIN_DIST;
    let fallback = |ball1: &mut DynamicBall, ball2: &mut DynamicBall| {
        let delta = ball2.position - ball1.position;
        let direction = if delta.length() <= EPSILON {
            Vec3::X
        } else {
            delta.normalized()
        };
        let correction = 2.0 * radius - delta.length() + MIN_DIST;
        ball1.position -= direction * (correction / 2.0);
        ball2.position += direction * (correction / 2.0);
    };
    let relative_velocity = v2 - v1;
    let relative_position = r2 - r1;
    let roots = quadratic_roots(
        relative_velocity.length_squared(),
        2.0 * relative_velocity.dot(relative_position),
        relative_position.length_squared() - target * target,
    );
    let Some(time) = roots.into_iter().min_by(|a, b| a.abs().total_cmp(&b.abs())) else {
        fallback(ball1, ball2);
        return;
    };
    let corrected1 = r1 + v1 * time;
    let corrected2 = r2 + v2 * time;
    let midpoint_shift = ((corrected1 + corrected2) * 0.5 - (r1 + r2) * 0.5).length();
    if midpoint_shift > 5.0 * MIN_DIST {
        fallback(ball1, ball2);
    } else {
        ball1.position = corrected1;
        ball2.position = corrected2;
    }
}

fn resolve_continually_touching(ball1: &mut DynamicBall, ball2: &mut DynamicBall) {
    let speed1 = ball1.velocity.length();
    let speed2 = ball2.velocity.length();
    if speed1 == 0.0 || speed2 == 0.0 {
        return;
    }
    let line = (ball2.position - ball1.position).normalized();
    let loc1 = ball1.velocity.dot(line);
    let loc2 = ball2.velocity.dot(line);
    let aligned = ball1.velocity.dot(ball2.velocity) / (speed1 * speed2) > 0.9;
    if (loc2 - loc1).abs() >= 0.01 || !aligned {
        return;
    }
    let (new1, new2) = if loc1 > loc2 {
        let stolen = 0.1 * loc1;
        (loc1 - stolen, loc2 + stolen)
    } else {
        let stolen = 0.1 * loc2;
        (loc1 + stolen, loc2 - stolen)
    };
    ball1.velocity += line * (new1 - loc1);
    ball2.velocity += line * (new2 - loc2);
}

fn resolve_linear_cushion(ball: &mut DynamicBall, cushion: &LinearCushion, params: BallParameters) {
    make_kiss_linear(ball, cushion, params.radius);
    resolve_cushion(ball, cushion.normal_3d(ball.position), params);
}

fn make_kiss_linear(ball: &mut DynamicBall, cushion: &LinearCushion, radius: f64) {
    let normal_xy = Vec3::new(cushion.lx, cushion.ly, 0.0).normalized();
    let normal = if normal_xy.dot(ball.velocity) > 0.0 {
        normal_xy
    } else {
        -normal_xy
    };
    let d0 = (ball.position - cushion.p1).dot(normal);
    let normal_velocity = ball.velocity.dot(normal);
    if normal_velocity.abs() > EPSILON {
        let first = (radius + MIN_DIST - d0) / normal_velocity;
        let second = (-(radius + MIN_DIST) - d0) / normal_velocity;
        let time = if first.abs() < second.abs() {
            first
        } else {
            second
        };
        if (ball.velocity * time).length() <= 5.0 * MIN_DIST {
            ball.position += ball.velocity * time;
            return;
        }
    }
    let axis = cushion.p2 - cushion.p1;
    let closest =
        cushion.p1 + axis * (ball.position - cushion.p1).dot(axis) / axis.length_squared();
    let closest = Vec3::new(closest.x, closest.y, ball.position.z);
    let direction = (ball.position - closest).normalized();
    ball.position = closest + direction * (radius + MIN_DIST);
}

fn resolve_circular_cushion(
    ball: &mut DynamicBall,
    cushion: &CircularCushion,
    params: BallParameters,
) {
    make_kiss_circular(ball, cushion, params.radius);
    resolve_cushion(ball, cushion.normal_3d(ball.position), params);
}

fn make_kiss_circular(ball: &mut DynamicBall, cushion: &CircularCushion, radius: f64) {
    let center = Vec3::new(cushion.center.x, cushion.center.y, ball.position.z);
    let difference = ball.position - center;
    let target = radius + cushion.radius + MIN_DIST;
    let roots = quadratic_roots(
        ball.velocity.xy().length_squared(),
        2.0 * difference.xy().dot(ball.velocity.xy()),
        difference.xy().length_squared() - target * target,
    );
    if let Some(time) = roots.into_iter().min_by(|a, b| a.abs().total_cmp(&b.abs()))
        && (ball.velocity * time).length() <= 5.0 * MIN_DIST
    {
        ball.position += ball.velocity * time;
        return;
    }
    let direction = (ball.position - center).normalized();
    ball.position = center + direction * target;
}

fn resolve_cushion(ball: &mut DynamicBall, normal: Vec3, params: BallParameters) {
    let contact_velocity = ball.velocity + ball.spin.cross(-normal * params.radius);
    let normal_velocity = normal.dot(contact_velocity);
    if normal_velocity >= 0.0 {
        return;
    }
    let normal_cross_velocity = normal.cross(contact_velocity);
    let tangent_velocity = -normal_cross_velocity.length();
    let tangent = if tangent_velocity == 0.0 {
        Vec3::ZERO
    } else {
        normal_cross_velocity.cross(normal) / tangent_velocity
    };
    let (tangent_final, normal_final) = stronge::resolve(
        tangent_velocity,
        normal_velocity,
        params.mass,
        params.cushion_friction,
        params.cushion_restitution,
        CUSHION_OMEGA_RATIO,
    );
    let delta_normal = normal_final - normal_velocity;
    ball.velocity += normal * delta_normal;
    let delta_tangent = (tangent_final - tangent_velocity) / 3.5;
    ball.velocity += tangent * delta_tangent;
    ball.spin += (-normal).cross(tangent * delta_tangent) * (2.5 / params.radius);
    ball.velocity.z = 0.0;
    ball.state = MotionState::Sliding;
}

fn resolve_ball_table(ball: &mut DynamicBall, params: BallParameters) {
    ball.position.z = params.radius;
    let initial_velocity = ball.velocity;
    let initial_spin = ball.spin;
    if initial_velocity.z >= 0.0 {
        return;
    }
    let vertical_delta = (1.0 + params.table_restitution) * -initial_velocity.z;
    let mut planar_initial = initial_velocity;
    planar_initial.z = 0.0;
    let contact_velocity = planar_initial + initial_spin.cross(Vec3::new(0.0, 0.0, -params.radius));
    let has_relative = contact_velocity.length_squared() > EPSILON * EPSILON;
    let slip_delta = if has_relative {
        -contact_velocity.normalized() * (params.sliding_friction * vertical_delta)
    } else {
        Vec3::ZERO
    };
    let no_slip_delta =
        (initial_spin.cross(Vec3::Z) * params.radius - planar_initial) * (2.0 / 7.0);
    ball.velocity += Vec3::Z * vertical_delta;
    if !has_relative || no_slip_delta.length_squared() <= slip_delta.length_squared() {
        ball.velocity += no_slip_delta;
        ball.spin += (-initial_spin + Vec3::Z.cross(planar_initial) / params.radius) * (5.0 / 7.0);
    } else {
        ball.velocity += slip_delta;
        ball.spin += Vec3::Z.cross(contact_velocity.normalized())
            * (2.5 / params.radius * slip_delta.length());
    }
    if 0.5 * ball.velocity.z.powi(2) / params.gravity < 0.005 {
        ball.velocity.z = 0.0;
    }
    ball.state = classify_motion(ball, params);
}

fn classify_motion(ball: &DynamicBall, params: BallParameters) -> MotionState {
    if ball.position.z < 0.0 {
        return MotionState::Pocketed;
    }
    if ball.velocity.z != 0.0 || ball.position.z != params.radius {
        return MotionState::Airborne;
    }
    if relative_cloth_velocity(ball, params.radius).length() > EPSILON {
        return MotionState::Sliding;
    }
    if ball.velocity.xy().length() > EPSILON {
        return MotionState::Rolling;
    }
    if ball.spin.z != 0.0 {
        return MotionState::Spinning;
    }
    MotionState::Stationary
}

fn two_mut<T>(values: &mut [T], first: usize, second: usize) -> (&mut T, &mut T) {
    debug_assert_ne!(first, second);
    if first < second {
        let (left, right) = values.split_at_mut(second);
        (&mut left[first], &mut right[0])
    } else {
        let (left, right) = values.split_at_mut(first);
        (&mut right[0], &mut left[second])
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
        at_seconds: quantize(current_time, EVENT_QUANTUM),
        kind: "ball_cushion".to_owned(),
        ball_ids: vec![id],
        geometry_id: Some(geometry_id.to_owned()),
    });
}

fn ball_energy(ball: &DynamicBall, params: BallParameters) -> f64 {
    let linear = params.mass * ball.velocity.length_squared() / 2.0;
    let rotational =
        (2.0 / 5.0 * params.mass * params.radius.powi(2)) * ball.spin.length_squared() / 2.0;
    let potential = params.mass * params.gravity * (ball.position.z - params.radius);
    linear + rotational + potential
}

fn make_frame(
    at_ms: u32,
    source: &[Ball],
    balls: &[DynamicBall],
    indices_by_id: &HashMap<String, usize>,
    params: BallParameters,
) -> SimulationFrame {
    SimulationFrame {
        at_ms,
        balls: source
            .iter()
            .map(|source_ball| {
                indices_by_id
                    .get(&source_ball.id)
                    .and_then(|index| balls.get(*index))
                    .map(|ball| frame_ball(ball, params))
                    .unwrap_or_else(|| SimulationBallFrame {
                        id: source_ball.id.clone(),
                        pocketed: source_ball.pocketed,
                        rotation: normalize_rotation(source_ball.rotation),
                        spin_x: 0.0,
                        spin_y: 0.0,
                        spin_z: 0.0,
                        state: if source_ball.pocketed {
                            MotionState::Pocketed
                        } else {
                            MotionState::Stationary
                        },
                        x: quantize(source_ball.x, OUTPUT_QUANTUM),
                        y: quantize(source_ball.y, OUTPUT_QUANTUM),
                        z: 0.0,
                    })
            })
            .collect(),
    }
}

fn frame_ball(ball: &DynamicBall, params: BallParameters) -> SimulationBallFrame {
    SimulationBallFrame {
        id: ball.source.id.clone(),
        pocketed: ball.pocketed,
        rotation: normalize_rotation(ball.rotation),
        spin_x: quantize(ball.spin.x, OUTPUT_QUANTUM),
        spin_y: quantize(ball.spin.y, OUTPUT_QUANTUM),
        spin_z: quantize(ball.spin.z, OUTPUT_QUANTUM),
        state: ball.state,
        x: quantize(ball.position.x, OUTPUT_QUANTUM),
        y: quantize(ball.position.y, OUTPUT_QUANTUM),
        z: quantize((ball.position.z - params.radius).max(0.0), OUTPUT_QUANTUM),
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
    params: BallParameters,
) {
    let event_time = current_time + duration;
    while *next_frame_time <= event_time + EPSILON {
        let offset = (*next_frame_time - current_time).clamp(0.0, duration);
        let mut sampled = balls.to_vec();
        evolve_all(&mut sampled, offset, params);
        frames.push(make_frame(
            (*next_frame_time * 1_000.0).round() as u32,
            source,
            &sampled,
            indices_by_id,
            params,
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
        .map(|source_ball| {
            let Some(dynamic) = indices_by_id
                .get(&source_ball.id)
                .and_then(|index| balls.get(*index))
            else {
                return source_ball.clone();
            };
            let mut ball = source_ball.clone();
            ball.pocketed = dynamic.pocketed;
            ball.rotation = normalize_rotation(dynamic.rotation);
            ball.x = quantize(dynamic.position.x, OUTPUT_QUANTUM);
            ball.y = quantize(dynamic.position.y, OUTPUT_QUANTUM);
            ball
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BallKind, CueTip};

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

    fn assert_vec3(actual: Vec3, expected: Vec3) {
        assert!(
            (actual - expected).length() < 1.0e-12,
            "{actual:?} != {expected:?}"
        );
    }

    #[test]
    fn pooltool_parameter_sets_are_exact() {
        let pool = ball_parameters(BilliardsMode::ChineseEightBall);
        assert_eq!(pool.mass, 0.170_097);
        assert_eq!(pool.radius, 0.028_575);
        assert_eq!(pool.sliding_friction, 0.2);
        assert_eq!(pool.rolling_friction, 0.01);
        assert_eq!(pool.spinning_friction, (4.0 / 9.0) * pool.radius);
        assert_eq!(pool.ball_restitution, 0.95);
        assert_eq!(pool.table_restitution, 0.5);
        assert_eq!(pool.cushion_restitution, 0.85);
        assert_eq!(pool.cushion_friction, 0.2);
        assert_eq!(pool.gravity, 9.81);
        let snooker = ball_parameters(BilliardsMode::Snooker);
        assert_eq!(snooker.mass, 0.140);
        assert_eq!(snooker.radius, 0.026_193_75);
        assert_eq!(snooker.sliding_friction, 0.5);
        assert_eq!(snooker.rolling_friction, 0.01);
        assert_eq!(snooker.spinning_friction, (4.0 / 9.0) * snooker.radius);
        assert_eq!(snooker.ball_restitution, 0.95);
        assert_eq!(snooker.table_restitution, 0.5);
        assert_eq!(snooker.cushion_restitution, 0.85);
        assert_eq!(snooker.cushion_friction, 0.5);
        assert_eq!(snooker.gravity, 9.81);

        let pool_cue = CueParameters::for_mode(BilliardsMode::ChineseEightBall);
        assert_eq!(pool_cue.mass, 0.567);
        assert_eq!(pool_cue.tip_radius, 0.010_604_5);
        assert_eq!(pool_cue.end_mass, 0.170_097 / 30.0);
        let snooker_cue = CueParameters::for_mode(BilliardsMode::Snooker);
        assert_eq!(snooker_cue.mass, 0.478);
        assert_eq!(snooker_cue.tip_radius, 0.010_604_5);
        assert_eq!(snooker_cue.end_mass, 0.140 / 30.0);
        assert_eq!(CUSHION_OMEGA_RATIO, 1.8);
    }

    #[test]
    fn center_strike_uses_pooltool_point_model() {
        let params = ball_parameters(BilliardsMode::ChineseEightBall);
        let table = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        let (mut balls, _) = dynamic_balls(
            &[ball("cue", BallKind::Cue, 0.5, 0.5)],
            &table.table,
            params,
        );
        let diagnostics = apply_cue_strike(
            &mut balls[0],
            &Shot {
                angle: 0.0,
                elevation: 0.0,
                nominated_color: None,
                power: 50.0,
                tip: CueTip { x: 0.0, y: 0.0 },
            },
            BilliardsMode::ChineseEightBall,
            params,
        );
        let expected = 4.0 / (1.0 + params.mass / 0.567);
        assert!((balls[0].velocity.x - expected).abs() < 1.0e-12);
        assert!(balls[0].velocity.y.abs() < 1.0e-12);
        assert_eq!(diagnostics.cue_speed, 2.0);
    }

    #[test]
    fn slide_transition_matches_pooltool_closed_form() {
        let params = ball_parameters(BilliardsMode::ChineseEightBall);
        let table = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        let (mut balls, _) = dynamic_balls(
            &[ball("cue", BallKind::Cue, 0.5, 0.5)],
            &table.table,
            params,
        );
        balls[0].velocity = Vec3::new(1.0, 0.0, 0.0);
        balls[0].state = MotionState::Sliding;
        let expected = 2.0 / (7.0 * params.sliding_friction * params.gravity);
        let (time, transition) = transition_for(&balls[0], params).unwrap();
        assert!((time - expected).abs() < 1.0e-12);
        assert!(matches!(transition, TransitionKind::SlidingRolling));
        evolve_ball(&mut balls[0], time, params);
        assert!(relative_cloth_velocity(&balls[0], params.radius).length() < 1.0e-12);
    }

    #[test]
    fn off_center_strike_matches_pinned_pooltool_oracle() {
        let params = ball_parameters(BilliardsMode::ChineseEightBall);
        let table = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        let (mut balls, _) = dynamic_balls(
            &[ball("cue", BallKind::Cue, 0.5, 0.5)],
            &table.table,
            params,
        );
        let diagnostics = apply_cue_strike(
            &mut balls[0],
            &Shot {
                angle: 37_f64.to_radians(),
                elevation: 20.0,
                nominated_color: None,
                power: 50.0,
                tip: CueTip { x: 0.3, y: -0.2 },
            },
            BilliardsMode::ChineseEightBall,
            params,
        );
        assert_vec3(
            balls[0].velocity,
            Vec3::new(1.876_818_638_518_478_6, 1.352_024_335_935_561, 0.0),
        );
        assert_vec3(
            balls[0].spin,
            Vec3::new(
                8.273_676_610_725_82,
                -47.696_923_084_183_05,
                -60.711_208_911_809_635,
            ),
        );
        assert!((diagnostics.squirt_radians - -0.021_498).abs() < OUTPUT_QUANTUM);
    }

    #[test]
    fn arbitrary_slide_evolution_matches_pinned_pooltool_oracle() {
        let params = ball_parameters(BilliardsMode::ChineseEightBall);
        let table = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        let (mut balls, _) = dynamic_balls(
            &[ball("cue", BallKind::Cue, 0.4, 0.5)],
            &table.table,
            params,
        );
        balls[0].velocity = Vec3::new(1.2, -0.3, 0.0);
        balls[0].spin = Vec3::new(4.0, -7.0, 12.0);
        balls[0].state = MotionState::Sliding;
        evolve_ball(&mut balls[0], 0.1, params);
        assert_vec3(
            balls[0].position,
            Vec3::new(
                0.510_275_173_867_242_6,
                0.471_289_905_689_436_3,
                params.radius,
            ),
        );
        assert_vec3(
            balls[0].velocity,
            Vec3::new(1.005_503_477_344_853_2, -0.274_201_886_211_274_3, 0.0),
        );
        assert_vec3(
            balls[0].spin,
            Vec3::new(6.257_052_824_910_388, 10.016_318_692_488_77, 10.91),
        );
    }

    #[test]
    fn zero_time_contacts_and_transitions_match_pooltool_event_semantics() {
        let params = ball_parameters(BilliardsMode::ChineseEightBall);
        let table = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        let source = [
            ball("one", BallKind::Solid, 0.5, 0.5),
            ball("two", BallKind::Stripe, 0.5 + 2.0 * params.radius, 0.5),
        ];
        let (mut balls, _) = dynamic_balls(&source, &table.table, params);
        balls[0].velocity = Vec3::new(1.0, 0.0, 0.0);
        balls[0].state = MotionState::Sliding;
        let contact = predict_next_event(&balls, &table, params).unwrap();
        assert_eq!(contact.time, 0.0);
        assert!(matches!(
            contact.kind,
            EventKind::BallBall {
                first: 0,
                second: 1
            }
        ));

        balls[1].position.x += params.radius;
        balls[0].spin = Vec3::new(0.0, 1.0 / params.radius, 0.0);
        let transition = predict_next_event(&balls, &table, params).unwrap();
        assert_eq!(transition.time, 0.0);
        assert!(matches!(
            transition.kind,
            EventKind::Transition {
                ball: 0,
                transition: TransitionKind::SlidingRolling
            }
        ));
    }

    #[test]
    fn event_time_matches_pinned_pooltool_quartic_oracle() {
        let params = ball_parameters(BilliardsMode::ChineseEightBall);
        let table = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        let source = [
            ball("one", BallKind::Solid, 0.5, 0.5),
            ball("two", BallKind::Stripe, 0.7, 0.52),
        ];
        let (mut balls, _) = dynamic_balls(&source, &table.table, params);
        balls[0].velocity = Vec3::new(1.2, 0.1, 0.0);
        balls[0].spin = Vec3::new(2.0, -3.0, 4.0);
        balls[0].state = MotionState::Sliding;

        let event = predict_next_event(&balls, &table, params).unwrap();
        assert!(matches!(
            event.kind,
            EventKind::BallBall {
                first: 0,
                second: 1
            }
        ));
        assert!(
            (event.time - 0.134_217_547_972_059_26).abs() < 1.0e-13,
            "{}",
            event.time
        );
    }

    #[test]
    fn frictional_ball_collision_matches_pinned_pooltool_oracle() {
        let params = ball_parameters(BilliardsMode::ChineseEightBall);
        let table = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        let source = [
            ball("one", BallKind::Solid, 0.5, 0.5),
            ball("two", BallKind::Stripe, 0.5 + 2.0 * params.radius, 0.5),
        ];
        let (mut balls, _) = dynamic_balls(&source, &table.table, params);
        balls[0].velocity = Vec3::new(1.4, 0.2, 0.0);
        balls[0].spin = Vec3::new(2.0, -3.0, 5.0);
        balls[1].velocity = Vec3::new(-0.1, 0.4, 0.0);
        balls[1].spin = Vec3::new(-1.0, 2.0, -4.0);
        resolve_ball_ball(&mut balls, 0, 1, params);
        assert_vec3(
            balls[0].velocity,
            Vec3::new(-0.062_500_397_794_790_69, 0.224_492_197_799_776_8, 0.0),
        );
        assert_vec3(
            balls[0].spin,
            Vec3::new(
                2.000_000_833_212_526,
                -2.642_857_976_073_557,
                7.142_500_943_615_547_5,
            ),
        );
        assert_vec3(
            balls[1].velocity,
            Vec3::new(1.362_500_397_794_790_5, 0.375_507_802_200_223_2, 0.0),
        );
        assert_vec3(
            balls[1].spin,
            Vec3::new(
                -0.999_999_166_787_473_4,
                2.357_142_023_926_442_7,
                -1.857_499_056_384_452_5,
            ),
        );
    }
}
