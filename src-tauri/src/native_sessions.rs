//! Read-only import of runtime-native session indexes.

use std::fs::{self, File};
use std::io::{BufRead, BufReader as StdBufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::process_util;
use crate::runtime::manifest::{self, RuntimeManifest};
use crate::runtime::{NativeSessionSource, RuntimeId};
use crate::session_store::StoredChatMessage;
use chrono::{TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::{timeout, Duration};

const CODEX_RPC_TIMEOUT_SECS: u64 = 45;
const TOOL_SUMMARY_MAX_CHARS: usize = 240;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionPage {
    pub runtime_id: RuntimeId,
    pub items: Vec<NativeSessionItem>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionItem {
    pub runtime_id: RuntimeId,
    pub native_source: String,
    pub native_session_id: Option<String>,
    pub native_thread_id: Option<String>,
    pub native_home: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub project_path: Option<String>,
    pub model_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Which import strategy a runtime uses is declared in its manifest, so a new
/// ACP CLI that writes the same `sessions/**/summary.json` layout works here
/// without a code change.
pub async fn sync_native_sessions(
    runtime_id: RuntimeId,
    limit: usize,
    cursor: Option<String>,
) -> Result<NativeSessionPage, String> {
    let limit = limit.clamp(1, 100);
    let manifest =
        manifest::get(runtime_id).ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;
    match manifest.native_sessions {
        Some(NativeSessionSource::AcpSummaryFiles) => {
            sync_summary_file_sessions(manifest, limit, cursor)
        }
        Some(NativeSessionSource::CodexAppServer) => {
            sync_codex_threads(manifest, limit, cursor).await
        }
        None => Err(format!("{} 不提供可导入的历史会话", manifest.display_name)),
    }
}

fn sync_summary_file_sessions(
    manifest: &RuntimeManifest,
    limit: usize,
    cursor: Option<String>,
) -> Result<NativeSessionPage, String> {
    let runtime_id = manifest
        .runtime_id()
        .ok_or_else(|| format!("invalid runtime id in manifest: {}", manifest.id))?;
    let home = manifest.resolve_home();
    let root = home.join("sessions");
    if !root.is_dir() {
        return Ok(NativeSessionPage {
            runtime_id,
            items: Vec::new(),
            next_cursor: None,
            has_more: false,
        });
    }

    let mut all = Vec::new();
    collect_summary_files(manifest, &root, &home, &mut all)?;
    all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let total = all.len();

    let offset = cursor
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let items: Vec<_> = all.into_iter().skip(offset).take(limit).collect();
    let next = offset + items.len();
    let has_more = next < total;

    Ok(NativeSessionPage {
        runtime_id,
        next_cursor: has_more.then(|| next.to_string()),
        has_more,
        items,
    })
}

fn collect_summary_files(
    manifest: &RuntimeManifest,
    dir: &Path,
    home: &Path,
    out: &mut Vec<NativeSessionItem>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.is_dir() {
            collect_summary_files(manifest, &path, home, out)?;
            continue;
        }
        if path.file_name().and_then(|name| name.to_str()) != Some("summary.json") {
            continue;
        }
        if let Some(item) = parse_summary_file(manifest, &path, home) {
            out.push(item);
        }
    }
    Ok(())
}

fn parse_summary_file(
    manifest: &RuntimeManifest,
    path: &Path,
    home: &Path,
) -> Option<NativeSessionItem> {
    let runtime_id = manifest.runtime_id()?;
    let fallback_title = format!("{} session", manifest.display_name);
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let session_id = value
        .pointer("/info/id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| path.parent()?.file_name()?.to_str().map(str::to_string))?;
    let title = value
        .get("generated_title")
        .or_else(|| value.get("session_summary"))
        .and_then(|v| v.as_str())
        .unwrap_or(&fallback_title)
        .trim()
        .to_string();
    let summary = value
        .get("session_summary")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let created_at = value
        .get("created_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let updated_at = value
        .get("last_active_at")
        .or_else(|| value.get("updated_at"))
        .and_then(|v| v.as_str())
        .unwrap_or(&created_at)
        .to_string();

    Some(NativeSessionItem {
        runtime_id,
        native_source: manifest.id.clone(),
        native_session_id: Some(session_id),
        native_thread_id: None,
        native_home: Some(home.display().to_string()),
        title: if title.is_empty() {
            fallback_title
        } else {
            title
        },
        summary,
        project_path: value
            .pointer("/info/cwd")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        model_id: value
            .get("current_model_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        created_at,
        updated_at,
    })
}

pub fn load_acp_summary_session_messages(
    runtime_id: RuntimeId,
    native_session_id: &str,
) -> Result<Vec<StoredChatMessage>, String> {
    let manifest =
        manifest::get(runtime_id).ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;
    if manifest.native_sessions != Some(NativeSessionSource::AcpSummaryFiles) {
        return Err(format!(
            "{} does not use ACP summary-file history",
            manifest.display_name
        ));
    }

    let home = manifest.resolve_home();
    let root = home.join("sessions");
    let Some(summary_path) = find_summary_file_for_session(&root, native_session_id)? else {
        return Ok(Vec::new());
    };
    let Some(session_dir) = summary_path.parent() else {
        return Ok(Vec::new());
    };
    let chat_path = session_dir.join("chat_history.jsonl");
    if !chat_path.is_file() {
        return Ok(Vec::new());
    }

    parse_acp_chat_history(runtime_id, &chat_path)
}

fn find_summary_file_for_session(
    dir: &Path,
    native_session_id: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    if !dir.is_dir() {
        return Ok(None);
    }

    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_summary_file_for_session(&path, native_session_id)? {
                return Ok(Some(found));
            }
            continue;
        }
        if path.file_name().and_then(|name| name.to_str()) != Some("summary.json") {
            continue;
        }
        let parent_matches = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            == Some(native_session_id);
        if parent_matches || summary_file_session_id(&path).as_deref() == Some(native_session_id) {
            return Ok(Some(path));
        }
    }

    Ok(None)
}

fn summary_file_session_id(path: &Path) -> Option<String> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    value
        .pointer("/info/id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn parse_acp_chat_history(
    runtime_id: RuntimeId,
    path: &Path,
) -> Result<Vec<StoredChatMessage>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();
    for line in StdBufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(item) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        messages.extend(parse_acp_chat_item(runtime_id, &item));
    }
    Ok(messages)
}

fn parse_acp_chat_item(runtime_id: RuntimeId, item: &Value) -> Vec<StoredChatMessage> {
    let created_at = timestamp_or_now(
        item.get("created_at")
            .or_else(|| item.get("timestamp"))
            .or_else(|| item.get("ts")),
    );
    match item.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "user" => message_from_text("user", acp_user_query_text(item), runtime_id, &created_at),
        "assistant" => message_from_text(
            "assistant",
            acp_content_text(item.get("content")),
            runtime_id,
            &created_at,
        ),
        "reasoning" => message_from_text(
            "thought",
            acp_reasoning_text(item)
                .or_else(|| reasoning_text(item))
                .or_else(|| acp_content_text(item.get("content"))),
            runtime_id,
            &created_at,
        ),
        "tool_result" => message_from_text(
            "tool",
            acp_content_text(item.get("content")),
            runtime_id,
            &created_at,
        ),
        _ => Vec::new(),
    }
}

fn acp_user_query_text(item: &Value) -> Option<String> {
    let text = acp_content_text(item.get("content"))?;
    if text.contains("<system-reminder>") || text.contains("<user_info>") {
        return None;
    }
    extract_tag_text(&text, "user_query").or(Some(text))
}

fn acp_content_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => clean_plain_text(text),
        Value::Array(parts) => {
            let chunks = parts
                .iter()
                .filter_map(|part| match part {
                    Value::String(text) => clean_plain_text(text),
                    Value::Object(_) => clean_str(part.get("text"))
                        .or_else(|| clean_str(part.get("content")))
                        .or_else(|| clean_str(part.get("url")).map(|url| format!("[image] {url}")))
                        .or_else(|| {
                            clean_str(part.get("path")).map(|path| format!("[file] {path}"))
                        }),
                    _ => None,
                })
                .collect::<Vec<_>>();
            join_non_empty(chunks)
        }
        Value::Object(map) => clean_str(map.get("text")).or_else(|| clean_str(map.get("content"))),
        _ => None,
    }
}

