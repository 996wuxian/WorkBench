//! Runtime adapters.
//!
//! Two protocols are implemented: ACP (generic, manifest-driven) and the Codex
//! App Server. Which CLIs exist, where they live and what they support is data
//! (`runtimes/builtin.json` + `<data>/runtimes/*.json`), not code.

pub mod acp;
mod capabilities;
pub mod catalog;
mod claude;
mod codex;
mod id;
pub mod manifest;
mod registry;
mod traits;

pub use capabilities::RuntimeCapabilities;
pub use catalog::{ChoiceOption, SessionSelectionCatalog};
pub use id::RuntimeId;
pub use manifest::{NativeSessionSource, RuntimeManifest, RuntimeProtocol};
pub use registry::{
    get as get_runtime, get_enabled as get_enabled_runtime, list_descriptors, probe_all,
    probe_runtime, registry, RuntimeDescriptor,
};
pub use traits::PermissionMode;
pub use traits::{
    AgentRuntime, ConnectOpts, LiveSession, ProbeResult, PromptInput, SessionSettings,
    SessionSettingsPatch,
};
