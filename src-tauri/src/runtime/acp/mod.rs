//! Shared Agent Client Protocol (JSON-RPC over stdio).
//! Used by Grok (`grok agent stdio`) and later Kimi (`kimi acp`).

mod transport;

pub use transport::{AcpClient, AcpSpawnOpts};
