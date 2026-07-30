use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRouteStatus {
    pub route_kind: String,
    pub cc_switch_detected: bool,
    pub model_provider: Option<String>,
    pub model: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub base_url: Option<String>,
    pub wire_api: Option<String>,
    pub latest_forward_url: Option<String>,
    pub latest_forward_model: Option<String>,
    pub latest_error: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRouteStatus {
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub output_limit: Option<String>,
    pub route_kind: String,
    pub note: String,
}

pub fn codex_route_status() -> CodexRouteStatus {
    let codex_config_path = user_home().map(|home| home.join(".codex").join("config.toml"));
    let codex_config_text = codex_config_path
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok());
    let model_provider = codex_config_text
        .as_deref()
        .and_then(|text| toml_string_value(text, "model_provider"));
    let model = codex_config_text
        .as_deref()
        .and_then(|text| toml_string_value(text, "model"));
    let model_reasoning_effort = codex_config_text
        .as_deref()
        .and_then(|text| toml_string_value(text, "model_reasoning_effort"));
    let provider_section = model_provider
        .as_deref()
        .map(|provider| format!("[model_providers.{provider}]"));
    let provider_body = codex_config_text
        .as_deref()
        .zip(provider_section.as_deref())
        .and_then(|(text, section)| toml_section_body(text, section));
    let base_url = provider_body
        .as_deref()
        .and_then(|body| toml_string_value(body, "base_url"));
    let wire_api = provider_body
        .as_deref()
        .and_then(|body| toml_string_value(body, "wire_api"));

    let cc_switch_dir = user_home().map(|home| home.join(".cc-switch"));
    let cc_switch_detected = cc_switch_dir.as_ref().is_some_and(|path| path.is_dir());
    let cc_switch_log_path = cc_switch_dir
        .as_ref()
        .map(|dir| dir.join("logs").join("cc-switch.log"))
        .filter(|path| path.exists());
    let (latest_forward_url, latest_forward_model, latest_error) = cc_switch_log_path
        .as_ref()
        .map(|path| parse_cc_switch_log(path))
        .unwrap_or_default();

    let via_cc_switch = base_url
        .as_deref()
        .is_some_and(|url| url.contains("127.0.0.1:15721"))
        || cc_switch_detected && model_provider.as_deref() == Some("custom");
    let route_kind = if via_cc_switch {
        "cc-switch".to_string()
    } else if model_provider.is_some() || base_url.is_some() {
        "custom".to_string()
    } else {
        "default".to_string()
    };
    let note = if via_cc_switch {
        "Codex CLI 当前配置指向 cc-switch 本地代理；Workbench 连接的是 Codex app-server，模型出口由 Codex CLI 配置决定。"
    } else {
        "Codex CLI 未检测到 cc-switch 本地代理；Workbench 连接的是 Codex app-server，模型出口由 Codex CLI 配置决定。"
    }
    .to_string();

    CodexRouteStatus {
        route_kind,
        cc_switch_detected,
        model_provider,
        model,
        model_reasoning_effort,
        base_url,
        wire_api,
        latest_forward_url,
        latest_forward_model,
        latest_error,
        note,
    }
}

pub fn claude_route_status() -> ClaudeRouteStatus {
    let config_path = user_home().map(|home| home.join(".claude").join("settings.json"));
    let config_text = config_path
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok());
    let env = config_text
        .as_deref()
        .and_then(claude_settings_env)
        .unwrap_or_default();
    let base_url = env.get("ANTHROPIC_BASE_URL").cloned();
    let model = env.get("ANTHROPIC_MODEL").cloned();
    let output_limit = env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS").cloned();

    let route_kind = match base_url.as_deref() {
        Some(url) if is_local_proxy_url(url) => "cc-switch/local-proxy",
        Some(url) if url.contains("deepseek.com/anthropic") => "direct-deepseek",
        Some(_) => "custom",
        None => "default",
    }
    .to_string();

    let note = match route_kind.as_str() {
        "cc-switch/local-proxy" => "Claude Code 当前配置指向本地代理；Workbench 连接的是 Claude CLI，模型出口由本机 settings.json 里的 ANTHROPIC_BASE_URL 决定。",
        "direct-deepseek" => "Claude Code 当前配置直连 DeepSeek 的 Anthropic 兼容入口；Workbench 连接的是 Claude CLI，模型出口由本机 settings.json 决定。",
        "custom" => "Claude Code 使用自定义 ANTHROPIC_BASE_URL；Workbench 连接的是 Claude CLI，模型出口由本机 settings.json 决定。",
        _ => "Claude Code 当前未检测到自定义出口配置；Workbench 连接的是 Claude CLI，模型出口走默认配置。",
    }
    .to_string();

    ClaudeRouteStatus {
        base_url,
        model,
        output_limit,
        route_kind,
        note,
    }
}

