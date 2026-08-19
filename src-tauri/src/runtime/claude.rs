//! Claude Code adapter — `claude -p --output-format stream-json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex as ParkingMutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{HostEvent, StreamKind};
use crate::host::permissions::{PermissionBroker, PermissionDecision, PermissionRequest};
use crate::process_util;
use crate::runtime::catalog::{self, ChoiceOption, SessionSelectionCatalog};
use crate::runtime::manifest::RuntimeManifest;
use crate::runtime::traits::{
    AgentRuntime, ConnectOpts, LiveSession, PermissionMode, ProbeResult, PromptInput,
};

const CLAUDE_PERMISSION_MCP_SERVER: &str = "workbench_permissions";
const CLAUDE_PERMISSION_TOOL_NAME: &str = "mcp__workbench_permissions__approval_prompt";
const PROMPT_TIMEOUT_SECS: u64 = 60 * 20;

pub struct ClaudeRuntime {
    manifest: &'static RuntimeManifest,
}

impl ClaudeRuntime {
    pub fn new(manifest: &'static RuntimeManifest) -> Self {
        Self { manifest }
    }
}

#[async_trait]
impl AgentRuntime for ClaudeRuntime {
    fn manifest(&self) -> &'static RuntimeManifest {
        self.manifest
    }

    async fn probe(&self) -> ProbeResult {
        match resolve_claude_cli(self.manifest) {
            Some(path) => {
                let version = read_version(&path, &self.manifest.version_args).await;
                ProbeResult {
                    runtime_id: self.id(),
                    found: true,
                    path: Some(path.display().to_string()),
                    version,
                    detail: Some("spawn: claude -p --output-format stream-json".into()),
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

    async fn selection_catalog(
        &self,
        _cwd: PathBuf,
        current_model: Option<String>,
    ) -> Result<SessionSelectionCatalog, String> {
        let mut catalog = catalog::from_manifest(self.manifest, current_model.clone());
        catalog.model_options = claude_model_options(self.manifest, current_model);
        Ok(catalog)
    }

    async fn connect(
        &self,
        opts: ConnectOpts,
        event_tx: mpsc::UnboundedSender<HostEvent>,
    ) -> Result<Box<dyn LiveSession>, AgentError> {
        let cli = opts
            .cli_path
            .or_else(|| resolve_claude_cli(self.manifest))
            .ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::CliNotFound,
                    "Claude Code CLI not found (expected `claude`)",
                )
            })?;

        if !opts.cwd.is_dir() {
            return Err(AgentError::new(
                AgentErrorCode::ConnectFailed,
                format!("cwd is not a directory: {}", opts.cwd.display()),
            ));
        }

        Ok(Box::new(ClaudeLiveSession {
            cli_path: cli,
            cwd: opts.cwd,
            model_id: opts.model_id,
            permission_mode: opts.permission_mode,
            native_session_id: ParkingMutex::new(opts.native_session_id),
            native_home: self.manifest.resolve_home(),
            claude_permission_bridge_script_path: opts.claude_permission_bridge_script_path,
            permissions: opts.permissions,
            event_tx,
            prompt_lock: AsyncMutex::new(()),
            current_child: AsyncMutex::new(None),
            cancelled: AtomicBool::new(false),
        }))
    }
}

struct ClaudeLiveSession {
    cli_path: PathBuf,
    cwd: PathBuf,
    model_id: Option<String>,
    permission_mode: PermissionMode,
    native_session_id: ParkingMutex<Option<String>>,
    native_home: PathBuf,
    claude_permission_bridge_script_path: Option<PathBuf>,
    permissions: PermissionBroker,
    event_tx: mpsc::UnboundedSender<HostEvent>,
    prompt_lock: AsyncMutex<()>,
    current_child: AsyncMutex<Option<Child>>,
    cancelled: AtomicBool,
}

#[async_trait]
impl LiveSession for ClaudeLiveSession {
    fn backend(&self) -> &str {
        "claude_code_stream_json"
    }

    fn native_session_id(&self) -> Option<String> {
        self.native_session_id.lock().clone()
    }

    fn native_home(&self) -> Option<String> {
        Some(self.native_home.display().to_string())
    }

