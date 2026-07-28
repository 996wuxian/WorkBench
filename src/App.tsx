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
import { DoctorRail } from "./components/DoctorRail";
import { AppOverlays } from "./components/AppOverlays";
import {
  IconChat,
  IconPanelRight,
  IconRefresh,
  IconSettings,
  IconThemeMoon,
  IconThemeSun,
} from "./components/icons";
import { useSessionEvents } from "./hooks/useSessionEvents";
import { api, isTauri } from "./lib/api";
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
  stateDotClass,
} from "./lib/sessions";
import type {
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
  enabledRuntimes,
  hydrateRuntimes,
  runtimeInfo,
  runtimeLabel,
} from "./lib/runtimes";

const ASSISTANT_LOADING_TEXT = "thinking";
const INITIAL_VISIBLE_MESSAGES = 60;
const HISTORY_BATCH_SIZE = 40;
const CHAT_BOTTOM_THRESHOLD = 80;
const CHAT_TOP_THRESHOLD = 48;


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
  const [sessionFilter, setSessionFilter] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    sessionId: string;
    left: number;
    top: number;
  } | null>(null);
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [deleteSessionBusy, setDeleteSessionBusy] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
  const [syncingRuntime, setSyncingRuntime] = useState<RuntimeId | null>(null);
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
  const [appDataDir, setAppDataDir] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState(
    isTauri() ? "Connecting Host…" : "UI preview mode (no Tauri)",
  );

  // Keep native window fill in sync (boot + theme toggles already call applyTheme).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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
  const activeModelLabel = active
    ? activeModelValue || "default"
    : "default";
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
      (runtimes.length > 0 ? enabledRuntimes() : []).map((r) => ({
        id: r.id,
        label: r.displayName,
        hint: r.capabilities.protocol,
      })),
    [runtimes],
  );
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
  const sessionsRef = useRef<SessionMeta[]>([]);
  const pendingSessionRef = useRef<SessionMeta | null>(null);
  const mockReplyTimerRef = useRef<number | null>(null);
  const sessionScrollRef = useRef<HTMLDivElement | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionContextMenuRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const pendingHistoryRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const assistantTypingTimersRef = useRef<Record<string, number>>({});
  const assistantTypingQueueRef = useRef<Record<string, string>>({});
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

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
    }, duration);
  }, []);

  const queueAssistantTyping = useCallback((messageId: string, content: string) => {
    assistantTypingQueueRef.current[messageId] = content;
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(assistantTypingTimersRef.current)) {
        window.clearTimeout(timer);
      }
      assistantTypingTimersRef.current = {};
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
    setAssistantTypingUntil,
    setSnapshot,
    setPermissionQueue,
    setPermissionBusy,
    setStatusLine,
    queueAssistantTyping,
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
          runtimeId: "grok",
          found: true,
          path: "D:\\tools\\grok\\bin\\grok.exe",
          version: "0.2.111",
          detail: "browser mock",
        },
        {
          runtimeId: "codex",
          found: true,
          path: "D:\\codex\\codex.exe",
          version: "0.144.4",
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
        codexConfigPath: "C:\\Users\\kata\\.codex\\config.toml",
        modelProvider: "custom",
        model: "gpt-5.5",
        baseUrl: "http://127.0.0.1:15721/v1",
        wireApi: "responses",
        ccSwitchDir: "C:\\Users\\kata\\.cc-switch",
        ccSwitchDbPath: "C:\\Users\\kata\\.cc-switch\\cc-switch.db",
        ccSwitchLogPath: "C:\\Users\\kata\\.cc-switch\\logs\\cc-switch.log",
        latestForwardUrl: "https://api.999555999.com/v1/responses",
        latestForwardModel: "gpt-5.5",
        latestError: null,
        note: "Codex 通过 cc-switch 本地代理路由；Grok 保持原生 ACP，不走 cc-switch。",
      });
      return;
    }
    try {
      setCodexRoute(await api.codexRouteStatus());
    } catch (e) {
      setStatusLine(`codex route probe failed: ${String(e)}`);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    if (!isTauri()) {
      const list = mockSessions();
      setPendingSession(null);
      setSessions(list);
      setActiveId(list[0]?.id ?? null);
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
        setActiveId(first.id);
        const snap = await api.getSnapshot(first.id);
        setSnapshot(snap);
        const restored = normalizeLoadedMessages(await api.getMessages(first.id));
        setMessagesBySession((prev) => ({
          ...prev,
          [first.id]: restored,
        }));
        resetChatViewport(first.id, restored.length);
      } else {
        setActiveId(null);
        setSnapshot(idleSnapshot());
      }
    } catch (e) {
      setStatusLine(`host error: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    // Runtimes first: labels, default modes and the engine picker all read the
    // registry, and sessions render as raw ids until it has landed.
    void refreshRuntimes().then(() => {
      void loadSessions();
    });
    void refreshProbes();
    void refreshCodexRoute();
  }, [loadSessions, refreshProbes, refreshCodexRoute, refreshRuntimes]);

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
      setActiveId(id);
      setQuoteTarget(null);
      const meta = metaOverride ?? sessions.find((s) => s.id === id) ?? null;
      if (!isTauri()) {
        setSnapshot(idleSnapshot(meta));
        resetChatViewport(id, messagesBySession[id]?.length ?? 0);
        return;
      }
      try {
        const snap = await api.getSnapshot(id);
        setSnapshot(snap);
        const restored = normalizeLoadedMessages(await api.getMessages(id));
        setMessagesBySession((prev) => ({
          ...prev,
          [id]: restored,
        }));
        resetChatViewport(id, restored.length);
      } catch (e) {
        setStatusLine(String(e));
      }
    },
    [messagesBySession, resetChatViewport, sessions],
  );

  async function selectSession(id: string) {
    void activateSession(id);
  }

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

  const requestDeleteSession = useCallback((sessionId: string) => {
    setSessionContextMenu(null);
    setDeleteSessionError(null);
    setDeleteSessionId(sessionId);
  }, []);

  const confirmDeleteSession = useCallback(async () => {
    if (!deleteSessionId || deleteSessionBusy) return;
    if (!isTauri()) {
      setStatusLine("UI preview · delete unavailable");
      setDeleteSessionId(null);
      return;
    }
    const sessionId = deleteSessionId;
    const target = sessions.find((s) => s.id === sessionId) ?? pendingSession;
    const removedMessages = messagesBySession[sessionId] ?? [];
    setDeleteSessionBusy(true);
    setDeleteSessionError(null);
    try {
      const result = await deleteSessionById(sessionId);
      setDeleteSessionId(null);
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setAssistantTypingUntil((prev) => {
        const next = { ...prev };
        for (const message of removedMessages) {
          delete next[message.id];
        }
        return next;
      });
      setPendingSession((prev) => (prev?.id === sessionId ? null : prev));
      const nextSessions = sessions.filter((item) => item.id !== sessionId);
      setSessions(nextSessions);

      if (result.activeSessionId) {
        const nextMeta =
          nextSessions.find((item) => item.id === result.activeSessionId) ??
          nextSessions[0] ??
          null;
        if (nextMeta) {
          await activateSession(nextMeta.id, nextMeta);
        } else {
          setActiveId(null);
          setSnapshot(idleSnapshot());
        }
      } else if (activeId === sessionId) {
        if (nextSessions.length > 0) {
          const nextMeta = nextSessions[0];
          await activateSession(nextMeta.id, nextMeta);
        } else {
          setActiveId(null);
          setSnapshot(idleSnapshot());
        }
      }

      setStatusLine(
        `deleted session${target ? ` · ${target.title}` : ""} · ${result.deletedPath}`,
      );
      setQuoteTarget((prev) => (prev?.messageId === sessionId ? null : prev));
    } catch (e) {
      const message = `delete failed: ${String(e)}`;
      setDeleteSessionError(message);
      setStatusLine(message);
    } finally {
      setDeleteSessionBusy(false);
    }
  }, [
    activateSession,
    activeId,
    deleteSessionBusy,
    deleteSessionId,
    messagesBySession,
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

  const sessionPathFor = useCallback(
    (sessionId: string) =>
      appDataDir ? `${appDataDir}\\sessions\\${sessionId}` : sessionId,
    [appDataDir],
  );

  const deleteTargetSession = useMemo(() => {
    if (!deleteSessionId) return null;
    return (
      sessions.find((session) => session.id === deleteSessionId) ??
      (pendingSession?.id === deleteSessionId ? pendingSession : null)
    );
  }, [deleteSessionId, pendingSession, sessions]);

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
        setActiveId(meta.id);
        setSnapshot(idleSnapshot(meta));
        resetChatViewport(meta.id, 0);
        updateSessionMessages(meta.id, () => []);
        return;
      }
      const meta = await api.createSession(runtimePick, null);
      setPendingSession(meta);
      setActiveId(meta.id);
      const snap = await api.getSnapshot(meta.id);
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
          queueAssistantTyping(replyId, replyContent);
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
      await api.stop(active.id);
      const snap = await api.getSnapshot(active.id);
      setSnapshot(snap);
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
  const routeDiagnosticsPanel = (
    <>
      <div className="probe-card">
        <div className="probe-card__row">
          <strong>Codex 路由</strong>
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
          <span>provider</span>
          <strong>{codexRoute?.modelProvider ?? "—"}</strong>
        </div>
        <div className="route-kv">
          <span>model</span>
          <strong>{codexRoute?.model ?? codexRoute?.latestForwardModel ?? "—"}</strong>
        </div>
        <div className="route-kv">
          <span>base_url</span>
          <strong>{codexRoute?.baseUrl ?? "—"}</strong>
        </div>
        <div className="route-kv">
          <span>wire_api</span>
          <strong>{codexRoute?.wireApi ?? "—"}</strong>
        </div>
        {codexRoute?.latestForwardUrl ? (
          <div className="route-kv">
            <span>forward</span>
            <strong>{codexRoute.latestForwardUrl}</strong>
          </div>
        ) : null}
        {codexRoute?.latestError ? (
          <div className="route-note route-note--warn">
            {codexRoute.latestError}
          </div>
        ) : null}
        <div className="route-note">{codexRoute?.note ?? "正在检测 Codex 路由。"}</div>
        <div className="route-actions">
          <button
            type="button"
            className="chip chip--btn"
            onClick={() => void refreshCodexRoute()}
          >
            <IconRefresh size={13} />
            刷新
          </button>
          <button
            type="button"
            className="chip chip--btn"
            onClick={async () => {
              try {
                setStatusLine(await api.openCcSwitch());
              } catch (e) {
                setStatusLine(String(e));
              }
            }}
          >
            <IconSettings size={13} />
            打开 cc-switch
          </button>
        </div>
      </div>
      <div className="probe-card">
        <div className="probe-card__row">
          <strong>Grok 路由</strong>
          <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
            native
          </span>
        </div>
        <div className="route-note">
          Grok 使用原生 ACP 会话，不读取也不经过 cc-switch。
        </div>
      </div>
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
          onSelectSession={(id) => void selectSession(id)}
          onSessionContextMenu={(sessionId, left, top) =>
            setSessionContextMenu({ sessionId, left, top })
          }
          onSyncNativeSessions={(mode) => void syncNativeSessions(mode)}
          onOpenSettings={() => {
            setSettingsOpen(true);
            void refreshCodexRoute();
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
                title={asideHidden ? "显示 Doctor" : "隐藏 Doctor"}
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
                onStatus={setStatusLine}
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
                runtimeId={active.runtimeId}
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

        <DoctorRail
          hidden={asideHidden}
          probes={probes}
          routeDiagnosticsPanel={routeDiagnosticsPanel}
          statusLine={statusLine}
          onToggleMaximize={() => void toggleMaximizeFromTitlebar()}
          onRefresh={() => {
            void refreshProbes();
            void refreshCodexRoute();
          }}
        />
      </div>

      <AppOverlays
        settingsOpen={settingsOpen}
        routeDiagnosticsPanel={routeDiagnosticsPanel}
        onCloseSettings={() => setSettingsOpen(false)}
        sessionContextMenu={sessionContextMenu}
        sessionContextTargetTitle={sessionContextTarget?.title ?? "会话"}
        sessionContextMenuRef={sessionContextMenuRef}
        onOpenSelectedSessionLocation={(sessionId) =>
          void openSelectedSessionLocation(sessionId)
        }
        onRequestDeleteSession={(sessionId) => requestDeleteSession(sessionId)}
        deleteSessionId={deleteSessionId}
        deleteTargetSession={deleteTargetSession}
        deleteTargetPath={deleteSessionId ? sessionPathFor(deleteSessionId) : ""}
        deleteSessionBusy={deleteSessionBusy}
        deleteSessionError={deleteSessionError}
        onCloseDelete={() => {
          setDeleteSessionError(null);
          setDeleteSessionId(null);
        }}
        onConfirmDelete={() => void confirmDeleteSession()}
      />
    </div>
  );
}
