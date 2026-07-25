//! Pure session FSM owned by Host (same model as grok-app).
//! Frontend only projects snapshots; transitions happen here.

use serde::{Deserialize, Serialize};

use crate::error::AgentError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Connecting,
    Ready,
    Streaming,
    AwaitingPermission,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionFsm {
    state: SessionState,
    last_error: Option<AgentError>,
}

impl Default for SessionFsm {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionFsm {
    pub fn new() -> Self {
        Self {
            state: SessionState::Idle,
            last_error: None,
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn last_error(&self) -> Option<&AgentError> {
        self.last_error.as_ref()
    }

    pub fn start_connect(&mut self) -> Result<(), FsmError> {
        match self.state {
            SessionState::Idle | SessionState::Disconnected => {
                self.state = SessionState::Connecting;
                self.last_error = None;
                Ok(())
            }
            other => Err(FsmError::InvalidTransition {
                from: other,
                event: "start_connect",
            }),
        }
    }

    pub fn handshake_ok(&mut self) -> Result<(), FsmError> {
        match self.state {
            SessionState::Connecting => {
                self.state = SessionState::Ready;
                Ok(())
            }
            other => Err(FsmError::InvalidTransition {
                from: other,
                event: "handshake_ok",
            }),
        }
    }

    pub fn connect_failed(&mut self, err: AgentError) -> Result<(), FsmError> {
        match self.state {
            SessionState::Connecting => {
                self.state = SessionState::Disconnected;
                self.last_error = Some(err);
                Ok(())
            }
            other => Err(FsmError::InvalidTransition {
                from: other,
                event: "connect_failed",
            }),
        }
    }

    pub fn begin_stream(&mut self) -> Result<(), FsmError> {
        match self.state {
            SessionState::Ready => {
                self.state = SessionState::Streaming;
                Ok(())
            }
            other => Err(FsmError::InvalidTransition {
                from: other,
                event: "begin_stream",
            }),
        }
    }

    pub fn end_stream(&mut self) -> Result<(), FsmError> {
        match self.state {
            SessionState::Streaming | SessionState::AwaitingPermission => {
                self.state = SessionState::Ready;
                Ok(())
            }
            other => Err(FsmError::InvalidTransition {
                from: other,
                event: "end_stream",
            }),
        }
    }

    pub fn await_permission(&mut self) -> Result<(), FsmError> {
        match self.state {
            SessionState::Streaming => {
                self.state = SessionState::AwaitingPermission;
                Ok(())
            }
            other => Err(FsmError::InvalidTransition {
                from: other,
                event: "await_permission",
            }),
        }
    }

    pub fn disconnect(&mut self, err: Option<AgentError>) {
        self.state = SessionState::Disconnected;
        self.last_error = err;
    }

    pub fn mark_ready_from_idle_for_stub(&mut self) {
        // Skeleton helper: allow demo transitions without full adapter.
        self.state = SessionState::Ready;
        self.last_error = None;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsmError {
    InvalidTransition {
        from: SessionState,
        event: &'static str,
    },
}

impl std::fmt::Display for FsmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTransition { from, event } => {
                write!(f, "invalid FSM transition: {event} from {from:?}")
            }
        }
    }
}

impl std::error::Error for FsmError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_ready_stream_cycle() {
        let mut fsm = SessionFsm::new();
        assert_eq!(fsm.state(), SessionState::Idle);
        fsm.start_connect().unwrap();
        fsm.handshake_ok().unwrap();
        assert_eq!(fsm.state(), SessionState::Ready);
        fsm.begin_stream().unwrap();
        fsm.end_stream().unwrap();
        assert_eq!(fsm.state(), SessionState::Ready);
    }
}