    async fn prompt(&self, input: PromptInput) -> Result<(), AgentError> {
        let _guard = self.prompt_lock.lock().await;
        self.cancelled.store(false, Ordering::SeqCst);

        let bridge = if self.permission_mode == PermissionMode::FullAccess {
            None
        } else {
            Some(
                ClaudePermissionBridge::start(
                    self.permissions.clone(),
                    self.claude_permission_bridge_script_path.clone(),
                )
                .await?,
            )
        };
        let bridge_config = bridge.as_ref().map(|bridge| bridge.cli_config());

        let mut child = spawn_claude_prompt(
            &self.cli_path,
            &self.cwd,
            self.model_id.as_deref(),
            self.permission_mode,
            self.native_session_id.lock().clone().as_deref(),
            bridge_config.as_ref(),
            &input.text,
        )?;

        let stdout = child.stdout.take().ok_or_else(|| {
            AgentError::new(AgentErrorCode::AgentCrashed, "Claude stdout missing")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AgentError::new(AgentErrorCode::AgentCrashed, "Claude stderr missing")
        })?;

        {
            let mut slot = self.current_child.lock().await;
            *slot = Some(child);
        }

        let stderr_tail = Arc::new(ParkingMutex::new(Vec::<String>::new()));
        let stderr_task = {
            let stderr_tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let line = line.trim_end();
                            if !line.is_empty() {
                                push_tail(&stderr_tail, line);
                                tracing::debug!(target: "claude.stderr", "{line}");
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
        };

        let mut stream = ClaudePromptStream::new(self.event_tx.clone());
        let read_result = {
            let mut read_task = Box::pin(read_stdout(stdout, &mut stream));
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(PROMPT_TIMEOUT_SECS),
                    &mut read_task,
                )
                .await
                {
                    Ok(result) => break Ok(result),
                    Err(_) if self.permissions.has_pending() => {
                        tracing::info!(
                            "Claude stdout read reached {PROMPT_TIMEOUT_SECS}s while permission is pending; continuing to wait"
                        );
                    }
                    Err(err) => break Err(err),
                }
            }
        };

        if read_result.is_err() {
            let _ = self.cancel().await;
            self.permissions.abort_all();
        }

        let status = {
            let mut slot = self.current_child.lock().await;
            match slot.as_mut() {
                Some(child) => child.wait().await.ok(),
                None => None,
            }
        };
        {
            let mut slot = self.current_child.lock().await;
            *slot = None;
        }
        let _ = stderr_task.await;
        if let Some(bridge) = bridge {
            bridge.shutdown().await;
        }
        self.permissions.abort_all();

        if let Some(session_id) = stream.session_id {
            *self.native_session_id.lock() = Some(session_id);
        }

        if self.cancelled.load(Ordering::SeqCst) {
            return Err(AgentError::new(
                AgentErrorCode::AgentCrashed,
                "Claude prompt cancelled",
            ));
        }

        if read_result.is_err() {
            return Err(AgentError::new(
                AgentErrorCode::NetworkProvider,
                format!("Claude Code 超时超过 {PROMPT_TIMEOUT_SECS} 秒"),
            ));
        }

        if let Some(error) = stream.result_error {
            return Err(error);
        }

        match status {
            Some(status) if status.success() => {
                let _ = self.event_tx.send(HostEvent::PromptComplete {
                    stop_reason: stream.stop_reason.unwrap_or_else(|| "completed".into()),
                });
                Ok(())
            }
            Some(status) => {
                let code = status.code();
                let stderr = stderr_tail.lock().join("\n");
                Err(classify_claude_error(&stderr, code))
            }
            None => Err(AgentError::new(
                AgentErrorCode::AgentCrashed,
                "Claude process exited without a status",
            )),
        }
    }

    async fn cancel(&self) -> Result<(), AgentError> {
        self.cancelled.store(true, Ordering::SeqCst);
        self.permissions.abort_all();
        let mut slot = self.current_child.lock().await;
        if let Some(child) = slot.as_mut() {
            let _ = child.kill().await;
        }
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), AgentError> {
        self.cancel().await
    }
}

