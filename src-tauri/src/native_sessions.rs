//! Read-only import of runtime-native session indexes.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::{timeout, Duration};
use which::which;

use crate::process_util;
use crate::runtime::RuntimeId;
use crate::session_store::StoredChatMessage;

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

pub async fn sync_native_sessions(
    runtime_id: RuntimeId,
    limit: usize,
    cursor: Option<String>,
) -> Result<NativeSessionPage, String> {
    let limit = limit.clamp(1, 100);
    match runtime_id {
        RuntimeId::Grok => sync_grok_sessions(limit, cursor),
        RuntimeId::Codex => sync_codex_threads(limit, cursor).await,
        _ => Err(format!(
            "{} is not enabled for native session sync",
            runtime_id.display_name()
        )),
    }
}

fn sync_grok_sessions(limit: usize, cursor: Option<String>) -> Result<NativeSessionPage, String> {
    let home = resolve_grok_home();
    let root = home.join("sessions");
    if !root.is_dir() {
        return Ok(NativeSessionPage {
            runtime_id: RuntimeId::Grok,
            items: Vec::new(),
            next_cursor: None,
            has_more: false,
        });
    }

    let mut all = Vec::new();
    collect_grok_summaries(&root, &home, &mut all)?;
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
        runtime_id: RuntimeId::Grok,
        next_cursor: has_more.then(|| next.to_string()),
        has_more,
        items,
    })
}

fn collect_grok_summaries(
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
            collect_grok_summaries(&path, home, out)?;
            continue;
        }
        if path.file_name().and_then(|name| name.to_str()) != Some("summary.json") {
            continue;
        }
        if let Some(item) = parse_grok_summary(&path, home) {
            out.push(item);
        }
    }
    Ok(())
}

fn parse_grok_summary(path: &Path, home: &Path) -> Option<NativeSessionItem> {
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
        .unwrap_or("Grok session")
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
        runtime_id: RuntimeId::Grok,
        native_source: "grok".into(),
        native_session_id: Some(session_id),
        native_thread_id: None,
        native_home: Some(home.display().to_string()),
        title: if title.is_empty() {
            "Grok session".into()
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

async fn sync_codex_threads(
    limit: usize,
    cursor: Option<String>,
) -> Result<NativeSessionPage, String> {
    let cli = resolve_codex_path().ok_or_else(|| "Codex CLI not found".to_string())?;
    let home = resolve_codex_home();
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
                .filter_map(|thread| parse_codex_thread(thread, &home))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let next_cursor = result
        .get("nextCursor")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Ok(NativeSessionPage {
        runtime_id: RuntimeId::Codex,
        has_more: next_cursor.is_some(),
        next_cursor,
        items,
    })
}

fn parse_codex_thread(thread: &Value, home: &Path) -> Option<NativeSessionItem> {
    let thread_id = thread.get("id").and_then(|v| v.as_str())?.to_string();
    let session_id = thread
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let preview = clean_str(thread.get("preview"));
    let title = clean_str(thread.get("name"))
        .or_else(|| clean_str(thread.get("title")))
        .or_else(|| preview.as_ref().map(|s| compact_text(s, 80)))
        .unwrap_or_else(|| "Codex session".into());
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
        runtime_id: RuntimeId::Codex,
        native_source: "codex".into(),
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
    let cli = resolve_codex_path().ok_or_else(|| "Codex CLI not found".to_string())?;
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

fn parse_codex_thread_item(item: &Value, created_at: &str) -> Vec<StoredChatMessage> {
    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match item_type {
        "userMessage" => message_from_text(
            "user",
            user_message_text(item),
            RuntimeId::Codex,
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
                RuntimeId::Codex,
                created_at,
            )
        }
        "reasoning" => message_from_text(
            "thought",
            reasoning_text(item),
            RuntimeId::Codex,
            created_at,
        ),
        "plan" => message_from_text(
            "tool",
            clean_str(item.get("text")),
            RuntimeId::Codex,
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
            RuntimeId::Codex,
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

fn resolve_grok_home() -> PathBuf {
    if let Ok(h) = std::env::var("GROK_HOME") {
        let p = PathBuf::from(h);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    process_util::user_home().join(".grok")
}

fn resolve_codex_home() -> PathBuf {
    if let Ok(h) = std::env::var("CODEX_HOME") {
        let p = PathBuf::from(h);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    process_util::user_home().join(".codex")
}

fn resolve_codex_path() -> Option<PathBuf> {
    if let Ok(p) = which("codex") {
        return Some(p);
    }
    let candidates = [
        r"D:\codex\codex.exe",
        r"%USERPROFILE%\.codex\bin\codex.exe",
        r"%LOCALAPPDATA%\Programs\codex\codex.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(expand_env(c));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn expand_env(s: &str) -> String {
    let mut out = s.to_string();
    if let Ok(v) = std::env::var("USERPROFILE") {
        out = out.replace("%USERPROFILE%", &v);
    }
    if let Ok(v) = std::env::var("LOCALAPPDATA") {
        out = out.replace("%LOCALAPPDATA%", &v);
    }
    out
}