fn acp_reasoning_text(item: &Value) -> Option<String> {
    let parts = item
        .get("summary")?
        .as_array()?
        .iter()
        .filter_map(|part| {
            part.as_str()
                .map(str::to_string)
                .or_else(|| clean_str(part.get("text")))
        })
        .collect::<Vec<_>>();
    join_non_empty(parts)
}

fn extract_tag_text(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    clean_plain_text(&text[start..end])
}

fn clean_plain_text(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

async fn sync_codex_threads(
    manifest: &RuntimeManifest,
    limit: usize,
    cursor: Option<String>,
) -> Result<NativeSessionPage, String> {
    let runtime_id = manifest
        .runtime_id()
        .ok_or_else(|| format!("invalid runtime id in manifest: {}", manifest.id))?;
    let cli = manifest
        .resolve_cli_path()
        .ok_or_else(|| format!("{} CLI not found", manifest.display_name))?;
    let home = manifest.resolve_home();
    let mut client = JsonRpcClient::spawn(&cli)?;
    client.initialize().await?;

    let result = client
        .request(
            "thread/list",
            json!({
                "limit": limit,
                "cursor": cursor,
                "archived": false,
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "useStateDbOnly": false,
                "sourceKinds": [
                    "cli",
                    "vscode",
                    "exec",
                    "appServer",
                    "subAgent",
                    "subAgentReview",
                    "subAgentCompact",
                    "subAgentThreadSpawn",
                    "subAgentOther",
                    "unknown"
                ]
            }),
        )
        .await?;

    let items = result
        .get("data")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|thread| parse_codex_thread(manifest, thread, &home))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let next_cursor = result
        .get("nextCursor")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Ok(NativeSessionPage {
        runtime_id,
        has_more: next_cursor.is_some(),
        next_cursor,
        items,
    })
}