fn spawn_claude_prompt(
    cli_path: &Path,
    cwd: &Path,
    model_id: Option<&str>,
    permission_mode: PermissionMode,
    native_session_id: Option<&str>,
    bridge: Option<&ClaudePermissionBridgeCliConfig>,
    prompt: &str,
) -> Result<Child, AgentError> {
    let mut cmd = Command::new(cli_path);
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("-p")
        .arg(prompt)
        .args(["--output-format", "stream-json"])
        .arg("--verbose");

    if let Some(model) = normalize_model(model_id) {
        cmd.args(["--model", model]);
    }
    if let Some(session_id) = native_session_id.filter(|id| !id.trim().is_empty()) {
        cmd.args(["--resume", session_id]);
    }
    if let Some(bridge) = bridge {
        cmd.args(["--mcp-config", &bridge.mcp_config_path]);
        cmd.args(["--permission-prompt-tool", CLAUDE_PERMISSION_TOOL_NAME]);
        cmd.args(["--allowedTools", CLAUDE_PERMISSION_TOOL_NAME]);
    }
    match permission_mode {
        PermissionMode::FullAccess => {
            cmd.arg("--dangerously-skip-permissions");
        }
        mode => {
            cmd.args(["--permission-mode", claude_permission_mode(mode)]);
        }
    }

    process_util::apply_no_window_tokio(&mut cmd);
    if let Some(path) = process_util::enriched_path_env() {
        cmd.env("PATH", path);
    }

    cmd.spawn().map_err(|err| {
        AgentError::new(
            AgentErrorCode::CliNotFound,
            format!("failed to spawn Claude Code: {err}"),
        )
    })
}

struct ClaudePermissionBridge {
    config_path: PathBuf,
    #[cfg(test)]
    url: String,
    #[cfg(test)]
    token: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

struct ClaudePermissionBridgeCliConfig {
    mcp_config_path: String,
}

impl ClaudePermissionBridge {
    async fn start(
        permissions: PermissionBroker,
        script_path: Option<PathBuf>,
    ) -> Result<Self, AgentError> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|err| {
            AgentError::new(
                AgentErrorCode::ConnectFailed,
                format!("failed to start Claude permission bridge: {err}"),
            )
        })?;
        let addr = listener.local_addr().map_err(|err| {
            AgentError::new(
                AgentErrorCode::ConnectFailed,
                format!("failed to read Claude permission bridge address: {err}"),
            )
        })?;
        let url = format!("http://{addr}/permission");
        let token = uuid::Uuid::new_v4().to_string();
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        let task_token = token.clone();

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else {
                            break;
                        };
                        let permissions = permissions.clone();
                        let token = task_token.clone();
                        tokio::spawn(async move {
                            handle_claude_permission_http(stream, permissions, token).await;
                        });
                    }
                }
            }
        });

        let script_path = script_path
            .filter(|path| path.is_file())
            .unwrap_or_else(claude_permission_bridge_script_path);
        let config_path = write_claude_mcp_config(&script_path, &url, &token)?;

        Ok(Self {
            config_path,
            #[cfg(test)]
            url,
            #[cfg(test)]
            token,
            shutdown_tx: Some(shutdown_tx),
            task,
        })
    }

    fn cli_config(&self) -> ClaudePermissionBridgeCliConfig {
        ClaudePermissionBridgeCliConfig {
            mcp_config_path: self.config_path.display().to_string(),
        }
    }

    #[cfg(test)]
    fn url(&self) -> &str {
        &self.url
    }

    #[cfg(test)]
    fn token(&self) -> &str {
        &self.token
    }

    async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), self.task).await;
        let _ = std::fs::remove_file(&self.config_path);
    }
}

fn claude_permission_bridge_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("runtime")
        .join("claude_permission_bridge.mjs")
}

fn write_claude_mcp_config(
    script_path: &Path,
    url: &str,
    token: &str,
) -> Result<PathBuf, AgentError> {
    let dir = crate::paths::claude_mcp_temp_dir();
    std::fs::create_dir_all(&dir).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to create Claude MCP temp dir: {err}"),
        )
    })?;
    let path = dir.join(format!("{}.json", uuid::Uuid::new_v4()));

    let mut servers = serde_json::Map::new();
    servers.insert(
        CLAUDE_PERMISSION_MCP_SERVER.to_string(),
        json!({
            "command": "node",
            "args": [
                script_path.display().to_string(),
                url,
                token
            ]
        }),
    );
    let text =
        serde_json::to_string(&json!({ "mcpServers": Value::Object(servers) })).map_err(|err| {
            AgentError::new(
                AgentErrorCode::ConnectFailed,
                format!("failed to encode Claude MCP config: {err}"),
            )
        })?;

    std::fs::write(&path, text).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to write Claude MCP config: {err}"),
        )
    })?;
    Ok(path)
}

