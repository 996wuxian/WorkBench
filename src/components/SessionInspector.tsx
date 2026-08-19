import { useEffect, useMemo, useState } from "react";

import { formatSessionTime } from "../lib/format";
import { assistantElapsedLabel, messageRoleLabel, toolMessageLabel } from "../lib/messages";
import {
  capabilityDescriptors,
  INSPECTOR_CAPABILITIES,
  protocolLabel,
} from "../lib/capabilities";
import { runtimeInfo, runtimeLabel } from "../lib/runtimes";
import { sessionDisplaySummary, sessionDisplayTitle, stateDotClass } from "../lib/sessions";
import { compactLabel } from "../lib/format";
import {
  IconFileText,
  IconHistory,
  IconChevronDown,
  IconChevronUp,
  IconRobot,
  IconSend,
  IconRiskAsk,
} from "./icons";
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

type InspectorActivityEntry = {
  key: string;
  kind: "state" | "permission" | "user" | "assistant" | "thought" | "tool" | "system";
  title: string;
  detail: string;
  meta: string[];
  time?: string | null;
  level?: number;
  children?: InspectorActivityEntry[];
};

const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "activity", label: "活动" },
  { id: "context", label: "上下文" },
  { id: "details", label: "详情" },
];

const INSPECTOR_ACTIVITY_ROOT_LIMIT = 18;

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

function summarizeMessageContent(message: ChatMessage): string {
  const text = (message.content ?? "").trim();
  const imageCount = (text.match(/^\[image\]\s+/gm) ?? []).length;
  const body = text
    .split(/\r?\n/)
    .filter((line) => !/^\[image\]\s+/.test(line))
    .join(" ")
    .trim();
  const compact = compactLabel(body, 96);
  if (compact && imageCount > 0) {
    return `${compact} · ${imageCount} 张图片`;
  }
  if (compact) return compact;
  if (imageCount > 0) return `${imageCount} 张图片`;
  return message.role === "assistant" && message.streaming
    ? "正在生成回复"
    : "无正文";
}

function snapshotStateLabel(state: SessionSnapshot["state"]): string {
  switch (state) {
    case "connecting":
      return "连接中";
    case "ready":
      return "就绪";
    case "streaming":
      return "回复中";
    case "awaiting_permission":
      return "等待权限";
    case "disconnected":
      return "已断开";
    default:
      return "空闲";
  }
}

function snapshotStateTone(state: SessionSnapshot["state"]): "neutral" | "good" | "warn" | "danger" {
  switch (state) {
    case "ready":
      return "good";
    case "streaming":
    case "awaiting_permission":
      return "warn";
    case "disconnected":
      return "danger";
    default:
      return "neutral";
  }
}

function activityKindLabel(kind: InspectorActivityEntry["kind"]): string {
  switch (kind) {
    case "user":
      return "用户";
    case "assistant":
      return "回复";
    case "thought":
      return "思考";
    case "tool":
      return "工具";
    case "permission":
      return "权限";
    case "state":
      return "状态";
    default:
      return "系统";
  }
}

function activityKindTone(kind: InspectorActivityEntry["kind"]): "neutral" | "good" | "warn" | "danger" {
  switch (kind) {
    case "state":
      return "good";
    case "permission":
      return "warn";
    default:
      return "neutral";
  }
}

