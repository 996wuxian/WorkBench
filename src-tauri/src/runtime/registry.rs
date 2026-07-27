//! Runtime registry — built from manifests, not from a hardcoded list.
//!
//! Adding a CLI that speaks a protocol we already support means shipping a
//! manifest; nothing here changes. Only a *new protocol* requires Rust.

use std::sync::{Arc, OnceLock};

use serde::Serialize;

use crate::runtime::acp::AcpRuntime;
use crate::runtime::capabilities::RuntimeCapabilities;
use crate::runtime::codex::CodexRuntime;
use crate::runtime::manifest::{self, RuntimeProtocol};
use crate::runtime::id::RuntimeId;
use crate::runtime::traits::{AgentRuntime, PermissionMode, ProbeResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub id: RuntimeId,
    pub display_name: String,
    pub enabled: bool,
    pub capabilities: RuntimeCapabilities,
    /// Permission modes the runtime can honor (empty manifest list = all four).
    pub permission_modes: Vec<PermissionMode>,
    pub default_permission_mode: PermissionMode,
    /// Why a runtime is disabled or unverified — shown in Doctor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Built once per process. Manifests are static; the mutable parts
/// (`enabled`, `cliPath`, `homeDir`) are read from settings on every access,
/// so a settings change takes effect without rebuilding this.
pub fn registry() -> &'static [Arc<dyn AgentRuntime>] {
    static REGISTRY: OnceLock<Vec<Arc<dyn AgentRuntime>>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        manifest::all()
            .iter()
            .map(|m| -> Arc<dyn AgentRuntime> {
                match m.protocol {
                    RuntimeProtocol::Acp => Arc::new(AcpRuntime::new(m)),
                    RuntimeProtocol::CodexAppServer => Arc::new(CodexRuntime::new(m)),
                }
            })
            .collect()
    })
}

pub fn get(id: RuntimeId) -> Option<Arc<dyn AgentRuntime>> {
    registry().iter().find(|r| r.id() == id).cloned()
}

/// Like [`get`], but rejects runtimes the user has turned off.
pub fn get_enabled(id: RuntimeId) -> Result<Arc<dyn AgentRuntime>, String> {
    let runtime = get(id).ok_or_else(|| format!("unknown runtime: {id}"))?;
    if !runtime.enabled() {
        return Err(format!("{} 已禁用（可在设置中启用）", runtime.display_name()));
    }
    Ok(runtime)
}

pub fn list_descriptors() -> Vec<RuntimeDescriptor> {
    registry()
        .iter()
        .map(|r| {
            let manifest = r.manifest();
            RuntimeDescriptor {
                id: r.id(),
                display_name: r.display_name().to_string(),
                enabled: r.enabled(),
                capabilities: r.capabilities(),
                permission_modes: if manifest.permission_modes.is_empty() {
                    vec![
                        PermissionMode::Ask,
                        PermissionMode::Auto,
                        PermissionMode::ReadOnly,
                        PermissionMode::FullAccess,
                    ]
                } else {
                    manifest.permission_modes.clone()
                },
                default_permission_mode: manifest.default_permission_mode(),
                notes: manifest.notes.clone(),
            }
        })
        .collect()
}

/// Probe every registered runtime, including disabled ones — Doctor should be
/// able to tell "not installed" apart from "installed but switched off".
pub async fn probe_all() -> Vec<ProbeResult> {
    let runtimes: Vec<Arc<dyn AgentRuntime>> = registry().to_vec();
    let mut out = Vec::with_capacity(runtimes.len());
    for r in runtimes {
        out.push(r.probe().await);
    }
    out
}

pub async fn probe_runtime(id: RuntimeId) -> Option<ProbeResult> {
    let r = get(id)?;
    Some(r.probe().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_every_manifest() {
        assert_eq!(registry().len(), manifest::all().len());
        assert!(registry().iter().any(|r| r.id() == RuntimeId::GROK));
        assert!(registry().iter().any(|r| r.id() == RuntimeId::CODEX));
    }

    #[test]
    fn descriptors_never_offer_an_unsupported_default_mode() {
        for descriptor in list_descriptors() {
            assert!(
                descriptor
                    .permission_modes
                    .contains(&descriptor.default_permission_mode),
                "{} default mode is not in its supported list",
                descriptor.id
            );
        }
    }
}