#[derive(Debug, Deserialize)]
struct ClaudePermissionBridgeRequest {
    #[serde(alias = "toolName")]
    tool_name: String,
    #[serde(default)]
    input: Value,
}

async fn handle_claude_permission_http(
    mut stream: TcpStream,
    permissions: PermissionBroker,
    token: String,
) {
    let Ok(request) = read_http_request(&mut stream).await else {
        let _ = write_http_json(
            &mut stream,
            400,
            json!({ "behavior": "deny", "message": "Invalid permission bridge request." }),
        )
        .await;
        return;
    };

    if request.method != "POST" || request.path != "/permission" {
        let _ = write_http_json(
            &mut stream,
            404,
            json!({ "behavior": "deny", "message": "Unknown permission bridge endpoint." }),
        )
        .await;
        return;
    }

    let expected_auth = format!("Bearer {token}");
    if request.header("authorization") != Some(expected_auth.as_str()) {
        let _ = write_http_json(
            &mut stream,
            401,
            json!({ "behavior": "deny", "message": "Permission bridge token mismatch." }),
        )
        .await;
        return;
    }

    let parsed = serde_json::from_slice::<ClaudePermissionBridgeRequest>(&request.body);
    let Ok(payload) = parsed else {
        let _ = write_http_json(
            &mut stream,
            400,
            json!({ "behavior": "deny", "message": "Invalid permission bridge payload." }),
        )
        .await;
        return;
    };

    let tool_name = payload.tool_name.trim();
    let tool_name = if tool_name.is_empty() {
        "tool"
    } else {
        tool_name
    };
    let input = if payload.input.is_null() {
        json!({})
    } else {
        payload.input
    };

    let decision = permissions
        .request(PermissionRequest {
            tool_name: format!("claude:{tool_name}"),
            title: claude_permission_title(tool_name, &input),
            preview: claude_permission_preview(tool_name, &input),
        })
        .await;

    let response = match decision {
        PermissionDecision::AllowOnce | PermissionDecision::AllowAlways => {
            json!({ "behavior": "allow", "updatedInput": input })
        }
        PermissionDecision::Deny => {
            json!({ "behavior": "deny", "message": "Workbench denied this Claude Code tool call." })
        }
        PermissionDecision::Cancel => {
            json!({ "behavior": "deny", "message": "Workbench cancelled this Claude Code tool call." })
        }
    };
    let _ = write_http_json(&mut stream, 200, response).await;
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

async fn read_http_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    const MAX_REQUEST_BYTES: usize = 512 * 1024;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "connection closed before headers",
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "permission request too large",
            ));
        }

        let Some(header_end) = find_header_end(&bytes) else {
            continue;
        };
        let header_text = String::from_utf8_lossy(&bytes[..header_end]).to_string();
        let content_length = parse_content_length(&header_text).unwrap_or(0);
        let body_start = header_end + 4;
        let total_len = body_start + content_length;
        while bytes.len() < total_len {
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "connection closed before body",
                ));
            }
            bytes.extend_from_slice(&chunk[..read]);
            if bytes.len() > MAX_REQUEST_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "permission request too large",
                ));
            }
        }

        let mut lines = header_text.lines();
        let first_line = lines.next().unwrap_or("");
        let mut parts = first_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();
        let headers = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect();
        let body = bytes[body_start..total_len].to_vec();
        return Ok(HttpRequest {
            method,
            path,
            headers,
            body,
        });
    }
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse().ok())
            .flatten()
    })
}

async fn write_http_json(stream: &mut TcpStream, status: u16, body: Value) -> std::io::Result<()> {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    let body = body.to_string();
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await
}

fn claude_permission_title(tool_name: &str, input: &Value) -> String {
    if let Some(path) = first_string_field(input, &["file_path", "path", "notebook_path"]) {
        return format!("Claude Code 请求 {tool_name}: {path}");
    }
    if let Some(command) = first_string_field(input, &["command"]) {
        return format!("Claude Code 请求 {tool_name}: {command}");
    }
    format!("Claude Code 请求 {tool_name} 权限")
}

