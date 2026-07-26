use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::AgentError;
use crate::host::events::HostEvent;
use crate::runtime::capabilities::RuntimeCapabilities;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeId {
    Grok,
    Codex,
    Claude,
    Kimi,
}

impl RuntimeId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Grok => "grok",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Kimi => "kimi",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "grok" => Some(Self::Grok),
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            "kimi" => Some(Self::Kimi),
            _ => None,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Grok => "Grok Build",
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
            Self::Kimi => "Kimi",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub runtime_id: RuntimeId,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    Ask,
    Auto,
    ReadOnly,
    FullAccess,
}

impl PermissionMode {
    pub fn default_for_runtime(runtime_id: RuntimeId) -> Self {
        match runtime_id {
            RuntimeId::Grok => Self::Auto,
            RuntimeId::Codex => Self::Ask,
            RuntimeId::Claude | RuntimeId::Kimi => Self::Ask,
        }
    }

    pub fn codex_approval_policy(self) -> &'static str {
        match self {
            Self::Ask | Self::ReadOnly | Self::Auto => "on-request",
            Self::FullAccess => "never",
        }
    }

    pub fn codex_sandbox(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::FullAccess => "danger-full-access",
            Self::Ask | Self::Auto => "workspace-write",
        }
    }

    pub fn codex_approvals_reviewer(self) -> &'static str {
        match self {
            Self::Auto => "auto_review",
            Self::Ask | Self::ReadOnly | Self::FullAccess => "user",
        }
    }

    pub fn grok_auto_allow(self) -> bool {
        matches!(self, Self::Auto)
    }
}

#[derive(Debug, Clone)]
pub struct ConnectOpts {
    pub cwd: PathBuf,
    pub model_id: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub permission_mode: PermissionMode,
    pub cli_path: Option<PathBuf>,
    pub native_session_id: Option<String>,
    pub native_thread_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PromptInput {
    pub text: String,
}

/// Descriptor-level runtime (probe + capabilities). Live sessions are separate.
#[async_trait]
pub trait AgentRuntime: Send + Sync {
    fn id(&self) -> RuntimeId;
    fn display_name(&self) -> &'static str {
        self.id().display_name()
    }
    fn enabled(&self) -> bool {
        true
    }
    fn capabilities(&self) -> RuntimeCapabilities;

    async fn probe(&self) -> ProbeResult;

    /// Skeleton: real adapters will spawn child + handshake.
    async fn connect(
        &self,
        opts: ConnectOpts,
        event_tx: mpsc::UnboundedSender<HostEvent>,
    ) -> Result<Box<dyn LiveSession>, AgentError>;
}

#[async_trait]
pub trait LiveSession: Send + Sync {
    fn backend(&self) -> &str;
    fn native_session_id(&self) -> Option<String> {
        None
    }
    fn native_thread_id(&self) -> Option<String> {
        None
    }
    fn native_home(&self) -> Option<String> {
        None
    }
    async fn prompt(&self, input: PromptInput) -> Result<(), AgentError>;
    async fn cancel(&self) -> Result<(), AgentError>;
    async fn shutdown(&self) -> Result<(), AgentError>;
}
