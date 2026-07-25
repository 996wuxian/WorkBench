//! Host session manager: owns FSM + live runtime sessions + event fan-out.

use std::collections::HashMap;
use std::path::PathBuf;

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{HostEvent, StreamKind};
use crate::runtime::{self, ConnectOpts, LiveSession, PromptInput, RuntimeId};
use crate::session_fsm::{SessionFsm, SessionState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub runtime_id: RuntimeId,
    pub project_path: Option<String>,
    pub model_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: Option<String>,
    pub runtime_id: Option<RuntimeId>,
    pub state: SessionState,
    pub last_error: Option<AgentError>,
    pub backend: String,
    pub model_id: Option<String>,
    pub project_path: Option<String>,
    pub title: String,
}

struct LiveSessionSlot {
    meta: SessionMeta,
    fsm: SessionFsm,
    backend: String,
    live: Option<std::sync::Arc<dyn LiveSession>>,
}

pub struct SessionManager {
    inner: Mutex<Inner>,
}

struct Inner {
    sessions: HashMap<String, LiveSessionSlot>,
    active_id: Option<String>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                active_id: None,
            }),
        }
    }

    pub fn list(&self) -> Vec<SessionMeta> {
        let guard = self.inner.lock();
        let mut list: Vec<_> = guard.sessions.values().map(|s| s.meta.clone()).collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        list
    }

    pub fn create(
        &self,
        runtime_id: RuntimeId,
        project_path: Option<String>,
    ) -> Result<SessionMeta, String> {
        if !matches!(runtime_id, RuntimeId::Grok | RuntimeId::Codex) {
            return Err(format!(
                "{} is not enabled in P0 (use grok or codex)",
                runtime_id.display_name()
            ));
        }

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let title = format!("{} · 新会话", runtime_id.display_name());
        let model_id = match runtime_id {
            RuntimeId::Grok => Some("grok-4.5".into()),
            RuntimeId::Codex => Some("default".into()),
            _ => None,
        };

        // Default project path: cwd or workbench repo
        let project_path = project_path.or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.display().to_string())
        });

        let meta = SessionMeta {
            id: id.clone(),
            title,
            runtime_id,
            project_path,
            model_id,
            created_at: now.clone(),
            updated_at: now,
        };

        let slot = LiveSessionSlot {
            meta: meta.clone(),
            fsm: SessionFsm::new(),
            backend: "none".into(),
            live: None,
        };

        let mut guard = self.inner.lock();
        guard.sessions.insert(id.clone(), slot);
        guard.active_id = Some(id);
        Ok(meta)
    }

    pub fn snapshot(&self, session_id: Option<&str>) -> SessionSnapshot {
        let guard = self.inner.lock();
        let id = session_id
            .map(|s| s.to_string())
            .or_else(|| guard.active_id.clone());

        let Some(id) = id else {
            return SessionSnapshot {
                session_id: None,
                runtime_id: None,
                state: SessionState::Idle,
                last_error: None,
                backend: "none".into(),
                model_id: None,
                project_path: None,
                title: "Workbench".into(),
            };
        };

        match guard.sessions.get(&id) {
            Some(slot) => SessionSnapshot {
                session_id: Some(slot.meta.id.clone()),
                runtime_id: Some(slot.meta.runtime_id),
                state: slot.fsm.state(),
                last_error: slot.fsm.last_error().cloned(),
                backend: slot.backend.clone(),
                model_id: slot.meta.model_id.clone(),
                project_path: slot.meta.project_path.clone(),
                title: slot.meta.title.clone(),
            },
            None => SessionSnapshot {
                session_id: Some(id),
                runtime_id: None,
                state: SessionState::Disconnected,
                last_error: Some(AgentError::new(
                    AgentErrorCode::ConnectFailed,
                    "session not found",
                )),
                backend: "none".into(),
                model_id: None,
                project_path: None,
                title: "missing".into(),
            },
        }
    }

    fn emit_state(&self, app: &AppHandle, session_id: &str) {
        let snap = self.snapshot(Some(session_id));
        let _ = app.emit("session://state", &snap);
    }

    pub async fn connect(
        &self,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<SessionSnapshot, String> {
        let (runtime_id, cwd, model_id) = {
            let mut guard = self.inner.lock();
            let slot = guard
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "session not found".to_string())?;

            // Already connected
            if slot.live.is_some()
                && matches!(
                    slot.fsm.state(),
                    SessionState::Ready
                        | SessionState::Streaming
                        | SessionState::AwaitingPermission
                )
            {
                return Ok(self.snapshot(Some(session_id)));
            }

            // Reset from disconnected
            if matches!(
                slot.fsm.state(),
                SessionState::Disconnected | SessionState::Idle
            ) {
                // force idle then connect
                if slot.fsm.state() == SessionState::Disconnected {
                    slot.fsm = SessionFsm::new();
                }
            }

            slot.fsm.start_connect().map_err(|e| e.to_string())?;
            let cwd = slot
                .meta
                .project_path
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
            (slot.meta.runtime_id, cwd, slot.meta.model_id.clone())
        };

        self.emit_state(app, session_id);

        let runtime = runtime::get_runtime(runtime_id)
            .ok_or_else(|| format!("runtime {:?} not registered", runtime_id))?;

        let (tx, mut rx) = mpsc::unbounded_channel::<HostEvent>();
        let opts = ConnectOpts {
            cwd,
            model_id,
            cli_path: None,
        };

        let app_events = app.clone();
        let sid_events = session_id.to_string();

        // Forward HostEvents to UI (stream/tool/error)
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                match &ev {
                    HostEvent::Stream { kind, text, done } => {
                        let _ = app_events.emit(
                            "session://stream",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "kind": match kind {
                                    StreamKind::Assistant => "assistant",
                                    StreamKind::Thought => "thought",
                                },
                                "text": text,
                                "done": done,
                            }),
                        );
                    }
                    HostEvent::ToolCall {
                        id,
                        name,
                        status,
                        title,
                    } => {
                        let _ = app_events.emit(
                            "session://tool",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "id": id,
                                "name": name,
                                "status": status,
                                "title": title,
                            }),
                        );
                    }
                    HostEvent::PermissionRequest {
                        rpc_id,
                        tool_name,
                        title,
                        preview,
                        auto_allowed,
                    } => {
                        let _ = app_events.emit(
                            "session://permission",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "rpcId": rpc_id,
                                "toolName": tool_name,
                                "title": title,
                                "preview": preview,
                                "autoAllowed": auto_allowed,
                            }),
                        );
                    }
                    HostEvent::PromptComplete { stop_reason } => {
                        let _ = app_events.emit(
                            "session://prompt_complete",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "stopReason": stop_reason,
                            }),
                        );
                    }
                    HostEvent::Error { error } => {
                        let _ = app_events.emit(
                            "session://error",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "code": error.code.as_str(),
                                "message": error.message,
                            }),
                        );
                    }
                    HostEvent::ProcessExited { code } => {
                        let _ = app_events.emit(
                            "session://exited",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "code": code,
                            }),
                        );
                    }
                    HostEvent::State {
                        state,
                        runtime_id,
                        backend,
                    } => {
                        let _ = app_events.emit(
                            "session://runtime_state",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "state": serde_json::to_value(state).unwrap_or_default(),
                                "runtimeId": runtime_id.as_str(),
                                "backend": backend,
                            }),
                        );
                    }
                }
            }
        });

        match runtime.connect(opts, tx).await {
            Ok(live) => {
                let backend = live.backend().to_string();
                let live: std::sync::Arc<dyn LiveSession> = live.into();
                let mut guard = self.inner.lock();
                let slot = guard
                    .sessions
                    .get_mut(session_id)
                    .ok_or_else(|| "session not found".to_string())?;
                slot.fsm.handshake_ok().map_err(|e| e.to_string())?;
                slot.backend = backend;
                slot.live = Some(live);
                slot.meta.updated_at = Utc::now().to_rfc3339();
            }
            Err(err) => {
                let mut guard = self.inner.lock();
                if let Some(slot) = guard.sessions.get_mut(session_id) {
                    let _ = slot.fsm.connect_failed(err.clone());
                    slot.backend = "error".into();
                }
                self.emit_state(app, session_id);
                return Err(format!("{}: {}", err.code.as_str(), err.message));
            }
        }

        self.emit_state(app, session_id);
        Ok(self.snapshot(Some(session_id)))
    }

    pub async fn send(
        self: std::sync::Arc<Self>,
        app: AppHandle,
        session_id: String,
        text: String,
    ) -> Result<(), String> {
        let needs_connect = {
            let guard = self.inner.lock();
            let slot = guard
                .sessions
                .get(&session_id)
                .ok_or_else(|| "session not found".to_string())?;
            slot.live.is_none()
        };
        if needs_connect {
            self.connect(&app, &session_id).await?;
        }

        {
            let mut guard = self.inner.lock();
            let slot = guard
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| "session not found".to_string())?;
            if slot.live.is_none() {
                return Err("session not connected after auto-connect".into());
            }
            slot.fsm.begin_stream().map_err(|e| e.to_string())?;
        }
        self.emit_state(&app, &session_id);

        let live = {
            let guard = self.inner.lock();
            let slot = guard
                .sessions
                .get(&session_id)
                .ok_or_else(|| "session not found".to_string())?;
            slot.live.clone()
        };

        let Some(live) = live else {
            return Err("session not connected".into());
        };

        let mgr = std::sync::Arc::clone(&self);
        tokio::spawn(async move {
            let result = live.prompt(PromptInput { text }).await;

            {
                let mut guard = mgr.inner.lock();
                if let Some(slot) = guard.sessions.get_mut(&session_id) {
                    match &result {
                        Ok(()) => {
                            let _ = slot.fsm.end_stream();
                        }
                        Err(e) => {
                            slot.fsm.disconnect(Some(e.clone()));
                        }
                    }
                    slot.meta.updated_at = Utc::now().to_rfc3339();
                }
            }

            mgr.emit_state(&app, &session_id);
            if let Err(error) = result {
                let _ = app.emit(
                    "session://error",
                    serde_json::json!({
                        "sessionId": session_id,
                        "code": error.code.as_str(),
                        "message": error.message,
                    }),
                );
            }
        });

        Ok(())
    }

    pub async fn stop(&self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        let live = {
            let guard = self.inner.lock();
            let slot = guard
                .sessions
                .get(session_id)
                .ok_or_else(|| "session not found".to_string())?;
            slot.live.clone()
        };
        if let Some(live) = live {
            live.cancel()
                .await
                .map_err(|e| format!("{}: {}", e.code.as_str(), e.message))?;
            let mut guard = self.inner.lock();
            if let Some(slot) = guard.sessions.get_mut(session_id) {
                if matches!(
                    slot.fsm.state(),
                    SessionState::Streaming | SessionState::AwaitingPermission
                ) {
                    let _ = slot.fsm.end_stream();
                }
            }
        }
        self.emit_state(app, session_id);
        Ok(())
    }

    pub async fn disconnect(&self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        let live = {
            let mut guard = self.inner.lock();
            let slot = guard
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "session not found".to_string())?;
            slot.live.take()
        };
        if let Some(live) = live {
            let _ = live.shutdown().await;
        }
        let mut guard = self.inner.lock();
        if let Some(slot) = guard.sessions.get_mut(session_id) {
            slot.fsm.disconnect(None);
            slot.backend = "none".into();
        }
        drop(guard);
        self.emit_state(app, session_id);
        Ok(())
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}
