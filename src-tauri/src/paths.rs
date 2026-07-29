//! App data roots. Independent of each CLI home by default.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use directories::ProjectDirs;

const QUALIFIER: &str = "com";
const ORGANIZATION: &str = "workbench";
const APPLICATION: &str = "Workbench";

pub fn project_dirs() -> Option<ProjectDirs> {
    ProjectDirs::from(QUALIFIER, ORGANIZATION, APPLICATION)
}

/// `%APPDATA%/workbench/Workbench` on Windows, `~/.local/share/workbench` on Linux, etc.
pub fn data_dir() -> PathBuf {
    project_dirs()
        .map(|p| p.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".workbench-data"))
}

pub fn sessions_dir() -> PathBuf {
    data_dir().join("sessions")
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

pub fn exports_dir() -> PathBuf {
    data_dir().join("exports")
}

pub fn agent_homes_dir() -> PathBuf {
    data_dir().join("agent-homes")
}

/// User-provided runtime manifests (`*.json`), merged over the built-ins.
pub fn runtimes_dir() -> PathBuf {
    data_dir().join("runtimes")
}

pub fn claude_mcp_temp_dir() -> PathBuf {
    std::env::temp_dir().join("workbench-claude-mcp")
}

pub fn ensure_app_dirs() -> std::io::Result<()> {
    fs::create_dir_all(data_dir())?;
    fs::create_dir_all(sessions_dir())?;
    fs::create_dir_all(logs_dir())?;
    fs::create_dir_all(exports_dir())?;
    fs::create_dir_all(agent_homes_dir())?;
    fs::create_dir_all(runtimes_dir())?;
    Ok(())
}

pub fn cleanup_stale_claude_mcp_configs() -> std::io::Result<usize> {
    let dir = claude_mcp_temp_dir();
    if !dir.is_dir() {
        return Ok(0);
    }

    let ttl = Duration::from_secs(24 * 60 * 60);
    let now = SystemTime::now();
    let mut removed = 0;

    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= ttl);
        if stale && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }

    Ok(removed)
}
