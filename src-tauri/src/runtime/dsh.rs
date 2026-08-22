//! DeepSeek Harness adapter — `dsh --profile headless "task"`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex as ParkingMutex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::error::{AgentError, AgentErrorCode};
use crate::host::events::{HostEvent, StreamKind};
use crate::paths;
use crate::process_util;
use crate::runtime::manifest::RuntimeManifest;
use crate::runtime::traits::{
    AgentRuntime, ConnectOpts, LiveSession, PermissionMode, ProbeResult, PromptInput,
    SessionSettings, SessionSettingsPatch,
};

const PROMPT_TIMEOUT_SECS: u64 = 60 * 30;
const DSH_VISION_MODEL: &str = "deepseek-v4-flash-vision-exp";
const DSH_BRIDGE_RUNNER: &str = "workbench_dsh_headless_runner.mjs";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DshPromptFile {
    text: String,
    images: Vec<DshPromptImageFile>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DshPromptImageFile {
    path: String,
    media_type: String,
    name: Option<String>,
}

pub struct DshRuntime {
    manifest: &'static RuntimeManifest,
}

impl DshRuntime {
    pub fn new(manifest: &'static RuntimeManifest) -> Self {
        Self { manifest }
    }
}

#[async_trait]
impl AgentRuntime for DshRuntime {
    fn manifest(&self) -> &'static RuntimeManifest {
        self.manifest
    }

    async fn probe(&self) -> ProbeResult {
        match self.manifest.resolve_cli_path() {
            Some(path) => {
                let version = read_version(&path, &self.manifest.version_args).await;
                ProbeResult {
                    runtime_id: self.id(),
                    found: true,
                    path: Some(path.display().to_string()),
                    version,
                    detail: Some("spawn: dsh --profile headless \"task\"".into()),
                }
            }
            None => ProbeResult {
                runtime_id: self.id(),
                found: false,
                path: None,
                version: None,
                detail: Some(format!(
                    "`{}` not found on PATH or known locations. Install @deepseek-ai/dsh first; Workbench will not run npx automatically.",
                    self.manifest.command
                )),
            },
        }
    }

    fn normalize_settings(
        &self,
        current: &SessionSettings,
        patch: &SessionSettingsPatch,
    ) -> Result<SessionSettings, String> {
        let mut next = current.clone();

        if let Some(model_id) = patch.model_id.as_deref() {
            let model_id = model_id.trim();
            if model_id.is_empty() {
                return Err("model id cannot be empty".into());
            }
            next.model_id = Some(model_id.to_string());
        }

        if let Some(effort) = patch.model_reasoning_effort.as_deref() {
            let effort = effort.trim();
            if effort.is_empty() {
                return Err("model reasoning effort cannot be empty".into());
            }
            if !is_supported_reasoning_effort(effort) {
                return Err(format!(
                    "DeepSeek Harness does not support reasoning effort `{effort}`"
                ));
            }
            next.model_reasoning_effort = Some(effort.to_string());
        }

        if let Some(mode) = patch.permission_mode {
            if !is_supported_permission_mode(mode) {
                return Err(format!(
                    "DeepSeek Harness does not support permission mode `{}`",
                    mode.as_str()
                ));
            }
            next.permission_mode = Some(mode);
        }

        if let Some(effort) = next.model_reasoning_effort.as_deref() {
            if !is_supported_reasoning_effort(effort) {
                return Err(format!(
                    "DeepSeek Harness does not support reasoning effort `{effort}`"
                ));
            }
        }

        if next.model_reasoning_effort.is_none() {
            next.model_reasoning_effort = Some(DEFAULT_REASONING_EFFORT.into());
        }

        Ok(next)
    }

    fn default_settings(&self) -> SessionSettings {
        SessionSettings {
            model_id: self.manifest.models.first().map(|m| m.value.clone()),
            model_reasoning_effort: Some(DEFAULT_REASONING_EFFORT.into()),
            permission_mode: Some(self.manifest.default_permission_mode()),
        }
    }

    async fn connect(
        &self,
        opts: ConnectOpts,
        event_tx: mpsc::UnboundedSender<HostEvent>,
    ) -> Result<Box<dyn LiveSession>, AgentError> {
        let cli_path = opts
            .cli_path
            .or_else(|| self.manifest.resolve_cli_path())
            .ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::CliNotFound,
                    "DeepSeek Harness CLI not found (expected `dsh`)",
                )
            })?;

        if !opts.cwd.is_dir() {
            return Err(AgentError::new(
                AgentErrorCode::ConnectFailed,
                format!("cwd is not a directory: {}", opts.cwd.display()),
            ));
        }

        Ok(Box::new(DshLiveSession {
            cli_path,
            cwd: opts.cwd,
            model_id: opts.model_id,
            model_reasoning_effort: opts.model_reasoning_effort,
            permission_mode: opts.permission_mode,
            home_env: self.manifest.home_env.clone(),
            home: self.manifest.resolve_home(),
            event_tx,
            prompt_lock: AsyncMutex::new(()),
            current_child: AsyncMutex::new(None),
            cancelled: AtomicBool::new(false),
        }))
    }
}

