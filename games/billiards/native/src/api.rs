use crate::geometry::table_spec;
use crate::model::{BilliardsMode, PredictShotInput, SimulateShotInput};
use crate::physics::{predict_shot, simulate_shot};
use crate::rules::{
    BilliardsAction, BilliardsMatchState, BilliardsSettings, BilliardsSimulationResult,
    ReducerContext, RuleError, RuleErrorKind, create_initial_billiards_state,
    reduce_billiards_action,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum CoreRequest {
    Simulate {
        input: SimulateShotInput,
    },
    Predict {
        input: PredictShotInput,
    },
    CreateMatch {
        settings: BilliardsSettings,
        seat_ids: Vec<String>,
    },
    ReduceAction {
        state: Box<BilliardsMatchState>,
        actor_seat_id: String,
        action: BilliardsAction,
        #[serde(default)]
        simulation: Option<BilliardsSimulationResult>,
        #[serde(default)]
        deciding_black_chooser_index: usize,
    },
    TableSpec {
        mode: BilliardsMode,
    },
    Ping,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreError {
    pub kind: ErrorKind,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    InvalidInput,
    Rule,
    Internal,
}

impl CoreError {
    pub fn invalid(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::InvalidInput,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn internal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Internal,
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<RuleError> for CoreError {
    fn from(error: RuleError) -> Self {
        Self {
            kind: match error.kind {
                RuleErrorKind::InvalidInput => ErrorKind::InvalidInput,
                RuleErrorKind::Rule => ErrorKind::Rule,
                RuleErrorKind::Internal => ErrorKind::Internal,
            },
            code: error.code,
            message: error.message,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum CoreResponse {
    Success { ok: bool, value: Value },
    Failure { ok: bool, error: CoreError },
}

impl CoreResponse {
    fn success<T: Serialize>(value: T) -> Self {
        match serde_json::to_value(value) {
            Ok(value) => Self::Success { ok: true, value },
            Err(error) => Self::Failure {
                ok: false,
                error: CoreError::internal("SERIALIZATION_FAILED", error.to_string()),
            },
        }
    }

    fn failure(error: CoreError) -> Self {
        Self::Failure { ok: false, error }
    }
}

pub fn process_json(input: &[u8]) -> Vec<u8> {
    let response = match serde_json::from_slice::<CoreRequest>(input) {
        Ok(CoreRequest::Simulate { input }) => match simulate_shot(input) {
            Ok(result) => CoreResponse::success(result),
            Err(error) => CoreResponse::failure(error),
        },
        Ok(CoreRequest::Predict { input }) => match predict_shot(input) {
            Ok(result) => CoreResponse::success(result),
            Err(error) => CoreResponse::failure(error),
        },
        Ok(CoreRequest::CreateMatch { settings, seat_ids }) => {
            match create_initial_billiards_state(settings, seat_ids) {
                Ok(state) => CoreResponse::success(state),
                Err(error) => CoreResponse::failure(error.into()),
            }
        }
        Ok(CoreRequest::ReduceAction {
            state,
            actor_seat_id,
            action,
            simulation,
            deciding_black_chooser_index,
        }) => match reduce_billiards_action(
            &state,
            &actor_seat_id,
            &action,
            ReducerContext {
                simulation: simulation.as_ref(),
                deciding_black_chooser_index,
            },
        ) {
            Ok(adjudication) => CoreResponse::success(adjudication),
            Err(error) => CoreResponse::failure(error.into()),
        },
        Ok(CoreRequest::TableSpec { mode }) => CoreResponse::success(table_spec(mode)),
        Ok(CoreRequest::Ping) => CoreResponse::success(serde_json::json!({
            "physicsVersion": crate::model::PHYSICS_VERSION,
            "rulesVersion": crate::rules::RULES_VERSION,
        })),
        Err(error) => CoreResponse::failure(CoreError::invalid(
            "INVALID_CORE_REQUEST",
            error.to_string(),
        )),
    };
    serde_json::to_vec(&response).unwrap_or_else(|_| {
        br#"{"ok":false,"error":{"kind":"internal","code":"SERIALIZATION_FAILED","message":"response serialization failed"}}"#.to_vec()
    })
}
