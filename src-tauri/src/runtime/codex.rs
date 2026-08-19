//! Codex adapter — `codex app-server --stdio` (Codex App Server JSON-RPC).

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use parking_lot::Mutex as ParkingMutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{FileChangeHunk, FileChangeLine, FileChangeStat, HostEvent, StreamKind};
use crate::host::permissions::{PermissionBroker, PermissionDecision, PermissionRequest};
use crate::process_util;
use crate::runtime::catalog::{ChoiceOption, SessionSelectionCatalog};
use crate::runtime::id::RuntimeId;
use crate::runtime::manifest::RuntimeManifest;
use crate::runtime::traits::{
    AgentRuntime, ConnectOpts, LiveSession, PermissionMode, ProbeResult, PromptImageInput,
    PromptInput, SessionSettings, SessionSettingsPatch,
};

const HANDSHAKE_TIMEOUT_SECS: u64 = 45;
const REQUEST_TIMEOUT_SECS: u64 = 60;
const INTERRUPT_TIMEOUT_SECS: u64 = 5;
const PROMPT_TIMEOUT_SECS: u64 = 60 * 20;
const PROMPT_MAX_ATTEMPTS: usize = 3;
const PROMPT_RETRY_BACKOFF_MS: u64 = 1000;
const FILE_CHANGE_MAX_FILES: usize = 8;
const FILE_CHANGE_MAX_LINES: usize = 120;
const FILE_CHANGE_MAX_LINE_CHARS: usize = 240;
const FILE_CHANGE_MAX_BYTES: u64 = 512 * 1024;
static RPC_TRACE_LOCK: OnceLock<ParkingMutex<()>> = OnceLock::new();

struct Pending {
    method: String,
    tx: oneshot::Sender<Result<Value, String>>,
}

enum CodexApprovalResponse {
    Decision,
    Permissions {
        scope: Value,
        permissions: Vec<Value>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelListResponse {
    data: Vec<CodexModelCatalogEntry>,
    next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct CodexModelCatalogEntry {
    id: String,
    display_name: String,
    description: String,
    hidden: bool,
    is_default: bool,
    model: String,
    default_reasoning_effort: String,
    supported_reasoning_efforts: Vec<CodexReasoningEffortOption>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct CodexReasoningEffortOption {
    description: String,
    reasoning_effort: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct PermissionProfileListResponse {
    data: Vec<PermissionProfileSummary>,
    next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct PermissionProfileSummary {
    id: String,
    allowed: bool,
    description: Option<String>,
}

pub struct CodexRuntime {
    manifest: &'static RuntimeManifest,
}

impl CodexRuntime {
    pub fn new(manifest: &'static RuntimeManifest) -> Self {
        Self { manifest }
    }
}

#[async_trait]
impl AgentRuntime for CodexRuntime {
    fn manifest(&self) -> &'static RuntimeManifest {
        self.manifest
    }

    async fn probe(&self) -> ProbeResult {
        match self.manifest.resolve_cli_path() {
            Some(p) => {
                let version = read_version(&p).await;
                ProbeResult {
                    runtime_id: self.id(),
                    found: true,
                    path: Some(p.display().to_string()),
                    version,
                    detail: Some("spawn: codex app-server --stdio".into()),
                }
            }
            None => ProbeResult {
                runtime_id: self.id(),
                found: false,
                path: None,
                version: None,
                detail: Some(format!(
                    "`{}` not found on PATH or known locations",
                    self.manifest.command
                )),
            },
        }
    }

    /// Codex can enumerate its own models, so this queries the app-server
    /// instead of using the manifest's (empty) static list.
    async fn selection_catalog(
        &self,
        cwd: PathBuf,
        current_model: Option<String>,
    ) -> Result<SessionSelectionCatalog, String> {
        read_selection_catalog(self.manifest, cwd, current_model).await
    }

    /// Codex is the one runtime with a reasoning-effort axis, and it encodes
    /// that effort in the model id (`gpt-5.5-high`). Both rules live here so
    /// `SessionManager` stays runtime-agnostic.
    fn normalize_settings(
        &self,
        current: &SessionSettings,
        patch: &SessionSettingsPatch,
    ) -> Result<SessionSettings, String> {
        let mut next = current.clone();

        if let Some(mode) = patch.permission_mode {
            if !self.manifest.supports_permission_mode(mode) {
                return Err(format!(
                    "{} does not support permission mode `{}`",
                    self.manifest.display_name,
                    mode.as_str()
                ));
            }
            next.permission_mode = Some(mode);
        }

        if let Some(raw) = patch.model_id.as_deref() {
            // Read the effort suffix off the *raw* id: normalization strips it.
            let effort_from_model = codex_reasoning_effort_from_model(raw);
            let model = normalize_codex_model_id(raw);
            if model.is_empty() {
                return Err(format!("invalid Codex model id: {raw}"));
            }
            // An id that carries an effort suffix wins over the stored effort,
            // otherwise switching model would silently keep the old one.
            next.model_reasoning_effort =
                effort_from_model.or_else(|| next.model_reasoning_effort.clone());
            next.model_id = Some(model);
        }

        if let Some(raw) = patch.model_reasoning_effort.as_deref() {
            next.model_reasoning_effort = validate_reasoning_effort(raw)?;
        }

        Ok(next)
    }

    fn default_settings(&self) -> SessionSettings {
        // `default` means "let the CLI choose"; the real catalog is fetched
        // lazily by `selection_catalog` once a session exists.
        SessionSettings {
            model_id: Some("default".into()),
            model_reasoning_effort: crate::route_diagnostics::codex_route_status()
                .model_reasoning_effort
                .or_else(|| Some("high".into())),
            permission_mode: Some(self.manifest.default_permission_mode()),
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
                    "Codex CLI not found (expected `codex`)",
                )
            })?;

        let client = spawn_initialized_client(
            cli.clone(),
            opts.cwd.clone(),
            opts.model_id.clone(),
            opts.model_reasoning_effort.clone(),
            opts.permission_mode,
            opts.permissions.clone(),
            opts.native_thread_id
                .clone()
                .or_else(|| opts.native_session_id.clone()),
            event_tx.clone(),
        )
        .await?;
        let native_thread_id = client.thread_id();
        let native_session_id = client.thread_session_id();

        Ok(Box::new(CodexLiveSession {
            client: AsyncMutex::new(client),
            cli_path: cli,
            cwd: opts.cwd,
            model_id: opts.model_id,
            model_reasoning_effort: opts.model_reasoning_effort,
            permission_mode: opts.permission_mode,
            permissions: opts.permissions,
            native_thread_id: ParkingMutex::new(native_thread_id),
            native_session_id: ParkingMutex::new(native_session_id),
            native_home: self.manifest.resolve_home(),
            event_tx,
        }))
    }
}

struct CodexLiveSession {
    client: AsyncMutex<Arc<CodexAppServerClient>>,
    cli_path: PathBuf,
    cwd: PathBuf,
    model_id: Option<String>,
    model_reasoning_effort: Option<String>,
    permission_mode: PermissionMode,
    permissions: PermissionBroker,
    native_thread_id: ParkingMutex<Option<String>>,
    native_session_id: ParkingMutex<Option<String>>,
    native_home: PathBuf,
    event_tx: mpsc::UnboundedSender<HostEvent>,
}

#[async_trait]
impl LiveSession for CodexLiveSession {
    fn backend(&self) -> &str {
        "codex_app_server"
    }

    fn native_session_id(&self) -> Option<String> {
        self.native_session_id.lock().clone()
    }

    fn native_thread_id(&self) -> Option<String> {
        self.native_thread_id.lock().clone()
    }

    fn native_home(&self) -> Option<String> {
        Some(self.native_home.display().to_string())
    }

    async fn prompt(&self, input: PromptInput) -> Result<(), AgentError> {
        let mut last_error: Option<AgentError> = None;
        for attempt in 1..=PROMPT_MAX_ATTEMPTS {
            let client = { self.client.lock().await.clone() };
            match client.prompt_once(&input.text, &input.images).await {
                Ok(()) => return Ok(()),
                Err(err) => {
                    let retryable = is_retryable_prompt_error(&err.message);
                    tracing::warn!(
                        "codex prompt attempt {attempt}/{PROMPT_MAX_ATTEMPTS} failed retryable={retryable}: {}",
                        err.message
                    );
                    last_error = Some(err);
                    if retryable && attempt < PROMPT_MAX_ATTEMPTS {
                        let _ = client.shutdown().await;
                        tokio::time::sleep(std::time::Duration::from_millis(
                            PROMPT_RETRY_BACKOFF_MS,
                        ))
                        .await;
                        let native_thread_id = { self.native_thread_id.lock().clone() };
                        let new_client = spawn_initialized_client(
                            self.cli_path.clone(),
                            self.cwd.clone(),
                            self.model_id.clone(),
                            self.model_reasoning_effort.clone(),
                            self.permission_mode,
                            self.permissions.clone(),
                            native_thread_id,
                            self.event_tx.clone(),
                        )
                        .await?;
                        *self.native_thread_id.lock() = new_client.thread_id();
                        *self.native_session_id.lock() = new_client.thread_session_id();
                        *self.client.lock().await = new_client;
                        continue;
                    }
                    break;
                }
            }
        }

        let err = last_error.unwrap_or_else(|| {
            AgentError::new(
                AgentErrorCode::AgentCrashed,
                "Codex prompt retry loop terminated unexpectedly",
            )
        });
        if is_retryable_prompt_error(&err.message) {
            return Err(AgentError::new(
                AgentErrorCode::NetworkProvider,
                format!(
                    "Codex 无响应或上游不可用，已超时 {PROMPT_TIMEOUT_SECS} 秒并重试 {PROMPT_MAX_ATTEMPTS} 次: {}",
                    err.message
                ),
            ));
        }
        Err(err)
    }

    async fn cancel(&self) -> Result<(), AgentError> {
        let client = { self.client.lock().await.clone() };
        client.cancel().await
    }

    async fn shutdown(&self) -> Result<(), AgentError> {
        let client = { self.client.lock().await.clone() };
        client.shutdown().await
    }
}

async fn spawn_initialized_client(
    cli: PathBuf,
    cwd: PathBuf,
    model_id: Option<String>,
    model_reasoning_effort: Option<String>,
    permission_mode: PermissionMode,
    permissions: PermissionBroker,
    native_thread_id: Option<String>,
    event_tx: mpsc::UnboundedSender<HostEvent>,
) -> Result<Arc<CodexAppServerClient>, AgentError> {
    let (client, rx) = CodexAppServerClient::spawn(
        cli,
        cwd.clone(),
        model_id.clone(),
        model_reasoning_effort.clone(),
        permission_mode,
        permissions,
    )?;
    bridge_client_events(rx, event_tx);

    if let Err(err) = client
        .initialize_thread(
            "workbench",
            &cwd,
            model_id.as_deref(),
            model_reasoning_effort.as_deref(),
            permission_mode,
            native_thread_id.as_deref(),
        )
        .await
    {
        let _ = client.shutdown().await;
        return Err(err);
    }
    Ok(client)
}

fn bridge_client_events(
    mut rx: mpsc::UnboundedReceiver<HostEvent>,
    event_tx: mpsc::UnboundedSender<HostEvent>,
) {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if event_tx.send(ev).is_err() {
                break;
            }
        }
    });
}