struct DshLiveSession {
    cli_path: PathBuf,
    cwd: PathBuf,
    model_id: Option<String>,
    model_reasoning_effort: Option<String>,
    permission_mode: PermissionMode,
    home_env: Option<String>,
    home: PathBuf,
    event_tx: mpsc::UnboundedSender<HostEvent>,
    prompt_lock: AsyncMutex<()>,
    current_child: AsyncMutex<Option<Child>>,
    cancelled: AtomicBool,
}

#[async_trait]
impl LiveSession for DshLiveSession {
    fn backend(&self) -> &str {
        "dsh_headless"
    }

    fn native_home(&self) -> Option<String> {
        Some(self.home.display().to_string())
    }

    async fn prompt(&self, input: PromptInput) -> Result<(), AgentError> {
        let _guard = self.prompt_lock.lock().await;
        self.cancelled.store(false, Ordering::SeqCst);

        let prompt_input_path = if input.images.is_empty() {
            None
        } else {
            let model = normalize_optional_setting(self.model_id.as_deref()).unwrap_or_default();
            if model != DSH_VISION_MODEL {
                return Err(AgentError::new(
                    AgentErrorCode::CapabilityMissing,
                    format!(
                        "DeepSeek Harness image input requires model `{DSH_VISION_MODEL}`"
                    ),
                ));
            }
            Some(write_prompt_input(&input)?)
        };

        let run_id = uuid::Uuid::new_v4().to_string();
        let _ = self.event_tx.send(HostEvent::ToolCall {
            id: run_id.clone(),
            name: "dsh_headless".into(),
            status: "running".into(),
            title: "DeepSeek Harness headless".into(),
        });

        let mut child = match spawn_dsh_headless(
            &self.cli_path,
            &self.cwd,
            self.home_env.as_deref(),
            &self.home,
            self.model_id.as_deref(),
            self.model_reasoning_effort.as_deref(),
            self.permission_mode,
            &input.text,
            prompt_input_path.as_deref(),
        ) {
            Ok(child) => child,
            Err(error) => {
                self.emit_failed_tool(&run_id, "DeepSeek Harness headless failed");
                return Err(error);
            }
        };

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                self.emit_failed_tool(&run_id, "DeepSeek Harness headless failed");
                return Err(AgentError::new(
                    AgentErrorCode::AgentCrashed,
                    "DSH stdout missing",
                ));
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                self.emit_failed_tool(&run_id, "DeepSeek Harness headless failed");
                return Err(AgentError::new(
                    AgentErrorCode::AgentCrashed,
                    "DSH stderr missing",
                ));
            }
        };

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
                                tracing::debug!(target: "dsh.stderr", "{line}");
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
        };

        let output_result = tokio::time::timeout(
            std::time::Duration::from_secs(PROMPT_TIMEOUT_SECS),
            stream_stdout(stdout, self.event_tx.clone()),
        )
        .await;

        if output_result.is_err() {
            let _ = self.cancel().await;
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

        if self.cancelled.load(Ordering::SeqCst) {
            let _ = self.event_tx.send(HostEvent::ToolCall {
                id: run_id,
                name: "dsh_headless".into(),
                status: "failed".into(),
                title: "DeepSeek Harness headless cancelled".into(),
            });
            return Err(AgentError::new(
                AgentErrorCode::AgentCrashed,
                "DeepSeek Harness prompt cancelled",
            ));
        }

        match output_result {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                self.emit_failed_tool(&run_id, "DeepSeek Harness headless failed");
                return Err(error);
            }
            Err(_) => {
                self.emit_failed_tool(&run_id, "DeepSeek Harness headless timed out");
                return Err(AgentError::new(
                    AgentErrorCode::NetworkProvider,
                    format!("DeepSeek Harness timed out after {PROMPT_TIMEOUT_SECS} seconds"),
                ));
            }
        }

        match status {
            Some(status) if status.success() => {
                let _ = self.event_tx.send(HostEvent::ToolCall {
                    id: run_id,
                    name: "dsh_headless".into(),
                    status: "completed".into(),
                    title: "DeepSeek Harness headless".into(),
                });
                let _ = self.event_tx.send(HostEvent::PromptComplete {
                    stop_reason: "completed".into(),
                });
                Ok(())
            }
            Some(status) => {
                let code = status.code();
                let stderr = stderr_tail.lock().join("\n");
                self.emit_failed_tool(&run_id, "DeepSeek Harness headless failed");
                Err(classify_dsh_error(&stderr, code))
            }
            None => {
                self.emit_failed_tool(&run_id, "DeepSeek Harness headless failed");
                Err(AgentError::new(
                    AgentErrorCode::AgentCrashed,
                    "DeepSeek Harness process exited without a status",
                ))
            }
        }
    }

    async fn cancel(&self) -> Result<(), AgentError> {
        self.cancelled.store(true, Ordering::SeqCst);
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

impl DshLiveSession {
    fn emit_failed_tool(&self, run_id: &str, title: &str) {
        let _ = self.event_tx.send(HostEvent::ToolCall {
            id: run_id.to_string(),
            name: "dsh_headless".into(),
            status: "failed".into(),
            title: title.into(),
        });
    }
}

fn spawn_dsh_headless(
    cli_path: &Path,
    cwd: &Path,
    home_env: Option<&str>,
    home: &Path,
    model_id: Option<&str>,
    model_reasoning_effort: Option<&str>,
    permission_mode: PermissionMode,
    prompt: &str,
    prompt_input_path: Option<&Path>,
) -> Result<Child, AgentError> {
    let mut cmd = Command::new(cli_path);
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(["--profile", "headless"]);
    if let Some(patch) = write_settings_patch(
        cwd,
        model_id,
        model_reasoning_effort,
        permission_mode,
        prompt_input_path,
    )?
    {
        cmd.arg("--patch").arg(patch);
    }
    cmd.arg(if prompt_input_path.is_some() {
        "workbench multimodal input"
    } else {
        prompt
    });
    if let Some(home_env) = home_env {
        cmd.env(home_env, home);
    }
    process_util::apply_no_window_tokio(&mut cmd);
    if let Some(path) = process_util::enriched_path_env() {
        cmd.env("PATH", path);
    }
    cmd.spawn().map_err(|err| {
        AgentError::new(
            AgentErrorCode::CliNotFound,
            format!("failed to spawn DeepSeek Harness: {err}"),
        )
    })
}

const DEFAULT_REASONING_EFFORT: &str = "high";
const SUPPORTED_REASONING_EFFORTS: [&str; 4] = ["off", "low", "high", "max"];

fn is_supported_reasoning_effort(effort: &str) -> bool {
    SUPPORTED_REASONING_EFFORTS.contains(&effort.trim())
}

fn is_supported_permission_mode(mode: PermissionMode) -> bool {
    matches!(
        mode,
        PermissionMode::Ask | PermissionMode::ReadOnly | PermissionMode::FullAccess
    )
}

fn dsh_permission_config(mode: PermissionMode) -> Result<(&'static str, &'static str), AgentError> {
    match mode {
        PermissionMode::Ask => Ok(("workspace-write", "ask")),
        PermissionMode::ReadOnly => Ok(("read-only", "ask")),
        PermissionMode::FullAccess => Ok(("danger-full-access", "never")),
        PermissionMode::Auto => Err(AgentError::new(
            AgentErrorCode::CapabilityMissing,
            "DeepSeek Harness `approval: never` rejects approval requests; it is not Workbench auto-approve",
        )),
    }
}

fn normalize_optional_setting(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("default") {
        None
    } else {
        Some(value.to_string())
    }
}

fn write_settings_patch(
    cwd: &Path,
    model_id: Option<&str>,
    model_reasoning_effort: Option<&str>,
    permission_mode: PermissionMode,
    prompt_input_path: Option<&Path>,
) -> Result<Option<PathBuf>, AgentError> {
    let model_id = normalize_optional_setting(model_id);
    let model_reasoning_effort = normalize_optional_setting(model_reasoning_effort)
        .or_else(|| Some(DEFAULT_REASONING_EFFORT.into()));
    let (sandbox_mode, approval_policy) = dsh_permission_config(permission_mode)?;

    let dir = paths::data_dir().join("dsh-patches");
    std::fs::create_dir_all(&dir).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to create DeepSeek Harness patch dir: {err}"),
        )
    })?;
    let patch_id = uuid::Uuid::new_v4();
    let settings_path = dir.join(format!("{patch_id}.settings.json"));
    let patch_path = dir.join(format!("{patch_id}.cordis.patch.yml"));

    let mut settings = serde_json::Map::new();
    let mut patch = String::new();
    patch.push_str("- id: settings\n");
    patch.push_str("  config:\n");
    patch.push_str("    path: ");
    patch.push_str(&json_string(&settings_path.display().to_string())?);
    patch.push('\n');
    patch.push_str("- id: sandbox-policy\n");
    patch.push_str("  config:\n");
    patch.push_str("    mode: ");
    patch.push_str(&json_string(sandbox_mode)?);
    patch.push('\n');
    patch.push_str("    workspaceRoot: ");
    patch.push_str(&json_string(&cwd.display().to_string())?);
    patch.push('\n');
    patch.push_str("- id: approval\n");
    patch.push_str("  config:\n");
    patch.push_str("    policy: ");
    patch.push_str(&json_string(approval_policy)?);
    patch.push('\n');

    if let Some(model_id) = model_id.as_deref() {
        let mut default_model = serde_json::Map::new();
        default_model.insert("provider".into(), serde_json::json!("deepseek-official"));
        default_model.insert("model".into(), serde_json::json!(model_id));
        if let Some(effort) = model_reasoning_effort.as_deref() {
            default_model.insert("reasoningEffort".into(), serde_json::json!(effort));
        }
        settings.insert(
            "agent-default-model".into(),
            serde_json::Value::Object(default_model),
        );

        patch.push_str("- id: agent-default-model\n");
        patch.push_str("  config:\n");
        patch.push_str("    provider: deepseek-official\n");
        patch.push_str("    model: ");
        patch.push_str(&json_string(model_id)?);
        patch.push('\n');
    }
    if let Some(effort) = model_reasoning_effort.as_deref() {
        if !is_supported_reasoning_effort(&effort) {
            return Err(AgentError::new(
                AgentErrorCode::CapabilityMissing,
                format!("DeepSeek Harness reasoning effort `{effort}` is not supported"),
            ));
        }
        let mut deepseek_settings = serde_json::Map::new();
        deepseek_settings.insert("reasoningEffort".into(), serde_json::json!(effort));
        settings.insert(
            "llm-deepseek".into(),
            serde_json::Value::Object(deepseek_settings),
        );

        patch.push_str("- id: llm-deepseek\n");
        patch.push_str("  config:\n");
        patch.push_str("    thinking: enabled\n");
        patch.push_str("    reasoningEffort: ");
        patch.push_str(&json_string(effort)?);
        patch.push('\n');
    }
    if let Some(prompt_input_path) = prompt_input_path {
        let runner_path = ensure_workbench_runner()?;
        patch.push_str("- id: headless-runner\n");
        patch.push_str("  disabled: true\n");
        patch.push_str("- insert:\n");
        patch.push_str("    - id: workbench-headless-runner\n");
        patch.push_str("      name: ");
        patch.push_str(&json_string(&file_url(&runner_path))?);
        patch.push('\n');
        patch.push_str("      config:\n");
        patch.push_str("        inputPath: ");
        patch.push_str(&json_string(&prompt_input_path.display().to_string())?);
        patch.push('\n');
    }

    let settings_text = serde_json::to_string_pretty(&serde_json::Value::Object(settings))
        .map_err(|err| {
            AgentError::new(
                AgentErrorCode::ConnectFailed,
                format!("failed to serialize DeepSeek Harness settings: {err}"),
            )
        })?;
    std::fs::write(&settings_path, settings_text).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to write DeepSeek Harness settings: {err}"),
        )
    })?;
    std::fs::write(&patch_path, patch).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to write DeepSeek Harness patch: {err}"),
        )
    })?;
    Ok(Some(patch_path))
}

