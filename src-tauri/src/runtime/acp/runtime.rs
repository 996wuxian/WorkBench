//! Generic ACP runtime adapter.
//!
//! Every field this needs comes from a [`RuntimeManifest`], so a new
//! ACP-speaking CLI is a JSON file — not a Rust module. Grok, Kimi and future
//! ACP bridges all run through this one type.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::HostEvent;
use crate::process_util;
use crate::runtime::acp::{AcpClient, AcpSpawnOpts};
use crate::runtime::manifest::RuntimeManifest;
use crate::runtime::traits::{AgentRuntime, ConnectOpts, LiveSession, ProbeResult, PromptInput};

pub struct AcpRuntime {
    manifest: &'static RuntimeManifest,
}

impl AcpRuntime {
    pub fn new(manifest: &'static RuntimeManifest) -> Self {
        Self { manifest }
    }
}

#[async_trait]
impl AgentRuntime for AcpRuntime {
    fn manifest(&self) -> &'static RuntimeManifest {
        self.manifest
    }

    async fn probe(&self) -> ProbeResult {
        let runtime_id = self.id();
        match self.manifest.resolve_cli_path() {
            Some(path) => {
                let version = read_version(&path, &self.manifest.version_args).await;
                ProbeResult {
                    runtime_id,
                    found: true,
                    path: Some(path.display().to_string()),
                    version,
                    detail: Some(format!("spawn: {} (ACP)", self.spawn_hint())),
                }
            }
            None => ProbeResult {
                runtime_id,
                found: false,
                path: None,
                version: None,
                detail: Some(match &self.manifest.notes {
                    Some(notes) => format!(
                        "`{}` not found on PATH or known locations. {notes}",
                        self.manifest.command
                    ),
                    None => format!(
                        "`{}` not found on PATH or known locations",
                        self.manifest.command
                    ),
                }),
            },
        }
    }

    async fn connect(
        &self,
        opts: ConnectOpts,
        event_tx: mpsc::UnboundedSender<HostEvent>,
    ) -> Result<Box<dyn LiveSession>, AgentError> {
        let cli = opts
            .cli_path
            .or_else(|| self.manifest.resolve_cli_path())
            .ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::CliNotFound,
                    format!(
                        "{} CLI not found (expected `{}`)",
                        self.manifest.display_name, self.manifest.command
                    ),
                )
            })?;

        let home = self.manifest.resolve_home();
        let spawn_opts = AcpSpawnOpts {
            cli_path: cli,
            cwd: opts.cwd.clone(),
            model_id: opts.model_id.clone(),
            home_env: self.manifest.home_env.clone(),
            home_dir: Some(home.clone()),
            pre_stdio_args: self.manifest.pre_stdio_args.clone(),
            stdio_args: self.manifest.stdio_args.clone(),
            model_arg: self.manifest.model_arg.clone(),
            client_name: "workbench".into(),
            runtime_id: self.id(),
            permissions: opts.permissions.clone(),
        };

        let (client, mut rx) = AcpClient::spawn(spawn_opts)?;

        // Bridge adapter events → caller channel.
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                if event_tx.send(ev).is_err() {
                    break;
                }
            }
        });

        // Resuming is only attempted when the manifest claims it works;
        // otherwise a stale id would fail the whole connect.
        let resume_id = opts
            .native_session_id
            .as_deref()
            .filter(|_| self.manifest.capabilities.session_resume);
        match resume_id {
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

        Ok(Box::new(AcpLiveSession { client, home }))
    }
}

impl AcpRuntime {
    fn spawn_hint(&self) -> String {
        let mut parts = vec![self.manifest.command.clone()];
        parts.extend(self.manifest.pre_stdio_args.iter().cloned());
        parts.extend(self.manifest.stdio_args.iter().cloned());
        parts.join(" ")
    }
}

struct AcpLiveSession {
    client: Arc<AcpClient>,
    home: PathBuf,
}

#[async_trait]
impl LiveSession for AcpLiveSession {
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

async fn read_version(path: &PathBuf, args: &[String]) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    process_util::apply_no_window_tokio(&mut cmd);
    if let Some(env_path) = process_util::enriched_path_env() {
        cmd.env("PATH", env_path);
    }

    let output = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;

    first_line(&output.stdout).or_else(|| first_line(&output.stderr))
}

fn first_line(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let line = text.lines().next().unwrap_or("").trim();
    (!line.is_empty()).then(|| line.to_string())
}
