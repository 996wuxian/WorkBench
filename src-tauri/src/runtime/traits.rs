use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::AgentError;
use crate::host::events::HostEvent;
use crate::host::permissions::PermissionBroker;
use crate::runtime::capabilities::RuntimeCapabilities;
use crate::runtime::catalog::SessionSelectionCatalog;
use crate::runtime::id::RuntimeId;
use crate::runtime::manifest::RuntimeManifest;

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
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Auto => "auto",
            Self::ReadOnly => "read_only",
            Self::FullAccess => "full_access",
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

    /// True when the Host may approve tool requests without asking the user.
    pub fn auto_allow(self) -> bool {
        matches!(self, Self::Auto | Self::FullAccess)
    }
}

/// Session-level settings owned by the Host but validated per runtime.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionSettings {
    pub model_id: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
}

/// A user-requested change. `None` means "leave as is".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettingsPatch {
    pub model_id: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
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
    /// Host-side approval gate. Adapters must route every agent permission
    /// request through this instead of deciding on their own.
    pub permissions: PermissionBroker,
}

#[derive(Debug, Clone)]
pub struct PromptInput {
    pub text: String,
}

/// Descriptor-level runtime (probe + capabilities). Live sessions are separate.
///
/// Everything an adapter can answer from its manifest has a default impl here,
/// so a manifest-driven runtime only has to implement `probe` and `connect`.
#[async_trait]
pub trait AgentRuntime: Send + Sync {
    fn manifest(&self) -> &'static RuntimeManifest;

    fn id(&self) -> RuntimeId {
        // The registry only builds runtimes from manifests with a valid id.
        self.manifest()
            .runtime_id()
            .expect("runtime manifest id validated at registry build")
    }

    fn display_name(&self) -> &str {
        &self.manifest().display_name
    }

    fn enabled(&self) -> bool {
        self.manifest().is_enabled()
    }

    fn capabilities(&self) -> RuntimeCapabilities {
        self.manifest().capabilities.clone()
    }

    async fn probe(&self) -> ProbeResult;

    /// Model / permission choices offered for a session. Adapters that can query
    /// the agent override this; the default answers from the manifest.
    async fn selection_catalog(
        &self,
        _cwd: PathBuf,
        current_model: Option<String>,
    ) -> Result<SessionSelectionCatalog, String> {
        Ok(crate::runtime::catalog::from_manifest(
            self.manifest(),
            current_model,
        ))
    }

    /// Validate and normalize a settings change. Runtime-specific rules
    /// (model id aliases, reasoning effort, unsupported modes) belong here,
    /// not in `SessionManager`.
    fn normalize_settings(
        &self,
        current: &SessionSettings,
        patch: &SessionSettingsPatch,
    ) -> Result<SessionSettings, String> {
        let manifest = self.manifest();
        let mut next = current.clone();

        if let Some(model_id) = patch.model_id.as_deref() {
            let model_id = model_id.trim();
            if model_id.is_empty() {
                return Err("model id cannot be empty".into());
            }
            next.model_id = Some(model_id.to_string());
        }

        if let Some(effort) = patch.model_reasoning_effort.as_deref() {
            if !manifest.capabilities.reasoning_effort {
                return Err(format!(
                    "{} does not support model reasoning effort",
                    manifest.display_name
                ));
            }
            let effort = effort.trim();
            if effort.is_empty() {
                return Err("model reasoning effort cannot be empty".into());
            }
            next.model_reasoning_effort = Some(effort.to_string());
        }

        if let Some(mode) = patch.permission_mode {
            if !manifest.supports_permission_mode(mode) {
                return Err(format!(
                    "{} does not support permission mode `{}`",
                    manifest.display_name,
                    mode.as_str()
                ));
            }
            next.permission_mode = Some(mode);
        }

        Ok(next)
    }

    /// Settings a freshly created session starts with.
    fn default_settings(&self) -> SessionSettings {
        let manifest = self.manifest();
        SessionSettings {
            model_id: manifest.models.first().map(|m| m.value.clone()),
            model_reasoning_effort: None,
            permission_mode: Some(manifest.default_permission_mode()),
        }
    }

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
