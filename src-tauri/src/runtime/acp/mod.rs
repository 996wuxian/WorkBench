//! Shared Agent Client Protocol (JSON-RPC over stdio).
//!
//! `AcpRuntime` is fully manifest-driven, so any ACP-speaking CLI (Grok, Kimi,
//! or another future ACP bridge) is added as JSON, not as Rust.

mod runtime;
mod transport;

pub use runtime::AcpRuntime;
pub use transport::{AcpClient, AcpSpawnOpts};
