import { useMemo, type RefObject } from "react";

import { RuntimeSelect, type RuntimeOption } from "./RuntimeSelect";
import {
  IconNewChat,
  IconPanel,
  IconRefresh,
  IconSearch,
  IconSettings,
} from "./icons";
import { formatSessionTime } from "../lib/format";
import { sessionDisplaySummary, sessionDisplayTitle } from "../lib/sessions";
import { runtimeLabel } from "../lib/runtimes";
import type { RuntimeId, SessionMeta } from "../lib/types";

type Props = {
  hidden: boolean;
  runtimePick: RuntimeId;
  runtimePickOptions: RuntimeOption[];
  sessions: SessionMeta[];
  activeId: string | null;
  busy: boolean;
  showSearch: boolean;
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
  onSessionFilterChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSessionContextMenu: (sessionId: string, left: number, top: number) => void;
  onSyncNativeSessions: (mode: "reset" | "more") => void;
  onOpenSettings: () => void;
};

export function SessionSidebar({
  hidden,
  runtimePick,
  runtimePickOptions,
  sessions,
  activeId,
  busy,
  showSearch,
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
  onSessionFilterChange,
  onSelectSession,
  onSessionContextMenu,
  onSyncNativeSessions,
  onOpenSettings,
}: Props) {
  const scopedSessions = useMemo(
    () => sessions.filter((session) => session.runtimeId === runtimePick),
    [runtimePick, sessions],
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
  const runtimeSessionCount = scopedSessions.length;
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
            placeholder="过滤会话…"
            value={sessionFilter}
            onChange={(e) => onSessionFilterChange(e.target.value)}
            autoFocus
          />
        </div>
      ) : null}

      <div className="sidebar__scroll" ref={sessionScrollRef} onScroll={handleScroll}>
        <div className="sidebar__section-row">
          <div className="sidebar__section-label">Sessions</div>
          <button
            type="button"
            className="section-icon-btn"
            title={`同步 ${runtimeLabel(runtimePick)} 原生会话`}
            disabled={syncing}
            onClick={() => onSyncNativeSessions("reset")}
          >
            <IconRefresh size={14} />
          </button>
        </div>
        {filteredSessions.length === 0 ? (
          <div className="sidebar-empty">
            {runtimeSessionCount === 0
              ? `还没有 ${runtimeLabel(runtimePick)} 会话。点同步或新建会话。`
              : "没有匹配的会话。"}
          </div>
        ) : null}
        {filteredSessions.map((session) => {
          const displayTitle = sessionDisplayTitle(session);
          const displaySummary = sessionDisplaySummary(session);
          return (
            <button
              type="button"
              key={session.id}
              className={
                "session-item" + (activeId === session.id ? " session-item--active" : "")
              }
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                onSessionContextMenu(
                  session.id,
                  Math.max(8, Math.min(ev.clientX, window.innerWidth - 224)),
                  Math.max(8, Math.min(ev.clientY, window.innerHeight - 120)),
                );
              }}
              onClick={() => onSelectSession(session.id)}
            >
              <span className={`runtime-dot runtime-dot--${session.runtimeId}`} />
              <span className="session-item__body">
                <span className="session-item__topline">
                  <span className="session-item__title">{displayTitle}</span>
                  <span className="session-item__time">
                    {formatSessionTime(session.nativeUpdatedAt ?? session.updatedAt)}
                  </span>
                </span>
                {displaySummary ? (
                  <span className="session-item__summary">{displaySummary}</span>
                ) : null}
              </span>
            </button>
          );
        })}
        {loadingMore ? (
          <div className="session-load-state">加载更多…</div>
        ) : hasMore ? (
          <button type="button" className="session-load-more" onClick={() => onSyncNativeSessions("more")}>
            加载更多
          </button>
        ) : runtimeSessionCount > 0 ? (
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
