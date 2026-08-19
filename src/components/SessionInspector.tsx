import { useState } from "react";

import { formatSessionTime } from "../lib/format";
import {
  capabilityDescriptors,
  INSPECTOR_CAPABILITIES,
  protocolLabel,
} from "../lib/capabilities";
import { toolMessageLabel } from "../lib/messages";
import { runtimeInfo, runtimeLabel } from "../lib/runtimes";
import { sessionDisplaySummary, sessionDisplayTitle, stateDotClass } from "../lib/sessions";
import type {
  ChatMessage,
  PermissionMode,
  PermissionRequestEvent,
  RuntimeId,
  SessionMeta,
  SessionSnapshot,
} from "../lib/types";

type Props = {
  hidden: boolean;
  active: SessionMeta | null;
  snapshot: SessionSnapshot;
  messages: ChatMessage[];
  permissionQueue: PermissionRequestEvent[];
  activeRuntimeId: RuntimeId;
  activeModelLabel: string;
  activeModelReasoningEffort: string | null;
  activePermissionMode: PermissionMode | null;
  appDataDir: string | null;
  statusLine: string;
  onToggleMaximize: () => void;
};

type InspectorTab = "activity" | "context" | "details";

const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "activity", label: "活动" },
  { id: "context", label: "上下文" },
  { id: "details", label: "详情" },
];

function valueOrDash(value?: string | null): string {
  const text = value?.trim();
  return text || "-";
}

function permissionLabel(mode: PermissionMode | null): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "auto":
      return "Auto";
    case "read_only":
      return "Read only";
    case "full_access":
      return "Full access";
    default:
      return "-";
  }
}

