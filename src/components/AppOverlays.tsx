import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import {
  IconArchive,
  IconArchiveOff,
  IconClose,
  IconCopy,
  IconEdit,
  IconFileExport,
  IconFileText,
  IconFolder,
  IconGitFork,
  IconHistory,
  IconPackageExport,
  IconPinned,
  IconPinnedOff,
  IconTrash,
} from "./icons";
import { SettingsDialog, type SettingsSection } from "./SettingsDialog";
import type { ProjectContextTarget } from "./SessionSidebar";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  ReactNode,
} from "react";
import type {
  AppSettings,
  ProbeResult,
  RuntimeId,
  RuntimeInfo,
  SessionMeta,
} from "../lib/types";
import type { UiFontSize } from "../lib/fontSize";

type SessionContextMenu = {
  sessionId: string;
  left: number;
  top: number;
} | null;

type ProjectContextMenu = (ProjectContextTarget & {
  left: number;
  top: number;
  pinned: boolean;
}) | null;

type DeleteTargetItem = {
  id: string;
  title: string;
  path: string;
  nativeLabel: string | null;
};

type Props = {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  uiFontSize: UiFontSize;
  runtimes: RuntimeInfo[];
  probes: ProbeResult[];
  appSettings: AppSettings | null;
  settingsRuntimeBusy: string | null;
  routeDiagnosticsPanel: ReactNode;
  statusLine: string;
  onCloseSettings: () => void;
  onSettingsSectionChange: (section: SettingsSection) => void;
  onFontSizeChange: (value: UiFontSize) => void;
  onRefreshSettingsDiagnostics: () => void;
  onSaveRuntimeCliPath: (runtimeId: RuntimeId, cliPath: string) => void;
  onClearRuntimeCliPath: (runtimeId: RuntimeId) => void;
  sessionContextMenu: SessionContextMenu;
  sessionContextTargetTitle: string;
  sessionContextTargetPinned: boolean;
  sessionContextTargetArchived: boolean;
  sessionContextArchiveDisabled: boolean;
  sessionContextTargetCount: number;
  sessionContextTargetIds: string[];
  sessionContextMenuRef: RefObject<HTMLDivElement | null>;
  onOpenSelectedSessionLocation: (sessionId: string) => void;
  onToggleSessionPinned: (sessionId: string, pinned: boolean) => void;
  onRequestRenameSession: (sessionId: string) => void;
  onCopySessionId: (sessionId: string) => void;
  onExportSessionMarkdown: (sessionId: string) => void;
  onExportSessionTrace: (sessionId: string) => void;
  onToggleSessionArchived: (sessionId: string, archived: boolean) => void;
  onRequestDeleteSessions: (sessionIds: string[]) => void;
  projectContextMenu: ProjectContextMenu;
  projectContextMenuRef: RefObject<HTMLDivElement | null>;
  onToggleProjectPinned: (projectKey: string, pinned: boolean, label: string) => void;
  onRequestDeleteProjectSessions: (project: ProjectContextTarget) => void;
  renameSessionId: string | null;
  renameSessionTitle: string;
  renameSessionBusy: boolean;
  renameSessionError: string | null;
  onRenameSessionTitleChange: (title: string) => void;
  onCloseRename: () => void;
  onConfirmRename: () => void;
  deleteSessionIds: string[];
  deleteDialogTitle: string;
  deleteDialogSub: string;
  deleteDialogNote: string;
  deleteTargetSessions: SessionMeta[];
  deleteTargetItems: DeleteTargetItem[];
  deleteSessionBusy: boolean;
  deleteSessionError: string | null;
  canDeleteWorkbenchOnly: boolean;
  onCloseDelete: () => void;
  onConfirmDelete: () => void;
  onConfirmDeleteWorkbenchOnly: () => void;
};

