import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { RuntimeSelect, type RuntimeOption } from "./RuntimeSelect";
import {
  IconArchive,
  IconArchiveOff,
  IconChevronDown,
  IconChevronRight,
  IconChevronsDown,
  IconChevronsUp,
  IconFolder,
  IconGitFork,
  IconNewChat,
  IconPanel,
  IconPinnedFilled,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
} from "./icons";
import { formatSessionTime } from "../lib/format";
import {
  sessionDisplaySummary,
  sessionDisplayTitle,
  sessionProcessStats,
  sessionStateLabel,
  stateDotClass,
} from "../lib/sessions";
import { runtimeLabel } from "../lib/runtimes";
import type {
  RuntimeId,
  SessionMeta,
  SessionSnapshot,
  SessionUnreadKind,
} from "../lib/types";

type SessionProjectGroup = {
  key: string;
  label: string;
  path: string | null;
  sessions: SessionMeta[];
};

export type ProjectContextTarget = SessionProjectGroup & {
  pinned: boolean;
};

const OTHER_PROJECT_KEY = "__other_sessions__";

function normalizeProjectKey(projectPath: string): string {
  return projectPath.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function projectLabel(projectPath: string): string {
  const clean = projectPath.trim().replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).filter(Boolean).at(-1) ?? clean;
}

type Props = {
  hidden: boolean;
  runtimePick: RuntimeId;
  runtimePickOptions: RuntimeOption[];
  sessions: SessionMeta[];
  sessionSnapshots: Record<string, SessionSnapshot>;
  sessionUnread: Record<string, SessionUnreadKind>;
  activeId: string | null;
  busy: boolean;
  showSearch: boolean;
  showArchived: boolean;
  sessionFilter: string;
  sessionScrollRef: RefObject<HTMLDivElement | null>;
  orchestrationActive: boolean;
  syncingRuntime: RuntimeId | null;
  loadingMoreRuntime: RuntimeId | null;
  nativeHasMore: Partial<Record<RuntimeId, boolean>>;
  onHideSidebar: () => void;
  onToggleMaximize: () => void;
  onRuntimePickChange: (id: RuntimeId) => void;
  onCreateSession: (projectPath?: string | null) => void;
  onOpenOrchestration: () => void;
  onToggleSearch: () => void;
  onShowArchivedChange: (showArchived: boolean) => void;
  onSessionFilterChange: (value: string) => void;
  selectedSessionIds: string[];
  projectOrder: string[];
  pinnedProjectKeys: string[];
  onSelectSession: (
    sessionId: string,
    options: { shiftKey: boolean; visibleSessionIds: string[] },
  ) => void;
  onSessionContextMenu: (
    sessionId: string,
    left: number,
    top: number,
    targetIds: string[],
  ) => void;
  onProjectContextMenu: (project: ProjectContextTarget, left: number, top: number) => void;
  onProjectReorder: (
    sourceKey: string,
    targetKey: string,
    visibleProjectKeys: string[],
  ) => void;
  onSyncNativeSessions: (mode: "reset" | "more") => void;
  onOpenSettings: () => void;
};

