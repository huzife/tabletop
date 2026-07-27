use super::common::{ball_by_id, end_state, mark_cue_ball_in_hand, newly_potted_balls, other_seat};
use super::error::{RuleError, RuleResult};
use super::setup::rerack_chinese_eight_ball;
use super::types::{
    AdjudicatedBilliardsShot, BallInHandZone, BilliardsBall, BilliardsBallKind,
    BilliardsBreakChoice, BilliardsEndReason, BilliardsLastShot, BilliardsMatchState,
    BilliardsPendingDecision, BilliardsPhase, BilliardsSelectableGroup, BreakDecisionReason,
    EightBallGroup, ShotAdjudicationInput,
};
use crate::geometry::table_spec;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShotTarget {
    Open,
    Solids,
    Stripes,
    Eight,
}

fn break_choices(reason: BreakDecisionReason) -> Vec<BilliardsBreakChoice> {
    match reason {
        BreakDecisionReason::IllegalBreak => vec![
            BilliardsBreakChoice::AcceptTable,
            BilliardsBreakChoice::RerackSelf,
            BilliardsBreakChoice::RerackOpponent,
        ],
        BreakDecisionReason::BreakFoul => vec![
            BilliardsBreakChoice::TakeLineInHand,
            BilliardsBreakChoice::RerackSelf,
            BilliardsBreakChoice::RerackOpponent,
        ],
        BreakDecisionReason::EightOnBreak => vec![
            BilliardsBreakChoice::SpotEight,
            BilliardsBreakChoice::RerackSelf,
        ],
        BreakDecisionReason::EightOnBreakFoul => vec![
            BilliardsBreakChoice::SpotEight,
            BilliardsBreakChoice::RerackSelf,
            BilliardsBreakChoice::RerackOpponent,
        ],
    }
}

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

fn player_group(state: &BilliardsMatchState, seat_id: &str) -> EightBallGroup {
    state
        .players
        .iter()
        .find(|player| player.seat_id == seat_id)
        .and_then(|player| player.group)
        .unwrap_or(EightBallGroup::Open)
}

fn group_of_ball(ball: &BilliardsBall) -> Option<BilliardsSelectableGroup> {
    match ball.kind {
        BilliardsBallKind::Solid => Some(BilliardsSelectableGroup::Solids),
        BilliardsBallKind::Stripe => Some(BilliardsSelectableGroup::Stripes),
        _ => None,
    }
}

fn eight_group(group: BilliardsSelectableGroup) -> EightBallGroup {
    match group {
        BilliardsSelectableGroup::Solids => EightBallGroup::Solids,
        BilliardsSelectableGroup::Stripes => EightBallGroup::Stripes,
    }
}

fn count_potted_group(balls: &[BilliardsBall], group: EightBallGroup) -> u32 {
    balls
        .iter()
        .filter(|ball| {
            ball.pocketed
                && matches!(
                    (group, ball.kind),
                    (EightBallGroup::Solids, BilliardsBallKind::Solid)
                        | (EightBallGroup::Stripes, BilliardsBallKind::Stripe)
                )
        })
        .count() as u32
}

fn recompute_scores(
    players: &[super::types::BilliardsPlayerState],
    balls: &[BilliardsBall],
) -> Vec<super::types::BilliardsPlayerState> {
    players
        .iter()
        .cloned()
        .map(|mut player| {
            player.score = match player.group {
                Some(EightBallGroup::Solids) => count_potted_group(balls, EightBallGroup::Solids),
                Some(EightBallGroup::Stripes) => count_potted_group(balls, EightBallGroup::Stripes),
                Some(EightBallGroup::Open) | None => 0,
            };
            player
        })
        .collect()
}