fn parse_codex_thread(
    manifest: &RuntimeManifest,
    thread: &Value,
    home: &Path,
) -> Option<NativeSessionItem> {
    let runtime_id = manifest.runtime_id()?;
    let thread_id = thread.get("id").and_then(|v| v.as_str())?.to_string();
    let session_id = thread
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let preview = clean_str(thread.get("preview"));
    let title = clean_str(thread.get("name"))
        .or_else(|| clean_str(thread.get("title")))
        .or_else(|| preview.as_ref().map(|s| compact_text(s, 80)))
        .unwrap_or_else(|| format!("{} session", manifest.display_name));
    let cwd = thread
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let created_at = timestamp_or_now(thread.get("createdAt"));
    let updated_at =
        timestamp_to_rfc3339(thread.get("updatedAt")).unwrap_or_else(|| created_at.clone());
    let model_id = thread
        .get("model")
        .or_else(|| thread.get("modelId"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let provider = thread
        .get("modelProvider")
        .and_then(|v| v.as_str())
        .unwrap_or("codex");
    let summary = preview.or_else(|| {
        cwd.as_ref()
            .map(|cwd| format!("{provider} · {cwd}"))
            .or_else(|| Some(provider.to_string()))
    });

    Some(NativeSessionItem {
        runtime_id,
        native_source: manifest.id.clone(),
        native_session_id: session_id,
        native_thread_id: Some(thread_id),
        native_home: Some(home.display().to_string()),
        title,
        summary,
        project_path: cwd,
        model_id,
        created_at,
        updated_at,
    })
}

pub async fn load_codex_thread_messages(thread_id: &str) -> Result<Vec<StoredChatMessage>, String> {
    let manifest = manifest::get(RuntimeId::CODEX)
        .ok_or_else(|| "Codex runtime is not registered".to_string())?;
    let cli = manifest
        .resolve_cli_path()
        .ok_or_else(|| format!("{} CLI not found", manifest.display_name))?;
    let mut client = JsonRpcClient::spawn(&cli)?;
    client.initialize().await?;
    let result = client
        .request(
            "thread/read",
            json!({
                "threadId": thread_id,
                "includeTurns": true
            }),
        )
        .await?;

    Ok(parse_codex_thread_messages(&result))
}

pub async fn delete_codex_thread(thread_id: &str) -> Result<(), String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Err("Codex native thread id is empty".into());
    }

    let manifest = manifest::get(RuntimeId::CODEX)
        .ok_or_else(|| "Codex runtime is not registered".to_string())?;
    let cli = manifest
        .resolve_cli_path()
        .ok_or_else(|| format!("{} CLI not found", manifest.display_name))?;
    let mut client = JsonRpcClient::spawn(&cli)?;
    client.initialize().await?;
    client
        .request(
            "thread/delete",
            json!({
                "threadId": thread_id
            }),
        )
        .await?;
    Ok(())
}

