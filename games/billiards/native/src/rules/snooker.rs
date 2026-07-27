use super::common::{
    SNOOKER_COLORS_ASCENDING, add_score, ball_by_id, end_state, is_snooker_color,
    mark_cue_ball_in_hand, newly_potted_balls, other_seat, require_competitive_players,
    snooker_color_for_on, snooker_color_id, snooker_color_kind, snooker_color_value,
};
use super::error::{RuleError, RuleResult};
use super::types::{
    AdjudicatedBilliardsShot, BallInHandZone, BilliardsBall, BilliardsBallKind,
    BilliardsDecidingBlackChoice, BilliardsEndReason, BilliardsLastShot, BilliardsMatchState,
    BilliardsMode, BilliardsPendingDecision, BilliardsPhase, ShotAdjudicationInput, SnookerColor,
    SnookerOn,
};
use crate::geometry::table_spec;
use std::collections::HashSet;

fn with_potted_flags(
    balls: &[BilliardsBall],
    pocketed_ids: &[String],
    cue_potted: bool,
) -> Vec<BilliardsBall> {
    let pocketed: HashSet<_> = pocketed_ids.iter().map(String::as_str).collect();
    balls
        .iter()
        .cloned()
        .map(|mut ball| {
            ball.pocketed = ball.pocketed
                || pocketed.contains(ball.id.as_str())
                || ball.kind == BilliardsBallKind::Cue && cue_potted;
            ball
        })
        .collect()
}

fn color_from_kind(kind: BilliardsBallKind) -> Option<SnookerColor> {
    match kind {
        BilliardsBallKind::Yellow => Some(SnookerColor::Yellow),
        BilliardsBallKind::Green => Some(SnookerColor::Green),
        BilliardsBallKind::Brown => Some(SnookerColor::Brown),
        BilliardsBallKind::Blue => Some(SnookerColor::Blue),
        BilliardsBallKind::Pink => Some(SnookerColor::Pink),
        BilliardsBallKind::Black => Some(SnookerColor::Black),
        _ => None,
    }
}

fn color_spot_position(
    color: SnookerColor,
    balls: &[BilliardsBall],
    ignored_ball_id: &str,
) -> Option<(f64, f64)> {
    let table = table_spec(BilliardsMode::Snooker);
    let own = table
        .spots
        .iter()
        .find(|spot| spot.id == snooker_color_id(color))
        .copied()?;
    let radius = table.ball_diameter / 2.0;
    let occupied = |x: f64, y: f64| {
        balls.iter().any(|ball| {
            ball.id != ignored_ball_id
                && !ball.pocketed
                && (x - ball.x).hypot(y - ball.y) < table.ball_diameter - 1e-9
        })
    };
    if !occupied(own.x, own.y) {
        return Some((own.x, own.y));
    }

    for candidate in SNOOKER_COLORS_ASCENDING.iter().rev().copied() {
        if let Some(spot) = table
            .spots
            .iter()
            .find(|spot| spot.id == snooker_color_id(candidate))
            && !occupied(spot.x, spot.y)
        {
            return Some((spot.x, spot.y));
        }
    }

    for step in 1..500 {
        let x = (own.x + step as f64 * radius / 2.0).min(table.width - radius);
        if !occupied(x, own.y) {
            return Some((x, own.y));
        }
        if x >= table.width - radius {
            break;
        }
    }
    for step in 1..500 {
        let x = (own.x - step as f64 * radius / 2.0).max(radius);
        if !occupied(x, own.y) {
            return Some((x, own.y));
        }
        if x <= radius {
            break;
        }
    }
    None
}

fn respot_colors(balls: &[BilliardsBall], ids: &[String]) -> Vec<BilliardsBall> {
    let mut seen = HashSet::new();
    let mut color_ids: Vec<_> = ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .filter(|id| ball_by_id(balls, id).is_some_and(|ball| is_snooker_color(ball.kind)))
        .cloned()
        .collect();
    color_ids.sort_by(|first, second| {
        let first_value = ball_by_id(balls, first).map_or(0, |ball| ball.value);
        let second_value = ball_by_id(balls, second).map_or(0, |ball| ball.value);
        second_value.cmp(&first_value)
    });

    let mut next = balls.to_vec();
    for id in color_ids {
        let Some(ball) = ball_by_id(&next, &id) else {
            continue;
        };
        let Some(color) = color_from_kind(ball.kind) else {
            continue;
        };
        let Some((x, y)) = color_spot_position(color, &next, &id) else {
            continue;
        };
        for candidate in &mut next {
            if candidate.id == id {
                candidate.pocketed = false;
                candidate.x = x;
                candidate.y = y;
            }
        }
    }
    next
}

