//! Minimal production ACP client (subset of grok-app AcpClient).
//! Handshake → session/new → session/prompt + stream session/update.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex as ParkingMutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tracing::{debug, error, info, warn};

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{HostEvent, StreamKind};
use crate::host::permissions::{PermissionBroker, PermissionDecision, PermissionRequest};
use crate::process_util;
use crate::runtime::RuntimeId;

const HANDSHAKE_TIMEOUT_SECS: u64 = 45;
const AUTH_TIMEOUT_SECS: u64 = 12;
const PROMPT_TIMEOUT_SECS: u64 = 60;
const PROMPT_MAX_ATTEMPTS: usize = 3;
const PROMPT_RETRY_BACKOFF_MS: u64 = 750;
const PROMPT_COMPLETE_FALLBACK_MS: u64 = 3000;

struct Pending {
    method: String,
    tx: oneshot::Sender<Result<Value, String>>,
}

#[derive(Debug, Clone)]
pub struct AcpSpawnOpts {
    pub cli_path: PathBuf,
    pub cwd: PathBuf,
    pub model_id: Option<String>,
    /// Env var name for agent home (e.g. GROK_HOME).
    pub home_env: Option<String>,
    pub home_dir: Option<PathBuf>,
    /// Args before the model flag, e.g. `["--no-auto-update", "agent"]`.
    pub pre_stdio_args: Vec<String>,
    /// Args that select the stdio transport, appended last. `["stdio"]` for
    /// Grok, `["acp"]` for Kimi, `[]` for a binary that speaks ACP with no
    /// subcommand.
    pub stdio_args: Vec<String>,
    /// Flag used to pin a model; `None` means never pass one.
    pub model_arg: Option<String>,
    pub client_name: String,
    pub runtime_id: RuntimeId,
    /// Host-owned approval gate. Every `session/request_permission` is routed
    /// through this — the transport never decides on its own.
    pub permissions: PermissionBroker,
}

pub struct AcpClient {
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    next_id: AtomicU64,
    pending: ParkingMutex<HashMap<u64, Pending>>,
    event_tx: mpsc::UnboundedSender<HostEvent>,
    agent_session_id: ParkingMutex<Option<String>>,
    runtime_id: RuntimeId,
    backend: String,
    stopped: AtomicBool,
    prompt_has_assistant_output: AtomicBool,
    reader_alive: AtomicBool,
    stderr_tail: ParkingMutex<Vec<String>>,
    permissions: PermissionBroker,
}

