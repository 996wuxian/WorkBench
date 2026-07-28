import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { IconClose, IconFolder } from "./icons";
import { SettingsDialog, type SettingsSection } from "./SettingsDialog";
import type { RefObject, ReactNode } from "react";
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
  sessionContextTargetCount: number;
  sessionContextTargetIds: string[];
  sessionContextMenuRef: RefObject<HTMLDivElement | null>;
  onOpenSelectedSessionLocation: (sessionId: string) => void;
  onRequestDeleteSessions: (sessionIds: string[]) => void;
  deleteSessionIds: string[];
  deleteTargetSessions: SessionMeta[];
  deleteTargetPath: string;
  deleteSessionBusy: boolean;
  deleteSessionError: string | null;
  onCloseDelete: () => void;
  onConfirmDelete: () => void;
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
  sessionContextTargetCount,
  sessionContextTargetIds,
  sessionContextMenuRef,
  onOpenSelectedSessionLocation,
  onRequestDeleteSessions,
  deleteSessionIds,
  deleteTargetSessions,
  deleteTargetPath,
  deleteSessionBusy,
  deleteSessionError,
  onCloseDelete,
  onConfirmDelete,
}: Props) {
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalHost(document.querySelector(".app-shell") as HTMLElement | null);
  }, []);

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
            >
              <div className="session-context-menu__title">{sessionContextTargetTitle}</div>
              {sessionContextTargetCount <= 1 ? (
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
              ) : null}
              <button
                type="button"
                className="session-context-menu__item session-context-menu__item--danger"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (sessionContextMenu) {
                    onRequestDeleteSessions(sessionContextTargetIds);
                  }
                }}
              >
                <IconClose size={14} />
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

      {deleteSessionIds.length > 0
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
                    <div className="settings-dialog__title">
                      {deleteSessionIds.length > 1
                        ? `删除 ${deleteSessionIds.length} 个会话`
                        : "删除会话"}
                    </div>
                    <div className="settings-dialog__sub">删除后会移除会话文件夹和记录</div>
                  </div>
                  <button type="button" className="btn btn--ghost" disabled={deleteSessionBusy} onClick={onCloseDelete}>
                    关闭
                  </button>
                </div>
                <div className="settings-dialog__body session-delete-dialog__body">
                  <div className="session-delete-dialog__title">
                    {deleteSessionIds.length === 1
                      ? (deleteTargetSessions[0]?.title ?? deleteSessionIds[0])
                      : deleteSessionIds
                          .map(
                            (sessionId) =>
                              deleteTargetSessions.find(
                                (session) => session.id === sessionId,
                              )?.title ?? sessionId,
                          )
                          .join("、")}
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
            overlayHost,
          )
        : null}
    </>
  );
}
