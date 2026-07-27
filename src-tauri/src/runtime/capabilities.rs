use serde::{Deserialize, Serialize};

/// Capability matrix projected to UI for honest degradation.
///
/// Values come from each runtime's manifest, so a user-authored runtime can
/// describe itself accurately. Every field defaults to `false`: a manifest that
/// omits a capability must degrade the UI, never over-promise.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeCapabilities {
    pub streaming: bool,
    pub thoughts: bool,
    pub tools: bool,
    pub permission_gate: bool,
    pub session_resume: bool,
    pub multi_turn: bool,
    pub models_list: bool,
    /// The agent accepts a separate reasoning-effort setting alongside the model.
    pub reasoning_effort: bool,
    pub plan_mode: bool,
    pub slash_commands: bool,
    pub images_in: bool,
    pub images_out: bool,
    /// Human label: "acp" | "codex_app_server" | "stream_json" | "stub"
    pub protocol: String,
}
