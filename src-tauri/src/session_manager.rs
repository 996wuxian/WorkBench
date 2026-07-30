//! Host session manager: owns FSM + live runtime sessions + event fan-out.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{HostEvent, StreamKind};
use crate::host::permissions::{PermissionBroker, PermissionDecision};
use crate::native_sessions::NativeSessionItem;
use crate::runtime::{
    self, ConnectOpts, LiveSession, NativeSessionSource, PermissionMode, PromptInput, RuntimeId,
    SessionSettings,
};
use crate::session_fsm::{SessionFsm, SessionState};
use crate::session_store::{self, StoredChatMessage, StoredSessionMeta, StoredTraceEvent};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    #[serde(skip)]
    title_is_custom: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
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
    pub prompt_started_at: Option<String>,
    pub last_error: Option<AgentError>,
    pub backend: String,
    pub model_id: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub project_path: Option<String>,
    pub title: String,
}

/// Re-exported so callers keep a single import path for session settings.
pub use crate::runtime::SessionSettingsPatch;

struct LiveSessionSlot {
    meta: SessionMeta,
    fsm: SessionFsm,
    backend: String,
    live: Option<std::sync::Arc<dyn LiveSession>>,
    /// Approval gate for the current connection. Dropped on disconnect so a
    /// stale broker can never answer for a new process.
    permissions: Option<PermissionBroker>,
    mirror: StreamMirror,
    prompt_started_at: Option<String>,
    prompt_paused_ms: u64,
    permission_pause_started_at: Option<DateTime<Utc>>,
    pending_permission_count: usize,
    persisted: bool,
}

impl LiveSessionSlot {
    fn disconnect_after_process_exit(&mut self, code: Option<i32>) {
        if let Some(broker) = self.permissions.take() {
            broker.abort_all();
        }
        self.live = None;
        self.backend = "error".into();
        self.fsm.disconnect(Some(process_exit_error(code)));
        self.meta.updated_at = Utc::now().to_rfc3339();
    }

    fn start_permission_pause(&mut self, now: DateTime<Utc>) {
        if self.pending_permission_count == 0 {
            self.permission_pause_started_at = Some(now);
        }
        self.pending_permission_count = self.pending_permission_count.saturating_add(1);
    }

    fn finish_permission_pause(&mut self, now: DateTime<Utc>) {
        if self.pending_permission_count == 0 {
            return;
        }

        self.pending_permission_count -= 1;
        if self.pending_permission_count == 0 {
            self.commit_active_permission_pause(now);
        }
    }

    fn reset_prompt_timing(&mut self, started_at: DateTime<Utc>) {
        self.prompt_started_at = Some(started_at.to_rfc3339());
        self.prompt_paused_ms = 0;
        self.permission_pause_started_at = None;
        self.pending_permission_count = 0;
    }

    fn elapsed_paused_ms_through(&self, now: DateTime<Utc>) -> u64 {
        let active_pause_ms = self
            .permission_pause_started_at
            .map(|started_at| positive_duration_ms(now - started_at))
            .unwrap_or(0);
        self.prompt_paused_ms.saturating_add(active_pause_ms)
    }

    fn close_prompt_timing(&mut self, completed_at: DateTime<Utc>) -> u64 {
        self.commit_active_permission_pause(completed_at);
        self.permission_pause_started_at = None;
        self.pending_permission_count = 0;
        self.prompt_started_at = None;
        self.prompt_paused_ms
    }

    fn commit_active_permission_pause(&mut self, now: DateTime<Utc>) {
        if let Some(started_at) = self.permission_pause_started_at.take() {
            self.prompt_paused_ms = self
                .prompt_paused_ms
                .saturating_add(positive_duration_ms(now - started_at));
        }
    }
}

#[derive(Debug, Default)]
struct StreamMirror {
    assistant: StreamBuffer,
    thought: StreamBuffer,
}

/// Smallest amount of new text worth a checkpoint. Below this the write costs
/// more than the tail it protects.
const MIN_CHECKPOINT_BYTES: usize = 4096;

/// One in-flight stream (assistant text or reasoning) of the current turn.
#[derive(Debug, Default)]
struct StreamBuffer {
    /// Journal id shared by this turn's checkpoints and its final record, so
    /// replay collapses them into a single message. Allocated on first write.
    id: Option<String>,
    text: String,
    /// How much of `text` the last checkpoint already covers.
    checkpointed: usize,
    /// Prevent duplicate completion records when an adapter emits more than one
    /// terminal stream frame.
    trace_completed: bool,
}

impl StreamBuffer {
    /// A checkpoint rewrites the whole buffer, so the interval grows with it:
    /// a long answer costs O(log n) writes instead of O(n). The trade is that a
    /// crash can lose up to a quarter of the tail — still far better than
    /// losing the entire turn, which is what an unbuffered journal did.
    fn checkpoint_due(&self) -> bool {
        let grown = self.text.len().saturating_sub(self.checkpointed);
        grown >= MIN_CHECKPOINT_BYTES.max(self.checkpointed / 4)
    }

    /// Take the accumulated turn, leaving the buffer ready for the next one.
    fn take(&mut self) -> (Option<String>, String, bool) {
        self.checkpointed = 0;
        let trace_completed = std::mem::take(&mut self.trace_completed);
        (
            self.id.take(),
            std::mem::take(&mut self.text),
            trace_completed,
        )
    }
}

fn stream_role(kind: StreamKind) -> &'static str {
    match kind {
        StreamKind::Assistant => "assistant",
        StreamKind::Thought => "thought",
    }
}

fn positive_duration_ms(duration: chrono::Duration) -> u64 {
    duration.num_milliseconds().max(0) as u64
}

fn elapsed_ms_since(started_at: &str, now: DateTime<Utc>) -> u64 {
    DateTime::parse_from_rfc3339(started_at)
        .map(|started_at| positive_duration_ms(now - started_at.with_timezone(&Utc)))
        .unwrap_or(0)
}