fn assign_groups(
    players: &[super::types::BilliardsPlayerState],
    chooser_seat_id: &str,
    group: BilliardsSelectableGroup,
) -> RuleResult<Vec<super::types::BilliardsPlayerState>> {
    let opponent_seat_id = players
        .iter()
        .find(|player| player.seat_id != chooser_seat_id)
        .map(|player| player.seat_id.clone())
        .ok_or_else(|| {
            RuleError::rule(
                "REQUIRES_TWO_PLAYERS",
                "Heyball group assignment requires two players",
            )
        })?;
    let opponent_group = match group {
        BilliardsSelectableGroup::Solids => BilliardsSelectableGroup::Stripes,
        BilliardsSelectableGroup::Stripes => BilliardsSelectableGroup::Solids,
    };
    Ok(players
        .iter()
        .cloned()
        .map(|mut player| {
            if player.seat_id == chooser_seat_id {
                player.group = Some(eight_group(group));
            } else if player.seat_id == opponent_seat_id {
                player.group = Some(eight_group(opponent_group));
            }
            player
        })
        .collect())
}

fn state_after_shot(
    state: &BilliardsMatchState,
    actor_seat_id: &str,
    balls: Vec<BilliardsBall>,
    potted_ball_ids: &[String],
    foul_code: Option<&str>,
) -> BilliardsMatchState {
    let mut next = state.clone();
    next.balls = balls;
    next.break_shot = false;
    next.last_shot = Some(BilliardsLastShot {
        foul_code: foul_code.map(str::to_owned),
        points: 0,
        potted_ball_ids: potted_ball_ids.to_vec(),
        seat_id: actor_seat_id.to_owned(),
    });
    next.outcome = None;
    next.pending_decision = None;
    next.shot_number = state.shot_number.saturating_add(1);
    next
}

fn pending_break_decision(
    input: &ShotAdjudicationInput,
    chooser_seat_id: String,
    balls: Vec<BilliardsBall>,
    reason: BreakDecisionReason,
    foul_code: Option<&str>,
) -> AdjudicatedBilliardsShot {
    let pending_decision = BilliardsPendingDecision::BreakChoice {
        breaker_seat_id: input.actor_seat_id.clone(),
        chooser_seat_id: chooser_seat_id.clone(),
        choices: break_choices(reason),
        reason,
    };
    let mut state = state_after_shot(
        &input.state,
        &input.actor_seat_id,
        balls,
        &input.simulation.pocketed_ball_ids,
        foul_code,
    );
    state.active_seat_id = Some(chooser_seat_id);
    state.ball_in_hand_zone = None;
    state.pending_decision = Some(pending_decision);
    state.phase = BilliardsPhase::Decision;
    AdjudicatedBilliardsShot {
        foul_code: foul_code.map(str::to_owned),
        points: 0,
        state,
    }
}

fn spot_eight_ball(balls: &[BilliardsBall]) -> RuleResult<Vec<BilliardsBall>> {
    let table = table_spec(super::types::BilliardsMode::ChineseEightBall);
    let spot = table
        .spots
        .iter()
        .find(|spot| spot.id == "foot")
        .copied()
        .ok_or_else(|| {
            RuleError::internal(
                "CHINESE_TABLE_MISSING_FOOT_SPOT",
                "Heyball table is missing the foot spot",
            )
        })?;
    if !balls
        .iter()
        .any(|ball| ball.kind == BilliardsBallKind::Eight)
    {
        return Err(RuleError::invalid(
            "EIGHT_BALL_MISSING",
            "Heyball state is missing the eight ball",
        ));
    }

    let radius = table.ball_diameter / 2.0;
    let without_eight: Vec<_> = balls
        .iter()
        .cloned()
        .map(|mut ball| {
            if ball.kind == BilliardsBallKind::Eight {
                ball.pocketed = true;
            }
            ball
        })
        .collect();
    let is_free = |x: f64, y: f64| {
        without_eight.iter().all(|ball| {
            ball.pocketed || (x - ball.x).hypot(y - ball.y) >= table.ball_diameter - 1e-9
        })
    };

    let mut candidates = vec![(spot.x, spot.y)];
    let mut offset = radius / 2.0;
    while spot.x + offset <= table.width - radius {
        candidates.push((spot.x + offset, spot.y));
        offset += radius / 2.0;
    }
    offset = radius / 2.0;
    while spot.x - offset >= radius {
        candidates.push((spot.x - offset, spot.y));
        offset += radius / 2.0;
    }
    let (x, y) = candidates
        .into_iter()
        .find(|(x, y)| is_free(*x, *y))
        .ok_or_else(|| {
            RuleError::rule(
                "EIGHT_CANNOT_BE_SPOTTED",
                "No legal position is available for the eight ball",
            )
        })?;

    Ok(balls
        .iter()
        .cloned()
        .map(|mut ball| {
            if ball.kind == BilliardsBallKind::Eight {
                ball.pocketed = false;
                ball.rotation = 0.0;
                ball.x = x;
                ball.y = y;
            }
            ball
        })
        .collect())
}

