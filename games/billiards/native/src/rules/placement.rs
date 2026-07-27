use super::error::{RuleError, RuleResult};
use super::types::{BallInHandZone, BilliardsBall, BilliardsBallKind, BilliardsMatchState};
use crate::geometry::table_spec;

const POSITION_EPSILON: f64 = 1e-9;

pub fn check_cue_placement(
    state: &BilliardsMatchState,
    x: f64,
    y: f64,
    zone: Option<BallInHandZone>,
) -> RuleResult<()> {
    let zone = zone
        .or(state.ball_in_hand_zone)
        .unwrap_or(BallInHandZone::Anywhere);
    let table = table_spec(state.settings.mode);
    let radius = table.ball_diameter / 2.0;
    if !x.is_finite()
        || !y.is_finite()
        || x < radius - POSITION_EPSILON
        || x > table.width - radius + POSITION_EPSILON
        || y < radius - POSITION_EPSILON
        || y > table.height - radius + POSITION_EPSILON
    {
        return Err(RuleError::rule(
            "CUE_OUT_OF_BOUNDS",
            "Cue-ball placement is outside the playable surface",
        ));
    }

    if zone == BallInHandZone::D {
        let Some(baulk_line_x) = table.baulk_line_x else {
            return Err(RuleError::rule(
                "CUE_OUTSIDE_D",
                "The selected table has no D",
            ));
        };
        let Some(d_radius) = table.d_radius else {
            return Err(RuleError::rule(
                "CUE_OUTSIDE_D",
                "The selected table has no D",
            ));
        };
        let dx = x - baulk_line_x;
        let dy = y - table.height / 2.0;
        if x > baulk_line_x + POSITION_EPSILON
            || dx * dx + dy * dy > d_radius * d_radius + POSITION_EPSILON
        {
            return Err(RuleError::rule(
                "CUE_OUTSIDE_D",
                "Cue-ball placement must be inside the D",
            ));
        }
    }

    if zone == BallInHandZone::BehindLine
        && table
            .baulk_line_x
            .is_none_or(|baulk_line_x| x > baulk_line_x + POSITION_EPSILON)
    {
        return Err(RuleError::rule(
            "CUE_OUTSIDE_BEHIND_LINE",
            "Cue-ball placement must be behind the baulk line",
        ));
    }

    if table.pockets.iter().any(|pocket| {
        (x - pocket.capture_x).hypot(y - pocket.capture_y)
            < pocket.capture_radius - POSITION_EPSILON
    }) {
        return Err(RuleError::rule(
            "CUE_IN_POCKET",
            "Cue-ball placement overlaps a pocket capture area",
        ));
    }

    if state.balls.iter().any(|ball| {
        ball.kind != BilliardsBallKind::Cue
            && !ball.pocketed
            && (x - ball.x).hypot(y - ball.y) < table.ball_diameter - POSITION_EPSILON
    }) {
        return Err(RuleError::rule(
            "CUE_OVERLAPS_BALL",
            "Cue-ball placement overlaps an object ball",
        ));
    }
    Ok(())
}

pub fn place_cue_ball(balls: &[BilliardsBall], x: f64, y: f64) -> RuleResult<Vec<BilliardsBall>> {
    let mut found = false;
    let placed = balls
        .iter()
        .cloned()
        .map(|mut ball| {
            if ball.kind == BilliardsBallKind::Cue {
                found = true;
                ball.pocketed = false;
                ball.rotation = 0.0;
                ball.x = x;
                ball.y = y;
            }
            ball
        })
        .collect();
    if !found {
        return Err(RuleError::invalid(
            "CUE_BALL_MISSING",
            "Billiards state is missing the cue ball",
        ));
    }
    Ok(placed)
}
