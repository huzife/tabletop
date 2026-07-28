use super::*;
use crate::geometry::table_spec;
use std::collections::HashSet;

const SEAT_ONE: &str = "seat-1";
const SEAT_TWO: &str = "seat-2";

fn settings(mode: BilliardsMode) -> BilliardsSettings {
    BilliardsSettings {
        cloth_rolling_friction: crate::model::DEFAULT_CLOTH_ROLLING_FRICTION,
        cloth_sliding_friction: crate::model::DEFAULT_CLOTH_SLIDING_FRICTION,
        cushion_friction: crate::model::DEFAULT_CUSHION_FRICTION,
        mode,
    }
}

fn state(mode: BilliardsMode) -> BilliardsMatchState {
    create_initial_billiards_state(
        settings(mode),
        vec![SEAT_ONE.to_owned(), SEAT_TWO.to_owned()],
    )
    .expect("valid competitive state")
}

fn practice_state(mode: BilliardsMode) -> BilliardsMatchState {
    create_initial_billiards_state(settings(mode), vec![SEAT_ONE.to_owned()])
        .expect("valid practice state")
}

fn ready_to_shoot(mut state: BilliardsMatchState) -> BilliardsMatchState {
    state.ball_in_hand_zone = None;
    state.phase = BilliardsPhase::Aiming;
    for ball in &mut state.balls {
        if ball.kind == BilliardsBallKind::Cue {
            ball.pocketed = false;
        }
    }
    state
}

fn shot(nominated_color: Option<SnookerColor>) -> BilliardsShot {
    BilliardsShot {
        angle: 0.0,
        elevation: 0.0,
        nominated_color,
        power: 50.0,
        tip: CueTip { x: 0.0, y: 0.0 },
    }
}

fn simulation(
    state: &BilliardsMatchState,
    firsts: &[&str],
    potted: &[&str],
    post_contact_rails: &[&str],
    jumped: &[&str],
) -> BilliardsSimulationResult {
    let potted_set: HashSet<_> = potted.iter().copied().collect();
    BilliardsSimulationResult {
        balls: state
            .balls
            .iter()
            .cloned()
            .map(|mut ball| {
                if potted_set.contains(ball.id.as_str()) {
                    ball.pocketed = true;
                }
                ball
            })
            .collect(),
        checksum: "1234abcd".to_owned(),
        cue_ball_potted: potted_set.contains("cue"),
        duration_ms: 1_000,
        first_contact_ball_id: firsts.first().map(|id| (*id).to_owned()),
        first_contact_ball_ids: firsts.iter().map(|id| (*id).to_owned()).collect(),
        jumped_ball_ids: jumped.iter().map(|id| (*id).to_owned()).collect(),
        pocketed_ball_ids: potted.iter().map(|id| (*id).to_owned()).collect(),
        post_contact_rail_ball_ids: post_contact_rails
            .iter()
            .map(|id| (*id).to_owned())
            .collect(),
        rail_contact_ball_ids: post_contact_rails
            .iter()
            .map(|id| (*id).to_owned())
            .collect(),
    }
}

fn input(
    state: BilliardsMatchState,
    shot: BilliardsShot,
    firsts: &[&str],
    potted: &[&str],
    rails: &[&str],
    jumped: &[&str],
) -> ShotAdjudicationInput {
    ShotAdjudicationInput {
        actor_seat_id: SEAT_ONE.to_owned(),
        simulation: simulation(&state, firsts, potted, rails, jumped),
        shot,
        state,
    }
}

fn grouped_eight_ball_state(clear_solids: bool) -> BilliardsMatchState {
    let mut state = ready_to_shoot(state(BilliardsMode::ChineseEightBall));
    state.break_shot = false;
    state.players[0].group = Some(EightBallGroup::Solids);
    state.players[1].group = Some(EightBallGroup::Stripes);
    if clear_solids {
        for ball in &mut state.balls {
            if ball.kind == BilliardsBallKind::Solid {
                ball.pocketed = true;
            }
        }
        state.players[0].score = 7;
    }
    state
}

