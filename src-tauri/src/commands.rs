//! Tauri command surface for the Workbench UI.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use chrono::Utc;
use tauri::{AppHandle, Manager};

use crate::host::permissions::PermissionDecision;
use crate::native_sessions;
use crate::paths;
use crate::route_diagnostics::{self, CodexRouteStatus};
use crate::runtime::{self, NativeSessionSource, RuntimeId, SessionSelectionCatalog};
use crate::session_manager::{SessionManager, SessionMeta, SessionSettingsPatch, SessionSnapshot};
use crate::session_store::{self, StoredChatMessage};
use crate::settings::{self, AppSettings, RuntimeOverride};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPresentationPatch {
    pub title: Option<String>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionSyncResult {
    pub runtime_id: RuntimeId,
    pub sessions: Vec<SessionMeta>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteResult {
    pub deleted_session_id: String,
    pub deleted_path: String,
    pub active_session_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExportResult {
    pub session_id: String,
    pub path: String,
    pub message_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTraceExportResult {
    pub session_id: String,
    pub path: String,
    pub event_count: usize,
}

/// Sync native window fill with UI theme so rounded corners don't show a dark halo.
#[tauri::command]
pub fn window_set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let light = theme.eq_ignore_ascii_case("light");
    // Match CSS --bg-app
    let color = if light {
        tauri::window::Color(244, 244, 245, 255) // #f4f4f5
    } else {
        tauri::window::Color(13, 13, 13, 255) // #0d0d0d
    };
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_background_color(Some(color))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "Workbench",
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": paths::data_dir().display().to_string(),
    })
}

#[tauri::command]
pub fn list_runtimes() -> Vec<runtime::RuntimeDescriptor> {
    runtime::list_descriptors()
}

#[tauri::command]
pub async fn probe_all() -> Vec<runtime::ProbeResult> {
    runtime::probe_all().await
}

#[tauri::command]
pub async fn probe_runtime(runtime_id: String) -> Result<runtime::ProbeResult, String> {
    let id =
        RuntimeId::parse(&runtime_id).ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;
    runtime::probe_runtime(id)
        .await
        .ok_or_else(|| format!("runtime not registered: {runtime_id}"))
}

#[tauri::command]
pub fn codex_route_status() -> CodexRouteStatus {
    route_diagnostics::codex_route_status()
}

#[tauri::command]
pub fn claude_route_status() -> route_diagnostics::ClaudeRouteStatus {
    route_diagnostics::claude_route_status()
}

#[tauri::command]
pub fn open_cc_switch() -> Result<String, String> {
    route_diagnostics::open_cc_switch()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub source: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResult {
    pub runtime_id: String,
    pub skills: Vec<SkillInfo>,
    pub searched_paths: Vec<String>,
}

/// Discover skill manifests without invoking or modifying a user's CLI.
/// Project-local skills win over user-level skills with the same name.
#[tauri::command]
pub fn skills_list(
    runtime_id: String,
    project_path: Option<String>,
) -> Result<SkillsListResult, String> {
    let id = runtime_id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return Err("runtime id cannot be empty".into());
    }

    let mut roots = Vec::<(PathBuf, &'static str)>::new();
    if let Some(raw) = project_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let project = PathBuf::from(raw);
        // Generic `.agents/skills` is used by Codex; runtime-specific folders
        // cover CLIs that keep skills under their own project namespace.
        roots.push((project.join(".agents").join("skills"), "project"));
        roots.push((project.join(format!(".{id}")).join("skills"), "project"));
        roots.push((project.join("skills"), "project"));
    }

    let runtime = crate::runtime::RuntimeId::parse(&id)
        .ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;
    let manifest = crate::runtime::manifest::get(runtime)
        .ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;
    let home = manifest.resolve_home();
    roots.push((home.join("skills"), "user"));

    // Keep conventional homes as a fallback even when the manifest resolves
    // to Workbench's isolated home because the CLI is not authenticated yet.
    let user_home = crate::process_util::user_home();
    roots.push((user_home.join(format!(".{id}")).join("skills"), "user"));

    let mut searched_paths = Vec::new();
    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    for (root, source) in roots {
        if !root.is_dir() {
            continue;
        }
        searched_paths.push(root.display().to_string());
        for manifest_path in find_skill_manifests(&root, 3) {
            let fallback_name = manifest_path
                .parent()
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().trim().to_string())
                .unwrap_or_default();
            let (name, description) = parse_skill_header(&manifest_path, &fallback_name);
            if name.is_empty() {
                continue;
            }
            let key = name.to_ascii_lowercase();
            if !seen.insert(key) {
                continue;
            }
            skills.push(SkillInfo {
                name,
                description,
                source: source.to_string(),
                path: Some(manifest_path.display().to_string()),
            });
        }
    }

    Ok(SkillsListResult {
        runtime_id: id,
        skills,
        searched_paths,
    })
}