struct CodexAppServerClient {
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    next_id: AtomicU64,
    pending: ParkingMutex<HashMap<u64, Pending>>,
    event_tx: mpsc::UnboundedSender<HostEvent>,
    backend: String,
    cwd: PathBuf,
    model_id: Option<String>,
    model_reasoning_effort: Option<String>,
    permission_mode: PermissionMode,
    permissions: PermissionBroker,
    thread_id: ParkingMutex<Option<String>>,
    thread_session_id: ParkingMutex<Option<String>>,
    current_turn_id: ParkingMutex<Option<String>>,
    turn_waiters: ParkingMutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
    completed_turns: ParkingMutex<HashMap<String, Result<String, String>>>,
    emitted_agent_message_items: ParkingMutex<HashSet<String>>,
    file_change_deltas: ParkingMutex<HashMap<String, String>>,
    stopped: AtomicBool,
    shutdown_requested: AtomicBool,
    reader_alive: AtomicBool,
    stderr_tail: ParkingMutex<Vec<String>>,
}

impl CodexAppServerClient {
    fn spawn(
        cli_path: PathBuf,
        cwd: PathBuf,
        model_id: Option<String>,
        model_reasoning_effort: Option<String>,
        permission_mode: PermissionMode,
        permissions: PermissionBroker,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<HostEvent>), AgentError> {
        if !cli_path.exists() {
            return Err(AgentError::new(
                AgentErrorCode::CliNotFound,
                format!("Codex binary missing: {}", cli_path.display()),
            ));
        }
        if !cwd.is_dir() {
            return Err(AgentError::new(
                AgentErrorCode::ConnectFailed,
                format!("cwd is not a directory: {}", cwd.display()),
            ));
        }

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let mut cmd = Command::new(&cli_path);
        cmd.args(["app-server", "--stdio"])
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        process_util::apply_no_window_tokio(&mut cmd);
        if let Some(path) = process_util::enriched_path_env() {
            cmd.env("PATH", path);
        }
        process_util::clear_proxy_env_tokio(&mut cmd);
        cmd.env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost");

        let mut child = cmd.spawn().map_err(|e| {
            AgentError::new(
                AgentErrorCode::CliNotFound,
                format!("failed to spawn Codex app-server: {e}"),
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "codex stdin missing"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "codex stdout missing"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "codex stderr missing"))?;

        let client = Arc::new(Self {
            child: AsyncMutex::new(Some(child)),
            stdin: AsyncMutex::new(Some(stdin)),
            next_id: AtomicU64::new(1),
            pending: ParkingMutex::new(HashMap::new()),
            event_tx: event_tx.clone(),
            backend: "codex_app_server".into(),
            cwd,
            model_id,
            model_reasoning_effort,
            permission_mode,
            permissions,
            thread_id: ParkingMutex::new(None),
            thread_session_id: ParkingMutex::new(None),
            current_turn_id: ParkingMutex::new(None),
            turn_waiters: ParkingMutex::new(HashMap::new()),
            completed_turns: ParkingMutex::new(HashMap::new()),
            emitted_agent_message_items: ParkingMutex::new(HashSet::new()),
            file_change_deltas: ParkingMutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
            shutdown_requested: AtomicBool::new(false),
            reader_alive: AtomicBool::new(true),
            stderr_tail: ParkingMutex::new(Vec::new()),
        });

        {
            let c = Arc::clone(&client);
            tokio::spawn(async move {
                let mut reader = BufReader::with_capacity(8 * 1024 * 1024, stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                Arc::clone(&c).handle_line(trimmed).await;
                            }
                        }
                        Err(e) => {
                            tracing::error!("codex stdout read error: {e}");
                            break;
                        }
                    }
                }
                let report_exit = !c.shutdown_requested.load(Ordering::SeqCst);
                c.reader_alive.store(false, Ordering::SeqCst);
                c.fail_all_pending("Codex app-server exited (stdout EOF)");
                c.fail_all_turns("Codex app-server exited");
                // Unblock anything waiting on an approval that can no longer be delivered.
                c.permissions.abort_all();
                if report_exit {
                    let _ = c.event_tx.send(HostEvent::ProcessExited { code: None });
                }
            });
        }

        {
            let c = Arc::clone(&client);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let t = line.trim_end().to_string();
                            if !t.is_empty() {
                                c.push_stderr(&t);
                                tracing::debug!(target: "codex.stderr", "{t}");
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let _ = event_tx.send(HostEvent::State {
            state: crate::session_fsm::SessionState::Connecting,
            runtime_id: RuntimeId::CODEX,
            backend: "codex_app_server".into(),
        });

        Ok((client, event_rx))
    }

    fn thread_id(&self) -> Option<String> {
        self.thread_id.lock().clone()
    }

    fn thread_session_id(&self) -> Option<String> {
        self.thread_session_id.lock().clone()
    }

    fn push_stderr(&self, line: &str) {
        let mut buf = self.stderr_tail.lock();
        buf.push(line.to_string());
        if buf.len() > 40 {
            let n = buf.len() - 40;
            buf.drain(0..n);
        }
    }

    fn stderr_joined(&self) -> String {
        self.stderr_tail.lock().join(" | ")
    }

    fn format_exit_detail(&self, head: &str) -> String {
        let tail = self.stderr_joined();
        if tail.is_empty() {
            head.to_string()
        } else {
            let t = if tail.len() > 600 {
                format!("...{}", &tail[tail.len() - 600..])
            } else {
                tail
            };
            format!("{head}; stderr: {t}")
        }
    }

    fn fail_all_pending(&self, message: &str) {
        for (_, p) in self.pending.lock().drain() {
            let _ = p.tx.send(Err(message.to_string()));
        }
    }

    fn fail_all_turns(&self, message: &str) {
        for (_, tx) in self.turn_waiters.lock().drain() {
            let _ = tx.send(Err(message.to_string()));
        }
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        trace_rpc_frame("out", value);
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| "stdin closed".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn request_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        if !self.reader_alive.load(Ordering::SeqCst) {
            return Err(self.format_exit_detail(&format!("Codex stdout closed before {method}")));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(
            id,
            Pending {
                method: method.to_string(),
                tx,
            },
        );
        let msg = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        tracing::info!("codex → {method} id={id}");
        if let Err(e) = self.write_line(&msg).await {
            self.pending.lock().remove(&id);
            return Err(format!("write {method} failed: {e}"));
        }
        let mut rx = rx;
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), &mut rx).await
            {
                Ok(Ok(Ok(v))) => {
                    tracing::info!("codex ← {method} id={id} ok");
                    return Ok(v);
                }
                Ok(Ok(Err(e))) => {
                    tracing::warn!("codex ← {method} id={id} error: {e}");
                    return Err(e);
                }
                Ok(Err(_)) => return Err(format!("rpc channel closed waiting for {method}")),
                Err(_) if self.permissions.has_pending() => {
                    tracing::info!(
                        "codex rpc {method} id={id} reached {timeout_secs}s while permission is pending; continuing to wait"
                    );
                }
                Err(_) => {
                    self.pending.lock().remove(&id);
                    return Err(format!("rpc timeout on {method} after {timeout_secs}s"));
                }
            }
        }
    }

    async fn reply_result(&self, id: u64, result: Value) {
        let reply = json!({ "id": id, "result": result });
        if let Err(e) = self.write_line(&reply).await {
            tracing::warn!("codex server request reply failed id={id}: {e}");
        }
    }

    async fn reply_error(&self, id: u64, code: i64, message: &str) {
        let reply = json!({
            "id": id,
            "error": { "code": code, "message": message }
        });
        if let Err(e) = self.write_line(&reply).await {
            tracing::warn!("codex server request error reply failed id={id}: {e}");
        }
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let msg = match params {
            Some(params) => json!({ "method": method, "params": params }),
            None => json!({ "method": method }),
        };
        self.write_line(&msg).await
    }

    async fn initialize_transport(&self, client_name: &str) -> Result<(), AgentError> {
        self.request_timeout(
            "initialize",
            json!({
                "clientInfo": { "name": client_name, "version": env!("CARGO_PKG_VERSION") },
                "capabilities": codex_client_capabilities()
            }),
            HANDSHAKE_TIMEOUT_SECS,
        )
        .await
        .map_err(|e| self.map_handshake_err("initialize", e))?;

        self.notify("initialized", None)
            .await
            .map_err(|e| self.map_handshake_err("initialized", e))?;
        Ok(())
    }

    async fn initialize_thread(
        &self,
        client_name: &str,
        cwd: &Path,
        model_id: Option<&str>,
        model_reasoning_effort: Option<&str>,
        permission_mode: PermissionMode,
        native_thread_id: Option<&str>,
    ) -> Result<String, AgentError> {
        self.initialize_transport(client_name).await?;

        let mut params = json!({
            "cwd": cwd.to_string_lossy().to_string(),
            "approvalPolicy": permission_mode.codex_approval_policy(),
            "approvalsReviewer": permission_mode.codex_approvals_reviewer(),
            "sandbox": permission_mode.codex_sandbox()
        });
        let method = if let Some(thread_id) = native_thread_id {
            params["threadId"] = json!(thread_id);
            "thread/resume"
        } else {
            params["runtimeWorkspaceRoots"] = json!([cwd.to_string_lossy().to_string()]);
            params["ephemeral"] = json!(false);
            "thread/start"
        };
        if let Some(model) = normalize_model(model_id) {
            params["model"] = json!(model);
        }
        if let Some(reasoning_effort) = normalize_reasoning_effort(model_reasoning_effort) {
            params["modelReasoningEffort"] = json!(reasoning_effort);
        }

        let result = self
            .request_timeout(method, params, HANDSHAKE_TIMEOUT_SECS)
            .await
            .map_err(|e| self.map_handshake_err(method, e))?;

        let thread_id = result
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::ProtocolMismatch,
                    format!("{method} response missing thread.id"),
                )
            })?
            .to_string();
        let session_id = result
            .pointer("/thread/sessionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let model = result
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        *self.thread_id.lock() = Some(thread_id.clone());
        *self.thread_session_id.lock() = session_id.clone();
        if let Some(m) = model {
            tracing::info!(
                "codex thread ready model={m} method={method} threadId={thread_id} sessionId={:?}",
                session_id
            );
        } else {
            tracing::info!(
                "codex thread ready method={method} threadId={thread_id} sessionId={:?}",
                session_id
            );
        }

        let _ = self.event_tx.send(HostEvent::State {
            state: crate::session_fsm::SessionState::Ready,
            runtime_id: RuntimeId::CODEX,
            backend: self.backend.clone(),
        });
        Ok(thread_id)
    }

    async fn fetch_model_catalog(&self) -> Result<Vec<ChoiceOption>, String> {
        let mut cursor: Option<String> = None;
        let mut out = Vec::new();

        loop {
            let mut params = json!({
                "limit": 100_u32,
                "includeHidden": false,
            });
            if let Some(ref c) = cursor {
                params["cursor"] = json!(c);
            }

            let result = self
                .request_timeout("model/list", params, HANDSHAKE_TIMEOUT_SECS)
                .await?;
            let response: ModelListResponse =
                serde_json::from_value(result).map_err(|e| e.to_string())?;

            for model in response.data {
                if model.hidden || is_hidden_codex_model(&model.model) {
                    continue;
                }
                let model_id = normalize_codex_model_id(&model.model);
                if model_id.is_empty() {
                    continue;
                }
                let mut label = model.display_name;
                if label.trim().is_empty() {
                    label = model_id.clone();
                }
                let hint = if model.description.trim().is_empty() {
                    Some(model_id.clone())
                } else if model.description == model_id {
                    None
                } else {
                    Some(model.description)
                };
                out.push(ChoiceOption {
                    value: model_id,
                    label,
                    hint,
                    suffix: None,
                    disabled: false,
                });
            }

            cursor = response.next_cursor;
            if cursor.is_none() {
                break;
            }
        }

        out.sort_by(|a, b| codex_model_sort_key(a).cmp(&codex_model_sort_key(b)));
        out.dedup_by(|a, b| a.value == b.value);
        Ok(out)
    }

    #[allow(dead_code)]
    async fn fetch_permission_profiles(&self, cwd: &Path) -> Result<Vec<ChoiceOption>, String> {
        let mut cursor: Option<String> = None;
        let mut out = Vec::new();

        loop {
            let mut params = json!({
                "cwd": cwd.to_string_lossy().to_string(),
                "limit": 100_u32,
            });
            if let Some(ref c) = cursor {
                params["cursor"] = json!(c);
            }

            let result = self
                .request_timeout("permissionProfile/list", params, HANDSHAKE_TIMEOUT_SECS)
                .await?;
            let response: PermissionProfileListResponse =
                serde_json::from_value(result).map_err(|e| e.to_string())?;

            for profile in response.data {
                let label = profile.id.clone();
                let hint = profile
                    .description
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| Some(profile.id.clone()));
                out.push(ChoiceOption {
                    value: profile.id,
                    label,
                    hint,
                    suffix: None,
                    disabled: !profile.allowed,
                });
            }

            cursor = response.next_cursor;
            if cursor.is_none() {
                break;
            }
        }

        out.sort_by(|a, b| a.label.cmp(&b.label).then(a.value.cmp(&b.value)));
        out.dedup_by(|a, b| a.value == b.value);
        Ok(out)
    }

    fn map_handshake_err(&self, phase: &str, e: String) -> AgentError {
        let detail = self.format_exit_detail(&format!("{phase}: {e}"));
        classify_codex_error(&detail)
    }

    async fn prompt_once(&self, text: &str, images: &[PromptImageInput]) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .clone()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no Codex thread"))?;

        self.stopped.store(false, Ordering::SeqCst);
        self.emitted_agent_message_items.lock().clear();
        self.file_change_deltas.lock().clear();
        let mut input = Vec::with_capacity(1 + images.len());
        input.push(json!({ "type": "text", "text": text, "text_elements": [] }));
        input.extend(images.iter().map(|image| {
            json!({
                "type": "localImage",
                "path": image.path.to_string_lossy().to_string(),
            })
        }));

        let mut params = json!({
            "threadId": thread_id,
            "input": input,
            "cwd": self.cwd.to_string_lossy().to_string(),
            "runtimeWorkspaceRoots": [self.cwd.to_string_lossy().to_string()],
            "approvalPolicy": self.permission_mode.codex_approval_policy(),
            "approvalsReviewer": self.permission_mode.codex_approvals_reviewer(),
            "sandbox": self.permission_mode.codex_sandbox(),
        });
        if let Some(model) = normalize_model(self.model_id.as_deref()) {
            params["model"] = json!(model);
        }
        if let Some(reasoning_effort) =
            normalize_reasoning_effort(self.model_reasoning_effort.as_deref())
        {
            params["modelReasoningEffort"] = json!(reasoning_effort);
        }

        let result = self
            .request_timeout("turn/start", params, REQUEST_TIMEOUT_SECS)
            .await
            .map_err(|e| classify_codex_error(&e))?;

        let turn_id = result
            .pointer("/turn/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::ProtocolMismatch,
                    "turn/start response missing turn.id",
                )
            })?
            .to_string();
        *self.current_turn_id.lock() = Some(turn_id.clone());

        let completed = {
            let mut completed_turns = self.completed_turns.lock();
            completed_turns.remove(&turn_id)
        };
        let done = if let Some(done) = completed {
            done
        } else {
            let (tx, rx) = oneshot::channel();
            self.turn_waiters.lock().insert(turn_id.clone(), tx);
            let mut rx = rx;
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(PROMPT_TIMEOUT_SECS),
                    &mut rx,
                )
                .await
                {
                    Ok(Ok(done)) => break done,
                    Ok(Err(_)) => break Err("turn waiter closed".to_string()),
                    Err(_) if self.permissions.has_pending() => {
                        tracing::info!(
                            "codex turn {turn_id} reached {PROMPT_TIMEOUT_SECS}s while permission is pending; continuing to wait"
                        );
                    }
                    Err(_) => {
                        self.stopped.store(true, Ordering::SeqCst);
                        let _ = self
                            .request_timeout(
                                "turn/interrupt",
                                json!({ "threadId": thread_id, "turnId": turn_id }),
                                INTERRUPT_TIMEOUT_SECS,
                            )
                            .await;
                        self.turn_waiters.lock().remove(&turn_id);
                        break Err(format!(
                            "turn timeout after {PROMPT_TIMEOUT_SECS}s (turnId={turn_id})"
                        ));
                    }
                }
            }
        };

        *self.current_turn_id.lock() = None;
        match done {
            Ok(stop_reason) => {
                let _ = self.event_tx.send(HostEvent::Stream {
                    kind: StreamKind::Assistant,
                    text: String::new(),
                    done: true,
                });
                let _ = self
                    .event_tx
                    .send(HostEvent::PromptComplete { stop_reason });
                Ok(())
            }
            Err(e) => Err(classify_codex_error(&e)),
        }
    }

    async fn cancel(&self) -> Result<(), AgentError> {
        self.stopped.store(true, Ordering::SeqCst);
        let thread_id = self
            .thread_id
            .lock()
            .clone()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no Codex thread"))?;
        let Some(turn_id) = self.current_turn_id.lock().clone() else {
            return Ok(());
        };
        self.request_timeout(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
            INTERRUPT_TIMEOUT_SECS,
        )
        .await
        .map_err(|e| classify_codex_error(&e))?;
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), AgentError> {
        self.shutdown_requested.store(true, Ordering::SeqCst);
        self.stopped.store(true, Ordering::SeqCst);
        self.fail_all_pending("shutdown");
        self.fail_all_turns("shutdown");
        let mut child = self.child.lock().await;
        if let Some(mut c) = child.take() {
            let _ = c.kill().await;
        }
        *self.stdin.lock().await = None;
        Ok(())
    }

    async fn handle_line(self: Arc<Self>, line: &str) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("codex non-json: {e}: {}", &line[..line.len().min(160)]);
                return;
            }
        };
        trace_rpc_frame("in", &msg);

        if let Some(id) = json_id_u64(msg.get("id")) {
            if msg.get("result").is_some() || msg.get("error").is_some() {
                if let Some(p) = self.pending.lock().remove(&id) {
                    if let Some(err) = msg.get("error") {
                        let full = format_jsonrpc_error(err);
                        tracing::warn!("codex ← {} id={id} error: {full}", p.method);
                        let _ = p.tx.send(Err(full));
                    } else {
                        let _ =
                            p.tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                    }
                    return;
                }
            } else if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
                self.handle_server_request(id, method, msg.get("params").unwrap_or(&Value::Null))
                    .await;
                return;
            }
        }

        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            self.handle_notification(method, msg.get("params").unwrap_or(&Value::Null));
        }
    }

    async fn handle_server_request(self: Arc<Self>, id: u64, method: &str, params: &Value) {
        match method {
            "currentTime/read" => {
                self.reply_result(
                    id,
                    json!({ "currentTimeAt": chrono::Utc::now().timestamp() }),
                )
                .await;
            }
            "item/commandExecution/requestApproval" => {
                let preview = params
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                self.gate_approval(
                    id,
                    "commandExecution",
                    "Command approval",
                    preview,
                    CodexApprovalResponse::Decision,
                );
            }
            "item/fileChange/requestApproval" => {
                let preview = params
                    .get("grantRoot")
                    .or_else(|| params.get("reason"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                self.gate_approval(
                    id,
                    "fileChange",
                    "File change approval",
                    preview,
                    CodexApprovalResponse::Decision,
                );
            }
            "item/permissions/requestApproval" => {
                let preview = params
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let scope = params.get("scope").cloned().unwrap_or(Value::Null);
                let permissions = params
                    .get("permissions")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                self.gate_approval(
                    id,
                    "permissions",
                    "Permission approval",
                    preview,
                    CodexApprovalResponse::Permissions { scope, permissions },
                );
            }
            // Not permission gates but free-form input requests. There is no UI
            // for them yet, so decline rather than raise an approval card the
            // user cannot actually answer.
            "item/tool/requestUserInput" => {
                tracing::warn!("codex requestUserInput declined (no UI) id={id}");
                self.reply_result(id, json!({ "answers": {} })).await;
            }
            "mcpServer/elicitation/request" => {
                tracing::warn!("codex MCP elicitation cancelled (no UI) id={id}");
                self.reply_result(
                    id,
                    json!({ "action": "cancel", "content": null, "_meta": null }),
                )
                .await;
            }
            _ => {
                tracing::warn!("codex unhandled server request method={method} id={id}");
                self.reply_error(id, -32601, &format!("Method not found: {method}"))
                    .await;
            }
        }
    }

    /// Route an approval through the Host gate and answer when it resolves.
    /// Spawned because the user may take minutes; the reader loop must not stall.
    fn gate_approval(
        self: Arc<Self>,
        id: u64,
        tool_name: &str,
        title: &str,
        preview: String,
        response: CodexApprovalResponse,
    ) {
        let request = PermissionRequest {
            tool_name: tool_name.to_string(),
            title: title.to_string(),
            preview,
        };
        tokio::spawn(async move {
            let decision = self.permissions.request(request).await;
            let result = codex_approval_result(response, decision);
            tracing::info!("codex approval id={id} decision={}", decision.as_str());
            self.reply_result(id, result).await;
        });
    }

    fn handle_notification(&self, method: &str, params: &Value) {
        match method {
            "item/agentMessage/delta" => {
                if self.stopped.load(Ordering::SeqCst) {
                    return;
                }
                let text = params
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !text.is_empty() {
                    if let Some(item_id) = params.get("itemId").and_then(|v| v.as_str()) {
                        self.emitted_agent_message_items
                            .lock()
                            .insert(item_id.to_string());
                    }
                    let _ = self.event_tx.send(HostEvent::Stream {
                        kind: StreamKind::Assistant,
                        text,
                        done: false,
                    });
                }
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                if self.stopped.load(Ordering::SeqCst) {
                    return;
                }
                let text = params
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !text.is_empty() {
                    let _ = self.event_tx.send(HostEvent::Stream {
                        kind: StreamKind::Thought,
                        text,
                        done: false,
                    });
                }
            }
            "item/started" => self.emit_tool_item(params, "running"),
            "item/fileChange/outputDelta" => self.emit_file_change_delta(params),
            "item/completed" => {
                self.emit_completed_agent_message_fallback(params);
                self.emit_completed_file_change(params);
                self.emit_tool_item(params, "completed");
            }
            "turn/completed" => self.complete_turn(params),
            "error" => {
                let message = params
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Codex error")
                    .to_string();
                if is_transient_reconnect_message(&message) {
                    tracing::warn!("codex transient reconnect: {message}");
                    return;
                }
                if let Some(turn_id) = params.get("turnId").and_then(|v| v.as_str()) {
                    self.complete_turn_id(turn_id, Err(message));
                    return;
                }
                let err = classify_codex_error(&message);
                let _ = self.event_tx.send(HostEvent::Error { error: err });
            }
            "thread/status/changed"
            | "thread/started"
            | "thread/tokenUsage/updated"
            | "mcpServer/startupStatus/updated"
            | "skills/changed" => {}
            _ => {
                tracing::debug!("codex notification ignored method={method}");
            }
        }
    }

    fn emit_tool_item(&self, params: &Value, default_status: &str) {
        let item = params.get("item").unwrap_or(params);
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let (name, title) = match item_type {
            "commandExecution" => (
                "command".to_string(),
                item.get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Command")
                    .to_string(),
            ),
            "fileChange" => ("file_change".to_string(), "File change".to_string()),
            "mcpToolCall" => {
                let server = item.get("server").and_then(|v| v.as_str()).unwrap_or("mcp");
                let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
                (format!("{server}/{tool}"), format!("{server}/{tool}"))
            }
            "dynamicToolCall" => {
                let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
                (tool.to_string(), tool.to_string())
            }
            "webSearch" => ("web_search".to_string(), "Web search".to_string()),
            "collabAgentToolCall" => {
                let tool = item
                    .get("tool")
                    .map(value_to_label)
                    .unwrap_or("agent".into());
                (tool.clone(), tool)
            }
            _ => return,
        };

        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = item
            .get("status")
            .map(value_to_label)
            .unwrap_or_else(|| default_status.to_string());
        let _ = self.event_tx.send(HostEvent::ToolCall {
            id,
            name,
            status,
            title,
        });
    }

    fn emit_completed_agent_message_fallback(&self, params: &Value) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }

        let item = params.get("item").unwrap_or(params);
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if item_type != "agentMessage" {
            return;
        }

        let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if !item_id.is_empty() && self.emitted_agent_message_items.lock().contains(item_id) {
            return;
        }

        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
        if text.is_empty() {
            return;
        }

        if !item_id.is_empty() {
            self.emitted_agent_message_items
                .lock()
                .insert(item_id.to_string());
        }
        let _ = self.event_tx.send(HostEvent::Stream {
            kind: StreamKind::Assistant,
            text: text.to_string(),
            done: false,
        });
    }

    fn complete_turn(&self, params: &Value) {
        let turn = params.get("turn").unwrap_or(params);
        let turn_id = turn
            .get("id")
            .and_then(|v| v.as_str())
            .or_else(|| params.get("turnId").and_then(|v| v.as_str()));
        let Some(turn_id) = turn_id else {
            return;
        };

        let status = turn
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed");
        let result = if status == "failed" {
            let message = turn
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("Codex turn failed")
                .to_string();
            Err(message)
        } else {
            Ok(status.to_string())
        };
        self.complete_turn_id(turn_id, result);
    }

    fn complete_turn_id(&self, turn_id: &str, result: Result<String, String>) {
        if let Some(tx) = self.turn_waiters.lock().remove(turn_id) {
            let _ = tx.send(result);
        } else {
            self.completed_turns
                .lock()
                .insert(turn_id.to_string(), result);
        }
    }

    fn emit_file_change_delta(&self, params: &Value) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let item_id = codex_item_id(params).unwrap_or("file_change").to_string();
        let Some(delta) = codex_delta_text(params) else {
            return;
        };
        let text = {
            let mut deltas = self.file_change_deltas.lock();
            let entry = deltas.entry(item_id).or_default();
            entry.push_str(&delta);
            entry.clone()
        };
        let files = parse_codex_file_change_text(&text, &self.cwd);
        if files.is_empty() {
            return;
        }
        let _ = self.event_tx.send(HostEvent::FileChange { files });
    }

    fn emit_completed_file_change(&self, params: &Value) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let item = params.get("item").unwrap_or(params);
        if item.get("type").and_then(|v| v.as_str()) != Some("fileChange") {
            return;
        }

        let item_id = codex_item_id(params).unwrap_or("file_change");
        let files = {
            let deltas = self.file_change_deltas.lock();
            deltas
                .get(item_id)
                .map(|text| parse_codex_file_change_text(text, &self.cwd))
                .unwrap_or_default()
        };
        let files = if files.is_empty() {
            parse_codex_file_change_item(item, &self.cwd)
        } else {
            files
        };
        if files.is_empty() {
            return;
        }
        let _ = self.event_tx.send(HostEvent::FileChange { files });
    }
}

