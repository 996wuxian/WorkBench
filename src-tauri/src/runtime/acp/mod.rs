//! Shared Agent Client Protocol (JSON-RPC over stdio).
//!
//! `AcpRuntime` is fully manifest-driven, so any ACP-speaking CLI (Grok, Kimi,
//! Gemini, the claude-code-acp bridge) is added as JSON, not as Rust.

mod runtime;
mod transport;

pub use runtime::AcpRuntime;
pub use transport::{AcpClient, AcpSpawnOpts};