pub async fn delete_codex_thread_direct(thread_id: &str) -> Result<(), String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Err("Codex native thread id is empty".into());
    }

    let manifest = manifest::get(RuntimeId::CODEX)
        .ok_or_else(|| "Codex runtime is not registered".to_string())?;
    let home = manifest.resolve_home();
    let thread_id = thread_id.to_string();

    tokio::task::spawn_blocking(move || delete_codex_thread_direct_blocking(&home, &thread_id))
        .await
        .map_err(|err| format!("Codex direct delete task failed: {err}"))?
}

fn delete_codex_thread_direct_blocking(home: &Path, thread_id: &str) -> Result<(), String> {
    let state = find_codex_state_thread(home, thread_id)?;
    let rollout_path = PathBuf::from(&state.rollout_path);
    ensure_codex_rollout_path(home, &rollout_path)?;

    let mut conn = Connection::open(&state.db_path)
        .map_err(|err| format!("open Codex state database failed: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| format!("configure Codex state database failed: {err}"))?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("begin Codex state delete transaction failed: {err}"))?;

    delete_codex_thread_refs(&tx, thread_id)?;

    if rollout_path.is_file() {
        fs::remove_file(&rollout_path).map_err(|err| {
            format!(
                "delete Codex rollout file {} failed: {err}",
                rollout_path.display()
            )
        })?;
    }

    tx.commit()
        .map_err(|err| format!("commit Codex state delete transaction failed: {err}"))?;
    Ok(())
}

struct CodexStateThread {
    db_path: PathBuf,
    rollout_path: String,
}

fn find_codex_state_thread(home: &Path, thread_id: &str) -> Result<CodexStateThread, String> {
    let mut candidates = codex_state_db_candidates(home)?;
    candidates.sort();
    candidates.reverse();

    for db_path in candidates {
        let Ok(conn) =
            Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            continue;
        };
        if !table_has_columns(&conn, "threads", &["id", "rollout_path"])? {
            continue;
        }
        let rollout_path = conn
            .query_row(
                "SELECT rollout_path FROM threads WHERE id = ?1",
                params![thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| format!("query Codex thread index failed: {err}"))?;
        if let Some(rollout_path) = rollout_path {
            return Ok(CodexStateThread {
                db_path,
                rollout_path,
            });
        }
    }

    Err(format!(
        "Codex direct delete unavailable: thread {thread_id} was not found in state_*.sqlite"
    ))
}

fn codex_state_db_candidates(home: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = fs::read_dir(home)
        .map_err(|err| format!("read Codex home {} failed: {err}", home.display()))?;
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let is_state_db =
            name == "state.sqlite" || (name.starts_with("state_") && name.ends_with(".sqlite"));
        if is_state_db {
            candidates.push(path);
        }
    }
    Ok(candidates)
}

fn ensure_codex_rollout_path(home: &Path, rollout_path: &Path) -> Result<(), String> {
    let sessions_root = home
        .join("sessions")
        .canonicalize()
        .map_err(|err| format!("resolve Codex sessions root failed: {err}"))?;

    if rollout_path.is_file() {
        let canonical = rollout_path
            .canonicalize()
            .map_err(|err| format!("resolve Codex rollout file failed: {err}"))?;
        if canonical.starts_with(&sessions_root) {
            return Ok(());
        }
    } else if let Some(parent) = rollout_path.parent().filter(|parent| parent.is_dir()) {
        let canonical_parent = parent
            .canonicalize()
            .map_err(|err| format!("resolve Codex rollout parent failed: {err}"))?;
        if canonical_parent.starts_with(&sessions_root) {
            return Ok(());
        }
    }

    Err(format!(
        "Codex direct delete refused: rollout path is outside {}: {}",
        sessions_root.display(),
        rollout_path.display()
    ))
}

fn delete_codex_thread_refs(tx: &Transaction<'_>, thread_id: &str) -> Result<(), String> {
    if !table_has_columns(tx, "threads", &["id"])? {
        return Err("Codex direct delete unavailable: threads table is missing id".into());
    }

    delete_if_table_has_columns(tx, "thread_dynamic_tools", &["thread_id"], thread_id)?;
    delete_if_table_has_columns(
        tx,
        "thread_spawn_edges",
        &["parent_thread_id", "child_thread_id"],
        thread_id,
    )?;
    delete_if_table_has_columns(tx, "agent_jobs", &["thread_id"], thread_id)?;

    let deleted = tx
        .execute("DELETE FROM threads WHERE id = ?1", params![thread_id])
        .map_err(|err| format!("delete Codex thread index failed: {err}"))?;
    if deleted != 1 {
        return Err(format!(
            "Codex direct delete refused: expected 1 thread row for {thread_id}, deleted {deleted}"
        ));
    }
    Ok(())
}

fn delete_if_table_has_columns(
    tx: &Transaction<'_>,
    table: &str,
    columns: &[&str],
    thread_id: &str,
) -> Result<(), String> {
    if !table_has_columns(tx, table, columns)? {
        return Ok(());
    }

    let where_clause = columns
        .iter()
        .map(|column| format!("{column} = ?1"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let sql = format!("DELETE FROM {table} WHERE {where_clause}");
    tx.execute(&sql, params![thread_id])
        .map_err(|err| format!("delete Codex {table} refs failed: {err}"))?;
    Ok(())
}

trait SqliteSchema {
    fn table_columns(&self, table: &str) -> rusqlite::Result<Vec<String>>;
}

impl SqliteSchema for Connection {
    fn table_columns(&self, table: &str) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.prepare(&format!("PRAGMA table_info({table})"))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.collect()
    }
}

impl SqliteSchema for Transaction<'_> {
    fn table_columns(&self, table: &str) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.prepare(&format!("PRAGMA table_info({table})"))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.collect()
    }
}