#[test]
fn serde_models_match_the_existing_wire_contract() {
    let action = BilliardsAction::Shoot {
        shot: shot(Some(SnookerColor::Black)),
    };
    let value = serde_json::to_value(&action).expect("serialize action");
    assert_eq!(value["type"], "billiards.shoot");
    assert_eq!(value["shot"]["nominatedColor"], "black");
    let decoded: BilliardsAction = serde_json::from_value(value).expect("deserialize action");
    assert_eq!(decoded, action);

    let match_state = state(BilliardsMode::ChineseEightBall);
    let value = serde_json::to_value(&match_state).expect("serialize state");
    assert_eq!(value["ballInHandZone"], "behind-line");
    assert_eq!(value["phase"], "ball_in_hand");
    assert_eq!(value["settings"]["mode"], "chinese-eight-ball");
    let decoded: BilliardsMatchState = serde_json::from_value(value).expect("deserialize state");
    assert_eq!(decoded, match_state);
}

#[test]
fn initial_racks_and_match_states_follow_the_native_table_profile() {
    let chinese = create_chinese_eight_ball_rack().expect("Chinese rack");
    assert_eq!(chinese.len(), 16);
    assert_eq!(
        chinese
            .iter()
            .filter(|ball| ball.kind == BilliardsBallKind::Solid)
            .count(),
        7
    );
    assert_eq!(
        chinese
            .iter()
            .filter(|ball| ball.kind == BilliardsBallKind::Stripe)
            .count(),
        7
    );
    let table = table_spec(BilliardsMode::ChineseEightBall);
    let foot = table
        .spots
        .iter()
        .find(|spot| spot.id == "foot")
        .expect("foot spot");
    let eight = chinese
        .iter()
        .find(|ball| ball.kind == BilliardsBallKind::Eight)
        .expect("eight");
    assert!((eight.x - (foot.x + 3.0_f64.sqrt() * table.ball_diameter)).abs() < 1e-12);

    let snooker = create_snooker_rack().expect("snooker rack");
    assert_eq!(snooker.len(), 22);
    assert_eq!(
        snooker
            .iter()
            .filter(|ball| ball.kind == BilliardsBallKind::Red)
            .count(),
        15
    );
    assert_eq!(
        state(BilliardsMode::ChineseEightBall).ball_in_hand_zone,
        Some(BallInHandZone::BehindLine)
    );
    assert_eq!(
        state(BilliardsMode::Snooker).ball_in_hand_zone,
        Some(BallInHandZone::D)
    );
    assert_eq!(
        practice_state(BilliardsMode::ChineseEightBall).players,
        vec![
            BilliardsPlayerState {
                seat_id: SEAT_ONE.to_owned(),
                group: Some(EightBallGroup::Open),
                score: 0,
            },
            BilliardsPlayerState {
                seat_id: SEAT_TWO.to_owned(),
                group: Some(EightBallGroup::Open),
                score: 0,
            },
        ]
    );
    assert_eq!(
        practice_state(BilliardsMode::Snooker).snooker_on,
        Some(SnookerOn::Red)
    );
}

#[test]
fn initial_state_rejects_invalid_seats_with_a_stable_error() {
    let error = create_initial_billiards_state(settings(BilliardsMode::Snooker), vec![])
        .expect_err("empty seats must fail");
    assert_eq!(error.kind, RuleErrorKind::InvalidInput);
    assert_eq!(error.code, "INVALID_SEAT_CONFIGURATION");
}

#[test]
fn cue_placement_checks_bounds_zones_pockets_and_overlap() {
    let mut anywhere = state(BilliardsMode::ChineseEightBall);
    anywhere.ball_in_hand_zone = Some(BallInHandZone::Anywhere);
    let table = table_spec(BilliardsMode::ChineseEightBall);
    assert_eq!(
        check_cue_placement(&anywhere, 0.0, table.height / 2.0, None)
            .expect_err("cushion")
            .code,
        "CUE_OUT_OF_BOUNDS"
    );
    check_cue_placement(
        &anywhere,
        table.ball_diameter / 2.0,
        table.ball_diameter / 2.0,
        None,
    )
    .expect("the pocket point-of-no-return lies beyond the corner shelf");
    let object = anywhere
        .balls
        .iter()
        .find(|ball| ball.kind == BilliardsBallKind::Solid)
        .expect("solid");
    assert_eq!(
        check_cue_placement(&anywhere, object.x, object.y, None)
            .expect_err("overlap")
            .code,
        "CUE_OVERLAPS_BALL"
    );
    check_cue_placement(&anywhere, table.width / 2.0, table.height / 4.0, None)
        .expect("valid anywhere placement");

    let snooker = state(BilliardsMode::Snooker);
    let snooker_table = table_spec(BilliardsMode::Snooker);
    let line = snooker_table.baulk_line_x.expect("baulk line");
    assert_eq!(
        check_cue_placement(
            &snooker,
            line + 0.01,
            snooker_table.height / 2.0,
            Some(BallInHandZone::D),
        )
        .expect_err("outside D")
        .code,
        "CUE_OUTSIDE_D"
    );
}