function activityIcon(kind: InspectorActivityEntry["kind"]) {
  switch (kind) {
    case "state":
      return <IconHistory size={13} />;
    case "permission":
      return <IconRiskAsk size={13} />;
    case "assistant":
      return <IconRobot size={13} />;
    case "tool":
      return <IconFileText size={13} />;
    case "user":
      return <IconSend size={13} />;
    case "thought":
      return <IconHistory size={13} />;
    default:
      return <IconHistory size={13} />;
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
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [expandedToolThreads, setExpandedToolThreads] = useState<Set<string>>(
    () => new Set(),
  );
  const allToolMessages = messages.filter((message) => message.role === "tool");
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
  useEffect(() => {
    setShowAllActivity(false);
    setExpandedToolThreads(new Set());
  }, [active?.id]);

  const activityView = useMemo(() => {
    const entries: InspectorActivityEntry[] = [
      {
        key: "state",
        kind: "state",
        title: snapshotStateLabel(snapshot.state),
        detail: active
          ? `${runtimeLabel(activeRuntimeId)} · ${activeModelLabel}${activeModelReasoningEffort ? ` · ${activeModelReasoningEffort}` : ""}`
          : "未选择会话",
        meta: [snapshot.backend, permissionLabel(activePermissionMode)],
        time: snapshot.promptStartedAt ? formatSessionTime(snapshot.promptStartedAt) : null,
      },
    ];

    for (const request of permissionQueue) {
      entries.push({
        key: `permission:${request.requestId}`,
        kind: "permission",
        title: request.title || request.toolName,
        detail: request.preview || request.toolName,
        meta: [
          request.autoAllowed ? "已自动放行" : "待确认",
          request.policy ? `${request.policy.action} · ${request.policy.risk}` : "权限请求",
        ],
        time: null,
      });
    }

    const renderedMessages: InspectorActivityEntry[] = [];
    const renderAll = showAllActivity;
    let rootCount = 0;
    let hasMore = false;
    let pendingToolChildren: InspectorActivityEntry[] = [];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const time = formatSessionTime(message.completedAt ?? message.createdAt ?? null);

      if (message.role === "tool") {
        const toolEntry: InspectorActivityEntry = {
          key: `tool:${message.id}`,
          kind: "tool",
          title: toolMessageLabel(message),
          detail: summarizeMessageContent(message),
          meta: [message.toolName ?? "工具"],
          time,
          level: 1,
        };
        pendingToolChildren.push(toolEntry);
        continue;
      }

      rootCount += 1;
      if (!renderAll && rootCount > INSPECTOR_ACTIVITY_ROOT_LIMIT) {
        hasMore = true;
        break;
      }

      const kind = message.role;
      const title =
        kind === "assistant"
          ? message.streaming
            ? "助手正在回复"
            : message.partial
              ? "助手中断"
              : "助手已完成"
          : kind === "thought"
            ? "思考内容"
            : kind === "system"
              ? "系统消息"
              : messageRoleLabel(message, runtimeLabel(message.runtimeId ?? activeRuntimeId));
      const meta =
        kind === "assistant"
          ? [
              message.streaming ? "流式输出" : message.partial ? "已中断" : "完成",
              assistantElapsedLabel(message) ?? "耗时 -",
            ]
          : kind === "thought"
            ? ["内部步骤"]
            : [];

      const entry: InspectorActivityEntry = {
        key: `${kind}:${message.id}`,
        kind,
        title,
        detail: summarizeMessageContent(message),
        meta,
        time,
      };
      if (kind === "assistant" && pendingToolChildren.length > 0) {
        entry.children = [...pendingToolChildren.reverse()];
      }
      pendingToolChildren = [];
      renderedMessages.push(entry);
    }

    if (pendingToolChildren.length > 0) {
      hasMore = true;
    }

    return { entries: [...entries, ...renderedMessages], hasMore };
  }, [
    active,
    activeModelLabel,
    activeModelReasoningEffort,
    activePermissionMode,
    activeRuntimeId,
    messages,
    permissionQueue,
    showAllActivity,
    snapshot.backend,
    snapshot.promptStartedAt,
    snapshot.state,
  ]);
  const activityEntries = activityView.entries;
  const hasMoreActivity = activityView.hasMore;

  useEffect(() => {
    setExpandedToolThreads((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of current) {
        const entry = activityEntries.find((item) => item.key === key);
        if (entry?.children?.length) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activityEntries]);

  const toggleToolThread = (key: string) => {
    setExpandedToolThreads((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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
                    <span>链路</span>
                    <span>{activityEntries.length} 条记录</span>
                  </div>
                  <div className="inspector-activity-summary">
                    本会话：{userCount} 条用户消息 · {assistantCount} 条 AI 回复 ·{" "}
                    {allToolMessages.length} 次工具调用
                  </div>
                  {hasMoreActivity && !showAllActivity ? (
                    <div className="inspector-ledger__collapse">
                      <span>更早内容已折叠，当前只保留最近活动。</span>
                      <button
                        type="button"
                        className="inspector-ledger__collapse-btn"
                        onClick={() => setShowAllActivity(true)}
                      >
                        查看全部
                      </button>
                    </div>
                  ) : null}
                  {showAllActivity && messages.length > INSPECTOR_ACTIVITY_ROOT_LIMIT ? (
                    <div className="inspector-ledger__collapse">
                      <span>已展开全部活动。</span>
                      <button
                        type="button"
                        className="inspector-ledger__collapse-btn"
                        onClick={() => setShowAllActivity(false)}
                      >
                        收起
                      </button>
                    </div>
                  ) : null}
                  <div className="inspector-ledger" role="list" aria-label="会话链路">
                    {activityEntries.map((entry) => (
                      <div
                        key={entry.key}
                        className={
                          "inspector-ledger__item" +
                          ` inspector-ledger__item--${entry.kind}` +
                          (entry.level ? ` inspector-ledger__item--level-${entry.level}` : "")
                        }
                        role="listitem"
                      >
                        <div className="inspector-ledger__rail" aria-hidden="true">
                          <span className="inspector-ledger__icon">
                            {activityIcon(entry.kind)}
                          </span>
                        </div>
                        <div className="inspector-ledger__body">
                          <div className="inspector-ledger__top">
                            <span className="inspector-ledger__title">{entry.title}</span>
                            <span className={`inspector-ledger__state inspector-ledger__state--${entry.kind === "state" ? snapshotStateTone(snapshot.state) : activityKindTone(entry.kind)}`}>
                              {entry.kind === "state"
                                ? snapshotStateLabel(snapshot.state)
                                : entry.kind === "permission"
                                  ? (permissionQueue.length > 0 ? "待处理" : "已处理")
                                  : activityKindLabel(entry.kind)}
                            </span>
                          </div>
                          <div className="inspector-ledger__detail" title={entry.detail}>
                            {entry.detail}
                          </div>
                          <div className="inspector-ledger__meta">
                            {entry.meta.map((item) => (
                              <span key={item}>{item}</span>
                            ))}
                            {entry.time ? <span>{entry.time}</span> : null}
                            {entry.children?.length ? (
                              <button
                                type="button"
                                className="inspector-ledger__expand"
                                aria-expanded={expandedToolThreads.has(entry.key)}
                                onClick={() => toggleToolThread(entry.key)}
                              >
                                {expandedToolThreads.has(entry.key) ? (
                                  <>
                                    <IconChevronUp size={12} />
                                    <span>收起 {entry.children.length} 条工具</span>
                                  </>
                                ) : (
                                  <>
                                    <IconChevronDown size={12} />
                                    <span>展开 {entry.children.length} 条工具</span>
                                  </>
                                )}
                              </button>
                            ) : null}
                          </div>
                          {entry.children?.length && expandedToolThreads.has(entry.key) ? (
                            <div className="inspector-ledger__children">
                              {entry.children.map((child) => (
                                <div
                                  key={child.key}
                                  className="inspector-ledger__item inspector-ledger__item--child"
                                  role="listitem"
                                >
                                  <div className="inspector-ledger__rail" aria-hidden="true">
                                    <span className="inspector-ledger__icon">
                                      {activityIcon(child.kind)}
                                    </span>
                                  </div>
                                  <div className="inspector-ledger__body">
                                    <div className="inspector-ledger__top">
                                      <span className="inspector-ledger__title">{child.title}</span>
                                      <span className="inspector-ledger__state inspector-ledger__state--neutral">
                                        {activityKindLabel(child.kind)}
                                      </span>
                                    </div>
                                    <div className="inspector-ledger__detail" title={child.detail}>
                                      {child.detail}
                                    </div>
                                    <div className="inspector-ledger__meta">
                                      {child.meta.map((item) => (
                                        <span key={item}>{item}</span>
                                      ))}
                                      {child.time ? <span>{child.time}</span> : null}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
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
