use super::common::{end_state, other_seat};
use super::eight_ball::{
    adjudicate_chinese_eight_ball_shot, resolve_eight_ball_break_choice,
    resolve_eight_ball_group_choice,
};
use super::error::{RuleError, RuleResult};
use super::placement::{check_cue_placement, place_cue_ball};
use super::practice::adjudicate_practice_shot;
use super::snooker::{adjudicate_snooker_shot, resolve_snooker_deciding_black_choice};
use super::types::{
    AdjudicatedBilliardsShot, BilliardsAction, BilliardsBallKind, BilliardsEndReason,
    BilliardsMatchState, BilliardsMode, BilliardsPhase, BilliardsShot, BilliardsSimulationResult,
    ShotAdjudicationInput, SnookerOn,
};

/// External facts needed by the pure action reducer.
#[derive(Clone, Copy, Debug, Default)]
pub struct ReducerContext<'a> {
    /// Required for `billiards.shoot`, absent for non-shot actions.
    pub simulation: Option<&'a BilliardsSimulationResult>,
    /// Index selected by the caller's deterministic random source if a tied
    /// final black requires a toss. Ignored for all other transitions.
    pub deciding_black_chooser_index: usize,
}

fn validate_shot(shot: &BilliardsShot) -> RuleResult<()> {
    let tip_radius_squared = shot.tip.x * shot.tip.x + shot.tip.y * shot.tip.y;
    if !shot.angle.is_finite()
        || !(-std::f64::consts::PI..=std::f64::consts::PI).contains(&shot.angle)
        || !shot.elevation.is_finite()
        || !(0.0..=90.0).contains(&shot.elevation)
        || !shot.power.is_finite()
        || !(1.0..=100.0).contains(&shot.power)
        || !shot.tip.x.is_finite()
        || !shot.tip.y.is_finite()
        || shot.tip.x.abs() > 0.95
        || shot.tip.y.abs() > 0.95
        || tip_radius_squared > 0.95 * 0.95
    {
        return Err(RuleError::invalid(
            "INVALID_SHOT",
            "Shot parameters are outside the supported input range",
        ));
    }
    Ok(())
}

fn transition(state: BilliardsMatchState) -> AdjudicatedBilliardsShot {
    AdjudicatedBilliardsShot {
        foul_code: None,
        points: 0,
        state,
    }
}

/// Reduces one existing wire action into a new match state.
///
/// The caller remains responsible for invoking the physics engine before a
/// shoot action and supplying its immutable summary in `context.simulation`.
pub fn reduce_billiards_action(
    state: &BilliardsMatchState,
    actor_seat_id: &str,
    action: &BilliardsAction,
    context: ReducerContext<'_>,
) -> RuleResult<AdjudicatedBilliardsShot> {
    if state.phase == BilliardsPhase::Ended || state.outcome.is_some() {
        return Err(RuleError::rule(
            "MATCH_ENDED",
            "The match has already ended",
        ));
    }

    if matches!(action, BilliardsAction::Resign) {
        if state.practice {
            return Err(RuleError::rule(
                "RESIGN_NOT_AVAILABLE_IN_PRACTICE",
                "Resignation is unavailable in practice",
            ));
        }
        if !state.seat_ids.iter().any(|seat| seat == actor_seat_id) {
            return Err(RuleError::rule(
                "PLAYER_ONLY",
                "Only a seated player may resign",
            ));
        }
        let winner_seat_id = other_seat(state, actor_seat_id)?;
        return Ok(transition(end_state(
            state,
            winner_seat_id,
            BilliardsEndReason::Resigned,
        )));
    }

    if state.active_seat_id.as_deref() != Some(actor_seat_id) {
        return Err(RuleError::rule(
            "NOT_YOUR_TURN",
            "Only the active player may perform this action",
        ));
    }

    match action {
        BilliardsAction::PlaceCue { x, y } => {
            let Some(zone) = state.ball_in_hand_zone else {
                return Err(RuleError::rule(
                    "CUE_NOT_IN_HAND",
                    "The cue ball is not currently in hand",
                ));
            };
            if state.phase != BilliardsPhase::BallInHand {
                return Err(RuleError::rule(
                    "CUE_NOT_IN_HAND",
                    "The cue ball is not currently in hand",
                ));
            }
            check_cue_placement(state, *x, *y, Some(zone))?;
            let mut next = state.clone();
            next.ball_in_hand_zone = None;
            next.balls = place_cue_ball(&state.balls, *x, *y)?;
            next.phase = BilliardsPhase::Aiming;
            Ok(transition(next))
        }
        BilliardsAction::BreakChoice { choice } => Ok(transition(resolve_eight_ball_break_choice(
            state,
            actor_seat_id,
            *choice,
        )?)),
        BilliardsAction::ChooseGroup { group } => Ok(transition(resolve_eight_ball_group_choice(
            state,
            actor_seat_id,
            *group,
        )?)),
        BilliardsAction::DecidingBlackChoice { choice } => Ok(transition(
            resolve_snooker_deciding_black_choice(state, actor_seat_id, *choice)?,
        )),
        BilliardsAction::Shoot { shot } => {
            validate_shot(shot)?;
            if state.phase != BilliardsPhase::Aiming
                || !state
                    .balls
                    .iter()
                    .any(|ball| ball.kind == BilliardsBallKind::Cue && !ball.pocketed)
            {
                return Err(RuleError::rule(
                    "PLACE_CUE_FIRST",
                    "The cue ball must be placed before shooting",
                ));
            }
            if !state.practice
                && state.settings.mode == BilliardsMode::Snooker
                && state.snooker_on == Some(SnookerOn::Color)
                && shot.nominated_color.is_none()
            {
                return Err(RuleError::rule(
                    "COLOR_NOMINATION_REQUIRED",
                    "A color must be nominated when color is on",
                ));
            }
            let simulation = context.simulation.ok_or_else(|| {
                RuleError::invalid(
                    "SIMULATION_RESULT_REQUIRED",
                    "A shoot action requires an authoritative simulation result",
                )
            })?;
            let input = ShotAdjudicationInput {
                actor_seat_id: actor_seat_id.to_owned(),
                shot: shot.clone(),
                simulation: simulation.clone(),
                state: state.clone(),
            };
            if state.practice {
                adjudicate_practice_shot(&input)
            } else {
                match state.settings.mode {
                    BilliardsMode::ChineseEightBall => adjudicate_chinese_eight_ball_shot(&input),
                    BilliardsMode::Snooker => {
                        adjudicate_snooker_shot(&input, context.deciding_black_chooser_index)
                    }
                }
            }
        }
        BilliardsAction::Resign => unreachable!("resignation is handled before turn validation"),
    }
}