#[test]
fn practice_uses_competitive_fouls_and_turn_rotation() {
    let mut state = ready_to_shoot(practice_state(BilliardsMode::ChineseEightBall));
    state.break_shot = false;
    state.players[0].group = Some(EightBallGroup::Solids);
    state.players[1].group = Some(EightBallGroup::Stripes);
    let input = input(state, shot(None), &["9"], &[], &["9"], &[]);
    let result = adjudicate_chinese_eight_ball_shot(&input).expect("practice shot");
    assert_eq!(result.foul_code.as_deref(), Some("WRONG_FIRST_CONTACT"));
    assert_eq!(result.state.active_seat_id.as_deref(), Some(SEAT_TWO));
    assert_eq!(
        result.state.ball_in_hand_zone,
        Some(BallInHandZone::Anywhere)
    );
    assert_eq!(result.state.phase, BilliardsPhase::BallInHand);
}

#[test]
fn chinese_illegal_break_and_break_choices_are_preserved() {
    let state = ready_to_shoot(state(BilliardsMode::ChineseEightBall));
    let input = input(state, shot(None), &["1"], &[], &["1", "2", "3"], &[]);
    let result = adjudicate_chinese_eight_ball_shot(&input).expect("illegal break");
    assert_eq!(result.foul_code.as_deref(), Some("ILLEGAL_BREAK"));
    assert_eq!(result.state.phase, BilliardsPhase::Decision);
    assert_eq!(result.state.active_seat_id.as_deref(), Some(SEAT_TWO));
    let Some(BilliardsPendingDecision::BreakChoice {
        reason, choices, ..
    }) = result.state.pending_decision.as_ref()
    else {
        panic!("missing break decision");
    };
    assert_eq!(*reason, BreakDecisionReason::IllegalBreak);
    assert_eq!(
        choices,
        &[
            BilliardsBreakChoice::AcceptTable,
            BilliardsBreakChoice::RerackSelf,
            BilliardsBreakChoice::RerackOpponent,
        ]
    );

    let accepted =
        resolve_eight_ball_break_choice(&result.state, SEAT_TWO, BilliardsBreakChoice::AcceptTable)
            .expect("accept table");
    assert_eq!(accepted.phase, BilliardsPhase::Aiming);
    assert_eq!(accepted.active_seat_id.as_deref(), Some(SEAT_TWO));

    let reracked =
        resolve_eight_ball_break_choice(&result.state, SEAT_TWO, BilliardsBreakChoice::RerackSelf)
            .expect("rerack");
    assert_eq!(reracked.phase, BilliardsPhase::BallInHand);
    assert_eq!(reracked.ball_in_hand_zone, Some(BallInHandZone::BehindLine));
    assert_eq!(reracked.shot_number, 1);
}

#[test]
fn chinese_break_eight_and_group_decisions_are_preserved() {
    let break_state = ready_to_shoot(state(BilliardsMode::ChineseEightBall));
    let break_input = input(break_state, shot(None), &["8"], &["8"], &[], &[]);
    let eight = adjudicate_chinese_eight_ball_shot(&break_input).expect("eight on break");
    let spotted =
        resolve_eight_ball_break_choice(&eight.state, SEAT_ONE, BilliardsBreakChoice::SpotEight)
            .expect("spot eight");
    assert!(
        spotted
            .balls
            .iter()
            .find(|ball| ball.kind == BilliardsBallKind::Eight)
            .is_some_and(|ball| !ball.pocketed)
    );

    let mut open = ready_to_shoot(state(BilliardsMode::ChineseEightBall));
    open.break_shot = false;
    let group_input = input(open, shot(None), &["1", "9"], &["1", "9"], &[], &[]);
    let choice = adjudicate_chinese_eight_ball_shot(&group_input).expect("group choice");
    assert_eq!(choice.state.phase, BilliardsPhase::Decision);
    let chosen =
        resolve_eight_ball_group_choice(&choice.state, SEAT_ONE, BilliardsSelectableGroup::Stripes)
            .expect("choose stripes");
    assert_eq!(chosen.players[0].group, Some(EightBallGroup::Stripes));
    assert_eq!(chosen.players[0].score, 1);
    assert_eq!(chosen.players[1].group, Some(EightBallGroup::Solids));
}

