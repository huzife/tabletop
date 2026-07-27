use super::common::mark_cue_ball_in_hand;
use super::error::{RuleError, RuleResult};
use super::types::{
    AdjudicatedBilliardsShot, BallInHandZone, BilliardsBall, BilliardsBallKind, BilliardsLastShot,
    BilliardsPhase, ShotAdjudicationInput,
};
use std::collections::{HashMap, HashSet};

fn merge_pocketed_balls(
    input: &ShotAdjudicationInput,
    cue_ball_potted: bool,
) -> Vec<BilliardsBall> {
    let initial_by_id: HashMap<_, _> = input
        .state
        .balls
        .iter()
        .map(|ball| (ball.id.as_str(), ball))
        .collect();
    let pocketed: HashSet<_> = input
        .simulation
        .pocketed_ball_ids
        .iter()
        .map(String::as_str)
        .collect();
    input
        .simulation
        .balls
        .iter()
        .cloned()
        .map(|mut ball| {
            ball.pocketed = initial_by_id
                .get(ball.id.as_str())
                .is_some_and(|initial| initial.pocketed)
                || ball.pocketed
                || pocketed.contains(ball.id.as_str())
                || ball.kind == BilliardsBallKind::Cue && cue_ball_potted;
            ball
        })
        .collect()
}

/// Applies physics without competitive scoring, fouls, turns, or terminal rules.
pub fn adjudicate_practice_shot(
    input: &ShotAdjudicationInput,
) -> RuleResult<AdjudicatedBilliardsShot> {
    let state = &input.state;
    if !state.practice || state.seat_ids.as_slice() != [input.actor_seat_id.as_str()] {
        return Err(RuleError::rule(
            "PRACTICE_SEAT_REQUIRED",
            "Practice adjudication requires the sole practice seat",
        ));
    }

    let cue_ball_potted = input.simulation.cue_ball_potted
        || input
            .simulation
            .pocketed_ball_ids
            .iter()
            .any(|id| id == "cue");
    let merged = merge_pocketed_balls(input, cue_ball_potted);
    let balls = if cue_ball_potted {
        mark_cue_ball_in_hand(&merged)
    } else {
        merged
    };

    let mut next = state.clone();
    next.active_seat_id = Some(input.actor_seat_id.clone());
    next.ball_in_hand_zone = cue_ball_potted.then_some(BallInHandZone::Anywhere);
    next.balls = balls;
    next.break_shot = false;
    next.deciding_black = false;
    next.last_shot = Some(BilliardsLastShot {
        foul_code: None,
        points: 0,
        potted_ball_ids: input.simulation.pocketed_ball_ids.clone(),
        seat_id: input.actor_seat_id.clone(),
    });
    next.outcome = None;
    next.pending_decision = None;
    next.phase = if cue_ball_potted {
        BilliardsPhase::BallInHand
    } else {
        BilliardsPhase::Aiming
    };
    next.shot_number = state.shot_number.saturating_add(1);
    next.snooker_on = None;

    Ok(AdjudicatedBilliardsShot {
        foul_code: None,
        points: 0,
        state: next,
    })
}
