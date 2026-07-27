//! Tauri command surface for the Workbench UI.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::native_sessions;
use crate::paths;
use crate::route_diagnostics::{self, CodexRouteStatus};
use crate::host::permissions::PermissionDecision;
use crate::runtime::{self, RuntimeId, SessionSelectionCatalog};
use crate::settings::{self, AppSettings, RuntimeOverride};
use crate::session_manager::{SessionManager, SessionMeta, SessionSettingsPatch, SessionSnapshot};
use crate::session_store::{self, StoredChatMessage};

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
pub fn open_cc_switch() -> Result<String, String> {
    route_diagnostics::open_cc_switch()
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
pub fn session_get_state(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: Option<String>,
) -> SessionSnapshot {
    mgr.snapshot(session_id.as_deref())
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
pub async fn session_delete(
    mgr: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<SessionDeleteResult, String> {
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
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });

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
