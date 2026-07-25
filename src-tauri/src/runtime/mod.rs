//! Runtime adapters: Grok (ACP) + Codex (App Server) for P0.
//! Claude / Kimi registered as disabled stubs for later phases.

pub mod acp;
mod capabilities;
mod codex;
mod grok;
mod registry;
mod traits;

pub use capabilities::RuntimeCapabilities;
pub use registry::{
    get as get_runtime, list_descriptors, probe_all, probe_runtime, registry, RuntimeDescriptor,
};
pub use traits::RuntimeId;
pub use traits::{AgentRuntime, ConnectOpts, LiveSession, ProbeResult, PromptInput};
