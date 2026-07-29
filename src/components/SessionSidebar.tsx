import { useMemo, type RefObject } from "react";

import { RuntimeSelect, type RuntimeOption } from "./RuntimeSelect";
import {
  IconArchive,
  IconArchiveOff,
  IconNewChat,
  IconPanel,
  IconPinnedFilled,
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
  syncingRuntime: RuntimeId | null;
  loadingMoreRuntime: RuntimeId | null;
  nativeHasMore: Partial<Record<RuntimeId, boolean>>;
  onHideSidebar: () => void;
  onToggleMaximize: () => void;
  onRuntimePickChange: (id: RuntimeId) => void;
  onCreateSession: () => void;
  onToggleSearch: () => void;
  onShowArchivedChange: (showArchived: boolean) => void;
  onSessionFilterChange: (value: string) => void;
  selectedSessionIds: string[];
  onSelectSession: (
    sessionId: string,
    options: { shiftKey: boolean; visibleSessionIds: string[] },
  ) => void;
  onSessionContextMenu: (sessionId: string, left: number, top: number) => void;
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
  syncingRuntime,
  loadingMoreRuntime,
  nativeHasMore,
  onHideSidebar,
  onToggleMaximize,
  onRuntimePickChange,
  onCreateSession,
  onToggleSearch,
  onShowArchivedChange,
  onSessionFilterChange,
  selectedSessionIds,
  onSelectSession,
  onSessionContextMenu,
  onSyncNativeSessions,
  onOpenSettings,
}: Props) {
  const runtimeSessions = useMemo(
    () => sessions.filter((session) => session.runtimeId === runtimePick),
    [runtimePick, sessions],
  );
  const scopedSessions = useMemo(
    () => runtimeSessions.filter((session) => session.archived === showArchived),
    [runtimeSessions, showArchived],
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
        (session.nativeThreadId ?? "").toLowerCase().includes(q),
    );
  }, [scopedSessions, sessionFilter]);
  const filteredSessionIds = useMemo(
    () => filteredSessions.map((session) => session.id),
    [filteredSessions],
  );
  const selectedSessionIdSet = useMemo(
    () => new Set(selectedSessionIds),
    [selectedSessionIds],
  );
  const runtimeSessionCount = scopedSessions.length;
  const processStats = useMemo(
    () => sessionProcessStats(scopedSessions, sessionSnapshots),
    [scopedSessions, sessionSnapshots],
  );
  const loadingMore = loadingMoreRuntime === runtimePick;
  const syncing = syncingRuntime === runtimePick;
  const hasMore = nativeHasMore[runtimePick];
  const handleScroll = () => {
    const el = sessionScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    if (!nearBottom) return;
    if (hasMore === false) return;
    if (loadingMore || syncing) return;
    onSyncNativeSessions("more");
  };

  return (
    <aside className={"sidebar" + (hidden ? " sidebar--hidden" : "")} aria-hidden={hidden}>
      <div
        className="sidebar-chrome"
        data-tauri-drag-region
        onDoubleClick={onToggleMaximize}
      >
        <button
          type="button"
          className="chrome-btn chrome-btn--traffic is-on"
          title="隐藏侧栏"
          onClick={onHideSidebar}
        >
          <IconPanel size={16} />
        </button>
        <div className="sidebar-chrome__drag" data-tauri-drag-region />
      </div>

      <div className="sidebar-brand-row">
        <div className="sidebar-brand-row__left">
          <img
            className="app-logo"
            src="/logo.png"
            alt=""
            width={28}
            height={28}
            draggable={false}
          />
          <span>Workbench</span>
        </div>
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
            onClick={onCreateSession}
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

      <div className="sidebar__scroll" ref={sessionScrollRef} onScroll={handleScroll}>
        <div className="sidebar__section-row">
          <div className="sidebar__section-head">
            <div className="sidebar__section-label">
              {showArchived ? "Archived" : "Sessions"}
            </div>
            {showArchived ? (
              <div className="sidebar__section-stats">{runtimeSessionCount}个</div>
            ) : (
              <div
                className="sidebar__section-stats"
                aria-label={`${processStats.total} 个会话，${processStats.running} 个运行中，${processStats.processes} 个活跃进程`}
                title="会话总数 · 运行中 · 活跃进程"
              >
                {processStats.total} · {processStats.running}运行 · {processStats.processes}进程
              </div>
            )}
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
              <button
                type="button"
                className="section-icon-btn"
                title={`同步 ${runtimeLabel(runtimePick)} 原生会话`}
                disabled={syncing}
                onClick={() => onSyncNativeSessions("reset")}
              >
                <IconRefresh size={14} />
              </button>
            ) : null}
          </div>
        </div>
        {filteredSessions.length === 0 ? (
          <div className="sidebar-empty">
            {runtimeSessionCount === 0
              ? showArchived
                ? `没有已归档的 ${runtimeLabel(runtimePick)} 会话。`
                : `还没有 ${runtimeLabel(runtimePick)} 会话。点同步或新建会话。`
              : "没有匹配的会话。"}
          </div>
        ) : null}
        {filteredSessions.map((session) => {
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
                onSessionContextMenu(
                  session.id,
                  Math.max(8, Math.min(ev.clientX, window.innerWidth - 252)),
                  Math.max(8, Math.min(ev.clientY, window.innerHeight - 440)),
                );
              }}
              onClick={(ev) =>
                onSelectSession(session.id, {
                  shiftKey: ev.shiftKey,
                  visibleSessionIds: filteredSessionIds,
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
                    <span
                      className={`status-dot ${stateDotClass(state)}`}
                      aria-hidden="true"
                    />
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

      <button
        type="button"
        className="sidebar__footer"
        title="设置"
        onClick={onOpenSettings}
      >
        <IconSettings size={16} />
        <span className="sidebar__footer-meta">
          <span className="sidebar__footer-name">设置</span>
          <span className="sidebar__footer-sub">主题 · 引擎 · 权限</span>
        </span>
      </button>
    </aside>
  );
}
