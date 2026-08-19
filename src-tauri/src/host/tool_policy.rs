//! Host-owned tool intent classification and approval policy.
//!
//! Runtime adapters report what they are trying to do in their own vocabulary.
//! This layer normalizes that into a small intent/risk/action model before the
//! approval broker decides whether to ask, allow, or deny.

use serde::{Deserialize, Serialize};

use crate::host::permissions::{DecisionSource, PermissionRequest};
use crate::runtime::PermissionMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolIntentKind {
    ReadFile,
    WriteFile,
    EditFile,
    Shell,
    Network,
    Unknown,
}

impl ToolIntentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadFile => "read_file",
            Self::WriteFile => "write_file",
            Self::EditFile => "edit_file",
            Self::Shell => "shell",
            Self::Network => "network",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolRiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl ToolRiskLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPolicyAction {
    Allow,
    Ask,
    Deny,
}

impl ToolPolicyAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolIntent {
    pub kind: ToolIntentKind,
    pub tool_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPolicyDecision {
    pub intent: ToolIntent,
    pub risk: ToolRiskLevel,
    pub scope_key: String,
    pub action: ToolPolicyAction,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct ToolPolicyEvaluation {
    pub decision: ToolPolicyDecision,
    pub automatic_source: Option<DecisionSource>,
}

pub struct ToolPolicyPipeline;

impl ToolPolicyPipeline {
    pub fn evaluate(
        request: &PermissionRequest,
        mode: PermissionMode,
        remembered: bool,
    ) -> ToolPolicyEvaluation {
        let kind = classify_intent(request);
        let risk = classify_risk(kind, request);
        let scope_key = scope_key(&request.tool_name, kind);

        let (action, reason, automatic_source) = match mode {
            PermissionMode::FullAccess | PermissionMode::Auto => (
                ToolPolicyAction::Allow,
                format!("permission mode `{}` allows tool intents", mode.as_str()),
                Some(DecisionSource::Mode),
            ),
            PermissionMode::ReadOnly if is_read_only_allowed(kind) => (
                ToolPolicyAction::Allow,
                "read-only mode allows read-only tool intents".to_string(),
                Some(DecisionSource::Mode),
            ),
            PermissionMode::ReadOnly => (
                ToolPolicyAction::Deny,
                "read-only mode blocks non-read tool intents".to_string(),
                Some(DecisionSource::Mode),
            ),
            PermissionMode::Ask if remembered => (
                ToolPolicyAction::Allow,
                "session grant matched this tool intent scope".to_string(),
                Some(DecisionSource::Remembered),
            ),
            PermissionMode::Ask => (
                ToolPolicyAction::Ask,
                "permission mode `ask` requires user approval".to_string(),
                None,
            ),
        };

        ToolPolicyEvaluation {
            decision: ToolPolicyDecision {
                intent: ToolIntent {
                    kind,
                    tool_name: request.tool_name.clone(),
                },
                risk,
                scope_key,
                action,
                reason,
            },
            automatic_source,
        }
    }
}

fn classify_intent(request: &PermissionRequest) -> ToolIntentKind {
    let tool = request.tool_name.to_ascii_lowercase();
    let title = request.title.to_ascii_lowercase();
    let preview = request.preview.to_ascii_lowercase();
    let combined = format!("{tool}\n{title}\n{preview}");

    if contains_any(
        &combined,
        &[
            "apply_patch",
            "edit",
            "replace",
            "patch",
            "filechange",
            "file_change",
        ],
    ) {
        return ToolIntentKind::EditFile;
    }
    if contains_any(
        &combined,
        &[
            "write",
            "create",
            "delete",
            "remove",
            "rename",
            "move",
            "set-content",
            "out-file",
            "rm ",
            "del ",
        ],
    ) {
        return ToolIntentKind::WriteFile;
    }
    if contains_any(
        &combined,
        &[
            "command",
            "bash",
            "shell",
            "terminal",
            "execute",
            "run_command",
            "runcommand",
            "powershell",
        ],
    ) {
        return ToolIntentKind::Shell;
    }
    if contains_any(
        &combined,
        &["fetch", "web", "http://", "https://", "network", "browser"],
    ) {
        return ToolIntentKind::Network;
    }
    if contains_any(
        &combined,
        &["read", "grep", "search", "list", "glob", "find", "open"],
    ) {
        return ToolIntentKind::ReadFile;
    }

    ToolIntentKind::Unknown
}

fn classify_risk(kind: ToolIntentKind, request: &PermissionRequest) -> ToolRiskLevel {
    let text = format!(
        "{}\n{}\n{}",
        request.tool_name, request.title, request.preview
    )
    .to_ascii_lowercase();
    if contains_any(
        &text,
        &[
            "remove-item",
            "rm -rf",
            "git reset --hard",
            "git clean",
            "force-push",
            "format ",
            "delete",
            "wipe",
        ],
    ) {
        return ToolRiskLevel::Critical;
    }

    match kind {
        ToolIntentKind::ReadFile => ToolRiskLevel::Low,
        ToolIntentKind::Network | ToolIntentKind::Unknown => ToolRiskLevel::Medium,
        ToolIntentKind::WriteFile | ToolIntentKind::EditFile | ToolIntentKind::Shell => {
            ToolRiskLevel::High
        }
    }
}

fn is_read_only_allowed(kind: ToolIntentKind) -> bool {
    matches!(kind, ToolIntentKind::ReadFile)
}

fn scope_key(tool_name: &str, kind: ToolIntentKind) -> String {
    let normalized = tool_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ':'
            }
        })
        .collect::<String>()
        .split(':')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(":");
    format!("intent:{}:tool:{}", kind.as_str(), normalized)
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(tool_name: &str, title: &str, preview: &str) -> PermissionRequest {
        PermissionRequest {
            tool_name: tool_name.into(),
            title: title.into(),
            preview: preview.into(),
        }
    }

    #[test]
    fn classifies_shell_commands_as_high_risk() {
        let request = req("commandExecution", "PowerShell", "pnpm test");
        let evaluation = ToolPolicyPipeline::evaluate(&request, PermissionMode::Ask, false);

        assert_eq!(evaluation.decision.intent.kind, ToolIntentKind::Shell);
        assert_eq!(evaluation.decision.risk, ToolRiskLevel::High);
        assert_eq!(evaluation.decision.action, ToolPolicyAction::Ask);
        assert!(evaluation.decision.scope_key.contains("commandexecution"));
    }

    #[test]
    fn read_only_allows_read_intents_without_asking() {
        let request = req("readFile", "Read src/main.rs", "");
        let evaluation = ToolPolicyPipeline::evaluate(&request, PermissionMode::ReadOnly, false);

        assert_eq!(evaluation.decision.intent.kind, ToolIntentKind::ReadFile);
        assert_eq!(evaluation.decision.action, ToolPolicyAction::Allow);
        assert_eq!(evaluation.automatic_source, Some(DecisionSource::Mode));
    }

    #[test]
    fn read_only_denies_write_intents() {
        let request = req("fileChange", "Edit src/main.rs", "apply_patch");
        let evaluation = ToolPolicyPipeline::evaluate(&request, PermissionMode::ReadOnly, false);

        assert_eq!(evaluation.decision.intent.kind, ToolIntentKind::EditFile);
        assert_eq!(evaluation.decision.action, ToolPolicyAction::Deny);
        assert_eq!(evaluation.automatic_source, Some(DecisionSource::Mode));
    }

    #[test]
    fn remembered_scope_allows_ask_mode_without_reasking() {
        let request = req("fileChange", "Edit src/main.rs", "apply_patch");
        let evaluation = ToolPolicyPipeline::evaluate(&request, PermissionMode::Ask, true);

        assert_eq!(evaluation.decision.action, ToolPolicyAction::Allow);
        assert_eq!(
            evaluation.automatic_source,
            Some(DecisionSource::Remembered)
        );
    }

    #[test]
    fn destructive_commands_are_critical() {
        let request = req("command", "PowerShell", "git reset --hard");
        let evaluation = ToolPolicyPipeline::evaluate(&request, PermissionMode::Ask, false);

        assert_eq!(evaluation.decision.risk, ToolRiskLevel::Critical);
    }
}
