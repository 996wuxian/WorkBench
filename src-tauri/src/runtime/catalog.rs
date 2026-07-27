use serde::{Deserialize, Serialize};

use super::RuntimeId;
use crate::runtime::manifest::RuntimeManifest;
use crate::runtime::traits::PermissionMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

impl ChoiceOption {
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            hint: None,
            suffix: None,
            disabled: false,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSelectionCatalog {
    pub runtime_id: RuntimeId,
    pub model_options: Vec<ChoiceOption>,
    pub permission_options: Vec<ChoiceOption>,
}

const ALL_PERMISSION_MODES: [PermissionMode; 4] = [
    PermissionMode::Ask,
    PermissionMode::Auto,
    PermissionMode::ReadOnly,
    PermissionMode::FullAccess,
];

fn permission_label(mode: PermissionMode) -> (&'static str, &'static str) {
    match mode {
        PermissionMode::Ask => ("Ask", "每次工具调用都询问"),
        PermissionMode::Auto => ("Approve for me", "自动放行工具调用"),
        PermissionMode::ReadOnly => ("Read Only", "只读沙箱，禁止写入"),
        PermissionMode::FullAccess => ("Full Access", "无沙箱，谨慎使用"),
    }
}

/// Default catalog for runtimes that cannot be queried for their own options.
/// Unsupported permission modes are listed but disabled, so the UI shows *why*
/// a mode is unavailable instead of silently hiding it.
pub fn from_manifest(
    manifest: &RuntimeManifest,
    current_model: Option<String>,
) -> SessionSelectionCatalog {
    let mut model_options: Vec<ChoiceOption> = Vec::new();
    if let Some(current) = current_model.filter(|m| !m.trim().is_empty()) {
        model_options.push(ChoiceOption::new(current.clone(), current));
    }
    for option in &manifest.models {
        if model_options.iter().any(|opt| opt.value == option.value) {
            continue;
        }
        model_options.push(option.clone());
    }

    let permission_options = ALL_PERMISSION_MODES
        .iter()
        .map(|&mode| {
            let (label, hint) = permission_label(mode);
            let supported = manifest.supports_permission_mode(mode);
            ChoiceOption::new(mode.as_str(), label)
                .with_hint(if supported {
                    hint.to_string()
                } else {
                    format!("{} 暂不支持", manifest.display_name)
                })
                .disabled(!supported)
        })
        .collect();

    SessionSelectionCatalog {
        runtime_id: manifest
            .runtime_id()
            .expect("catalog built from a validated manifest"),
        model_options,
        permission_options,
    }
}
