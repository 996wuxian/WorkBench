//! Codex adapter — `codex app-server --stdio` (Codex App Server JSON-RPC).

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
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
use which::which;

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{HostEvent, StreamKind};
use crate::process_util;
use crate::runtime::capabilities::RuntimeCapabilities;
use crate::runtime::catalog::{ChoiceOption, SessionSelectionCatalog};
use crate::runtime::traits::{
    AgentRuntime, ConnectOpts, LiveSession, PermissionMode, ProbeResult, PromptInput, RuntimeId,
};

const HANDSHAKE_TIMEOUT_SECS: u64 = 45;
const REQUEST_TIMEOUT_SECS: u64 = 60;
const INTERRUPT_TIMEOUT_SECS: u64 = 5;
const PROMPT_TIMEOUT_SECS: u64 = 60;
const PROMPT_MAX_ATTEMPTS: usize = 3;
const PROMPT_RETRY_BACKOFF_MS: u64 = 1000;
static RPC_TRACE_LOCK: OnceLock<ParkingMutex<()>> = OnceLock::new();

struct Pending {
    method: String,
    tx: oneshot::Sender<Result<Value, String>>,
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

pub struct CodexRuntime;

#[async_trait]
impl AgentRuntime for CodexRuntime {
    fn id(&self) -> RuntimeId {
        RuntimeId::Codex
    }

    fn capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities::codex_app_server()
    }

