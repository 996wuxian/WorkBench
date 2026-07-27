//! App data roots. Independent of each CLI home by default.

use std::fs;
use std::path::PathBuf;

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

pub fn agent_homes_dir() -> PathBuf {
    data_dir().join("agent-homes")
}

/// User-provided runtime manifests (`*.json`), merged over the built-ins.
pub fn runtimes_dir() -> PathBuf {
    data_dir().join("runtimes")
}

pub fn ensure_app_dirs() -> std::io::Result<()> {
    fs::create_dir_all(data_dir())?;
    fs::create_dir_all(sessions_dir())?;
    fs::create_dir_all(logs_dir())?;
    fs::create_dir_all(agent_homes_dir())?;
    fs::create_dir_all(runtimes_dir())?;
    Ok(())
}
