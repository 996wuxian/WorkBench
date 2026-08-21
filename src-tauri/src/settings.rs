//! User-editable app settings (`<data>/settings.json`).
//!
//! Kept deliberately small: anything a user must be able to fix without
//! recompiling — most importantly per-runtime CLI paths, since hard-coded
//! install locations are the #1 reason a fresh machine can't find an agent.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOverride {
    /// Absolute path to the agent executable. Wins over PATH and probe paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_path: Option<String>,
    /// Agent home dir (e.g. what `GROK_HOME` should point at).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_dir: Option<String>,
    /// Force-enable or force-disable a runtime regardless of its manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

impl RuntimeOverride {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexGatewayUsageConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

impl CodexGatewayUsageConfig {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekUsageConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

impl DeepSeekUsageConfig {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSettings {
    #[serde(default, skip_serializing_if = "CodexGatewayUsageConfig::is_empty")]
    pub codex_gateway: CodexGatewayUsageConfig,
    #[serde(default, skip_serializing_if = "DeepSeekUsageConfig::is_empty")]
    pub deepseek: DeepSeekUsageConfig,
}

impl UsageSettings {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalCenterSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl PersonalCenterSettings {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Keyed by runtime id.
    #[serde(default)]
    pub runtimes: BTreeMap<String, RuntimeOverride>,
    #[serde(default, skip_serializing_if = "UsageSettings::is_empty")]
    pub usage: UsageSettings,
    #[serde(default, skip_serializing_if = "PersonalCenterSettings::is_empty")]
    pub personal_center: PersonalCenterSettings,
}

fn settings_path() -> PathBuf {
    paths::data_dir().join("settings.json")
}

fn cache() -> &'static RwLock<AppSettings> {
    static CACHE: OnceLock<RwLock<AppSettings>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(read_from_disk()))
}

fn read_from_disk() -> AppSettings {
    let path = settings_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return AppSettings::default();
    };
    match serde_json::from_str(&text) {
        Ok(settings) => settings,
        Err(err) => {
            tracing::warn!("invalid settings.json ignored ({}): {err}", path.display());
            AppSettings::default()
        }
    }
}

pub fn get() -> AppSettings {
    cache().read().clone()
}

pub fn runtime_override(runtime_id: &str) -> RuntimeOverride {
    cache()
        .read()
        .runtimes
        .get(runtime_id)
        .cloned()
        .unwrap_or_default()
}

/// Replace one runtime's override and persist. An empty override removes the entry.
pub fn set_runtime_override(
    runtime_id: &str,
    value: RuntimeOverride,
) -> Result<AppSettings, String> {
    let next = {
        let mut guard = cache().write();
        if value.is_empty() {
            guard.runtimes.remove(runtime_id);
        } else {
            guard.runtimes.insert(runtime_id.to_string(), value);
        }
        guard.clone()
    };
    write_to_disk(&next)?;
    Ok(next)
}

pub fn set_codex_gateway_usage(value: CodexGatewayUsageConfig) -> Result<AppSettings, String> {
    let next = {
        let mut guard = cache().write();
        guard.usage.codex_gateway = value;
        guard.clone()
    };
    write_to_disk(&next)?;
    Ok(next)
}

pub fn set_deepseek_usage(value: DeepSeekUsageConfig) -> Result<AppSettings, String> {
    let next = {
        let mut guard = cache().write();
        guard.usage.deepseek = value;
        guard.clone()
    };
    write_to_disk(&next)?;
    Ok(next)
}

pub fn set_personal_center(value: PersonalCenterSettings) -> Result<AppSettings, String> {
    if let Some(path) = value.path.as_deref() {
        let path = PathBuf::from(path);
        if !path.is_dir() {
            return Err(format!(
                "personal center directory does not exist: {}",
                path.display()
            ));
        }
    }
    let next = {
        let mut guard = cache().write();
        guard.personal_center = value;
        guard.clone()
    };
    write_to_disk(&next)?;
    Ok(next)
}

/// Drop the in-memory copy and re-read from disk (user edited the file by hand).
pub fn reload() -> AppSettings {
    let fresh = read_from_disk();
    *cache().write() = fresh.clone();
    fresh
}

fn write_to_disk(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Write-then-rename so a crash mid-write cannot truncate the file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
