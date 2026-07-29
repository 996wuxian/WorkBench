import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  WindowControls,
  toggleMaximizeFromTitlebar,
} from "./components/WindowControls";
import { MessageList } from "./components/MessageList";
import { PermissionBar } from "./components/PermissionBar";
import { SessionSidebar } from "./components/SessionSidebar";
import { ComposerPanel } from "./components/ComposerPanel";
import { SessionInspector } from "./components/SessionInspector";
import { AppOverlays } from "./components/AppOverlays";
import { ToastViewport } from "./components/Toast";
import type { SettingsSection } from "./components/SettingsDialog";
import {
  IconChat,
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
  CODEX_REASONING_OPTIONS,
  codexReasoningEffortFromModel,
  fallbackModelOptions,
  normalizeCodexModelId,
} from "./lib/codex";
import { nowIso, uid } from "./lib/format";
import {
  composeMessageText,
  finalizeAssistantMessage,
  normalizeLoadedMessages,
  toolMessageKey,
  type QuoteTarget,
} from "./lib/messages";
import { mockRuntimes, mockSessions } from "./lib/mocks";
import {
  defaultPermissionMode,
  fallbackPermissionOptions,
} from "./lib/permissions";
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
  CodexRouteStatus,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  ProbeResult,
  RuntimeId,
  RuntimeInfo,
  SessionMeta,
  SessionSelectionCatalog,
  SessionSnapshot,
  SessionState,
} from "./lib/types";
import {
  allRuntimes,
  hydrateRuntimes,
  runtimeInfo,
  runtimeLabel,
  sortRuntimes,
} from "./lib/runtimes";

const ASSISTANT_LOADING_TEXT = "thinking";
const INITIAL_VISIBLE_MESSAGES = 60;
const HISTORY_BATCH_SIZE = 40;
const CHAT_BOTTOM_THRESHOLD = 80;
const CHAT_TOP_THRESHOLD = 48;

function runtimeRouteMode(runtime: RuntimeInfo): string {
  if (!runtime.enabled) return "disabled";
  if (runtime.id === "claude") return "stream-json";
  if (runtime.id === "grok") return "native ACP";
  if (runtime.id === "kimi") return "ACP";
  return runtime.capabilities.protocol;
}

function runtimeConnectHint(runtimeId: RuntimeId): string {
  if (runtimeId === "claude") return "claude -p --output-format stream-json";
  if (runtimeId === "codex") return "codex app-server --stdio";
  if (runtimeId === "grok") return "grok agent stdio";
  if (runtimeId === "kimi") return "kimi acp";
  return "runtime manifest";
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
  return `Workbench 通过 ${runtime.capabilities.protocol} 协议连接 ${runtime.displayName}；具体命令和参数来自 runtime manifest，模型出口由该 CLI 自身处理。`;
}


