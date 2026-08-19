import { type ReactNode, useEffect, useMemo, useState } from "react";

import { IconClose, IconDoctor, IconRefresh, IconSettings } from "./icons";
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
import type { AppSettings, ProbeResult, RuntimeId, RuntimeInfo } from "../lib/types";

export type SettingsSection = "general" | "cli";

type Props = {
  activeSection: SettingsSection;
  uiFontSize: UiFontSize;
  runtimes: RuntimeInfo[];
  probes: ProbeResult[];
  appSettings: AppSettings | null;
  settingsRuntimeBusy: string | null;
  routeDiagnosticsPanel: ReactNode;
  statusLine: string;
  onSectionChange: (section: SettingsSection) => void;
  onFontSizeChange: (value: UiFontSize) => void;
  onRefreshDiagnostics: () => void;
  onSaveRuntimeCliPath: (runtimeId: RuntimeId, cliPath: string) => void;
  onClearRuntimeCliPath: (runtimeId: RuntimeId) => void;
  onClose: () => void;
};

const settingsSections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: "general", label: "常规", description: "显示与基础偏好" },
  { id: "cli", label: "CLI 检测", description: "本机 Agent 状态" },
];

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
  routeDiagnosticsPanel,
  statusLine,
  onSectionChange,
  onFontSizeChange,
  onRefreshDiagnostics,
  onSaveRuntimeCliPath,
  onClearRuntimeCliPath,
  onClose,
}: Props) {
  const [cliPathDrafts, setCliPathDrafts] = useState<Record<string, string>>({});
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
              {section.id === "general" ? <IconSettings size={15} /> : <IconDoctor size={15} />}
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
                            placeholder="例如 C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"
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
