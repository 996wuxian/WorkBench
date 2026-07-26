//! Grok Build adapter — `grok agent stdio` (real ACP).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::process::Command;
use tokio::sync::mpsc;
use which::which;

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::HostEvent;
use crate::paths;
use crate::process_util;
use crate::runtime::acp::{AcpClient, AcpSpawnOpts};
use crate::runtime::capabilities::RuntimeCapabilities;
use crate::runtime::traits::{
    AgentRuntime, ConnectOpts, LiveSession, ProbeResult, PromptInput, RuntimeId,
};

pub struct GrokRuntime;

#[async_trait]
impl AgentRuntime for GrokRuntime {
    fn id(&self) -> RuntimeId {
        RuntimeId::Grok
    }

    fn capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities::acp_full()
    }

    async fn probe(&self) -> ProbeResult {
        match resolve_grok_path() {
            Some(p) => {
                let version = read_version(&p).await;
                ProbeResult {
                    runtime_id: RuntimeId::Grok,
                    found: true,
                    path: Some(p.display().to_string()),
                    version,
                    detail: Some("spawn: grok --no-auto-update agent stdio (ACP)".into()),
                }
            }
            None => ProbeResult {
                runtime_id: RuntimeId::Grok,
                found: false,
                path: None,
                version: None,
                detail: Some("not found on PATH or common install locations".into()),
            },
        }
    }

    async fn connect(
        &self,
        opts: ConnectOpts,
        event_tx: mpsc::UnboundedSender<HostEvent>,
    ) -> Result<Box<dyn LiveSession>, AgentError> {
        let cli = opts.cli_path.or_else(resolve_grok_path).ok_or_else(|| {
            AgentError::new(
                AgentErrorCode::CliNotFound,
                "Grok Build CLI not found (expected `grok`)",
            )
        })?;

        let home = resolve_grok_home();
        let spawn_opts = AcpSpawnOpts {
            cli_path: cli,
            cwd: opts.cwd.clone(),
            model_id: opts.model_id.clone(),
            home_env: Some("GROK_HOME".into()),
            home_dir: Some(home.clone()),
            // Flag order: top-level --no-auto-update, then agent, then opts, then stdio
            pre_stdio_args: vec!["--no-auto-update".into(), "agent".into()],
            client_name: "workbench".into(),
            runtime_id: RuntimeId::Grok,
            auto_allow_permissions: opts.permission_mode.grok_auto_allow(),
        };

        let (client, mut rx) = AcpClient::spawn(spawn_opts)?;

        // Bridge adapter events → caller channel
        let bridge_tx = event_tx;
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                if bridge_tx.send(ev).is_err() {
                    break;
                }
            }
        });

        match opts.native_session_id.as_deref() {
            Some(session_id) => {
                client
                    .initialize_and_load_session("workbench", &opts.cwd, session_id)
                    .await?;
            }
            None => {
                client
                    .initialize_and_new_session("workbench", &opts.cwd)
                    .await?;
            }
        }

        Ok(Box::new(GrokLiveSession { client, home }))
    }
}

struct GrokLiveSession {
    client: Arc<AcpClient>,
    home: PathBuf,
}

#[async_trait]
impl LiveSession for GrokLiveSession {
    fn backend(&self) -> &str {
        self.client.backend()
    }

    fn native_session_id(&self) -> Option<String> {
        self.client.agent_session_id()
    }

    fn native_home(&self) -> Option<String> {
        Some(self.home.display().to_string())
    }

    async fn prompt(&self, input: PromptInput) -> Result<(), AgentError> {
        self.client.prompt(&input.text).await
    }

    async fn cancel(&self) -> Result<(), AgentError> {
        self.client.cancel().await
    }

    async fn shutdown(&self) -> Result<(), AgentError> {
        self.client.shutdown().await
    }
}

/// Prefer existing CLI home (auth already there); else app agent-homes/grok.
fn resolve_grok_home() -> PathBuf {
    if let Ok(h) = std::env::var("GROK_HOME") {
        let p = PathBuf::from(h);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let user = process_util::user_home().join(".grok");
    if user.join("auth.json").is_file() || user.join("config.toml").is_file() {
        return user;
    }
    // Windows install path sibling
    let win = PathBuf::from(r"D:\tools\grok");
    if win.join("auth.json").is_file() || win.join("config.toml").is_file() {
        return win;
    }
    paths::agent_homes_dir().join("grok")
}

fn resolve_grok_path() -> Option<PathBuf> {
    if let Ok(p) = which("grok") {
        return Some(p);
    }
    let candidates = [
        r"D:\tools\grok\bin\grok.exe",
        r"%USERPROFILE%\.grok\bin\grok.exe",
    ];
    for c in candidates {
        let expanded = expand_userprofile(c);
        let p = PathBuf::from(&expanded);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn expand_userprofile(s: &str) -> String {
    if let Ok(home) = std::env::var("USERPROFILE") {
        return s.replace("%USERPROFILE%", &home);
    }
    if let Ok(home) = std::env::var("HOME") {
        return s.replace("%USERPROFILE%", &home);
    }
    s.to_string()
}

async fn read_version(path: &PathBuf) -> Option<String> {
    let output = Command::new(path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        let line = err.lines().next().unwrap_or("").trim();
        if line.is_empty() {
            None
        } else {
            Some(line.to_string())
        }
    } else {
        Some(line.to_string())
    }
}
