import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";

import {
  IconClose,
  IconDoctor,
  IconFolder,
  IconPlug,
  IconRefresh,
  IconSettings,
} from "./icons";
import {
  capabilityDescriptors,
  protocolLabel,
  runtimeCapabilitySummary,
} from "../lib/capabilities";
import { UI_FONT_SIZE_OPTIONS, type UiFontSize } from "../lib/fontSize";
import {
  runtimeAvatarLabel,
  runtimeAvatarSrc,
  runtimeLabel,
  sortRuntimes,
} from "../lib/runtimes";
import type {
  AppSettings,
  CodexGatewayUsageConfig,
  DeepSeekUsageConfig,
  ProbeResult,
  RuntimeId,
  RuntimeInfo,
} from "../lib/types";

export type SettingsSection = "general" | "personal" | "usage" | "cli";

type Props = {
  activeSection: SettingsSection;
  uiFontSize: UiFontSize;
  runtimes: RuntimeInfo[];
  probes: ProbeResult[];
  appSettings: AppSettings | null;
  settingsRuntimeBusy: string | null;
  settingsUsageBusy: boolean;
  settingsPersonalCenterBusy: boolean;
  routeDiagnosticsPanel: ReactNode;
  statusLine: string;
  onSectionChange: (section: SettingsSection) => void;
  onFontSizeChange: (value: UiFontSize) => void;
  onRefreshDiagnostics: () => void;
  onSaveRuntimeCliPath: (runtimeId: RuntimeId, cliPath: string) => void;
  onClearRuntimeCliPath: (runtimeId: RuntimeId) => void;
  onSaveCodexGatewayUsage: (patch: CodexGatewayUsageConfig) => void;
  onSaveDeepSeekUsage: (patch: DeepSeekUsageConfig) => void;
  onSavePersonalCenterPath: (path: string | null) => void;
  onPickPersonalCenterPath: () => void;
  onClose: () => void;
};

const settingsSections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: "general", label: "常规", description: "显示与基础偏好" },
  { id: "personal", label: "个人中心", description: "目录与会话模式" },
  { id: "usage", label: "余额与消耗", description: "Codex / DeepSeek" },
  { id: "cli", label: "CLI 检测", description: "本机 Agent 状态" },
];

type UsageProvider = "codex" | "deepseek";

type CodexUsageDraft = {
  baseUrl: string;
  apiKey: string;
  path: string;
  timeoutSecs: string;
};

type DeepSeekUsageDraft = {
  apiKey: string;
  timeoutSecs: string;
};

const defaultCodexUsageDraft: CodexUsageDraft = {
  baseUrl: "https://api.999555999.com",
  apiKey: "",
  path: "/v1/usage",
  timeoutSecs: "10",
};

const defaultDeepSeekUsageDraft: DeepSeekUsageDraft = {
  apiKey: "",
  timeoutSecs: "12",
};

function probeForRuntime(probes: ProbeResult[], runtimeId: string) {
  return probes.find((probe) => probe.runtimeId === runtimeId) ?? null;
}

function runtimeProbeClassName(runtime: RuntimeInfo, probe: ProbeResult | null) {
  if (!runtime.enabled) return "settings-runtime-card__status--disabled";
  if (!probe) return "settings-runtime-card__status--unknown";
  return probe.found
    ? "settings-runtime-card__status--found"
    : "settings-runtime-card__status--missing";
}

function runtimeProbeLabel(runtime: RuntimeInfo, probe: ProbeResult | null) {
  if (!runtime.enabled) return "已禁用";
  if (!probe) return "未探测";
  return probe.found ? "已找到" : "未找到";
}