fn write_prompt_input(input: &PromptInput) -> Result<PathBuf, AgentError> {
    let dir = paths::data_dir().join("dsh-patches");
    std::fs::create_dir_all(&dir).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to create DeepSeek Harness prompt input dir: {err}"),
        )
    })?;
    let input_path = dir.join(format!("{}.prompt.json", uuid::Uuid::new_v4()));
    let images = input
        .images
        .iter()
        .map(|image| {
            let path = std::fs::canonicalize(&image.path).map_err(|err| {
                AgentError::new(
                    AgentErrorCode::ConnectFailed,
                    format!("failed to resolve image attachment {}: {err}", image.path.display()),
                )
            })?;
            if !path.is_file() {
                return Err(AgentError::new(
                    AgentErrorCode::ConnectFailed,
                    format!("image attachment is not a file: {}", path.display()),
                ));
            }
            let media_type = image_mime_type_from_path(&path).ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::CapabilityMissing,
                    format!("unsupported image attachment type: {}", path.display()),
                )
            })?;
            Ok(DshPromptImageFile {
                path: path.display().to_string(),
                media_type: media_type.into(),
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.to_string()),
            })
        })
        .collect::<Result<Vec<_>, AgentError>>()?;
    let payload = DshPromptFile {
        text: input.text.clone(),
        images,
    };
    let text = serde_json::to_string_pretty(&payload).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to serialize DeepSeek Harness prompt input: {err}"),
        )
    })?;
    std::fs::write(&input_path, text).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to write DeepSeek Harness prompt input: {err}"),
        )
    })?;
    Ok(input_path)
}