/// Applies one authoritative shot using the behavior of the existing
/// TypeScript Chinese-eight-ball reducer.
pub fn adjudicate_chinese_eight_ball_shot(
    input: &ShotAdjudicationInput,
) -> RuleResult<AdjudicatedBilliardsShot> {
    let state = &input.state;
    let actor_seat_id = input.actor_seat_id.as_str();
    let opponent_seat_id = other_seat(state, actor_seat_id)?;
    let potted = newly_potted_balls(state, &input.simulation.pocketed_ball_ids);
    let object_potted: Vec<_> = potted
        .iter()
        .filter(|ball| ball.kind != BilliardsBallKind::Cue)
        .cloned()
        .collect();
    let eight_potted = object_potted
        .iter()
        .any(|ball| ball.kind == BilliardsBallKind::Eight);
    let cue_potted = input.simulation.cue_ball_potted
        || potted
            .iter()
            .any(|ball| ball.kind == BilliardsBallKind::Cue);

    let mut seen_first = HashSet::new();
    let unique_first_ids: Vec<_> = input
        .simulation
        .first_contact_ball_ids
        .iter()
        .filter(|id| seen_first.insert(id.as_str()))
        .collect();
    let first_balls: Vec<_> = unique_first_ids
        .iter()
        .filter_map(|id| ball_by_id(&state.balls, id))
        .collect();
    let jumped_balls: Vec<_> = input
        .simulation
        .jumped_ball_ids
        .iter()
        .filter_map(|id| ball_by_id(&state.balls, id))
        .collect();

    let group = player_group(state, actor_seat_id);
    let own_remaining = match group {
        EightBallGroup::Solids => state
            .balls
            .iter()
            .any(|ball| !ball.pocketed && ball.kind == BilliardsBallKind::Solid),
        EightBallGroup::Stripes => state
            .balls
            .iter()
            .any(|ball| !ball.pocketed && ball.kind == BilliardsBallKind::Stripe),
        EightBallGroup::Open => false,
    };
    let target = match (group, own_remaining) {
        (EightBallGroup::Open, _) => ShotTarget::Open,
        (EightBallGroup::Solids, true) => ShotTarget::Solids,
        (EightBallGroup::Stripes, true) => ShotTarget::Stripes,
        (EightBallGroup::Solids | EightBallGroup::Stripes, false) => ShotTarget::Eight,
    };
    let legal_first_exists = first_balls.iter().any(|first| {
        if state.break_shot {
            return first.kind != BilliardsBallKind::Cue;
        }
        matches!(
            (target, first.kind),
            (
                ShotTarget::Open,
                BilliardsBallKind::Solid | BilliardsBallKind::Stripe
            ) | (ShotTarget::Solids, BilliardsBallKind::Solid)
                | (ShotTarget::Stripes, BilliardsBallKind::Stripe)
                | (ShotTarget::Eight, BilliardsBallKind::Eight)
        )
    });
    let no_contact = unique_first_ids.is_empty();
    let unknown_first_contact = first_balls.len() != unique_first_ids.len();
    let wrong_first = !no_contact && (unknown_first_contact || !legal_first_exists);
    let illegal_jump = input.shot.tip.y < 0.0 && !jumped_balls.is_empty();

    let initial_by_id = |id: &str| ball_by_id(&state.balls, id);
    let distinct_object_rail_contacts: HashSet<_> = input
        .simulation
        .post_contact_rail_ball_ids
        .iter()
        .filter_map(|id| {
            initial_by_id(id).and_then(|ball| {
                (ball.kind != BilliardsBallKind::Cue && !ball.pocketed).then_some(id.as_str())
            })
        })
        .collect();
    let distinct_post_contact_rails: HashSet<_> = input
        .simulation
        .post_contact_rail_ball_ids
        .iter()
        .filter_map(|id| initial_by_id(id).and_then(|ball| (!ball.pocketed).then_some(id.as_str())))
        .collect();
    let no_rail_or_pocket = object_potted.is_empty() && distinct_post_contact_rails.is_empty();

    let mut foul_code = if cue_potted {
        Some("CUE_BALL_POTTED")
    } else if illegal_jump {
        Some("ILLEGAL_JUMP")
    } else if no_contact {
        Some("NO_OBJECT_CONTACT")
    } else if wrong_first {
        Some("WRONG_FIRST_CONTACT")
    } else if !state.break_shot && no_rail_or_pocket {
        Some("NO_RAIL_OR_POCKET")
    } else {
        None
    };

    let mut balls = with_potted_flags(
        &input.simulation.balls,
        &input.simulation.pocketed_ball_ids,
        cue_potted,
    );
    if state.break_shot {
        let meets_break_requirement =
            !object_potted.is_empty() || distinct_object_rail_contacts.len() >= 4;
        if foul_code.is_none() && !meets_break_requirement {
            foul_code = Some("ILLEGAL_BREAK");
        }
        if eight_potted {
            let clean = foul_code.is_none();
            return Ok(pending_break_decision(
                input,
                if clean {
                    input.actor_seat_id.clone()
                } else {
                    opponent_seat_id
                },
                balls,
                if clean {
                    BreakDecisionReason::EightOnBreak
                } else {
                    BreakDecisionReason::EightOnBreakFoul
                },
                foul_code,
            ));
        }
        if foul_code == Some("ILLEGAL_BREAK") {
            return Ok(pending_break_decision(
                input,
                opponent_seat_id,
                balls,
                BreakDecisionReason::IllegalBreak,
                foul_code,
            ));
        }
        if foul_code.is_some() {
            return Ok(pending_break_decision(
                input,
                opponent_seat_id,
                balls,
                BreakDecisionReason::BreakFoul,
                foul_code,
            ));
        }

        let continue_turn = object_potted
            .iter()
            .any(|ball| group_of_ball(ball).is_some());
        let mut next = state_after_shot(
            state,
            actor_seat_id,
            balls,
            &input.simulation.pocketed_ball_ids,
            None,
        );
        next.active_seat_id = Some(if continue_turn {
            input.actor_seat_id.clone()
        } else {
            opponent_seat_id
        });
        next.ball_in_hand_zone = None;
        next.phase = BilliardsPhase::Aiming;
        return Ok(AdjudicatedBilliardsShot {
            foul_code: None,
            points: 0,
            state: next,
        });
    }

    let eight_is_legal_target = target == ShotTarget::Eight;
    if eight_potted {
        let eight_win = eight_is_legal_target && foul_code.is_none();
        let final_foul_code = if eight_win {
            None
        } else if eight_is_legal_target {
            Some("EIGHT_BALL_POTTED_ON_FOUL")
        } else {
            Some("EIGHT_BALL_POTTED_EARLY")
        };
        let mut base = state_after_shot(
            state,
            actor_seat_id,
            balls.clone(),
            &input.simulation.pocketed_ball_ids,
            final_foul_code,
        );
        base.pending_decision = None;
        base.phase = BilliardsPhase::Aiming;
        base.players = recompute_scores(&state.players, &balls);
        let ended = end_state(
            &base,
            if eight_win {
                input.actor_seat_id.clone()
            } else {
                opponent_seat_id
            },
            BilliardsEndReason::EightBall,
        );
        return Ok(AdjudicatedBilliardsShot {
            foul_code: final_foul_code.map(str::to_owned),
            points: 0,
            state: ended,
        });
    }

    let first_groups: HashSet<_> = first_balls
        .iter()
        .filter_map(|ball| group_of_ball(ball))
        .collect();
    let potted_groups: HashSet<_> = object_potted.iter().filter_map(group_of_ball).collect();
    let mut players = state.players.clone();
    if foul_code.is_none() && group == EightBallGroup::Open {
        let assigned_group = if first_groups.len() == 1 {
            first_groups
                .iter()
                .next()
                .copied()
                .filter(|first| potted_groups.contains(first))
        } else if first_groups.len() == 2 && potted_groups.len() == 1 {
            potted_groups.iter().next().copied()
        } else {
            None
        };
        if let Some(assigned_group) = assigned_group {
            players = assign_groups(&players, actor_seat_id, assigned_group)?;
        }

        if first_groups.len() == 2 && potted_groups.len() == 2 {
            let mut next = state_after_shot(
                state,
                actor_seat_id,
                balls,
                &input.simulation.pocketed_ball_ids,
                None,
            );
            next.active_seat_id = Some(input.actor_seat_id.clone());
            next.ball_in_hand_zone = None;
            next.pending_decision = Some(BilliardsPendingDecision::ChooseGroup {
                chooser_seat_id: input.actor_seat_id.clone(),
                groups: vec![
                    BilliardsSelectableGroup::Solids,
                    BilliardsSelectableGroup::Stripes,
                ],
            });
            next.phase = BilliardsPhase::Decision;
            next.players = recompute_scores(&players, &next.balls);
            return Ok(AdjudicatedBilliardsShot {
                foul_code: None,
                points: 0,
                state: next,
            });
        }
    }
    players = recompute_scores(&players, &balls);

    if let Some(foul_code) = foul_code {
        balls = mark_cue_ball_in_hand(&balls);
        let mut next = state_after_shot(
            state,
            actor_seat_id,
            balls,
            &input.simulation.pocketed_ball_ids,
            Some(foul_code),
        );
        next.active_seat_id = Some(opponent_seat_id);
        next.ball_in_hand_zone = Some(BallInHandZone::Anywhere);
        next.phase = BilliardsPhase::BallInHand;
        next.players = players;
        return Ok(AdjudicatedBilliardsShot {
            foul_code: Some(foul_code.to_owned()),
            points: 0,
            state: next,
        });
    }

    let actor_group = players
        .iter()
        .find(|player| player.seat_id == actor_seat_id)
        .and_then(|player| player.group)
        .unwrap_or(EightBallGroup::Open);
    let scoring_pot = match actor_group {
        // A ball from the opposite group alone is not a legal scoring pot on
        // an open table, so it cannot extend the visit.
        EightBallGroup::Open => potted_groups
            .iter()
            .any(|potted_group| first_groups.contains(potted_group)),
        EightBallGroup::Solids => object_potted
            .iter()
            .any(|ball| ball.kind == BilliardsBallKind::Solid),
        EightBallGroup::Stripes => object_potted
            .iter()
            .any(|ball| ball.kind == BilliardsBallKind::Stripe),
    };
    let mut next = state_after_shot(
        state,
        actor_seat_id,
        balls,
        &input.simulation.pocketed_ball_ids,
        None,
    );
    next.active_seat_id = Some(if scoring_pot {
        input.actor_seat_id.clone()
    } else {
        opponent_seat_id
    });
    next.ball_in_hand_zone = None;
    next.phase = BilliardsPhase::Aiming;
    next.players = players;
    Ok(AdjudicatedBilliardsShot {
        foul_code: None,
        points: 0,
        state: next,
    })
}