fn table_has_columns(
    db: &impl SqliteSchema,
    table: &str,
    required: &[&str],
) -> Result<bool, String> {
    let columns = db
        .table_columns(table)
        .map_err(|err| format!("read Codex {table} schema failed: {err}"))?;
    Ok(required
        .iter()
        .all(|required| columns.iter().any(|column| column == required)))
}

fn parse_codex_thread_messages(result: &Value) -> Vec<StoredChatMessage> {
    let thread = result.get("thread").unwrap_or(result);
    let Some(turns) = thread.get("turns").and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    let mut messages = Vec::new();
    for turn in turns {
        let created_at =
            timestamp_to_rfc3339(turn.get("startedAt")).unwrap_or_else(|| Utc::now().to_rfc3339());
        let Some(items) = turn.get("items").and_then(|v| v.as_array()) else {
            continue;
        };
        for item in items {
            messages.extend(parse_codex_thread_item(item, &created_at));
        }
    }
    messages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_history_items_map_to_workbench_messages() {
        let result = serde_json::json!({
            "thread": {
                "turns": [
                    {
                        "startedAt": 1710000000,
                        "items": [
                            {
                                "type": "userMessage",
                                "content": [
                                    { "type": "text", "text": "hello" }
                                ]
                            },
                            {
                                "type": "agentMessage",
                                "phase": "interim",
                                "text": "thinking"
                            },
                            {
                                "type": "reasoning",
                                "summary": ["step one", "step two"]
                            },
                            {
                                "type": "commandExecution",
                                "command": "ls",
                                "status": "completed"
                            },
                            {
                                "type": "fileChange",
                                "changes": [{ "path": "src/main.rs" }]
                            },
                            {
                                "type": "agentMessage",
                                "text": "done"
                            }
                        ]
                    }
                ]
            }
        });

        let messages = parse_codex_thread_messages(&result);

        assert_eq!(messages.len(), 6);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello");
        assert_eq!(messages[1].role, "thought");
        assert_eq!(messages[1].content, "thinking");
        assert_eq!(messages[2].role, "thought");
        assert_eq!(messages[2].content, "step one\n\nstep two");
        assert_eq!(messages[3].role, "tool");
        assert_eq!(messages[3].content, "command: ls · completed");
        assert_eq!(messages[4].role, "tool");
        assert_eq!(messages[4].content, "file changes: 1");
        assert_eq!(messages[5].role, "assistant");
        assert_eq!(messages[5].content, "done");
        assert_eq!(messages[0].runtime_id, Some(RuntimeId::CODEX));
        assert_eq!(messages[0].created_at, "2024-03-09T16:00:00+00:00");
    }

    #[test]
    fn empty_or_missing_turns_do_not_import_anything() {
        assert!(parse_codex_thread_messages(&serde_json::json!({})).is_empty());
        assert!(parse_codex_thread_messages(&serde_json::json!({
            "thread": { "turns": [] }
        }))
        .is_empty());
    }

    #[test]
    fn acp_chat_history_items_map_to_workbench_messages() {
        let user = parse_acp_chat_item(
            RuntimeId::GROK,
            &serde_json::json!({
                "type": "user",
                "content": [{ "type": "text", "text": "<user_query>\n你好\n</user_query>" }],
                "created_at": "2026-07-24T07:09:10Z"
            }),
        );
        let reminder = parse_acp_chat_item(
            RuntimeId::GROK,
            &serde_json::json!({
                "type": "user",
                "content": [{ "type": "text", "text": "<system-reminder>ignore</system-reminder>" }]
            }),
        );
        let reasoning = parse_acp_chat_item(
            RuntimeId::GROK,
            &serde_json::json!({
                "type": "reasoning",
                "summary": [{ "type": "summary_text", "text": "thinking" }]
            }),
        );
        let assistant = parse_acp_chat_item(
            RuntimeId::GROK,
            &serde_json::json!({
                "type": "assistant",
                "content": "done"
            }),
        );
        let tool = parse_acp_chat_item(
            RuntimeId::GROK,
            &serde_json::json!({
                "type": "tool_result",
                "content": "read file"
            }),
        );

        assert_eq!(user.len(), 1);
        assert_eq!(user[0].role, "user");
        assert_eq!(user[0].content, "你好");
        assert_eq!(user[0].runtime_id, Some(RuntimeId::GROK));
        assert_eq!(user[0].created_at, "2026-07-24T07:09:10Z");
        assert!(reminder.is_empty());
        assert_eq!(reasoning[0].role, "thought");
        assert_eq!(reasoning[0].content, "thinking");
        assert_eq!(assistant[0].role, "assistant");
        assert_eq!(assistant[0].content, "done");
        assert_eq!(tool[0].role, "tool");
        assert_eq!(tool[0].content, "read file");
    }
}