fn ensure_workbench_runner() -> Result<PathBuf, AgentError> {
    let dir = paths::data_dir().join("dsh-bridge");
    std::fs::create_dir_all(&dir).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to create DeepSeek Harness bridge dir: {err}"),
        )
    })?;
    let runner_path = dir.join(DSH_BRIDGE_RUNNER);
    std::fs::write(&runner_path, WORKBENCH_HEADLESS_RUNNER).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to write DeepSeek Harness bridge runner: {err}"),
        )
    })?;
    Ok(runner_path)
}

fn image_mime_type_from_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        _ => None,
    }
}

fn file_url(path: &Path) -> String {
    let mut path = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) && path.as_bytes().get(1) == Some(&b':') {
        path = format!("/{path}");
    }
    format!("file://{}", percent_encode_file_path(&path))
}

fn percent_encode_file_path(path: &str) -> String {
    let mut out = String::new();
    for byte in path.as_bytes() {
        let keep = matches!(
            *byte,
            b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'.'
                | b'_'
                | b'~'
                | b'/'
                | b':'
        );
        if keep {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", *byte));
        }
    }
    out
}

fn json_string(value: &str) -> Result<String, AgentError> {
    serde_json::to_string(value).map_err(|err| {
        AgentError::new(
            AgentErrorCode::ConnectFailed,
            format!("failed to serialize DeepSeek Harness setting: {err}"),
        )
    })
}