fn codex_client_capabilities() -> Value {
    json!({
        "experimentalApi": true,
        "requestAttestation": false,
        // Command output and plan deltas are still too noisy for the transcript.
        // File-change deltas are projected as compact diff previews.
        "optOutNotificationMethods": [
            "command/exec/outputDelta",
            "item/plan/delta"
        ]
    })
}

fn codex_item_id(params: &Value) -> Option<&str> {
    params
        .get("itemId")
        .and_then(|v| v.as_str())
        .or_else(|| params.pointer("/item/id").and_then(|v| v.as_str()))
        .or_else(|| params.get("id").and_then(|v| v.as_str()))
}

fn codex_delta_text(params: &Value) -> Option<String> {
    ["delta", "text", "output"]
        .iter()
        .find_map(|key| params.get(*key).and_then(|v| v.as_str()))
        .map(str::to_string)
}

fn parse_codex_file_change_text(text: &str, cwd: &Path) -> Vec<FileChangeStat> {
    let mut files = Vec::new();
    let mut current: Option<FileChangeStat> = None;

    for line in text.lines() {
        if let Some((path, additions, deletions)) = parse_codex_file_header(line) {
            if let Some(file) = current.take() {
                files.push(finalize_codex_file_change(file));
            }
            if files.len() >= FILE_CHANGE_MAX_FILES {
                current = Some(FileChangeStat {
                    full_path: full_path_for_change(cwd, &path),
                    path,
                    additions,
                    deletions,
                    hunks: Vec::new(),
                    truncated: true,
                });
                break;
            }
            current = Some(FileChangeStat {
                full_path: full_path_for_change(cwd, &path),
                path,
                additions,
                deletions,
                hunks: vec![FileChangeHunk {
                    old_start: None,
                    new_start: None,
                    lines: Vec::new(),
                    truncated: false,
                }],
                truncated: false,
            });
            continue;
        }

        let Some(file) = current.as_mut() else {
            continue;
        };
        let Some(parsed) = parse_codex_file_change_line(line) else {
            continue;
        };
        let Some(hunk) = file.hunks.first_mut() else {
            continue;
        };
        if hunk.lines.len() >= FILE_CHANGE_MAX_LINES {
            hunk.truncated = true;
            file.truncated = true;
            continue;
        }
        if hunk.old_start.is_none() && parsed.old_line.is_some() {
            hunk.old_start = parsed.old_line;
        }
        if hunk.new_start.is_none() && parsed.new_line.is_some() {
            hunk.new_start = parsed.new_line;
        }
        hunk.lines.push(parsed);
    }

    if let Some(file) = current {
        files.push(finalize_codex_file_change(file));
    }

    files
        .into_iter()
        .filter(|file| file.additions > 0 || file.deletions > 0 || !file.hunks.is_empty())
        .collect()
}