fn prompt_trace_details(text: &str) -> serde_json::Value {
    serde_json::json!({
        "textChars": text.chars().count(),
        "textBytes": text.len(),
    })
}

fn error_trace_details(error: &AgentError) -> serde_json::Value {
    serde_json::json!({
        "errorCode": error.code.as_str(),
        "messageChars": error.message.chars().count(),
    })
}

fn first_delta_trace_details(kind: StreamKind, text: &str, elapsed_ms: u64) -> serde_json::Value {
    serde_json::json!({
        "kind": stream_role(kind),
        "chunkBytes": text.len(),
        "elapsedMs": elapsed_ms,
    })
}

fn tool_trace_details(name: &str, status: &str, _private_title: &str) -> serde_json::Value {
    serde_json::json!({
        "toolName": name,
        "status": status,
    })
}

fn permission_request_trace_details(
    tool_name: &str,
    _private_title: &str,
    _private_preview: &str,
    auto_allowed: bool,
) -> serde_json::Value {
    serde_json::json!({
        "toolName": tool_name,
        "autoAllowed": auto_allowed,
    })
}

fn session_settings_trace_details(patch: &SessionSettingsPatch) -> serde_json::Value {
    let mut details = serde_json::Map::new();
    let mut changed_fields = Vec::new();
    if let Some(model_id) = patch.model_id.as_deref() {
        changed_fields.push("modelId");
        details.insert("modelId".into(), model_id.into());
    }
    if let Some(reasoning_effort) = patch.model_reasoning_effort.as_deref() {
        changed_fields.push("modelReasoningEffort");
        details.insert("modelReasoningEffort".into(), reasoning_effort.into());
    }
    if let Some(permission_mode) = patch.permission_mode {
        changed_fields.push("permissionMode");
        details.insert("permissionMode".into(), permission_mode.as_str().into());
    }
    details.insert("changedFields".into(), serde_json::json!(changed_fields));
    serde_json::Value::Object(details)
}

fn sort_session_metas(metas: &mut [SessionMeta]) {
    metas.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
}

fn validate_session_title(title: String) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("session title cannot be empty".to_string());
    }
    if title.chars().count() > 120 {
        return Err("session title cannot exceed 120 characters".to_string());
    }
    Ok(title.to_string())
}

pub struct SessionManager {
    inner: Mutex<Inner>,
}

struct Inner {
    sessions: HashMap<String, LiveSessionSlot>,
    active_id: Option<String>,
}

enum NativeHistoryImport {
    AcpSummary {
        runtime_id: RuntimeId,
        native_session_id: String,
    },
    CodexThread(String),
}