export function SessionSidebar({
  hidden,
  runtimePick,
  runtimePickOptions,
  sessions,
  sessionSnapshots,
  sessionUnread,
  activeId,
  busy,
  showSearch,
  showArchived,
  sessionFilter,
  sessionScrollRef,
  orchestrationActive,
  syncingRuntime,
  loadingMoreRuntime,
  nativeHasMore,
  onHideSidebar,
  onToggleMaximize,
  onRuntimePickChange,
  onCreateSession,
  onOpenOrchestration,
  onToggleSearch,
  onShowArchivedChange,
  onSessionFilterChange,
  selectedSessionIds,
  projectOrder,
  pinnedProjectKeys,
  onSelectSession,
  onSessionContextMenu,
  onProjectContextMenu,
  onProjectReorder,
  onSyncNativeSessions,
  onOpenSettings,
}: Props) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [draggingProjectKey, setDraggingProjectKey] = useState<string | null>(null);
  const [dragOverProjectKey, setDragOverProjectKey] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointerIdRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressProjectToggleRef = useRef<string | null>(null);
  const runtimeSessions = useMemo(
    () => sessions.filter((session) => session.runtimeId === runtimePick),
    [runtimePick, sessions],
  );
  const scopedSessions = useMemo(
    () => runtimeSessions.filter((session) => session.archived === showArchived),
    [runtimeSessions, showArchived],
  );
  const liveSessions = useMemo(
    () => runtimeSessions.filter((session) => !session.archived),
    [runtimeSessions],
  );
  const filteredSessions = useMemo(() => {
    const q = sessionFilter.trim().toLowerCase();
    if (!q) return scopedSessions;
    return scopedSessions.filter(
      (session) =>
        sessionDisplayTitle(session).toLowerCase().includes(q) ||
        (sessionDisplaySummary(session) ?? "").toLowerCase().includes(q) ||
        session.runtimeId.includes(q) ||
        (session.modelId ?? "").toLowerCase().includes(q) ||
        (session.nativeSessionId ?? "").toLowerCase().includes(q) ||
        (session.nativeThreadId ?? "").toLowerCase().includes(q) ||
        (session.projectPath ?? "").toLowerCase().includes(q),
    );
  }, [scopedSessions, sessionFilter]);
  const projectGroups = useMemo<SessionProjectGroup[]>(() => {
    const groups = new Map<string, SessionProjectGroup>();
    for (const session of filteredSessions) {
      const path = session.projectPath?.trim() || null;
      const key = path ? normalizeProjectKey(path) : OTHER_PROJECT_KEY;
      const existing = groups.get(key);
      if (existing) {
        existing.sessions.push(session);
        continue;
      }
      groups.set(key, {
        key,
        label: path ? projectLabel(path) : "其他会话",
        path,
        sessions: [session],
      });
    }
    const pinnedSet = new Set(pinnedProjectKeys);
    const orderIndex = new Map(projectOrder.map((key, index) => [key, index]));
    return [...groups.values()].sort((a, b) => {
      const aPinned = pinnedSet.has(a.key);
      const bPinned = pinnedSet.has(b.key);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      const aIndex = orderIndex.get(a.key);
      const bIndex = orderIndex.get(b.key);
      if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
      if (aIndex !== undefined) return -1;
      if (bIndex !== undefined) return 1;
      if (a.key === OTHER_PROJECT_KEY) return 1;
      if (b.key === OTHER_PROJECT_KEY) return -1;
      return a.label.localeCompare(b.label, "zh-CN");
    });
  }, [filteredSessions, pinnedProjectKeys, projectOrder]);
  const projectKeys = useMemo(
    () => projectGroups.map((group) => group.key),
    [projectGroups],
  );
  const visibleSessionIds = useMemo(
    () =>
      projectGroups.flatMap((group) => {
        const collapsed = !sessionFilter.trim() && collapsedProjects.has(group.key);
        return collapsed ? [] : group.sessions.map((session) => session.id);
      }),
    [collapsedProjects, projectGroups, sessionFilter],
  );
  const selectedSessionIdSet = useMemo(
    () => new Set(selectedSessionIds),
    [selectedSessionIds],
  );
  const runtimeSessionCount = scopedSessions.length;
  const processStats = useMemo(
    () => sessionProcessStats(liveSessions, sessionSnapshots),
    [liveSessions, sessionSnapshots],
  );
  const loadingMore = loadingMoreRuntime === runtimePick;
  const syncing = syncingRuntime === runtimePick;
  const hasMore = nativeHasMore[runtimePick];
  const allProjectGroupsCollapsed =
    projectGroups.length > 0 &&
    projectGroups.every((group) => collapsedProjects.has(group.key));
  const activeProjectKey = useMemo(() => {
    const activeSession = sessions.find((session) => session.id === activeId);
    const path = activeSession?.projectPath?.trim();
    return path ? normalizeProjectKey(path) : activeSession ? OTHER_PROJECT_KEY : null;
  }, [activeId, sessions]);

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!activeProjectKey) return;
    setCollapsedProjects((current) => {
      const next = new Set(projectKeys.filter((key) => key !== activeProjectKey));
      if (
        next.size === current.size &&
        [...next].every((key) => current.has(key))
      ) {
        return current;
      }
      return next;
    });
  }, [activeProjectKey, projectKeys]);

  const handleScroll = () => {
    const el = sessionScrollRef.current;
    if (!el) return;
    setShowScrollTop(el.scrollTop > 96);
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    if (!nearBottom) return;
    if (hasMore === false) return;
    if (loadingMore || syncing) return;
    onSyncNativeSessions("more");
  };

  useEffect(() => {
    const el = sessionScrollRef.current;
    setShowScrollTop(Boolean(el && el.scrollTop > 96));
  }, [sessionScrollRef, runtimePick, showArchived, sessionFilter, filteredSessions.length]);

  const scrollSessionsToTop = () => {
    sessionScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const clearProjectLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPointerIdRef.current = null;
    longPressStartRef.current = null;
  };

  const findProjectKeyAtPoint = (clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY);
    return element?.closest<HTMLElement>("[data-project-key]")?.dataset.projectKey ?? null;
  };

  const beginProjectLongPress = (
    event: ReactPointerEvent<HTMLElement>,
    group: SessionProjectGroup,
  ) => {
    if (event.button !== 0 || projectGroups.length < 2) return;
    clearProjectLongPress();
    const target = event.currentTarget;
    longPressPointerIdRef.current = event.pointerId;
    longPressStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      suppressProjectToggleRef.current = group.key;
      setDraggingProjectKey(group.key);
      setDragOverProjectKey(group.key);
      target.setPointerCapture?.(event.pointerId);
    }, 360);
  };

  const moveProjectDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const start = longPressStartRef.current;
    if (
      start &&
      longPressTimerRef.current !== null &&
      Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 10
    ) {
      clearProjectLongPress();
      return;
    }
    if (!draggingProjectKey) return;
    event.preventDefault();
    const overKey = findProjectKeyAtPoint(event.clientX, event.clientY);
    if (overKey && projectKeys.includes(overKey)) {
      setDragOverProjectKey(overKey);
    }
  };

  const finishProjectDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const sourceKey = draggingProjectKey;
    const targetKey = dragOverProjectKey;
    if (longPressPointerIdRef.current === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    clearProjectLongPress();
    setDraggingProjectKey(null);
    setDragOverProjectKey(null);
    if (sourceKey && targetKey && sourceKey !== targetKey) {
      onProjectReorder(sourceKey, targetKey, projectKeys);
    }
  };

  const cancelProjectDrag = () => {
    clearProjectLongPress();
    setDraggingProjectKey(null);
    setDragOverProjectKey(null);
  };

  const toggleProjectCollapsed = (groupKey: string) => {
    if (suppressProjectToggleRef.current === groupKey) {
      suppressProjectToggleRef.current = null;
      return;
    }
    setCollapsedProjects((current) => {
      if (!current.has(groupKey)) {
        return new Set(projectKeys);
      }
      return new Set(projectKeys.filter((key) => key !== groupKey));
    });
  };

  const renderSession = (session: SessionMeta) => {
    const displayTitle = sessionDisplayTitle(session);
    const displaySummary = sessionDisplaySummary(session);
    const sessionSnapshot = sessionSnapshots[session.id];
    const state = sessionSnapshot?.state ?? "idle";
    const stateLabel = sessionStateLabel(sessionSnapshot);
    const unread = sessionUnread[session.id];
    return (
      <button
        type="button"
        key={session.id}
        className={
          "session-item" +
          (activeId === session.id ? " session-item--active" : "") +
          (selectedSessionIdSet.has(session.id) ? " session-item--selected" : "")
        }
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const targetIds = selectedSessionIdSet.has(session.id)
            ? visibleSessionIds.filter((id) => selectedSessionIdSet.has(id))
            : [session.id];
          onSessionContextMenu(
            session.id,
            Math.max(8, Math.min(ev.clientX, window.innerWidth - 252)),
            Math.max(8, Math.min(ev.clientY, window.innerHeight - 440)),
            targetIds,
          );
        }}
        onClick={(ev) =>
          onSelectSession(session.id, {
            shiftKey: ev.shiftKey,
            visibleSessionIds,
          })
        }
      >
        <span className={`runtime-dot runtime-dot--${session.runtimeId}`} />
        <span className="session-item__body">
          <span className="session-item__topline">
            <span className="session-item__title">{displayTitle}</span>
            {session.pinned ? (
              <span className="session-item__pin">
                <IconPinnedFilled size={14} title="已置顶" />
              </span>
            ) : null}
            <span className="session-item__time">
              {formatSessionTime(session.nativeUpdatedAt ?? session.updatedAt)}
            </span>
          </span>
          {displaySummary ? (
            <span className="session-item__summary">{displaySummary}</span>
          ) : null}
          <span className="session-item__status-row">
            <span className="session-item__state" title={`Host 状态：${stateLabel}`}>
              <span className={`status-dot ${stateDotClass(state)}`} aria-hidden="true" />
              {stateLabel}
            </span>
            {unread ? (
              <span
                className={`session-item__unread session-item__unread--${unread}`}
                aria-label={unread === "completed" ? "后台会话已完成" : "后台会话发生错误"}
              >
                {unread === "completed" ? "完成" : "异常"}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    );
  };

  return (
    <aside className={"sidebar" + (hidden ? " sidebar--hidden" : "")} aria-hidden={hidden}>
      <div
        className="sidebar-brand-row"
        data-tauri-drag-region
        onDoubleClick={onToggleMaximize}
      >
        <div className="sidebar-brand-row__left" data-tauri-drag-region>
          <img
            className="app-logo"
            src="/logo.png"
            alt=""
            width={28}
            height={28}
            draggable={false}
          />
          <span data-tauri-drag-region>Workbench</span>
        </div>
        <button
          type="button"
          className="chrome-btn chrome-btn--traffic is-on"
          title="隐藏侧栏"
          aria-label="隐藏侧栏"
          onClick={onHideSidebar}
        >
          <IconPanel size={16} />
        </button>
      </div>

      <div className="sidebar-nav">
        <div className="sidebar-runtime-pick">
          <RuntimeSelect
            value={runtimePick}
            onChange={onRuntimePickChange}
            aria-label="默认引擎"
            title="新建会话使用的引擎"
            options={runtimePickOptions}
          />
        </div>
        <div className="sidebar-nav__new-row">
          <button
            type="button"
            className="nav-new"
            disabled={busy}
            onClick={() => onCreateSession()}
          >
            <span className="nav-item__icon">
              <IconNewChat size={16} />
            </span>
            新建会话
          </button>
          <button
            type="button"
            className={"chrome-btn" + (showSearch ? " is-on" : "")}
            title="搜索会话"
            onClick={onToggleSearch}
          >
            <IconSearch size={16} />
          </button>
        </div>
        <button
          type="button"
          className={"nav-orchestration" + (orchestrationActive ? " is-active" : "")}
          onClick={onOpenOrchestration}
        >
          <span className="nav-item__icon">
            <IconGitFork size={16} />
          </span>
          编排
        </button>
      </div>

      {showSearch ? (
        <div className="session-filter">
          <input
            className="session-filter__input"
            aria-label="过滤会话"
            placeholder={showArchived ? "过滤归档会话…" : "过滤会话…"}
            value={sessionFilter}
            onChange={(e) => onSessionFilterChange(e.target.value)}
            autoFocus
          />
        </div>
      ) : null}

      <div className="sidebar__section-row">
        <div className="sidebar__section-head">
          <div className="sidebar__section-label">
            {showArchived ? "Archived" : "Sessions"}
          </div>
          {showArchived ? (
            <div className="sidebar__section-stats">{runtimeSessionCount}个</div>
          ) : null}
        </div>
        <div className="sidebar__section-actions">
          <button
            type="button"
            className={"section-icon-btn" + (showArchived ? " is-on" : "")}
            title={showArchived ? "返回会话列表" : "查看归档会话"}
            aria-label={showArchived ? "返回会话列表" : "查看归档会话"}
            onClick={() => onShowArchivedChange(!showArchived)}
          >
            {showArchived ? <IconArchiveOff size={14} /> : <IconArchive size={14} />}
          </button>
          {!showArchived ? (
            <>
              <button
                type="button"
                className="section-icon-btn"
                title={`同步 ${runtimeLabel(runtimePick)} 原生会话`}
                disabled={syncing}
                onClick={() => onSyncNativeSessions("reset")}
              >
                <IconRefresh size={14} />
              </button>
              <button
                type="button"
                className="section-icon-btn"
                title={
                  sessionFilter.trim()
                    ? "搜索时项目组保持展开"
                    : allProjectGroupsCollapsed
                      ? "展开第一个项目"
                      : "折叠当前项目"
                }
                aria-label={
                  allProjectGroupsCollapsed ? "展开第一个项目" : "折叠当前项目"
                }
                disabled={projectGroups.length === 0 || Boolean(sessionFilter.trim())}
                onClick={() =>
                  setCollapsedProjects((current) => {
                    if (!allProjectGroupsCollapsed) return new Set(projectKeys);
                    const firstProjectKey = projectGroups[0]?.key;
                    if (!firstProjectKey) return current;
                    return new Set(projectKeys.filter((key) => key !== firstProjectKey));
                  })
                }
              >
                {allProjectGroupsCollapsed ? (
                  <IconChevronsDown size={14} />
                ) : (
                  <IconChevronsUp size={14} />
                )}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="sidebar__scroll-wrap">
        <div className="sidebar__scroll" ref={sessionScrollRef} onScroll={handleScroll}>
          {filteredSessions.length === 0 ? (
            <div className="sidebar-empty">
              {runtimeSessionCount === 0
                ? showArchived
                  ? `没有已归档的 ${runtimeLabel(runtimePick)} 会话。`
                  : `还没有 ${runtimeLabel(runtimePick)} 会话。点同步或新建会话。`
                : "没有匹配的会话。"}
            </div>
          ) : null}
          {projectGroups.map((group) => {
            const collapsed = !sessionFilter.trim() && collapsedProjects.has(group.key);
            const pinned = pinnedProjectKeys.includes(group.key);
            return (
              <section
                className={
                  "session-project" +
                  (pinned ? " is-pinned" : "") +
                  (draggingProjectKey === group.key ? " is-dragging" : "") +
                  (dragOverProjectKey === group.key && draggingProjectKey !== group.key
                    ? " is-drag-over"
                    : "")
                }
                key={group.key}
                data-project-key={group.key}
              >
                <div
                  className="session-project__header"
                  title={group.path ?? "没有绑定工作目录的会话"}
                  onContextMenu={(ev) => {
                    if (!group.path) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    onProjectContextMenu(
                      { ...group, pinned },
                      Math.max(8, Math.min(ev.clientX, window.innerWidth - 252)),
                      Math.max(8, Math.min(ev.clientY, window.innerHeight - 220)),
                    );
                  }}
                >
                  <button
                    type="button"
                    className="session-project__toggle"
                    aria-expanded={!collapsed}
                    onClick={() => toggleProjectCollapsed(group.key)}
                    onPointerDown={(event) => beginProjectLongPress(event, group)}
                    onPointerMove={moveProjectDrag}
                    onPointerUp={finishProjectDrag}
                    onPointerCancel={cancelProjectDrag}
                    onPointerLeave={() => {
                      if (!draggingProjectKey) clearProjectLongPress();
                    }}
                  >
                    {collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
                    <IconFolder size={14} />
                    <span className="session-project__name">{group.label}</span>
                    {pinned ? (
                      <span className="session-project__pin">
                        <IconPinnedFilled size={12} title="目录已置顶" />
                      </span>
                    ) : null}
                    <span className="session-project__count">{group.sessions.length}</span>
                  </button>
                  {group.path ? (
                    <button
                      type="button"
                      className="session-project__add"
                      title={`在 ${group.path} 新建会话`}
                      aria-label={`在 ${group.label} 新建会话`}
                      disabled={busy}
                      onClick={() => onCreateSession(group.path)}
                    >
                      <IconPlus size={14} />
                    </button>
                  ) : null}
                </div>
                {!collapsed ? (
                  <div className="session-project__sessions">
                    {group.sessions.map(renderSession)}
                  </div>
                ) : null}
              </section>
            );
          })}
          {!showArchived && loadingMore ? (
            <div className="session-load-state">加载更多…</div>
          ) : !showArchived && hasMore ? (
            <button type="button" className="session-load-more" onClick={() => onSyncNativeSessions("more")}>
              加载更多
            </button>
          ) : !showArchived && runtimeSessionCount > 0 ? (
            <div className="session-load-state">已到列表底部</div>
          ) : null}
        </div>
        {showScrollTop ? (
          <button
            type="button"
            className="sidebar-scroll-top"
            title="回到顶部"
            aria-label="回到会话列表顶部"
            onClick={scrollSessionsToTop}
          >
            <IconChevronsUp size={16} />
          </button>
        ) : null}
      </div>

      <div
        className="sidebar__footer-stats"
        aria-label={`${processStats.total} 个会话，${processStats.running} 个运行中，${processStats.processes} 个活跃进程`}
        title="当前引擎的非归档会话 · 运行中 · 活跃进程"
      >
        <span>会话 {processStats.total}</span>
        <span>运行 {processStats.running}</span>
        <span>进程 {processStats.processes}</span>
      </div>
      <button
        type="button"
        className="sidebar__footer"
        title="设置"
        onClick={onOpenSettings}
      >
        <IconSettings size={16} />
        <span className="sidebar__footer-name">设置</span>
      </button>
    </aside>
  );
}