fn parse_codex_file_header(line: &str) -> Option<(String, u32, u32)> {
    let mut text = line.trim();
    text = text.strip_prefix('•').unwrap_or(text).trim();
    text = text.strip_prefix('-').unwrap_or(text).trim();

    let stats_start = text.rfind("(+")?;
    let stats_end = text[stats_start..].find(')')? + stats_start;
    let mut path = text[..stats_start].trim();
    for prefix in [
        "Edited ",
        "Created ",
        "Added ",
        "Modified ",
        "Deleted ",
        "Updated ",
        "Wrote ",
    ] {
        if let Some(rest) = path.strip_prefix(prefix) {
            path = rest.trim();
            break;
        }
    }
    if path.is_empty() {
        return None;
    }

    let stats = &text[stats_start + 1..stats_end];
    let additions = stats
        .split_whitespace()
        .find_map(|part| part.strip_prefix('+'))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let deletions = stats
        .split_whitespace()
        .find_map(|part| part.strip_prefix('-'))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    Some((path.to_string(), additions, deletions))
}

fn parse_codex_file_change_line(line: &str) -> Option<FileChangeLine> {
    let trimmed = line.trim_start();
    let digit_count = trimmed.chars().take_while(|ch| ch.is_ascii_digit()).count();
    if digit_count == 0 {
        return None;
    }
    let number = trimmed[..digit_count].parse::<u32>().ok()?;
    let after_number = trimmed[digit_count..].strip_prefix(' ')?;
    let mut chars = after_number.chars();
    let marker = chars.next()?;
    let content = truncate_file_change_line(chars.as_str());

    match marker {
        '+' => Some(FileChangeLine {
            kind: "add".into(),
            old_line: None,
            new_line: Some(number),
            content,
        }),
        '-' => Some(FileChangeLine {
            kind: "delete".into(),
            old_line: Some(number),
            new_line: None,
            content,
        }),
        ' ' => Some(FileChangeLine {
            kind: "context".into(),
            old_line: Some(number),
            new_line: Some(number),
            content,
        }),
        _ => None,
    }
}

