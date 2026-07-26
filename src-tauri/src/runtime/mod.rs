//! Runtime adapters: Grok (ACP) + Codex (App Server) for P0.
//! Claude / Kimi registered as disabled stubs for later phases.

pub mod acp;
mod capabilities;
pub mod catalog;
mod codex;
mod grok;
mod registry;
mod traits;

pub use capabilities::RuntimeCapabilities;
pub use catalog::{ChoiceOption, SessionSelectionCatalog};
pub use codex::read_selection_catalog as read_codex_selection_catalog;
pub use registry::{
    get as get_runtime, list_descriptors, probe_all, probe_runtime, registry, RuntimeDescriptor,
};
pub use traits::{AgentRuntime, ConnectOpts, LiveSession, ProbeResult, PromptInput};
pub use traits::{PermissionMode, RuntimeId};