fn reds_remaining(balls: &[BilliardsBall]) -> usize {
    balls
        .iter()
        .filter(|ball| ball.kind == BilliardsBallKind::Red && !ball.pocketed)
        .count()
}

fn colors_remaining(balls: &[BilliardsBall]) -> usize {
    balls
        .iter()
        .filter(|ball| is_snooker_color(ball.kind) && !ball.pocketed)
        .count()
}

fn next_color_after(on: SnookerOn) -> Option<SnookerOn> {
    match on {
        SnookerOn::Yellow => Some(SnookerOn::Green),
        SnookerOn::Green => Some(SnookerOn::Brown),
        SnookerOn::Brown => Some(SnookerOn::Blue),
        SnookerOn::Blue => Some(SnookerOn::Pink),
        SnookerOn::Pink => Some(SnookerOn::Black),
        SnookerOn::Black | SnookerOn::Red | SnookerOn::Color => None,
    }
}

fn require_nomination(input: &ShotAdjudicationInput) -> RuleResult<()> {
    if input.state.snooker_on == Some(SnookerOn::Color) && input.shot.nominated_color.is_none() {
        return Err(RuleError::rule(
            "COLOR_NOMINATION_REQUIRED",
            "A color must be nominated when color is on",
        ));
    }
    Ok(())
}

fn final_black_resolution(
    input: &ShotAdjudicationInput,
    balls: Vec<BilliardsBall>,
    players: Vec<super::types::BilliardsPlayerState>,
    foul_code: Option<&str>,
    points: u32,
    chooser_index: usize,
) -> RuleResult<AdjudicatedBilliardsShot> {
    let (tie, winner_seat_id) = {
        let (first_player, second_player) = require_competitive_players(&players)?;
        (
            first_player.score == second_player.score,
            if first_player.score > second_player.score {
                first_player.seat_id.clone()
            } else {
                second_player.seat_id.clone()
            },
        )
    };
    let mut base = input.state.clone();
    base.balls = balls;
    base.break_shot = false;
    base.last_shot = Some(BilliardsLastShot {
        foul_code: foul_code.map(str::to_owned),
        points,
        potted_ball_ids: input.simulation.pocketed_ball_ids.clone(),
        seat_id: input.actor_seat_id.clone(),
    });
    base.players = players;
    base.shot_number = input.state.shot_number.saturating_add(1);

    if tie {
        let chooser_seat_id = input
            .state
            .seat_ids
            .get(chooser_index)
            .cloned()
            .ok_or_else(|| {
                RuleError::invalid(
                    "INVALID_DECIDING_BLACK_CHOOSER_INDEX",
                    "The deciding-black chooser index is outside the seat list",
                )
            })?;
        let black_id = base
            .balls
            .iter()
            .find(|ball| ball.kind == BilliardsBallKind::Black)
            .map(|ball| ball.id.clone());
        let with_cue = mark_cue_ball_in_hand(&base.balls);
        base.balls = black_id
            .map(|id| respot_colors(&with_cue, &[id]))
            .unwrap_or(with_cue);
        base.active_seat_id = Some(chooser_seat_id.clone());
        base.ball_in_hand_zone = None;
        base.deciding_black = true;
        base.outcome = None;
        base.pending_decision = Some(BilliardsPendingDecision::DecidingBlackChoice {
            chooser_seat_id,
            choices: vec![
                BilliardsDecidingBlackChoice::PlaySelf,
                BilliardsDecidingBlackChoice::Defer,
            ],
        });
        base.phase = BilliardsPhase::Decision;
        base.snooker_on = Some(SnookerOn::Black);
        return Ok(AdjudicatedBilliardsShot {
            foul_code: foul_code.map(str::to_owned),
            points,
            state: base,
        });
    }

    base.deciding_black = false;
    base.phase = BilliardsPhase::Aiming;
    base.snooker_on = Some(SnookerOn::Black);
    let ended = end_state(&base, winner_seat_id, BilliardsEndReason::FinalBlack);
    Ok(AdjudicatedBilliardsShot {
        foul_code: foul_code.map(str::to_owned),
        points,
        state: ended,
    })
}