fn finalize_codex_file_change(mut file: FileChangeStat) -> FileChangeStat {
    let mut additions = 0_u32;
    let mut deletions = 0_u32;
    file.hunks.retain(|hunk| !hunk.lines.is_empty());
    for line in file.hunks.iter().flat_map(|hunk| &hunk.lines) {
        match line.kind.as_str() {
            "add" => additions = additions.saturating_add(1),
            "delete" => deletions = deletions.saturating_add(1),
            _ => {}
        }
    }
    if file.additions == 0 {
        file.additions = additions;
    }
    if file.deletions == 0 {
        file.deletions = deletions;
    }
    file
}

fn parse_codex_file_change_item(item: &Value, cwd: &Path) -> Vec<FileChangeStat> {
    let Some(changes) = item.get("changes").and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    changes
        .iter()
        .take(FILE_CHANGE_MAX_FILES)
        .filter_map(|change| {
            let path = ["path", "filePath", "displayPath"]
                .iter()
                .find_map(|key| change.get(*key).and_then(|v| v.as_str()))?;
            let text = ["diff", "patch", "unifiedDiff", "preview"]
                .iter()
                .find_map(|key| change.get(*key).and_then(|v| v.as_str()))
                .unwrap_or("");
            let mut files = parse_codex_file_change_text(text, cwd);
            if let Some(file) = files.pop() {
                return Some(file);
            }
            let additions = change
                .get("additions")
                .and_then(|v| v.as_u64())
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);
            let deletions = change
                .get("deletions")
                .and_then(|v| v.as_u64())
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);
            if additions == 0 && deletions == 0 {
                if let Some(file) = preview_text_file_as_added_change(cwd, path) {
                    return Some(file);
                }
            }
            Some(FileChangeStat {
                path: path.to_string(),
                full_path: full_path_for_change(cwd, path),
                additions,
                deletions,
                hunks: Vec::new(),
                truncated: false,
            })
        })
        .collect()
}

