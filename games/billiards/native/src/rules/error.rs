use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

pub type RuleResult<T> = Result<T, RuleError>;

/// Stable error categories exposed across the native/WASM boundary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleErrorKind {
    InvalidInput,
    Rule,
    Internal,
}

/// A machine-readable rules error.
///
/// `code` is the compatibility contract; `message` is only diagnostic text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleError {
    pub kind: RuleErrorKind,
    pub code: String,
    pub message: String,
}

impl RuleError {
    pub fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: RuleErrorKind::InvalidInput,
            code: code.to_owned(),
            message: message.into(),
        }
    }

    pub fn rule(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: RuleErrorKind::Rule,
            code: code.to_owned(),
            message: message.into(),
        }
    }

    pub fn internal(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: RuleErrorKind::Internal,
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl Display for RuleError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RuleError {}
