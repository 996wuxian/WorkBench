//! Unified event model. All runtime adapters translate into these events.

use serde::{Deserialize, Serialize};

use crate::error::AgentError;
use crate::host::permissions::{DecisionSource, PermissionDecision};
use crate::runtime::RuntimeId;
use crate::session_fsm::SessionState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostEvent {
    State {
        state: SessionState,
        runtime_id: RuntimeId,
        backend: String,
    },
    Stream {
        kind: StreamKind,
        text: String,
        done: bool,
    },
    ToolCall {
        id: String,
        name: String,
        status: String,
        title: String,
    },
    FileChange {
        files: Vec<FileChangeStat>,
    },
    /// A tool call is waiting for approval. `request_id` is Host-generated and
    /// is what `session_permission_respond` expects — adapters never expose
    /// their own protocol ids to the UI.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        title: String,
        preview: String,
        /// Already decided by the session's permission mode or a remembered
        /// grant; emitted for visibility, no answer is expected.
        auto_allowed: bool,
    },
    /// Terminal state for a `PermissionRequest`. The UI uses this to retire the
    /// approval card, including when the Host decided on the user's behalf.
    PermissionResolved {
        request_id: String,
        decision: PermissionDecision,
        source: DecisionSource,
    },
    PromptComplete {
        stop_reason: String,
    },
    Error {
        error: AgentError,
    },
    ProcessExited {
        code: Option<i32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeStat {
    pub path: String,
    pub full_path: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<FileChangeHunk>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeHunk {
    pub old_start: Option<u32>,
    pub new_start: Option<u32>,
    pub lines: Vec<FileChangeLine>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeLine {
    pub kind: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    Assistant,
    Thought,
}