fn preview_text_file_as_added_change(cwd: &Path, path: &str) -> Option<FileChangeStat> {
    let full_path = path_for_change(cwd, path)?;
    let metadata = fs::metadata(&full_path).ok()?;
    if !metadata.is_file() || metadata.len() > FILE_CHANGE_MAX_BYTES {
        return None;
    }

    let bytes = fs::read(&full_path).ok()?;
    if bytes.iter().any(|byte| *byte == 0) {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    let total_lines = text.lines().count();
    if total_lines == 0 {
        return None;
    }

    let mut hunk = FileChangeHunk {
        old_start: None,
        new_start: Some(1),
        lines: Vec::new(),
        truncated: total_lines > FILE_CHANGE_MAX_LINES,
    };
    for (index, line) in text.lines().take(FILE_CHANGE_MAX_LINES).enumerate() {
        let new_line = u32::try_from(index + 1).ok()?;
        hunk.lines.push(FileChangeLine {
            kind: "add".into(),
            old_line: None,
            new_line: Some(new_line),
            content: truncate_file_change_line(line),
        });
    }

    Some(FileChangeStat {
        path: path.to_string(),
        full_path: Some(full_path.display().to_string()),
        additions: u32::try_from(total_lines).unwrap_or(u32::MAX),
        deletions: 0,
        hunks: vec![hunk],
        truncated: total_lines > FILE_CHANGE_MAX_LINES,
    })
}

fn full_path_for_change(cwd: &Path, path: &str) -> Option<String> {
    path_for_change(cwd, path).map(|path| path.display().to_string())
}

fn path_for_change(cwd: &Path, path: &str) -> Option<PathBuf> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(path);
    Some(if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    })
}