export function AppOverlays({
  settingsOpen,
  settingsSection,
  uiFontSize,
  runtimes,
  probes,
  appSettings,
  settingsRuntimeBusy,
  routeDiagnosticsPanel,
  statusLine,
  onCloseSettings,
  onSettingsSectionChange,
  onFontSizeChange,
  onRefreshSettingsDiagnostics,
  onSaveRuntimeCliPath,
  onClearRuntimeCliPath,
  sessionContextMenu,
  sessionContextTargetTitle,
  sessionContextTargetPinned,
  sessionContextTargetArchived,
  sessionContextArchiveDisabled,
  sessionContextTargetCount,
  sessionContextTargetIds,
  sessionContextMenuRef,
  onOpenSelectedSessionLocation,
  onToggleSessionPinned,
  onRequestRenameSession,
  onCopySessionId,
  onExportSessionMarkdown,
  onExportSessionTrace,
  onToggleSessionArchived,
  onRequestDeleteSessions,
  projectContextMenu,
  projectContextMenuRef,
  onToggleProjectPinned,
  onRequestDeleteProjectSessions,
  renameSessionId,
  renameSessionTitle,
  renameSessionBusy,
  renameSessionError,
  onRenameSessionTitleChange,
  onCloseRename,
  onConfirmRename,
  deleteSessionIds,
  deleteDialogTitle,
  deleteDialogSub,
  deleteDialogNote,
  deleteTargetSessions,
  deleteTargetItems,
  deleteSessionBusy,
  deleteSessionError,
  canDeleteWorkbenchOnly,
  onCloseDelete,
  onConfirmDelete,
  onConfirmDeleteWorkbenchOnly,
}: Props) {
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalHost(document.querySelector(".app-shell") as HTMLElement | null);
  }, []);

  useEffect(() => {
    if (!sessionContextMenu) return;
    const frame = requestAnimationFrame(() => {
      const menu = sessionContextMenuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu
        .querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionContextMenu, sessionContextMenuRef]);

  useEffect(() => {
    if (!projectContextMenu) return;
    const frame = requestAnimationFrame(() => {
      const menu = projectContextMenuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu
        .querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [projectContextMenu, projectContextMenuRef]);

  useEffect(() => {
    if (!renameSessionId || renameSessionBusy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRename();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCloseRename, renameSessionBusy, renameSessionId]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? (current - 1 + items.length) % items.length
            : (current + 1) % items.length;
    items[nextIndex]?.focus();
  };

  const trapDialogFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const overlayHost = portalHost ?? document.body;

  return (
    <>
      {settingsOpen
        ? createPortal(
            <div
              className="settings-overlay"
              role="presentation"
              onMouseDown={(ev) => {
                if (ev.target === ev.currentTarget) onCloseSettings();
              }}
            >
              <SettingsDialog
                activeSection={settingsSection}
                uiFontSize={uiFontSize}
                runtimes={runtimes}
                probes={probes}
                appSettings={appSettings}
                settingsRuntimeBusy={settingsRuntimeBusy}
                routeDiagnosticsPanel={routeDiagnosticsPanel}
                statusLine={statusLine}
                onSectionChange={onSettingsSectionChange}
                onFontSizeChange={onFontSizeChange}
                onRefreshDiagnostics={onRefreshSettingsDiagnostics}
                onSaveRuntimeCliPath={onSaveRuntimeCliPath}
                onClearRuntimeCliPath={onClearRuntimeCliPath}
                onClose={onCloseSettings}
              />
            </div>,
            overlayHost,
          )
        : null}

      {sessionContextMenu
        ? createPortal(
            <div
              ref={sessionContextMenuRef}
              className="session-context-menu"
              role="menu"
              style={{
                left: sessionContextMenu.left,
                top: sessionContextMenu.top,
              }}
              onMouseDown={(ev) => ev.stopPropagation()}
              onKeyDown={handleMenuKeyDown}
              aria-label={`${sessionContextTargetTitle} 会话菜单`}
            >
              <div className="session-context-menu__title">{sessionContextTargetTitle}</div>
              {sessionContextTargetCount <= 1 ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    onClick={() => {
                      if (sessionContextMenu) {
                        onToggleSessionPinned(
                          sessionContextMenu.sessionId,
                          !sessionContextTargetPinned,
                        );
                      }
                    }}
                  >
                    {sessionContextTargetPinned ? (
                      <IconPinnedOff size={15} />
                    ) : (
                      <IconPinned size={15} />
                    )}
                    <span>{sessionContextTargetPinned ? "取消置顶" : "置顶会话"}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    onClick={() => {
                      if (sessionContextMenu) {
                        onRequestRenameSession(sessionContextMenu.sessionId);
                      }
                    }}
                  >
                    <IconEdit size={15} />
                    <span>重命名</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    title="当前 Runtime 暂不支持分叉会话"
                    aria-label="分叉会话，当前不可用"
                    disabled
                  >
                    <IconGitFork size={15} />
                    <span>分叉会话</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    title="当前 Runtime 暂不支持时间线回退"
                    aria-label="回退时间线，当前不可用"
                    disabled
                  >
                    <IconHistory size={15} />
                    <span>回退时间线</span>
                  </button>
                  <div className="session-context-menu__separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    onClick={() => {
                      if (sessionContextMenu) {
                        onExportSessionMarkdown(sessionContextMenu.sessionId);
                      }
                    }}
                  >
                    <IconFileText size={15} />
                    <span>导出会话为 Markdown</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    onClick={() => {
                      if (sessionContextMenu) {
                        onExportSessionTrace(sessionContextMenu.sessionId);
                      }
                    }}
                  >
                    <IconFileExport size={15} />
                    <span>导出 trace</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    title="诊断包导出能力尚未接入"
                    aria-label="导出完整诊断包，当前不可用"
                    disabled
                  >
                    <IconPackageExport size={15} />
                    <span>导出完整诊断包...</span>
                  </button>
                  <div className="session-context-menu__separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    onClick={() => {
                      if (sessionContextMenu) onCopySessionId(sessionContextMenu.sessionId);
                    }}
                  >
                    <IconCopy size={15} />
                    <span>复制会话 ID</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    onClick={() => {
                      if (sessionContextMenu) {
                        void onOpenSelectedSessionLocation(sessionContextMenu.sessionId);
                      }
                    }}
                  >
                    <IconFolder size={15} />
                    <span>打开文件所在位置</span>
                  </button>
                  <div className="session-context-menu__separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-menu__item"
                    title={
                      sessionContextArchiveDisabled
                        ? "运行中的会话不能归档"
                        : sessionContextTargetArchived
                          ? "恢复到会话列表"
                          : "移到归档会话"
                    }
                    disabled={sessionContextArchiveDisabled}
                    onClick={() => {
                      if (sessionContextMenu) {
                        onToggleSessionArchived(
                          sessionContextMenu.sessionId,
                          !sessionContextTargetArchived,
                        );
                      }
                    }}
                  >
                    {sessionContextTargetArchived ? (
                      <IconArchiveOff size={15} />
                    ) : (
                      <IconArchive size={15} />
                    )}
                    <span>{sessionContextTargetArchived ? "恢复会话" : "归档"}</span>
                  </button>
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="session-context-menu__item session-context-menu__item--danger"
                onClick={() => {
                  if (sessionContextMenu) {
                    onRequestDeleteSessions(sessionContextTargetIds);
                  }
                }}
              >
                <IconTrash size={15} />
                <span>
                  {sessionContextTargetCount > 1
                    ? `删除 ${sessionContextTargetCount} 个会话`
                    : "删除会话"}
                </span>
              </button>
            </div>,
            overlayHost,
          )
        : null}

      {projectContextMenu
        ? createPortal(
            <div
              ref={projectContextMenuRef}
              className="session-context-menu"
              role="menu"
              style={{
                left: projectContextMenu.left,
                top: projectContextMenu.top,
              }}
              onMouseDown={(ev) => ev.stopPropagation()}
              onKeyDown={handleMenuKeyDown}
              aria-label={`${projectContextMenu.label} 目录菜单`}
            >
              <div className="session-context-menu__title">{projectContextMenu.label}</div>
              <button
                type="button"
                role="menuitem"
                className="session-context-menu__item"
                onClick={() => {
                  if (projectContextMenu) {
                    onToggleProjectPinned(
                      projectContextMenu.key,
                      !projectContextMenu.pinned,
                      projectContextMenu.label,
                    );
                  }
                }}
              >
                {projectContextMenu.pinned ? (
                  <IconPinnedOff size={15} />
                ) : (
                  <IconPinned size={15} />
                )}
                <span>{projectContextMenu.pinned ? "取消置顶" : "置顶目录"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="session-context-menu__item session-context-menu__item--danger"
                onClick={() => {
                  if (projectContextMenu) {
                    onRequestDeleteProjectSessions(projectContextMenu);
                  }
                }}
              >
                <IconTrash size={15} />
                <span>
                  {projectContextMenu.sessions.length > 1
                    ? `删除该目录下的 ${projectContextMenu.sessions.length} 个会话`
                    : "删除该目录下的会话"}
                </span>
              </button>
            </div>,
            overlayHost,
          )
        : null}

      {renameSessionId
        ? createPortal(
            <div
              className="settings-overlay"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) onCloseRename();
              }}
            >
              <form
                className="settings-dialog session-rename-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="session-rename-title"
                onSubmit={(event) => {
                  event.preventDefault();
                  onConfirmRename();
                }}
                onKeyDown={trapDialogFocus}
              >
                <div className="settings-dialog__head">
                  <div>
                    <div className="settings-dialog__title" id="session-rename-title">
                      重命名会话
                    </div>
                    <div className="settings-dialog__sub">名称仅用于 Workbench 会话列表</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon settings-dialog__close"
                    aria-label="关闭重命名"
                    title="关闭重命名"
                    disabled={renameSessionBusy}
                    onClick={onCloseRename}
                  >
                    <IconClose size={16} />
                  </button>
                </div>
                <div className="settings-dialog__body session-rename-dialog__body">
                  <label className="session-rename-dialog__label" htmlFor="session-rename-input">
                    会话名称
                  </label>
                  <input
                    id="session-rename-input"
                    className="session-rename-dialog__input"
                    value={renameSessionTitle}
                    aria-invalid={Boolean(renameSessionError)}
                    aria-describedby={renameSessionError ? "session-rename-error" : undefined}
                    disabled={renameSessionBusy}
                    autoFocus
                    onChange={(event) => onRenameSessionTitleChange(event.target.value)}
                  />
                  {renameSessionError ? (
                    <div
                      className="session-rename-dialog__error"
                      id="session-rename-error"
                      role="alert"
                    >
                      {renameSessionError}
                    </div>
                  ) : null}
                  <div className="session-delete-dialog__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={renameSessionBusy}
                      onClick={onCloseRename}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={renameSessionBusy || !renameSessionTitle.trim()}
                    >
                      {renameSessionBusy ? "保存中..." : "保存"}
                    </button>
                  </div>
                </div>
              </form>
            </div>,
            overlayHost,
          )
        : null}

      {deleteSessionIds.length > 0
        ? createPortal(
            <div
              className="settings-overlay"
              role="presentation"
              onMouseDown={(ev) => {
                if (ev.target === ev.currentTarget) onCloseDelete();
              }}
            >
              <section
                className="settings-dialog session-delete-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={deleteDialogTitle}
              >
                <div className="settings-dialog__head">
                  <div>
                    <div className="settings-dialog__title">
                      {deleteDialogTitle}
                    </div>
                    <div className="settings-dialog__sub">{deleteDialogSub}</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon settings-dialog__close"
                    aria-label="关闭删除确认"
                    title="关闭删除确认"
                    disabled={deleteSessionBusy}
                    onClick={onCloseDelete}
                  >
                    <IconClose size={16} />
                  </button>
                </div>
                <div className="settings-dialog__body session-delete-dialog__body">
                  <div className="session-delete-dialog__content">
                    <div className="session-delete-dialog__title">
                      {deleteSessionIds.length === 1
                        ? (deleteTargetSessions[0]?.title ?? deleteSessionIds[0])
                        : `将删除 ${deleteSessionIds.length} 个会话`}
                    </div>
                    <div className="session-delete-dialog__list" role="list">
                      {deleteTargetItems.map((item, index) => (
                        <div
                          className="session-delete-dialog__item"
                          role="listitem"
                          key={item.id}
                        >
                          <div className="session-delete-dialog__item-index">
                            {index + 1}
                          </div>
                          <div className="session-delete-dialog__item-main">
                            <div className="session-delete-dialog__item-title">
                              {item.title}
                            </div>
                            <div className="session-delete-dialog__item-path">
                              {item.path}
                            </div>
                            {item.nativeLabel ? (
                              <div className="session-delete-dialog__item-native">
                                {item.nativeLabel}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="session-delete-dialog__note">{deleteDialogNote}</div>
                    {deleteSessionError ? (
                      <div className="session-delete-dialog__error">{deleteSessionError}</div>
                    ) : null}
                  </div>
                  <div className="session-delete-dialog__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={deleteSessionBusy}
                      onClick={onCloseDelete}
                    >
                      取消
                    </button>
                    {canDeleteWorkbenchOnly ? (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={deleteSessionBusy}
                        onClick={onConfirmDeleteWorkbenchOnly}
                      >
                        仅删除 Workbench 记录
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={deleteSessionBusy}
                      onClick={onConfirmDelete}
                    >
                      {deleteSessionBusy ? "删除中..." : "删除"}
                    </button>
                  </div>
                </div>
              </section>
            </div>,
            overlayHost,
          )
        : null}
    </>
  );
}
