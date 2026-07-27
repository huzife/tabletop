use super::error::{RuleError, RuleResult};
use super::types::{
    BilliardsBall, BilliardsBallKind, BilliardsEndReason, BilliardsMatchState, BilliardsOutcome,
    BilliardsPhase, BilliardsPlayerState, SeatId, SnookerColor, SnookerOn,
};
use std::collections::HashSet;

pub(crate) const SNOOKER_COLORS_ASCENDING: [SnookerColor; 6] = [
    SnookerColor::Yellow,
    SnookerColor::Green,
    SnookerColor::Brown,
    SnookerColor::Blue,
    SnookerColor::Pink,
    SnookerColor::Black,
];

pub(crate) fn other_seat(state: &BilliardsMatchState, seat_id: &str) -> RuleResult<SeatId> {
    state
        .seat_ids
        .iter()
        .find(|candidate| candidate.as_str() != seat_id)
        .cloned()
        .ok_or_else(|| {
            RuleError::rule(
                "REQUIRES_TWO_PLAYERS",
                "Competitive billiards requires two distinct seats",
            )
        })
}

pub(crate) fn ball_by_id<'a>(balls: &'a [BilliardsBall], id: &str) -> Option<&'a BilliardsBall> {
    balls.iter().find(|ball| ball.id == id)
}

pub(crate) fn newly_potted_balls(
    state: &BilliardsMatchState,
    ids: &[String],
) -> Vec<BilliardsBall> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            continue;
        }
        if let Some(ball) = ball_by_id(&state.balls, id)
            && !ball.pocketed
        {
            result.push(ball.clone());
        }
    }
    result
}

pub(crate) fn mark_cue_ball_in_hand(balls: &[BilliardsBall]) -> Vec<BilliardsBall> {
    balls
        .iter()
        .cloned()
        .map(|mut ball| {
            if ball.kind == BilliardsBallKind::Cue {
                ball.pocketed = true;
            }
            ball
        })
        .collect()
}

pub(crate) fn add_score(
    players: &[BilliardsPlayerState],
    seat_id: &str,
    points: u32,
) -> Vec<BilliardsPlayerState> {
    players
        .iter()
        .cloned()
        .map(|mut player| {
            if player.seat_id == seat_id {
                player.score = player.score.saturating_add(points);
            }
            player
        })
        .collect()
}

pub(crate) fn end_state(
    state: &BilliardsMatchState,
    winner_seat_id: SeatId,
    reason: BilliardsEndReason,
) -> BilliardsMatchState {
    let mut next = state.clone();
    next.active_seat_id = None;
    next.ball_in_hand_zone = None;
    next.outcome = Some(BilliardsOutcome {
        reason,
        winner_seat_id,
    });
    next.pending_decision = None;
    next.phase = BilliardsPhase::Ended;
    next
}

pub(crate) fn require_competitive_players(
    players: &[BilliardsPlayerState],
) -> RuleResult<(&BilliardsPlayerState, &BilliardsPlayerState)> {
    match players {
        [first, second] => Ok((first, second)),
        _ => Err(RuleError::rule(
            "REQUIRES_TWO_PLAYERS",
            "Competitive billiards requires two players",
        )),
    }
}

pub(crate) fn is_snooker_color(kind: BilliardsBallKind) -> bool {
    matches!(
        kind,
        BilliardsBallKind::Yellow
            | BilliardsBallKind::Green
            | BilliardsBallKind::Brown
            | BilliardsBallKind::Blue
            | BilliardsBallKind::Pink
            | BilliardsBallKind::Black
    )
}

pub(crate) fn snooker_color_kind(color: SnookerColor) -> BilliardsBallKind {
    match color {
        SnookerColor::Yellow => BilliardsBallKind::Yellow,
        SnookerColor::Green => BilliardsBallKind::Green,
        SnookerColor::Brown => BilliardsBallKind::Brown,
        SnookerColor::Blue => BilliardsBallKind::Blue,
        SnookerColor::Pink => BilliardsBallKind::Pink,
        SnookerColor::Black => BilliardsBallKind::Black,
    }
}

pub(crate) fn snooker_color_for_on(on: SnookerOn) -> Option<SnookerColor> {
    match on {
        SnookerOn::Yellow => Some(SnookerColor::Yellow),
        SnookerOn::Green => Some(SnookerColor::Green),
        SnookerOn::Brown => Some(SnookerColor::Brown),
        SnookerOn::Blue => Some(SnookerColor::Blue),
        SnookerOn::Pink => Some(SnookerColor::Pink),
        SnookerOn::Black => Some(SnookerColor::Black),
        SnookerOn::Red | SnookerOn::Color => None,
    }
}

pub(crate) fn snooker_color_value(color: SnookerColor) -> u32 {
    match color {
        SnookerColor::Yellow => 2,
        SnookerColor::Green => 3,
        SnookerColor::Brown => 4,
        SnookerColor::Blue => 5,
        SnookerColor::Pink => 6,
        SnookerColor::Black => 7,
    }
}

pub(crate) fn snooker_color_id(color: SnookerColor) -> &'static str {
    match color {
        SnookerColor::Yellow => "yellow",
        SnookerColor::Green => "green",
        SnookerColor::Brown => "brown",
        SnookerColor::Blue => "blue",
        SnookerColor::Pink => "pink",
        SnookerColor::Black => "black",
    }
}
