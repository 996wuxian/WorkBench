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
            commands::open_cc_switch,
            commands::session_list,
            commands::session_create,
            commands::session_get_state,
            commands::session_control_options,
            commands::session_update_settings,
            commands::session_get_messages,
            commands::session_sync_native,
            commands::session_connect,
            commands::session_send,
            commands::session_stop,
            commands::session_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Workbench");
}
