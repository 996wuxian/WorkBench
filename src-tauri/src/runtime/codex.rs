//! Codex adapter — `codex app-server --stdio` (Codex App Server JSON-RPC).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex as ParkingMutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use which::which;

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{HostEvent, StreamKind};
use crate::process_util;
use crate::runtime::capabilities::RuntimeCapabilities;
use crate::runtime::traits::{
    AgentRuntime, ConnectOpts, LiveSession, ProbeResult, PromptInput, RuntimeId,
};

const HANDSHAKE_TIMEOUT_SECS: u64 = 45;
const REQUEST_TIMEOUT_SECS: u64 = 60;
const PROMPT_TIMEOUT_SECS: u64 = 600;

struct Pending {
    method: String,
    tx: oneshot::Sender<Result<Value, String>>,
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

        let (client, mut rx) =
            CodexAppServerClient::spawn(cli, opts.cwd.clone(), opts.model_id.clone())?;

        let bridge_tx = event_tx;
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                if bridge_tx.send(ev).is_err() {
                    break;
                }
            }
        });

        client
            .initialize_and_start_thread("workbench", &opts.cwd, opts.model_id.as_deref())
            .await?;

        Ok(Box::new(CodexLiveSession { client }))
    }
}

struct CodexLiveSession {
    client: Arc<CodexAppServerClient>,
}

#[async_trait]
impl LiveSession for CodexLiveSession {
    fn backend(&self) -> &str {
        self.client.backend()
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

struct CodexAppServerClient {
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    next_id: AtomicU64,
    pending: ParkingMutex<HashMap<u64, Pending>>,
    event_tx: mpsc::UnboundedSender<HostEvent>,
    backend: String,
    cwd: PathBuf,
    model_id: Option<String>,
    thread_id: ParkingMutex<Option<String>>,
    current_turn_id: ParkingMutex<Option<String>>,
    turn_waiters: ParkingMutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
    completed_turns: ParkingMutex<HashMap<String, Result<String, String>>>,
    stopped: AtomicBool,
    reader_alive: AtomicBool,
    stderr_tail: ParkingMutex<Vec<String>>,
}

impl CodexAppServerClient {
    fn spawn(
        cli_path: PathBuf,
        cwd: PathBuf,
        model_id: Option<String>,
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
            thread_id: ParkingMutex::new(None),
            current_turn_id: ParkingMutex::new(None),
            turn_waiters: ParkingMutex::new(HashMap::new()),
            completed_turns: ParkingMutex::new(HashMap::new()),
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

    fn backend(&self) -> &str {
        &self.backend
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

    async fn initialize_and_start_thread(
        &self,
        client_name: &str,
        cwd: &Path,
        model_id: Option<&str>,
    ) -> Result<String, AgentError> {
        self.request_timeout(
            "initialize",
            json!({
                "clientInfo": { "name": client_name, "version": env!("CARGO_PKG_VERSION") },
                "capabilities": null
            }),
            HANDSHAKE_TIMEOUT_SECS,
        )
        .await
        .map_err(|e| self.map_handshake_err("initialize", e))?;

        let mut params = json!({
            "cwd": cwd.to_string_lossy().to_string(),
            "runtimeWorkspaceRoots": [cwd.to_string_lossy().to_string()],
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "sandbox": "workspace-write",
            "ephemeral": true
        });
        if let Some(model) = normalize_model(model_id) {
            params["model"] = json!(model);
        }

        let result = self
            .request_timeout("thread/start", params, HANDSHAKE_TIMEOUT_SECS)
            .await
            .map_err(|e| self.map_handshake_err("thread/start", e))?;

        let thread_id = result
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::ProtocolMismatch,
                    "thread/start response missing thread.id",
                )
            })?
            .to_string();
        let model = result
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        *self.thread_id.lock() = Some(thread_id.clone());
        if let Some(m) = model {
            tracing::info!("codex thread ready model={m} threadId={thread_id}");
        } else {
            tracing::info!("codex thread ready threadId={thread_id}");
        }

        let _ = self.event_tx.send(HostEvent::State {
            state: crate::session_fsm::SessionState::Ready,
            runtime_id: RuntimeId::Codex,
            backend: self.backend.clone(),
        });
        Ok(thread_id)
    }

    fn map_handshake_err(&self, phase: &str, e: String) -> AgentError {
        let detail = self.format_exit_detail(&format!("{phase}: {e}"));
        classify_codex_error(&detail)
    }

    async fn prompt(&self, text: &str) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .clone()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no Codex thread"))?;

        self.stopped.store(false, Ordering::SeqCst);
        let mut params = json!({
            "threadId": thread_id,
            "input": [
                { "type": "text", "text": text, "text_elements": [] }
            ],
            "cwd": self.cwd.to_string_lossy().to_string(),
            "runtimeWorkspaceRoots": [self.cwd.to_string_lossy().to_string()],
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
        });
        if let Some(model) = normalize_model(self.model_id.as_deref()) {
            params["model"] = json!(model);
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
            REQUEST_TIMEOUT_SECS,
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
            "item/completed" => self.emit_tool_item(params, "completed"),
            "turn/completed" => self.complete_turn(params),
            "error" => {
                let message = params
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Codex error")
                    .to_string();
                let err = classify_codex_error(&message);
                let _ = self.event_tx.send(HostEvent::Error { error: err });
                if let Some(turn_id) = params.get("turnId").and_then(|v| v.as_str()) {
                    self.complete_turn_id(turn_id, Err(message));
                }
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

fn classify_codex_error(e: &str) -> AgentError {
    let lower = e.to_lowercase();
    if lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("auth")
        || lower.contains("login")
    {
        AgentError::new(AgentErrorCode::AuthFailed, e)
    } else if lower.contains("timeout")
        || lower.contains("network")
        || lower.contains("dns")
        || lower.contains("connection")
    {
        AgentError::new(AgentErrorCode::NetworkProvider, e)
    } else if lower.contains("quota")
        || lower.contains("rate")
        || lower.contains("usage limit")
        || lower.contains("budget")
    {
        AgentError::new(AgentErrorCode::QuotaExceeded, e)
    } else {
        AgentError::new(AgentErrorCode::AgentCrashed, e)
    }
}