fn claude_permission_preview(tool_name: &str, input: &Value) -> String {
    let input = serde_json::to_string_pretty(input).unwrap_or_else(|_| input.to_string());
    format!("tool: {tool_name}\ninput:\n{input}")
}

fn first_string_field<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a str> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(|v| v.as_str()))
        .filter(|v| !v.trim().is_empty())
}

fn claude_permission_mode(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Ask => "default",
        PermissionMode::Auto => "auto",
        PermissionMode::ReadOnly => "plan",
        PermissionMode::FullAccess => "bypassPermissions",
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

#[derive(Debug, Default, Deserialize)]
struct ClaudeSettings {
    #[serde(default)]
    env: HashMap<String, String>,
}

fn claude_model_options(
    manifest: &RuntimeManifest,
    current_model: Option<String>,
) -> Vec<ChoiceOption> {
    let env = read_claude_model_env(&manifest.resolve_home());
    let mut options = Vec::new();

    if let Some(model) = env
        .get("ANTHROPIC_MODEL")
        .and_then(|v| clean_model_value(v))
    {
        options.push(ChoiceOption {
            value: "default".into(),
            label: model.clone(),
            hint: Some("Claude Code 默认模型 · ANTHROPIC_MODEL".into()),
            suffix: None,
            disabled: false,
        });
    }

    push_alias_model(
        &mut options,
        "opus",
        env.get("ANTHROPIC_DEFAULT_OPUS_MODEL"),
        "opus alias",
    );
    push_alias_model(
        &mut options,
        "sonnet",
        env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
        "sonnet alias",
    );
    push_alias_model(
        &mut options,
        "haiku",
        env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
        "haiku alias",
    );
    for option in &manifest.models {
        if options
            .iter()
            .any(|existing| existing.value == option.value)
        {
            continue;
        }
        options.push(option.clone());
    }

    ensure_current_model_option(options, current_model)
}

fn push_alias_model(
    options: &mut Vec<ChoiceOption>,
    value: &str,
    model: Option<&String>,
    hint: &str,
) {
    let Some(model) = model.and_then(|v| clean_model_value(v)) else {
        return;
    };
    if options.iter().any(|option| option.value == value) {
        return;
    }
    options.push(ChoiceOption {
        value: value.into(),
        label: model,
        hint: Some(format!("Claude Code {hint}")),
        suffix: None,
        disabled: false,
    });
}

fn ensure_current_model_option(
    mut options: Vec<ChoiceOption>,
    current_model: Option<String>,
) -> Vec<ChoiceOption> {
    let Some(current) = current_model.and_then(|v| clean_model_value(&v)) else {
        return options;
    };
    if options.iter().any(|option| option.value == current) {
        return options;
    }
    options.insert(
        0,
        ChoiceOption {
            value: current.clone(),
            label: current,
            hint: Some("当前会话".into()),
            suffix: None,
            disabled: false,
        },
    );
    options
}

fn read_claude_model_env(home: &Path) -> HashMap<String, String> {
    let path = home.join("settings.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(settings) = serde_json::from_str::<ClaudeSettings>(&text) else {
        return HashMap::new();
    };

    let allowed = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ];
    settings
        .env
        .into_iter()
        .filter(|(key, _)| allowed.contains(&key.as_str()))
        .collect()
}

fn clean_model_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(120).collect())
    }
}

async fn read_stdout(
    stdout: tokio::process::ChildStdout,
    stream: &mut ClaudePromptStream,
) -> Result<(), AgentError> {
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                stream.handle_line(line);
            }
            Err(err) => {
                return Err(AgentError::new(
                    AgentErrorCode::AgentCrashed,
                    format!("Claude stdout read error: {err}"),
                ));
            }
        }
    }
    Ok(())
}

struct ClaudePromptStream {
    event_tx: mpsc::UnboundedSender<HostEvent>,
    session_id: Option<String>,
    stop_reason: Option<String>,
    result_error: Option<AgentError>,
    suppress_assistant_text: bool,
    emitted_text_by_message: HashMap<String, String>,
    emitted_any_text: bool,
}

