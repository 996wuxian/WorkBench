import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  WindowControls,
  toggleMaximizeFromTitlebar,
} from "./components/WindowControls";
import { MessageList } from "./components/MessageList";
import { PermissionBar } from "./components/PermissionBar";
import {
  SessionSidebar,
  type ProjectContextTarget,
} from "./components/SessionSidebar";
import {
  OrchestrationPage,
} from "./components/OrchestrationPage";
import { OrchestrationSidebar } from "./components/OrchestrationSidebar";
import { ComposerPanel } from "./components/ComposerPanel";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "./components/ComposerPanel";
import { SessionInspector } from "./components/SessionInspector";
import { AppOverlays } from "./components/AppOverlays";
import { ToastViewport } from "./components/Toast";
import type { SettingsSection } from "./components/SettingsDialog";
import {
  IconChat,
  IconGitFork,
  IconPanelRight,
  IconThemeMoon,
  IconThemeSun,
} from "./components/icons";
import { useSessionEvents } from "./hooks/useSessionEvents";
import { api, isTauri } from "./lib/api";
import {
  applyUiFontSize,
  loadUiFontSize,
  saveUiFontSize,
  type UiFontSize,
} from "./lib/fontSize";
import { applyTheme, loadTheme, toggleTheme, type ThemeMode } from "./lib/theme";
import {
  codexReasoningEffortFromModel,
  fallbackModelOptions,
  normalizeCodexModelId,
} from "./lib/codex";
import {
  defaultReasoningEffortForRuntime,
  reasoningOptionsForRuntime,
} from "./lib/reasoning";
import { copyTextToClipboard, nowIso, uid } from "./lib/format";
import { emitToast } from "./lib/toast";
import { notifySessionResult } from "./lib/sessionNotifications";
import { findSkillByName, skillInvocationToken, skillKey } from "./lib/skills";
import {
  composeMessageText,
  finalizeStreamingMessage,
  normalizeLoadedMessages,
  restoreSessionMessages,
  type QuoteTarget,
} from "./lib/messages";
import {
  diffWorktreeSnapshots,
  insertOrUpdateWorktreeChangeBlock,
} from "./lib/worktreeChanges";
import { mockRuntimes, mockSessions } from "./lib/mocks";
import {
  defaultPermissionMode,
  fallbackPermissionOptions,
} from "./lib/permissions";
import { protocolLabel } from "./lib/capabilities";
import {
  SESSION_PAGE_SIZE,
  canChangeSessionSettings,
  deleteSessionById,
  idleSnapshot,
  loadRuntimePick,
  mergeSessions,
  saveRuntimePick,
  sessionDisplaySummary,
  sessionDisplayTitle,
  stateDotClass,
} from "./lib/sessions";
import type {
  AppSettings,
  ClaudeRouteStatus,
  ChatMessage,
  CodexGatewayUsageConfig,
  CodexRouteStatus,
  DeepSeekUsageConfig,
  NativeDeleteMode,
  PermissionDecision,
  PermissionMode,
  PickedFile,
  PermissionRequestEvent,
  ProbeResult,
  RuntimeId,
  RuntimeInfo,
  RuntimeUsageStatus,
  SessionMeta,
  SessionImageAttachment,
  SessionSelectionCatalog,
  SessionSnapshot,
  SessionState,
  SessionUnreadKind,
  SkillInfo,
  TurnSettledEvent,
  WorktreeChangeSnapshot,
} from "./lib/types";
import {
  allRuntimes,
  hydrateRuntimes,
  runtimeInfo,
  runtimeLabel,
  sortRuntimes,
} from "./lib/runtimes";
import {
  buildWorkflowNodePrompt,
  extractLastAssistantText,
  fixedWorkflowNodes,
  createOrchestrationTask,
  formatOrchestrationUpdatedAt,
  loadOrchestrationTasks,
  saveOrchestrationTasks,
  updateWorkflowNode,
  type WorkflowStepOutput,
  type OrchestrationNode,
  type OrchestrationTask,
} from "./lib/orchestration";

const INITIAL_VISIBLE_MESSAGES = 60;
const HISTORY_BATCH_SIZE = 40;
const CHAT_BOTTOM_THRESHOLD = 80;
const CHAT_TOP_THRESHOLD = 48;

function codexGoalPrompt(text: string): string {
  if (/^\/goal(?:\s|$)/i.test(text.trimStart())) {
    return text;
  }
  return `/goal ${text}`;
}
const PROJECT_ORDER_STORAGE_KEY = "workbench.projectOrder";
const PINNED_PROJECTS_STORAGE_KEY = "workbench.pinnedProjects";
const APP_VERSION = __APP_VERSION__;
const APP_DEVELOPMENT_DATE = "2026-08-19";
const APP_REPOSITORY_URL = "https://github.com/996wuxian/WorkBench";
const APP_DOWNLOAD_URL = "https://github.com/996wuxian/WorkBench/releases";

type DeleteSessionScope =
  | { kind: "sessions" }
  | { kind: "project"; label: string; path: string | null };

type AppView = "chat" | "orchestration";

function loadStringList(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function saveStringList(key: string, values: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Local ordering is a UI preference; failing to persist must not block the app.
  }
}

function runtimeRouteMode(runtime: RuntimeInfo): string {
  if (!runtime.enabled) return "disabled";
  return protocolLabel(runtime.capabilities.protocol);
}

function runtimeConnectHint(runtimeId: RuntimeId): string {
  if (runtimeId === "claude") return "claude -p --output-format stream-json";
  if (runtimeId === "codex") return "codex app-server --stdio";
  if (runtimeId === "deepseek-harness") return 'dsh --profile headless "task"';
  if (runtimeId === "grok") return "grok agent stdio";
  if (runtimeId === "kimi") return "kimi acp";
  return "runtime manifest";
}

function isCodexNativeDeleteError(message: string | null): boolean {
  return Boolean(
    message &&
      message.includes("codex thread/delete failed") &&
      message.includes("no such table: agent_jobs"),
  );
}

function isCodexDeleteFallbackError(message: string | null): boolean {
  return Boolean(
    message &&
      (isCodexNativeDeleteError(message) ||
        message.includes("Codex direct delete")),
  );
}

function isNativeDeleteFallbackError(message: string | null): boolean {
  return Boolean(
    message &&
      (isCodexDeleteFallbackError(message) ||
        message.includes("原生会话删除失败") ||
        message.includes("native delete failed") ||
        message.includes("native delete refused") ||
        message.includes("ACP summary delete task failed")),
  );
}

function formatDeleteSessionError(error: unknown): string {
  const raw = String(error);
  if (
    raw.includes("codex thread/delete failed") &&
    raw.includes("no such table: agent_jobs")
  ) {
    return `Codex 官方删除失败：当前 Codex app-server 状态库缺少 agent_jobs 表。Workbench 会话尚未删除；你可以直接删除 Codex 原生文件和索引，或仅删除 Workbench 记录。技术细节：${raw}`;
  }
  if (isNativeDeleteFallbackError(raw)) {
    return `原生会话删除失败：Workbench 会话尚未删除；你可以重试，或仅删除 Workbench 记录。技术细节：${raw}`;
  }
  return `delete failed: ${raw}`;
}

function nativeDeleteKind(
  session: SessionMeta,
): "codex" | "grok" | "claude" | "kimi" | null {
  if (session.runtimeId === "codex" && session.nativeThreadId) return "codex";
  if (session.runtimeId === "grok" && session.nativeSessionId) return "grok";
  if (session.runtimeId === "claude" && session.nativeSessionId) return "claude";
  if (session.runtimeId === "kimi" && session.nativeSessionId) return "kimi";
  return null;
}

function runtimeRouteDescription(runtime: RuntimeInfo): string {
  if (!runtime.enabled) {
    return "该运行时当前已禁用，不会创建新会话。";
  }
  if (runtime.id === "claude") {
    return "Workbench 连接本机 Claude CLI 的 headless stream-json 输出；权限通过 Workbench MCP 审批桥转回应用内确认。模型出口由 Claude Code 自身配置决定，当前页面不直接诊断 Claude 的上游代理。";
  }
  if (runtime.id === "grok") {
    return "Workbench 启动 grok agent stdio 并通过原生 ACP 通信；模型出口由 Grok CLI 自身处理，Workbench 不经过 cc-switch。";
  }
  if (runtime.id === "kimi") {
    return "Workbench 按 manifest 启动 kimi acp 并通过 ACP 通信；模型出口由 Kimi CLI 自身处理，是否可用取决于本机 Kimi CLI 是否安装并完成握手。";
  }
  if (runtime.id === "deepseek-harness") {
    return "Workbench 启动 dsh --profile headless 执行一次性任务；模型、工具和权限策略由 DeepSeek Harness profile 自身配置。当前阶段只接最终输出，完整事件桥后续再接。";
  }
  return `Workbench 通过 ${runtime.capabilities.protocol} 协议连接 ${runtime.displayName}；具体命令和参数来自 runtime manifest，模型出口由该 CLI 自身处理。`;
}