const WORKBENCH_HEADLESS_RUNNER: &str = r#"
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

async function importDshPackage(specifier) {
  const failures = [];
  const dshEntry = process.argv[1];
  if (dshEntry) {
    try {
      const dshRoot = new URL("../", pathToFileURL(dshEntry));
      const pkgUrl = new URL(`node_modules/${specifier}/package.json`, dshRoot);
      const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
      const entry =
        pkg.exports?.["."]?.import ??
        pkg.exports?.["."]?.default ??
        pkg.module ??
        pkg.main ??
        "lib/index.js";
      const normalizedEntry = typeof entry === "string" ? entry.replace(/^\.\//, "") : "lib/index.js";
      return await import(new URL(`node_modules/${specifier}/${normalizedEntry}`, dshRoot).href);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    return await import(specifier);
  } catch (error) {
    failures.push(error);
  }
  throw new Error(`Unable to import ${specifier}: ${failures.map((error) => error?.message ?? String(error)).join("; ")}`);
}

const [
  schemastery,
  dshAgent,
  dshLlm,
  dshSession,
] = await Promise.all([
  importDshPackage("@deepseek-ai/schemastery"),
  importDshPackage("@deepseek-ai/dsh-agent"),
  importDshPackage("@deepseek-ai/dsh-llm"),
  importDshPackage("@deepseek-ai/dsh-session"),
]);

const z = schemastery.default ?? schemastery;
const { installModelSelection } = dshAgent;
const { createUserMessage } = dshLlm;
const { SessionId } = dshSession;

export const name = "workbench-headless-runner";
export const inject = ["agentDefaultModel", "agents", "sessions", "attachments"];
export const Config = z.object({ inputPath: z.string().required() });

function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

async function readInput(inputPath) {
  const parsed = JSON.parse(await readFile(inputPath, "utf8"));
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const images = Array.isArray(parsed.images) ? parsed.images : [];
  return { text, images };
}

async function imageBlocks(attachments, images) {
  if (images.length === 0) return [];
  const refs = await attachments.saveImages(
    await Promise.all(
      images.map(async (image) => ({
        data: new Uint8Array(await readFile(image.path)),
        mediaType: image.mediaType,
        name: typeof image.name === "string" ? image.name : basename(image.path),
      })),
    ),
  );
  return refs.map((attachment) => ({ type: "image", attachment }));
}

async function run(ctx, inputPath, io) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  const attachments = ctx.get("attachments");
  if (agents === undefined || defaultModel === undefined || sessions === undefined || attachments === undefined) return;

  const input = await readInput(inputPath);
  const selection = defaultModel.currentSelection();
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, {
        current: selection,
        assembled: undefined,
      });
    },
  });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  const content = [];
  if (input.text.trim() !== "" || input.images.length === 0) {
    content.push({ type: "text", text: input.text });
  }
  content.push(...await imageBlocks(attachments, input.images));
  agent.followup(createUserMessage({
    content,
    source: { kind: "user" },
  }));
  await agent.whenIdle();
  await sessions.flush(agent.session);
  const outcome = summarize(agent.session.events, firstSeq);
  io.stdout.write(outcome.text + "\n");
  if (outcome.reason?.kind === "error") {
    const error = outcome.reason.error ?? outcome.reason.failure;
    io.stderr.write(`dsh: ${error?.code ?? "ERROR"}: ${error?.message ?? "DeepSeek Harness failed"}\n`);
  }
  io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}