impl SessionMeta {
    fn from_stored(stored: StoredSessionMeta) -> Self {
        let (model_id, model_reasoning_effort) = normalize_stored_settings(
            stored.runtime_id,
            stored.model_id,
            stored.model_reasoning_effort,
        );
        Self {
            id: stored.id,
            title: stored.title,
            title_is_custom: stored.title_is_custom,
            pinned: stored.pinned,
            archived: stored.archived,
            summary: stored.summary,
            runtime_id: stored.runtime_id,
            project_path: stored.project_path,
            model_id,
            model_reasoning_effort,
            permission_mode: stored
                .permission_mode
                .unwrap_or_else(|| default_permission_mode(stored.runtime_id)),
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
            title_is_custom: self.title_is_custom,
            pinned: self.pinned,
            archived: self.archived,
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
                    permissions: None,
                    mirror: StreamMirror::default(),
                    prompt_started_at: None,
                    prompt_paused_ms: 0,
                    permission_pause_started_at: None,
                    pending_permission_count: 0,
                    persisted: true,
                },
            );
        }
        let active_id = sessions
            .values()
            .filter(|slot| !slot.meta.archived)
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
        sort_session_metas(&mut list);
        list
    }

    pub fn snapshots(&self) -> Vec<SessionSnapshot> {
        let guard = self.inner.lock();
        guard
            .sessions
            .values()
            .filter(|slot| slot.persisted)
            .map(Self::snapshot_from_slot)
            .collect()
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
                if !slot.meta.title_is_custom {
                    slot.meta.title = item.title.clone();
                }
                slot.meta.summary = item.summary.clone();
                slot.meta.project_path =
                    item.project_path.clone().or(slot.meta.project_path.clone());
                let (model_id, model_reasoning_effort) = normalize_stored_settings(
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
                    title_is_custom: false,
                    pinned: false,
                    archived: false,
                    summary: item.summary.clone(),
                    runtime_id: item.runtime_id,
                    project_path: item.project_path.clone(),
                    model_id: None,
                    model_reasoning_effort: None,
                    permission_mode: default_permission_mode(item.runtime_id),
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
                    normalize_stored_settings(item.runtime_id, item.model_id.clone(), None);
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
                        permissions: None,
                        mirror: StreamMirror::default(),
                        prompt_started_at: None,
                        prompt_paused_ms: 0,
                        permission_pause_started_at: None,
                        pending_permission_count: 0,
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

        sort_session_metas(&mut out);
        out
    }

    pub fn create(
        &self,
        runtime_id: RuntimeId,
        project_path: Option<String>,
    ) -> Result<SessionMeta, String> {
        let runtime = runtime::get_enabled_runtime(runtime_id)?;
        let defaults = runtime.default_settings();

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let title = format!("{} · 新会话", runtime.display_name());

        let project_path = match project_path {
            Some(path) => Some(validate_project_dir(&path)?),
            None => None,
        };

        let meta = SessionMeta {
            id: id.clone(),
            title,
            title_is_custom: false,
            pinned: false,
            archived: false,
            summary: None,
            runtime_id,
            project_path,
            model_id: defaults.model_id,
            model_reasoning_effort: defaults.model_reasoning_effort,
            permission_mode: defaults
                .permission_mode
                .unwrap_or_else(|| default_permission_mode(runtime_id)),
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
            permissions: None,
            mirror: StreamMirror::default(),
            prompt_started_at: None,
            prompt_paused_ms: 0,
            permission_pause_started_at: None,
            pending_permission_count: 0,
            persisted: false,
        };

        let mut guard = self.inner.lock();
        guard.sessions.insert(id.clone(), slot);
        guard.active_id = Some(id);
        Ok(meta)
    }

    pub fn update_presentation(
        &self,
        session_id: &str,
        title: Option<String>,
        pinned: Option<bool>,
    ) -> Result<SessionMeta, String> {
        let title = title.map(validate_session_title).transpose()?;
        if title.is_none() && pinned.is_none() {
            return Err("no session presentation changes supplied".to_string());
        }

        let mut guard = self.inner.lock();
        let slot = guard
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "session not found".to_string())?;
        let mut next = slot.meta.clone();
        if let Some(title) = title {
            next.title = title;
            next.title_is_custom = true;
        }
        if let Some(pinned) = pinned {
            next.pinned = pinned;
        }

        if slot.persisted {
            session_store::save_meta(&next.to_stored()).map_err(|err| err.to_string())?;
        }
        slot.meta = next.clone();
        Ok(next)
    }

    pub fn update_project_path(
        &self,
        session_id: &str,
        project_path: String,
    ) -> Result<SessionMeta, String> {
        let project_path = validate_project_dir(&project_path)?;

        let mut guard = self.inner.lock();
        let slot = guard
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "session not found".to_string())?;
        if slot.persisted || slot.live.is_some() {
            return Err("工作目录只能在首次发送前修改".into());
        }
        if !matches!(slot.fsm.state(), SessionState::Idle | SessionState::Disconnected) {
            return Err("当前会话状态不能修改工作目录".into());
        }

        slot.meta.project_path = Some(project_path);
        Ok(slot.meta.clone())
    }

    pub fn session_meta(&self, session_id: &str) -> Result<SessionMeta, String> {
        let guard = self.inner.lock();
        guard
            .sessions
            .get(session_id)
            .map(|slot| slot.meta.clone())
            .ok_or_else(|| "session not found".to_string())
    }

    pub async fn set_archived(
        &self,
        app: &AppHandle,
        session_id: &str,
        archived: bool,
    ) -> Result<SessionMeta, String> {
        let (live, next_meta) = {
            let mut guard = self.inner.lock();
            let was_active = guard.active_id.as_deref() == Some(session_id);
            let (live, next_meta) = {
                let slot = guard
                    .sessions
                    .get_mut(session_id)
                    .ok_or_else(|| "session not found".to_string())?;
                if archived
                    && matches!(
                        slot.fsm.state(),
                        SessionState::Connecting
                            | SessionState::Streaming
                            | SessionState::AwaitingPermission
                    )
                {
                    return Err("cannot archive a session while the runtime is busy".to_string());
                }

                let mut next = slot.meta.clone();
                next.archived = archived;
                if slot.persisted {
                    session_store::save_meta(&next.to_stored()).map_err(|err| err.to_string())?;
                }
                slot.meta = next.clone();

                let live = if archived {
                    if let Some(broker) = slot.permissions.take() {
                        broker.abort_all();
                    }
                    slot.fsm.disconnect(None);
                    slot.backend = "none".into();
                    slot.prompt_started_at = None;
                    slot.live.take()
                } else {
                    None
                };
                (live, next)
            };

            if archived && was_active {
                guard.active_id = guard
                    .sessions
                    .values()
                    .filter(|slot| slot.persisted && !slot.meta.archived)
                    .max_by(|a, b| a.meta.updated_at.cmp(&b.meta.updated_at))
                    .map(|slot| slot.meta.id.clone());
            }
            (live, next_meta)
        };

        if let Some(live) = live {
            let _ = live.shutdown().await;
        }
        self.record_trace(
            session_id,
            if archived {
                "session_archived"
            } else {
                "session_restored"
            },
            serde_json::json!({}),
        );
        self.emit_state(app, session_id);
        Ok(next_meta)
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
                prompt_started_at: None,
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
                prompt_started_at: None,
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
            prompt_started_at: slot.prompt_started_at.clone(),
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
                    .filter(|slot| !slot.meta.archived)
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
        let trace_details = session_settings_trace_details(&patch);
        let live = {
            let mut guard = self.inner.lock();
            let slot = guard
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "session not found".to_string())?;

            if slot.meta.archived {
                return Err("restore the archived session before changing settings".into());
            }

            if matches!(
                slot.fsm.state(),
                SessionState::Connecting
                    | SessionState::Streaming
                    | SessionState::AwaitingPermission
            ) {
                return Err("cannot change session settings while runtime is busy".into());
            }

            // Validation lives in the adapter: model aliases, reasoning effort and
            // unsupported permission modes are runtime-specific knowledge.
            let runtime = runtime::get_enabled_runtime(slot.meta.runtime_id)?;
            let current = SessionSettings {
                model_id: slot.meta.model_id.clone(),
                model_reasoning_effort: slot.meta.model_reasoning_effort.clone(),
                permission_mode: Some(slot.meta.permission_mode),
            };
            let next = runtime.normalize_settings(&current, &patch)?;

            slot.meta.model_id = next.model_id;
            slot.meta.model_reasoning_effort = next.model_reasoning_effort;
            if let Some(permission_mode) = next.permission_mode {
                slot.meta.permission_mode = permission_mode;
                // A live broker must follow the session's mode, otherwise a
                // switch to Ask would keep auto-approving until reconnect.
                if let Some(broker) = &slot.permissions {
                    broker.set_mode(permission_mode);
                }
            }

            slot.meta.updated_at = Utc::now().to_rfc3339();
            if slot.persisted {
                if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                    tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
                }
            }

            if let Some(broker) = slot.permissions.take() {
                broker.abort_all();
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
        self.record_trace(session_id, "session_settings_changed", trace_details);

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
        // Resolve the runtime before moving the FSM into `Connecting`. A stored
        // session can outlive a runtime being disabled in settings; returning
        // after the transition would otherwise leave the session permanently
        // stuck in `Connecting`.
        let runtime_id = {
            let guard = self.inner.lock();
            let slot = guard
                .sessions
                .get(session_id)
                .ok_or_else(|| "session not found".to_string())?;
            if slot.meta.archived {
                return Err("restore the archived session before connecting".to_string());
            }
            if matches!(
                slot.fsm.state(),
                SessionState::Connecting
                    | SessionState::Ready
                    | SessionState::Streaming
                    | SessionState::AwaitingPermission
            ) {
                return Ok(Self::snapshot_from_slot(slot));
            }
            slot.meta.runtime_id
        };
        let runtime = match runtime::get_enabled_runtime(runtime_id) {
            Ok(runtime) => runtime,
            Err(error) => {
                self.record_trace(
                    session_id,
                    "connection_failed",
                    serde_json::json!({
                        "runtimeId": runtime_id.as_str(),
                        "errorCode": "RUNTIME_UNAVAILABLE",
                        "messageChars": error.chars().count(),
                    }),
                );
                return Err(error);
            }
        };

        let (
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

            // Another caller may have connected while runtime availability was
            // being resolved outside the lock.
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

            let cwd = match slot.meta.project_path.clone() {
                Some(path) => PathBuf::from(path),
                None => {
                    let path = default_project_dir().map_err(|error| error.to_string())?;
                    slot.meta.project_path = Some(path.display().to_string());
                    path
                }
            };
            slot.fsm.start_connect().map_err(|e| e.to_string())?;
            (
                cwd,
                slot.meta.model_id.clone(),
                slot.meta.model_reasoning_effort.clone(),
                slot.meta.permission_mode,
                slot.meta.native_session_id.clone(),
                slot.meta.native_thread_id.clone(),
            )
        };

        let connect_started_at = Utc::now();
        self.record_trace(
            session_id,
            "connection_started",
            serde_json::json!({
                "runtimeId": runtime_id.as_str(),
                "resuming": native_session_id.is_some() || native_thread_id.is_some(),
            }),
        );

        self.emit_state(app, session_id);

        // Legacy sessions may predate a runtime's defaults; fill the gap from the
        // adapter rather than special-casing a runtime id here.
        let model_reasoning_effort =
            model_reasoning_effort.or_else(|| runtime.default_settings().model_reasoning_effort);

        let (tx, mut rx) = mpsc::unbounded_channel::<HostEvent>();
        let permissions = PermissionBroker::new(session_id, permission_mode, tx.clone());
        {
            let mut guard = self.inner.lock();
            if let Some(slot) = guard.sessions.get_mut(session_id) {
                slot.permissions = Some(permissions.clone());
            }
        }
        let opts = ConnectOpts {
            cwd,
            model_id,
            model_reasoning_effort,
            permission_mode,
            cli_path: None,
            claude_permission_bridge_script_path: resolve_claude_permission_bridge_script_path(app),
            native_session_id,
            native_thread_id,
            permissions,
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
                        mgr_events.record_tool(&sid_events, id, name, title, status);
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
                        request_id,
                        tool_name,
                        title,
                        preview,
                        auto_allowed,
                    } => {
                        mgr_events.record_trace(
                            &sid_events,
                            "permission_requested",
                            permission_request_trace_details(
                                tool_name,
                                title,
                                preview,
                                *auto_allowed,
                            ),
                        );
                        // Auto-allowed requests are surfaced for the transcript but
                        // must not park the FSM: nobody is going to answer them.
                        if !auto_allowed && mgr_events.mark_awaiting_permission(&sid_events) {
                            mgr_events.emit_state(&app_events, &sid_events);
                        }
                        let _ = app_events.emit(
                            "session://permission",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "requestId": request_id,
                                "toolName": tool_name,
                                "title": title,
                                "preview": preview,
                                "autoAllowed": auto_allowed,
                            }),
                        );
                    }
                    HostEvent::PermissionResolved {
                        request_id,
                        decision,
                        source,
                    } => {
                        mgr_events.record_trace(
                            &sid_events,
                            "permission_resolved",
                            serde_json::json!({
                                "decision": decision.as_str(),
                                "source": source,
                            }),
                        );
                        if mgr_events.mark_permission_resolved(&sid_events) {
                            mgr_events.emit_state(&app_events, &sid_events);
                        }
                        let _ = app_events.emit(
                            "session://permission_resolved",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "requestId": request_id,
                                "decision": decision.as_str(),
                                "source": serde_json::to_value(source).unwrap_or_default(),
                            }),
                        );
                    }
                    HostEvent::PromptComplete { stop_reason } => {
                        mgr_events.record_prompt_complete(&sid_events, stop_reason);
                        let settled_meta = mgr_events.settle_successful_turn(&sid_events);
                        let _ = app_events.emit(
                            "session://prompt_complete",
                            serde_json::json!({
                                "sessionId": sid_events,
                                "stopReason": stop_reason,
                            }),
                        );
                        if let Some(meta) = settled_meta {
                            mgr_events.emit_state(&app_events, &sid_events);
                            let _ = app_events.emit(
                                "session://turn_settled",
                                serde_json::json!({
                                    "sessionId": sid_events,
                                    "stopReason": stop_reason,
                                    "meta": meta,
                                }),
                            );
                        }
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
                        if mgr_events.mark_process_exited(&sid_events, *code) {
                            mgr_events.emit_state(&app_events, &sid_events);
                            let _ = app_events.emit(
                                "session://exited",
                                serde_json::json!({
                                    "sessionId": sid_events,
                                    "code": code,
                                }),
                            );
                        }
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
                let trace_backend = backend.clone();
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
                drop(guard);
                self.record_trace(
                    session_id,
                    "connection_succeeded",
                    serde_json::json!({
                        "runtimeId": runtime_id.as_str(),
                        "backend": trace_backend,
                        "elapsedMs": positive_duration_ms(Utc::now() - connect_started_at),
                    }),
                );
            }
            Err(err) => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(slot) = guard.sessions.get_mut(session_id) {
                        let _ = slot.fsm.connect_failed(err.clone());
                        slot.backend = "error".into();
                        slot.meta.last_resume_error = Some(err.message.clone());
                        slot.meta.updated_at = Utc::now().to_rfc3339();
                        if slot.persisted {
                            if let Err(save_err) = session_store::save_meta(&slot.meta.to_stored())
                            {
                                tracing::warn!(
                                    "failed to save session meta {}: {save_err}",
                                    slot.meta.id
                                );
                            }
                        }
                    }
                }
                let mut details = error_trace_details(&err);
                if let Some(details) = details.as_object_mut() {
                    details.insert("runtimeId".into(), runtime_id.as_str().into());
                    details.insert(
                        "elapsedMs".into(),
                        positive_duration_ms(Utc::now() - connect_started_at).into(),
                    );
                }
                self.record_trace(session_id, "connection_failed", details);
                self.emit_state(app, session_id);
                return Err(format!("{}: {}", err.code.as_str(), err.message));
            }
        }

        self.emit_state(app, session_id);
        Ok(self.snapshot(Some(session_id)))
    }

    /// The turn continues after an approval was answered. Returns true when the
    /// FSM actually moved, so we only emit a state event on a real change.
    fn mark_permission_resolved(&self, session_id: &str) -> bool {
        let mut guard = self.inner.lock();
        let Some(slot) = guard.sessions.get_mut(session_id) else {
            return false;
        };
        slot.finish_permission_pause(Utc::now());
        if slot.fsm.state() != SessionState::AwaitingPermission || slot.pending_permission_count > 0
        {
            return false;
        }
        slot.fsm.resume_stream().is_ok()
    }

    /// Answer a pending approval. The broker resolves exactly once, so a late or
    /// duplicate click is reported as an error rather than silently ignored.
    pub fn respond_permission(
        &self,
        session_id: &str,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        let broker = {
            let guard = self.inner.lock();
            guard
                .sessions
                .get(session_id)
                .ok_or_else(|| "session not found".to_string())?
                .permissions
                .clone()
                .ok_or_else(|| "session has no active permission gate".to_string())?
        };
        broker.resolve(request_id, decision)
    }

    fn mark_awaiting_permission(&self, session_id: &str) -> bool {
        let mut guard = self.inner.lock();
        let Some(slot) = guard.sessions.get_mut(session_id) else {
            return false;
        };
        if !matches!(
            slot.fsm.state(),
            SessionState::Streaming | SessionState::AwaitingPermission
        ) {
            return false;
        }
        slot.start_permission_pause(Utc::now());

        if slot.fsm.await_permission().is_err() {
            return false;
        }

        slot.meta.updated_at = Utc::now().to_rfc3339();
        if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
            tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
        }
        true
    }

    /// Finish a successful turn after the adapter emitted `PromptComplete`.
    /// Runtime-native ids stay authoritative; Workbench only persists their
    /// mapping and emits the updated UI metadata after the journal is committed.
    fn settle_successful_turn(&self, session_id: &str) -> Option<SessionMeta> {
        let live = {
            let guard = self.inner.lock();
            guard.sessions.get(session_id)?.live.clone()
        };
        let native_session_id = live
            .as_ref()
            .and_then(|session| session.native_session_id());
        let native_thread_id = live.as_ref().and_then(|session| session.native_thread_id());
        let native_home = live.as_ref().and_then(|session| session.native_home());

        let mut guard = self.inner.lock();
        let slot = guard.sessions.get_mut(session_id)?;
        match slot.fsm.state() {
            SessionState::Streaming | SessionState::AwaitingPermission => {
                if slot.fsm.end_stream().is_err() {
                    return None;
                }
            }
            SessionState::Ready => {}
            _ => return None,
        }
        if let Some(native_session_id) = native_session_id {
            slot.meta.native_session_id = Some(native_session_id);
        }
        if let Some(native_thread_id) = native_thread_id {
            slot.meta.native_thread_id = Some(native_thread_id);
        }
        if let Some(native_home) = native_home {
            slot.meta.native_home = Some(native_home);
        }
        slot.meta.updated_at = Utc::now().to_rfc3339();
        if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
            tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
        }
        Some(slot.meta.clone())
    }

    /// A runtime EOF is terminal for this connection. Flush the visible tail
    /// before dropping the process handle so the next send can reconnect.
    fn mark_process_exited(&self, session_id: &str, code: Option<i32>) -> bool {
        self.record_prompt_complete(session_id, "exited");
        self.record_trace(
            session_id,
            "process_exited",
            serde_json::json!({ "exitCode": code }),
        );
        let mut guard = self.inner.lock();
        let Some(slot) = guard.sessions.get_mut(session_id) else {
            return false;
        };
        slot.disconnect_after_process_exit(code);
        if slot.persisted {
            if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
            }
        }
        true
    }

    /// Mirror an incoming stream chunk and checkpoint it to the journal often
    /// enough that a crash mid-turn costs the tail rather than the whole answer.
    fn record_stream(&self, session_id: &str, kind: StreamKind, text: &str, done: bool) {
        let (checkpoint, first_delta, completed) = {
            let mut guard = self.inner.lock();
            let Some(slot) = guard.sessions.get_mut(session_id) else {
                return;
            };
            let now = Utc::now();
            let runtime_id = slot.meta.runtime_id;
            let started_at = slot
                .prompt_started_at
                .clone()
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let elapsed_ms = elapsed_ms_since(&started_at, now);
            let elapsed_paused_ms = slot.elapsed_paused_ms_through(now);
            let buffer = match kind {
                StreamKind::Assistant => &mut slot.mirror.assistant,
                StreamKind::Thought => &mut slot.mirror.thought,
            };
            let was_empty = buffer.text.is_empty();
            if !text.is_empty() {
                buffer.text.push_str(text);
            }
            let first_delta = (was_empty && !text.is_empty())
                .then(|| first_delta_trace_details(kind, text, elapsed_ms));
            let completed = if done && !buffer.trace_completed {
                buffer.trace_completed = true;
                Some(serde_json::json!({
                    "kind": stream_role(kind),
                    "bytes": buffer.text.len(),
                    "elapsedMs": elapsed_ms,
                }))
            } else {
                None
            };
            // `done` closes this stream but not the turn — tool calls may still
            // follow — so checkpoint here and let prompt_complete finalize.
            let checkpoint = if buffer.text.trim().is_empty()
                || buffer.checkpointed == buffer.text.len()
                || !(done || buffer.checkpoint_due())
            {
                None
            } else {
                let id = buffer
                    .id
                    .get_or_insert_with(|| Uuid::new_v4().to_string())
                    .clone();
                buffer.checkpointed = buffer.text.len();
                let mut checkpoint = StoredChatMessage::checkpoint(
                    id,
                    stream_role(kind),
                    buffer.text.clone(),
                    Some(runtime_id),
                    started_at,
                );
                checkpoint.elapsed_paused_ms = elapsed_paused_ms;
                Some(checkpoint)
            };
            (checkpoint, first_delta, completed)
        };
        if let Some(details) = first_delta {
            self.record_trace(session_id, "stream_first_delta", details);
        }
        if let Some(details) = completed {
            self.record_trace(session_id, "stream_completed", details);
        }
        if let Some(checkpoint) = checkpoint {
            self.append_message(session_id, &checkpoint);
        }
    }

    fn record_tool(&self, session_id: &str, id: &str, name: &str, title: &str, status: &str) {
        self.record_trace(
            session_id,
            "tool_status",
            tool_trace_details(name, status, title),
        );
        let runtime_id = self.runtime_id_for_session(session_id);
        let message = StoredChatMessage::tool(id, name, title, status, runtime_id);
        self.append_message(session_id, &message);
    }

    /// Close the turn: promote both mirrors to final records. They reuse the id
    /// their checkpoints used, so replay sees one message, not a growing stack.
    fn record_prompt_complete(&self, session_id: &str, stop_reason: &str) {
        let result = {
            let mut guard = self.inner.lock();
            let Some(slot) = guard.sessions.get_mut(session_id) else {
                return;
            };
            if slot.prompt_started_at.is_none()
                && slot.mirror.assistant.text.is_empty()
                && slot.mirror.thought.text.is_empty()
            {
                return;
            }
            let started_at = slot
                .prompt_started_at
                .clone()
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let completed_at = Utc::now();
            let elapsed_ms = elapsed_ms_since(&started_at, completed_at);
            let elapsed_paused_ms = slot.close_prompt_timing(completed_at);
            let completed_at = completed_at.to_rfc3339();
            let runtime_id = slot.meta.runtime_id;
            let mut messages = Vec::new();
            let mut incomplete_streams = Vec::new();
            let assistant_bytes = slot.mirror.assistant.text.len();
            let thought_bytes = slot.mirror.thought.text.len();
            for (role, buffer) in [
                ("thought", &mut slot.mirror.thought),
                ("assistant", &mut slot.mirror.assistant),
            ] {
                let (id, text, trace_completed) = buffer.take();
                if !trace_completed && !text.is_empty() {
                    incomplete_streams.push(serde_json::json!({
                        "kind": role,
                        "bytes": text.len(),
                        "elapsedMs": elapsed_ms,
                    }));
                }
                if text.trim().is_empty() {
                    continue;
                }
                let mut message = StoredChatMessage::completed_with_id(
                    id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    role,
                    text,
                    Some(runtime_id),
                    started_at.clone(),
                    completed_at.clone(),
                );
                message.elapsed_paused_ms = elapsed_paused_ms;
                messages.push(message);
            }
            let details = serde_json::json!({
                "stopReason": stop_reason,
                "elapsedMs": elapsed_ms,
                "pausedMs": elapsed_paused_ms,
                "activeMs": elapsed_ms.saturating_sub(elapsed_paused_ms),
                "assistantBytes": assistant_bytes,
                "thoughtBytes": thought_bytes,
            });
            (messages, incomplete_streams, details)
        };
        let (messages, incomplete_streams, details) = result;
        for stream_details in incomplete_streams {
            self.record_trace(session_id, "stream_completed", stream_details);
        }
        for message in messages {
            self.append_message(session_id, &message);
        }
        self.record_trace(session_id, "prompt_completed", details);
    }

    fn record_error(&self, session_id: &str, error: &AgentError) {
        self.record_prompt_complete(session_id, "error");
        self.record_trace(session_id, "agent_error", error_trace_details(error));
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

    fn record_trace(&self, session_id: &str, event: &str, details: serde_json::Value) {
        if !self.inner.lock().sessions.contains_key(session_id) {
            return;
        }
        let trace = StoredTraceEvent::new(session_id, event, details);
        if let Err(err) = session_store::append_trace_event(session_id, &trace) {
            tracing::warn!("failed to append session trace {session_id}: {err}");
        }
    }

    pub async fn messages(&self, session_id: &str) -> Result<Vec<StoredChatMessage>, String> {
        let native_import = {
            let guard = self.inner.lock();
            let slot = guard
                .sessions
                .get(session_id)
                .ok_or_else(|| "session not found".to_string())?;
            let messages = session_store::load_messages(session_id).map_err(|e| e.to_string())?;
            if !messages.is_empty() || slot.meta.native_history_imported_at.is_some() {
                return Ok(messages);
            }
            match runtime::manifest::get(slot.meta.runtime_id).and_then(|m| m.native_sessions) {
                Some(NativeSessionSource::AcpSummaryFiles) => slot
                    .meta
                    .native_session_id
                    .clone()
                    .map(|native_session_id| NativeHistoryImport::AcpSummary {
                        runtime_id: slot.meta.runtime_id,
                        native_session_id,
                    }),
                Some(NativeSessionSource::CodexAppServer) => slot
                    .meta
                    .native_thread_id
                    .clone()
                    .map(NativeHistoryImport::CodexThread),
                None => None,
            }
        };

        let Some(native_import) = native_import else {
            return session_store::load_messages(session_id).map_err(|e| e.to_string());
        };

        let imported = match native_import {
            NativeHistoryImport::AcpSummary {
                runtime_id,
                native_session_id,
            } => crate::native_sessions::load_acp_summary_session_messages(
                runtime_id,
                &native_session_id,
            )?,
            NativeHistoryImport::CodexThread(thread_id) => {
                crate::native_sessions::load_codex_thread_messages(&thread_id).await?
            }
        };
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
        let initial_summary = prompt_summary(&text);
        let needs_connect = {
            let guard = self.inner.lock();
            let slot = guard
                .sessions
                .get(&session_id)
                .ok_or_else(|| "session not found".to_string())?;
            if slot.meta.archived {
                return Err("restore the archived session before sending".to_string());
            }
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
            slot.reset_prompt_timing(Utc::now());
            if slot.meta.summary.is_none() {
                slot.meta.summary = initial_summary;
            }
            // A new turn gets fresh journal ids. Anything the previous turn left
            // behind is already on disk as a `partial` record.
            slot.mirror = StreamMirror::default();
        }
        let runtime_id = self.runtime_id_for_session(&session_id);
        self.record_trace(&session_id, "prompt_submitted", prompt_trace_details(&text));
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
            if let Err(error) = &result {
                mgr.record_prompt_complete(&session_id, "error");
                mgr.record_trace(&session_id, "prompt_failed", error_trace_details(error));
                let _ = live.shutdown().await;
                let mut guard = mgr.inner.lock();
                if let Some(slot) = guard.sessions.get_mut(&session_id) {
                    let is_current_live = slot
                        .live
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &live));
                    if is_current_live {
                        slot.fsm.disconnect(Some(error.clone()));
                        slot.live = None;
                        slot.backend = "error".into();
                        slot.meta.updated_at = Utc::now().to_rfc3339();
                        if let Err(err) = session_store::save_meta(&slot.meta.to_stored()) {
                            tracing::warn!("failed to save session meta {}: {err}", slot.meta.id);
                        }
                    }
                }
            }

            if let Err(error) = result {
                mgr.emit_state(&app, &session_id);
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
        self.record_trace(
            session_id,
            "stop_requested",
            serde_json::json!({ "hadLiveProcess": live.is_some() }),
        );
        if let Some(live) = live {
            if let Err(error) = live.cancel().await {
                self.record_trace(session_id, "stop_failed", error_trace_details(&error));
                return Err(format!("{}: {}", error.code.as_str(), error.message));
            }
            self.record_prompt_complete(session_id, "cancelled");
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
        self.record_trace(session_id, "stop_completed", serde_json::json!({}));
        self.emit_state(app, session_id);
        Ok(())
    }

    pub async fn disconnect(&self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        {
            let guard = self.inner.lock();
            if !guard.sessions.contains_key(session_id) {
                return Err("session not found".to_string());
            }
        }
        self.record_trace(session_id, "disconnect_requested", serde_json::json!({}));
        // Flush before teardown: text the user already saw must not vanish just
        // because the turn never reached prompt_complete.
        self.record_prompt_complete(session_id, "disconnected");
        let live = {
            let mut guard = self.inner.lock();
            let slot = guard
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "session not found".to_string())?;
            // Abort first: pending approvals belong to the process we are killing.
            if let Some(broker) = slot.permissions.take() {
                broker.abort_all();
            }
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
        self.record_trace(session_id, "session_disconnected", serde_json::json!({}));
        self.emit_state(app, session_id);
        Ok(())
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Re-validate settings loaded from disk. Stored data must never fail to load,
/// so an adapter rejection is logged and the raw values are kept as-is.
fn normalize_stored_settings(
    runtime_id: RuntimeId,
    model_id: Option<String>,
    model_reasoning_effort: Option<String>,
) -> (Option<String>, Option<String>) {
    let Some(runtime) = runtime::get_runtime(runtime_id) else {
        return (model_id, model_reasoning_effort);
    };
    let patch = SessionSettingsPatch {
        model_id: model_id.clone(),
        model_reasoning_effort: model_reasoning_effort.clone(),
        permission_mode: None,
    };
    match runtime.normalize_settings(&SessionSettings::default(), &patch) {
        Ok(next) => (next.model_id, next.model_reasoning_effort),
        Err(err) => {
            tracing::warn!("stored settings for runtime {runtime_id} are not valid: {err}");
            (model_id, model_reasoning_effort)
        }
    }
}

fn default_permission_mode(runtime_id: RuntimeId) -> PermissionMode {
    runtime::manifest::get(runtime_id)
        .map(|m| m.default_permission_mode())
        .unwrap_or(PermissionMode::Ask)
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

fn prompt_summary(text: &str) -> Option<String> {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    Some(compact.chars().take(120).collect())
}

fn process_exit_error(code: Option<i32>) -> AgentError {
    let message = match code {
        Some(code) => format!("Agent process exited unexpectedly with code {code}"),
        None => "Agent process exited unexpectedly".to_string(),
    };
    AgentError::new(AgentErrorCode::AgentCrashed, message)
}

fn default_project_dir() -> std::io::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut last_error = None;
        for root in [PathBuf::from(r"D:\"), PathBuf::from(r"X:\")] {
            if !root.is_dir() {
                continue;
            }
            let path = root.join("workbench");
            match fs::create_dir_all(&path) {
                Ok(()) => return Ok(path),
                Err(error) => last_error = Some(error),
            }
        }
        if let Some(error) = last_error {
            tracing::warn!("failed to create preferred Workbench directory: {error}");
        }
    }

    let path = crate::process_util::user_home().join("workbench");
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn validate_project_dir(project_path: &str) -> Result<String, String> {
    let project_path = project_path.trim();
    if project_path.is_empty() {
        return Err("project path cannot be empty".into());
    }
    let path = PathBuf::from(project_path);
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("project directory does not exist: {}", path.display()));
    }
    Ok(path.display().to_string())
}

fn resolve_claude_permission_bridge_script_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve(
            "runtime/claude_permission_bridge.mjs",
            BaseDirectory::Resource,
        )
        .ok()
        .filter(|path| path.is_file())
        .or_else(|| {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join("runtime")
                .join("claude_permission_bridge.mjs");
            path.is_file().then_some(path)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_meta(id: &str, updated_at: &str, pinned: bool) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            title: id.into(),
            title_is_custom: false,
            pinned,
            archived: false,
            summary: None,
            runtime_id: RuntimeId::CODEX,
            project_path: None,
            model_id: Some("default".into()),
            model_reasoning_effort: Some("high".into()),
            permission_mode: PermissionMode::Ask,
            native_session_id: None,
            native_thread_id: None,
            native_home: None,
            resume_supported: true,
            last_resume_error: None,
            native_source: None,
            native_updated_at: None,
            native_history_imported_at: None,
            created_at: updated_at.into(),
            updated_at: updated_at.into(),
        }
    }

    #[test]
    fn prompt_summary_is_compact_and_bounded() {
        let source = format!("  first line\n\n{}  ", "x".repeat(160));
        let summary = prompt_summary(&source).expect("non-empty prompt");

        assert!(!summary.contains('\n'));
        assert_eq!(summary.chars().count(), 120);
        assert!(summary.starts_with("first line "));
    }

    #[test]
    fn session_titles_are_trimmed_and_bounded() {
        assert_eq!(
            validate_session_title("  renamed  ".into()).unwrap(),
            "renamed"
        );
        assert!(validate_session_title("   ".into()).is_err());
        assert!(validate_session_title("x".repeat(121)).is_err());
    }

    #[test]
    fn trace_detail_builders_do_not_include_private_text() {
        let secret = "SECRET prompt and response body";
        let prompt = prompt_trace_details(secret).to_string();
        let error = error_trace_details(&AgentError::new(AgentErrorCode::NetworkProvider, secret))
            .to_string();
        let stream = first_delta_trace_details(StreamKind::Assistant, secret, 42).to_string();
        let tool = tool_trace_details("commandExecution", "pending", secret).to_string();
        let permission =
            permission_request_trace_details("commandExecution", secret, secret, false).to_string();

        assert!(!prompt.contains(secret));
        assert!(prompt.contains("textChars"));
        assert!(!error.contains(secret));
        assert!(error.contains("NETWORK_PROVIDER"));
        assert!(!stream.contains(secret));
        assert!(!tool.contains(secret));
        assert!(!permission.contains(secret));
    }

    #[test]
    fn settings_trace_only_contains_selected_runtime_controls() {
        let details = session_settings_trace_details(&SessionSettingsPatch {
            model_id: Some("gpt-5".into()),
            model_reasoning_effort: Some("high".into()),
            permission_mode: Some(PermissionMode::Ask),
        });
        let text = details.to_string();

        assert!(text.contains("gpt-5"));
        assert!(text.contains("high"));
        assert!(text.contains("ask"));
        assert!(!text.contains("projectPath"));
    }

    #[test]
    fn pinned_sessions_sort_before_newer_unpinned_sessions() {
        let mut sessions = vec![
            session_meta("recent", "2026-07-29T02:00:00Z", false),
            session_meta("pinned", "2026-07-29T01:00:00Z", true),
        ];

        sort_session_metas(&mut sessions);

        assert_eq!(sessions[0].id, "pinned");
    }

    #[test]
    fn process_exit_disconnects_the_live_slot() {
        let now = Utc::now().to_rfc3339();
        let mut fsm = SessionFsm::new();
        fsm.start_connect().unwrap();
        fsm.handshake_ok().unwrap();
        fsm.begin_stream().unwrap();
        let mut slot = LiveSessionSlot {
            meta: SessionMeta {
                id: "test-session".into(),
                title: "test".into(),
                title_is_custom: false,
                pinned: false,
                archived: false,
                summary: None,
                runtime_id: RuntimeId::CODEX,
                project_path: None,
                model_id: Some("default".into()),
                model_reasoning_effort: Some("high".into()),
                permission_mode: PermissionMode::Ask,
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
            },
            fsm,
            backend: "codex_app_server".into(),
            live: None,
            permissions: None,
            mirror: StreamMirror::default(),
            prompt_started_at: Some(Utc::now().to_rfc3339()),
            prompt_paused_ms: 0,
            permission_pause_started_at: None,
            pending_permission_count: 0,
            persisted: false,
        };

        slot.disconnect_after_process_exit(Some(9));

        assert_eq!(slot.fsm.state(), SessionState::Disconnected);
        assert_eq!(slot.backend, "error");
        let error = slot.fsm.last_error().expect("process exit error");
        assert_eq!(error.code, AgentErrorCode::AgentCrashed);
        assert!(error.message.contains("code 9"));
    }
}