export function SessionInspector({
  hidden,
  active,
  snapshot,
  messages,
  permissionQueue,
  activeRuntimeId,
  activeModelLabel,
  activeModelReasoningEffort,
  activePermissionMode,
  appDataDir,
  statusLine,
  onToggleMaximize,
}: Props) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("activity");
  const allToolMessages = messages.filter((message) => message.role === "tool");
  const toolMessages = allToolMessages.slice(-5);
  const assistantCount = messages.filter((message) => message.role === "assistant").length;
  const userCount = messages.filter((message) => message.role === "user").length;
  const sessionPath = active && appDataDir ? `${appDataDir}\\sessions\\${active.id}` : null;
  const summary = active ? sessionDisplaySummary(active) : null;
  const activeRuntime = runtimeInfo(activeRuntimeId);
  const runtimeCapabilities = activeRuntime
    ? capabilityDescriptors(activeRuntime.capabilities, INSPECTOR_CAPABILITIES)
    : [];
  const unavailableRuntimeCapabilities = runtimeCapabilities.filter(
    (capability) => !capability.enabled,
  );

  return (
    <aside className={"aside inspector" + (hidden ? " aside--hidden" : "")} aria-hidden={hidden}>
      <div className="aside__chrome" data-tauri-drag-region onDoubleClick={onToggleMaximize}>
        <span className="aside__chrome-title">Inspector</span>
      </div>

      <div className="aside__body inspector__body">
        {!active ? (
          <div className="inspector-empty">
            <div className="inspector-empty__title">未选择会话</div>
            <div className="inspector-empty__sub">选择左侧会话后查看上下文和活动。</div>
          </div>
        ) : (
          <>
            <div className="inspector-session-head">
              <div className="inspector-session-head__title">
                <span className={`status-dot ${stateDotClass(snapshot.state)}`} />
                <span>{sessionDisplayTitle(active)}</span>
              </div>
              <div className="inspector-session-head__meta">
                {runtimeLabel(activeRuntimeId)} · {activeModelLabel}
              </div>
            </div>

            <div className="inspector-tabs" role="tablist" aria-label="会话检查器">
              {INSPECTOR_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={
                    "inspector-tab" +
                    (activeTab === tab.id ? " inspector-tab--active" : "")
                  }
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === "activity" ? (
              <div className="inspector-tab-panel" role="tabpanel">
                <section className="inspector-section">
                  <div className="inspector-section__head">
                    <span>活动</span>
                    <span>{messages.length} 条消息</span>
                  </div>
                  <div className="inspector-activity-summary">
                    本会话：{userCount} 条用户消息 · {assistantCount} 条 AI 回复 ·{" "}
                    {allToolMessages.length} 次工具调用
                  </div>
                  {permissionQueue.length > 0 ? (
                    <div className="inspector-alert">
                      <strong>等待权限 · {permissionQueue.length}</strong>
                      <span>{permissionQueue[0]?.title ?? permissionQueue[0]?.toolName}</span>
                    </div>
                  ) : null}
                </section>

                <section className="inspector-section">
                  <div className="inspector-section__head">
                    <span>最近工具</span>
                    <span>{toolMessages.length}/5</span>
                  </div>
                  {toolMessages.length > 0 ? (
                    <div className="inspector-list">
                      {toolMessages.map((message) => (
                        <div key={message.id} className="inspector-list__item">
                          <span>{toolMessageLabel(message)}</span>
                          <small>{formatSessionTime(message.completedAt ?? message.createdAt)}</small>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="inspector-muted">暂无工具活动</div>
                  )}
                </section>
              </div>
            ) : null}

            {activeTab === "context" ? (
              <div className="inspector-tab-panel" role="tabpanel">
                <section className="inspector-section">
                  <div className="inspector-section__head">
                    <span>摘要</span>
                  </div>
                  <div className="inspector-title">{sessionDisplayTitle(active)}</div>
                  {summary ? (
                    <div className="inspector-summary">{summary}</div>
                  ) : (
                    <div className="inspector-muted">暂无摘要</div>
                  )}
                </section>

                <section className="inspector-section">
                  <div className="inspector-section__head">
                    <span>路径</span>
                  </div>
                  <div className="inspector-grid">
                    <span>项目</span>
                    <strong>{valueOrDash(active.projectPath ?? snapshot.projectPath)}</strong>
                    <span>会话目录</span>
                    <strong>{valueOrDash(sessionPath)}</strong>
                    <span>原生 ID</span>
                    <strong>{valueOrDash(active.nativeSessionId ?? active.nativeThreadId)}</strong>
                    <span>更新</span>
                    <strong>{formatSessionTime(active.nativeUpdatedAt ?? active.updatedAt)}</strong>
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === "details" ? (
              <div className="inspector-tab-panel" role="tabpanel">
                <section className="inspector-section">
                  <div className="inspector-section__head">
                    <span>运行状态</span>
                    <span>{snapshot.backend}</span>
                  </div>
                  <div className="inspector-grid">
                    <span>状态</span>
                    <strong>{snapshot.state}</strong>
                    <span>引擎</span>
                    <strong>{runtimeLabel(activeRuntimeId)}</strong>
                    <span>模型</span>
                    <strong>{activeModelLabel}</strong>
                    {activeModelReasoningEffort ? (
                      <>
                        <span>推理</span>
                        <strong>{activeModelReasoningEffort}</strong>
                      </>
                    ) : null}
                    <span>权限</span>
                    <strong>{permissionLabel(activePermissionMode)}</strong>
                  </div>
                </section>

                {activeRuntime ? (
                  <section className="inspector-section">
                    <div className="inspector-section__head">
                      <span>能力矩阵</span>
                      <span>{protocolLabel(activeRuntime.capabilities.protocol)}</span>
                    </div>
                    <div className="inspector-capability-list">
                      {runtimeCapabilities.map((capability) => (
                        <span
                          key={capability.key}
                          className={
                            "inspector-capability" +
                            (capability.enabled ? " inspector-capability--on" : "")
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
                    {unavailableRuntimeCapabilities.length > 0 ? (
                      <div className="inspector-muted inspector-capability-note">
                        {unavailableRuntimeCapabilities[0].unavailableReason}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {snapshot.lastError ? (
                  <section className="inspector-section inspector-section--danger">
                    <div className="inspector-section__head">
                      <span>最后错误</span>
                      <span>{snapshot.lastError.code}</span>
                    </div>
                    <div className="inspector-error">{snapshot.lastError.message}</div>
                  </section>
                ) : null}

                <section className="inspector-section">
                  <div className="inspector-section__head">
                    <span>Host</span>
                  </div>
                  <div className="inspector-muted">{statusLine}</div>
                </section>
              </div>
            ) : null}
          </>
        )}

        {!active ? (
          <section className="inspector-section">
            <div className="inspector-section__head">
              <span>Host</span>
            </div>
            <div className="inspector-muted">{statusLine}</div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
