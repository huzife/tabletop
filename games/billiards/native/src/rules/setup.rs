use super::error::{RuleError, RuleResult};
use super::types::{
    BallInHandZone, BilliardsBall, BilliardsBallKind, BilliardsMatchState, BilliardsMode,
    BilliardsPhase, BilliardsPlayerState, BilliardsSettings, EightBallGroup, SeatId, SnookerOn,
};
use crate::geometry::table_spec;
use crate::model::{MAX_SHOT_POWER, MIN_SHOT_POWER};

const SQRT_THREE_OVER_TWO: f64 = 0.866_025_403_784_438_6;
const SNOOKER_PINK_RED_GAP: f64 = 0.0005;

fn numbered_ball(number: u8, x: f64, y: f64) -> BilliardsBall {
    let kind = if number == 8 {
        BilliardsBallKind::Eight
    } else if number < 8 {
        BilliardsBallKind::Solid
    } else {
        BilliardsBallKind::Stripe
    };
    BilliardsBall {
        id: number.to_string(),
        kind,
        number: Some(number),
        pocketed: false,
        rotation: 0.0,
        value: if number == 8 { 8 } else { 1 },
        x,
        y,
    }
}

fn snooker_ball(
    id: impl Into<String>,
    kind: BilliardsBallKind,
    value: u8,
    x: f64,
    y: f64,
) -> BilliardsBall {
    BilliardsBall {
        id: id.into(),
        kind,
        number: None,
        pocketed: false,
        rotation: 0.0,
        value,
        x,
        y,
    }
}

pub fn create_chinese_eight_ball_rack() -> RuleResult<Vec<BilliardsBall>> {
    let table = table_spec(BilliardsMode::ChineseEightBall);
    let foot = table
        .spots
        .iter()
        .find(|spot| spot.id == "foot")
        .copied()
        .ok_or_else(|| {
            RuleError::internal(
                "CHINESE_TABLE_MISSING_FOOT_SPOT",
                "Chinese eight-ball table is missing its foot spot",
            )
        })?;

    let rows: [&[u8]; 5] = [
        &[1],
        &[9, 2],
        &[3, 8, 10],
        &[11, 4, 12, 5],
        &[6, 13, 7, 14, 15],
    ];
    let mut balls = Vec::with_capacity(16);
    balls.push(BilliardsBall {
        id: "cue".to_owned(),
        kind: BilliardsBallKind::Cue,
        number: None,
        pocketed: false,
        rotation: 0.0,
        value: 0,
        x: table.baulk_line_x.unwrap_or(table.width / 4.0),
        y: table.height / 2.0,
    });

    for (row_index, row) in rows.iter().enumerate() {
        let x = foot.x + row_index as f64 * table.ball_diameter * SQRT_THREE_OVER_TWO;
        for (index, number) in row.iter().copied().enumerate() {
            let y = foot.y + (index as f64 - (row.len() as f64 - 1.0) / 2.0) * table.ball_diameter;
            balls.push(numbered_ball(number, x, y));
        }
    }
    Ok(balls)
}

pub fn create_snooker_rack() -> RuleResult<Vec<BilliardsBall>> {
    let table = table_spec(BilliardsMode::Snooker);
    let spot = |id: &str| {
        table
            .spots
            .iter()
            .find(|candidate| candidate.id == id)
            .copied()
    };
    let brown = spot("brown").ok_or_else(|| {
        RuleError::internal(
            "SNOOKER_TABLE_MISSING_BROWN_SPOT",
            "Snooker table is missing its brown spot",
        )
    })?;
    let pink = spot("pink").ok_or_else(|| {
        RuleError::internal(
            "SNOOKER_TABLE_MISSING_PINK_SPOT",
            "Snooker table is missing its pink spot",
        )
    })?;
    let d_radius = table.d_radius.ok_or_else(|| {
        RuleError::internal(
            "SNOOKER_TABLE_MISSING_D",
            "Snooker table is missing its D dimensions",
        )
    })?;

    let mut balls = Vec::with_capacity(22);
    balls.push(snooker_ball(
        "cue",
        BilliardsBallKind::Cue,
        0,
        brown.x - d_radius / 2.0,
        brown.y,
    ));

    let colors = [
        (BilliardsBallKind::Yellow, "yellow", 2),
        (BilliardsBallKind::Green, "green", 3),
        (BilliardsBallKind::Brown, "brown", 4),
        (BilliardsBallKind::Blue, "blue", 5),
        (BilliardsBallKind::Pink, "pink", 6),
        (BilliardsBallKind::Black, "black", 7),
    ];
    for (kind, id, value) in colors {
        let color_spot = spot(id).ok_or_else(|| {
            RuleError::internal(
                "SNOOKER_TABLE_MISSING_COLOR_SPOT",
                format!("Snooker table is missing the {id} spot"),
            )
        })?;
        balls.push(snooker_ball(id, kind, value, color_spot.x, color_spot.y));
    }

    let mut red_number = 1_u8;
    for row in 0..5 {
        let x = pink.x
            + table.ball_diameter
            + SNOOKER_PINK_RED_GAP
            + row as f64 * table.ball_diameter * SQRT_THREE_OVER_TWO;
        for index in 0..=row {
            let y = pink.y + (index as f64 - row as f64 / 2.0) * table.ball_diameter;
            balls.push(snooker_ball(
                format!("red-{red_number}"),
                BilliardsBallKind::Red,
                1,
                x,
                y,
            ));
            red_number += 1;
        }
    }
    Ok(balls)
}

