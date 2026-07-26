//! Host session manager: owns FSM + live runtime sessions + event fan-out.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{HostEvent, StreamKind};
use crate::native_sessions::NativeSessionItem;
use crate::runtime::{self, ConnectOpts, LiveSession, PermissionMode, PromptInput, RuntimeId};
use crate::session_fsm::{SessionFsm, SessionState};
use crate::session_store::{self, StoredChatMessage, StoredSessionMeta};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub summary: Option<String>,
    pub runtime_id: RuntimeId,
    pub project_path: Option<String>,
    pub model_id: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub permission_mode: PermissionMode,
    pub native_session_id: Option<String>,
    pub native_thread_id: Option<String>,
    pub native_home: Option<String>,
    pub resume_supported: bool,
    pub last_resume_error: Option<String>,
    pub native_source: Option<String>,
    pub native_updated_at: Option<String>,
    pub native_history_imported_at: Option<String>,
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
    pub model_reasoning_effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub project_path: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettingsPatch {
    pub model_id: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
}

struct LiveSessionSlot {
    meta: SessionMeta,
    fsm: SessionFsm,
    backend: String,
    live: Option<std::sync::Arc<dyn LiveSession>>,
    mirror: StreamMirror,
    prompt_started_at: Option<String>,
    persisted: bool,
}

#[derive(Debug, Default)]
struct StreamMirror {
    assistant: String,
    thought: String,
}

pub struct SessionManager {
    inner: Mutex<Inner>,
}

struct Inner {
    sessions: HashMap<String, LiveSessionSlot>,
    active_id: Option<String>,
}

impl SessionMeta {
    fn from_stored(stored: StoredSessionMeta) -> Self {
        let (model_id, model_reasoning_effort) = normalize_codex_model_settings(
            stored.runtime_id,
            stored.model_id,
            stored.model_reasoning_effort,
        );
        Self {
            id: stored.id,
            title: stored.title,
            summary: stored.summary,
            runtime_id: stored.runtime_id,
            project_path: stored.project_path,
            model_id,
            model_reasoning_effort,
            permission_mode: stored
                .permission_mode
                .unwrap_or_else(|| PermissionMode::default_for_runtime(stored.runtime_id)),
            native_session_id: stored.native_session_id,
            native_thread_id: stored.native_thread_id,
            native_home: stored.native_home,
            resume_supported: stored.resume_supported,
            last_resume_error: stored.last_resume_error,
            native_source: stored.native_source,
            native_updated_at: stored.native_updated_at,
            native_history_imported_at: stored.native_history_imported_at,
            created_at: stored.created_at,
            updated_at: stored.updated_at,
        }
    }

