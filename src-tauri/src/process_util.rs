//! Process helpers (Windows GUI spawn, PATH enrichment).

use std::path::PathBuf;

pub fn user_home() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(h) = std::env::var("USERPROFILE") {
            if !h.is_empty() {
                return PathBuf::from(h);
            }
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    PathBuf::from(".")
}

pub fn apply_no_window_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd;
}

pub fn apply_no_window_std(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd;
}

pub fn clear_proxy_env_tokio(cmd: &mut tokio::process::Command) {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        cmd.env_remove(key);
    }
}

/// PATH for GUI-spawned agents (node/git/npx often missing otherwise).
pub fn enriched_path_env() -> Option<String> {
    #[cfg(target_os = "windows")]
    let sep = ';';
    #[cfg(not(target_os = "windows"))]
    let sep = ':';

    let mut parts: Vec<String> = Vec::new();
    let mut push = |p: &str| {
        if !p.is_empty() && !parts.iter().any(|x| x == p) {
            parts.push(p.to_string());
        }
    };

    if let Ok(cur) = std::env::var("PATH") {
        for p in cur.split(sep) {
            push(p);
        }
    }

    let home = user_home();
    let home_s = home.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        push(&format!(r"{home_s}\.grok\bin"));
        push(&format!(r"{home_s}\.codex\bin"));
        push(&format!(r"{home_s}\.local\bin"));
        push(&format!(r"{home_s}\AppData\Roaming\npm"));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            push(&format!(r"{local}\Microsoft\WinGet\Links"));
        }
        push(r"C:\Program Files\nodejs");
        push(r"C:\Program Files\Git\cmd");
    }
    #[cfg(not(target_os = "windows"))]
    {
        push(&format!("{home_s}/.grok/bin"));
        push(&format!("{home_s}/.local/bin"));
        push(&format!("{home_s}/.cargo/bin"));
        push("/usr/local/bin");
        push("/usr/bin");
    }

    Some(parts.join(&sep.to_string()))
}