fn find_skill_manifests(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
        if depth > max_depth {
            return;
        }
        let manifest = dir.join("SKILL.md");
        if manifest.is_file() {
            out.push(manifest);
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut dirs = entries
            .flatten()
            // Follow bounded skill-directory junctions (common on Windows
            // when multiple CLIs share the same installed skill).
            .filter(|entry| entry.path().is_dir())
            .collect::<Vec<_>>();
        dirs.sort_by_key(|entry| entry.file_name());
        for entry in dirs {
            walk(&entry.path(), depth + 1, max_depth, out);
        }
    }

    let mut out = Vec::new();
    walk(root, 0, max_depth, &mut out);
    out
}

fn parse_skill_header(path: &Path, fallback_name: &str) -> (String, String) {
    let Ok(text) = fs::read_to_string(path) else {
        return (fallback_name.to_string(), String::new());
    };
    let mut name = String::new();
    let mut description = String::new();
    let mut in_frontmatter = false;
    for line in text.lines().take(80) {
        let trimmed = line.trim();
        if trimmed == "---" {
            if in_frontmatter {
                break;
            }
            in_frontmatter = true;
            continue;
        }
        if !in_frontmatter {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("name:") {
            name = value.trim().trim_matches(['"', '\'']).to_string();
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            description = value.trim().trim_matches(['"', '\'']).to_string();
        }
    }
    if name.is_empty() {
        name = fallback_name.to_string();
    }
    (name, description)
}

#[tauri::command]
pub fn session_open_location(session_id: String) -> Result<String, String> {
    let path = session_store::session_dir_path(&session_id).map_err(|e| e.to_string())?;
    open_in_file_manager(&path)?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn session_list(mgr: tauri::State<'_, Arc<SessionManager>>) -> Vec<SessionMeta> {
    mgr.list()
}

#[tauri::command]
pub fn session_create(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    runtime_id: String,
    project_path: Option<String>,
) -> Result<SessionMeta, String> {
    let id =
        RuntimeId::parse(&runtime_id).ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;
    mgr.create(id, project_path)
}

#[tauri::command]
pub fn session_update_presentation(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    patch: SessionPresentationPatch,
) -> Result<SessionMeta, String> {
    mgr.update_presentation(&session_id, patch.title, patch.pinned)
}

#[tauri::command]
pub fn session_update_project(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    project_path: String,
) -> Result<SessionMeta, String> {
    mgr.update_project_path(&session_id, project_path)
}

#[tauri::command]
pub async fn project_pick_directory(
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pick_project_directory(initial_path.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

fn pick_project_directory(initial_path: Option<&str>) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择会话工作目录'
$dialog.ShowNewFolderButton = $true
if ($env:WORKBENCH_PICKER_DIR -and (Test-Path -LiteralPath $env:WORKBENCH_PICKER_DIR -PathType Container)) {
  $dialog.SelectedPath = $env:WORKBENCH_PICKER_DIR
}
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}
"#;
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
        if let Some(path) = initial_path.filter(|path| !path.trim().is_empty()) {
            command.env("WORKBENCH_PICKER_DIR", path);
        }
        crate::process_util::apply_no_window_std(&mut command);
        let output = command.output().map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if selected.is_empty() {
            return Ok(None);
        }
        let path = PathBuf::from(&selected);
        if !path.is_dir() {
            return Err(format!("selected directory does not exist: {selected}"));
        }
        return Ok(Some(selected));
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .args([
                "-e",
                "POSIX path of (choose folder with prompt \"选择会话工作目录\")",
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!selected.is_empty()).then_some(selected));
    }

    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("zenity");
        command.args([
            "--file-selection",
            "--directory",
            "--title=选择会话工作目录",
        ]);
        if let Some(path) = initial_path.filter(|path| !path.trim().is_empty()) {
            command.arg(format!("--filename={path}/"));
        }
        let output = command.output().map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!selected.is_empty()).then_some(selected));
    }

    #[allow(unreachable_code)]
    Err("folder picker is not supported on this platform".into())
}