export default function App() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("chat");
  const [orchestrationTasks, setOrchestrationTasks] = useState<
    OrchestrationTask[]
  >(() => loadOrchestrationTasks());
  const [activeOrchestrationId, setActiveOrchestrationId] = useState(
    () => loadOrchestrationTasks()[0]?.id ?? "",
  );
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [pendingSession, setPendingSession] = useState<SessionMeta | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(idleSnapshot());
  const [sessionSnapshots, setSessionSnapshots] = useState<
    Record<string, SessionSnapshot>
  >({});
  const [sessionUnread, setSessionUnread] = useState<
    Record<string, SessionUnreadKind>
  >({});
  const [sessionTurnBusy, setSessionTurnBusy] = useState<Record<string, boolean>>({});
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  /** Approvals still waiting on the user, keyed by session. */
  const [permissionQueue, setPermissionQueue] = useState<
    Record<string, PermissionRequestEvent[]>
  >({});
  const [permissionBusy, setPermissionBusy] = useState<string | null>(null);
  const [codexRoute, setCodexRoute] = useState<CodexRouteStatus | null>(null);
  const [runtimeUsage, setRuntimeUsage] = useState<RuntimeUsageStatus | null>(null);
  const [runtimeUsageLoading, setRuntimeUsageLoading] = useState(false);
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [visibleMessageCounts, setVisibleMessageCounts] = useState<
    Record<string, number>
  >({});
  const [assistantTypingUntil, setAssistantTypingUntil] = useState<
    Record<string, number>
  >({});
  const [draft, setDraft] = useState("");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkillNames, setSelectedSkillNames] = useState<string[]>([]);
  const [goalModeBySession, setGoalModeBySession] = useState<Record<string, boolean>>({});
  const [quoteTarget, setQuoteTarget] = useState<QuoteTarget | null>(null);
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<ComposerFileAttachment[]>([]);
  const [runtimePick, setRuntimePick] = useState<RuntimeId>(() =>
    loadRuntimePick(),
  );
  const [busy, setBusy] = useState(false);
  const [runningWorkflowId, setRunningWorkflowId] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [projectPathBusy, setProjectPathBusy] = useState(false);
  const [controlCatalog, setControlCatalog] =
    useState<SessionSelectionCatalog | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [asideHidden, setAsideHidden] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsRuntimeBusy, setSettingsRuntimeBusy] = useState<string | null>(
    null,
  );
  const [settingsUsageBusy, setSettingsUsageBusy] = useState(false);
  const [settingsPersonalCenterBusy, setSettingsPersonalCenterBusy] = useState(false);
  const [sessionFilter, setSessionFilter] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    sessionId: string;
    left: number;
    top: number;
    targetIds: string[];
  } | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<
    (ProjectContextTarget & { left: number; top: number }) | null
  >(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [projectOrder, setProjectOrder] = useState<string[]>(() =>
    loadStringList(PROJECT_ORDER_STORAGE_KEY),
  );
  const [pinnedProjectKeys, setPinnedProjectKeys] = useState<string[]>(() =>
    loadStringList(PINNED_PROJECTS_STORAGE_KEY),
  );
  const [deleteSessionIds, setDeleteSessionIds] = useState<string[]>([]);
  const [deleteSessionScope, setDeleteSessionScope] = useState<DeleteSessionScope>({
    kind: "sessions",
  });
  const [deleteSessionBusy, setDeleteSessionBusy] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameSessionTitle, setRenameSessionTitle] = useState("");
  const [renameSessionBusy, setRenameSessionBusy] = useState(false);
  const [renameSessionError, setRenameSessionError] = useState<string | null>(null);
  const [syncingRuntime, setSyncingRuntime] = useState<RuntimeId | null>(null);
  const [claudeRoute, setClaudeRoute] = useState<ClaudeRouteStatus | null>(null);
  const [loadingMoreRuntime, setLoadingMoreRuntime] = useState<RuntimeId | null>(
    null,
  );
  const [nativeCursors, setNativeCursors] = useState<
    Partial<Record<RuntimeId, string | null>>
  >({});
  const [nativeHasMore, setNativeHasMore] = useState<
    Partial<Record<RuntimeId, boolean>>
  >({});
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [uiFontSize, setUiFontSize] = useState<UiFontSize>(() =>
    loadUiFontSize(),
  );
  const [appDataDir, setAppDataDir] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState(
    isTauri() ? "Connecting Host…" : "UI preview mode (no Tauri)",
  );

  // Keep native window fill in sync (boot + theme toggles already call applyTheme).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    applyUiFontSize(uiFontSize);
  }, [uiFontSize]);

  useEffect(() => {
    saveRuntimePick(runtimePick);
  }, [runtimePick]);

  useEffect(() => {
    saveStringList(PROJECT_ORDER_STORAGE_KEY, projectOrder);
  }, [projectOrder]);

  useEffect(() => {
    saveStringList(PINNED_PROJECTS_STORAGE_KEY, pinnedProjectKeys);
  }, [pinnedProjectKeys]);

  useEffect(() => {
    if (!saveOrchestrationTasks(orchestrationTasks)) {
      setStatusLine("编排任务保存失败：localStorage 不可写");
    }
  }, [orchestrationTasks]);

  const active = useMemo(
    () =>
      sessions.find((s) => s.id === activeId) ??
      (pendingSession?.id === activeId ? pendingSession : null),
    [sessions, pendingSession, activeId],
  );
  const activeRuntimeId = active?.runtimeId ?? snapshot.runtimeId ?? runtimePick;

  const refreshRuntimeUsage = useCallback(async () => {
    const runtimeId = activeRuntimeId;
    const supportsUsage = runtimeId === "deepseek-harness" || runtimeId === "codex";
    if (!active || !supportsUsage) {
      setRuntimeUsage(null);
      setRuntimeUsageLoading(false);
      return;
    }

    setRuntimeUsageLoading(true);
    if (!isTauri()) {
      setRuntimeUsage(
        runtimeId === "deepseek-harness"
          ? {
              runtimeId,
              provider: "DeepSeek",
              status: "ready",
              label: "DeepSeek 可用",
              summary: "CNY 88.80",
              detail: "浏览器预览数据",
              refreshedAt: nowIso(),
              hasCredential: true,
              balances: [
                {
                  currency: "CNY",
                  totalBalance: "88.80",
                  grantedBalance: "0.00",
                  toppedUpBalance: "88.80",
                },
              ],
              routeKind: "deepseek-official",
            }
          : {
              runtimeId,
              provider: "Codex",
              status: "ready",
              label: "Codex 用量",
              summary: "已使用：39.96 剩余：35.04 USD 到期：2026-09-18T09:46:05",
              detail: "浏览器预览数据",
              refreshedAt: nowIso(),
              hasCredential: true,
              balances: [],
              used: "39.96",
              remaining: "35.04",
              total: "75.00",
              unit: "USD",
              expiresAt: "2026-09-18T09:46:05",
            },
      );
      setRuntimeUsageLoading(false);
      return;
    }

    try {
      const status = await api.runtimeUsageStatus(runtimeId, active.projectPath ?? null);
      setRuntimeUsage(status);
    } catch (error) {
      setRuntimeUsage({
        runtimeId,
        provider: runtimeLabel(runtimeId),
        status: "error",
        label: "用量查询失败",
        summary: "无法读取用量",
        detail: String(error),
        refreshedAt: nowIso(),
        hasCredential: false,
        balances: [],
      });
    } finally {
      setRuntimeUsageLoading(false);
    }
  }, [active, activeRuntimeId]);

  useEffect(() => {
    void refreshRuntimeUsage();
  }, [refreshRuntimeUsage]);

  useEffect(() => {
    let cancelled = false;
    setSkills([]);
    setSkillsError(null);
    if (!active || !isTauri()) {
      setSkillsLoading(false);
      return;
    }
    setSkillsLoading(true);
    void api
      .skillsList(activeRuntimeId, active.projectPath ?? null)
      .then((result) => {
        if (cancelled) return;
        setSkills(result.skills ?? []);
      })
      .catch((error) => {
        if (cancelled) return;
        setSkillsError(String(error));
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.projectPath, activeRuntimeId]);

  useEffect(() => {
    setSelectedSkillNames((prev) =>
      prev.filter((name) => Boolean(findSkillByName(skills, name))),
    );
  }, [skills]);

  const activeSessionModelValue = useMemo(
    () =>
      active?.runtimeId === "codex"
        ? normalizeCodexModelId(active?.modelId ?? snapshot.modelId ?? "")
        : active?.modelId ?? snapshot.modelId ?? "",
    [active?.modelId, active?.runtimeId, snapshot.modelId],
  );
  const messages = activeId ? (messagesBySession[activeId] ?? []) : [];
  const visibleMessageCount = activeId
    ? (visibleMessageCounts[activeId] ?? INITIAL_VISIBLE_MESSAGES)
    : INITIAL_VISIBLE_MESSAGES;
  const visibleMessages =
    messages.length > visibleMessageCount
      ? messages.slice(messages.length - visibleMessageCount)
      : messages;
  const visibleMessageGroups = useMemo(() => {
    const groups: Array<{ message: ChatMessage; toolMessages: ChatMessage[] }> = [];
    for (const message of visibleMessages) {
      groups.push({ message, toolMessages: [] });
    }
    return groups;
  }, [visibleMessages]);
  const hiddenMessageCount = Math.max(0, messages.length - visibleMessages.length);
  const lastMessage = messages[messages.length - 1];
  const isActiveTurnStreaming = Boolean(
    messages.some(
      (message) =>
        message.role === "assistant" &&
        (message.streaming || message.pending),
    ) ||
      snapshot.state === "streaming" ||
      snapshot.state === "awaiting_permission",
  );
  const activeRuntimeCapabilities = runtimeInfo(activeRuntimeId)?.capabilities;
  const activeCodexModelFallback =
    active?.runtimeId === "codex"
      ? normalizeCodexModelId(
          codexRoute?.model ?? codexRoute?.latestForwardModel ?? null,
        ) || null
      : null;
  const activeModelValue =
    active?.runtimeId === "codex"
      ? activeSessionModelValue || activeCodexModelFallback || "default"
      : activeSessionModelValue;
  const activeModelReasoningEffort = activeRuntimeCapabilities?.reasoningEffort
    ? active?.modelReasoningEffort ??
      snapshot.modelReasoningEffort ??
      (active?.runtimeId === "codex" ? codexRoute?.modelReasoningEffort : null) ??
      (active?.runtimeId === "codex"
        ? codexReasoningEffortFromModel(active?.modelId ?? snapshot.modelId)
        : null) ??
      defaultReasoningEffortForRuntime(active?.runtimeId ?? snapshot.runtimeId) ??
      null
    : null;
  const activePermissionMode =
    active?.permissionMode ??
    snapshot.permissionMode ??
    defaultPermissionMode(active?.runtimeId ?? snapshot.runtimeId);
  const activeControlCatalog =
    controlCatalog?.runtimeId === activeRuntimeId ? controlCatalog : null;
  const controlModelOptions = useMemo(
    () =>
      activeControlCatalog?.modelOptions.length
        ? activeControlCatalog.modelOptions
        : fallbackModelOptions(activeRuntimeId, activeModelValue),
    [activeRuntimeId, activeModelValue, activeControlCatalog],
  );
  const activeModelLabel = active
    ? (controlModelOptions.find((option) => option.value === activeModelValue)?.label ??
        (activeModelValue || "default"))
    : "default";
  const controlReasoningOptions = useMemo(
    () => reasoningOptionsForRuntime(activeRuntimeId),
    [activeRuntimeId],
  );
  const controlPermissionOptions = useMemo(
    () =>
      activeControlCatalog?.permissionOptions.length
        ? activeControlCatalog.permissionOptions
        : fallbackPermissionOptions(activeRuntimeId),
    [activeRuntimeId, activeControlCatalog],
  );
  const settingsChangeDisabled =
    !active || active.archived || settingsBusy || !canChangeSessionSettings(snapshot.state);
  const projectPathEditable = Boolean(
    active && pendingSession?.id === active.id && messages.length === 0 && !active.archived,
  );
  const runtimePickOptions = useMemo(
    () =>
      (runtimes.length > 0 ? allRuntimes() : []).map((r) => ({
        id: r.id,
        label: r.displayName,
        hint: r.enabled
          ? r.capabilities.protocol
          : `未启用 · ${r.notes ?? r.capabilities.protocol}`,
        disabled: !r.enabled,
      })),
    [runtimes],
  );
  const runtimeVisibleSessions = useMemo(() => {
    const scoped = sessions.filter(
      (session) =>
        session.runtimeId === runtimePick && session.archived === showArchived,
    );
    const q = sessionFilter.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter(
      (session) =>
        sessionDisplayTitle(session).toLowerCase().includes(q) ||
        (sessionDisplaySummary(session) ?? "").toLowerCase().includes(q) ||
        session.runtimeId.includes(q) ||
        (session.modelId ?? "").toLowerCase().includes(q) ||
        (session.nativeSessionId ?? "").toLowerCase().includes(q) ||
        (session.nativeThreadId ?? "").toLowerCase().includes(q),
    );
  }, [runtimePick, sessionFilter, sessions, showArchived]);
  const activeSupportsReasoningEffort =
    activeRuntimeCapabilities?.reasoningEffort ?? false;
  const activeGoalModeAvailable = active?.runtimeId === "codex";
  const activeGoalMode =
    Boolean(active && goalModeBySession[active.id]) && activeGoalModeAvailable;
  const activePermissionQueue = activeId
    ? (permissionQueue[activeId] ?? [])
    : [];
  // One card at a time: overlapping approvals are answered in arrival order so
  // the user is never asked to reason about which request a button belongs to.
  const activePermissionRequest = activePermissionQueue[0] ?? null;
  const pendingPermissionCount = activePermissionQueue.length;
  const permissionActionsDisabled =
    permissionBusy !== null &&
    permissionBusy === activePermissionRequest?.requestId;
  const activeIdRef = useRef<string | null>(null);
  const activationRequestRef = useRef(0);
  const mockReplyTimerRef = useRef<number | null>(null);
  const sessionScrollRef = useRef<HTMLDivElement | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionContextMenuRef = useRef<HTMLDivElement | null>(null);
  const projectContextMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionSelectionAnchorRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const autoFollowStreamRef = useRef(true);
  const lastMessageScrollTopRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const pendingHistoryRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const messageNavigationLockUntilRef = useRef(0);
  const assistantTypingTimersRef = useRef<Record<string, number>>({});
  const assistantTypingQueueRef = useRef<Record<string, string>>({});
  const assistantTypingSessionRef = useRef<Record<string, string>>({});
  const imageAttachmentsRef = useRef<ComposerImageAttachment[]>([]);
  const sessionUnreadRef = useRef<Record<string, SessionUnreadKind>>({});
  const notifiedSessionResultRef = useRef<Record<string, SessionUnreadKind>>({});
  const turnWorktreeBaselineRef = useRef<
    Record<string, WorktreeChangeSnapshot | null>
  >({});

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  const clearImageAttachments = useCallback(() => {
    for (const image of imageAttachmentsRef.current) {
      URL.revokeObjectURL(image.previewUrl);
    }
    imageAttachmentsRef.current = [];
    setImageAttachments([]);
  }, []);

  useEffect(
    () => () => {
      for (const image of imageAttachmentsRef.current) {
        URL.revokeObjectURL(image.previewUrl);
      }
      imageAttachmentsRef.current = [];
    },
    [],
  );

  useEffect(() => {
    clearImageAttachments();
    setFileAttachments([]);
  }, [active?.id, clearImageAttachments]);

  const beginSessionActivation = useCallback((sessionId: string | null) => {
    const requestId = activationRequestRef.current + 1;
    activationRequestRef.current = requestId;
    activeIdRef.current = sessionId;
    setActiveId(sessionId);
    if (sessionId) {
      if (sessionId in sessionUnreadRef.current) {
        const next = { ...sessionUnreadRef.current };
        delete next[sessionId];
        sessionUnreadRef.current = next;
        setSessionUnread(next);
      }
    }
    return requestId;
  }, []);

  const isCurrentSessionActivation = useCallback(
    (sessionId: string, requestId: number) =>
      activeIdRef.current === sessionId &&
      activationRequestRef.current === requestId,
    [],
  );

  useEffect(() => {
    if (!active) {
      setControlCatalog(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        if (!isTauri()) {
          setControlCatalog({
            runtimeId: active.runtimeId,
            modelOptions: fallbackModelOptions(active.runtimeId, activeModelValue),
            permissionOptions: fallbackPermissionOptions(active.runtimeId),
          });
          return;
        }

        const catalog = await api.getSessionControlOptions(active.id);
        if (!cancelled) {
          setControlCatalog(catalog);
        }
      } catch (e) {
        if (!cancelled) {
          setStatusLine(String(e));
          setControlCatalog({
            runtimeId: active.runtimeId,
            modelOptions: fallbackModelOptions(active.runtimeId, activeModelValue),
            permissionOptions: fallbackPermissionOptions(active.runtimeId),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.projectPath, active?.runtimeId, activeModelValue]);

  useEffect(() => {
    return () => {
      if (mockReplyTimerRef.current !== null) {
        window.clearTimeout(mockReplyTimerRef.current);
      }
    };
  }, []);

  const updateSessionMessages = useCallback(
    (sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      setMessagesBySession((prev) => {
        const current = prev[sessionId] ?? [];
        const next = updater(current);
        const addedCount = Math.max(0, next.length - current.length);

        if (
          addedCount > 0 &&
          activeIdRef.current === sessionId &&
          stickToBottomRef.current
        ) {
          setVisibleMessageCounts((counts) => {
            const currentVisible = counts[sessionId] ?? INITIAL_VISIBLE_MESSAGES;
            const nextVisible = Math.min(next.length, currentVisible + addedCount);
            if (nextVisible === currentVisible) return counts;
            return {
              ...counts,
              [sessionId]: nextVisible,
            };
          });
        }

        if (next === current) return prev;
        return {
          ...prev,
          [sessionId]: next,
        };
      });
    },
    [],
  );

  const applySettledSessionMeta = useCallback((meta: SessionMeta) => {
    setSessions((prev) => mergeSessions(prev, [meta]));
    setPendingSession((prev) => (prev?.id === meta.id ? null : prev));
  }, []);

  const applySessionSnapshot = useCallback((next: SessionSnapshot) => {
    const sessionId = next.sessionId;
    if (!sessionId) return;
    if (next.state === "streaming") {
      delete notifiedSessionResultRef.current[sessionId];
    }
    setSessionSnapshots((prev) => ({ ...prev, [sessionId]: next }));
    if (activeIdRef.current === sessionId) {
      setSnapshot(next);
    }
  }, []);

  const markSessionResult = useCallback(
    (sessionId: string, kind: SessionUnreadKind, meta?: SessionMeta) => {
      const isBackgroundSession = activeIdRef.current !== sessionId;
      setSessionTurnBusy((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      const isWindowBackground =
        !document.hasFocus() || document.visibilityState !== "visible";
      if (isBackgroundSession && sessionUnreadRef.current[sessionId] !== kind) {
        const next = { ...sessionUnreadRef.current, [sessionId]: kind };
        sessionUnreadRef.current = next;
        setSessionUnread(next);
      }
      if (!isBackgroundSession && !isWindowBackground) return;
      if (notifiedSessionResultRef.current[sessionId] === kind) return;
      notifiedSessionResultRef.current = {
        ...notifiedSessionResultRef.current,
        [sessionId]: kind,
      };

      const session = meta ?? sessions.find((item) => item.id === sessionId);
      const title = session ? sessionDisplayTitle(session) : "后台会话";
      const completed = kind === "completed";
      const message = completed ? `${title} 已完成` : `${title} 发生异常`;
      emitToast({
        message,
        tone: completed ? "success" : "danger",
        duration: 5000,
      });
      void notifySessionResult(message, kind, isWindowBackground);
    },
    [sessions],
  );

  const applyTurnWorktreeChanges = useCallback(
    (event: TurnSettledEvent) => {
      const baseline = turnWorktreeBaselineRef.current[event.sessionId];
      delete turnWorktreeBaselineRef.current[event.sessionId];
      const projectPath = event.meta.projectPath?.trim();
      if (!baseline || !projectPath || !isTauri()) return;

      void api
        .projectWorktreeChanges(projectPath)
        .then((current) => {
          const changes = diffWorktreeSnapshots(baseline, current);
          if (changes.length === 0) return;
          updateSessionMessages(event.sessionId, (items) => {
            for (let index = items.length - 1; index >= 0; index -= 1) {
              if (items[index].role !== "assistant") continue;
              const next = items.slice();
              next[index] = insertOrUpdateWorktreeChangeBlock(
                items[index],
                uid("chg"),
                changes,
              );
              return next;
            }
            return items;
          });
        })
        .catch(() => {
          // Diff stats are supplementary UI; failed git probes should not
          // change the completed transcript.
        });
    },
    [updateSessionMessages],
  );

  useEffect(() => {
    if (!snapshot.sessionId) return;
    setSessionSnapshots((prev) => ({
      ...prev,
      [snapshot.sessionId as string]: snapshot,
    }));
  }, [snapshot]);

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroll = () => {
      const el = messageScrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom <= CHAT_BOTTOM_THRESHOLD) {
        stickToBottomRef.current = true;
        lastMessageScrollTopRef.current = el.scrollTop;
      }
    };
    window.requestAnimationFrame(() => {
      scroll();
      window.requestAnimationFrame(scroll);
    });
  }, []);

  const resetChatViewport = useCallback(
    (sessionId: string, totalMessages: number) => {
      setVisibleMessageCounts((prev) => ({
        ...prev,
        [sessionId]:
          totalMessages > 0
            ? Math.min(totalMessages, INITIAL_VISIBLE_MESSAGES)
            : INITIAL_VISIBLE_MESSAGES,
      }));
      stickToBottomRef.current = true;
      autoFollowStreamRef.current = true;
      userScrolledUpRef.current = false;
      lastMessageScrollTopRef.current = 0;
      scrollChatToBottom();
    },
    [scrollChatToBottom],
  );

  const revealOlderMessages = useCallback(() => {
    if (!activeId || hiddenMessageCount <= 0) return;
    const el = messageScrollRef.current;
    if (el) {
      pendingHistoryRestoreRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
    }
    setVisibleMessageCounts((prev) => {
      const current = prev[activeId] ?? INITIAL_VISIBLE_MESSAGES;
      return {
        ...prev,
        [activeId]: Math.min(messages.length, current + HISTORY_BATCH_SIZE),
      };
    });
  }, [activeId, hiddenMessageCount, messages.length]);

  const revealMessageForNavigation = useCallback(
    (messageIndex: number) => {
      if (!activeId || messageIndex < 0 || messageIndex >= messages.length) return;
      messageNavigationLockUntilRef.current = performance.now() + 1400;
      pendingHistoryRestoreRef.current = null;
      stickToBottomRef.current = false;
      autoFollowStreamRef.current = false;
      const requiredCount = messages.length - messageIndex;
      setVisibleMessageCounts((previous) => ({
        ...previous,
        [activeId]: Math.max(
          previous[activeId] ?? INITIAL_VISIBLE_MESSAGES,
          requiredCount,
        ),
      }));
    },
    [activeId, messages.length],
  );

  const handleMessageScroll = useCallback(() => {
    const el = messageScrollRef.current;
    if (!el) return;
    const previousScrollTop = lastMessageScrollTopRef.current;
    const movingUp = el.scrollTop < previousScrollTop - 2;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= CHAT_BOTTOM_THRESHOLD;
    lastMessageScrollTopRef.current = el.scrollTop;
    if (stickToBottomRef.current) {
      autoFollowStreamRef.current = true;
      userScrolledUpRef.current = false;
    } else if (movingUp) {
      autoFollowStreamRef.current = false;
      userScrolledUpRef.current = true;
    }
    if (
      performance.now() >= messageNavigationLockUntilRef.current &&
      !isActiveTurnStreaming &&
      userScrolledUpRef.current &&
      el.scrollTop <= CHAT_TOP_THRESHOLD &&
      hiddenMessageCount > 0
    ) {
      userScrolledUpRef.current = false;
      revealOlderMessages();
    }
  }, [hiddenMessageCount, isActiveTurnStreaming, revealOlderMessages]);

  const handleTypingProgress = useCallback(() => {
    if (!stickToBottomRef.current && !autoFollowStreamRef.current) return;
    scrollChatToBottom();
  }, [scrollChatToBottom]);

  const handleComposerInputFocus = useCallback(() => {
    const el = messageScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= CHAT_BOTTOM_THRESHOLD) return;
    pendingHistoryRestoreRef.current = null;
    stickToBottomRef.current = true;
    autoFollowStreamRef.current = true;
    userScrolledUpRef.current = false;
    scrollChatToBottom("smooth");
  }, [scrollChatToBottom]);

  const markAssistantTyping = useCallback((messageId: string, content: string) => {
    const length = Array.from(content).length;
    const duration = Math.max(900, Math.min(3200, 240 + length * 22));
    const until = Date.now() + duration;
    setAssistantTypingUntil((prev) => ({ ...prev, [messageId]: until }));
    const existing = assistantTypingTimersRef.current[messageId];
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    assistantTypingTimersRef.current[messageId] = window.setTimeout(() => {
      setAssistantTypingUntil((prev) => {
        if (!(messageId in prev)) return prev;
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      delete assistantTypingTimersRef.current[messageId];
      delete assistantTypingSessionRef.current[messageId];
      if (Object.keys(assistantTypingTimersRef.current).length === 0) {
        autoFollowStreamRef.current = false;
      }
    }, duration);
  }, []);

  const queueAssistantTyping = useCallback(
    (sessionId: string, messageId: string, content: string) => {
      assistantTypingSessionRef.current[messageId] = sessionId;
      assistantTypingQueueRef.current[messageId] = content;
    },
    [],
  );

  const clearAssistantTypingForSession = useCallback((sessionId: string) => {
    const messageIds = Object.entries(assistantTypingSessionRef.current)
      .filter(([, ownerSessionId]) => ownerSessionId === sessionId)
      .map(([messageId]) => messageId);
    if (messageIds.length === 0) return;

    for (const messageId of messageIds) {
      const timer = assistantTypingTimersRef.current[messageId];
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      delete assistantTypingTimersRef.current[messageId];
      delete assistantTypingQueueRef.current[messageId];
      delete assistantTypingSessionRef.current[messageId];
    }

    setAssistantTypingUntil((prev) => {
      const next = { ...prev };
      for (const messageId of messageIds) {
        delete next[messageId];
      }
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(assistantTypingTimersRef.current)) {
        window.clearTimeout(timer);
      }
      assistantTypingTimersRef.current = {};
      assistantTypingQueueRef.current = {};
      assistantTypingSessionRef.current = {};
    };
  }, []);

  useEffect(() => {
    const queue = assistantTypingQueueRef.current;
    const entries = Object.entries(queue);
    if (entries.length === 0) return;
    assistantTypingQueueRef.current = {};
    for (const [messageId, content] of entries) {
      markAssistantTyping(messageId, content);
    }
  }, [messagesBySession, markAssistantTyping]);

  useEffect(() => {
    const pending = pendingHistoryRestoreRef.current;
    if (!pending) return;
    pendingHistoryRestoreRef.current = null;
    window.requestAnimationFrame(() => {
      const el = messageScrollRef.current;
      if (!el) return;
      const delta = el.scrollHeight - pending.scrollHeight;
      el.scrollTop = pending.scrollTop + delta;
      lastMessageScrollTopRef.current = el.scrollTop;
    });
  }, [visibleMessages.length]);

  useEffect(() => {
    if (!activeId || pendingHistoryRestoreRef.current) return;
    if (stickToBottomRef.current || autoFollowStreamRef.current) {
      scrollChatToBottom();
    }
  }, [
    activeId,
    assistantTypingUntil,
    lastMessage?.content,
    lastMessage?.id,
    lastMessage?.streaming,
    scrollChatToBottom,
    visibleMessages.length,
  ]);

  // Host → UI event fold. The listeners live in the hook; everything they need
  // is passed in, so App owns the state and the hook owns the protocol.
  useSessionEvents({
    activeSessionIdRef: activeIdRef,
    updateSessionMessages,
    setSnapshot,
    applySessionSnapshot,
    setPermissionQueue,
    setPermissionBusy,
    queueAssistantTyping,
    clearAssistantTypingForSession,
    applySettledSessionMeta,
    onTurnSettled: applyTurnWorktreeChanges,
    markSessionResult,
  });

  const refreshRuntimes = useCallback(async () => {
    if (!isTauri()) {
      setRuntimes(hydrateRuntimes(mockRuntimes()));
      return;
    }
    try {
      setRuntimes(hydrateRuntimes(await api.listRuntimes()));
    } catch (e) {
      setStatusLine(`list runtimes failed: ${String(e)}`);
    }
  }, []);

  const refreshProbes = useCallback(async () => {
    if (!isTauri()) {
      setProbes([
        {
          runtimeId: "claude",
          found: true,
          path: "D:\\Nvm\\node\\node_global\\claude.cmd",
          version: "1.0.64",
          detail: "browser mock",
        },
        {
          runtimeId: "codex",
          found: true,
          path: "D:\\codex\\codex.exe",
          version: "0.144.4",
          detail: "browser mock",
        },
        {
          runtimeId: "kimi",
          found: false,
          path: null,
          version: null,
          detail: "browser mock · CLI not found",
        },
        {
          runtimeId: "grok",
          found: true,
          path: "D:\\tools\\grok\\bin\\grok.exe",
          version: "0.2.111",
          detail: "browser mock",
        },
      ]);
      return;
    }
    try {
      const list = await api.probeAll();
      setProbes(list);
    } catch (e) {
      setStatusLine(`probe failed: ${String(e)}`);
    }
  }, []);

  const refreshCodexRoute = useCallback(async () => {
    if (!isTauri()) {
      setCodexRoute({
        routeKind: "cc-switch",
        ccSwitchDetected: true,
        modelProvider: "custom",
        model: "gpt-5.5",
        baseUrl: "http://127.0.0.1:15721/v1",
        wireApi: "responses",
        latestForwardUrl: "https://api.999555999.com/v1/responses",
        latestForwardModel: "gpt-5.5",
        latestError: null,
        note: "Codex CLI 当前配置指向 cc-switch 本地代理；Workbench 连接的是 Codex app-server，模型出口由 Codex CLI 配置决定。",
      });
      return;
    }
    try {
      setCodexRoute(await api.codexRouteStatus());
    } catch (e) {
      setStatusLine(`codex route probe failed: ${String(e)}`);
    }
  }, []);

  const refreshClaudeRoute = useCallback(async () => {
    if (!isTauri()) {
      setClaudeRoute({
        baseUrl: "https://api.deepseek.com/anthropic",
        model: "deepseek-v4-pro[1m]",
        outputLimit: "32000",
        routeKind: "direct-deepseek",
        note: "Claude Code 当前配置直连 DeepSeek 的 Anthropic 兼容入口；Workbench 连接的是 Claude CLI，模型出口由本机 Claude 配置决定。",
      });
      return;
    }
    try {
      setClaudeRoute(await api.claudeRouteStatus());
    } catch (e) {
      setStatusLine(`claude route probe failed: ${String(e)}`);
    }
  }, []);

  const changeUiFontSize = useCallback((value: UiFontSize) => {
    setUiFontSize(value);
    saveUiFontSize(value);
  }, []);

  const refreshSettingsDiagnostics = useCallback(() => {
    void refreshRuntimes();
    void refreshProbes();
    void refreshCodexRoute();
    void refreshClaudeRoute();
  }, [refreshClaudeRoute, refreshCodexRoute, refreshProbes, refreshRuntimes]);

  const refreshAppSettings = useCallback(async () => {
    if (!isTauri()) {
      setAppSettings({ runtimes: {} });
      return;
    }
    try {
      setAppSettings(await api.getSettings());
    } catch (e) {
      setStatusLine(`settings load failed: ${String(e)}`);
    }
  }, []);

  const saveRuntimeCliPath = useCallback(
    async (runtimeId: RuntimeId, cliPath: string) => {
      const path = cliPath.trim().replace(/^["']|["']$/g, "");
      const current = appSettings?.runtimes[runtimeId] ?? {};
      const patch = {
        ...current,
        cliPath: path.length > 0 ? path : null,
      };

      if (!isTauri()) {
        setAppSettings((prev) => ({
          runtimes: {
            ...(prev?.runtimes ?? {}),
            [runtimeId]: patch,
          },
        }));
        setStatusLine(`${runtimeLabel(runtimeId)} CLI 路径已保存 · browser mock`);
        return;
      }

      try {
        setSettingsRuntimeBusy(runtimeId);
        const next = await api.setRuntimeOverride(runtimeId, patch);
        setAppSettings(next);
        setStatusLine(`${runtimeLabel(runtimeId)} CLI 路径已保存`);
        refreshSettingsDiagnostics();
      } catch (e) {
        setStatusLine(`save runtime path failed: ${String(e)}`);
      } finally {
        setSettingsRuntimeBusy(null);
      }
    },
    [appSettings, refreshSettingsDiagnostics],
  );

  const clearRuntimeCliPath = useCallback(
    async (runtimeId: RuntimeId) => {
      const current = appSettings?.runtimes[runtimeId] ?? {};
      const patch = {
        ...current,
        cliPath: null,
      };

      if (!isTauri()) {
        setAppSettings((prev) => ({
          runtimes: {
            ...(prev?.runtimes ?? {}),
            [runtimeId]: patch,
          },
        }));
        setStatusLine(`${runtimeLabel(runtimeId)} 自定义 CLI 路径已清除 · browser mock`);
        return;
      }

      try {
        setSettingsRuntimeBusy(runtimeId);
        const next = await api.setRuntimeOverride(runtimeId, patch);
        setAppSettings(next);
        setStatusLine(`${runtimeLabel(runtimeId)} 自定义 CLI 路径已清除`);
        refreshSettingsDiagnostics();
      } catch (e) {
        setStatusLine(`clear runtime path failed: ${String(e)}`);
      } finally {
        setSettingsRuntimeBusy(null);
      }
    },
    [appSettings, refreshSettingsDiagnostics],
  );

  const saveCodexGatewayUsage = useCallback(
    async (patch: CodexGatewayUsageConfig) => {
      if (!isTauri()) {
        setAppSettings((prev) => ({
          runtimes: prev?.runtimes ?? {},
          usage: {
            ...(prev?.usage ?? {}),
            codexGateway: patch,
          },
        }));
        setStatusLine("Codex 中转用量配置已保存 · browser mock");
        return;
      }

      try {
        setSettingsUsageBusy(true);
        const next = await api.setCodexGatewayUsage(patch);
        setAppSettings(next);
        setStatusLine("Codex 中转用量配置已保存");
        void refreshRuntimeUsage();
      } catch (e) {
        setStatusLine(`save usage config failed: ${String(e)}`);
      } finally {
        setSettingsUsageBusy(false);
      }
    },
    [refreshRuntimeUsage],
  );

  const saveDeepSeekUsage = useCallback(
    async (patch: DeepSeekUsageConfig) => {
      if (!isTauri()) {
        setAppSettings((prev) => ({
          runtimes: prev?.runtimes ?? {},
          usage: {
            ...(prev?.usage ?? {}),
            deepseek: patch,
          },
        }));
        setStatusLine("DeepSeek 用量配置已保存 · browser mock");
        return;
      }

      try {
        setSettingsUsageBusy(true);
        const next = await api.setDeepSeekUsage(patch);
        setAppSettings(next);
        setStatusLine("DeepSeek 用量配置已保存");
        void refreshRuntimeUsage();
      } catch (e) {
        setStatusLine(`save usage config failed: ${String(e)}`);
      } finally {
        setSettingsUsageBusy(false);
      }
    },
    [refreshRuntimeUsage],
  );

  const savePersonalCenterPath = useCallback(async (path: string | null) => {
    const nextPath = path?.trim().replace(/^["']|["']$/g, "") || null;
    if (!isTauri()) {
      setAppSettings((prev) => ({
        runtimes: prev?.runtimes ?? {},
        usage: prev?.usage,
        personalCenter: nextPath ? { path: nextPath } : {},
      }));
      setStatusLine("个人中心目录已保存 · browser mock");
      return;
    }

    try {
      setSettingsPersonalCenterBusy(true);
      const next = await api.setPersonalCenter(nextPath);
      setAppSettings(next);
      setStatusLine(nextPath ? "个人中心目录已保存" : "个人中心目录已清除");
    } catch (e) {
      setStatusLine(`save personal center failed: ${String(e)}`);
    } finally {
      setSettingsPersonalCenterBusy(false);
    }
  }, []);

  const pickPersonalCenterPath = useCallback(async () => {
    if (!isTauri()) {
      setStatusLine("目录选择仅在桌面模式可用");
      return;
    }
    try {
      const selected = await api.pickProjectDirectory(
        appSettings?.personalCenter?.path ?? null,
      );
      if (!selected) return;
      await savePersonalCenterPath(selected);
    } catch (e) {
      setStatusLine(`pick personal center failed: ${String(e)}`);
    }
  }, [appSettings?.personalCenter?.path, savePersonalCenterPath]);

  const loadSessions = useCallback(async () => {
    if (!isTauri()) {
      const list = mockSessions();
      setPendingSession(null);
      setSessions(list);
      beginSessionActivation(list[0]?.id ?? null);
      setSnapshot(idleSnapshot(list[0]));
      if (list[0]) {
        setMessagesBySession({
          [list[0].id]: [
            {
              id: uid("sys"),
              role: "system",
              content:
                "Workbench 骨架已就绪。当前为浏览器预览；`pnpm dev`（Tauri）后走真实 Host 命令。P0 引擎：Grok + Codex。",
            },
          ],
        });
      }
      setStatusLine("UI preview · mock sessions");
      return;
    }

    try {
      const info = await api.appInfo();
      setAppDataDir(info.dataDir);
      setStatusLine(`${info.name} ${info.version} · ${info.dataDir}`);
      const list = await api.listSessions();
      setPendingSession(null);
      setSessions(list);
      const snapshots = await api.listSnapshots();
      const snapshotMap = Object.fromEntries(
        snapshots.flatMap((item) => (item.sessionId ? [[item.sessionId, item]] : [])),
      );
      setSessionSnapshots(snapshotMap);
      const first = list.find((session) => !session.archived);
      if (first) {
        const requestId = beginSessionActivation(first.id);
        const storedMessages = await api.getMessages(first.id);
        if (!isCurrentSessionActivation(first.id, requestId)) return;
        const snap = snapshotMap[first.id] ?? idleSnapshot(first);
        const restored = normalizeLoadedMessages(storedMessages, snap);
        setSnapshot(snap);
        setMessagesBySession((prev) => ({
          ...prev,
          [first.id]: restored,
        }));
        resetChatViewport(first.id, restored.length);
      } else {
        beginSessionActivation(null);
        setSnapshot(idleSnapshot());
      }
    } catch (e) {
      setStatusLine(`host error: ${String(e)}`);
    }
  }, [beginSessionActivation, isCurrentSessionActivation, resetChatViewport]);

  useEffect(() => {
    // Runtimes first: labels, default modes and the engine picker all read the
    // registry, and sessions render as raw ids until it has landed.
    void refreshRuntimes().then(() => {
      void loadSessions();
    });
    void refreshProbes();
    void refreshCodexRoute();
    void refreshClaudeRoute();
    void refreshAppSettings();
  }, [
    loadSessions,
    refreshAppSettings,
    refreshClaudeRoute,
    refreshProbes,
    refreshCodexRoute,
    refreshRuntimes,
  ]);

  const copyAboutLink = useCallback(async (label: string, value: string) => {
    try {
      await copyTextToClipboard(value);
      setStatusLine(`已复制${label} · ${value}`);
      emitToast({ message: `已复制${label}`, tone: "success" });
    } catch (error) {
      setStatusLine(`复制${label}失败：${String(error)}`);
      emitToast({ message: `复制${label}失败`, tone: "danger" });
    }
  }, []);

  // A stored engine pick can point at a runtime that was since disabled or
  // removed from the manifests; fall back to the first enabled one.
  useEffect(() => {
    if (runtimes.length === 0) return;
    const usable = runtimes.filter((r) => r.enabled);
    if (usable.length === 0) return;
    if (usable.some((r) => r.id === runtimePick)) return;
    setRuntimePick(usable[0].id);
  }, [runtimes, runtimePick]);

  const activateSession = useCallback(
    async (id: string, metaOverride?: SessionMeta | null) => {
      setPendingSession(null);
      const requestId = beginSessionActivation(id);
      setQuoteTarget(null);
      const meta = metaOverride ?? sessions.find((s) => s.id === id) ?? null;
      if (!isTauri()) {
        setSnapshot(idleSnapshot(meta));
        resetChatViewport(id, messagesBySession[id]?.length ?? 0);
        return;
      }
      try {
        const cachedMessages = messagesBySession[id];
        const [snap, storedMessages] = await Promise.all([
          api.getSnapshot(id),
          cachedMessages === undefined
            ? api.getMessages(id)
            : Promise.resolve<ChatMessage[] | null>(null),
        ]);
        if (!isCurrentSessionActivation(id, requestId)) return;
        const restored = restoreSessionMessages(
          cachedMessages,
          storedMessages ?? [],
          snap,
        );
        setSnapshot(snap);
        setMessagesBySession((prev) => {
          const current = prev[id];
          if (current !== undefined) {
            return {
              ...prev,
              [id]: restoreSessionMessages(current, [], snap),
            };
          }
          return storedMessages === null ? prev : { ...prev, [id]: restored };
        });
        resetChatViewport(id, restored.length);
      } catch (e) {
        if (isCurrentSessionActivation(id, requestId)) {
          setStatusLine(String(e));
        }
      }
    },
    [
      beginSessionActivation,
      isCurrentSessionActivation,
      messagesBySession,
      resetChatViewport,
      sessions,
    ],
  );

  function selectSession(
    id: string,
    options?: { shiftKey: boolean; visibleSessionIds: string[] },
  ) {
    const visibleIds = options?.visibleSessionIds ?? [];
    if (options?.shiftKey && visibleIds.length > 0) {
      const anchorId = sessionSelectionAnchorRef.current ?? activeId ?? id;
      const anchorIndex = visibleIds.indexOf(anchorId);
      const targetIndex = visibleIds.indexOf(id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [from, to] =
          anchorIndex <= targetIndex
            ? [anchorIndex, targetIndex]
            : [targetIndex, anchorIndex];
        setSelectedSessionIds(visibleIds.slice(from, to + 1));
      } else {
        setSelectedSessionIds([id]);
      }
    } else {
      sessionSelectionAnchorRef.current = id;
      setSelectedSessionIds([]);
    }
    void activateSession(id);
  }

  useEffect(() => {
    if (active?.runtimeId === runtimePick) return;

    setQuoteTarget(null);
    setDraft("");
    setPendingSession(null);

    const nextSession = runtimeVisibleSessions[0] ?? null;
    if (nextSession) {
      void activateSession(nextSession.id, nextSession);
      return;
    }

    beginSessionActivation(null);
    setSnapshot(idleSnapshot());
  }, [
    activateSession,
    active?.runtimeId,
    beginSessionActivation,
    runtimePick,
    runtimeVisibleSessions,
  ]);

  const applySessionPresentationMeta = useCallback((meta: SessionMeta) => {
    setSessions((prev) => mergeSessions(prev, [meta]));
    setPendingSession((prev) => (prev?.id === meta.id ? meta : prev));
    if (activeIdRef.current === meta.id) {
      setSnapshot((prev) => ({ ...prev, title: meta.title }));
    }
  }, []);

  const openSelectedSessionLocation = useCallback(async (sessionId: string) => {
    setSessionContextMenu(null);
    if (!isTauri()) {
      setStatusLine("UI preview · open location unavailable");
      return;
    }
    try {
      const path = await api.openSessionLocation(sessionId);
      setStatusLine(`opened location · ${path}`);
    } catch (e) {
      setStatusLine(`open location failed: ${String(e)}`);
    }
  }, []);

  const toggleSessionPinned = useCallback(
    async (sessionId: string, pinned: boolean) => {
      setSessionContextMenu(null);
      const target =
        sessions.find((session) => session.id === sessionId) ??
        (pendingSession?.id === sessionId ? pendingSession : null);
      if (!target) return;

      try {
        const nextMeta = isTauri()
          ? await api.updateSessionPresentation(sessionId, { pinned })
          : { ...target, pinned };
        applySessionPresentationMeta(nextMeta);
        setStatusLine(`${pinned ? "已置顶" : "已取消置顶"} · ${sessionDisplayTitle(nextMeta)}`);
      } catch (error) {
        setStatusLine(`更新置顶状态失败: ${String(error)}`);
      }
    },
    [applySessionPresentationMeta, pendingSession, sessions],
  );

  const requestRenameSession = useCallback(
    (sessionId: string) => {
      const target =
        sessions.find((session) => session.id === sessionId) ??
        (pendingSession?.id === sessionId ? pendingSession : null);
      if (!target) return;
      setSessionContextMenu(null);
      setRenameSessionId(sessionId);
      setRenameSessionTitle(sessionDisplayTitle(target));
      setRenameSessionError(null);
    },
    [pendingSession, sessions],
  );

  const closeRenameSession = useCallback(() => {
    if (renameSessionBusy) return;
    setRenameSessionId(null);
    setRenameSessionTitle("");
    setRenameSessionError(null);
  }, [renameSessionBusy]);

  const confirmRenameSession = useCallback(async () => {
    if (!renameSessionId || renameSessionBusy) return;
    const title = renameSessionTitle.trim();
    if (!title) {
      setRenameSessionError("会话名称不能为空");
      return;
    }
    if (Array.from(title).length > 120) {
      setRenameSessionError("会话名称不能超过 120 个字符");
      return;
    }

    const target =
      sessions.find((session) => session.id === renameSessionId) ??
      (pendingSession?.id === renameSessionId ? pendingSession : null);
    if (!target) {
      setRenameSessionError("会话不存在或已被删除");
      return;
    }

    setRenameSessionBusy(true);
    setRenameSessionError(null);
    try {
      const nextMeta = isTauri()
        ? await api.updateSessionPresentation(renameSessionId, { title })
        : { ...target, title };
      applySessionPresentationMeta(nextMeta);
      setRenameSessionId(null);
      setRenameSessionTitle("");
      setStatusLine(`已重命名会话 · ${title}`);
    } catch (error) {
      setRenameSessionError(`重命名失败: ${String(error)}`);
    } finally {
      setRenameSessionBusy(false);
    }
  }, [
    applySessionPresentationMeta,
    pendingSession,
    renameSessionBusy,
    renameSessionId,
    renameSessionTitle,
    sessions,
  ]);

  const copySessionId = useCallback(async (sessionId: string) => {
    setSessionContextMenu(null);
    try {
      await copyTextToClipboard(sessionId);
      setStatusLine(`已复制会话 ID · ${sessionId}`);
    } catch (error) {
      setStatusLine(`复制会话 ID 失败: ${String(error)}`);
    }
  }, []);

  const exportSessionMarkdown = useCallback(async (sessionId: string) => {
    setSessionContextMenu(null);
    if (!isTauri()) {
      setStatusLine("UI preview · Markdown export unavailable");
      return;
    }
    try {
      const result = await api.exportSessionMarkdown(sessionId);
      emitToast({ message: `已导出 ${result.messageCount} 条消息`, tone: "success" });
      setStatusLine(`已导出 Markdown · ${result.path}`);
    } catch (error) {
      emitToast({ message: "Markdown 导出失败", tone: "danger" });
      setStatusLine(`Markdown 导出失败: ${String(error)}`);
    }
  }, []);

  const exportSessionTrace = useCallback(async (sessionId: string) => {
    setSessionContextMenu(null);
    if (!isTauri()) {
      setStatusLine("UI preview · trace export unavailable");
      return;
    }
    try {
      const result = await api.exportSessionTrace(sessionId);
      emitToast({ message: `已导出 ${result.eventCount} 条 trace 事件`, tone: "success" });
      setStatusLine(`已导出 trace · ${result.path}`);
    } catch (error) {
      const errorText = String(error);
      const traceEmpty = errorText.includes("session has no trace events");
      emitToast({
        message: traceEmpty ? "该会话暂无可导出的 trace" : "trace 导出失败",
        tone: traceEmpty ? "neutral" : "danger",
      });
      setStatusLine(
        traceEmpty ? "该会话暂无可导出的 trace" : `trace 导出失败: ${errorText}`,
      );
    }
  }, []);

  const toggleSessionArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      setSessionContextMenu(null);
      const target =
        sessions.find((session) => session.id === sessionId) ??
        (pendingSession?.id === sessionId ? pendingSession : null);
      if (!target) return;

      try {
        const nextMeta = isTauri()
          ? await api.setSessionArchived(sessionId, archived)
          : { ...target, archived };
        applySessionPresentationMeta(nextMeta);
        setSelectedSessionIds([]);

        if (archived) {
          if (activeIdRef.current === sessionId) {
            setDraft("");
            setQuoteTarget(null);
            const nextSession = mergeSessions(sessions, [nextMeta]).find(
              (session) =>
                session.runtimeId === runtimePick && !session.archived,
            );
            if (nextSession) {
              await activateSession(nextSession.id, nextSession);
            } else {
              beginSessionActivation(null);
              setSnapshot(idleSnapshot());
            }
          }
          setStatusLine(`已归档 · ${sessionDisplayTitle(nextMeta)}`);
          return;
        }

        setShowArchived(false);
        setSessionFilter("");
        await activateSession(nextMeta.id, nextMeta);
        setStatusLine(`已恢复 · ${sessionDisplayTitle(nextMeta)}`);
      } catch (error) {
        const action = archived ? "归档" : "恢复";
        emitToast({ message: `${action}会话失败`, tone: "danger" });
        setStatusLine(`${action}会话失败: ${String(error)}`);
      }
    },
    [
      activateSession,
      applySessionPresentationMeta,
      beginSessionActivation,
      pendingSession,
      runtimePick,
      sessions,
    ],
  );

  const changeArchivedView = useCallback(
    (nextShowArchived: boolean) => {
      setShowArchived(nextShowArchived);
      setSessionFilter("");
      setSelectedSessionIds([]);
      setDraft("");
      setQuoteTarget(null);
      const nextSession = sessions.find(
        (session) =>
          session.runtimeId === runtimePick &&
          session.archived === nextShowArchived,
      );
      if (nextSession) {
        void activateSession(nextSession.id, nextSession);
      } else {
        beginSessionActivation(null);
        setSnapshot(idleSnapshot());
      }
    },
    [activateSession, beginSessionActivation, runtimePick, sessions],
  );

  const reorderProject = useCallback(
    (sourceKey: string, targetKey: string, visibleProjectKeys: string[]) => {
      if (sourceKey === targetKey) return;
      setProjectOrder((prev) => {
        const visible = visibleProjectKeys.filter(Boolean);
        const nextVisible = visible.filter((key) => key !== sourceKey);
        const targetIndex = nextVisible.indexOf(targetKey);
        if (targetIndex < 0) return prev;
        nextVisible.splice(targetIndex, 0, sourceKey);
        const hidden = prev.filter(
          (key) => !visible.includes(key) && !nextVisible.includes(key),
        );
        return [...nextVisible, ...hidden];
      });
      setStatusLine("已调整目录排序");
    },
    [],
  );

  const toggleProjectPinned = useCallback(
    (projectKey: string, pinned: boolean, label: string) => {
      setProjectContextMenu(null);
      setPinnedProjectKeys((prev) => {
        const next = prev.filter((key) => key !== projectKey);
        return pinned ? [projectKey, ...next] : next;
      });
      setStatusLine(`${pinned ? "已置顶目录" : "已取消目录置顶"} · ${label}`);
    },
    [],
  );

  const requestDeleteSessions = useCallback((
    sessionIds: string[],
    scope: DeleteSessionScope = { kind: "sessions" },
  ) => {
    const uniqueIds = Array.from(new Set(sessionIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;
    setSessionContextMenu(null);
    setProjectContextMenu(null);
    setDeleteSessionError(null);
    setDeleteSessionScope(scope);
    setDeleteSessionIds(uniqueIds);
  }, []);

  const confirmDeleteSession = useCallback(
    async (nativeDeleteMode?: NativeDeleteMode) => {
    if (deleteSessionIds.length === 0 || deleteSessionBusy) return;
    if (!isTauri()) {
      setStatusLine("UI preview · delete unavailable");
      setDeleteSessionIds([]);
      setDeleteSessionScope({ kind: "sessions" });
      return;
    }
    const scope = deleteSessionScope;
    const sessionIds = deleteSessionIds;
    const targets = sessionIds
      .map(
        (sessionId) =>
          sessions.find((s) => s.id === sessionId) ??
          (pendingSession?.id === sessionId ? pendingSession : null),
      )
      .filter((session): session is SessionMeta => Boolean(session));
    const effectiveNativeDeleteMode =
      nativeDeleteMode ??
      (targets.some((session) => nativeDeleteKind(session))
        ? "direct"
        : "official");
    const applyDeletedSessions = async (removedSessionIds: string[]) => {
      const removedSessionIdSet = new Set(removedSessionIds);

      setSelectedSessionIds((prev) =>
        prev.filter((id) => !removedSessionIdSet.has(id)),
      );
      for (const sessionId of removedSessionIds) {
        clearAssistantTypingForSession(sessionId);
      }
      setMessagesBySession((prev) => {
        const next = { ...prev };
        for (const sessionId of removedSessionIds) {
          delete next[sessionId];
        }
        return next;
      });
      setSessionSnapshots((prev) => {
        const next = { ...prev };
        for (const sessionId of removedSessionIds) {
          delete next[sessionId];
        }
        return next;
      });
      const nextUnread = { ...sessionUnreadRef.current };
      for (const sessionId of removedSessionIds) {
        delete nextUnread[sessionId];
        delete notifiedSessionResultRef.current[sessionId];
      }
      sessionUnreadRef.current = nextUnread;
      setSessionUnread(nextUnread);
      setPendingSession((prev) =>
        prev && removedSessionIdSet.has(prev.id) ? null : prev,
      );
      const nextSessions = sessions.filter(
        (item) => !removedSessionIdSet.has(item.id),
      );
      setSessions(nextSessions);

      if (activeId && removedSessionIdSet.has(activeId)) {
        setQuoteTarget(null);
        const nextMeta = nextSessions.find(
          (session) =>
            session.runtimeId === runtimePick && session.archived === showArchived,
        );
        if (nextMeta) {
          await activateSession(nextMeta.id, nextMeta);
        } else {
          beginSessionActivation(null);
          setSnapshot(idleSnapshot());
        }
      }
    };

    setDeleteSessionBusy(true);
    setDeleteSessionError(null);
    const successfulSessionIds: string[] = [];
    try {
      const results = [];
      for (const sessionId of sessionIds) {
        results.push(
          await deleteSessionById(sessionId, {
            nativeDeleteMode: effectiveNativeDeleteMode,
          }),
        );
        successfulSessionIds.push(sessionId);
      }
      setDeleteSessionIds([]);
      setDeleteSessionScope({ kind: "sessions" });
      await applyDeletedSessions(sessionIds);

      setStatusLine(
        scope.kind === "project"
          ? `deleted ${sessionIds.length} sessions under ${scope.label}`
          : sessionIds.length === 1
          ? `deleted session${targets[0] ? ` · ${targets[0].title}` : ""} · ${results[0]?.deletedPath ?? sessionIds[0]}`
          : `deleted ${sessionIds.length} sessions`,
      );
    } catch (e) {
      if (successfulSessionIds.length > 0) {
        const successfulSessionIdSet = new Set(successfulSessionIds);
        await applyDeletedSessions(successfulSessionIds);
        setDeleteSessionIds((prev) =>
          prev.filter((sessionId) => !successfulSessionIdSet.has(sessionId)),
        );
      }
      const message = formatDeleteSessionError(e);
      setDeleteSessionError(message);
      setStatusLine(
        successfulSessionIds.length > 0
          ? `deleted ${successfulSessionIds.length} sessions · ${message}`
          : message,
      );
    } finally {
      setDeleteSessionBusy(false);
    }
  }, [
    activateSession,
    activeId,
    beginSessionActivation,
    clearAssistantTypingForSession,
    deleteSessionBusy,
    deleteSessionIds,
    deleteSessionScope,
    pendingSession,
    runtimePick,
    sessions,
    showArchived,
  ]);

  const sessionContextTarget = useMemo(() => {
    if (!sessionContextMenu) return null;
    return (
      sessions.find((session) => session.id === sessionContextMenu.sessionId) ??
      (pendingSession?.id === sessionContextMenu.sessionId ? pendingSession : null)
    );
  }, [pendingSession, sessionContextMenu, sessions]);
  const sessionContextTargetIds = sessionContextMenu?.targetIds ?? [];
  const sessionContextTargetTitle =
    sessionContextTargetIds.length > 1
      ? `已选择 ${sessionContextTargetIds.length} 个会话`
      : (sessionContextTarget?.title ?? "会话");
  const sessionContextTargetSnapshot = sessionContextTarget
    ? sessionSnapshots[sessionContextTarget.id]
    : undefined;
  const sessionContextArchiveDisabled = Boolean(
    sessionContextTarget &&
      !sessionContextTarget.archived &&
      !canChangeSessionSettings(sessionContextTargetSnapshot?.state ?? "idle"),
  );

  useEffect(() => {
    sessionSelectionAnchorRef.current = null;
    setSelectedSessionIds([]);
  }, [runtimePick, sessionFilter, showArchived]);

  const sessionPathFor = useCallback(
    (sessionId: string) =>
      appDataDir ? `${appDataDir}\\sessions\\${sessionId}` : sessionId,
    [appDataDir],
  );

  const deleteTargetSessions = useMemo(
    () =>
      deleteSessionIds
        .map(
          (sessionId) =>
            sessions.find((session) => session.id === sessionId) ??
            (pendingSession?.id === sessionId ? pendingSession : null),
        )
        .filter((session): session is SessionMeta => Boolean(session)),
    [deleteSessionIds, pendingSession, sessions],
  );
  const deleteTargetNativeCodexCount = deleteTargetSessions.filter(
    (session) => nativeDeleteKind(session) === "codex",
  ).length;
  const deleteTargetNativeGrokCount = deleteTargetSessions.filter(
    (session) => nativeDeleteKind(session) === "grok",
  ).length;
  const deleteTargetNativeClaudeCount = deleteTargetSessions.filter(
    (session) => nativeDeleteKind(session) === "claude",
  ).length;
  const deleteTargetNativeKimiCount = deleteTargetSessions.filter(
    (session) => nativeDeleteKind(session) === "kimi",
  ).length;
  const deleteTargetNativeCount =
    deleteTargetNativeCodexCount +
    deleteTargetNativeGrokCount +
    deleteTargetNativeClaudeCount +
    deleteTargetNativeKimiCount;
  const deleteTargetNativeSummary = [
    deleteTargetNativeCodexCount > 0
      ? `${deleteTargetNativeCodexCount} 个 Codex`
      : null,
    deleteTargetNativeGrokCount > 0
      ? `${deleteTargetNativeGrokCount} 个 Grok`
      : null,
    deleteTargetNativeClaudeCount > 0
      ? `${deleteTargetNativeClaudeCount} 个 Claude`
      : null,
    deleteTargetNativeKimiCount > 0
      ? `${deleteTargetNativeKimiCount} 个 Kimi`
      : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("、");
  const canDeleteWorkbenchOnly =
    deleteTargetNativeCount > 0 &&
    isNativeDeleteFallbackError(deleteSessionError);
  const deleteTargetItems = deleteSessionIds.map((sessionId) => {
    const session = deleteTargetSessions.find((session) => session.id === sessionId);
    return {
      id: sessionId,
      title: session?.title ?? sessionId,
      path: sessionPathFor(sessionId),
      nativeLabel:
        session?.runtimeId === "codex" && session.nativeThreadId
          ? `Codex 原生 thread：${session.nativeThreadId}`
          : session?.runtimeId === "grok" && session.nativeSessionId
          ? `Grok 原生 session：${session.nativeSessionId}`
          : session?.runtimeId === "claude" && session.nativeSessionId
          ? `Claude 原生 session：${session.nativeSessionId}`
          : session?.runtimeId === "kimi" && session.nativeSessionId
          ? `Kimi 原生 session：${session.nativeSessionId}`
          : null,
    };
  });
  const deleteDialogTitle =
    deleteSessionScope.kind === "project"
      ? `删除 ${deleteSessionScope.label} 下的 ${deleteSessionIds.length} 个会话`
      : deleteSessionIds.length > 1
        ? `删除 ${deleteSessionIds.length} 个会话`
        : "删除会话";
  const deleteDialogSub =
    deleteSessionScope.kind === "project"
      ? deleteTargetNativeCount > 0
        ? "删除 Workbench 会话，并直接删除绑定的原生会话数据；不删除项目源码目录"
        : "只删除 Workbench 会话文件夹和记录，不删除项目源码目录"
      : deleteTargetNativeCount > 0
        ? "删除后会移除 Workbench 会话，并直接删除绑定的原生会话数据"
        : "删除后会移除会话文件夹和记录";
  const deleteDialogNote =
    deleteSessionScope.kind === "project"
      ? deleteTargetNativeCount > 0
        ? `此操作会删除该目录分组下的所有会话，其中 ${deleteTargetNativeSummary} 原生会话会同步删除。Codex 会删除对应 rollout jsonl 文件并清理 state_*.sqlite 索引；Grok 会删除 ~/.grok/sessions 下对应 session 目录；Claude 会删除 ~/.claude/projects 下对应 session jsonl 文件；Kimi 会删除 ~/.kimi 或 ~/.kimi-code/sessions 下对应 session 目录。不会删除整个 CLI 配置目录，无法恢复。`
        : "此操作会删除该目录分组下的所有会话，无法恢复。"
      : deleteTargetNativeCount > 0
        ? `此操作会删除会话及其文件夹内容，并永久删除 ${deleteTargetNativeSummary} 绑定的原生会话数据。Codex 会删除 rollout jsonl 和索引；Grok 会删除 ~/.grok/sessions 下对应 session 目录；Claude 会删除 ~/.claude/projects 下对应 session jsonl 文件；Kimi 会删除 ~/.kimi 或 ~/.kimi-code/sessions 下对应 session 目录。不会删除整个 CLI 配置目录，无法恢复。`
        : "此操作会删除会话及其文件夹内容，无法恢复。";

  useEffect(() => {
    if (!sessionContextMenu) return;
    const close = () => setSessionContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sessionContextMenuRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [sessionContextMenu]);

  useEffect(() => {
    if (!projectContextMenu) return;
    const close = () => setProjectContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (projectContextMenuRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [projectContextMenu]);

  useEffect(() => {
    const suppressGlobalContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".session-item") || target.closest(".session-project__header"))
      ) {
        return;
      }
      event.preventDefault();
      setSessionContextMenu(null);
      setProjectContextMenu(null);
    };
    window.addEventListener("contextmenu", suppressGlobalContextMenu);
    return () => {
      window.removeEventListener("contextmenu", suppressGlobalContextMenu);
    };
  }, []);

  const respondPermission = useCallback(
    async (request: PermissionRequestEvent, decision: PermissionDecision) => {
      if (!isTauri()) {
        setPermissionQueue((prev) => {
          const queue = (prev[request.sessionId] ?? []).filter(
            (item) => item.requestId !== request.requestId,
          );
          if (queue.length === 0) {
            const { [request.sessionId]: _drop, ...rest } = prev;
            return rest;
          }
          return { ...prev, [request.sessionId]: queue };
        });
        return;
      }
      setPermissionBusy(request.requestId);
      try {
        await api.respondPermission(
          request.sessionId,
          request.requestId,
          decision,
        );
        // The queue is cleared by session://permission_resolved so the Host
        // stays the single source of truth for what is still pending.
      } catch (e) {
        setPermissionBusy(null);
        setStatusLine(`permission respond failed: ${String(e)}`);
      }
    },
    [],
  );

  async function createSession(projectPathOverride?: string | null) {
    setBusy(true);
    try {
      setShowArchived(false);
      setQuoteTarget(null);
      const projectPath = projectPathOverride?.trim() || null;
      if (!isTauri()) {
        const baseMeta: SessionMeta = {
          id: uid("sess"),
          title: `${runtimeLabel(runtimePick)} · 新会话`,
          pinned: false,
          archived: false,
          runtimeId: runtimePick,
          projectPath,
          modelId:
            runtimePick === "grok"
              ? "grok-4.5"
              : runtimePick === "deepseek-harness"
                ? "deepseek-v4-flash"
                : "default",
          modelReasoningEffort: defaultReasoningEffortForRuntime(runtimePick),
          permissionMode: defaultPermissionMode(runtimePick),
          personalCenterEnabled: false,
          personalCenterPath: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        setPendingSession(baseMeta);
        beginSessionActivation(baseMeta.id);
        setSnapshot(idleSnapshot(baseMeta));
        resetChatViewport(baseMeta.id, 0);
        updateSessionMessages(baseMeta.id, () => []);
        setStatusLine(`${runtimeLabel(baseMeta.runtimeId)} 新会话已创建`);
        return;
      }
      const meta = await api.createSession(runtimePick, projectPath);
      setPendingSession(meta);
      const requestId = beginSessionActivation(meta.id);
      const snap = await api.getSnapshot(meta.id);
      if (!isCurrentSessionActivation(meta.id, requestId)) return;
      setSnapshot(snap);
      resetChatViewport(meta.id, 0);
      updateSessionMessages(meta.id, () => []);
      setStatusLine(`${runtimeLabel(meta.runtimeId)} 新会话已创建`);
    } catch (e) {
      setStatusLine(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickActiveProjectDirectory() {
    if (!active || pendingSession?.id !== active.id || messages.length > 0) return;
    if (!isTauri()) {
      setStatusLine("目录选择需要在桌面版中使用");
      return;
    }
    setProjectPathBusy(true);
    try {
      const selected = await api.pickProjectDirectory(active.projectPath ?? null);
      if (!selected) return;
      const meta = await api.updateSessionProject(active.id, selected);
      setPendingSession((current) => (current?.id === meta.id ? meta : current));
      setSessions((current) =>
        current.map((session) => (session.id === meta.id ? meta : session)),
      );
      if (activeIdRef.current === meta.id) {
        setSnapshot((current) => ({ ...current, projectPath: meta.projectPath }));
      }
      setStatusLine(`工作目录：${selected}`);
    } catch (error) {
      setStatusLine(`选择工作目录失败：${String(error)}`);
    } finally {
      setProjectPathBusy(false);
    }
  }

  async function updateActiveSessionSettings(patch: {
    modelId?: string;
    modelReasoningEffort?: string | null;
    permissionMode?: PermissionMode;
  }) {
    if (!active || settingsChangeDisabled) return;
    const wasLive =
      snapshot.state === "ready" || snapshot.state === "streaming";
    setSettingsBusy(true);
    try {
      if (!isTauri()) {
        const nextMeta: SessionMeta = {
          ...active,
          modelId: patch.modelId ?? active.modelId,
          modelReasoningEffort:
            patch.modelReasoningEffort ?? active.modelReasoningEffort,
          permissionMode: patch.permissionMode ?? active.permissionMode,
          updatedAt: nowIso(),
        };
        setPendingSession((prev) => (prev?.id === active.id ? nextMeta : prev));
        setSessions((prev) =>
          prev.map((session) => (session.id === active.id ? nextMeta : session)),
        );
        setSnapshot((prev) => ({
          ...prev,
          modelId: nextMeta.modelId,
          modelReasoningEffort: nextMeta.modelReasoningEffort,
          permissionMode: nextMeta.permissionMode,
          state:
            prev.state === "ready" || prev.state === "streaming"
              ? "disconnected"
              : prev.state,
          backend:
            prev.state === "ready" || prev.state === "streaming" ? "none" : prev.backend,
        }));
        return;
      }

      const nextMeta = await api.updateSessionSettings(active.id, patch);
      setPendingSession((prev) => (prev?.id === nextMeta.id ? nextMeta : prev));
      setSessions((prev) =>
        prev.map((session) => (session.id === nextMeta.id ? nextMeta : session)),
      );
      if (activeIdRef.current === nextMeta.id) {
        const baseSnapshot = {
          ...snapshot,
          modelId: nextMeta.modelId,
          modelReasoningEffort: nextMeta.modelReasoningEffort,
          permissionMode: nextMeta.permissionMode,
          state: wasLive ? ("disconnected" as SessionState) : snapshot.state,
          backend: wasLive ? "none" : snapshot.backend,
        };
        setSnapshot(baseSnapshot);
        if (wasLive) {
          const snap = await api.connect(nextMeta.id);
          if (activeIdRef.current === nextMeta.id) {
            setSnapshot(snap);
          }
        }
      }
    } catch (e) {
      setStatusLine(String(e));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function toggleActivePersonalCenter() {
    if (!active) return;
    const enabled = !Boolean(active.personalCenterEnabled);
    if (!isTauri()) {
      const nextMeta: SessionMeta = {
        ...active,
        personalCenterEnabled: enabled,
        personalCenterPath: enabled
          ? appSettings?.personalCenter?.path ?? active.personalCenterPath ?? null
          : active.personalCenterPath ?? null,
        updatedAt: nowIso(),
      };
      setPendingSession((prev) => (prev?.id === active.id ? nextMeta : prev));
      setSessions((prev) => mergeSessions(prev, [nextMeta]));
      setStatusLine(
        enabled ? "个人中心模式已开启 · browser mock" : "个人中心模式已关闭 · browser mock",
      );
      requestAnimationFrame(() => composerInputRef.current?.focus());
      return;
    }

    try {
      const nextMeta = await api.setSessionPersonalCenter(active.id, enabled);
      setPendingSession((prev) => (prev?.id === active.id ? nextMeta : prev));
      setSessions((prev) => mergeSessions(prev, [nextMeta]));
      setStatusLine(enabled ? "个人中心模式已开启" : "个人中心模式已关闭");
    } catch (e) {
      setStatusLine(`personal center mode failed: ${String(e)}`);
    } finally {
      requestAnimationFrame(() => composerInputRef.current?.focus());
    }
  }

  function insertSkill(name: string) {
    const skill = findSkillByName(skills, name);
    if (!skill) return;
    setSelectedSkillNames((prev) => {
      if (prev.some((item) => skillKey(item) === skillKey(skill.name))) return prev;
      return [...prev, skill.name];
    });
    requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  }

  async function fileToBytes(file: File): Promise<number[]> {
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }

  function imageBytesToPreviewUrl(bytes: number[], mimeType: string): string {
    const array = new Uint8Array(bytes);
    const buffer = array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength);
    return URL.createObjectURL(new Blob([buffer], { type: mimeType }));
  }

  function imageAttachmentFromSaved(
    saved: SessionImageAttachment,
    previewUrl: string,
  ): ComposerImageAttachment {
    return {
      id: saved.id,
      name: saved.name,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
      path: saved.path,
      previewUrl,
    };
  }

  async function savePickedImageAttachment(
    sessionId: string,
    picked: PickedFile,
  ): Promise<ComposerImageAttachment | null> {
    const imageBytes = picked.imageBytes ?? [];
    if (imageBytes.length === 0) {
      emitToast({ message: `${picked.name} 不是支持的图片或超过 10MB`, tone: "danger" });
      return null;
    }
    const mimeType = picked.mimeType || "image/png";
    const previewUrl = imageBytesToPreviewUrl(imageBytes, mimeType);
    try {
      const saved = await api.saveImageAttachment(
        sessionId,
        picked.name || "selected-image",
        mimeType,
        imageBytes,
      );
      if (activeIdRef.current !== sessionId) {
        URL.revokeObjectURL(previewUrl);
        return null;
      }
      return imageAttachmentFromSaved(saved, previewUrl);
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      emitToast({ message: `图片添加失败: ${String(error)}`, tone: "danger" });
      return null;
    }
  }

  async function pasteImageAttachments(files: File[]) {
    const session = active;
    if (!session || files.length === 0) return;
    if (session.runtimeId !== "codex") {
      emitToast({ message: "图片粘贴目前仅支持 Codex 会话", tone: "danger" });
      return;
    }
    if (!isTauri()) {
      emitToast({ message: "图片粘贴需要在桌面版中使用", tone: "danger" });
      return;
    }

    const sessionId = session.id;
    const savedAttachments: ComposerImageAttachment[] = [];
    for (const file of files) {
      const previewUrl = URL.createObjectURL(file);
      try {
        const saved = await api.saveImageAttachment(
          sessionId,
          file.name || "pasted-image",
          file.type || "image/png",
          await fileToBytes(file),
        );
        if (activeIdRef.current !== sessionId) {
          URL.revokeObjectURL(previewUrl);
          continue;
        }
        savedAttachments.push(imageAttachmentFromSaved(saved, previewUrl));
      } catch (error) {
        URL.revokeObjectURL(previewUrl);
        emitToast({ message: `图片粘贴失败: ${String(error)}`, tone: "danger" });
      }
    }
    if (savedAttachments.length === 0) return;
    setImageAttachments((current) => [...current, ...savedAttachments]);
    setStatusLine(`已添加 ${savedAttachments.length} 张图片`);
  }

  function removeImageAttachment(id: string) {
    setImageAttachments((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  async function pickComposerFiles() {
    const session = active;
    if (!session) return;
    if (!isTauri()) {
      emitToast({ message: "添加文件需要在桌面版中使用", tone: "danger" });
      return;
    }

    try {
      const pickedFiles = await api.pickProjectFiles(session.projectPath ?? null);
      if (!pickedFiles || pickedFiles.length === 0) return;

      const sessionId = session.id;
      const nextImages: ComposerImageAttachment[] = [];
      const nextFiles: ComposerFileAttachment[] = [];
      let skippedImages = 0;

      for (const picked of pickedFiles) {
        if (picked.isImage) {
          if (session.runtimeId !== "codex") {
            skippedImages += 1;
            continue;
          }
          const image = await savePickedImageAttachment(sessionId, picked);
          if (image) nextImages.push(image);
          continue;
        }

        nextFiles.push({
          id: uid("file"),
          name: picked.name,
          path: picked.path,
          extension: picked.extension,
          mimeType: picked.mimeType,
          sizeBytes: picked.sizeBytes,
        });
      }

      if (activeIdRef.current !== sessionId) return;

      if (nextFiles.length > 0) {
        setFileAttachments((current) => {
          const seen = new Set(current.map((file) => file.path.toLowerCase()));
          const unique = nextFiles.filter((file) => {
            const key = file.path.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return unique.length > 0 ? [...current, ...unique] : current;
        });
      }
      if (nextImages.length > 0) {
        setImageAttachments((current) => [...current, ...nextImages]);
      }
      if (skippedImages > 0) {
        emitToast({ message: "图片添加目前仅支持 Codex 会话", tone: "danger" });
      }
      const totalAdded = nextFiles.length + nextImages.length;
      if (totalAdded > 0) setStatusLine(`已添加 ${totalAdded} 个附件`);
    } catch (error) {
      emitToast({ message: `添加文件失败: ${String(error)}`, tone: "danger" });
    } finally {
      requestAnimationFrame(() => composerInputRef.current?.focus());
    }
  }

  function removeFileAttachment(id: string) {
    setFileAttachments((current) => current.filter((file) => file.id !== id));
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  async function sendMessage() {
    const body = draft.trim();
    const selectedSkillTokens = selectedSkillNames
      .filter((name) => Boolean(findSkillByName(skills, name)))
      .map((name) => skillInvocationToken(name, activeRuntimeId));
    if (
      (!body &&
        selectedSkillTokens.length === 0 &&
        imageAttachments.length === 0 &&
        fileAttachments.length === 0) ||
      !active
    ) {
      return;
    }
    if (active.archived) {
      setStatusLine("请先恢复归档会话再继续发送");
      return;
    }
    if (imageAttachments.length > 0 && active.runtimeId !== "codex") {
      setStatusLine("图片输入目前仅支持 Codex 会话");
      return;
    }
    const fileContextLines = fileAttachments.map((file) => `[file] ${file.path}`);
    const bodyWithSkills = [selectedSkillTokens.join(" "), fileContextLines.join("\n"), body]
      .filter(Boolean)
      .join("\n\n");
    const session = active;
    const goalMode = session.runtimeId === "codex" && Boolean(goalModeBySession[session.id]);
    const composedText = composeMessageText(quoteTarget, bodyWithSkills);
    const text = goalMode ? codexGoalPrompt(composedText) : composedText;
    const outgoingImages = imageAttachments;
    const imagePaths = outgoingImages.map((image) => image.path);
    const displayText = [
      text,
      ...outgoingImages.map((image) => `[image] ${image.path}`),
    ]
      .filter(Boolean)
      .join("\n");
    setSessionTurnBusy((prev) => ({ ...prev, [session.id]: true }));
    setDraft("");
    setSelectedSkillNames([]);
    clearImageAttachments();
    setFileAttachments([]);
    stickToBottomRef.current = true;
    autoFollowStreamRef.current = true;
    scrollChatToBottom("smooth");
    const userMsg: ChatMessage = {
      id: uid("u"),
      role: "user",
      content: displayText,
      runtimeId: session.runtimeId,
    };
    updateSessionMessages(session.id, (m) => [...m, userMsg]);

    if (!isTauri()) {
      updateSessionMessages(session.id, (m) => [
        ...m,
        {
          id: uid("a"),
          role: "assistant",
          content: "",
          runtimeId: session.runtimeId,
          streaming: true,
          pending: true,
          createdAt: nowIso(),
          completedAt: null,
        },
      ]);
      setSnapshot((s) => ({ ...s, state: "streaming" }));
      mockReplyTimerRef.current = window.setTimeout(() => {
        updateSessionMessages(session.id, (m) => {
          const replyId = uid("a");
          const replyContent = `[${runtimeLabel(session.runtimeId)} stub]\n收到：${displayText}\n\n下一步会接入真实 Adapter（Grok ACP / Codex App Server）。`;
          queueAssistantTyping(session.id, replyId, replyContent);
          const last = m[m.length - 1];
          const reply: ChatMessage = {
            id: replyId,
            role: "assistant",
            content: replyContent,
            runtimeId: session.runtimeId,
            createdAt: last?.role === "assistant" ? last.createdAt ?? nowIso() : nowIso(),
            completedAt: nowIso(),
          };
          if (last?.role === "assistant" && last.pending) {
            return [...m.slice(0, -1), reply];
          }
          return [...m, reply];
        });
        if (activeIdRef.current === session.id) {
          setSnapshot((s) => ({ ...s, state: "ready" }));
        }
      setPendingSession((prev) => (prev?.id === session.id ? null : prev));
      setSessions((prev) =>
        prev.some((item) => item.id === session.id)
          ? prev
          : [{ ...session, updatedAt: nowIso() }, ...prev],
      );
        setQuoteTarget(null);
        mockReplyTimerRef.current = null;
        setSessionTurnBusy((prev) => {
          const next = { ...prev };
          delete next[session.id];
          return next;
        });
        autoFollowStreamRef.current = false;
      }, 400);
      return;
    }

    try {
      setBusy(true);
      updateSessionMessages(session.id, (m) => [
        ...m,
        {
          id: uid("a"),
          role: "assistant",
          content: "",
          runtimeId: session.runtimeId,
          streaming: true,
          pending: true,
          createdAt: nowIso(),
          completedAt: null,
        },
      ]);
      setSnapshot((s) => ({ ...s, state: "streaming" }));
      const projectPath = session.projectPath?.trim();
      turnWorktreeBaselineRef.current[session.id] = projectPath
        ? await api.projectWorktreeChanges(projectPath).catch(() => null)
        : null;
      await api.send(session.id, text, imagePaths);
      const list = await api.listSessions();
      setSessions((prev) => mergeSessions(prev, list));
      setPendingSession((prev) => (prev?.id === session.id ? null : prev));
      setQuoteTarget(null);
    } catch (e) {
      autoFollowStreamRef.current = false;
      setSessionTurnBusy((prev) => {
        const next = { ...prev };
        delete next[session.id];
        return next;
      });
      delete turnWorktreeBaselineRef.current[session.id];
      updateSessionMessages(session.id, (m) => [
        ...m.filter(
          (msg) =>
            !(
              msg.role === "assistant" &&
              ((msg.pending && msg.streaming) || (msg.streaming && !msg.content))
            ),
        ),
        {
          id: uid("sys"),
          role: "system",
          content: `send failed: ${String(e)}`,
        },
      ]);
      if (activeIdRef.current === session.id) {
        setSnapshot((s) => ({ ...s, state: "disconnected" }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function stopActive() {
    if (!active) return;
    autoFollowStreamRef.current = false;

    if (!isTauri() && mockReplyTimerRef.current !== null) {
      window.clearTimeout(mockReplyTimerRef.current);
      mockReplyTimerRef.current = null;
    }

    const sessionId = active.id;
    updateSessionMessages(sessionId, (m) =>
      m
        .filter((msg) => !(msg.role === "assistant" && msg.pending))
        .map(finalizeStreamingMessage),
    );
    setSnapshot((s) =>
      s.state === "streaming" || s.state === "awaiting_permission"
        ? { ...s, state: "ready" }
        : s,
    );
    setBusy(false);
    setSessionTurnBusy((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });

    if (!isTauri()) return;

    try {
      await api.stop(sessionId);
      const snap = await api.getSnapshot(sessionId);
      if (activeIdRef.current === sessionId) {
        setSnapshot(snap);
      }
    } catch (e) {
      setStatusLine(`stop failed: ${String(e)}`);
    }
  }

  const syncNativeSessions = useCallback(
    async (mode: "reset" | "more" = "reset") => {
      if (!isTauri()) {
        setStatusLine("UI preview · native sync unavailable");
        return;
      }
      const runtime = runtimePick;
      const loadingMore = mode === "more";
      if (loadingMore && nativeHasMore[runtime] === false) return;
      if (syncingRuntime || loadingMoreRuntime) return;

      if (loadingMore) {
        setLoadingMoreRuntime(runtime);
      } else {
        setSyncingRuntime(runtime);
      }
      try {
        const result = await api.syncNativeSessions(
          runtime,
          SESSION_PAGE_SIZE,
          loadingMore ? (nativeCursors[runtime] ?? null) : null,
        );
        setSessions((prev) => mergeSessions(prev, result.sessions));
        setNativeCursors((prev) => ({
          ...prev,
          [runtime]: result.nextCursor ?? null,
        }));
        setNativeHasMore((prev) => ({
          ...prev,
          [runtime]: result.hasMore,
        }));
        setStatusLine(
          `${runtimeLabel(runtime)} synced · ${result.sessions.length} sessions`,
        );
      } catch (e) {
        setStatusLine(`sync failed: ${String(e)}`);
      } finally {
        setSyncingRuntime(null);
        setLoadingMoreRuntime(null);
      }
    },
    [
      loadingMoreRuntime,
      nativeCursors,
      nativeHasMore,
      runtimePick,
      syncingRuntime,
    ],
  );

  const activeTurnBusy = activeId ? Boolean(sessionTurnBusy[activeId]) : false;
  const streaming =
    activeTurnBusy ||
    snapshot.state === "connecting" ||
    snapshot.state === "streaming" ||
    snapshot.state === "awaiting_permission";
  const composerInputDisabled =
    Boolean(active?.archived) || streaming || runningWorkflowId !== null;
  const nonCodexRouteRuntimes = sortRuntimes(runtimes).filter(
    (runtime) => runtime.id !== "codex" && runtime.id !== "claude",
  );
  const claudeRuntime = runtimes.find((runtime) => runtime.id === "claude");
  const codexRuntime = runtimes.find((runtime) => runtime.id === "codex");
  const routeDiagnosticsPanel = (
    <>
      <div className="probe-card">
        <div className="probe-card__row">
          <strong>Claude Code 连接 / 模型出口</strong>
          <span
            style={{
              color:
                claudeRoute?.routeKind === "cc-switch/local-proxy"
                  ? "var(--success)"
                  : "var(--text-secondary)",
              fontSize: 11,
            }}
          >
            {claudeRoute?.routeKind ?? "unknown"}
          </span>
        </div>
        <div className="route-kv">
          <span>connect</span>
          <strong>{runtimeConnectHint("claude")}</strong>
        </div>
        <div className="route-kv">
          <span>protocol</span>
          <strong>{protocolLabel(claudeRuntime?.capabilities.protocol ?? "claude_code")}</strong>
        </div>
        <div className="route-kv">
          <span>permission</span>
          <strong>{claudeRuntime?.capabilities.permissionGate === false ? "none" : "gated"}</strong>
        </div>
        <div className="route-note">{claudeRoute?.note ?? "正在检测 Claude Code 路由。"}</div>
      </div>

      <div className="probe-card">
        <div className="probe-card__row">
          <strong>Codex 连接 / 模型出口</strong>
          <span
            style={{
              color:
                codexRoute?.routeKind === "cc-switch"
                  ? "var(--success)"
                  : "var(--text-secondary)",
              fontSize: 11,
            }}
          >
            {codexRoute?.routeKind ?? "unknown"}
          </span>
        </div>
        <div className="route-kv">
          <span>connect</span>
          <strong>{runtimeConnectHint("codex")}</strong>
        </div>
        <div className="route-kv">
          <span>protocol</span>
          <strong>{protocolLabel(codexRuntime?.capabilities.protocol ?? "codex_app_server")}</strong>
        </div>
        <div className="route-kv">
          <span>permission</span>
          <strong>{codexRuntime?.capabilities.permissionGate === false ? "none" : "gated"}</strong>
        </div>
        {codexRoute?.latestError ? (
          <div className="route-note route-note--warn">
            {codexRoute.latestError}
          </div>
        ) : null}
        <div className="route-note">{codexRoute?.note ?? "正在检测 Codex 路由。"}</div>
      </div>
      {nonCodexRouteRuntimes.map((runtime) => (
        <div key={runtime.id} className="probe-card">
          <div className="probe-card__row">
            <strong>{runtimeLabel(runtime.id)} 连接 / 模型出口</strong>
            <span
              style={{
                color: runtime.enabled
                  ? "var(--text-secondary)"
                  : "var(--danger)",
                fontSize: 11,
              }}
            >
              {runtimeRouteMode(runtime)}
            </span>
          </div>
          <div className="route-kv">
            <span>connect</span>
            <strong>{runtimeConnectHint(runtime.id)}</strong>
          </div>
          <div className="route-kv">
            <span>protocol</span>
            <strong>{protocolLabel(runtime.capabilities.protocol)}</strong>
          </div>
          <div className="route-kv">
            <span>permission</span>
            <strong>{runtime.capabilities.permissionGate ? "gated" : "none"}</strong>
          </div>
          <div className="route-note">{runtimeRouteDescription(runtime)}</div>
        </div>
      ))}
    </>
  );
  const isOrchestrationView = activeView === "orchestration";
  const activeOrchestrationTask = orchestrationTasks.find(
    (task) => task.id === activeOrchestrationId,
  ) ?? orchestrationTasks[0];
  const updateOrchestrationTask = (nextTask: OrchestrationTask) => {
    setOrchestrationTasks((current) =>
      current.map((task) => (task.id === nextTask.id ? nextTask : task)),
    );
  };
  const createOrchestration = () => {
    const nextTask = createOrchestrationTask(orchestrationTasks.length + 1);
    setOrchestrationTasks((current) => [nextTask, ...current]);
    setActiveOrchestrationId(nextTask.id);
  };
  const updateWorkflowTask = (
    taskId: string,
    updater: (task: OrchestrationTask) => OrchestrationTask,
  ): OrchestrationTask | null => {
    let nextTask: OrchestrationTask | null = null;
    setOrchestrationTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) return task;
        nextTask = updater(task);
        return nextTask;
      }),
    );
    return nextTask;
  };
  const createWorkflowTurnWaiter = async (sessionId: string) => {
    let settled = false;
    let resolveWaiter: () => void = () => {};
    let rejectWaiter: (error: Error) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const cleanup: Array<() => void> = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      for (const unlisten of cleanup) unlisten();
      if (error) {
        rejectWaiter(error);
      } else {
        resolveWaiter();
      }
    };
    const settledUnlisten = await listen<TurnSettledEvent>(
      "session://turn_settled",
      (event) => {
        if (event.payload.sessionId === sessionId) finish();
      },
    );
    cleanup.push(settledUnlisten);
    const errorUnlisten = await listen<{
      sessionId: string;
      code?: string | null;
      message: string;
    }>("session://error", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      const code = event.payload.code ? `${event.payload.code}: ` : "";
      finish(new Error(`${code}${event.payload.message}`));
    });
    cleanup.push(errorUnlisten);
    return {
      promise,
      cancel: () => finish(),
    };
  };
  const createWorkflowSession = async (
    node: OrchestrationNode,
    projectPath: string | null,
  ): Promise<SessionMeta> => {
    if (isTauri()) {
      const meta = await api.createSession(node.runtimeId, projectPath);
      setSessions((prev) => mergeSessions(prev, [meta]));
      return meta;
    }

    const meta: SessionMeta = {
      id: uid("wf"),
      title: `${runtimeLabel(node.runtimeId)} · ${node.title}`,
      pinned: false,
      archived: false,
      runtimeId: node.runtimeId,
      projectPath,
      modelId:
        node.runtimeId === "grok"
          ? "grok-4.5"
          : node.runtimeId === "deepseek-harness"
            ? "deepseek-v4-flash"
            : "default",
      modelReasoningEffort: defaultReasoningEffortForRuntime(node.runtimeId),
      permissionMode: defaultPermissionMode(node.runtimeId),
      personalCenterEnabled: false,
      personalCenterPath: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    setSessions((prev) => mergeSessions(prev, [meta]));
    return meta;
  };
  const sendWorkflowStep = async (
    task: OrchestrationTask,
    node: OrchestrationNode,
    upstream: WorkflowStepOutput[],
    projectPath: string | null,
    onSessionCreated: (session: SessionMeta) => void,
  ): Promise<WorkflowStepOutput> => {
    const prompt = buildWorkflowNodePrompt(task, node, upstream);
    const session = await createWorkflowSession(node, projectPath);
    onSessionCreated(session);
    updateSessionMessages(session.id, () => [
      {
        id: uid("u"),
        role: "user",
        content: prompt,
        runtimeId: session.runtimeId,
      },
      {
        id: uid("a"),
        role: "assistant",
        content: "",
        runtimeId: session.runtimeId,
        streaming: true,
        pending: true,
        createdAt: nowIso(),
        completedAt: null,
      },
    ]);
    setVisibleMessageCounts((prev) => ({
      ...prev,
      [session.id]: INITIAL_VISIBLE_MESSAGES,
    }));

    if (!isTauri()) {
      const output = `[${runtimeLabel(session.runtimeId)} workflow stub]\n${node.title} 已接收上游输入。`;
      updateSessionMessages(session.id, (messages) => [
        ...messages.slice(0, -1),
        {
          id: uid("a"),
          role: "assistant",
          content: output,
          runtimeId: session.runtimeId,
          createdAt: nowIso(),
          completedAt: nowIso(),
        },
      ]);
      return { node, session, output };
    }

    const waiter = await createWorkflowTurnWaiter(session.id);
    try {
      const baseline = projectPath
        ? await api.projectWorktreeChanges(projectPath).catch(() => null)
        : null;
      turnWorktreeBaselineRef.current[session.id] = baseline;
      await api.send(session.id, prompt);
      await waiter.promise;
      const storedMessages = await api.getMessages(session.id);
      const snap = await api.getSnapshot(session.id).catch(() => undefined);
      const normalized = normalizeLoadedMessages(storedMessages, snap);
      updateSessionMessages(session.id, () => normalized);
      const list = await api.listSessions();
      setSessions((prev) => mergeSessions(prev, list));
      return {
        node,
        session,
        output: extractLastAssistantText(normalized),
      };
    } finally {
      waiter.cancel();
    }
  };
  const runWorkflow = async (task: OrchestrationTask) => {
    if (runningWorkflowId) return;
    const nodes = fixedWorkflowNodes(task);
    if (nodes.length === 0) {
      setStatusLine("编排运行失败：需要 implement/review/fix 三个固定节点");
      return;
    }

    setRunningWorkflowId(task.id);
    setStatusLine(`开始运行编排：${task.title}`);
    const projectPath = active?.projectPath?.trim() || snapshot.projectPath?.trim() || null;
    const upstream: WorkflowStepOutput[] = [];
    let currentTask = task;

    try {
      for (const node of nodes) {
        const startedAt = formatOrchestrationUpdatedAt();
        const runningTask = updateWorkflowNode(currentTask, node.id, {
          status: "running",
          lastRunAt: startedAt,
          lastError: null,
        });
        currentTask =
          updateWorkflowTask(task.id, () => runningTask) ?? runningTask;
        const latestNode =
          currentTask.nodes.find((item) => item.id === node.id) ?? node;
        let stepSessionId = latestNode.sessionId ?? null;

        try {
          const output = await sendWorkflowStep(
            currentTask,
            latestNode,
            upstream,
            projectPath,
            (session) => {
              stepSessionId = session.id;
              const linkedTask = updateWorkflowNode(currentTask, node.id, {
                sessionId: session.id,
              });
              currentTask =
                updateWorkflowTask(task.id, () => linkedTask) ?? linkedTask;
            },
          );
          upstream.push(output);
          const doneTask = updateWorkflowNode(currentTask, node.id, {
            status: "done",
            sessionId: output.session.id,
            lastRunAt: formatOrchestrationUpdatedAt(),
            lastError: null,
          });
          currentTask = updateWorkflowTask(task.id, () => doneTask) ?? doneTask;
        } catch (error) {
          const failedTask = updateWorkflowNode(currentTask, node.id, {
            status: "failed",
            sessionId: stepSessionId,
            lastRunAt: formatOrchestrationUpdatedAt(),
            lastError: String(error),
          });
          updateWorkflowTask(task.id, () => failedTask);
          setStatusLine(`编排暂停：${latestNode.title} 失败，${String(error)}`);
          return;
        }
      }

      setStatusLine(`编排完成：${task.title}`);
    } finally {
      setRunningWorkflowId(null);
    }
  };
  const openWorkflowSession = (sessionId: string) => {
    setActiveView("chat");
    selectSession(sessionId);
  };
  return (
    <div className="app-shell platform-win has-custom-chrome" data-theme={theme}>
      <WindowControls visible={isTauri()} />

      <div className="workbench">
        {isOrchestrationView ? (
          <OrchestrationSidebar
            hidden={sidebarHidden}
            tasks={orchestrationTasks}
            activeTaskId={activeOrchestrationTask?.id ?? ""}
            onSelectTask={setActiveOrchestrationId}
            onCreateTask={createOrchestration}
            onBackToChat={() => setActiveView("chat")}
            onHideSidebar={() => setSidebarHidden(true)}
            onToggleMaximize={() => void toggleMaximizeFromTitlebar()}
            onOpenAbout={() => setAboutOpen(true)}
          />
        ) : (
          <SessionSidebar
            hidden={sidebarHidden}
            runtimePick={runtimePick}
            runtimePickOptions={runtimePickOptions}
            sessions={sessions}
            sessionSnapshots={sessionSnapshots}
            sessionUnread={sessionUnread}
            activeId={activeId}
            busy={busy}
            showSearch={showSearch}
            showArchived={showArchived}
            sessionFilter={sessionFilter}
            sessionScrollRef={sessionScrollRef}
            orchestrationActive={isOrchestrationView}
            syncingRuntime={syncingRuntime}
            loadingMoreRuntime={loadingMoreRuntime}
            nativeHasMore={nativeHasMore}
            onHideSidebar={() => setSidebarHidden(true)}
            onToggleMaximize={() => void toggleMaximizeFromTitlebar()}
            onRuntimePickChange={setRuntimePick}
            onCreateSession={(projectPath) => {
              setActiveView("chat");
              void createSession(projectPath);
            }}
            onOpenOrchestration={() => setActiveView("orchestration")}
            onToggleSearch={() => {
              setShowSearch((v) => !v);
              if (showSearch) setSessionFilter("");
            }}
            onShowArchivedChange={changeArchivedView}
            onSessionFilterChange={setSessionFilter}
            selectedSessionIds={selectedSessionIds}
            projectOrder={projectOrder}
            pinnedProjectKeys={pinnedProjectKeys}
            onSelectSession={(id, options) => {
              setActiveView("chat");
              selectSession(id, options);
            }}
            onSessionContextMenu={(sessionId, left, top, targetIds) =>
              {
                setProjectContextMenu(null);
                setSessionContextMenu({ sessionId, left, top, targetIds });
              }
            }
            onProjectContextMenu={(project, left, top) => {
              setSessionContextMenu(null);
              setProjectContextMenu({ ...project, left, top });
            }}
            onProjectReorder={(sourceKey, targetKey, visibleProjectKeys) =>
              reorderProject(sourceKey, targetKey, visibleProjectKeys)
            }
            onSyncNativeSessions={(mode) => void syncNativeSessions(mode)}
            onOpenSettings={() => {
              setSettingsOpen(true);
              refreshSettingsDiagnostics();
              void refreshAppSettings();
            }}
            onOpenAbout={() => setAboutOpen(true)}
          />
        )}

        <main
          className={
            "main" + (asideHidden || isOrchestrationView ? " main--aside-hidden" : "")
          }
        >
          <div
            className="main__top"
            data-tauri-drag-region
            onDoubleClick={() => void toggleMaximizeFromTitlebar()}
          >
            <div className="main__title-row" data-tauri-drag-region>
              {sidebarHidden ? (
                <button
                  type="button"
                  className="chrome-btn chrome-btn--traffic"
                  title="显示侧栏"
                  onClick={() => setSidebarHidden(false)}
                >
                  <IconPanelRight size={16} />
                </button>
              ) : null}
              {isOrchestrationView ? (
                <>
                  <IconGitFork size={16} />
                  <h1 className="main__title">编排</h1>
                  <span className="main__sub">半自动多 CLI 链路</span>
                </>
              ) : active ? (
                <>
                  <h1 className="main__title" data-tauri-drag-region>
                    {active.title}
                  </h1>
                  <span className={`status-dot ${stateDotClass(snapshot.state)}`} />
                  <span className="main__sub">
                    {snapshot.state} · {snapshot.backend}
                  </span>
                </>
              ) : (
                <>
                  <IconChat size={16} />
                  <button
                    type="button"
                    className="main__title main__title-button"
                    onClick={() => setAboutOpen(true)}
                    aria-label="查看 Workbench 应用信息"
                    title="关于 Workbench"
                  >
                    Workbench
                  </button>
                  <span className="main__sub">{statusLine}</span>
                </>
              )}
            </div>
            <div className="main__top-actions">
              <button
                type="button"
                className="chrome-btn"
                title={theme === "dark" ? "切换亮色" : "切换暗色"}
                onClick={() => setTheme((t) => toggleTheme(t))}
              >
                {theme === "dark" ? (
                  <IconThemeSun size={16} />
                ) : (
                  <IconThemeMoon size={16} />
                )}
              </button>
              {!isOrchestrationView ? (
                <button
                  type="button"
                  className={"chrome-btn" + (!asideHidden ? " is-on" : "")}
                  title={asideHidden ? "显示 Inspector" : "隐藏 Inspector"}
                  onClick={() => setAsideHidden((v) => !v)}
                >
                  <IconPanelRight size={16} />
                </button>
              ) : null}
            </div>
          </div>

          {isOrchestrationView ? (
            activeOrchestrationTask ? (
              <OrchestrationPage
                task={activeOrchestrationTask}
                onBackToChat={() => setActiveView("chat")}
                onTaskChange={updateOrchestrationTask}
                onRunWorkflow={(task) => void runWorkflow(task)}
                onOpenSession={openWorkflowSession}
                runningWorkflowId={runningWorkflowId}
              />
            ) : (
              <div className="empty-state">暂无编排任务</div>
            )
          ) : !active ? (
            <div className="empty-state">
              <div>
                <div className="empty-state__icon">
                  <img
                    className="app-logo app-logo--lg"
                    src="/logo.png"
                    alt=""
                    width={48}
                    height={48}
                    draggable={false}
                  />
                </div>
                <div className="empty-state__title">Workbench</div>
                <div>本机多 Agent 指挥台</div>
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  左侧选择引擎并新建会话 · Grok 已接真 ACP
                </div>
              </div>
            </div>
          ) : (
            <>
              <MessageList
                scrollRef={messageScrollRef}
                onScroll={handleMessageScroll}
                sessionKey={active.id}
                messages={messages}
                groups={visibleMessageGroups}
                empty={messages.length === 0}
                hiddenCount={hiddenMessageCount}
                onRevealOlder={revealOlderMessages}
                onRevealMessage={revealMessageForNavigation}
                fallbackRuntimeId={active.runtimeId ?? snapshot.runtimeId ?? null}
                assistantTypingUntil={assistantTypingUntil}
                turnStreaming={isActiveTurnStreaming}
                skills={skills}
                onTypingProgress={handleTypingProgress}
                onQuote={(target) => {
                  setQuoteTarget(target);
                  composerInputRef.current?.focus();
                  setStatusLine(`已引用 ${target.label}`);
                }}
              />

              {activePermissionRequest ? (
                <PermissionBar
                  request={activePermissionRequest}
                  pendingCount={pendingPermissionCount}
                  disabled={permissionActionsDisabled}
                  onRespond={(request, decision) =>
                    void respondPermission(request, decision)
                  }
                />
              ) : null}

              <ComposerPanel
                draft={draft}
                busy={busy}
                streaming={streaming}
                readOnly={active.archived}
                inputDisabled={composerInputDisabled}
                settingsChangeDisabled={settingsChangeDisabled}
                activeModelValue={activeModelValue}
                activeModelLabel={activeModelLabel}
                activeModelReasoningEffort={activeModelReasoningEffort}
                activePermissionMode={activePermissionMode}
                activeSupportsReasoningEffort={activeSupportsReasoningEffort}
                controlModelOptions={controlModelOptions}
                controlReasoningOptions={controlReasoningOptions}
                controlPermissionOptions={controlPermissionOptions}
                skills={skills}
                skillsLoading={skillsLoading}
                skillsError={skillsError}
                selectedSkillNames={selectedSkillNames}
                goalModeAvailable={activeGoalModeAvailable}
                goalModeActive={activeGoalMode}
                personalCenterAvailable={Boolean(appSettings?.personalCenter?.path?.trim())}
                personalCenterActive={Boolean(active.personalCenterEnabled)}
                personalCenterPath={
                  active.personalCenterPath ?? appSettings?.personalCenter?.path ?? null
                }
                runtimeUsageStatus={runtimeUsage}
                runtimeUsageLoading={runtimeUsageLoading}
                projectPath={active.projectPath ?? null}
                projectPathEditable={projectPathEditable}
                projectPathBusy={projectPathBusy}
                quoteTarget={quoteTarget}
                imageAttachments={imageAttachments}
                fileAttachments={fileAttachments}
                imagePasteEnabled={active.runtimeId === "codex"}
                composerInputRef={composerInputRef}
                onDraftChange={setDraft}
                onSend={() => void sendMessage()}
                onStop={() => void stopActive()}
                onClearQuote={() => setQuoteTarget(null)}
                onPasteImages={(files) => void pasteImageAttachments(files)}
                onRemoveImageAttachment={removeImageAttachment}
                onPickFiles={() => void pickComposerFiles()}
                onRemoveFileAttachment={removeFileAttachment}
                onInputFocus={handleComposerInputFocus}
                onModelChange={(value) =>
                  void updateActiveSessionSettings({ modelId: value })
                }
                onReasoningEffortChange={(value) =>
                  void updateActiveSessionSettings({
                    modelReasoningEffort: value,
                  })
                }
                onPermissionChange={(value) =>
                  void updateActiveSessionSettings({
                    permissionMode: value as PermissionMode,
                  })
                }
                onSkillSelect={insertSkill}
                onSkillRemove={(name) =>
                  setSelectedSkillNames((prev) =>
                    prev.filter((item) => skillKey(item) !== skillKey(name)),
                  )
                }
                onGoalModeToggle={() => {
                  if (!active || active.runtimeId !== "codex") return;
                  setGoalModeBySession((prev) => ({
                    ...prev,
                    [active.id]: !prev[active.id],
                  }));
                  requestAnimationFrame(() => composerInputRef.current?.focus());
                }}
                onPersonalCenterToggle={() => void toggleActivePersonalCenter()}
                onRefreshRuntimeUsage={() => void refreshRuntimeUsage()}
                onPickProjectPath={() => void pickActiveProjectDirectory()}
              />
            </>
          )}
        </main>

        {!isOrchestrationView ? (
          <SessionInspector
            hidden={asideHidden}
            active={active}
            snapshot={snapshot}
            messages={messages}
            permissionQueue={activePermissionQueue}
            activeRuntimeId={activeRuntimeId}
            activeModelLabel={activeModelLabel}
            activeModelReasoningEffort={activeModelReasoningEffort}
            activePermissionMode={activePermissionMode}
            appDataDir={appDataDir}
            statusLine={statusLine}
            onToggleMaximize={() => void toggleMaximizeFromTitlebar()}
          />
        ) : null}
      </div>

      <AppOverlays
        aboutOpen={aboutOpen}
        appVersion={APP_VERSION}
        appDevelopmentDate={APP_DEVELOPMENT_DATE}
        appRepositoryUrl={APP_REPOSITORY_URL}
        appDownloadUrl={APP_DOWNLOAD_URL}
        appDataDir={appDataDir}
        onCloseAbout={() => setAboutOpen(false)}
        onCopyAboutLink={(label, value) => void copyAboutLink(label, value)}
        settingsOpen={settingsOpen}
        settingsSection={settingsSection}
        uiFontSize={uiFontSize}
        runtimes={runtimes}
        probes={probes}
        appSettings={appSettings}
        settingsRuntimeBusy={settingsRuntimeBusy}
        settingsUsageBusy={settingsUsageBusy}
        settingsPersonalCenterBusy={settingsPersonalCenterBusy}
        routeDiagnosticsPanel={routeDiagnosticsPanel}
        statusLine={statusLine}
        onCloseSettings={() => setSettingsOpen(false)}
        onSettingsSectionChange={setSettingsSection}
        onFontSizeChange={changeUiFontSize}
        onRefreshSettingsDiagnostics={refreshSettingsDiagnostics}
        onSaveRuntimeCliPath={saveRuntimeCliPath}
        onClearRuntimeCliPath={clearRuntimeCliPath}
        onSaveCodexGatewayUsage={saveCodexGatewayUsage}
        onSaveDeepSeekUsage={saveDeepSeekUsage}
        onSavePersonalCenterPath={savePersonalCenterPath}
        onPickPersonalCenterPath={pickPersonalCenterPath}
        sessionContextMenu={sessionContextMenu}
        sessionContextTargetTitle={sessionContextTargetTitle}
        sessionContextTargetPinned={sessionContextTarget?.pinned ?? false}
        sessionContextTargetArchived={sessionContextTarget?.archived ?? false}
        sessionContextArchiveDisabled={sessionContextArchiveDisabled}
        sessionContextTargetCount={sessionContextTargetIds.length}
        sessionContextTargetIds={sessionContextTargetIds}
        sessionContextMenuRef={sessionContextMenuRef}
        projectContextMenu={projectContextMenu}
        projectContextMenuRef={projectContextMenuRef}
        onToggleProjectPinned={(projectKey, pinned, label) =>
          toggleProjectPinned(projectKey, pinned, label)
        }
        onRequestDeleteProjectSessions={(project) =>
          requestDeleteSessions(
            project.sessions.map((session) => session.id),
            {
              kind: "project",
              label: project.label,
              path: project.path,
            },
          )
        }
        onOpenSelectedSessionLocation={(sessionId) =>
          void openSelectedSessionLocation(sessionId)
        }
        onToggleSessionPinned={(sessionId, pinned) =>
          void toggleSessionPinned(sessionId, pinned)
        }
        onRequestRenameSession={requestRenameSession}
        onCopySessionId={(sessionId) => void copySessionId(sessionId)}
        onExportSessionMarkdown={(sessionId) => void exportSessionMarkdown(sessionId)}
        onExportSessionTrace={(sessionId) => void exportSessionTrace(sessionId)}
        onToggleSessionArchived={(sessionId, archived) =>
          void toggleSessionArchived(sessionId, archived)
        }
        onRequestDeleteSessions={(sessionIds) => requestDeleteSessions(sessionIds)}
        renameSessionId={renameSessionId}
        renameSessionTitle={renameSessionTitle}
        renameSessionBusy={renameSessionBusy}
        renameSessionError={renameSessionError}
        onRenameSessionTitleChange={(title) => {
          setRenameSessionTitle(title);
          setRenameSessionError(null);
        }}
        onCloseRename={closeRenameSession}
        onConfirmRename={() => void confirmRenameSession()}
        deleteSessionIds={deleteSessionIds}
        deleteDialogTitle={deleteDialogTitle}
        deleteDialogSub={deleteDialogSub}
        deleteDialogNote={deleteDialogNote}
        deleteTargetSessions={deleteTargetSessions}
        deleteTargetItems={deleteTargetItems}
        deleteSessionBusy={deleteSessionBusy}
        deleteSessionError={deleteSessionError}
        canDeleteWorkbenchOnly={canDeleteWorkbenchOnly}
        onCloseDelete={() => {
          setDeleteSessionError(null);
          setDeleteSessionIds([]);
          setDeleteSessionScope({ kind: "sessions" });
        }}
        onConfirmDelete={() => void confirmDeleteSession()}
        onConfirmDeleteWorkbenchOnly={() => void confirmDeleteSession("skip")}
      />
      <ToastViewport />
    </div>
  );
}