pub fn create_initial_balls(mode: BilliardsMode) -> RuleResult<Vec<BilliardsBall>> {
    match mode {
        BilliardsMode::ChineseEightBall => create_chinese_eight_ball_rack(),
        BilliardsMode::Snooker => create_snooker_rack(),
    }
}

pub fn create_initial_billiards_state(
    settings: BilliardsSettings,
    mut seat_ids: Vec<SeatId>,
) -> RuleResult<BilliardsMatchState> {
    if !settings.fixed_shot_power.is_finite()
        || settings.fixed_shot_power.fract() != 0.0
        || !(MIN_SHOT_POWER..=MAX_SHOT_POWER).contains(&settings.fixed_shot_power)
    {
        return Err(RuleError::invalid(
            "INVALID_FIXED_SHOT_POWER",
            "Fixed shot power is outside the supported input range",
        ));
    }
    if seat_ids.is_empty()
        || seat_ids.len() > 2
        || seat_ids.iter().any(String::is_empty)
        || seat_ids.len() == 2 && seat_ids[0] == seat_ids[1]
    {
        return Err(RuleError::invalid(
            "INVALID_SEAT_CONFIGURATION",
            "Billiards requires one or two distinct, non-empty seats",
        ));
    }

    let practice = seat_ids.len() == 1;
    if practice {
        let second_seat_id = if seat_ids[0] == "seat-2" {
            "seat-1"
        } else {
            "seat-2"
        };
        seat_ids.push(second_seat_id.to_owned());
    }
    let initial_group = if settings.mode == BilliardsMode::ChineseEightBall {
        Some(EightBallGroup::Open)
    } else {
        None
    };
    let players = seat_ids
        .iter()
        .map(|seat_id| BilliardsPlayerState {
            seat_id: seat_id.clone(),
            group: initial_group,
            score: 0,
        })
        .collect();
    let mut balls = create_initial_balls(settings.mode)?;
    for ball in &mut balls {
        if ball.kind == BilliardsBallKind::Cue {
            ball.pocketed = true;
        }
    }

    Ok(BilliardsMatchState {
        active_seat_id: seat_ids.first().cloned(),
        ball_in_hand_zone: Some(match settings.mode {
            BilliardsMode::ChineseEightBall => BallInHandZone::BehindLine,
            BilliardsMode::Snooker => BallInHandZone::D,
        }),
        balls,
        break_shot: true,
        deciding_black: false,
        last_shot: None,
        outcome: None,
        pending_decision: None,
        phase: BilliardsPhase::BallInHand,
        players,
        practice,
        seat_ids,
        settings: settings.clone(),
        shot_number: 0,
        snooker_on: if settings.mode == BilliardsMode::Snooker {
            Some(SnookerOn::Red)
        } else {
            None
        },
    })
}

pub fn rerack_chinese_eight_ball(
    state: &BilliardsMatchState,
    breaker_seat_id: &str,
) -> RuleResult<BilliardsMatchState> {
    if state.settings.mode != BilliardsMode::ChineseEightBall
        || !state.seat_ids.iter().any(|seat| seat == breaker_seat_id)
    {
        return Err(RuleError::rule(
            "CANNOT_RERACK_MATCH",
            "Cannot rerack a non-Heyball match or assign an unknown breaker",
        ));
    }

    let mut balls = create_chinese_eight_ball_rack()?;
    for ball in &mut balls {
        if ball.kind == BilliardsBallKind::Cue {
            ball.pocketed = true;
        }
    }
    let mut next = state.clone();
    next.active_seat_id = Some(breaker_seat_id.to_owned());
    next.ball_in_hand_zone = Some(BallInHandZone::BehindLine);
    next.balls = balls;
    next.break_shot = true;
    next.deciding_black = false;
    next.outcome = None;
    next.pending_decision = None;
    next.phase = BilliardsPhase::BallInHand;
    next.players = state
        .seat_ids
        .iter()
        .map(|seat_id| BilliardsPlayerState {
            seat_id: seat_id.clone(),
            group: Some(EightBallGroup::Open),
            score: 0,
        })
        .collect();
    next.snooker_on = None;
    Ok(next)
}