impl ClaudePromptStream {
    fn new(event_tx: mpsc::UnboundedSender<HostEvent>) -> Self {
        Self {
            event_tx,
            session_id: None,
            stop_reason: None,
            result_error: None,
            suppress_assistant_text: false,
            emitted_text_by_message: HashMap::new(),
            emitted_any_text: false,
        }
    }

    fn handle_line(&mut self, line: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            tracing::debug!(target: "claude.stdout", "{line}");
            return;
        };

        if let Some(session_id) = frame.get("session_id").and_then(|v| v.as_str()) {
            if !session_id.trim().is_empty() {
                self.session_id = Some(session_id.to_string());
            }
        }

        match frame.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "assistant" => self.handle_assistant(&frame),
            "result" => self.handle_result(&frame),
            "user" => self.handle_user(&frame),
            "system" => {}
            "tool_use" => self.emit_tool_from_value(&frame, "running"),
            "tool_result" => self.emit_tool_result_from_value(&frame),
            _ => {
                if let Some(text) = frame
                    .pointer("/delta/text")
                    .and_then(|v| v.as_str())
                    .or_else(|| frame.get("text").and_then(|v| v.as_str()))
                {
                    self.emit_assistant_text(text);
                }
            }
        }
    }

    fn handle_assistant(&mut self, frame: &Value) {
        let message = frame.get("message").unwrap_or(frame);
        let message_id = message
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("assistant")
            .to_string();

        if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
            let mut text = String::new();
            for block in content {
                match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "text" => {
                        if let Some(part) = block.get("text").and_then(|v| v.as_str()) {
                            text.push_str(part);
                        }
                    }
                    "thinking" => {
                        if let Some(part) = block.get("thinking").and_then(|v| v.as_str()) {
                            let _ = self.event_tx.send(HostEvent::Stream {
                                kind: StreamKind::Thought,
                                text: part.to_string(),
                                done: false,
                            });
                        }
                    }
                    "tool_use" => self.emit_tool_from_value(block, "running"),
                    _ => {}
                }
            }

            if !text.is_empty() {
                self.emit_message_text_delta(&message_id, &text);
            }
        }

        if let Some(stop_reason) = message.get("stop_reason").and_then(|v| v.as_str()) {
            if !stop_reason.is_empty() {
                self.stop_reason = Some(stop_reason.to_string());
            }
        }
    }

    fn handle_user(&mut self, frame: &Value) {
        let message = frame.get("message").unwrap_or(frame);
        if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
            for block in content {
                if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                    self.emit_tool_result_from_value(block);
                }
            }
        }
    }

    fn handle_result(&mut self, frame: &Value) {
        if let Some(session_id) = frame.get("session_id").and_then(|v| v.as_str()) {
            if !session_id.trim().is_empty() {
                self.session_id = Some(session_id.to_string());
            }
        }
        if let Some(subtype) = frame.get("subtype").and_then(|v| v.as_str()) {
            self.stop_reason = Some(subtype.to_string());
        }

        let is_error = frame
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || frame.get("subtype").and_then(|v| v.as_str()) == Some("error");
        let result = frame.get("result").and_then(|v| v.as_str()).unwrap_or("");
        if self.result_error.is_none() {
            if let Some(error) = claude_permission_denial_error(frame) {
                self.result_error = Some(error);
                self.suppress_assistant_text = true;
            }
        }

        if is_error {
            self.result_error = Some(classify_claude_error(result, None));
            return;
        }
        if !result.is_empty() && !self.emitted_any_text {
            self.emit_assistant_text(result);
        }
    }

    fn emit_message_text_delta(&mut self, message_id: &str, text: &str) {
        let prev = self
            .emitted_text_by_message
            .entry(message_id.to_string())
            .or_default();
        let delta = if text.starts_with(prev.as_str()) {
            text[prev.len()..].to_string()
        } else {
            text.to_string()
        };
        *prev = text.to_string();
        self.emit_assistant_text(&delta);
    }

    fn emit_assistant_text(&mut self, text: &str) {
        if self.suppress_assistant_text {
            return;
        }
        if text.is_empty() {
            return;
        }
        self.emitted_any_text = true;
        let _ = self.event_tx.send(HostEvent::Stream {
            kind: StreamKind::Assistant,
            text: text.to_string(),
            done: false,
        });
    }

    fn emit_tool_from_value(&self, value: &Value, status: &str) {
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("tool_use_id").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("tool_name").and_then(|v| v.as_str()))
            .unwrap_or("tool")
            .to_string();
        let title = match value.get("input") {
            Some(input) if !input.is_null() => format!("{name} {}", compact_json(input)),
            _ => name.clone(),
        };
        let _ = self.event_tx.send(HostEvent::ToolCall {
            id,
            name,
            status: status.to_string(),
            title,
        });
    }

    fn emit_tool_result_from_value(&mut self, value: &Value) {
        let is_error = value
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_error {
            if let Some(error) = claude_tool_permission_error(value) {
                if self.result_error.is_none() {
                    self.result_error = Some(error);
                }
                self.suppress_assistant_text = true;
            }
        }
        let id = value
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("id").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("tool")
            .to_string();
        let _ = self.event_tx.send(HostEvent::ToolCall {
            id,
            title: if is_error {
                format!("{name} failed")
            } else {
                name.clone()
            },
            name,
            status: if is_error { "failed" } else { "completed" }.into(),
        });
    }
}