    fn to_stored(&self) -> StoredSessionMeta {
        StoredSessionMeta {
            id: self.id.clone(),
            title: self.title.clone(),
            summary: self.summary.clone(),
            runtime_id: self.runtime_id,
            project_path: self.project_path.clone(),
            model_id: self.model_id.clone(),
            model_reasoning_effort: self.model_reasoning_effort.clone(),
            permission_mode: Some(self.permission_mode),
            native_session_id: self.native_session_id.clone(),
            native_thread_id: self.native_thread_id.clone(),
            native_home: self.native_home.clone(),
            resume_supported: self.resume_supported,
            last_resume_error: self.last_resume_error.clone(),
            native_source: self.native_source.clone(),
            native_updated_at: self.native_updated_at.clone(),
            native_history_imported_at: self.native_history_imported_at.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

impl SessionManager {
    pub fn new() -> Self {
        let mut sessions = HashMap::new();
        let stored_metas = session_store::load_metas().unwrap_or_else(|err| {
            tracing::warn!("failed to load session index: {err}");
            Vec::new()
        });
        for meta in stored_metas.into_iter().map(SessionMeta::from_stored) {
            sessions.insert(
                meta.id.clone(),
                LiveSessionSlot {
                    meta,
                    fsm: SessionFsm::new(),
                    backend: "none".into(),
                    live: None,
                    mirror: StreamMirror::default(),
                    prompt_started_at: None,
                    persisted: true,
                },
            );
        }
        let active_id = sessions
            .values()
            .max_by(|a, b| a.meta.updated_at.cmp(&b.meta.updated_at))
            .map(|slot| slot.meta.id.clone());

        Self {
            inner: Mutex::new(Inner {
                sessions,
                active_id,
            }),
        }
    }

    pub fn list(&self) -> Vec<SessionMeta> {
        let guard = self.inner.lock();
        let mut list: Vec<_> = guard
            .sessions
            .values()
            .filter(|slot| slot.persisted)
            .map(|slot| slot.meta.clone())
            .collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        list
    }

    pub fn upsert_native_sessions(&self, items: Vec<NativeSessionItem>) -> Vec<SessionMeta> {
        let mut guard = self.inner.lock();
        let mut out = Vec::new();

        for item in items {
            let existing_id = guard
                .sessions
                .values()
                .find(|slot| native_matches(&slot.meta, &item))
                .map(|slot| slot.meta.id.clone());

            let meta = if let Some(id) = existing_id {
                let slot = guard.sessions.get_mut(&id).expect("existing session id");
                slot.meta.title = item.title.clone();
                slot.meta.summary = item.summary.clone();
                slot.meta.project_path =
                    item.project_path.clone().or(slot.meta.project_path.clone());
                let (model_id, model_reasoning_effort) = normalize_codex_model_settings(
                    item.runtime_id,
                    item.model_id.clone().or(slot.meta.model_id.clone()),
                    slot.meta.model_reasoning_effort.clone(),
                );
                slot.meta.model_id = model_id;
                slot.meta.model_reasoning_effort = model_reasoning_effort;
                slot.meta.native_session_id = item
                    .native_session_id
                    .clone()
                    .or(slot.meta.native_session_id.clone());
                slot.meta.native_thread_id = item
                    .native_thread_id
                    .clone()
                    .or(slot.meta.native_thread_id.clone());
                slot.meta.native_home = item.native_home.clone().or(slot.meta.native_home.clone());
                slot.meta.native_source = Some(item.native_source.clone());
                slot.meta.native_updated_at = Some(item.updated_at.clone());
                slot.meta.updated_at = item.updated_at.clone();
                slot.meta.resume_supported = true;
                slot.meta.last_resume_error = None;
                slot.persisted = true;
                slot.meta.clone()
            } else {
                let id = Uuid::new_v4().to_string();
                let meta = SessionMeta {
                    id: id.clone(),
                    title: item.title.clone(),
                    summary: item.summary.clone(),
                    runtime_id: item.runtime_id,
                    project_path: item.project_path.clone(),
                    model_id: None,
                    model_reasoning_effort: None,
                    permission_mode: PermissionMode::default_for_runtime(item.runtime_id),
                    native_session_id: item.native_session_id.clone(),
                    native_thread_id: item.native_thread_id.clone(),
                    native_home: item.native_home.clone(),
                    resume_supported: true,
                    last_resume_error: None,
                    native_source: Some(item.native_source.clone()),
                    native_updated_at: Some(item.updated_at.clone()),
                    native_history_imported_at: None,
                    created_at: item.created_at.clone(),
                    updated_at: item.updated_at.clone(),
                };
                let (model_id, model_reasoning_effort) =
                    normalize_codex_model_settings(item.runtime_id, item.model_id.clone(), None);
                let meta = SessionMeta {
                    model_id,
                    model_reasoning_effort,
                    ..meta
                };
                guard.sessions.insert(
                    id.clone(),
                    LiveSessionSlot {
                        meta: meta.clone(),
                    fsm: SessionFsm::new(),
                    backend: "none".into(),
                    live: None,
                    mirror: StreamMirror::default(),
                    prompt_started_at: None,
                    persisted: true,
                },
            );
                meta
            };

            if let Err(err) = session_store::save_meta(&meta.to_stored()) {
                tracing::warn!("failed to save synced session meta {}: {err}", meta.id);
            }
            out.push(meta);
        }

        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
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
        let model_reasoning_effort = match runtime_id {
            RuntimeId::Codex => crate::route_diagnostics::codex_route_status()
                .model_reasoning_effort
                .or_else(|| Some("high".into())),
            _ => None,
        };

        let project_path =
            project_path.or_else(|| default_project_dir().ok().map(|p| p.display().to_string()));

        let meta = SessionMeta {
            id: id.clone(),
            title,
            summary: None,
            runtime_id,
            project_path,
            model_id,
            model_reasoning_effort,
            permission_mode: PermissionMode::default_for_runtime(runtime_id),
            native_session_id: None,
            native_thread_id: None,
            native_home: None,
            resume_supported: true,
            last_resume_error: None,
            native_source: None,
            native_updated_at: None,
            native_history_imported_at: None,
            created_at: now.clone(),
            updated_at: now,
        };

        let slot = LiveSessionSlot {
            meta: meta.clone(),
            fsm: SessionFsm::new(),
            backend: "none".into(),
            live: None,
            mirror: StreamMirror::default(),
            prompt_started_at: None,
            persisted: false,
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
                model_reasoning_effort: None,
                permission_mode: None,
                project_path: None,
                title: "Workbench".into(),
            };
        };

        match guard.sessions.get(&id) {
            Some(slot) => Self::snapshot_from_slot(slot),
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
                model_reasoning_effort: None,
                permission_mode: None,
                project_path: None,
                title: "missing".into(),
            },
        }
    }

    fn snapshot_from_slot(slot: &LiveSessionSlot) -> SessionSnapshot {
        SessionSnapshot {
            session_id: Some(slot.meta.id.clone()),
            runtime_id: Some(slot.meta.runtime_id),
            state: slot.fsm.state(),
            last_error: slot.fsm.last_error().cloned(),
            backend: slot.backend.clone(),
            model_id: slot.meta.model_id.clone(),
            model_reasoning_effort: slot.meta.model_reasoning_effort.clone(),
            permission_mode: Some(slot.meta.permission_mode),
            project_path: slot.meta.project_path.clone(),
            title: slot.meta.title.clone(),
        }
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<Option<String>, String> {
        let (live, next_active, removed_meta) = {
            let mut guard = self.inner.lock();
            let Some(slot) = guard.sessions.remove(session_id) else {
                return Err("session not found".to_string());
            };
            let next_active = if guard.active_id.as_deref() == Some(session_id) {
                guard
                    .sessions
                    .values()
                    .max_by(|a, b| a.meta.updated_at.cmp(&b.meta.updated_at))
                    .map(|slot| slot.meta.id.clone())
            } else {
                guard.active_id.clone()
            };
            guard.active_id = next_active.clone();
            (slot.live, next_active, slot.meta)
        };

        if let Some(live) = live {
            let _ = live.shutdown().await;
        }

        session_store::delete_session(session_id).map_err(|e| e.to_string())?;
        tracing::info!(
            "deleted session {} ({})",
            removed_meta.id,
            removed_meta.title
        );
        Ok(next_active)
    }

    fn emit_state(&self, app: &AppHandle, session_id: &str) {
        let snap = self.snapshot(Some(session_id));
        let _ = app.emit("session://state", &snap);
    }

    pub async fn update_settings(
        &self,
        app: &AppHandle,
        session_id: &str,
        patch: SessionSettingsPatch,
    ) -> Result<SessionMeta, String> {
        let live = {
            let mut guard = self.inner.lock();
            let slot = guard
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "session not found".to_string())?;

            if matches!(
                slot.fsm.state(),
                SessionState::Connecting
                    | SessionState::Streaming
                    | SessionState::AwaitingPermission
            ) {
                return Err("cannot change session settings while runtime is busy".into());
            }

            let next_model_id = patch
                .model_id
                .as_deref()
                .map(|model_id| normalize_model_id_for_runtime(slot.meta.runtime_id, model_id));
            let next_model_reasoning_effort =
                if let Some(model_reasoning_effort) = patch.model_reasoning_effort.as_deref() {
                    if slot.meta.runtime_id != RuntimeId::Codex {
                        return Err("model reasoning effort is only supported for Codex".into());
                    }
                    Some(
                        normalize_codex_reasoning_effort(model_reasoning_effort)?
                            .ok_or_else(|| "model reasoning effort cannot be empty".to_string())?,
                    )
                } else {
                    None
                };

            if let Some(model_id) = next_model_id {
                slot.meta.model_id = Some(model_id.clone());
                if patch.model_reasoning_effort.is_none()
                    && slot.meta.runtime_id == RuntimeId::Codex
                {
                    slot.meta.model_reasoning_effort = codex_reasoning_effort_from_model(&model_id)
                        .or_else(|| slot.meta.model_reasoning_effort.clone());
                }
            }

            if let Some(model_reasoning_effort) = next_model_reasoning_effort {
                slot.meta.model_reasoning_effort = Some(model_reasoning_effort);
            }

            if let Some(permission_mode) = patch.permission_mode {
                if slot.meta.runtime_id == RuntimeId::Grok
                    && permission_mode != PermissionMode::Auto
                {
                    return Err(
                        "Grok Ask/Read Only needs permission approval UI before it can be enabled"
                            .into(),
                    );
                }
                slot.meta.permission_mode = permission_mode;
            }

            slot.meta.updated_at = Utc::now().to_rfc3339();
            if slot.persisted {
                if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                    tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
                }
            }

            slot.live.take()
        };

        if let Some(live) = live {
            let _ = live.shutdown().await;
            let mut guard = self.inner.lock();
            if let Some(slot) = guard.sessions.get_mut(session_id) {
                slot.fsm.disconnect(None);
                slot.backend = "none".into();
                if slot.persisted {
                    if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                        tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
                    }
                }
            }
        }

