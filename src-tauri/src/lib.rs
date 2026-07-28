//! Workbench Host — multi-runtime agent desktop shell.
//!
//! Architecture (mirrors grok-app Host ideas):
//! UI → commands → SessionManager (FSM) → Runtime Registry → Adapters

mod commands;
mod error;
mod native_sessions;
mod paths;
mod process_util;
mod route_diagnostics;
mod session_fsm;
mod session_manager;
mod session_store;
mod settings;

pub mod host;
pub mod runtime;

use std::sync::Arc;

use session_manager::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = paths::ensure_app_dirs();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    match paths::cleanup_stale_claude_mcp_configs() {
        Ok(removed) if removed > 0 => {
            tracing::info!("removed {removed} stale Claude MCP temp config(s)");
        }
        Err(err) => tracing::warn!("failed to clean Claude MCP temp configs: {err}"),
        _ => {}
    }

    let session_mgr = Arc::new(SessionManager::new());

    tauri::Builder::default()
        .manage(session_mgr)
        .setup(|app| {
            tracing::info!("Workbench host starting");
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                // Solid dark base — avoids white flash under frameless chrome.
                let _ = window.set_background_color(Some(tauri::window::Color(13, 13, 13, 255)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::window_set_theme,
            commands::list_runtimes,
            commands::probe_all,
            commands::probe_runtime,
            commands::codex_route_status,
            commands::claude_route_status,
            commands::open_cc_switch,
            commands::session_list,
            commands::session_create,
            commands::session_get_state,
            commands::session_control_options,
            commands::session_update_settings,
            commands::session_permission_respond,
            commands::session_get_messages,
            commands::session_delete,
            commands::session_open_location,
            commands::session_sync_native,
            commands::session_connect,
            commands::session_send,
            commands::session_stop,
            commands::session_disconnect,
            commands::settings_get,
            commands::settings_reload,
            commands::settings_set_runtime_override,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Workbench");
}