fn compact_json(value: &Value) -> String {
    let text = value.to_string();
    const MAX_LEN: usize = 160;
    if text.len() <= MAX_LEN {
        text
    } else {
        format!("{}...", &text[..MAX_LEN])
    }
}

fn claude_tool_permission_error(value: &Value) -> Option<AgentError> {
    let text = tool_result_text(value);
    if !looks_like_claude_permission_denial(&text) {
        return None;
    }
    Some(AgentError::new(
        AgentErrorCode::CapabilityMissing,
        format!(
            "Claude Code 工具权限未授予，工具未执行: {}",
            text.chars().take(220).collect::<String>()
        ),
    ))
}

fn claude_permission_denial_error(value: &Value) -> Option<AgentError> {
    let denials = value.get("permission_denials").and_then(|v| v.as_array())?;
    if denials.is_empty() {
        return None;
    }
    let text = denials
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| item.to_string())
        })
        .collect::<Vec<_>>()
        .join("; ");
    Some(AgentError::new(
        AgentErrorCode::CapabilityMissing,
        format!(
            "Claude Code 工具权限未授予，工具未执行: {}",
            text.chars().take(220).collect::<String>()
        ),
    ))
}

fn tool_result_text(value: &Value) -> String {
    match value.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .or_else(|| {
                        item.get("text")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                    })
                    .or_else(|| {
                        item.get("content")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                    })
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => value
            .get("toolUseResult")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

fn looks_like_claude_permission_denial(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("requested permissions")
        || lower.contains("haven't granted")
        || lower.contains("permission denied")
        || lower.contains("permissions to write")
        || lower.contains("not granted")
}

fn classify_claude_error(message: &str, code: Option<i32>) -> AgentError {
    let trimmed = message.trim();
    let lower = trimmed.to_ascii_lowercase();
    let message = if trimmed.is_empty() {
        match code {
            Some(code) => format!("Claude Code exited with status {code}"),
            None => "Claude Code failed".into(),
        }
    } else {
        trimmed.to_string()
    };

    let code = if lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("api key")
    {
        AgentErrorCode::AuthFailed
    } else if lower.contains("rate")
        || lower.contains("quota")
        || lower.contains("usage limit")
        || lower.contains("budget")
    {
        AgentErrorCode::QuotaExceeded
    } else if lower.contains("network")
        || lower.contains("timeout")
        || lower.contains("connection")
        || lower.contains("overloaded")
        || lower.contains("503")
        || lower.contains("502")
        || lower.contains("504")
    {
        AgentErrorCode::NetworkProvider
    } else {
        AgentErrorCode::AgentCrashed
    };

    AgentError::new(code, message)
}

fn resolve_claude_cli(manifest: &RuntimeManifest) -> Option<PathBuf> {
    manifest.resolve_cli_path().map(normalize_windows_shim)
}

fn normalize_windows_shim(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"))
        {
            let cmd = path.with_extension("cmd");
            if cmd.is_file() {
                return cmd;
            }
        }
    }
    path
}

