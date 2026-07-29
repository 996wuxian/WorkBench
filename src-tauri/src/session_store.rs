//! Workbench session index and UI mirror journal.
//!
//! Runtime-native histories remain authoritative. This store only maps
//! Workbench sessions to native ids and restores the UI after reloads.

use std::collections::{BTreeSet, HashMap};
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

/// One journal record.
///
/// The journal is append-only, but a record may be written several times under
/// the same `id`: a streaming turn checkpoints as it grows, and a tool call is
/// re-written on every status change. `load_messages` collapses by `id`, so the
/// last write wins while the first one fixes the position in the transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub runtime_id: Option<RuntimeId>,
    pub created_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub elapsed_paused_ms: u64,
    /// Runtime-native id of the tool call this record describes.
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_title: Option<String>,
    #[serde(default)]
    pub tool_status: Option<String>,
    /// True for a mid-stream checkpoint. The turn's final record carries the
    /// same `id` and clears it; a record that is still `partial` after replay
    /// means the turn was cut short by a crash or a killed process.
    #[serde(default)]
    pub partial: bool,
}

impl StoredChatMessage {
    fn base(
        id: String,
        role: impl Into<String>,
        content: impl Into<String>,
        runtime_id: Option<RuntimeId>,
        created_at: String,
    ) -> Self {
        Self {
            id,
            role: role.into(),
            content: content.into(),
            runtime_id,
            created_at,
            completed_at: None,
            elapsed_paused_ms: 0,
            tool_call_id: None,
            tool_name: None,
            tool_title: None,
            tool_status: None,
            partial: false,
        }
    }

    pub fn new(
        role: impl Into<String>,
        content: impl Into<String>,
        runtime_id: Option<RuntimeId>,
    ) -> Self {
        Self::base(
            uuid::Uuid::new_v4().to_string(),
            role,
            content,
            runtime_id,
            Utc::now().to_rfc3339(),
        )
    }

    pub fn imported(
        role: impl Into<String>,
        content: impl Into<String>,
        runtime_id: Option<RuntimeId>,
        created_at: impl Into<String>,
    ) -> Self {
        let created_at = created_at.into();
        Self {
            completed_at: Some(created_at.clone()),
            ..Self::base(
                uuid::Uuid::new_v4().to_string(),
                role,
                content,
                runtime_id,
                created_at,
            )
        }
    }

    /// Final record of a streamed turn. Callers pass the id their checkpoints
    /// used so replay keeps one message instead of a stack of partials.
    pub fn completed_with_id(
        id: String,
        role: impl Into<String>,
        content: impl Into<String>,
        runtime_id: Option<RuntimeId>,
        created_at: impl Into<String>,
        completed_at: impl Into<String>,
    ) -> Self {
        Self {
            completed_at: Some(completed_at.into()),
            ..Self::base(id, role, content, runtime_id, created_at.into())
        }
    }

    /// Mid-stream snapshot of an open turn, so a crash loses at most the tail
    /// instead of everything the agent has said so far.
    pub fn checkpoint(
        id: String,
        role: impl Into<String>,
        content: impl Into<String>,
        runtime_id: Option<RuntimeId>,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            partial: true,
            ..Self::base(id, role, content, runtime_id, created_at.into())
        }
    }

    /// One tool call. `tool_call_id` keys the record, so a status update
    /// replaces the previous line instead of appending a near-duplicate.
    /// Adapters that cannot supply an id fall back to one record per event.
    pub fn tool(
        tool_call_id: &str,
        name: &str,
        title: &str,
        status: &str,
        runtime_id: Option<RuntimeId>,
    ) -> Self {
        let tool_call_id = tool_call_id.trim();
        let id = if tool_call_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            format!("tool:{tool_call_id}")
        };
        Self {
            // `content` stays human-readable so journals written before the
            // structured fields existed and journals written after it render
            // through the same fallback path.
            tool_call_id: (!tool_call_id.is_empty()).then(|| tool_call_id.to_string()),
            tool_name: Some(name.to_string()),
            tool_title: Some(title.to_string()),
            tool_status: Some(status.to_string()),
            ..Self::base(
                id,
                "tool",
                format!("{title} · {status}"),
                runtime_id,
                Utc::now().to_rfc3339(),
            )
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

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
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
    atomic_write(&path, text.as_bytes())?;
    write_index(Some(&meta.id))
}

pub fn session_dir_path(session_id: &str) -> std::io::Result<PathBuf> {
    session_dir(session_id)
}