export function apply(ctx, config) {
  const exit = ctx.get("appExit");
  if (exit === undefined) {
    throw new Error("workbench-headless-runner: ctx.appExit is required");
  }
  const io = {
    stdout: process.stdout,
    stderr: process.stderr,
    exit,
  };
  run(ctx, config.inputPath, io).catch((error) => fail(io, error));
}
"#;

async fn stream_stdout(
    stdout: tokio::process::ChildStdout,
    event_tx: mpsc::UnboundedSender<HostEvent>,
) -> Result<String, AgentError> {
    let mut reader = BufReader::new(stdout);
    let mut output = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).await.map_err(|err| {
            AgentError::new(
                AgentErrorCode::AgentCrashed,
                format!("DeepSeek Harness stdout read error: {err}"),
            )
        })?;
        if bytes == 0 {
            break;
        }
        output.push_str(&line);
        let _ = event_tx.send(HostEvent::Stream {
            kind: StreamKind::Assistant,
            text: line.clone(),
            done: false,
        });
    }
    let _ = event_tx.send(HostEvent::Stream {
        kind: StreamKind::Assistant,
        text: String::new(),
        done: true,
    });
    Ok(output)
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

fn classify_dsh_error(message: &str, code: Option<i32>) -> AgentError {
    let trimmed = message.trim();
    let lower = trimmed.to_ascii_lowercase();
    let message = if trimmed.is_empty() {
        match code {
            Some(code) => format!("DeepSeek Harness exited with status {code}"),
            None => "DeepSeek Harness failed".into(),
        }
    } else {
        trimmed.to_string()
    };

    let code = if lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("api key")
        || lower.contains("credential")
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
