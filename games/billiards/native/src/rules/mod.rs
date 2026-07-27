//! Pure, serde-compatible billiards rules.
//!
//! The physics engine produces a [`BilliardsSimulationResult`]. This module
//! consumes that immutable result and returns a new [`BilliardsMatchState`];
//! it never mutates global state or performs random I/O. When snooker's
//! respotted-black procedure needs a toss, the caller supplies the selected
//! seat index through [`ReducerContext`].

pub const RULES_VERSION: &str = "tabletop-billiards-rules-v1";

mod common;
mod eight_ball;
mod error;
mod placement;
mod practice;
mod reducer;
mod setup;
mod snooker;
mod types;

pub use eight_ball::{
    adjudicate_chinese_eight_ball_shot, resolve_eight_ball_break_choice,
    resolve_eight_ball_group_choice,
};
pub use error::{RuleError, RuleErrorKind, RuleResult};
pub use placement::{check_cue_placement, place_cue_ball};
pub use practice::adjudicate_practice_shot;
pub use reducer::{ReducerContext, reduce_billiards_action};
pub use setup::{
    create_chinese_eight_ball_rack, create_initial_balls, create_initial_billiards_state,
    create_snooker_rack, rerack_chinese_eight_ball,
};
pub use snooker::{adjudicate_snooker_shot, resolve_snooker_deciding_black_choice};
pub use types::*;

#[cfg(test)]
mod tests;