pub fn codex_config_context() -> Option<String> {
    let status = codex_route_status();
    let mut parts = Vec::new();
    if let Some(v) = status.model_provider {
        parts.push(format!("provider={v}"));
    }
    if let Some(v) = status.model {
        parts.push(format!("model={v}"));
    }
    if let Some(v) = status.model_reasoning_effort {
        parts.push(format!("model_reasoning_effort={v}"));
    }
    if let Some(v) = status.base_url {
        parts.push(format!("base_url={v}"));
    }
    if let Some(v) = status.wire_api {
        parts.push(format!("wire_api={v}"));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

pub fn open_cc_switch() -> Result<String, String> {
    let candidates = [
        user_home()
            .unwrap_or_else(|| PathBuf::from(""))
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("cc-switch")
            .join("cc-switch.exe"),
        PathBuf::from(r"C:\Program Files\cc-switch\cc-switch.exe"),
    ];

    let Some(path) = candidates.into_iter().find(|path| path.is_file()) else {
        return Err("找不到 cc-switch 可执行文件，请从系统托盘或开始菜单打开 cc-switch。".into());
    };

    Command::new(&path)
        .spawn()
        .map_err(|e| format!("打开 cc-switch 失败: {e}"))?;
    Ok(format!("已打开 {}", display_path(&path)))
}

fn user_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

fn parse_cc_switch_log(path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(text) = fs::read_to_string(path) else {
        return (None, None, None);
    };
    let mut latest_forward_url = None;
    let mut latest_forward_model = None;
    let mut latest_error = None;
    let mut recovered_after_latest_error = false;

    for line in text.lines().rev().take(400) {
        let redacted = redact_secret_line(line);
        if latest_error.is_none() && looks_like_recovery(&redacted) {
            recovered_after_latest_error = true;
        }
        if latest_error.is_none() && !recovered_after_latest_error && looks_like_error(&redacted) {
            latest_error = Some(redacted.clone());
        }
        if latest_forward_url.is_none() && redacted.contains("[Codex] >>> 请求 URL:") {
            latest_forward_url = between(&redacted, "请求 URL: ", " ")
                .or_else(|| redacted.split("请求 URL: ").nth(1).map(|s| s.to_string()));
            latest_forward_model = between(&redacted, "(model=", ")").or_else(|| {
                redacted
                    .split("(model=")
                    .nth(1)
                    .map(|s| s.trim_end_matches(')').to_string())
            });
        }
        if latest_forward_url.is_some() && latest_error.is_some() {
            break;
        }
    }

    (latest_forward_url, latest_forward_model, latest_error)
}

fn looks_like_recovery(line: &str) -> bool {
    line.contains("恢复正常") || line.contains("HalfOpen → Closed")
}

fn looks_like_error(line: &str) -> bool {
    line.contains("[ERROR]")
        || line.contains("[WARN]")
        || line.contains(" 502 ")
        || line.contains(" 503 ")
        || line.contains(" 504 ")
        || line.contains("Bad Gateway")
        || line.contains("上游错误")
        || line.contains("转发失败")
        || line.contains("请求超时")
}

fn redact_secret_line(line: &str) -> String {
    let lower = line.to_lowercase();
    if lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("authorization")
        || lower.contains("bearer")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("cookie")
        || lower.contains("password")
        || line.contains("sk-")
    {
        "[REDACTED_SECRET_LINE]".to_string()
    } else {
        line.to_string()
    }
}

fn between(text: &str, start: &str, end: &str) -> Option<String> {
    let rest = text.split(start).nth(1)?;
    Some(rest.split(end).next()?.to_string())
}

fn toml_section_body(text: &str, section: &str) -> Option<String> {
    let mut in_section = false;
    let mut body = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_section {
                break;
            }
            in_section = trimmed == section;
            continue;
        }
        if in_section {
            body.push(line);
        }
    }
    in_section.then(|| body.join("\n"))
}

fn toml_string_value(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key} = ");
    text.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix(&prefix)?.trim();
        value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .map(|v| v.to_string())
    })
}

fn claude_settings_env(text: &str) -> Option<std::collections::HashMap<String, String>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let env = value.get("env")?.as_object()?;
    let allowed = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ];
    let mut map = std::collections::HashMap::new();
    for (key, value) in env {
        if !allowed.contains(&key.as_str()) {
            continue;
        }
        if let Some(text) = value.as_str() {
            map.insert(key.clone(), text.to_string());
        }
    }
    Some(map)
}

fn is_local_proxy_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("127.0.0.1") || lower.contains("localhost") || lower.contains("cc-switch")
}

fn display_path(path: &PathBuf) -> String {
    path.display().to_string()
}
