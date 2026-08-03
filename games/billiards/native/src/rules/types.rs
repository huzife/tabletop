use crate::model::{
    default_cloth_rolling_friction, default_cloth_sliding_friction, default_cushion_friction,
    default_fixed_shot_power,
};
use serde::{Deserialize, Serialize};

pub use crate::model::{Ball as BilliardsBall, BallKind as BilliardsBallKind, BilliardsMode};

pub type SeatId = String;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BilliardsPhase {
    Aiming,
    BallInHand,
    Decision,
    Ended,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BallInHandZone {
    Anywhere,
    BehindLine,
    D,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BilliardsEndReason {
    EightBall,
    FinalBlack,
    Resigned,
    Disconnected,
    Left,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EightBallGroup {
    Open,
    Solids,
    Stripes,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BilliardsSelectableGroup {
    Solids,
    Stripes,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnookerColor {
    Yellow,
    Green,
    Brown,
    Blue,
    Pink,
    Black,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnookerOn {
    Red,
    Color,
    Yellow,
    Green,
    Brown,
    Blue,
    Pink,
    Black,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BilliardsBreakChoice {
    AcceptTable,
    TakeLineInHand,
    SpotEight,
    RerackSelf,
    RerackOpponent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BilliardsDecidingBlackChoice {
    PlaySelf,
    Defer,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BreakDecisionReason {
    IllegalBreak,
    BreakFoul,
    EightOnBreak,
    EightOnBreakFoul,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueTip {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilliardsShot {
    pub angle: f64,
    pub elevation: f64,
    pub nominated_color: Option<SnookerColor>,
    pub power: f64,
    pub tip: CueTip,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilliardsSettings {
    #[serde(default = "default_cloth_rolling_friction")]
    pub cloth_rolling_friction: f64,
    #[serde(default = "default_cloth_sliding_friction")]
    pub cloth_sliding_friction: f64,
    #[serde(default = "default_cushion_friction")]
    pub cushion_friction: f64,
    #[serde(default = "default_fixed_shot_power")]
    pub fixed_shot_power: f64,
    #[serde(default)]
    pub fixed_shot_power_enabled: bool,
    pub mode: BilliardsMode,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilliardsPlayerState {
    pub seat_id: SeatId,
    pub group: Option<EightBallGroup>,
    pub score: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilliardsLastShot {
    pub foul_code: Option<String>,
    pub points: u32,
    pub potted_ball_ids: Vec<String>,
    pub seat_id: SeatId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilliardsOutcome {
    pub reason: BilliardsEndReason,
    pub winner_seat_id: SeatId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum BilliardsPendingDecision {
    BreakChoice {
        reason: BreakDecisionReason,
        breaker_seat_id: SeatId,
        chooser_seat_id: SeatId,
        choices: Vec<BilliardsBreakChoice>,
    },
    ChooseGroup {
        chooser_seat_id: SeatId,
        groups: Vec<BilliardsSelectableGroup>,
    },
    DecidingBlackChoice {
        chooser_seat_id: SeatId,
        choices: Vec<BilliardsDecidingBlackChoice>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilliardsMatchState {
    pub settings: BilliardsSettings,
    pub seat_ids: Vec<SeatId>,
    pub active_seat_id: Option<SeatId>,
    pub ball_in_hand_zone: Option<BallInHandZone>,
    pub balls: Vec<BilliardsBall>,
    pub break_shot: bool,
    pub deciding_black: bool,
    pub last_shot: Option<BilliardsLastShot>,
    pub outcome: Option<BilliardsOutcome>,
    pub pending_decision: Option<BilliardsPendingDecision>,
    pub phase: BilliardsPhase,
    pub players: Vec<BilliardsPlayerState>,
    pub practice: bool,
    pub shot_number: u32,
    pub snooker_on: Option<SnookerOn>,
}

/// Serde-compatible form of the current TypeScript physics summary.
///
/// Unknown fields from the richer Rust physics result are intentionally
/// ignored during deserialization, so this can also consume the native
/// engine's JSON response.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilliardsSimulationResult {
    pub balls: Vec<BilliardsBall>,
    pub checksum: String,
    pub cue_ball_potted: bool,
    pub duration_ms: u32,
    pub first_contact_ball_id: Option<String>,
    pub first_contact_ball_ids: Vec<String>,
    pub jumped_ball_ids: Vec<String>,
    pub pocketed_ball_ids: Vec<String>,
    pub post_contact_rail_ball_ids: Vec<String>,
    pub rail_contact_ball_ids: Vec<String>,
}

impl From<crate::model::ShotSimulationResult> for BilliardsSimulationResult {
    fn from(value: crate::model::ShotSimulationResult) -> Self {
        Self {
            balls: value.balls,
            checksum: value.checksum,
            cue_ball_potted: value.cue_ball_potted,
            duration_ms: value.duration_ms,
            first_contact_ball_id: value.first_contact_ball_id,
            first_contact_ball_ids: value.first_contact_ball_ids,
            jumped_ball_ids: value.jumped_ball_ids,
            pocketed_ball_ids: value.pocketed_ball_ids,
            post_contact_rail_ball_ids: value.post_contact_rail_ball_ids,
            rail_contact_ball_ids: value.rail_contact_ball_ids,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum BilliardsAction {
    #[serde(rename = "billiards.shoot")]
    Shoot { shot: BilliardsShot },
    #[serde(rename = "billiards.place-cue")]
    PlaceCue { x: f64, y: f64 },
    #[serde(rename = "billiards.break-choice")]
    BreakChoice { choice: BilliardsBreakChoice },
    #[serde(rename = "billiards.choose-group")]
    ChooseGroup { group: BilliardsSelectableGroup },
    #[serde(rename = "billiards.deciding-black-choice")]
    DecidingBlackChoice {
        choice: BilliardsDecidingBlackChoice,
    },
    #[serde(rename = "billiards.resign")]
    Resign,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotAdjudicationInput {
    pub actor_seat_id: SeatId,
    pub shot: BilliardsShot,
    pub simulation: BilliardsSimulationResult,
    pub state: BilliardsMatchState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjudicatedBilliardsShot {
    pub foul_code: Option<String>,
    pub points: u32,
    pub state: BilliardsMatchState,
}
