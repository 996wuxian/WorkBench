//! Runtime manifests — the data that describes *how to reach a CLI agent*.
//!
//! Adding a runtime that speaks a protocol we already support (today: ACP and
//! the Codex App Server) is a matter of dropping a JSON file into
//! `<data>/runtimes/`; no Rust change is required. Built-ins are embedded so a
//! fresh install works with an empty data dir.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use which::which;

use crate::paths;
use crate::process_util;
use crate::runtime::capabilities::RuntimeCapabilities;
use crate::runtime::catalog::ChoiceOption;
use crate::runtime::id::RuntimeId;
use crate::runtime::traits::PermissionMode;
use crate::settings;

const BUILTIN_MANIFESTS: &str = include_str!("../../runtimes/builtin.json");

/// Wire protocol the Host speaks to this agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProtocol {
    /// Agent Client Protocol over stdio. Generic — driven entirely by manifest.
    Acp,
    /// `codex app-server --stdio`. Bespoke adapter.
    CodexAppServer,
    /// `claude -p --output-format stream-json`. Bespoke Claude Code CLI adapter.
    ClaudeCode,
}

/// Where the runtime's own session history lives, for read-only import.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeSessionSource {
    /// `<home>/sessions/**/summary.json` (Grok layout).
    AcpSummaryFiles,
    /// Queried over the Codex App Server RPC.
    CodexAppServer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub id: String,
    pub display_name: String,
    pub protocol: RuntimeProtocol,
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Executable name looked up on PATH first.
    pub command: String,
    /// Args inserted before the transport arg (e.g. `["--no-auto-update", "agent"]`).
    #[serde(default)]
    pub pre_stdio_args: Vec<String>,
    /// Args that select the stdio transport, appended last
    /// (`["stdio"]` for Grok, `["acp"]` for Kimi, `[]` for a bare ACP binary).
    #[serde(default = "default_stdio_args")]
    pub stdio_args: Vec<String>,
    /// Flag used to pin a model, e.g. `--model`. `None` = never pass a model.
    #[serde(default = "default_model_arg")]
    pub model_arg: Option<String>,
    /// Args used to read a version string during probing.
    #[serde(default = "default_version_args")]
    pub version_args: Vec<String>,
    /// Fallback absolute paths when the command is not on PATH.
    /// Supports `~`, `%USERPROFILE%`, `%LOCALAPPDATA%`, `%APPDATA%`.
    #[serde(default)]
    pub probe_paths: Vec<String>,

    /// Env var carrying the agent home (e.g. `GROK_HOME`, `CODEX_HOME`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_env: Option<String>,
    /// Candidate homes, in priority order. First one containing a marker wins,
    /// so we reuse the user's existing auth instead of forcing a re-login.
    #[serde(default)]
    pub home_candidates: Vec<String>,
    /// Files that prove a candidate home is a real, logged-in agent home.
    #[serde(default = "default_home_markers")]
    pub home_markers: Vec<String>,

    #[serde(default)]
    pub default_permission_mode: Option<PermissionMode>,
    /// Permission modes this runtime can actually honor. Empty = all four.
    #[serde(default)]
    pub permission_modes: Vec<PermissionMode>,

    /// Static model list, used when the agent exposes no model catalog RPC.
    #[serde(default)]
    pub models: Vec<ChoiceOption>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_sessions: Option<NativeSessionSource>,

    pub capabilities: RuntimeCapabilities,

    /// Shown in the Doctor panel when the runtime is unavailable or degraded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_version_args() -> Vec<String> {
    vec!["--version".into()]
}

fn default_stdio_args() -> Vec<String> {
    vec!["stdio".into()]
}

fn default_model_arg() -> Option<String> {
    Some("--model".into())
}

fn default_home_markers() -> Vec<String> {
    vec!["auth.json".into(), "config.toml".into()]
}

impl RuntimeManifest {
    pub fn runtime_id(&self) -> Option<RuntimeId> {
        RuntimeId::parse(&self.id)
    }

    pub fn is_enabled(&self) -> bool {
        settings::runtime_override(&self.id)
            .enabled
            .unwrap_or(self.enabled)
    }

    pub fn default_permission_mode(&self) -> PermissionMode {
        self.default_permission_mode
            .or_else(|| self.permission_modes.first().copied())
            .unwrap_or(PermissionMode::Ask)
    }

    pub fn supports_permission_mode(&self, mode: PermissionMode) -> bool {
        self.permission_modes.is_empty() || self.permission_modes.contains(&mode)
    }

    /// User override → PATH → manifest probe paths.
    pub fn resolve_cli_path(&self) -> Option<PathBuf> {
        if let Some(raw) = settings::runtime_override(&self.id).cli_path {
            let path = PathBuf::from(expand_path(&raw));
            if path.is_file() {
                return Some(path);
            }
            tracing::warn!(
                "runtime {} cliPath override does not exist: {}",
                self.id,
                path.display()
            );
        }
        if let Ok(path) = which(&self.command) {
            return Some(path);
        }
        self.probe_paths
            .iter()
            .map(|candidate| PathBuf::from(expand_path(candidate)))
            .find(|path| path.is_file())
    }

