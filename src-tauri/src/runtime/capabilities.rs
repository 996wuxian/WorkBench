use serde::{Deserialize, Serialize};

/// Capability matrix projected to UI for honest degradation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub streaming: bool,
    pub thoughts: bool,
    pub tools: bool,
    pub permission_gate: bool,
    pub session_resume: bool,
    pub multi_turn: bool,
    pub models_list: bool,
    pub plan_mode: bool,
    pub slash_commands: bool,
    pub images_in: bool,
    pub images_out: bool,
    /// Human label: "acp" | "codex_app_server" | "stream_json" | "stub"
    pub protocol: String,
}

impl RuntimeCapabilities {
    pub fn acp_full() -> Self {
        Self {
            streaming: true,
            thoughts: true,
            tools: true,
            permission_gate: true,
            session_resume: true,
            multi_turn: true,
            models_list: true,
            plan_mode: true,
            slash_commands: true,
            images_in: true,
            images_out: true,
            protocol: "acp".into(),
        }
    }

    pub fn codex_app_server() -> Self {
        Self {
            streaming: true,
            thoughts: true,
            tools: true,
            permission_gate: true,
            session_resume: true,
            multi_turn: true,
            models_list: true,
            plan_mode: false,
            slash_commands: false,
            images_in: true,
            images_out: false,
            protocol: "codex_app_server".into(),
        }
    }

    pub fn stub(protocol: &str) -> Self {
        Self {
            streaming: false,
            thoughts: false,
            tools: false,
            permission_gate: false,
            session_resume: false,
            multi_turn: false,
            models_list: false,
            plan_mode: false,
            slash_commands: false,
            images_in: false,
            images_out: false,
            protocol: protocol.into(),
        }
    }
}
