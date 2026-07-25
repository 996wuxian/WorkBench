//! Host-side error taxonomy. UI maps codes for user-facing copy.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentErrorCode {
    CliNotFound,
    AuthFailed,
    NetworkProvider,
    AgentCrashed,
    QuotaExceeded,
    ConnectFailed,
    ProtocolMismatch,
    CapabilityMissing,
}

impl AgentErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CliNotFound => "CLI_NOT_FOUND",
            Self::AuthFailed => "AUTH_FAILED",
            Self::NetworkProvider => "NETWORK_PROVIDER",
            Self::AgentCrashed => "AGENT_CRASHED",
            Self::QuotaExceeded => "QUOTA_EXCEEDED",
            Self::ConnectFailed => "CONNECT_FAILED",
            Self::ProtocolMismatch => "PROTOCOL_MISMATCH",
            Self::CapabilityMissing => "CAPABILITY_MISSING",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentError {
    pub code: AgentErrorCode,
    pub message: String,
}

impl AgentError {
    pub fn new(code: AgentErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_serialize_to_stable_names() {
        let json = serde_json::to_string(&AgentErrorCode::CliNotFound).unwrap();
        assert_eq!(json, "\"CLI_NOT_FOUND\"");
    }
}