fn truncate_file_change_line(value: &str) -> String {
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= FILE_CHANGE_MAX_LINE_CHARS {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

pub async fn read_selection_catalog(
    manifest: &'static RuntimeManifest,
    cwd: PathBuf,
    current_model: Option<String>,
) -> Result<SessionSelectionCatalog, String> {
    let runtime_id = manifest
        .runtime_id()
        .ok_or_else(|| "invalid Codex manifest id".to_string())?;
    let cli = manifest
        .resolve_cli_path()
        .ok_or_else(|| "Codex CLI not found".to_string())?;
    // A throwaway probe session: nothing it does should ever prompt the user,
    // so it gets an auto-allow broker whose events go nowhere.
    let (probe_tx, probe_rx) = mpsc::unbounded_channel();
    drop(probe_rx);
    let permissions = PermissionBroker::new("codex-catalog-probe", PermissionMode::Auto, probe_tx);

    let (client, mut rx) = CodexAppServerClient::spawn(
        cli,
        cwd.clone(),
        None,
        None,
        manifest.default_permission_mode(),
        permissions,
    )
    .map_err(|e| format!("{e:?}"))?;

    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let result: Result<SessionSelectionCatalog, String> = async {
        client
            .initialize_transport("workbench")
            .await
            .map_err(|e| format!("{e:?}"))?;

        let model_options = match client.fetch_model_catalog().await {
            Ok(models) if !models.is_empty() => models,
            Ok(_) | Err(_) => fallback_codex_models(current_model.clone()),
        };
        let permission_options = fallback_codex_permissions();

        Ok::<SessionSelectionCatalog, String>(SessionSelectionCatalog {
            runtime_id,
            model_options: ensure_current_model(model_options, current_model),
            permission_options,
        })
    }
    .await;

    let _ = client.shutdown().await;
    let _ = drain.await;
    result
}

fn fallback_codex_models(current_model: Option<String>) -> Vec<ChoiceOption> {
    let status = crate::route_diagnostics::codex_route_status();
    let mut values = Vec::new();
    if let Some(model) = current_model {
        let model = normalize_codex_model_id(&model);
        if model.is_empty() {
            return fallback_codex_models(None);
        }
        values.push(ChoiceOption {
            value: model.clone(),
            label: model,
            hint: Some("当前会话".into()),
            suffix: None,
            disabled: false,
        });
    }
    for candidate in [
        status.model,
        status.latest_forward_model,
        Some("gpt-5.5".into()),
        Some("gpt-5.4".into()),
        Some("default".into()),
    ] {
        if let Some(model) = candidate {
            let model = normalize_codex_model_id(&model);
            if model.is_empty() {
                continue;
            }
            if !values.iter().any(|opt| opt.value == model) {
                values.push(ChoiceOption {
                    value: model.clone(),
                    label: model.clone(),
                    hint: Some("fallback".into()),
                    suffix: None,
                    disabled: false,
                });
            }
        }
    }
    if values.is_empty() {
        values.push(ChoiceOption::new("default", "default"));
    }
    values
}

fn fallback_codex_permissions() -> Vec<ChoiceOption> {
    vec![
        ChoiceOption {
            value: "ask".into(),
            label: "Ask".into(),
            hint: Some(
                "approvalPolicy=on-request; sandbox=workspace-write; approvalsReviewer=user".into(),
            ),
            suffix: None,
            disabled: false,
        },
        ChoiceOption {
            value: "read_only".into(),
            label: "Read Only".into(),
            hint: Some(
                "approvalPolicy=on-request; sandbox=read-only; approvalsReviewer=user".into(),
            ),
            suffix: None,
            disabled: false,
        },
        ChoiceOption {
            value: "auto".into(),
            label: "Approve for me".into(),
            hint: Some(
                "approvalPolicy=on-request; sandbox=workspace-write; approvalsReviewer=auto_review"
                    .into(),
            ),
            suffix: None,
            disabled: false,
        },
        ChoiceOption {
            value: "full_access".into(),
            label: "Full Access".into(),
            hint: Some("approvalPolicy=never; sandbox=danger-full-access".into()),
            suffix: None,
            disabled: false,
        },
    ]
}

fn ensure_current_model(
    mut options: Vec<ChoiceOption>,
    current_model: Option<String>,
) -> Vec<ChoiceOption> {
    let Some(model) = current_model else {
        return options;
    };
    let model = normalize_codex_model_id(&model);
    if model.is_empty() || options.iter().any(|opt| opt.value == model) {
        return options;
    }
    options.insert(0, {
        ChoiceOption {
            value: model.clone(),
            label: model,
            hint: Some("当前会话".into()),
            suffix: None,
            disabled: false,
        }
    });
    options
}

fn is_hidden_codex_model(model: &str) -> bool {
    model.trim().eq_ignore_ascii_case("gpt-5")
}

fn normalize_codex_model_id(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() || is_hidden_codex_model(trimmed) {
        return String::new();
    }

    let parts: Vec<&str> = trimmed.split('-').collect();
    if parts.len() == 3 && parts[0].eq_ignore_ascii_case("gpt") {
        let suffix = parts[2].to_ascii_lowercase();
        if matches!(suffix.as_str(), "low" | "medium" | "high") {
            return format!("{}-{}", parts[0], parts[1]);
        }
    }

    trimmed.chars().take(120).collect()
}

fn codex_approval_result(response: CodexApprovalResponse, decision: PermissionDecision) -> Value {
    match response {
        CodexApprovalResponse::Decision => {
            let decision = match decision {
                PermissionDecision::AllowOnce => "accept",
                PermissionDecision::AllowAlways => "acceptForSession",
                PermissionDecision::Deny => "decline",
                PermissionDecision::Cancel => "cancel",
            };
            json!({ "decision": decision })
        }
        CodexApprovalResponse::Permissions { scope, permissions } => {
            let permissions = if decision.is_allowed() {
                permissions
            } else {
                Vec::new()
            };
            json!({
                "scope": scope,
                "permissions": permissions,
            })
        }
    }
}

fn normalize_reasoning_effort(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "low" | "medium" | "high" => Some(trimmed.to_ascii_lowercase()),
        _ => None,
    }
}

/// `gpt-5.5-high` → `high`. Codex encodes effort in the model id, so a model
/// switch has to be able to carry the effort with it.
fn codex_reasoning_effort_from_model(model: &str) -> Option<String> {
    let parts: Vec<&str> = model.trim().split('-').collect();
    if parts.len() != 3 || !parts[0].eq_ignore_ascii_case("gpt") {
        return None;
    }
    match parts[2].to_ascii_lowercase().as_str() {
        effort @ ("low" | "medium" | "high") => Some(effort.to_string()),
        _ => None,
    }
}

/// Like [`normalize_reasoning_effort`] but rejects garbage instead of dropping
/// it, so a bad UI value surfaces as an error rather than a silent no-op.
fn validate_reasoning_effort(value: &str) -> Result<Option<String>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    normalize_reasoning_effort(Some(trimmed))
        .map(Some)
        .ok_or(format!(
            "invalid Codex reasoning effort: {trimmed} (expected low, medium, or high)"
        ))
}

fn codex_model_sort_key(option: &ChoiceOption) -> (String, i32, String) {
    (
        codex_model_family_key(&option.value),
        codex_model_variant_rank(&option.value),
        option.value.to_ascii_lowercase(),
    )
}

fn codex_model_family_key(model: &str) -> String {
    let model = model.trim();
    let mut parts = model.splitn(3, '-');
    if parts.next() != Some("gpt") {
        return model.to_ascii_lowercase();
    }

    let Some(version) = parts.next() else {
        return model.to_ascii_lowercase();
    };

    format!("gpt-{version}").to_ascii_lowercase()
}