#[test]
fn open_table_opposite_group_only_pot_ends_the_visit() {
    let mut open = ready_to_shoot(state(BilliardsMode::ChineseEightBall));
    open.break_shot = false;
    let input = input(open, shot(None), &["1"], &["9"], &[], &[]);
    let result = adjudicate_chinese_eight_ball_shot(&input).expect("legal open-table shot");
    assert!(
        result
            .state
            .players
            .iter()
            .all(|player| { player.group == Some(EightBallGroup::Open) })
    );
    assert_eq!(result.state.active_seat_id.as_deref(), Some(SEAT_TWO));
}

#[test]
fn chinese_fouls_and_eight_ball_outcomes_are_preserved() {
    let assigned = grouped_eight_ball_state(false);
    let foul_input = input(assigned, shot(None), &["9"], &[], &["9"], &[]);
    let foul = adjudicate_chinese_eight_ball_shot(&foul_input).expect("wrong first");
    assert_eq!(foul.foul_code.as_deref(), Some("WRONG_FIRST_CONTACT"));
    assert_eq!(foul.state.ball_in_hand_zone, Some(BallInHandZone::Anywhere));

    let cleared = grouped_eight_ball_state(true);
    let win_input = input(cleared, shot(None), &["8"], &["8"], &[], &[]);
    let won = adjudicate_chinese_eight_ball_shot(&win_input).expect("legal eight");
    assert_eq!(
        won.state.outcome,
        Some(BilliardsOutcome {
            reason: BilliardsEndReason::EightBall,
            winner_seat_id: SEAT_ONE.to_owned(),
        })
    );
}

#[test]
fn snooker_scores_red_then_nominated_color_and_respots_it() {
    let state = ready_to_shoot(state(BilliardsMode::Snooker));
    let red_input = input(state, shot(None), &["red-1"], &["red-1"], &[], &[]);
    let red = adjudicate_snooker_shot(&red_input, 0).expect("red");
    assert_eq!(red.points, 1);
    assert_eq!(red.state.snooker_on, Some(SnookerOn::Color));
    assert_eq!(red.state.active_seat_id.as_deref(), Some(SEAT_ONE));

    let black_input = input(
        red.state,
        shot(Some(SnookerColor::Black)),
        &["black"],
        &["black"],
        &[],
        &[],
    );
    let black = adjudicate_snooker_shot(&black_input, 0).expect("black");
    assert_eq!(black.points, 7);
    assert_eq!(black.state.players[0].score, 8);
    assert_eq!(black.state.snooker_on, Some(SnookerOn::Red));
    let black_ball = black
        .state
        .balls
        .iter()
        .find(|ball| ball.kind == BilliardsBallKind::Black)
        .expect("black");
    assert!(!black_ball.pocketed);
    let black_spot = table_spec(BilliardsMode::Snooker)
        .spots
        .into_iter()
        .find(|spot| spot.id == "black")
        .expect("black spot");
    assert!((black_ball.x - black_spot.x).abs() < 1e-12);
}

#[test]
fn snooker_fouls_use_the_highest_involved_value() {
    let state = ready_to_shoot(state(BilliardsMode::Snooker));
    let input = input(state, shot(None), &["black"], &["black"], &[], &[]);
    let foul = adjudicate_snooker_shot(&input, 0).expect("snooker foul");
    assert_eq!(foul.foul_code.as_deref(), Some("WRONG_FIRST_CONTACT"));
    assert_eq!(foul.points, 7);
    assert_eq!(foul.state.players[1].score, 7);
    assert!(
        foul.state
            .balls
            .iter()
            .find(|ball| ball.kind == BilliardsBallKind::Black)
            .is_some_and(|ball| !ball.pocketed)
    );
}