impl AcpClient {
    pub fn spawn(
        opts: AcpSpawnOpts,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<HostEvent>), AgentError> {
        if !opts.cli_path.exists() {
            return Err(AgentError::new(
                AgentErrorCode::CliNotFound,
                format!("CLI not found: {}", opts.cli_path.display()),
            ));
        }
        if !opts.cwd.is_dir() {
            return Err(AgentError::new(
                AgentErrorCode::ConnectFailed,
                format!("cwd is not a directory: {}", opts.cwd.display()),
            ));
        }

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let backend = format!("{}_acp", opts.runtime_id.as_str());

        let mut cmd = Command::new(&opts.cli_path);
        for a in &opts.pre_stdio_args {
            cmd.arg(a);
        }
        if let (Some(flag), Some(model)) = (opts.model_arg.as_deref(), opts.model_id.as_deref()) {
            let model = model.trim();
            if !model.is_empty() {
                cmd.args([flag, model]);
            }
        }
        for a in &opts.stdio_args {
            cmd.arg(a);
        }
        cmd.current_dir(&opts.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        process_util::apply_no_window_tokio(&mut cmd);
        if let Some(path) = process_util::enriched_path_env() {
            cmd.env("PATH", path);
        }
        if let (Some(key), Some(dir)) = (&opts.home_env, &opts.home_dir) {
            let _ = std::fs::create_dir_all(dir);
            cmd.env(key, dir);
            info!(
                "acp spawn {} home={}={}",
                opts.runtime_id.as_str(),
                key,
                dir.display()
            );
        }

        let mut child = cmd.spawn().map_err(|e| {
            AgentError::new(
                AgentErrorCode::CliNotFound,
                format!("failed to spawn agent: {e}"),
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no stderr"))?;

        let client = Arc::new(Self {
            child: AsyncMutex::new(Some(child)),
            stdin: AsyncMutex::new(Some(stdin)),
            next_id: AtomicU64::new(1),
            pending: ParkingMutex::new(HashMap::new()),
            event_tx: event_tx.clone(),
            agent_session_id: ParkingMutex::new(None),
            runtime_id: opts.runtime_id,
            backend: backend.clone(),
            stopped: AtomicBool::new(false),
            prompt_has_assistant_output: AtomicBool::new(false),
            reader_alive: AtomicBool::new(true),
            stderr_tail: ParkingMutex::new(Vec::new()),
            permissions: opts.permissions.clone(),
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
                            error!("acp stdout read error: {e}");
                            break;
                        }
                    }
                }
                c.reader_alive.store(false, Ordering::SeqCst);
                c.fail_all_pending("Agent process exited (stdout EOF)");
                // Unblock anything waiting on an approval that can no longer be delivered.
                c.permissions.abort_all();
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
                                debug!(target: "acp.stderr", "{t}");
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let _ = event_tx.send(HostEvent::State {
            state: crate::session_fsm::SessionState::Connecting,
            runtime_id: opts.runtime_id,
            backend,
        });

        Ok((client, event_rx))
    }

    pub fn backend(&self) -> &str {
        &self.backend
    }

    pub fn agent_session_id(&self) -> Option<String> {
        self.agent_session_id.lock().clone()
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
                format!("…{}", &tail[tail.len() - 600..])
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
            return Err(self.format_exit_detail(&format!("agent stdout closed before {method}")));
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
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        info!("acp → {method} id={id}");
        if let Err(e) = self.write_line(&msg).await {
            self.pending.lock().remove(&id);
            return Err(format!("write {method} failed: {e}"));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(Ok(v))) => {
                info!("acp ← {method} id={id} ok");
                Ok(v)
            }
            Ok(Ok(Err(e))) => {
                warn!("acp ← {method} id={id} error: {e}");
                Err(e)
            }
            Ok(Err(_)) => Err(format!("rpc channel closed waiting for {method}")),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(format!("rpc timeout on {method} after {timeout_secs}s"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_line(&msg).await
    }

    pub async fn initialize_and_new_session(
        &self,
        client_name: &str,
        cwd: &std::path::Path,
    ) -> Result<String, AgentError> {
        self.initialize_session(client_name, cwd, None).await
    }

    pub async fn initialize_and_load_session(
        &self,
        client_name: &str,
        cwd: &std::path::Path,
        session_id: &str,
    ) -> Result<String, AgentError> {
        self.initialize_session(client_name, cwd, Some(session_id))
            .await
    }

    async fn initialize_session(
        &self,
        client_name: &str,
        cwd: &std::path::Path,
        session_id: Option<&str>,
    ) -> Result<String, AgentError> {
        let init = self
            .request_timeout(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientInfo": { "name": client_name, "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": {}
                }),
                HANDSHAKE_TIMEOUT_SECS,
            )
            .await
            .map_err(|e| self.map_handshake_err("initialize", e))?;

        info!(
            "acp initialized agentVersion={:?}",
            init.pointer("/_meta/agentVersion")
                .or_else(|| init.pointer("/agentVersion"))
        );

        match self
            .request_timeout(
                "authenticate",
                json!({ "methodId": "cached_token" }),
                AUTH_TIMEOUT_SECS,
            )
            .await
        {
            Ok(_) => info!("acp authenticate cached_token ok"),
            Err(e) => warn!("acp authenticate soft-fail: {e}"),
        }

        let cwd_s = cwd.to_string_lossy().to_string();
        let (method, params) = match session_id {
            Some(session_id) => (
                "session/load",
                json!({
                    "sessionId": session_id,
                    "cwd": cwd_s,
                    "mcpServers": []
                }),
            ),
            None => (
                "session/new",
                json!({
                    "cwd": cwd_s,
                    "mcpServers": []
                }),
            ),
        };
        let result = self
            .request_timeout(method, params, HANDSHAKE_TIMEOUT_SECS)
            .await
            .map_err(|e| self.map_handshake_err(method, e))?;

        let sid = result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .or(session_id)
            .ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::AgentCrashed,
                    format!("{method} missing sessionId"),
                )
            })?
            .to_string();

        *self.agent_session_id.lock() = Some(sid.clone());
        let model_id = result
            .pointer("/models/currentModelId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let _ = self.event_tx.send(HostEvent::State {
            state: crate::session_fsm::SessionState::Ready,
            runtime_id: self.runtime_id,
            backend: self.backend.clone(),
        });
        if let Some(m) = model_id {
            info!("acp session ready model={m} sessionId={sid}");
        } else {
            info!("acp session ready sessionId={sid}");
        }
        Ok(sid)
    }

    fn map_handshake_err(&self, phase: &str, e: String) -> AgentError {
        let detail = self.format_exit_detail(&format!("{phase}: {e}"));
        let lower = detail.to_lowercase();
        if lower.contains("401")
            || lower.contains("auth")
            || lower.contains("unauthor")
            || lower.contains("login")
        {
            AgentError::new(AgentErrorCode::AuthFailed, detail)
        } else if lower.contains("network")
            || lower.contains("dns")
            || lower.contains("timeout")
            || lower.contains("5xx")
        {
            AgentError::new(AgentErrorCode::NetworkProvider, detail)
        } else {
            AgentError::new(AgentErrorCode::ConnectFailed, detail)
        }
    }

    pub async fn prompt(&self, text: &str) -> Result<(), AgentError> {
        let sid = self
            .agent_session_id
            .lock()
            .clone()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no session"))?;

        self.stopped.store(false, Ordering::SeqCst);
        self.prompt_has_assistant_output
            .store(false, Ordering::SeqCst);
        let params = json!({
            "sessionId": sid,
            "prompt": [{ "type": "text", "text": text }]
        });

        for attempt in 1..=PROMPT_MAX_ATTEMPTS {
            self.stopped.store(false, Ordering::SeqCst);
            match self
                .request_timeout("session/prompt", params.clone(), PROMPT_TIMEOUT_SECS)
                .await
            {
                Ok(result) => {
                    let stop = result
                        .get("stopReason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("end_turn")
                        .to_string();

                    if !self.prompt_has_assistant_output.load(Ordering::SeqCst) {
                        return Err(AgentError::new(
                            AgentErrorCode::ProtocolMismatch,
                            format!(
                                "Grok 本轮已结束，但没有返回任何可显示内容（stopReason: {stop}）。请重试；如果持续出现，可能是 Grok CLI/ACP 没有发送 agent_message_chunk。"
                            ),
                        ));
                    }

                    let _ = self
                        .event_tx
                        .send(HostEvent::PromptComplete { stop_reason: stop });
                    return Ok(());
                }
                Err(e) => {
                    if e.to_lowercase().contains("timeout") {
                        warn!(
                            "acp session/prompt attempt {attempt}/{PROMPT_MAX_ATTEMPTS} timed out after {PROMPT_TIMEOUT_SECS}s: {e}"
                        );
                        if attempt < PROMPT_MAX_ATTEMPTS {
                            let _ = self.cancel().await;
                            tokio::time::sleep(std::time::Duration::from_millis(
                                PROMPT_RETRY_BACKOFF_MS,
                            ))
                            .await;
                            continue;
                        }
                        let msg = format!(
                            "Grok 无响应，已超时 {PROMPT_TIMEOUT_SECS} 秒并重试 {PROMPT_MAX_ATTEMPTS} 次: {e}"
                        );
                        return Err(AgentError::new(AgentErrorCode::NetworkProvider, msg));
                    }
                    return Err(classify_rpc_error(&e));
                }
            }
        }

        Err(AgentError::new(
            AgentErrorCode::AgentCrashed,
            "prompt retry loop terminated unexpectedly",
        ))
    }

    pub async fn cancel(&self) -> Result<(), AgentError> {
        let sid = self
            .agent_session_id
            .lock()
            .clone()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no session"))?;
        self.stopped.store(true, Ordering::SeqCst);
        self.notify("session/cancel", json!({ "sessionId": sid }))
            .await
            .map_err(|e| AgentError::new(AgentErrorCode::AgentCrashed, e))?;
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), AgentError> {
        self.stopped.store(true, Ordering::SeqCst);
        self.fail_all_pending("shutdown");
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
                warn!("acp non-json: {e}: {}", &line[..line.len().min(160)]);
                return;
            }
        };

        if let Some(id) = json_id_u64(msg.get("id")) {
            if msg.get("result").is_some() || msg.get("error").is_some() {
                if let Some(p) = self.pending.lock().remove(&id) {
                    if let Some(err) = msg.get("error") {
                        let full = format_jsonrpc_error(err);
                        let _ = p.tx.send(Err(full));
                    } else {
                        let _ =
                            p.tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                    }
                } else if let Some(err) = msg.get("error") {
                    let full = format_jsonrpc_error(err);
                    warn!("acp late error id={id}: {full}");
                    let _ = self.event_tx.send(HostEvent::Error {
                        error: classify_rpc_error(&full),
                    });
                }
                return;
            }
        }

        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            let req_id = json_id_u64(msg.get("id"));

            if method == "session/request_permission" {
                let rpc_id = req_id.unwrap_or(0);
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                let tool_name = tool_call
                    .get("kind")
                    .or_else(|| tool_call.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let title = tool_call
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Tool permission")
                    .to_string();
                let preview = tool_call
                    .get("rawInput")
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                let options = params.get("options").cloned().unwrap_or(json!([]));

                // Awaiting the user can take minutes; never block the reader loop.
                let this = Arc::clone(&self);
                tokio::spawn(async move {
                    let decision = this
                        .permissions
                        .request(PermissionRequest {
                            tool_name: tool_name.clone(),
                            title,
                            preview,
                        })
                        .await;

                    let outcome = match decision {
                        PermissionDecision::AllowOnce | PermissionDecision::AllowAlways => {
                            match pick_option(&options, true) {
                                Some(option_id) => {
                                    json!({ "outcome": "selected", "optionId": option_id })
                                }
                                None => json!({ "outcome": "cancelled" }),
                            }
                        }
                        PermissionDecision::Deny => match pick_option(&options, false) {
                            Some(option_id) => {
                                json!({ "outcome": "selected", "optionId": option_id })
                            }
                            // No reject option offered: cancelling is the only
                            // way to say "no" without granting anything.
                            None => json!({ "outcome": "cancelled" }),
                        },
                        PermissionDecision::Cancel => json!({ "outcome": "cancelled" }),
                    };

                    info!(
                        "acp permission id={rpc_id} tool={tool_name} decision={}",
                        decision.as_str()
                    );
                    let reply = json!({
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "result": { "outcome": outcome }
                    });
                    if let Err(e) = this.write_line(&reply).await {
                        warn!("acp permission reply failed: {e}");
                    }
                });
                return;
            }

            // Plan gate: auto-approve so agent does not hang (UI later).
            if let Some(bare) = method.strip_prefix('_') {
                if bare == "x.ai/exit_plan_mode" {
                    if let Some(id) = req_id {
                        let reply = json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "outcome": "approved" }
                        });
                        let _ = self.write_line(&reply).await;
                    }
                    return;
                }
                if bare == "x.ai/ask_user_question" {
                    if let Some(id) = req_id {
                        let reply = json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "outcome": "cancelled" }
                        });
                        let _ = self.write_line(&reply).await;
                    }
                    return;
                }
            }

            if req_id.is_none() {
                if method == "session/update" || method == "_x.ai/session/update" {
                    self.handle_session_update(msg.get("params").unwrap_or(&Value::Null));
                } else if method == "_x.ai/session/prompt_complete" {
                    let stop = msg
                        .pointer("/params/stopReason")
                        .or_else(|| msg.pointer("/params/stop_reason"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("end_turn")
                        .to_string();
                    let this = Arc::clone(&self);
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            PROMPT_COMPLETE_FALLBACK_MS,
                        ))
                        .await;
                        this.complete_pending_prompt_fallback(&stop);
                    });
                }
                return;
            }

            let id = req_id.unwrap();
            warn!("acp unhandled server request method={method} id={id}");
            let err = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            });
            let _ = self.write_line(&err).await;
        }
    }

    fn complete_pending_prompt_fallback(&self, stop_reason: &str) {
        let mut pending = self.pending.lock();
        let ids: Vec<u64> = pending
            .iter()
            .filter(|(_, p)| p.method == "session/prompt")
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some(p) = pending.remove(&id) {
                info!("acp session/prompt id={id} completed via prompt_complete fallback");
                let _ = p.tx.send(Ok(json!({ "stopReason": stop_reason })));
            }
        }
    }

    fn handle_session_update(&self, params: &Value) {
        let update = params.get("update").unwrap_or(params);
        let kind = update
            .get("sessionUpdate")
            .or_else(|| update.get("session_update"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match kind {
            "agent_message_chunk" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !text.is_empty() {
                    self.prompt_has_assistant_output
                        .store(true, Ordering::SeqCst);
                    let _ = self.event_tx.send(HostEvent::Stream {
                        kind: StreamKind::Assistant,
                        text,
                        done: false,
                    });
                }
            }
            "agent_thought_chunk" | "thought" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(|v| v.as_str())
                    .or_else(|| update.get("text").and_then(|v| v.as_str()))
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
            "tool_call" | "tool_call_update" => {
                let id = update
                    .get("toolCallId")
                    .or_else(|| update.get("tool_call_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = update
                    .get("kind")
                    .or_else(|| update.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let title = update
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&name)
                    .to_string();
                let status = update
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or(if kind == "tool_call" {
                        "pending"
                    } else {
                        "updated"
                    })
                    .to_string();
                let _ = self.event_tx.send(HostEvent::ToolCall {
                    id,
                    name,
                    status,
                    title,
                });
            }
            _ => {
                debug!("acp sessionUpdate ignored kind={kind}");
            }
        }
    }
}

/// Pick the option id matching the Host's decision.
///
/// ACP options carry a `kind` (`allow_once` / `reject_once` / …); that is
/// authoritative. Ids are only a fallback for agents that omit `kind`. There is
/// deliberately no "just take the first option" fallback: guessing could turn a
/// deny into an allow.
fn pick_option(options: &Value, allow: bool) -> Option<String> {
    let arr = options.as_array()?;
    let option_id = |o: &Value| -> Option<String> {
        o.get("optionId")
            .or_else(|| o.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    let wanted_kinds: &[&str] = if allow {
        &["allow_once", "allow_always"]
    } else {
        &["reject_once", "reject_always"]
    };
    for kind in wanted_kinds {
        for o in arr {
            if o.get("kind").and_then(|v| v.as_str()) == Some(*kind) {
                if let Some(id) = option_id(o) {
                    return Some(id);
                }
            }
        }
    }

    let needles: &[&str] = if allow {
        &["allow", "approve", "accept", "yes"]
    } else {
        &["reject", "deny", "decline", "no"]
    };
    for o in arr {
        let Some(id) = option_id(o) else { continue };
        let lower = id.to_ascii_lowercase();
        if needles.iter().any(|needle| lower.contains(needle)) {
            return Some(id);
        }
    }
    None
}

fn json_id_u64(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    v.as_u64()
        .or_else(|| v.as_i64().map(|i| i as u64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
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

fn classify_rpc_error(e: &str) -> AgentError {
    let lower = e.to_lowercase();
    if lower.contains("401")
        || lower.contains("auth")
        || lower.contains("unauthor")
        || lower.contains("login")
    {
        AgentError::new(AgentErrorCode::AuthFailed, e)
    } else if lower.contains("timeout") || lower.contains("network") || lower.contains("dns") {
        AgentError::new(AgentErrorCode::NetworkProvider, e)
    } else if lower.contains("quota") || lower.contains("rate") {
        AgentError::new(AgentErrorCode::QuotaExceeded, e)
    } else {
        AgentError::new(AgentErrorCode::AgentCrashed, e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Value {
        json!([
            { "optionId": "a1", "kind": "allow_once", "name": "Allow" },
            { "optionId": "r1", "kind": "reject_once", "name": "Reject" }
        ])
    }

    #[test]
    fn pick_option_uses_kind_when_present() {
        assert_eq!(pick_option(&options(), true).as_deref(), Some("a1"));
        assert_eq!(pick_option(&options(), false).as_deref(), Some("r1"));
    }

    #[test]
    fn pick_option_falls_back_to_id_heuristics() {
        let opts = json!([{ "optionId": "approve_all" }, { "optionId": "decline" }]);
        assert_eq!(pick_option(&opts, true).as_deref(), Some("approve_all"));
        assert_eq!(pick_option(&opts, false).as_deref(), Some("decline"));
    }

    #[test]
    fn pick_option_never_guesses_an_unrelated_option() {
        // Only an allow option is offered: a deny must not select it.
        let opts = json!([{ "optionId": "allow_once", "kind": "allow_once" }]);
        assert_eq!(pick_option(&opts, false), None);
        assert_eq!(pick_option(&json!([]), true), None);
    }
}