async fn read_version(path: &Path, args: &[String]) -> Option<String> {
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

fn push_tail(tail: &ParkingMutex<Vec<String>>, line: &str) {
    let mut tail = tail.lock();
    tail.push(line.to_string());
    if tail.len() > 40 {
        tail.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_permission_modes_match_cli_values() {
        assert_eq!(claude_permission_mode(PermissionMode::Ask), "default");
        assert_eq!(claude_permission_mode(PermissionMode::Auto), "auto");
        assert_eq!(claude_permission_mode(PermissionMode::ReadOnly), "plan");
        assert_eq!(
            claude_permission_mode(PermissionMode::FullAccess),
            "bypassPermissions"
        );
    }

    #[test]
    fn message_delta_handles_cumulative_partial_text() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut stream = ClaudePromptStream::new(tx);

        stream.handle_line(
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hel"}]}}"#,
        );
        stream.handle_line(
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello"}]}}"#,
        );

        let first = rx.try_recv().unwrap();
        let second = rx.try_recv().unwrap();
        match first {
            HostEvent::Stream { text, .. } => assert_eq!(text, "hel"),
            _ => panic!("expected first stream event"),
        }
        match second {
            HostEvent::Stream { text, .. } => assert_eq!(text, "lo"),
            _ => panic!("expected second stream event"),
        }
    }

    #[test]
    fn alias_model_options_display_configured_models() {
        let mut options = Vec::new();
        push_alias_model(
            &mut options,
            "opus",
            Some(&"deepseek-v4-pro[1m]".to_string()),
            "opus alias",
        );

        assert_eq!(options.len(), 1);
        assert_eq!(options[0].value, "opus");
        assert_eq!(options[0].label, "deepseek-v4-pro[1m]");
        assert_eq!(options[0].hint.as_deref(), Some("Claude Code opus alias"));
    }

    #[test]
    fn permission_denial_suppresses_later_success_text() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut stream = ClaudePromptStream::new(tx);

        stream.handle_line(
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"call_1","name":"Write","input":{"file_path":"X:\\1_2026_project\\order\\3.txt","content":"123"}}]}}"#,
        );
        stream.handle_line(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"Claude requested permissions to write to X:\\1_2026_project\\order\\3.txt, but you haven't granted it yet.","is_error":true,"tool_use_id":"call_1"}]}}"#,
        );
        stream.handle_line(
            r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"文件已创建。"}]}}"#,
        );

        assert_eq!(
            stream.result_error.as_ref().map(|error| error.code),
            Some(AgentErrorCode::CapabilityMissing)
        );

        let mut assistant_text = String::new();
        while let Ok(event) = rx.try_recv() {
            if let HostEvent::Stream {
                kind: StreamKind::Assistant,
                text,
                ..
            } = event
            {
                assistant_text.push_str(&text);
            }
        }
        assert!(assistant_text.is_empty());
    }

    #[tokio::test]
    async fn permission_bridge_round_trips_allow_decision() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let broker = PermissionBroker::new("claude-test", PermissionMode::Ask, tx);
        let bridge = ClaudePermissionBridge::start(broker.clone(), None)
            .await
            .unwrap();
        let request_body = json!({
            "tool_name": "Write",
            "input": {
                "file_path": "X:\\tmp\\probe.txt",
                "content": "hello"
            }
        })
        .to_string();
        let request = format!(
            "POST /permission HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            bridge.token(),
            request_body.len(),
            request_body
        );
        let url = bridge.url().to_string();

        let client = tokio::spawn(async move {
            let address = url
                .strip_prefix("http://")
                .unwrap()
                .strip_suffix("/permission")
                .unwrap()
                .to_string();
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            response
        });

        let HostEvent::PermissionRequest {
            request_id,
            tool_name,
            title,
            preview,
            auto_allowed,
            policy: _,
        } = rx.recv().await.unwrap()
        else {
            panic!("expected permission request");
        };
        assert_eq!(tool_name, "claude:Write");
        assert!(title.contains("Write"));
        assert!(title.contains("probe.txt"));
        assert!(preview.contains("hello"));
        assert!(!auto_allowed);

        broker
            .resolve(&request_id, PermissionDecision::AllowOnce)
            .unwrap();
        let response = client.await.unwrap();
        assert!(response.contains("200 OK"));
        assert!(response.contains(r#""behavior":"allow""#));
        assert!(response.contains(r#""updatedInput""#));

        bridge.shutdown().await;
    }
}
