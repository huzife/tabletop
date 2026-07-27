use crate::geometry::{configure_table_scene, ensure_table_scene_configured, table_spec};
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
    ConfigureTableScene {
        mode: BilliardsMode,
        scene: Value,
    },
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

fn execute_with_table_scene<T, E>(
    mode: BilliardsMode,
    operation: impl FnOnce() -> Result<T, E>,
) -> CoreResponse
where
    T: Serialize,
    E: Into<CoreError>,
{
    if let Err(message) = ensure_table_scene_configured(mode) {
        return CoreResponse::failure(CoreError::invalid("TABLE_SCENE_NOT_LOADED", message));
    }
    match operation() {
        Ok(value) => CoreResponse::success(value),
        Err(error) => CoreResponse::failure(error.into()),
    }
}

pub fn process_json(input: &[u8]) -> Vec<u8> {
    let response = match serde_json::from_slice::<CoreRequest>(input) {
        Ok(CoreRequest::ConfigureTableScene { mode, scene }) => {
            match configure_table_scene(mode, scene) {
                Ok(()) => CoreResponse::success(serde_json::json!({ "mode": mode })),
                Err(message) => {
                    CoreResponse::failure(CoreError::invalid("INVALID_TABLE_SCENE", message))
                }
            }
        }
        Ok(CoreRequest::Simulate { input }) => {
            execute_with_table_scene(input.mode, || simulate_shot(input))
        }
        Ok(CoreRequest::Predict { input }) => {
            execute_with_table_scene(input.mode, || predict_shot(input))
        }
        Ok(CoreRequest::CreateMatch { settings, seat_ids }) => {
            execute_with_table_scene(settings.mode, || {
                create_initial_billiards_state(settings, seat_ids)
            })
        }
        Ok(CoreRequest::ReduceAction {
            state,
            actor_seat_id,
            action,
            simulation,
            deciding_black_chooser_index,
        }) => execute_with_table_scene(state.settings.mode, || {
            reduce_billiards_action(
                &state,
                &actor_seat_id,
                &action,
                ReducerContext {
                    simulation: simulation.as_ref(),
                    deciding_black_chooser_index,
                },
            )
        }),
        Ok(CoreRequest::TableSpec { mode }) => {
            execute_with_table_scene(mode, || Ok::<_, CoreError>(table_spec(mode)))
        }
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