fn codex_model_variant_rank(model: &str) -> i32 {
    let model = model.trim();
    let mut parts = model.splitn(3, '-');
    if parts.next() != Some("gpt") {
        return 0;
    }
    let _version = parts.next();
    let Some(rest) = parts.next() else {
        return 0;
    };
    match rest.rsplit('-').next().unwrap_or(rest) {
        "low" => 1,
        "medium" => 2,
        "high" => 3,
        "xhigh" => 4,
        "mini" => 5,
        "nano" => 6,
        "minimal" => 7,
        _ => 50,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_capabilities_keep_visible_stream_deltas_enabled() {
        let capabilities = codex_client_capabilities();
        let opt_out = capabilities["optOutNotificationMethods"]
            .as_array()
            .expect("opt-out notification list");

        for visible_method in [
            "item/agentMessage/delta",
            "item/fileChange/outputDelta",
            "item/reasoning/summaryTextDelta",
            "item/reasoning/textDelta",
        ] {
            assert!(
                !opt_out.iter().any(|method| method == visible_method),
                "{visible_method} must be delivered to the chat projection"
            );
        }
    }

    #[test]
    fn command_approval_uses_codex_app_server_decisions() {
        assert_eq!(
            codex_approval_result(
                CodexApprovalResponse::Decision,
                PermissionDecision::AllowOnce
            ),
            json!({ "decision": "accept" })
        );
        assert_eq!(
            codex_approval_result(
                CodexApprovalResponse::Decision,
                PermissionDecision::AllowAlways
            ),
            json!({ "decision": "acceptForSession" })
        );
        assert_eq!(
            codex_approval_result(CodexApprovalResponse::Decision, PermissionDecision::Deny),
            json!({ "decision": "decline" })
        );
    }

    #[test]
    fn permissions_approval_returns_granted_permissions() {
        let response = CodexApprovalResponse::Permissions {
            scope: json!({ "type": "project" }),
            permissions: vec![json!({ "type": "write", "path": "X:\\tmp" })],
        };
        assert_eq!(
            codex_approval_result(response, PermissionDecision::AllowOnce),
            json!({
                "scope": { "type": "project" },
                "permissions": [{ "type": "write", "path": "X:\\tmp" }],
            })
        );

        let response = CodexApprovalResponse::Permissions {
            scope: json!({ "type": "project" }),
            permissions: vec![json!({ "type": "write", "path": "X:\\tmp" })],
        };
        assert_eq!(
            codex_approval_result(response, PermissionDecision::Deny),
            json!({
                "scope": { "type": "project" },
                "permissions": [],
            })
        );
    }

    #[test]
    fn codex_file_change_text_parses_cli_style_diff_preview() {
        let files = parse_codex_file_change_text(
            "\
• Edited X:\\WorkBench\\AGENTS.md (+2 -1)
  10  context
  11 -old
  11 +new
  12 +next
",
            Path::new("X:\\WorkBench"),
        );

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "X:\\WorkBench\\AGENTS.md");
        assert_eq!(files[0].additions, 2);
        assert_eq!(files[0].deletions, 1);
        assert_eq!(files[0].hunks.len(), 1);
        assert_eq!(files[0].hunks[0].lines[0].kind, "context");
        assert_eq!(files[0].hunks[0].lines[1].kind, "delete");
        assert_eq!(files[0].hunks[0].lines[2].kind, "add");
        assert_eq!(files[0].hunks[0].lines[3].new_line, Some(12));
    }

    #[test]
    fn codex_file_change_item_reads_text_file_when_preview_is_missing() {
        let token = format!(
            "workbench-codex-file-change-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let dir = std::env::temp_dir().join(token);
        fs::create_dir_all(&dir).expect("create temp test dir");
        let file = dir.join("created.html");
        fs::write(
            &file,
            "<!doctype html>\n<title>Demo</title>\n<main>ok</main>\n",
        )
        .expect("write temp text file");

        let files = parse_codex_file_change_item(
            &json!({
                "type": "fileChange",
                "changes": [{ "path": "created.html" }]
            }),
            &dir,
        );

        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "created.html");
        assert_eq!(files[0].additions, 3);
        assert_eq!(files[0].deletions, 0);
        assert_eq!(files[0].hunks.len(), 1);
        assert_eq!(files[0].hunks[0].new_start, Some(1));
        assert_eq!(files[0].hunks[0].lines.len(), 3);
        assert_eq!(files[0].hunks[0].lines[0].kind, "add");
        assert_eq!(files[0].hunks[0].lines[0].new_line, Some(1));
        assert_eq!(files[0].hunks[0].lines[0].content, "<!doctype html>");
    }
}

fn normalize_model(model_id: Option<&str>) -> Option<&str> {
    let model = model_id?.trim();
    if model.is_empty() || model.eq_ignore_ascii_case("default") {
        None
    } else {
        Some(model)
    }
}

fn json_id_u64(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    v.as_u64()
        .or_else(|| v.as_i64().and_then(|i| u64::try_from(i).ok()))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn value_to_label(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn format_jsonrpc_error(err: &Value) -> String {
    let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("error");
    let data = err.get("data").map(|d| d.to_string()).unwrap_or_default();
    if data.is_empty() {
        format!("[{code}] {msg}")
    } else {
        format!("[{code}] {msg}: {data}")
    }
}

fn trace_rpc_frame(direction: &str, frame: &Value) {
    if std::env::var("WORKBENCH_CODEX_RPC_TRACE").ok().as_deref() != Some("1") {
        return;
    }

    let path = crate::paths::logs_dir().join("codex-rpc-trace.jsonl");
    let _ = std::fs::create_dir_all(crate::paths::logs_dir());
    let line = json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "direction": direction,
        "frame": redact_rpc_value(frame),
    });

    let _guard = RPC_TRACE_LOCK.get_or_init(|| ParkingMutex::new(())).lock();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line);
    }
}

fn redact_rpc_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let redacted = map.iter().map(|(key, value)| {
                let lower = key.to_ascii_lowercase();
                let value = if lower.contains("authorization")
                    || lower.contains("api_key")
                    || lower.contains("apikey")
                    || lower.contains("token")
                    || lower.contains("secret")
                    || lower.contains("cookie")
                    || lower.contains("password")
                {
                    Value::String("[REDACTED]".into())
                } else {
                    redact_rpc_value(value)
                };
                (key.clone(), value)
            });
            Value::Object(redacted.collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_rpc_value).collect()),
        other => other.clone(),
    }
}

fn is_transient_reconnect_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.starts_with("reconnecting") || lower.contains("reconnecting...")
}

fn is_retryable_prompt_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("timeout")
        || lower.contains("network")
        || lower.contains("dns")
        || lower.contains("connection")
        || lower.contains("reconnecting")
        || lower.contains("bad gateway")
        || lower.contains("upstream")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("/v1/responses")
        || message.contains("上游")
        || message.contains("超时")
        || message.contains("熔断")
}

fn classify_codex_error(e: &str) -> AgentError {
    let lower = e.to_lowercase();
    let message = enrich_codex_error_message(e);
    if lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("auth")
        || lower.contains("login")
    {
        AgentError::new(AgentErrorCode::AuthFailed, message)
    } else if lower.contains("timeout")
        || lower.contains("network")
        || lower.contains("dns")
        || lower.contains("connection")
        || lower.contains("reconnecting")
        || lower.contains("bad gateway")
        || lower.contains("upstream")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("/v1/responses")
    {
        AgentError::new(AgentErrorCode::NetworkProvider, message)
    } else if lower.contains("quota")
        || lower.contains("rate")
        || lower.contains("usage limit")
        || lower.contains("budget")
    {
        AgentError::new(AgentErrorCode::QuotaExceeded, message)
    } else {
        AgentError::new(AgentErrorCode::AgentCrashed, message)
    }
}

fn enrich_codex_error_message(e: &str) -> String {
    let Some(context) = crate::route_diagnostics::codex_config_context() else {
        return e.to_string();
    };
    format!("{e}; Codex config: {context}")
}