fn parse_codex_thread_item(item: &Value, created_at: &str) -> Vec<StoredChatMessage> {
    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match item_type {
        "userMessage" => message_from_text(
            "user",
            user_message_text(item),
            RuntimeId::CODEX,
            created_at,
        ),
        "agentMessage" => {
            let role = match item.get("phase").and_then(|v| v.as_str()) {
                Some("interim") => "thought",
                _ => "assistant",
            };
            message_from_text(
                role,
                clean_str(item.get("text")),
                RuntimeId::CODEX,
                created_at,
            )
        }
        "reasoning" => message_from_text(
            "thought",
            reasoning_text(item),
            RuntimeId::CODEX,
            created_at,
        ),
        "plan" => message_from_text(
            "tool",
            clean_str(item.get("text")),
            RuntimeId::CODEX,
            created_at,
        ),
        "commandExecution"
        | "fileChange"
        | "mcpToolCall"
        | "dynamicToolCall"
        | "collabAgentToolCall"
        | "subAgentActivity"
        | "webSearch"
        | "imageView"
        | "sleep"
        | "imageGeneration"
        | "enteredReviewMode"
        | "exitedReviewMode"
        | "contextCompaction" => message_from_text(
            "tool",
            tool_summary(item_type, item),
            RuntimeId::CODEX,
            created_at,
        ),
        _ => Vec::new(),
    }
}

fn message_from_text(
    role: &str,
    content: Option<String>,
    runtime_id: RuntimeId,
    created_at: &str,
) -> Vec<StoredChatMessage> {
    content
        .map(|content| StoredChatMessage::imported(role, content, Some(runtime_id), created_at))
        .into_iter()
        .collect()
}

fn user_message_text(item: &Value) -> Option<String> {
    let parts = item
        .get("content")?
        .as_array()?
        .iter()
        .filter_map(
            |part| match part.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "text" => clean_str(part.get("text")),
                "image" => clean_str(part.get("url")).map(|url| format!("[image] {url}")),
                "localImage" => clean_str(part.get("path")).map(|path| format!("[image] {path}")),
                "skill" => clean_str(part.get("name")).map(|name| format!("[skill] {name}")),
                "mention" => clean_str(part.get("name")).map(|name| format!("[mention] {name}")),
                _ => None,
            },
        )
        .collect::<Vec<_>>();
    join_non_empty(parts)
}