export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [pendingSession, setPendingSession] = useState<SessionMeta | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(idleSnapshot());
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  /** Approvals still waiting on the user, keyed by session. */
  const [permissionQueue, setPermissionQueue] = useState<
    Record<string, PermissionRequestEvent[]>
  >({});
  const [permissionBusy, setPermissionBusy] = useState<string | null>(null);
  const [codexRoute, setCodexRoute] = useState<CodexRouteStatus | null>(null);
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
  const [quoteTarget, setQuoteTarget] = useState<QuoteTarget | null>(null);
  const [runtimePick, setRuntimePick] = useState<RuntimeId>(() =>
    loadRuntimePick(),
  );
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
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
  const [sessionFilter, setSessionFilter] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    sessionId: string;
    left: number;
    top: number;
  } | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [deleteSessionIds, setDeleteSessionIds] = useState<string[]>([]);
  const [deleteSessionBusy, setDeleteSessionBusy] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
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

  const active = useMemo(
    () =>
      sessions.find((s) => s.id === activeId) ??
      (pendingSession?.id === activeId ? pendingSession : null),
    [sessions, pendingSession, activeId],
  );
  const activeRuntimeId = active?.runtimeId ?? snapshot.runtimeId ?? runtimePick;
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
      if (message.role === "tool") {
        const previous = groups[groups.length - 1];
        if (previous?.message.role === "assistant") {
          const key = toolMessageKey(message);
          const existingIndex = previous.toolMessages.findIndex(
            (item) => toolMessageKey(item) === key,
          );
          if (existingIndex >= 0) {
            previous.toolMessages[existingIndex] = message;
          } else {
            previous.toolMessages.push(message);
          }
        } else {
          continue;
        }
        continue;
      }
      groups.push({ message, toolMessages: [] });
    }
    return groups;
  }, [visibleMessages]);
  const hiddenMessageCount = Math.max(0, messages.length - visibleMessages.length);
  const lastMessage = messages[messages.length - 1];
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
  const activeModelReasoningEffort = active?.runtimeId === "codex"
    ? (active?.modelReasoningEffort ??
        snapshot.modelReasoningEffort ??
        codexRoute?.modelReasoningEffort ??
        codexReasoningEffortFromModel(active?.modelId ?? snapshot.modelId) ??
        "high")
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
  const controlPermissionOptions = useMemo(
    () =>
      activeControlCatalog?.permissionOptions.length
        ? activeControlCatalog.permissionOptions
        : fallbackPermissionOptions(activeRuntimeId),
    [activeRuntimeId, activeControlCatalog],
  );
  const controlReasoningOptions = useMemo(
    () => CODEX_REASONING_OPTIONS,
    [],
  );
  const settingsChangeDisabled =
    !active || settingsBusy || !canChangeSessionSettings(snapshot.state);
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
    const scoped = sessions.filter((session) => session.runtimeId === runtimePick);
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
  }, [runtimePick, sessionFilter, sessions]);
  const activeSupportsReasoningEffort =
    runtimeInfo(activeRuntimeId)?.capabilities.reasoningEffort ?? false;
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
  const sessionsRef = useRef<SessionMeta[]>([]);
  const pendingSessionRef = useRef<SessionMeta | null>(null);
  const mockReplyTimerRef = useRef<number | null>(null);
  const sessionScrollRef = useRef<HTMLDivElement | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionContextMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionSelectionAnchorRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const pendingHistoryRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const assistantTypingTimersRef = useRef<Record<string, number>>({});
  const assistantTypingQueueRef = useRef<Record<string, string>>({});
  const assistantTypingSessionRef = useRef<Record<string, string>>({});

  const beginSessionActivation = useCallback((sessionId: string | null) => {
    const requestId = activationRequestRef.current + 1;
    activationRequestRef.current = requestId;
    activeIdRef.current = sessionId;
    setActiveId(sessionId);
    return requestId;
  }, []);

  const isCurrentSessionActivation = useCallback(
    (sessionId: string, requestId: number) =>
      activeIdRef.current === sessionId &&
      activationRequestRef.current === requestId,
    [],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    pendingSessionRef.current = pendingSession;
  }, [pendingSession]);

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
  }, [active?.id, active?.runtimeId, activeModelValue]);

  useEffect(() => {
    return () => {
      if (mockReplyTimerRef.current !== null) {
        window.clearTimeout(mockReplyTimerRef.current);
      }
    };
  }, []);

  const updateSessionMessages = useCallback(
    (sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: updater(prev[sessionId] ?? []),
      }));
    },
    [],
  );

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroll = () => {
      const el = messageScrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
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

  const handleMessageScroll = useCallback(() => {
    const el = messageScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= CHAT_BOTTOM_THRESHOLD;
    if (el.scrollTop <= CHAT_TOP_THRESHOLD && hiddenMessageCount > 0) {
      revealOlderMessages();
    }
  }, [hiddenMessageCount, revealOlderMessages]);

  const handleTypingProgress = useCallback(() => {
    if (!stickToBottomRef.current) return;
    scrollChatToBottom();
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
    });
  }, [visibleMessages.length]);

  useEffect(() => {
    if (!activeId || pendingHistoryRestoreRef.current) return;
    if (stickToBottomRef.current) {
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

  const refreshSessionMeta = useCallback(async (sessionId: string) => {
    if (!isTauri()) return;
    const session =
      sessionsRef.current.find((item) => item.id === sessionId) ??
      (pendingSessionRef.current?.id === sessionId ? pendingSessionRef.current : null);
    const runtimeId = session?.runtimeId;

    try {
      if (runtimeId === "grok" || runtimeId === "codex") {
        const result = await api.syncNativeSessions(runtimeId, SESSION_PAGE_SIZE, null);
        setSessions((prev) => mergeSessions(prev, result.sessions));
        setNativeCursors((prev) => ({
          ...prev,
          [runtimeId]: result.nextCursor ?? null,
        }));
        setNativeHasMore((prev) => ({
          ...prev,
          [runtimeId]: result.hasMore,
        }));
        setPendingSession((prev) =>
          prev && result.sessions.some((item) => item.id === prev.id) ? null : prev,
        );
        return;
      }

      const list = await api.listSessions();
      setSessions(list);
      setPendingSession((prev) =>
        prev && list.some((item) => item.id === prev.id) ? null : prev,
      );
    } catch (error) {
      try {
        const list = await api.listSessions();
        setSessions(list);
        setPendingSession((prev) =>
          prev && list.some((item) => item.id === prev.id) ? null : prev,
        );
      } catch {
        setStatusLine(`refresh session meta failed: ${String(error)}`);
      }
    }
  }, []);

  // Host → UI event fold. The listeners live in the hook; everything they need
  // is passed in, so App owns the state and the hook owns the protocol.
  useSessionEvents({
    activeSessionIdRef: activeIdRef,
    updateSessionMessages,
    setMessagesBySession,
    setSnapshot,
    setPermissionQueue,
    setPermissionBusy,
    setStatusLine,
    queueAssistantTyping,
    clearAssistantTypingForSession,
    refreshSessionMeta,
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
      if (list.length > 0) {
        const first = list[0];
        const requestId = beginSessionActivation(first.id);
        const [snap, storedMessages] = await Promise.all([
          api.getSnapshot(first.id),
          api.getMessages(first.id),
        ]);
        if (!isCurrentSessionActivation(first.id, requestId)) return;
        const restored = normalizeLoadedMessages(storedMessages);
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
        const [snap, storedMessages] = await Promise.all([
          api.getSnapshot(id),
          api.getMessages(id),
        ]);
        if (!isCurrentSessionActivation(id, requestId)) return;
        const restored = normalizeLoadedMessages(storedMessages);
        setSnapshot(snap);
        setMessagesBySession((prev) => ({
          ...prev,
          [id]: restored,
        }));
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

  const requestDeleteSessions = useCallback((sessionIds: string[]) => {
    const uniqueIds = Array.from(new Set(sessionIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;
    setSessionContextMenu(null);
    setDeleteSessionError(null);
    setDeleteSessionIds(uniqueIds);
  }, []);

  const confirmDeleteSession = useCallback(async () => {
    if (deleteSessionIds.length === 0 || deleteSessionBusy) return;
    if (!isTauri()) {
      setStatusLine("UI preview · delete unavailable");
      setDeleteSessionIds([]);
      return;
    }
    const sessionIds = deleteSessionIds;
    const targets = sessionIds
      .map(
        (sessionId) =>
          sessions.find((s) => s.id === sessionId) ??
          (pendingSession?.id === sessionId ? pendingSession : null),
      )
      .filter((session): session is SessionMeta => Boolean(session));
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
      setPendingSession((prev) =>
        prev && removedSessionIdSet.has(prev.id) ? null : prev,
      );
      const nextSessions = sessions.filter(
        (item) => !removedSessionIdSet.has(item.id),
      );
      setSessions(nextSessions);

      if (activeId && removedSessionIdSet.has(activeId)) {
        setQuoteTarget(null);
        if (nextSessions.length > 0) {
          const nextMeta = nextSessions[0];
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
        results.push(await deleteSessionById(sessionId));
        successfulSessionIds.push(sessionId);
      }
      setDeleteSessionIds([]);
      await applyDeletedSessions(sessionIds);

      setStatusLine(
        sessionIds.length === 1
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
      const message = `delete failed: ${String(e)}`;
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
    pendingSession,
    sessions,
  ]);

  const sessionContextTarget = useMemo(() => {
    if (!sessionContextMenu) return null;
    return (
      sessions.find((session) => session.id === sessionContextMenu.sessionId) ??
      (pendingSession?.id === sessionContextMenu.sessionId ? pendingSession : null)
    );
  }, [pendingSession, sessionContextMenu, sessions]);
  const sessionContextTargetIds = useMemo(() => {
    if (!sessionContextMenu) return [];
    return selectedSessionIds.includes(sessionContextMenu.sessionId)
      ? selectedSessionIds
      : [sessionContextMenu.sessionId];
  }, [selectedSessionIds, sessionContextMenu]);
  const sessionContextTargetTitle =
    sessionContextTargetIds.length > 1
      ? `已选择 ${sessionContextTargetIds.length} 个会话`
      : (sessionContextTarget?.title ?? "会话");

  useEffect(() => {
    sessionSelectionAnchorRef.current = null;
    setSelectedSessionIds([]);
  }, [runtimePick, sessionFilter]);

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
  const deleteTargetPath = deleteSessionIds
    .map((sessionId) => sessionPathFor(sessionId))
    .join("\n");

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
    const suppressGlobalContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".session-item")) {
        return;
      }
      event.preventDefault();
      setSessionContextMenu(null);
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

  async function createSession() {
    setBusy(true);
    try {
      setQuoteTarget(null);
      if (!isTauri()) {
        const meta: SessionMeta = {
          id: uid("sess"),
          title: `${runtimeLabel(runtimePick)} · 新会话`,
          runtimeId: runtimePick,
          projectPath: "X:\\1_2026_project\\work",
          modelId: runtimePick === "grok" ? "grok-4.5" : "default",
          modelReasoningEffort: runtimePick === "codex" ? "high" : null,
          permissionMode: defaultPermissionMode(runtimePick),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        setPendingSession(meta);
        beginSessionActivation(meta.id);
        setSnapshot(idleSnapshot(meta));
        resetChatViewport(meta.id, 0);
        updateSessionMessages(meta.id, () => []);
        return;
      }
      const meta = await api.createSession(runtimePick, null);
      setPendingSession(meta);
      const requestId = beginSessionActivation(meta.id);
      const snap = await api.getSnapshot(meta.id);
      if (!isCurrentSessionActivation(meta.id, requestId)) return;
      setSnapshot(snap);
      resetChatViewport(meta.id, 0);
      updateSessionMessages(meta.id, () => []);
    } catch (e) {
      setStatusLine(String(e));
    } finally {
      setBusy(false);
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

  async function sendMessage() {
    const body = draft.trim();
    if (!body || !active) return;
    const text = composeMessageText(quoteTarget, body);
    const session = active;
    setDraft("");
    stickToBottomRef.current = true;
    scrollChatToBottom("smooth");
    const userMsg: ChatMessage = {
      id: uid("u"),
      role: "user",
      content: text,
      runtimeId: session.runtimeId,
    };
    updateSessionMessages(session.id, (m) => [...m, userMsg]);

    if (!isTauri()) {
      updateSessionMessages(session.id, (m) => [
        ...m,
        {
          id: uid("a"),
          role: "assistant",
          content: ASSISTANT_LOADING_TEXT,
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
          const replyContent = `[${runtimeLabel(session.runtimeId)} stub]\n收到：${text}\n\n下一步会接入真实 Adapter（Grok ACP / Codex App Server）。`;
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
          content: ASSISTANT_LOADING_TEXT,
          runtimeId: session.runtimeId,
          streaming: true,
          pending: true,
          createdAt: nowIso(),
          completedAt: null,
        },
      ]);
      setSnapshot((s) => ({ ...s, state: "streaming" }));
      await api.send(session.id, text);
      const list = await api.listSessions();
      setSessions(list);
      setPendingSession((prev) => (prev?.id === session.id ? null : prev));
      setQuoteTarget(null);
    } catch (e) {
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

    if (!isTauri() && mockReplyTimerRef.current !== null) {
      window.clearTimeout(mockReplyTimerRef.current);
      mockReplyTimerRef.current = null;
    }

    const sessionId = active.id;
    updateSessionMessages(sessionId, (m) =>
      m
        .filter((msg) => !(msg.role === "assistant" && msg.pending))
        .map((msg) => (msg.streaming ? finalizeAssistantMessage(msg) : msg)),
    );
    setSnapshot((s) =>
      s.state === "streaming" || s.state === "awaiting_permission"
        ? { ...s, state: "ready" }
        : s,
    );
    setBusy(false);

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

  const streaming = snapshot.state === "streaming";
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
          <strong>{claudeRuntime?.capabilities.protocol ?? "claude_code"}</strong>
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
          <strong>{codexRuntime?.capabilities.protocol ?? "codex_app_server"}</strong>
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
            <strong>{runtime.capabilities.protocol}</strong>
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
  return (
    <div className="app-shell platform-win has-custom-chrome" data-theme={theme}>
      <WindowControls visible={isTauri()} />

      <div className="workbench">
        <SessionSidebar
          hidden={sidebarHidden}
          runtimePick={runtimePick}
          runtimePickOptions={runtimePickOptions}
          sessions={sessions}
          activeId={activeId}
          busy={busy}
          showSearch={showSearch}
          sessionFilter={sessionFilter}
          sessionScrollRef={sessionScrollRef}
          syncingRuntime={syncingRuntime}
          loadingMoreRuntime={loadingMoreRuntime}
          nativeHasMore={nativeHasMore}
          onHideSidebar={() => setSidebarHidden(true)}
          onToggleMaximize={() => void toggleMaximizeFromTitlebar()}
          onRuntimePickChange={setRuntimePick}
          onCreateSession={() => void createSession()}
          onToggleSearch={() => {
            setShowSearch((v) => !v);
            if (showSearch) setSessionFilter("");
          }}
          onSessionFilterChange={setSessionFilter}
          selectedSessionIds={selectedSessionIds}
          onSelectSession={(id, options) => selectSession(id, options)}
          onSessionContextMenu={(sessionId, left, top) =>
            setSessionContextMenu({ sessionId, left, top })
          }
          onSyncNativeSessions={(mode) => void syncNativeSessions(mode)}
          onOpenSettings={() => {
            setSettingsOpen(true);
            refreshSettingsDiagnostics();
            void refreshAppSettings();
          }}
        />

        <main className={"main" + (asideHidden ? " main--aside-hidden" : "")}>
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
              {active ? (
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
                  <h1 className="main__title">Workbench</h1>
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
              <button
                type="button"
                className={"chrome-btn" + (!asideHidden ? " is-on" : "")}
                title={asideHidden ? "显示 Inspector" : "隐藏 Inspector"}
                onClick={() => setAsideHidden((v) => !v)}
              >
                <IconPanelRight size={16} />
              </button>
            </div>
          </div>

          {!active ? (
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
                groups={visibleMessageGroups}
                empty={messages.length === 0}
                hiddenCount={hiddenMessageCount}
                onRevealOlder={revealOlderMessages}
                fallbackRuntimeId={active.runtimeId ?? snapshot.runtimeId ?? null}
                assistantTypingUntil={assistantTypingUntil}
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
                settingsChangeDisabled={settingsChangeDisabled}
                activeModelValue={activeModelValue}
                activeModelLabel={activeModelLabel}
                activeModelReasoningEffort={activeModelReasoningEffort}
                activePermissionMode={activePermissionMode}
                activeSupportsReasoningEffort={activeSupportsReasoningEffort}
                controlModelOptions={controlModelOptions}
                controlPermissionOptions={controlPermissionOptions}
                controlReasoningOptions={controlReasoningOptions}
                quoteTarget={quoteTarget}
                composerInputRef={composerInputRef}
                onDraftChange={setDraft}
                onSend={() => void sendMessage()}
                onStop={() => void stopActive()}
                onClearQuote={() => setQuoteTarget(null)}
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
              />
            </>
          )}
        </main>

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
      </div>

      <AppOverlays
        settingsOpen={settingsOpen}
        settingsSection={settingsSection}
        uiFontSize={uiFontSize}
        runtimes={runtimes}
        probes={probes}
        appSettings={appSettings}
        settingsRuntimeBusy={settingsRuntimeBusy}
        routeDiagnosticsPanel={routeDiagnosticsPanel}
        statusLine={statusLine}
        onCloseSettings={() => setSettingsOpen(false)}
        onSettingsSectionChange={setSettingsSection}
        onFontSizeChange={changeUiFontSize}
        onRefreshSettingsDiagnostics={refreshSettingsDiagnostics}
        onSaveRuntimeCliPath={saveRuntimeCliPath}
        onClearRuntimeCliPath={clearRuntimeCliPath}
        sessionContextMenu={sessionContextMenu}
        sessionContextTargetTitle={sessionContextTargetTitle}
        sessionContextTargetCount={sessionContextTargetIds.length}
        sessionContextTargetIds={sessionContextTargetIds}
        sessionContextMenuRef={sessionContextMenuRef}
        onOpenSelectedSessionLocation={(sessionId) =>
          void openSelectedSessionLocation(sessionId)
        }
        onRequestDeleteSessions={(sessionIds) => requestDeleteSessions(sessionIds)}
        deleteSessionIds={deleteSessionIds}
        deleteTargetSessions={deleteTargetSessions}
        deleteTargetPath={deleteTargetPath}
        deleteSessionBusy={deleteSessionBusy}
        deleteSessionError={deleteSessionError}
        onCloseDelete={() => {
          setDeleteSessionError(null);
          setDeleteSessionIds([]);
        }}
        onConfirmDelete={() => void confirmDeleteSession()}
      />
      <ToastViewport />
    </div>
  );
}