    /// User override → `home_env` → first marked candidate → isolated app home.
    ///
    /// The isolated fallback keeps a brand-new runtime from writing into a
    /// user CLI home we did not verify.
    pub fn resolve_home(&self) -> PathBuf {
        if let Some(raw) = settings::runtime_override(&self.id).home_dir {
            let path = PathBuf::from(expand_path(&raw));
            if !path.as_os_str().is_empty() {
                return path;
            }
        }
        if let Some(key) = &self.home_env {
            if let Ok(value) = std::env::var(key) {
                let path = PathBuf::from(value);
                if !path.as_os_str().is_empty() {
                    return path;
                }
            }
        }
        for candidate in &self.home_candidates {
            let path = PathBuf::from(expand_path(candidate));
            if self.home_markers.is_empty() && path.is_dir() {
                return path;
            }
            if self
                .home_markers
                .iter()
                .any(|marker| path.join(marker).is_file())
            {
                return path;
            }
        }
        paths::agent_homes_dir().join(&self.id)
    }
}

/// Expand the small set of placeholders manifests are allowed to use.
pub fn expand_path(raw: &str) -> String {
    let home = process_util::user_home();
    let home_str = home.to_string_lossy().to_string();

    let mut out = raw.to_string();
    if let Some(rest) = out.strip_prefix("~/").or_else(|| out.strip_prefix("~\\")) {
        out = format!("{home_str}/{rest}");
    } else if out == "~" {
        out = home_str.clone();
    }
    out = out.replace("%USERPROFILE%", &home_str);
    out = out.replace("$HOME", &home_str);
    for key in ["LOCALAPPDATA", "APPDATA", "PROGRAMFILES"] {
        if let Ok(value) = std::env::var(key) {
            out = out.replace(&format!("%{key}%"), &value);
        }
    }
    out
}

/// Built-ins, then user files from `<data>/runtimes/*.json` (override by id).
/// Cached: manifests are static for the process, while the mutable bits
/// (`cliPath`, `homeDir`, `enabled`) are read live from settings.
pub fn all() -> &'static [RuntimeManifest] {
    static MANIFESTS: OnceLock<Vec<RuntimeManifest>> = OnceLock::new();
    MANIFESTS.get_or_init(load_all)
}

pub fn get(runtime_id: RuntimeId) -> Option<&'static RuntimeManifest> {
    all().iter().find(|m| m.id == runtime_id.as_str())
}

/// Display name without needing a live registry — falls back to the raw id so
/// error messages never show an empty name.
pub fn display_name(runtime_id: RuntimeId) -> String {
    get(runtime_id)
        .map(|m| m.display_name.clone())
        .unwrap_or_else(|| runtime_id.as_str().to_string())
}

fn load_all() -> Vec<RuntimeManifest> {
    let mut manifests: Vec<RuntimeManifest> = match serde_json::from_str(BUILTIN_MANIFESTS) {
        Ok(list) => list,
        Err(err) => {
            // Built-ins are compiled in; a failure here is a build-time mistake.
            tracing::error!("built-in runtime manifests are invalid: {err}");
            Vec::new()
        }
    };

    for manifest in load_user_manifests() {
        match manifests.iter_mut().find(|m| m.id == manifest.id) {
            Some(existing) => {
                tracing::info!("runtime manifest overridden by user file: {}", manifest.id);
                *existing = manifest;
            }
            None => {
                tracing::info!("runtime manifest added by user file: {}", manifest.id);
                manifests.push(manifest);
            }
        }
    }

    manifests.retain(|m| match m.runtime_id() {
        Some(_) => true,
        None => {
            tracing::warn!("runtime manifest with invalid id skipped: {:?}", m.id);
            false
        }
    });
    manifests
}

fn load_user_manifests() -> Vec<RuntimeManifest> {
    let dir = paths::runtimes_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        // Accept either a single manifest or an array of them.
        let parsed = serde_json::from_str::<Vec<RuntimeManifest>>(&text).or_else(|_| {
            serde_json::from_str::<RuntimeManifest>(&text).map(|single| vec![single])
        });
        match parsed {
            Ok(list) => out.extend(list),
            Err(err) => tracing::warn!("invalid runtime manifest {}: {err}", path.display()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_manifests_parse() {
        let list: Vec<RuntimeManifest> =
            serde_json::from_str(BUILTIN_MANIFESTS).expect("built-in manifests must parse");
        assert!(list.iter().any(|m| m.id == "grok"));
        assert!(list.iter().any(|m| m.id == "codex"));
        for manifest in &list {
            assert!(
                manifest.runtime_id().is_some(),
                "manifest id must be a valid RuntimeId: {}",
                manifest.id
            );
        }
    }

    #[test]
    fn builtin_permission_modes_include_the_default() {
        for manifest in all() {
            assert!(
                manifest.supports_permission_mode(manifest.default_permission_mode()),
                "{} declares a default mode it does not support",
                manifest.id
            );
        }
    }

    #[test]
    fn expand_path_handles_tilde() {
        let expanded = expand_path("~/.grok");
        assert!(!expanded.starts_with('~'));
        assert!(expanded.ends_with(".grok"));
    }
}