pub fn resolve_eight_ball_break_choice(
    state: &BilliardsMatchState,
    actor_seat_id: &str,
    choice: BilliardsBreakChoice,
) -> RuleResult<BilliardsMatchState> {
    let Some(BilliardsPendingDecision::BreakChoice {
        reason,
        breaker_seat_id,
        chooser_seat_id,
        choices,
    }) = state.pending_decision.as_ref()
    else {
        return Err(RuleError::rule(
            "NO_BREAK_DECISION_PENDING",
            "There is no break decision to resolve",
        ));
    };
    if state.phase != BilliardsPhase::Decision {
        return Err(RuleError::rule(
            "NO_BREAK_DECISION_PENDING",
            "There is no break decision to resolve",
        ));
    }
    if chooser_seat_id != actor_seat_id {
        return Err(RuleError::rule(
            "NOT_YOUR_TURN",
            "Only the break-decision chooser may act",
        ));
    }
    if !choices.contains(&choice) {
        return Err(RuleError::rule(
            "BREAK_CHOICE_NOT_AVAILABLE",
            "The selected break choice is not available",
        ));
    }

    match choice {
        BilliardsBreakChoice::RerackSelf => rerack_chinese_eight_ball(state, actor_seat_id),
        BilliardsBreakChoice::RerackOpponent => rerack_chinese_eight_ball(state, breaker_seat_id),
        BilliardsBreakChoice::AcceptTable => {
            let mut next = state.clone();
            next.active_seat_id = Some(actor_seat_id.to_owned());
            next.ball_in_hand_zone = None;
            next.pending_decision = None;
            next.phase = BilliardsPhase::Aiming;
            Ok(next)
        }
        BilliardsBreakChoice::TakeLineInHand => {
            let mut next = state.clone();
            next.active_seat_id = Some(actor_seat_id.to_owned());
            next.ball_in_hand_zone = Some(BallInHandZone::BehindLine);
            next.balls = mark_cue_ball_in_hand(&state.balls);
            next.pending_decision = None;
            next.phase = BilliardsPhase::BallInHand;
            Ok(next)
        }
        BilliardsBreakChoice::SpotEight => {
            let foul_eight = *reason == BreakDecisionReason::EightOnBreakFoul;
            let spotted = spot_eight_ball(&state.balls)?;
            let mut next = state.clone();
            next.active_seat_id = Some(actor_seat_id.to_owned());
            next.ball_in_hand_zone = foul_eight.then_some(BallInHandZone::BehindLine);
            next.balls = if foul_eight {
                mark_cue_ball_in_hand(&spotted)
            } else {
                spotted
            };
            next.pending_decision = None;
            next.phase = if foul_eight {
                BilliardsPhase::BallInHand
            } else {
                BilliardsPhase::Aiming
            };
            Ok(next)
        }
    }
}