export function SettingsDialog({
  activeSection,
  uiFontSize,
  runtimes,
  probes,
  appSettings,
  settingsRuntimeBusy,
  settingsUsageBusy,
  settingsPersonalCenterBusy,
  routeDiagnosticsPanel,
  statusLine,
  onSectionChange,
  onFontSizeChange,
  onRefreshDiagnostics,
  onSaveRuntimeCliPath,
  onClearRuntimeCliPath,
  onSaveCodexGatewayUsage,
  onSaveDeepSeekUsage,
  onSavePersonalCenterPath,
  onPickPersonalCenterPath,
  onClose,
}: Props) {
  const [cliPathDrafts, setCliPathDrafts] = useState<Record<string, string>>({});
  const [personalCenterPathDraft, setPersonalCenterPathDraft] = useState("");
  const [usageProvider, setUsageProvider] = useState<UsageProvider>("codex");
  const [codexUsageDraft, setCodexUsageDraft] = useState<CodexUsageDraft>(
    defaultCodexUsageDraft,
  );
  const [deepseekUsageDraft, setDeepSeekUsageDraft] = useState<DeepSeekUsageDraft>(
    defaultDeepSeekUsageDraft,
  );
  const visibleRuntimes = useMemo(() => sortRuntimes(runtimes), [runtimes]);
  const enabledCount = visibleRuntimes.filter((runtime) => runtime.enabled).length;
  const foundCount = visibleRuntimes.filter((runtime) => {
    const probe = probeForRuntime(probes, runtime.id);
    return runtime.enabled && probe?.found;
  }).length;
  const missingCount = visibleRuntimes.filter((runtime) => {
    const probe = probeForRuntime(probes, runtime.id);
    return runtime.enabled && probe && !probe.found;
  }).length;
  const gatedCount = visibleRuntimes.filter(
    (runtime) => runtime.enabled && runtime.capabilities.permissionGate,
  ).length;
  const unknownCount = visibleRuntimes.filter(
    (runtime) => runtime.enabled && !probeForRuntime(probes, runtime.id),
  ).length;
  const activeMeta =
    settingsSections.find((section) => section.id === activeSection) ??
    settingsSections[0];

  useEffect(() => {
    setCliPathDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const runtime of visibleRuntimes) {
        const saved = appSettings?.runtimes[runtime.id]?.cliPath ?? "";
        next[runtime.id] = prev[runtime.id] ?? saved;
      }
      return next;
    });
  }, [appSettings, visibleRuntimes]);

  useEffect(() => {
    const saved = appSettings?.usage?.codexGateway;
    setCodexUsageDraft({
      baseUrl: saved?.baseUrl ?? defaultCodexUsageDraft.baseUrl,
      apiKey: saved?.apiKey ?? "",
      path: saved?.path ?? defaultCodexUsageDraft.path,
      timeoutSecs: String(saved?.timeoutSecs ?? defaultCodexUsageDraft.timeoutSecs),
    });
  }, [appSettings]);

  useEffect(() => {
    const saved = appSettings?.usage?.deepseek;
    setDeepSeekUsageDraft({
      apiKey: saved?.apiKey ?? "",
      timeoutSecs: String(saved?.timeoutSecs ?? defaultDeepSeekUsageDraft.timeoutSecs),
    });
  }, [appSettings]);

  useEffect(() => {
    setPersonalCenterPathDraft(appSettings?.personalCenter?.path ?? "");
  }, [appSettings]);

  const savedCodexUsage = appSettings?.usage?.codexGateway;
  const codexUsageTimeout = Number(codexUsageDraft.timeoutSecs);
  const codexUsageTimeoutValid =
    Number.isFinite(codexUsageTimeout) && codexUsageTimeout >= 3 && codexUsageTimeout <= 30;
  const codexUsageDirty =
    codexUsageDraft.baseUrl.trim() !== (savedCodexUsage?.baseUrl ?? defaultCodexUsageDraft.baseUrl) ||
    codexUsageDraft.apiKey.trim() !== (savedCodexUsage?.apiKey ?? "") ||
    codexUsageDraft.path.trim() !== (savedCodexUsage?.path ?? defaultCodexUsageDraft.path) ||
    codexUsageTimeout !== (savedCodexUsage?.timeoutSecs ?? Number(defaultCodexUsageDraft.timeoutSecs));
  const canSaveCodexUsage =
    codexUsageDraft.baseUrl.trim().length > 0 &&
    codexUsageDraft.apiKey.trim().length > 0 &&
    codexUsageDraft.path.trim().length > 0 &&
    codexUsageTimeoutValid &&
    !settingsUsageBusy &&
    codexUsageDirty;
  const canClearCodexUsage =
    !settingsUsageBusy &&
    Boolean(
      savedCodexUsage?.baseUrl ||
        savedCodexUsage?.apiKey ||
        savedCodexUsage?.path ||
        savedCodexUsage?.timeoutSecs,
    );
  const savedDeepSeekUsage = appSettings?.usage?.deepseek;
  const deepseekUsageTimeout = Number(deepseekUsageDraft.timeoutSecs);
  const deepseekUsageTimeoutValid =
    Number.isFinite(deepseekUsageTimeout) &&
    deepseekUsageTimeout >= 3 &&
    deepseekUsageTimeout <= 30;
  const deepseekUsageDirty =
    deepseekUsageDraft.apiKey.trim() !== (savedDeepSeekUsage?.apiKey ?? "") ||
    deepseekUsageTimeout !==
      (savedDeepSeekUsage?.timeoutSecs ?? Number(defaultDeepSeekUsageDraft.timeoutSecs));
  const canSaveDeepSeekUsage =
    deepseekUsageDraft.apiKey.trim().length > 0 &&
    deepseekUsageTimeoutValid &&
    !settingsUsageBusy &&
    deepseekUsageDirty;
  const canClearDeepSeekUsage =
    !settingsUsageBusy && Boolean(savedDeepSeekUsage?.apiKey || savedDeepSeekUsage?.timeoutSecs);
  const savedPersonalCenterPath = appSettings?.personalCenter?.path ?? "";
  const personalCenterPathDirty =
    personalCenterPathDraft.trim() !== savedPersonalCenterPath.trim();
  const canSavePersonalCenterPath =
    personalCenterPathDirty && !settingsPersonalCenterBusy;
  const canClearPersonalCenterPath =
    Boolean(savedPersonalCenterPath.trim()) && !settingsPersonalCenterBusy;

  function saveCodexUsage(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!canSaveCodexUsage) return;
    onSaveCodexGatewayUsage({
      baseUrl: codexUsageDraft.baseUrl.trim(),
      apiKey: codexUsageDraft.apiKey.trim(),
      path: codexUsageDraft.path.trim(),
      timeoutSecs: codexUsageTimeout,
    });
  }

  function saveDeepSeekUsage(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!canSaveDeepSeekUsage) return;
    onSaveDeepSeekUsage({
      apiKey: deepseekUsageDraft.apiKey.trim(),
      timeoutSecs: deepseekUsageTimeout,
    });
  }

  return (
    <section
      className="settings-dialog settings-dialog--main"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <aside className="settings-side">
        <div className="settings-side__brand">
          <div className="settings-side__title">设置</div>
          <div className="settings-side__sub">Workbench</div>
        </div>
        <nav className="settings-side__nav" aria-label="设置菜单">
          {settingsSections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={
                "settings-nav-item" +
                (activeSection === section.id ? " settings-nav-item--active" : "")
              }
              onClick={() => onSectionChange(section.id)}
            >
              {section.id === "general" ? (
                <IconSettings size={15} />
              ) : section.id === "personal" ? (
                <IconFolder size={15} />
              ) : section.id === "usage" ? (
                <IconPlug size={15} />
              ) : (
                <IconDoctor size={15} />
              )}
              <span>
                <strong>{section.label}</strong>
                <small>{section.description}</small>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="settings-main">
        <div className="settings-dialog__head settings-main__head">
          <div>
            <div className="settings-dialog__title">{activeMeta.label}</div>
            <div className="settings-dialog__sub">{activeMeta.description}</div>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon settings-dialog__close"
            aria-label="关闭设置"
            title="关闭设置"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="settings-dialog__body settings-dialog__body--settings">
          {activeSection === "general" ? (
            <div className="settings-section">
              <div className="settings-row">
                <div>
                  <div className="settings-row__title">字体大小</div>
                  <div className="settings-row__desc">调整界面主要文字尺寸。</div>
                </div>
                <div className="settings-segmented" role="group" aria-label="字体大小">
                  {UI_FONT_SIZE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={
                        "settings-segmented__item" +
                        (uiFontSize === option.value ? " settings-segmented__item--active" : "")
                      }
                      onClick={() => onFontSizeChange(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-preview">
                <strong>预览文本</strong>
                <span>聊天、会话列表和设置面板会使用当前字体大小。</span>
              </div>
            </div>
          ) : activeSection === "personal" ? (
            <div className="settings-section">
              <div className="settings-row settings-row--stack">
                <div className="settings-row__title">个人中心目录</div>
                <div className="settings-row__desc">
                  仅在会话手动开启个人中心模式时读取入口规则，不会默认注入或写入该目录。
                </div>
              </div>
              <form
                className="settings-runtime-path"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (!canSavePersonalCenterPath) return;
                  const nextPath = personalCenterPathDraft.trim().replace(/^["']|["']$/g, "");
                  onSavePersonalCenterPath(nextPath.length > 0 ? nextPath : null);
                }}
              >
                <label className="settings-runtime-path__label" htmlFor="personal-center-path">
                  目录路径
                  <span>
                    读取 AGENTS.md、workflows/README.md 和 memory/personal 入口文件。
                  </span>
                </label>
                <div className="settings-runtime-path__row">
                  <input
                    id="personal-center-path"
                    type="text"
                    value={personalCenterPathDraft}
                    placeholder="X:\\1_2026_project\\wuxian-ai-center"
                    spellCheck={false}
                    disabled={settingsPersonalCenterBusy}
                    onChange={(ev) => setPersonalCenterPathDraft(ev.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={settingsPersonalCenterBusy}
                    onClick={onPickPersonalCenterPath}
                  >
                    选择
                  </button>
                  <button
                    type="submit"
                    className="btn"
                    disabled={!canSavePersonalCenterPath}
                  >
                    {settingsPersonalCenterBusy ? "保存中" : "保存"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={!canClearPersonalCenterPath}
                    onClick={() => {
                      setPersonalCenterPathDraft("");
                      onSavePersonalCenterPath(null);
                    }}
                  >
                    清除
                  </button>
                </div>
              </form>
              <div className="settings-preview">
                <strong>会话开关</strong>
                <span>在聊天输入区开启 Center 后，本会话每轮会附加个人中心入口规则。</span>
              </div>
            </div>
          ) : activeSection === "usage" ? (
            <div className="settings-section">
              <div className="settings-usage-tabs" role="tablist" aria-label="余额与消耗">
                <button
                  type="button"
                  role="tab"
                  aria-selected={usageProvider === "codex"}
                  className={
                    "settings-usage-tab" +
                    (usageProvider === "codex" ? " settings-usage-tab--active" : "")
                  }
                  onClick={() => setUsageProvider("codex")}
                >
                  Codex
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={usageProvider === "deepseek"}
                  className={
                    "settings-usage-tab" +
                    (usageProvider === "deepseek" ? " settings-usage-tab--active" : "")
                  }
                  onClick={() => setUsageProvider("deepseek")}
                >
                  DeepSeek
                </button>
              </div>

              {usageProvider === "codex" ? (
                <form className="settings-usage-form" onSubmit={saveCodexUsage}>
                  <div className="settings-row settings-row--stack">
                    <div className="settings-row__title">Codex</div>
                  </div>
                  <label className="settings-runtime-path__label" htmlFor="codex-usage-base-url">
                    API 地址
                  </label>
                  <input
                    id="codex-usage-base-url"
                    className="settings-usage-input"
                    type="url"
                    value={codexUsageDraft.baseUrl}
                    placeholder="https://api.999555999.com"
                    spellCheck={false}
                    disabled={settingsUsageBusy}
                    onChange={(ev) =>
                      setCodexUsageDraft((prev) => ({ ...prev, baseUrl: ev.target.value }))
                    }
                  />
                  <label className="settings-runtime-path__label" htmlFor="codex-usage-path">
                    接口路径
                  </label>
                  <input
                    id="codex-usage-path"
                    className="settings-usage-input"
                    type="text"
                    value={codexUsageDraft.path}
                    placeholder="/v1/usage"
                    spellCheck={false}
                    disabled={settingsUsageBusy}
                    onChange={(ev) =>
                      setCodexUsageDraft((prev) => ({ ...prev, path: ev.target.value }))
                    }
                  />
                  <label className="settings-runtime-path__label" htmlFor="codex-usage-api-key">
                    API Key
                  </label>
                  <input
                    id="codex-usage-api-key"
                    className="settings-usage-input"
                    type="password"
                    value={codexUsageDraft.apiKey}
                    placeholder="sk-..."
                    spellCheck={false}
                    autoComplete="off"
                    disabled={settingsUsageBusy}
                    onChange={(ev) =>
                      setCodexUsageDraft((prev) => ({ ...prev, apiKey: ev.target.value }))
                    }
                  />
                  <label className="settings-runtime-path__label" htmlFor="codex-usage-timeout">
                    查询超时
                  </label>
                  <input
                    id="codex-usage-timeout"
                    className="settings-usage-input settings-usage-input--number"
                    type="number"
                    min={3}
                    max={30}
                    value={codexUsageDraft.timeoutSecs}
                    disabled={settingsUsageBusy}
                    onChange={(ev) =>
                      setCodexUsageDraft((prev) => ({ ...prev, timeoutSecs: ev.target.value }))
                    }
                  />
                  <div className="settings-usage-actions">
                    <button type="submit" className="btn" disabled={!canSaveCodexUsage}>
                      {settingsUsageBusy ? "保存中" : "保存"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={!canClearCodexUsage}
                      onClick={() => onSaveCodexGatewayUsage({})}
                    >
                      清除
                    </button>
                  </div>
                </form>
              ) : (
                <form className="settings-usage-form" onSubmit={saveDeepSeekUsage}>
                  <div className="settings-row settings-row--stack">
                    <div className="settings-row__title">DeepSeek</div>
                  </div>
                  <label className="settings-runtime-path__label" htmlFor="deepseek-usage-api-key">
                    API Key
                  </label>
                  <input
                    id="deepseek-usage-api-key"
                    className="settings-usage-input"
                    type="password"
                    value={deepseekUsageDraft.apiKey}
                    placeholder="sk-..."
                    spellCheck={false}
                    autoComplete="off"
                    disabled={settingsUsageBusy}
                    onChange={(ev) =>
                      setDeepSeekUsageDraft((prev) => ({ ...prev, apiKey: ev.target.value }))
                    }
                  />
                  <label className="settings-runtime-path__label" htmlFor="deepseek-usage-timeout">
                    查询超时
                  </label>
                  <input
                    id="deepseek-usage-timeout"
                    className="settings-usage-input settings-usage-input--number"
                    type="number"
                    min={3}
                    max={30}
                    value={deepseekUsageDraft.timeoutSecs}
                    disabled={settingsUsageBusy}
                    onChange={(ev) =>
                      setDeepSeekUsageDraft((prev) => ({
                        ...prev,
                        timeoutSecs: ev.target.value,
                      }))
                    }
                  />
                  <div className="settings-usage-actions">
                    <button type="submit" className="btn" disabled={!canSaveDeepSeekUsage}>
                      {settingsUsageBusy ? "保存中" : "保存"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={!canClearDeepSeekUsage}
                      onClick={() => onSaveDeepSeekUsage({})}
                    >
                      清除
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : (
            <div className="settings-section">
              <div className="settings-cli-head">
                <div>
                  <div className="settings-row__title">多 CLI 检测</div>
                  <div className="settings-row__desc">
                    检测本机 Agent CLI 的路径、版本和路由状态。
                  </div>
                </div>
                <button type="button" className="btn" onClick={onRefreshDiagnostics}>
                  <IconRefresh size={15} />
                  重新探测
                </button>
              </div>
              <div className="settings-cli-stats" aria-label="CLI 检测概览">
                <span>
                  <span>启用</span>
                  <strong>{enabledCount}</strong>
                </span>
                <span>
                  <span>已找到</span>
                  <strong>{foundCount}</strong>
                </span>
                <span>
                  <span>未找到</span>
                  <strong>{missingCount}</strong>
                </span>
                <span>
                  <span>Host 权限</span>
                  <strong>{gatedCount}</strong>
                </span>
              </div>
              {unknownCount > 0 ? (
                <div className="settings-cli-hint">还有 {unknownCount} 个 runtime 未探测。</div>
              ) : null}

              <div className="settings-runtime-list">
                {visibleRuntimes.map((runtime) => {
                  const probe = probeForRuntime(probes, runtime.id);
                  const statusClass = runtimeProbeClassName(runtime, probe);
                  const savedCliPath =
                    appSettings?.runtimes[runtime.id]?.cliPath?.trim() ?? "";
                  const cliPathDraft = cliPathDrafts[runtime.id] ?? savedCliPath;
                  const pathBusy = settingsRuntimeBusy === runtime.id;
                  const pathDirty = cliPathDraft.trim() !== savedCliPath;
                  const canSavePath = cliPathDraft.trim().length > 0 && pathDirty && !pathBusy;
                  return (
                    <div key={runtime.id} className="settings-runtime-card">
                      <div className="settings-runtime-card__head">
                        <span className="settings-runtime-card__identity">
                          {runtimeAvatarSrc[runtime.id] ? (
                            <img
                              src={runtimeAvatarSrc[runtime.id]}
                              alt=""
                              title={runtimeAvatarLabel(runtime.id)}
                              width={24}
                              height={24}
                              draggable={false}
                            />
                          ) : (
                            <span className={`runtime-dot runtime-dot--${runtime.id}`} />
                          )}
                          <strong>{runtimeLabel(runtime.id)}</strong>
                        </span>
                        <span className={`settings-runtime-card__status ${statusClass}`}>
                          {runtimeProbeLabel(runtime, probe)}
                        </span>
                      </div>
                      <div className="settings-kv">
                        <span>protocol</span>
                        <strong>{protocolLabel(runtime.capabilities.protocol)}</strong>
                      </div>
                      <div className="settings-kv">
                        <span>path</span>
                        <strong>{probe?.path ?? "-"}</strong>
                      </div>
                      <div className="settings-kv">
                        <span>version</span>
                        <strong>{probe?.version ?? probe?.detail ?? "-"}</strong>
                      </div>
                      <div className="settings-kv">
                        <span>能力</span>
                        <strong>{runtimeCapabilitySummary(runtime)}</strong>
                      </div>
                      <div className="settings-capability-grid" aria-label={`${runtime.displayName} 能力矩阵`}>
                        {capabilityDescriptors(runtime.capabilities).map((capability) => (
                          <span
                            key={capability.key}
                            className={
                              "settings-capability" +
                              (capability.enabled ? " settings-capability--on" : "")
                            }
                            title={
                              capability.enabled
                                ? capability.label
                                : capability.unavailableReason
                            }
                          >
                            {capability.label}
                          </span>
                        ))}
                      </div>
                      {probe?.detail && probe.detail !== probe.version ? (
                        <div className="settings-kv">
                          <span>detail</span>
                          <strong>{probe.detail}</strong>
                        </div>
                      ) : null}
                      {runtime.notes ? (
                        <div className="settings-runtime-card__note">{runtime.notes}</div>
                      ) : null}
                      <form
                        className="settings-runtime-path"
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          if (canSavePath) {
                            const nextPath = cliPathDraft.trim().replace(/^["']|["']$/g, "");
                            setCliPathDrafts((prev) => ({
                              ...prev,
                              [runtime.id]: nextPath,
                            }));
                            onSaveRuntimeCliPath(runtime.id, nextPath);
                          }
                        }}
                      >
                        <label className="settings-runtime-path__label">
                          自定义 CLI 路径
                          <span>
                            {savedCliPath ? "用户指定路径优先" : "留空时使用 PATH 和常见路径"}
                          </span>
                        </label>
                        <div className="settings-runtime-path__row">
                          <input
                            type="text"
                            value={cliPathDraft}
                            placeholder="C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"
                            spellCheck={false}
                            disabled={pathBusy}
                            onChange={(ev) =>
                              setCliPathDrafts((prev) => ({
                                ...prev,
                                [runtime.id]: ev.target.value,
                              }))
                            }
                          />
                          <button
                            type="submit"
                            className="btn"
                            disabled={!canSavePath}
                          >
                            {pathBusy ? "保存中" : "保存"}
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={!savedCliPath || pathBusy}
                            onClick={() => {
                              setCliPathDrafts((prev) => ({
                                ...prev,
                                [runtime.id]: "",
                              }));
                              onClearRuntimeCliPath(runtime.id);
                            }}
                          >
                            清除
                          </button>
                        </div>
                      </form>
                    </div>
                  );
                })}
              </div>

              <div className="sidebar__section-label settings-diagnostics__label">
                路由
              </div>
              {routeDiagnosticsPanel}
              <div className="sidebar__section-label settings-diagnostics__label">
                Host
              </div>
              <div className="muted settings-diagnostics__host">{statusLine}</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
