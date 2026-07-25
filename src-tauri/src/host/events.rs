//! Unified event model. All runtime adapters translate into these events.

use serde::{Deserialize, Serialize};

use crate::error::AgentError;
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
    PermissionRequest {
        rpc_id: String,
        tool_name: String,
        title: String,
        preview: String,
        auto_allowed: bool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    Assistant,
    Thought,
}