        self.emit_state(app, session_id);

        let guard = self.inner.lock();
        guard
            .sessions
            .get(session_id)
            .map(|slot| slot.meta.clone())
            .ok_or_else(|| "session not found".to_string())
    }

    pub async fn connect(
        self: Arc<Self>,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<SessionSnapshot, String> {
        let (
            runtime_id,
            cwd,
            model_id,
            model_reasoning_effort,
            permission_mode,
            native_session_id,
            native_thread_id,
        ) = {
            let mut guard = self.inner.lock();
            let slot = guard
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "session not found".to_string())?;

            // Already connected or still connecting: return current snapshot without
            // re-entering the session mutex.
            if matches!(
                slot.fsm.state(),
                SessionState::Connecting
                    | SessionState::Ready
                    | SessionState::Streaming
                    | SessionState::AwaitingPermission
            ) {
                return Ok(Self::snapshot_from_slot(slot));
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
                .unwrap_or_else(|| default_project_dir().unwrap_or_else(|_| PathBuf::from(".")));
            (
                slot.meta.runtime_id,
                cwd,
                slot.meta.model_id.clone(),
                slot.meta.model_reasoning_effort.clone(),
                slot.meta.permission_mode,
                slot.meta.native_session_id.clone(),
                slot.meta.native_thread_id.clone(),
            )
        };

        self.emit_state(app, session_id);

        let runtime = runtime::get_runtime(runtime_id)
            .ok_or_else(|| format!("runtime {:?} not registered", runtime_id))?;
        let model_reasoning_effort = model_reasoning_effort.or_else(|| {
            if runtime_id == RuntimeId::Codex {
                crate::route_diagnostics::codex_route_status()
                    .model_reasoning_effort
                    .or_else(|| Some("high".into()))
            } else {
                None
            }
        });

        let (tx, mut rx) = mpsc::unbounded_channel::<HostEvent>();
        let opts = ConnectOpts {
            cwd,
            model_id,
            model_reasoning_effort,
            permission_mode,
            cli_path: None,
            native_session_id,
            native_thread_id,
        };

        let app_events = app.clone();
        let sid_events = session_id.to_string();
        let mgr_events = Arc::clone(&self);

        // Forward HostEvents to UI (stream/tool/error)
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                match &ev {
                    HostEvent::Stream { kind, text, done } => {
                        mgr_events.record_stream(&sid_events, *kind, text, *done);
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
                        mgr_events.record_tool(&sid_events, title, status);
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
                        if mgr_events.mark_awaiting_permission(&sid_events) {
                            mgr_events.emit_state(&app_events, &sid_events);
                        }
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
                        mgr_events.record_prompt_complete(&sid_events, stop_reason);
                        let _ = app_events.emit(
                            "session://prompt_complete",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "stopReason": stop_reason,
                            }),
                        );
                    }
                    HostEvent::Error { error } => {
                        mgr_events.record_error(&sid_events, error);
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
                let native_session_id = live.native_session_id();
                let native_thread_id = live.native_thread_id();
                let native_home = live.native_home();
                let live: std::sync::Arc<dyn LiveSession> = live.into();
                let mut guard = self.inner.lock();
                let slot = guard
                    .sessions
                    .get_mut(session_id)
                    .ok_or_else(|| "session not found".to_string())?;
                slot.fsm.handshake_ok().map_err(|e| e.to_string())?;
                slot.backend = backend;
                slot.live = Some(live);
                slot.meta.native_session_id = native_session_id;
                slot.meta.native_thread_id = native_thread_id;
                slot.meta.native_home = native_home;
                slot.meta.resume_supported = true;
                slot.meta.last_resume_error = None;
                slot.meta.updated_at = Utc::now().to_rfc3339();
                slot.persisted = true;
                if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                    tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
                }
            }
            Err(err) => {
                let mut guard = self.inner.lock();
                if let Some(slot) = guard.sessions.get_mut(session_id) {
                    let _ = slot.fsm.connect_failed(err.clone());
                    slot.backend = "error".into();
                    slot.meta.last_resume_error = Some(err.message.clone());
                    slot.meta.updated_at = Utc::now().to_rfc3339();
                    if slot.persisted {
                        if let Err(save_err) = session_store::save_meta(&slot.meta.to_stored()) {
                            tracing::warn!(
                                "failed to save session meta {}: {save_err}",
                                slot.meta.id
                            );
                        }
                    }
                }
                self.emit_state(app, session_id);
                return Err(format!("{}: {}", err.code.as_str(), err.message));
            }
        }

        self.emit_state(app, session_id);
        Ok(self.snapshot(Some(session_id)))
    }

    fn mark_awaiting_permission(&self, session_id: &str) -> bool {
        let mut guard = self.inner.lock();
        let Some(slot) = guard.sessions.get_mut(session_id) else {
            return false;
        };

        if slot.fsm.await_permission().is_err() {
            return false;
        }

        slot.meta.updated_at = Utc::now().to_rfc3339();
        if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
            tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
        }
        true
    }

    fn record_stream(&self, session_id: &str, kind: StreamKind, text: &str, done: bool) {
        let mut guard = self.inner.lock();
        let Some(slot) = guard.sessions.get_mut(session_id) else {
            return;
        };
        let buffer = match kind {
            StreamKind::Assistant => &mut slot.mirror.assistant,
            StreamKind::Thought => &mut slot.mirror.thought,
        };
        if !text.is_empty() {
            buffer.push_str(text);
        }
        if done {
            tracing::debug!(
                "session {session_id} stream completed; awaiting prompt_complete to persist final {}",
                match kind {
                    StreamKind::Assistant => "assistant",
                    StreamKind::Thought => "thought",
                }
            );
        }
    }

    fn record_tool(&self, session_id: &str, title: &str, status: &str) {
        let runtime_id = self.runtime_id_for_session(session_id);
        let message = StoredChatMessage::new("tool", format!("{title} · {status}"), runtime_id);
        self.append_message(session_id, &message);
    }

    fn record_prompt_complete(&self, session_id: &str, _stop_reason: &str) {
        let messages = {
            let mut guard = self.inner.lock();
            let Some(slot) = guard.sessions.get_mut(session_id) else {
                return;
            };
            let started_at = slot
                .prompt_started_at
                .clone()
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let completed_at = Utc::now().to_rfc3339();
            let mut messages = Vec::new();
            if !slot.mirror.thought.trim().is_empty() {
                messages.push(StoredChatMessage::completed(
                    "thought",
                    std::mem::take(&mut slot.mirror.thought),
                    Some(slot.meta.runtime_id),
                    started_at.clone(),
                    completed_at.clone(),
                ));
            }
            if !slot.mirror.assistant.trim().is_empty() {
                messages.push(StoredChatMessage::completed(
                    "assistant",
                    std::mem::take(&mut slot.mirror.assistant),
                    Some(slot.meta.runtime_id),
                    started_at,
                    completed_at,
                ));
            }
            slot.prompt_started_at = None;
            messages
        };
        for message in messages {
            self.append_message(session_id, &message);
        }
    }

    fn record_error(&self, session_id: &str, error: &AgentError) {
        self.record_prompt_complete(session_id, "error");
        let runtime_id = self.runtime_id_for_session(session_id);
        let message = StoredChatMessage::new(
            "system",
            format!("error {}: {}", error.code.as_str(), error.message),
            runtime_id,
        );
        self.append_message(session_id, &message);
    }

    fn runtime_id_for_session(&self, session_id: &str) -> Option<RuntimeId> {
        let guard = self.inner.lock();
        guard
            .sessions
            .get(session_id)
            .map(|slot| slot.meta.runtime_id)
    }

    fn append_message(&self, session_id: &str, message: &StoredChatMessage) {
        if let Err(err) = session_store::append_message(session_id, message) {
            tracing::warn!("failed to append session message {session_id}: {err}");
        }
    }

    pub async fn messages(&self, session_id: &str) -> Result<Vec<StoredChatMessage>, String> {
        let import_thread_id = {
            let guard = self.inner.lock();
            let slot = guard
                .sessions
                .get(session_id)
                .ok_or_else(|| "session not found".to_string())?;
            let messages = session_store::load_messages(session_id).map_err(|e| e.to_string())?;
            if !messages.is_empty()
                || slot.meta.runtime_id != RuntimeId::Codex
                || slot.meta.native_history_imported_at.is_some()
            {
                return Ok(messages);
            }
            slot.meta.native_thread_id.clone()
        };

        let Some(thread_id) = import_thread_id else {
            return session_store::load_messages(session_id).map_err(|e| e.to_string());
        };

        let imported = crate::native_sessions::load_codex_thread_messages(&thread_id).await?;
        if let Err(err) = session_store::append_messages(session_id, &imported) {
            return Err(err.to_string());
        }

        {
            let mut guard = self.inner.lock();
            if let Some(slot) = guard.sessions.get_mut(session_id) {
                slot.meta.native_history_imported_at = Some(Utc::now().to_rfc3339());
                if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                    tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
                }
            }
        }

        session_store::load_messages(session_id).map_err(|e| e.to_string())
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
            Arc::clone(&self).connect(&app, &session_id).await?;
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
            slot.prompt_started_at = Some(Utc::now().to_rfc3339());
        }
        let runtime_id = self.runtime_id_for_session(&session_id);
        self.append_message(
            &session_id,
            &StoredChatMessage::new("user", text.clone(), runtime_id),
        );
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
            if result.is_err() {
                let _ = live.shutdown().await;
            }

            {
                let mut guard = mgr.inner.lock();
                if let Some(slot) = guard.sessions.get_mut(&session_id) {
                    match &result {
                        Ok(()) => {
                            let _ = slot.fsm.end_stream();
                        }
                        Err(e) => {
                            slot.fsm.disconnect(Some(e.clone()));
                            slot.live = None;
                            slot.backend = "error".into();
                        }
                    }
                    slot.meta.updated_at = Utc::now().to_rfc3339();
                    if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                        tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
                    }
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
                slot.meta.updated_at = Utc::now().to_rfc3339();
                if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                    tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
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
            slot.meta.updated_at = Utc::now().to_rfc3339();
            if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
            }
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