fn reasoning_text(item: &Value) -> Option<String> {
    string_array_text(item.get("summary")).or_else(|| string_array_text(item.get("content")))
}

fn string_array_text(value: Option<&Value>) -> Option<String> {
    let parts = value?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::trim))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    join_non_empty(parts)
}

fn tool_summary(item_type: &str, item: &Value) -> Option<String> {
    let status = clean_str(item.get("status"));
    let label = match item_type {
        "commandExecution" => clean_str(item.get("command")).map(|cmd| format!("command: {cmd}")),
        "fileChange" => item
            .get("changes")
            .and_then(|v| v.as_array())
            .map(|changes| format!("file changes: {}", changes.len())),
        "mcpToolCall" => {
            let server = clean_str(item.get("server")).unwrap_or_else(|| "mcp".into());
            let tool = clean_str(item.get("tool")).unwrap_or_else(|| "tool".into());
            Some(format!("{server}/{tool}"))
        }
        "dynamicToolCall" | "collabAgentToolCall" => {
            clean_str(item.get("tool")).or_else(|| Some(item_type.to_string()))
        }
        "subAgentActivity" => {
            clean_str(item.get("message")).or_else(|| Some("sub-agent activity".into()))
        }
        "webSearch" => Some("web search".into()),
        "imageView" => Some("image view".into()),
        "sleep" => Some("sleep".into()),
        "imageGeneration" => Some("image generation".into()),
        "enteredReviewMode" => Some("entered review mode".into()),
        "exitedReviewMode" => Some("exited review mode".into()),
        "contextCompaction" => Some("context compaction".into()),
        _ => None,
    }?;

    let text = if let Some(status) = status {
        format!("{label} · {status}")
    } else {
        label
    };
    Some(compact_text(&text, TOOL_SUMMARY_MAX_CHARS))
}

fn clean_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn join_non_empty(parts: Vec<String>) -> Option<String> {
    let text = parts
        .into_iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn compact_text(text: &str, max_chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max_chars {
        return text;
    }
    let mut out = text
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    out.push_str("...");
    out
}

fn timestamp_or_now(value: Option<&Value>) -> String {
    timestamp_to_rfc3339(value).unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn timestamp_to_rfc3339(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let seconds = value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|v| i64::try_from(v).ok()))
        .or_else(|| value.as_f64().map(|v| v as i64));
    if let Some(seconds) = seconds {
        return Some(
            Utc.timestamp_opt(seconds, 0)
                .single()
                .unwrap_or_else(Utc::now)
                .to_rfc3339(),
        );
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

struct JsonRpcClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

impl JsonRpcClient {
    fn spawn(cli: &Path) -> Result<Self, String> {
        let mut cmd = Command::new(cli);
        cmd.args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        process_util::apply_no_window_tokio(&mut cmd);
        if let Some(path) = process_util::enriched_path_env() {
            cmd.env("PATH", path);
        }
        process_util::clear_proxy_env_tokio(&mut cmd);
        cmd.env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost");

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn Codex app-server: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex stdin missing".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex stdout missing".to_string())?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "clientInfo": { "name": "workbench", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true, "requestAttestation": false }
            }),
        )
        .await?;
        self.notify("initialized", None).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "id": id, "method": method, "params": params });
        self.write(&msg).await?;

        timeout(Duration::from_secs(CODEX_RPC_TIMEOUT_SECS), async {
            loop {
                let msg = self.read_message().await?;
                if msg.get("id").and_then(|v| v.as_u64()) != Some(id) {
                    continue;
                }
                if let Some(err) = msg.get("error") {
                    return Err(format!("codex {method} failed: {err}"));
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
        })
        .await
        .map_err(|_| format!("codex {method} timed out"))?
    }

    async fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let msg = match params {
            Some(params) => json!({ "method": method, "params": params }),
            None => json!({ "method": method }),
        };
        self.write(&msg).await
    }

    async fn write(&mut self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn read_message(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        loop {
            line.clear();
            let n = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("codex app-server stdout closed".into());
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            return serde_json::from_str(trimmed).map_err(|e| e.to_string());
        }
    }
}

impl Drop for JsonRpcClient {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