pub fn resolve_eight_ball_group_choice(
    state: &BilliardsMatchState,
    actor_seat_id: &str,
    group: BilliardsSelectableGroup,
) -> RuleResult<BilliardsMatchState> {
    let Some(BilliardsPendingDecision::ChooseGroup {
        chooser_seat_id,
        groups,
    }) = state.pending_decision.as_ref()
    else {
        return Err(RuleError::rule(
            "NO_GROUP_DECISION_PENDING",
            "There is no group decision to resolve",
        ));
    };
    if state.phase != BilliardsPhase::Decision {
        return Err(RuleError::rule(
            "NO_GROUP_DECISION_PENDING",
            "There is no group decision to resolve",
        ));
    }
    if chooser_seat_id != actor_seat_id {
        return Err(RuleError::rule(
            "NOT_YOUR_TURN",
            "Only the group-decision chooser may act",
        ));
    }
    if !groups.contains(&group) {
        return Err(RuleError::rule(
            "GROUP_CHOICE_NOT_AVAILABLE",
            "The selected group is not available",
        ));
    }

    let players = recompute_scores(
        &assign_groups(&state.players, actor_seat_id, group)?,
        &state.balls,
    );
    let mut next = state.clone();
    next.active_seat_id = Some(actor_seat_id.to_owned());
    next.ball_in_hand_zone = None;
    next.pending_decision = None;
    next.phase = BilliardsPhase::Aiming;
    next.players = players;
    Ok(next)
}