pub fn delete_session(session_id: &str) -> std::io::Result<PathBuf> {
    let dir = session_dir(session_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    write_index(None)?;
    Ok(dir)
}

pub fn append_message(session_id: &str, message: &StoredChatMessage) -> std::io::Result<()> {
    append_messages(session_id, std::slice::from_ref(message))
}

/// Append records to the journal.
///
/// No `fsync`: the journal exists to survive a crashing *process* (agent or
/// Host), and the OS flushes buffered writes for us in that case. Paying a
/// sync per streaming checkpoint would be far more expensive than the power-loss
/// window it closes.
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

/// Replay the journal into the transcript the UI shows.
///
/// Records are collapsed by `id`: the last write wins, the first write fixes
/// the position. That is what turns repeated tool-status lines and streaming
/// checkpoints back into single messages. Unparsable lines are skipped rather
/// than failing the load — a truncated tail is exactly what a crash leaves
/// behind, and losing it must not cost the user the rest of the session.
pub fn load_messages(session_id: &str) -> std::io::Result<Vec<StoredChatMessage>> {
    let path = session_dir(session_id)?.join("journal.jsonl");
    if !path.is_file() {
        return Ok(Vec::new());
    }

    let file = File::open(path)?;
    Ok(collapse_journal(
        BufReader::new(file).lines().map_while(Result::ok),
    ))
}

fn collapse_journal(lines: impl Iterator<Item = String>) -> Vec<StoredChatMessage> {
    let mut messages: Vec<StoredChatMessage> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<StoredChatMessage>(&line) {
            Ok(message) => match positions.get(&message.id) {
                Some(&index) => messages[index] = message,
                None => {
                    positions.insert(message.id.clone(), messages.len());
                    messages.push(message);
                }
            },
            Err(err) => tracing::warn!("invalid session journal line skipped: {err}"),
        }
    }
    messages
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

fn atomic_write(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    let tmp = path.with_file_name(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(messages: &[StoredChatMessage]) -> Vec<String> {
        messages
            .iter()
            .map(|m| serde_json::to_string(m).expect("serialize"))
            .collect()
    }

    #[test]
    fn tool_updates_collapse_onto_one_record() {
        let pending = StoredChatMessage::tool("call-1", "read", "Read main.rs", "pending", None);
        let done = StoredChatMessage::tool("call-1", "read", "Read main.rs", "completed", None);
        let other = StoredChatMessage::tool("call-2", "edit", "Edit main.rs", "pending", None);

        let replayed = collapse_journal(lines(&[pending, done, other]).into_iter());

        assert_eq!(replayed.len(), 2);
        assert_eq!(replayed[0].tool_status.as_deref(), Some("completed"));
        assert_eq!(replayed[1].tool_call_id.as_deref(), Some("call-2"));
    }

    #[test]
    fn tool_calls_without_an_id_are_never_merged() {
        let first = StoredChatMessage::tool("", "bash", "run tests", "pending", None);
        let second = StoredChatMessage::tool("", "bash", "run tests", "pending", None);

        let replayed = collapse_journal(lines(&[first, second]).into_iter());

        assert_eq!(replayed.len(), 2);
    }

    #[test]
    fn final_record_supersedes_its_checkpoints_and_keeps_position() {
        let user = StoredChatMessage::new("user", "hi", None);
        let turn_id = "turn-1".to_string();
        let early = StoredChatMessage::checkpoint(turn_id.clone(), "assistant", "he", None, "t0");
        let later = StoredChatMessage::checkpoint(turn_id.clone(), "assistant", "hello", None, "t0");
        let tool = StoredChatMessage::tool("call-1", "read", "Read", "completed", None);
        let done = StoredChatMessage::completed_with_id(
            turn_id,
            "assistant",
            "hello there",
            None,
            "t0",
            "t1",
        );

        let replayed = collapse_journal(lines(&[user, early, later, tool, done]).into_iter());

        // user, assistant, tool — the assistant keeps the slot its first
        // checkpoint claimed even though the final record was written last.
        assert_eq!(replayed.len(), 3);
        assert_eq!(replayed[1].role, "assistant");
        assert_eq!(replayed[1].content, "hello there");
        assert!(!replayed[1].partial);
        assert_eq!(replayed[1].completed_at.as_deref(), Some("t1"));
        assert_eq!(replayed[2].role, "tool");
    }

    #[test]
    fn a_crashed_turn_replays_as_partial() {
        let checkpoint =
            StoredChatMessage::checkpoint("turn-1".into(), "assistant", "half an ans", None, "t0");

        let replayed = collapse_journal(lines(&[checkpoint]).into_iter());

        assert_eq!(replayed.len(), 1);
        assert!(replayed[0].partial);
        assert_eq!(replayed[0].content, "half an ans");
    }

    #[test]
    fn a_truncated_tail_does_not_lose_earlier_records() {
        let good = serde_json::to_string(&StoredChatMessage::new("user", "hi", None)).unwrap();
        let truncated = "{\"id\":\"x\",\"role\":\"assis".to_string();

        let replayed = collapse_journal(vec![good, truncated, String::new()].into_iter());

        assert_eq!(replayed.len(), 1);
        assert_eq!(replayed[0].content, "hi");
    }

    #[test]
    fn legacy_records_without_structured_fields_still_load() {
        let legacy = r#"{"id":"m1","role":"tool","content":"Read main.rs · completed","runtimeId":"grok","createdAt":"t0"}"#;

        let replayed = collapse_journal(std::iter::once(legacy.to_string()));

        assert_eq!(replayed.len(), 1);
        assert_eq!(replayed[0].content, "Read main.rs · completed");
        assert!(replayed[0].tool_call_id.is_none());
        assert!(!replayed[0].partial);
    }
}