#[tauri::command]
pub async fn session_set_archived(
    app: AppHandle,
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    archived: bool,
) -> Result<SessionMeta, String> {
    mgr.set_archived(&app, &session_id, archived).await
}

#[tauri::command]
pub fn session_get_state(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: Option<String>,
) -> SessionSnapshot {
    mgr.snapshot(session_id.as_deref())
}

#[tauri::command]
pub fn session_list_states(mgr: tauri::State<'_, Arc<SessionManager>>) -> Vec<SessionSnapshot> {
    mgr.snapshots()
}

#[tauri::command]
pub async fn session_update_settings(
    app: AppHandle,
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    patch: SessionSettingsPatch,
) -> Result<SessionMeta, String> {
    mgr.update_settings(&app, &session_id, patch).await
}

#[tauri::command]
pub async fn session_get_messages(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<Vec<StoredChatMessage>, String> {
    mgr.messages(&session_id).await
}

#[tauri::command]
pub async fn session_export_markdown(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<SessionExportResult, String> {
    let meta = mgr.session_meta(&session_id)?;
    let messages = mgr.messages(&session_id).await?;
    let exported_at = Utc::now().to_rfc3339();
    let markdown = render_session_markdown(
        &meta.title,
        meta.runtime_id,
        meta.project_path.as_deref(),
        &messages,
        &exported_at,
    );
    let path = session_store::write_markdown_export(&session_id, &meta.title, &markdown)
        .map_err(|err| err.to_string())?;
    if let Some(parent) = path.parent() {
        if let Err(err) = open_in_file_manager(parent) {
            tracing::warn!(
                "failed to open export directory {}: {err}",
                parent.display()
            );
        }
    }
    Ok(SessionExportResult {
        session_id,
        path: path.display().to_string(),
        message_count: messages.len(),
    })
}

#[tauri::command]
pub fn session_export_trace(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<SessionTraceExportResult, String> {
    let meta = mgr.session_meta(&session_id)?;
    let (path, event_count) = session_store::write_trace_export(&session_id, &meta.title)
        .map_err(|err| err.to_string())?;
    if let Some(parent) = path.parent() {
        if let Err(err) = open_in_file_manager(parent) {
            tracing::warn!(
                "failed to open trace export directory {}: {err}",
                parent.display()
            );
        }
    }
    Ok(SessionTraceExportResult {
        session_id,
        path: path.display().to_string(),
        event_count,
    })
}

#[tauri::command]
pub async fn session_delete(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    delete_native: Option<bool>,
    native_delete_mode: Option<String>,
) -> Result<SessionDeleteResult, String> {
    let meta = mgr.session_meta(&session_id)?;
    let native_delete_mode = native_delete_mode.unwrap_or_else(|| {
        if delete_native.unwrap_or(true) {
            "official".to_string()
        } else {
            "skip".to_string()
        }
    });
    if !matches!(native_delete_mode.as_str(), "official" | "direct" | "skip") {
        return Err(format!(
            "unsupported native delete mode: {native_delete_mode}"
        ));
    }
    if native_delete_mode.as_str() != "skip" {
        match runtime::manifest::get(meta.runtime_id).and_then(|manifest| manifest.native_sessions)
        {
            Some(NativeSessionSource::CodexAppServer) => {
                if let Some(thread_id) = meta
                    .native_thread_id
                    .as_deref()
                    .filter(|id| !id.trim().is_empty())
                {
                    match native_delete_mode.as_str() {
                        "official" => {
                            crate::native_sessions::delete_codex_thread(thread_id).await?
                        }
                        "direct" => {
                            crate::native_sessions::delete_codex_thread_direct(thread_id).await?
                        }
                        other => return Err(format!("unsupported native delete mode: {other}")),
                    }
                }
            }
            Some(NativeSessionSource::AcpSummaryFiles) => {
                if let Some(native_session_id) = meta
                    .native_session_id
                    .as_deref()
                    .filter(|id| !id.trim().is_empty())
                {
                    match native_delete_mode.as_str() {
                        "official" | "direct" => {
                            crate::native_sessions::delete_acp_summary_session(
                                meta.runtime_id,
                                native_session_id,
                            )
                            .await?
                        }
                        other => return Err(format!("unsupported native delete mode: {other}")),
                    }
                }
            }
            Some(NativeSessionSource::ClaudeProjectJsonl) => {
                if let Some(native_session_id) = meta
                    .native_session_id
                    .as_deref()
                    .filter(|id| !id.trim().is_empty())
                {
                    match native_delete_mode.as_str() {
                        "official" | "direct" => {
                            crate::native_sessions::delete_claude_project_jsonl_session(
                                meta.runtime_id,
                                native_session_id,
                            )
                            .await?
                        }
                        other => return Err(format!("unsupported native delete mode: {other}")),
                    }
                }
            }
            Some(NativeSessionSource::KimiWireJsonl) => {
                if let Some(native_session_id) = meta
                    .native_session_id
                    .as_deref()
                    .filter(|id| !id.trim().is_empty())
                {
                    match native_delete_mode.as_str() {
                        "official" | "direct" => {
                            crate::native_sessions::delete_kimi_wire_jsonl_session(
                                meta.runtime_id,
                                native_session_id,
                            )
                            .await?
                        }
                        other => return Err(format!("unsupported native delete mode: {other}")),
                    }
                }
            }
            None => {}
        }
    }
    let path = session_store::session_dir_path(&session_id).map_err(|e| e.to_string())?;
    let active_session_id = mgr.delete_session(&session_id).await?;
    Ok(SessionDeleteResult {
        deleted_session_id: session_id,
        deleted_path: path.display().to_string(),
        active_session_id,
    })
}

#[tauri::command]
pub async fn session_control_options(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<SessionSelectionCatalog, String> {
    let snapshot = mgr.snapshot(Some(&session_id));
    let runtime_id = snapshot
        .runtime_id
        .ok_or_else(|| "session not found".to_string())?;
    let current_model = snapshot.model_id.clone();
    let cwd = snapshot
        .project_path
        .clone()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(paths::data_dir);

    // Which models and modes exist is the adapter's knowledge; the default impl
    // answers from the manifest, Codex overrides it with a live config read.
    let runtime = runtime::get_enabled_runtime(runtime_id)?;
    runtime.selection_catalog(cwd, current_model).await
}

#[tauri::command]
pub fn session_permission_respond(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    request_id: String,
    decision: PermissionDecision,
) -> Result<(), String> {
    mgr.respond_permission(&session_id, &request_id, decision)
}

#[tauri::command]
pub fn settings_get() -> AppSettings {
    settings::get()
}

/// Re-read `settings.json` after the user edited it by hand. Runtime manifests
/// are cached for the process lifetime, so a new `runtimes/*.json` still needs
/// a restart — only the overrides in this file are picked up live.
#[tauri::command]
pub fn settings_reload() -> AppSettings {
    settings::reload()
}

/// Point a runtime at a custom binary / home, or switch it off entirely.
/// `None` fields clear the override rather than leaving a stale value behind.
#[tauri::command]
pub fn settings_set_runtime_override(
    runtime_id: String,
    patch: RuntimeOverride,
) -> Result<AppSettings, String> {
    let id =
        RuntimeId::parse(&runtime_id).ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;
    settings::set_runtime_override(id.as_str(), patch)
}

#[tauri::command]
pub async fn session_sync_native(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    runtime_id: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<NativeSessionSyncResult, String> {
    let runtime_id =
        RuntimeId::parse(&runtime_id).ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;
    let page = native_sessions::sync_native_sessions(
        runtime_id,
        limit.unwrap_or(30) as usize,
        cursor.filter(|s| !s.trim().is_empty()),
    )
    .await?;
    let sessions = mgr.upsert_native_sessions(page.items);
    Ok(NativeSessionSyncResult {
        runtime_id: page.runtime_id,
        sessions,
        next_cursor: page.next_cursor,
        has_more: page.has_more,
    })
}

fn render_session_markdown(
    title: &str,
    runtime_id: RuntimeId,
    project_path: Option<&str>,
    messages: &[StoredChatMessage],
    exported_at: &str,
) -> String {
    let mut markdown = String::new();
    let title = single_line_markdown(title);
    let _ = writeln!(markdown, "# {title}\n");
    let _ = writeln!(markdown, "- Runtime: `{}`", runtime_id.as_str());
    if let Some(project_path) = project_path.filter(|path| !path.trim().is_empty()) {
        let _ = writeln!(
            markdown,
            "- Project: `{}`",
            single_line_markdown(project_path).replace('`', "'")
        );
    }
    let _ = writeln!(markdown, "- Exported: `{exported_at}`");

    if messages.is_empty() {
        markdown.push_str("\n---\n\n_No messages._\n");
        return markdown;
    }

    for message in messages {
        let heading = match message.role.as_str() {
            "user" => "User".to_string(),
            "assistant" => "Assistant".to_string(),
            "system" => "System".to_string(),
            "thought" => "Reasoning".to_string(),
            "tool" => {
                let name = message
                    .tool_title
                    .as_deref()
                    .or(message.tool_name.as_deref())
                    .unwrap_or("Tool");
                format!("Tool · {}", single_line_markdown(name))
            }
            other => single_line_markdown(other),
        };
        let _ = writeln!(markdown, "\n---\n\n## {heading}\n");
        let _ = writeln!(markdown, "> {}", message.created_at);
        if let Some(status) = message.tool_status.as_deref() {
            let _ = writeln!(markdown, "> Status: {}", single_line_markdown(status));
        }
        if message.partial {
            markdown.push_str("> Incomplete response checkpoint\n");
        }
        markdown.push('\n');
        let content = message.content.trim_end();
        if content.is_empty() {
            markdown.push_str("_Empty message._\n");
        } else {
            markdown.push_str(content);
            markdown.push('\n');
        }
    }
    markdown
}

fn single_line_markdown(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn open_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("open location is not supported on this platform".into())
}

#[tauri::command]
pub async fn session_connect(
    app: AppHandle,
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<SessionSnapshot, String> {
    let mgr = mgr.inner().clone();
    mgr.connect(&app, &session_id).await
}

#[tauri::command]
pub async fn session_send(
    app: AppHandle,
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let mgr = mgr.inner().clone();
    mgr.send(app, session_id, text).await
}

#[tauri::command]
pub async fn session_stop(
    app: AppHandle,
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    mgr.stop(&app, &session_id).await
}

#[tauri::command]
pub async fn session_disconnect(
    app: AppHandle,
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    mgr.disconnect(&app, &session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_export_contains_metadata_and_messages() {
        let mut tool = StoredChatMessage::new("tool", "read src/App.tsx", Some(RuntimeId::CODEX));
        tool.tool_title = Some("Read file".into());
        tool.tool_status = Some("completed".into());
        let messages = vec![
            StoredChatMessage::new("user", "Inspect the project", Some(RuntimeId::CODEX)),
            StoredChatMessage::new("assistant", "Done.", Some(RuntimeId::CODEX)),
            tool,
        ];

        let markdown = render_session_markdown(
            "Review session",
            RuntimeId::CODEX,
            Some("X:\\work"),
            &messages,
            "2026-07-29T00:00:00Z",
        );

        assert!(markdown.contains("# Review session"));
        assert!(markdown.contains("- Runtime: `codex`"));
        assert!(markdown.contains("## User"));
        assert!(markdown.contains("## Assistant"));
        assert!(markdown.contains("## Tool · Read file"));
        assert!(markdown.contains("> Status: completed"));
    }
}