fn normalize_codex_model_settings(
    runtime_id: RuntimeId,
    model_id: Option<String>,
    model_reasoning_effort: Option<String>,
) -> (Option<String>, Option<String>) {
    let model_id = model_id.map(|value| normalize_model_id_for_runtime(runtime_id, &value));
    let model_reasoning_effort = match runtime_id {
        RuntimeId::Codex => model_reasoning_effort
            .and_then(|value| normalize_codex_reasoning_effort(&value).ok().flatten())
            .or_else(|| {
                model_id
                    .as_deref()
                    .and_then(codex_reasoning_effort_from_model)
            }),
        _ => model_reasoning_effort,
    };
    (model_id, model_reasoning_effort)
}

fn normalize_model_id_for_runtime(runtime_id: RuntimeId, model_id: &str) -> String {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return "default".into();
    }

    if runtime_id == RuntimeId::Codex {
        let parts: Vec<&str> = trimmed.split('-').collect();
        if parts.len() == 3 && parts[0].eq_ignore_ascii_case("gpt") {
            let suffix = parts[2].to_ascii_lowercase();
            if matches!(suffix.as_str(), "low" | "medium" | "high") {
                return format!("{}-{}", parts[0], parts[1]);
            }
        }
    }

    trimmed.chars().take(120).collect()
}