#[test]
fn final_red_potted_on_a_foul_starts_clearance_at_yellow() {
    let mut last_red = ready_to_shoot(state(BilliardsMode::Snooker));
    last_red.break_shot = false;
    for ball in &mut last_red.balls {
        if ball.kind == BilliardsBallKind::Red && ball.id != "red-1" {
            ball.pocketed = true;
        }
    }
    let input = input(last_red, shot(None), &["black"], &["red-1"], &[], &[]);
    let result = adjudicate_snooker_shot(&input, 0).expect("final-red foul");
    assert_eq!(result.foul_code.as_deref(), Some("WRONG_FIRST_CONTACT"));
    assert_eq!(result.state.snooker_on, Some(SnookerOn::Yellow));
    assert_eq!(result.state.active_seat_id.as_deref(), Some(SEAT_TWO));
}

#[test]
fn snooker_clearance_keeps_legal_colors_down_and_advances() {
    let mut clearance = ready_to_shoot(state(BilliardsMode::Snooker));
    clearance.break_shot = false;
    clearance.snooker_on = Some(SnookerOn::Yellow);
    for ball in &mut clearance.balls {
        if ball.kind == BilliardsBallKind::Red {
            ball.pocketed = true;
        }
    }
    let input = input(clearance, shot(None), &["yellow"], &["yellow"], &[], &[]);
    let yellow = adjudicate_snooker_shot(&input, 0).expect("yellow");
    assert_eq!(yellow.points, 2);
    assert_eq!(yellow.state.snooker_on, Some(SnookerOn::Green));
    assert!(
        yellow
            .state
            .balls
            .iter()
            .find(|ball| ball.kind == BilliardsBallKind::Yellow)
            .is_some_and(|ball| ball.pocketed)
    );
}

#[test]
fn tied_final_black_is_respotted_and_the_injected_chooser_can_defer() {
    let mut final_black = ready_to_shoot(state(BilliardsMode::Snooker));
    final_black.break_shot = false;
    final_black.snooker_on = Some(SnookerOn::Black);
    final_black.players[0].score = 43;
    final_black.players[1].score = 50;
    for ball in &mut final_black.balls {
        if matches!(
            ball.kind,
            BilliardsBallKind::Red
                | BilliardsBallKind::Yellow
                | BilliardsBallKind::Green
                | BilliardsBallKind::Brown
                | BilliardsBallKind::Blue
                | BilliardsBallKind::Pink
        ) {
            ball.pocketed = true;
        }
    }
    let input = input(final_black, shot(None), &["black"], &["black"], &[], &[]);
    let tied = adjudicate_snooker_shot(&input, 1).expect("tied black");
    assert_eq!(tied.state.phase, BilliardsPhase::Decision);
    assert!(tied.state.deciding_black);
    assert_eq!(tied.state.active_seat_id.as_deref(), Some(SEAT_TWO));
    assert!(
        tied.state
            .balls
            .iter()
            .find(|ball| ball.kind == BilliardsBallKind::Black)
            .is_some_and(|ball| !ball.pocketed)
    );
    let deferred = resolve_snooker_deciding_black_choice(
        &tied.state,
        SEAT_TWO,
        BilliardsDecidingBlackChoice::Defer,
    )
    .expect("defer");
    assert_eq!(deferred.active_seat_id.as_deref(), Some(SEAT_ONE));
    assert_eq!(deferred.ball_in_hand_zone, Some(BallInHandZone::D));
    assert_eq!(deferred.phase, BilliardsPhase::BallInHand);
}

#[test]
fn reducer_requires_simulation_and_applies_place_and_shoot() {
    let initial = state(BilliardsMode::ChineseEightBall);
    let place = BilliardsAction::PlaceCue { x: 0.4, y: 0.63 };
    let placed = reduce_billiards_action(&initial, SEAT_ONE, &place, ReducerContext::default())
        .expect("place cue");
    assert_eq!(placed.state.phase, BilliardsPhase::Aiming);

    let shoot = BilliardsAction::Shoot { shot: shot(None) };
    let error = reduce_billiards_action(&placed.state, SEAT_ONE, &shoot, ReducerContext::default())
        .expect_err("simulation required");
    assert_eq!(error.kind, RuleErrorKind::InvalidInput);
    assert_eq!(error.code, "SIMULATION_RESULT_REQUIRED");

    let simulation = simulation(&placed.state, &["1"], &["1"], &[], &[]);
    let shot_result = reduce_billiards_action(
        &placed.state,
        SEAT_ONE,
        &shoot,
        ReducerContext {
            simulation: Some(&simulation),
            deciding_black_chooser_index: 0,
        },
    )
    .expect("reduce shot");
    assert_eq!(shot_result.state.shot_number, 1);
}
