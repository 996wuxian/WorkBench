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
import { copyTextToClipboard, nowIso, uid } from "./lib/format";
import { emitToast } from "./lib/toast";
import { notifySessionResult } from "./lib/sessionNotifications";
import {
  composeMessageText,
  finalizeStreamingMessage,
  normalizeLoadedMessages,
  restoreSessionMessages,
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
  SessionUnreadKind,
  SkillInfo,
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
  const [sessionSnapshots, setSessionSnapshots] = useState<
    Record<string, SessionSnapshot>
  >({});
  const [sessionUnread, setSessionUnread] = useState<
    Record<string, SessionUnreadKind>
  >({});
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
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<QuoteTarget | null>(null);
  const [runtimePick, setRuntimePick] = useState<RuntimeId>(() =>
    loadRuntimePick(),
  );
  const [busy, setBusy] = useState(false);
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
  const [sessionFilter, setSessionFilter] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    sessionId: string;
    left: number;
    top: number;
  } | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [deleteSessionIds, setDeleteSessionIds] = useState<string[]>([]);
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

  const active = useMemo(
    () =>
      sessions.find((s) => s.id === activeId) ??
      (pendingSession?.id === activeId ? pendingSession : null),
    [sessions, pendingSession, activeId],
  );
  const activeRuntimeId = active?.runtimeId ?? snapshot.runtimeId ?? runtimePick;

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
  const messageNavigationLockUntilRef = useRef(0);
  const assistantTypingTimersRef = useRef<Record<string, number>>({});
  const assistantTypingQueueRef = useRef<Record<string, string>>({});
  const assistantTypingSessionRef = useRef<Record<string, string>>({});
  const sessionUnreadRef = useRef<Record<string, SessionUnreadKind>>({});
  const notifiedSessionResultRef = useRef<Record<string, SessionUnreadKind>>({});

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
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: updater(prev[sessionId] ?? []),
      }));
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

  const revealMessageForNavigation = useCallback(
    (messageIndex: number) => {
      if (!activeId || messageIndex < 0 || messageIndex >= messages.length) return;
      messageNavigationLockUntilRef.current = performance.now() + 1400;
      pendingHistoryRestoreRef.current = null;
      stickToBottomRef.current = false;
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
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= CHAT_BOTTOM_THRESHOLD;
    if (
      performance.now() >= messageNavigationLockUntilRef.current &&
      el.scrollTop <= CHAT_TOP_THRESHOLD &&
      hiddenMessageCount > 0
    ) {
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

  async function createSession(projectPathOverride?: string | null) {
    setBusy(true);
    try {
      setShowArchived(false);
      setQuoteTarget(null);
      const projectPath = projectPathOverride?.trim() || null;
      if (!isTauri()) {
        const meta: SessionMeta = {
          id: uid("sess"),
          title: `${runtimeLabel(runtimePick)} · 新会话`,
          pinned: false,
          archived: false,
          runtimeId: runtimePick,
          projectPath,
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
      const meta = await api.createSession(runtimePick, projectPath);
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

  function insertSkill(name: string) {
    const input = composerInputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    // Codex uses `$skill-name`; Grok/Claude/Kimi accept slash invocation.
    const prefix = activeRuntimeId === "codex" ? "$" : "/";
    const token = `${prefix}${name} `;
    const next = `${draft.slice(0, start)}${token}${draft.slice(end)}`;
    setDraft(next);
    requestAnimationFrame(() => {
      input?.focus();
      const caret = start + token.length;
      input?.setSelectionRange(caret, caret);
    });
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || !active) return;
    if (active.archived) {
      setStatusLine("请先恢复归档会话再继续发送");
      return;
    }
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
        .map(finalizeStreamingMessage),
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
          sessionSnapshots={sessionSnapshots}
          sessionUnread={sessionUnread}
          activeId={activeId}
          busy={busy}
          showSearch={showSearch}
          showArchived={showArchived}
          sessionFilter={sessionFilter}
          sessionScrollRef={sessionScrollRef}
          syncingRuntime={syncingRuntime}
          loadingMoreRuntime={loadingMoreRuntime}
          nativeHasMore={nativeHasMore}
          onHideSidebar={() => setSidebarHidden(true)}
          onToggleMaximize={() => void toggleMaximizeFromTitlebar()}
          onRuntimePickChange={setRuntimePick}
          onCreateSession={(projectPath) => void createSession(projectPath)}
          onToggleSearch={() => {
            setShowSearch((v) => !v);
            if (showSearch) setSessionFilter("");
          }}
          onShowArchivedChange={changeArchivedView}
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
                sessionKey={active.id}
                messages={messages}
                groups={visibleMessageGroups}
                empty={messages.length === 0}
                hiddenCount={hiddenMessageCount}
                onRevealOlder={revealOlderMessages}
                onRevealMessage={revealMessageForNavigation}
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
                readOnly={active.archived}
                settingsChangeDisabled={settingsChangeDisabled}
                activeModelValue={activeModelValue}
                activeModelLabel={activeModelLabel}
                activeModelReasoningEffort={activeModelReasoningEffort}
                activePermissionMode={activePermissionMode}
                activeSupportsReasoningEffort={activeSupportsReasoningEffort}
                controlModelOptions={controlModelOptions}
                controlPermissionOptions={controlPermissionOptions}
                controlReasoningOptions={controlReasoningOptions}
                skills={skills}
                skillsLoading={skillsLoading}
                skillsError={skillsError}
                projectPath={active.projectPath ?? null}
                projectPathEditable={projectPathEditable}
                projectPathBusy={projectPathBusy}
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
                onSkillSelect={insertSkill}
                onPickProjectPath={() => void pickActiveProjectDirectory()}
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
        sessionContextTargetPinned={sessionContextTarget?.pinned ?? false}
        sessionContextTargetArchived={sessionContextTarget?.archived ?? false}
        sessionContextArchiveDisabled={sessionContextArchiveDisabled}
        sessionContextTargetCount={sessionContextTargetIds.length}
        sessionContextTargetIds={sessionContextTargetIds}
        sessionContextMenuRef={sessionContextMenuRef}
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