/// Applies one authoritative snooker shot. `chooser_index` is only consulted
/// when the shot creates a tied, respotted-black decision.
pub fn adjudicate_snooker_shot(
    input: &ShotAdjudicationInput,
    chooser_index: usize,
) -> RuleResult<AdjudicatedBilliardsShot> {
    require_nomination(input)?;
    let state = &input.state;
    let actor_seat_id = input.actor_seat_id.as_str();
    let opponent_seat_id = other_seat(state, actor_seat_id)?;
    let potted = newly_potted_balls(state, &input.simulation.pocketed_ball_ids);
    let object_potted: Vec<_> = potted
        .iter()
        .filter(|ball| ball.kind != BilliardsBallKind::Cue)
        .cloned()
        .collect();
    let cue_potted = input.simulation.cue_ball_potted
        || potted
            .iter()
            .any(|ball| ball.kind == BilliardsBallKind::Cue);
    let first_balls: Vec<_> = input
        .simulation
        .first_contact_ball_ids
        .iter()
        .filter_map(|id| ball_by_id(&state.balls, id))
        .collect();
    let jumped_balls: Vec<_> = input
        .simulation
        .jumped_ball_ids
        .iter()
        .filter_map(|id| ball_by_id(&state.balls, id))
        .collect();

    let on = state.snooker_on.unwrap_or(SnookerOn::Red);
    let target_kind = match on {
        SnookerOn::Red => BilliardsBallKind::Red,
        SnookerOn::Color => {
            let nominated = input.shot.nominated_color.ok_or_else(|| {
                RuleError::rule(
                    "COLOR_NOMINATION_REQUIRED",
                    "A color must be nominated when color is on",
                )
            })?;
            snooker_color_kind(nominated)
        }
        ordered => snooker_color_kind(snooker_color_for_on(ordered).ok_or_else(|| {
            RuleError::invalid(
                "INVALID_SNOOKER_ON",
                "The current snooker target cannot be resolved",
            )
        })?),
    };
    let target_value = if target_kind == BilliardsBallKind::Red {
        1
    } else {
        color_from_kind(target_kind).map_or(0, snooker_color_value)
    };
    let wrong_first =
        first_balls.is_empty() || first_balls.iter().any(|ball| ball.kind != target_kind);
    let wrong_potted = object_potted.iter().any(|ball| ball.kind != target_kind);
    let no_contact = input.simulation.first_contact_ball_ids.is_empty();

    let mut foul_code = if no_contact {
        Some("NO_BALL_CONTACT")
    } else if wrong_first {
        Some("WRONG_FIRST_CONTACT")
    } else if wrong_potted {
        Some("WRONG_BALL_POTTED")
    } else {
        None
    };
    if cue_potted {
        foul_code = Some("CUE_BALL_POTTED");
    }
    if !input.simulation.jumped_ball_ids.is_empty() {
        foul_code = Some("JUMP_SHOT");
    }

    let mut balls = with_potted_flags(
        &input.simulation.balls,
        &input.simulation.pocketed_ball_ids,
        cue_potted,
    );
    let reds_after = reds_remaining(&balls);
    let potted_red_count = object_potted
        .iter()
        .filter(|ball| ball.kind == BilliardsBallKind::Red)
        .count() as u32;
    let target_potted = object_potted.iter().any(|ball| ball.kind == target_kind);
    let points = if foul_code.is_none() {
        if on == SnookerOn::Red {
            potted_red_count
        } else if target_potted {
            target_value
        } else {
            0
        }
    } else {
        let mut penalty = 4_u32.max(target_value);
        for ball in first_balls
            .iter()
            .copied()
            .chain(jumped_balls.iter().copied())
            .chain(object_potted.iter())
        {
            penalty = penalty.max(u32::from(ball.value));
        }
        penalty
    };

    let respot_ids: Vec<_> = if reds_after > 0 || on == SnookerOn::Red || on == SnookerOn::Color {
        object_potted
            .iter()
            .filter(|ball| is_snooker_color(ball.kind))
            .map(|ball| ball.id.clone())
            .collect()
    } else if foul_code.is_some() {
        object_potted
            .iter()
            .filter(|ball| is_snooker_color(ball.kind))
            .map(|ball| ball.id.clone())
            .collect()
    } else {
        object_potted
            .iter()
            .filter(|ball| is_snooker_color(ball.kind) && ball.kind != target_kind)
            .map(|ball| ball.id.clone())
            .collect()
    };
    if !respot_ids.is_empty() {
        balls = respot_colors(&balls, &respot_ids);
    }

    let players = if foul_code.is_none() {
        add_score(&state.players, actor_seat_id, points)
    } else {
        add_score(&state.players, &opponent_seat_id, points)
    };
    let final_black = on == SnookerOn::Black && reds_after == 0 && colors_remaining(&balls) <= 1;
    if final_black && (foul_code.is_some() || target_potted) {
        return final_black_resolution(input, balls, players, foul_code, points, chooser_index);
    }

    let (next_on, continue_turn) = if foul_code.is_some() {
        match on {
            // If the final red was removed during a foul, no optional color is
            // due: the incoming player starts the ordered clearance at yellow.
            SnookerOn::Red => (
                if reds_after > 0 {
                    SnookerOn::Red
                } else {
                    SnookerOn::Yellow
                },
                false,
            ),
            SnookerOn::Color => (
                if reds_after > 0 {
                    SnookerOn::Red
                } else {
                    SnookerOn::Yellow
                },
                false,
            ),
            ordered => (ordered, false),
        }
    } else {
        match on {
            SnookerOn::Red if potted_red_count > 0 => (SnookerOn::Color, true),
            SnookerOn::Red => (
                if reds_after > 0 {
                    SnookerOn::Red
                } else {
                    SnookerOn::Color
                },
                false,
            ),
            SnookerOn::Color => (
                if reds_after > 0 {
                    SnookerOn::Red
                } else {
                    SnookerOn::Yellow
                },
                target_potted,
            ),
            ordered => (
                if target_potted {
                    next_color_after(ordered).unwrap_or(SnookerOn::Black)
                } else {
                    ordered
                },
                target_potted,
            ),
        }
    };

    let ball_in_hand = cue_potted;
    let next_seat_id = if continue_turn && foul_code.is_none() {
        input.actor_seat_id.clone()
    } else {
        opponent_seat_id
    };
    if ball_in_hand {
        balls = mark_cue_ball_in_hand(&balls);
    }
    let mut next = state.clone();
    next.active_seat_id = Some(next_seat_id);
    next.ball_in_hand_zone = ball_in_hand.then_some(BallInHandZone::D);
    next.balls = balls;
    next.break_shot = false;
    next.last_shot = Some(BilliardsLastShot {
        foul_code: foul_code.map(str::to_owned),
        points,
        potted_ball_ids: input.simulation.pocketed_ball_ids.clone(),
        seat_id: input.actor_seat_id.clone(),
    });
    next.outcome = None;
    next.phase = if ball_in_hand {
        BilliardsPhase::BallInHand
    } else {
        BilliardsPhase::Aiming
    };
    next.players = players;
    next.shot_number = state.shot_number.saturating_add(1);
    next.snooker_on = Some(next_on);
    Ok(AdjudicatedBilliardsShot {
        foul_code: foul_code.map(str::to_owned),
        points,
        state: next,
    })
}

