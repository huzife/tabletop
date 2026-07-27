use crate::math::Vec3;
use serde::{Deserialize, Serialize};

pub const PHYSICS_VERSION: &str = "tabletop-billiards-scene-v4";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum BilliardsMode {
    #[serde(rename = "chinese-eight-ball")]
    ChineseEightBall,
    #[serde(rename = "snooker")]
    Snooker,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BallKind {
    Cue,
    Solid,
    Stripe,
    Eight,
    Red,
    Yellow,
    Green,
    Brown,
    Blue,
    Pink,
    Black,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ball {
    pub id: String,
    pub kind: BallKind,
    pub number: Option<u8>,
    pub pocketed: bool,
    pub rotation: f64,
    pub value: u8,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueTip {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub angle: f64,
    pub elevation: f64,
    pub nominated_color: Option<String>,
    pub power: f64,
    pub tip: CueTip,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulateShotInput {
    pub balls: Vec<Ball>,
    #[serde(default)]
    pub capture_frames: bool,
    pub mode: BilliardsMode,
    pub shot: Shot,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictShotInput {
    pub balls: Vec<Ball>,
    pub mode: BilliardsMode,
    pub shot: Shot,
    #[serde(default = "default_prediction_frames")]
    pub max_frames: usize,
}

fn default_prediction_frames() -> usize {
    240
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MotionState {
    Stationary,
    Spinning,
    Sliding,
    Rolling,
    Airborne,
    Pocketed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationBallFrame {
    pub id: String,
    pub pocketed: bool,
    pub rotation: f64,
    pub spin_x: f64,
    pub spin_y: f64,
    pub spin_z: f64,
    pub state: MotionState,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationFrame {
    pub at_ms: u32,
    pub balls: Vec<SimulationBallFrame>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationEvent {
    pub at_seconds: f64,
    pub kind: String,
    pub ball_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueStrikeDiagnostics {
    pub cue_speed: f64,
    pub jump_speed: f64,
    pub miscue: bool,
    pub squirt_radians: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotSimulationResult {
    pub balls: Vec<Ball>,
    pub checksum: String,
    pub cue_ball_potted: bool,
    pub cue_strike: CueStrikeDiagnostics,
    pub duration_ms: u32,
    pub events: Vec<SimulationEvent>,
    pub first_contact_ball_id: Option<String>,
    pub first_contact_ball_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<Vec<SimulationFrame>>,
    pub jumped_ball_ids: Vec<String>,
    pub physics_version: &'static str,
    pub pocketed_ball_ids: Vec<String>,
    pub post_contact_rail_ball_ids: Vec<String>,
    pub rail_contact_ball_ids: Vec<String>,
    pub state_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictedPathPoint {
    pub at_ms: u32,
    pub state: MotionState,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictedBallPath {
    pub id: String,
    pub points: Vec<PredictedPathPoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryPrediction {
    pub checksum: String,
    pub first_contact_ball_ids: Vec<String>,
    pub paths: Vec<PredictedBallPath>,
    pub physics_version: &'static str,
    pub pocketed_ball_ids: Vec<String>,
    pub state_hash: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BallParameters {
    pub mass: f64,
    pub radius: f64,
    pub sliding_friction: f64,
    pub rolling_friction: f64,
    pub spinning_friction: f64,
    pub ball_restitution: f64,
    pub table_restitution: f64,
    pub cushion_restitution: f64,
    pub cushion_friction: f64,
    pub gravity: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PocketSpec {
    pub id: String,
    pub capture_radius: f64,
    pub capture_x: f64,
    pub capture_y: f64,
    pub kind: PocketKind,
    pub mouth_width: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PocketKind {
    Corner,
    Side,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotSpec {
    pub id: &'static str,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearCushionSpec {
    pub id: String,
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircularCushionSpec {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub radius: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSpec {
    pub mode: BilliardsMode,
    pub width: f64,
    pub height: f64,
    pub outer_width: f64,
    pub outer_height: f64,
    pub cushion_width: f64,
    pub ball_diameter: f64,
    pub ball_mass: f64,
    pub baulk_line_x: Option<f64>,
    pub d_radius: Option<f64>,
    pub pockets: Vec<PocketSpec>,
    pub linear_cushions: Vec<LinearCushionSpec>,
    pub circular_cushions: Vec<CircularCushionSpec>,
    pub spots: Vec<SpotSpec>,
}

#[derive(Clone, Debug)]
pub(crate) struct DynamicBall {
    pub source: Ball,
    pub position: Vec3,
    pub velocity: Vec3,
    pub spin: Vec3,
    pub rotation: f64,
    pub state: MotionState,
    pub pocketed: bool,
}

impl DynamicBall {
    pub fn active(&self) -> bool {
        !self.pocketed && self.state != MotionState::Pocketed
    }
}
