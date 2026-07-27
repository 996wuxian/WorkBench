import { createPortal } from "react-dom";
import { IconClose, IconFolder } from "./icons";
import type { RefObject, ReactNode } from "react";
import type { SessionMeta } from "../lib/types";

type SessionContextMenu = {
  sessionId: string;
  left: number;
  top: number;
} | null;

type Props = {
  settingsOpen: boolean;
  routeDiagnosticsPanel: ReactNode;
  onCloseSettings: () => void;
  sessionContextMenu: SessionContextMenu;
  sessionContextTargetTitle: string;
  sessionContextMenuRef: RefObject<HTMLDivElement | null>;
  onOpenSelectedSessionLocation: (sessionId: string) => void;
  onRequestDeleteSession: (sessionId: string) => void;
  deleteSessionId: string | null;
  deleteTargetSession: SessionMeta | null;
  deleteTargetPath: string;
  deleteSessionBusy: boolean;
  deleteSessionError: string | null;
  onCloseDelete: () => void;
  onConfirmDelete: () => void;
};

export function AppOverlays({
  settingsOpen,
  routeDiagnosticsPanel,
  onCloseSettings,
  sessionContextMenu,
  sessionContextTargetTitle,
  sessionContextMenuRef,
  onOpenSelectedSessionLocation,
  onRequestDeleteSession,
  deleteSessionId,
  deleteTargetSession,
  deleteTargetPath,
  deleteSessionBusy,
  deleteSessionError,
  onCloseDelete,
  onConfirmDelete,
}: Props) {
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
              <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
                <div className="settings-dialog__head">
                  <div>
                    <div className="settings-dialog__title">设置</div>
                    <div className="settings-dialog__sub">引擎路由</div>
                  </div>
                  <button type="button" className="btn btn--ghost" onClick={onCloseSettings}>
                    关闭
                  </button>
                </div>
                <div className="settings-dialog__body">
                  <div className="sidebar__section-label">Codex / Grok</div>
                  {routeDiagnosticsPanel}
                </div>
              </section>
            </div>,
            document.body,
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
            >
              <div className="session-context-menu__title">{sessionContextTargetTitle}</div>
              <button
                type="button"
                className="session-context-menu__item"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (sessionContextMenu) {
                    void onOpenSelectedSessionLocation(sessionContextMenu.sessionId);
                  }
                }}
              >
                <IconFolder size={14} />
                <span>打开文件所在位置</span>
              </button>
              <button
                type="button"
                className="session-context-menu__item session-context-menu__item--danger"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (sessionContextMenu) {
                    onRequestDeleteSession(sessionContextMenu.sessionId);
                  }
                }}
              >
                <IconClose size={14} />
                <span>删除会话</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {deleteSessionId
        ? createPortal(
            <div
              className="settings-overlay"
              role="presentation"
              onMouseDown={(ev) => {
                if (ev.target === ev.currentTarget) onCloseDelete();
              }}
            >
              <section className="settings-dialog session-delete-dialog" role="dialog" aria-modal="true" aria-label="删除会话">
                <div className="settings-dialog__head">
                  <div>
                    <div className="settings-dialog__title">删除会话</div>
                    <div className="settings-dialog__sub">删除后会移除会话文件夹和记录</div>
                  </div>
                  <button type="button" className="btn btn--ghost" disabled={deleteSessionBusy} onClick={onCloseDelete}>
                    关闭
                  </button>
                </div>
                <div className="settings-dialog__body session-delete-dialog__body">
                  <div className="session-delete-dialog__title">
                    {deleteTargetSession?.title ?? deleteSessionId}
                  </div>
                  <div className="session-delete-dialog__path">{deleteTargetPath}</div>
                  <div className="session-delete-dialog__note">
                    此操作会删除会话及其文件夹内容，无法恢复。
                  </div>
                  {deleteSessionError ? (
                    <div className="session-delete-dialog__error">{deleteSessionError}</div>
                  ) : null}
                  <div className="session-delete-dialog__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={deleteSessionBusy}
                      onClick={onCloseDelete}
                    >
                      取消
                    </button>
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
            document.body,
          )
        : null}
    </>
  );
}