pub fn resolve_snooker_deciding_black_choice(
    state: &BilliardsMatchState,
    actor_seat_id: &str,
    choice: BilliardsDecidingBlackChoice,
) -> RuleResult<BilliardsMatchState> {
    let Some(BilliardsPendingDecision::DecidingBlackChoice {
        chooser_seat_id,
        choices,
    }) = state.pending_decision.as_ref()
    else {
        return Err(RuleError::rule(
            "NO_DECIDING_BLACK_DECISION_PENDING",
            "There is no deciding-black decision to resolve",
        ));
    };
    if state.settings.mode != BilliardsMode::Snooker
        || !state.deciding_black
        || state.phase != BilliardsPhase::Decision
    {
        return Err(RuleError::rule(
            "NO_DECIDING_BLACK_DECISION_PENDING",
            "There is no deciding-black decision to resolve",
        ));
    }
    if chooser_seat_id != actor_seat_id {
        return Err(RuleError::rule(
            "NOT_YOUR_TURN",
            "Only the deciding-black chooser may act",
        ));
    }
    if !choices.contains(&choice) {
        return Err(RuleError::rule(
            "DECIDING_BLACK_CHOICE_NOT_AVAILABLE",
            "The selected deciding-black choice is not available",
        ));
    }

    let active_seat_id = match choice {
        BilliardsDecidingBlackChoice::PlaySelf => actor_seat_id.to_owned(),
        BilliardsDecidingBlackChoice::Defer => other_seat(state, actor_seat_id)?,
    };
    let mut next = state.clone();
    next.active_seat_id = Some(active_seat_id);
    next.ball_in_hand_zone = Some(BallInHandZone::D);
    next.pending_decision = None;
    next.phase = BilliardsPhase::BallInHand;
    Ok(next)
}