fn codex_reasoning_effort_from_model(model: &str) -> Option<String> {
    let trimmed = model.trim();
    let parts: Vec<&str> = trimmed.split('-').collect();
    if parts.len() != 3 || !parts[0].eq_ignore_ascii_case("gpt") {
        return None;
    }
    match parts[2].to_ascii_lowercase().as_str() {
        "low" | "medium" | "high" => Some(parts[2].to_ascii_lowercase()),
        _ => None,
    }
}

fn normalize_codex_reasoning_effort(value: &str) -> Result<Option<String>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "low" | "medium" | "high" => Ok(Some(trimmed.to_ascii_lowercase())),
        other => Err(format!(
            "invalid Codex reasoning effort: {other} (expected low, medium, or high)"
        )),
    }
}

fn native_matches(meta: &SessionMeta, item: &NativeSessionItem) -> bool {
    if meta.runtime_id != item.runtime_id {
        return false;
    }
    if let (Some(a), Some(b)) = (&meta.native_thread_id, &item.native_thread_id) {
        if a == b {
            return true;
        }
    }
    if let (Some(a), Some(b)) = (&meta.native_session_id, &item.native_session_id) {
        if a == b {
            return true;
        }
    }
    false
}

fn default_project_dir() -> std::io::Result<PathBuf> {
    let cwd = std::env::current_dir()?;
    Ok(workspace_root_from_dir(&cwd).unwrap_or(cwd))
}

fn workspace_root_from_dir(dir: &Path) -> Option<PathBuf> {
    if dir.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        let parent = dir.parent()?;
        if parent.join("package.json").is_file() && parent.join("src-tauri").is_dir() {
            return Some(parent.to_path_buf());
        }
    }

    if dir.join("package.json").is_file() && dir.join("src-tauri").is_dir() {
        return Some(dir.to_path_buf());
    }

    None
}