    async fn probe(&self) -> ProbeResult {
        let path = resolve_codex_path();
        match path {
            Some(p) => {
                let version = read_version(&p).await;
                ProbeResult {
                    runtime_id: RuntimeId::Codex,
                    found: true,
                    path: Some(p.display().to_string()),
                    version,
                    detail: Some("spawn: codex app-server --stdio".into()),
                }
            }
            None => ProbeResult {
                runtime_id: RuntimeId::Codex,
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
        let cli = opts.cli_path.or_else(resolve_codex_path).ok_or_else(|| {
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
            native_thread_id: ParkingMutex::new(native_thread_id),
            native_session_id: ParkingMutex::new(native_session_id),
            native_home: resolve_codex_home(),
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
            match client.prompt_once(&input.text).await {
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
    native_thread_id: Option<String>,
    event_tx: mpsc::UnboundedSender<HostEvent>,
) -> Result<Arc<CodexAppServerClient>, AgentError> {
    let (client, rx) = CodexAppServerClient::spawn(
        cli,
        cwd.clone(),
        model_id.clone(),
        model_reasoning_effort.clone(),
        permission_mode,
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
    thread_id: ParkingMutex<Option<String>>,
    thread_session_id: ParkingMutex<Option<String>>,
    current_turn_id: ParkingMutex<Option<String>>,
    turn_waiters: ParkingMutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
    completed_turns: ParkingMutex<HashMap<String, Result<String, String>>>,
    emitted_agent_message_items: ParkingMutex<HashSet<String>>,
    stopped: AtomicBool,
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
            thread_id: ParkingMutex::new(None),
            thread_session_id: ParkingMutex::new(None),
            current_turn_id: ParkingMutex::new(None),
            turn_waiters: ParkingMutex::new(HashMap::new()),
            completed_turns: ParkingMutex::new(HashMap::new()),
            emitted_agent_message_items: ParkingMutex::new(HashSet::new()),
            stopped: AtomicBool::new(false),
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
                c.reader_alive.store(false, Ordering::SeqCst);
                c.fail_all_pending("Codex app-server exited (stdout EOF)");
                c.fail_all_turns("Codex app-server exited");
                let _ = c.event_tx.send(HostEvent::ProcessExited { code: None });
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
            runtime_id: RuntimeId::Codex,
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
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(Ok(v))) => {
                tracing::info!("codex ← {method} id={id} ok");
                Ok(v)
            }
            Ok(Ok(Err(e))) => {
                tracing::warn!("codex ← {method} id={id} error: {e}");
                Err(e)
            }
            Ok(Err(_)) => Err(format!("rpc channel closed waiting for {method}")),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(format!("rpc timeout on {method} after {timeout_secs}s"))
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
                "capabilities": {
                    "experimentalApi": true,
                    "requestAttestation": false,
                    "optOutNotificationMethods": [
                        "command/exec/outputDelta",
                        "item/agentMessage/delta",
                        "item/plan/delta",
                        "item/fileChange/outputDelta",
                        "item/reasoning/summaryTextDelta",
                        "item/reasoning/textDelta"
                    ]
                }
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
            runtime_id: RuntimeId::Codex,
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

    async fn prompt_once(&self, text: &str) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .clone()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no Codex thread"))?;

        self.stopped.store(false, Ordering::SeqCst);
        self.emitted_agent_message_items.lock().clear();
        let mut params = json!({
            "threadId": thread_id,
            "input": [
                { "type": "text", "text": text, "text_elements": [] }
            ],
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
            match tokio::time::timeout(std::time::Duration::from_secs(PROMPT_TIMEOUT_SECS), rx)
                .await
            {
                Ok(Ok(done)) => done,
                Ok(Err(_)) => Err("turn waiter closed".to_string()),
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
                    Err(format!(
                        "turn timeout after {PROMPT_TIMEOUT_SECS}s (turnId={turn_id})"
                    ))
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

    async fn handle_server_request(&self, id: u64, method: &str, params: &Value) {
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
                self.emit_permission(id, "commandExecution", "Command approval", &preview);
                self.reply_result(id, json!({ "decision": "decline" }))
                    .await;
            }
            "item/fileChange/requestApproval" => {
                let preview = params
                    .get("grantRoot")
                    .or_else(|| params.get("reason"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                self.emit_permission(id, "fileChange", "File change approval", &preview);
                self.reply_result(id, json!({ "decision": "decline" }))
                    .await;
            }
            "item/tool/requestUserInput" => {
                self.emit_permission(id, "userInput", "User input required", "");
                self.reply_result(id, json!({ "answers": {} })).await;
            }
            "mcpServer/elicitation/request" => {
                self.emit_permission(id, "mcpElicitation", "MCP input required", "");
                self.reply_result(
                    id,
                    json!({ "action": "cancel", "content": null, "_meta": null }),
                )
                .await;
            }
            "item/permissions/requestApproval" => {
                let reason = params
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                self.emit_permission(id, "permissions", "Permission approval", &reason);
                self.reply_error(id, -32001, "permission approval UI is not implemented")
                    .await;
            }
            _ => {
                tracing::warn!("codex unhandled server request method={method} id={id}");
                self.reply_error(id, -32601, &format!("Method not found: {method}"))
                    .await;
            }
        }
    }

    fn emit_permission(&self, id: u64, tool_name: &str, title: &str, preview: &str) {
        let _ = self.event_tx.send(HostEvent::PermissionRequest {
            rpc_id: id.to_string(),
            tool_name: tool_name.to_string(),
            title: title.to_string(),
            preview: preview.chars().take(400).collect(),
            auto_allowed: false,
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
            "item/completed" => {
                self.emit_completed_agent_message_fallback(params);
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
}

fn resolve_codex_path() -> Option<PathBuf> {
    if let Ok(p) = which("codex") {
        return Some(p);
    }
    let candidates = [
        r"D:\codex\codex.exe",
        r"%USERPROFILE%\.codex\bin\codex.exe",
        r"%LOCALAPPDATA%\Programs\codex\codex.exe",
    ];
    for c in candidates {
        let expanded = expand_env(c);
        let p = PathBuf::from(&expanded);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn resolve_codex_home() -> PathBuf {
    if let Ok(h) = std::env::var("CODEX_HOME") {
        let p = PathBuf::from(h);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    process_util::user_home().join(".codex")
}

fn expand_env(s: &str) -> String {
    let mut out = s.to_string();
    if let Ok(v) = std::env::var("USERPROFILE") {
        out = out.replace("%USERPROFILE%", &v);
    }
    if let Ok(v) = std::env::var("LOCALAPPDATA") {
        out = out.replace("%LOCALAPPDATA%", &v);
    }
    if let Ok(v) = std::env::var("HOME") {
        out = out.replace("%USERPROFILE%", &v);
    }
    out
}

pub async fn read_selection_catalog(
    cwd: PathBuf,
    current_model: Option<String>,
) -> Result<SessionSelectionCatalog, String> {
    let cli = resolve_codex_path().ok_or_else(|| "Codex CLI not found".to_string())?;
    let (client, mut rx) = CodexAppServerClient::spawn(
        cli,
        cwd.clone(),
        None,
        None,
        PermissionMode::default_for_runtime(RuntimeId::Codex),
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
            runtime_id: RuntimeId::Codex,
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
