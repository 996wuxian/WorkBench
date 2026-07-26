//! Workbench session index and UI mirror journal.
//!
//! Runtime-native histories remain authoritative. This store only maps
//! Workbench sessions to native ids and restores the UI after reloads.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::paths;
use crate::runtime::{PermissionMode, RuntimeId};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSessionMeta {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub runtime_id: RuntimeId,
    pub project_path: Option<String>,
    pub model_id: Option<String>,
    #[serde(default)]
    pub model_reasoning_effort: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub native_session_id: Option<String>,
    #[serde(default)]
    pub native_thread_id: Option<String>,
    #[serde(default)]
    pub native_home: Option<String>,
    #[serde(default = "default_resume_supported")]
    pub resume_supported: bool,
    #[serde(default)]
    pub last_resume_error: Option<String>,
    #[serde(default)]
    pub native_source: Option<String>,
    #[serde(default)]
    pub native_updated_at: Option<String>,
    #[serde(default)]
    pub native_history_imported_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub runtime_id: Option<RuntimeId>,
    pub created_at: String,
}

impl StoredChatMessage {
    pub fn new(
        role: impl Into<String>,
        content: impl Into<String>,
        runtime_id: Option<RuntimeId>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.into(),
            content: content.into(),
            runtime_id,
            created_at: Utc::now().to_rfc3339(),
        }
    }

    pub fn imported(
        role: impl Into<String>,
        content: impl Into<String>,
        runtime_id: Option<RuntimeId>,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.into(),
            content: content.into(),
            runtime_id,
            created_at: created_at.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionIndex {
    session_ids: Vec<String>,
    updated_at: String,
}

fn default_resume_supported() -> bool {
    true
}

pub fn load_metas() -> std::io::Result<Vec<StoredSessionMeta>> {
    let root = paths::sessions_dir();
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut metas = Vec::new();
    for entry in fs::read_dir(root)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path().join("meta.json");
        if !path.is_file() {
            continue;
        }
        match fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<StoredSessionMeta>(&text).ok())
        {
            Some(meta) => metas.push(meta),
            None => tracing::warn!("invalid session meta skipped: {}", path.display()),
        }
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

pub fn save_meta(meta: &StoredSessionMeta) -> std::io::Result<()> {
    let dir = session_dir(&meta.id)?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("meta.json");
    let text = serde_json::to_string_pretty(meta)?;
    fs::write(path, text)?;
    write_index(Some(&meta.id))
}

pub fn append_message(session_id: &str, message: &StoredChatMessage) -> std::io::Result<()> {
    append_messages(session_id, std::slice::from_ref(message))
}

pub fn append_messages(session_id: &str, messages: &[StoredChatMessage]) -> std::io::Result<()> {
    if messages.is_empty() {
        return Ok(());
    }
    let dir = session_dir(session_id)?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("journal.jsonl");
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    for message in messages {
        serde_json::to_writer(&mut file, message)?;
        file.write_all(b"\n")?;
    }
    Ok(())
}

pub fn load_messages(session_id: &str) -> std::io::Result<Vec<StoredChatMessage>> {
    let path = session_dir(session_id)?.join("journal.jsonl");
    if !path.is_file() {
        return Ok(Vec::new());
    }

    let file = File::open(path)?;
    let mut messages = Vec::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<StoredChatMessage>(&line) {
            Ok(message) => messages.push(message),
            Err(err) => tracing::warn!("invalid session journal line skipped: {err}"),
        }
    }
    Ok(messages)
}

fn session_dir(session_id: &str) -> std::io::Result<PathBuf> {
    if !session_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid session id",
        ));
    }
    Ok(paths::sessions_dir().join(session_id))
}

fn write_index(extra_id: Option<&str>) -> std::io::Result<()> {
    let root = paths::sessions_dir();
    fs::create_dir_all(&root)?;

    let mut ids = BTreeSet::new();
    for entry in fs::read_dir(&root)? {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.path().join("meta.json").is_file() {
            if let Some(name) = entry.file_name().to_str() {
                ids.insert(name.to_string());
            }
        }
    }
    if let Some(id) = extra_id {
        ids.insert(id.to_string());
    }

    let index = SessionIndex {
        session_ids: ids.into_iter().collect(),
        updated_at: Utc::now().to_rfc3339(),
    };
    let text = serde_json::to_string_pretty(&index)?;
    fs::write(root.join("index.json"), text)
}
