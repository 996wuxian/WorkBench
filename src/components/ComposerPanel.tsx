import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

import { ChoiceSelect, type ChoiceOption } from "./ChoiceSelect";
import {
  IconClipboard,
  IconClose,
  IconQuote,
  IconRiskAsk,
  IconRiskAuto,
  IconRiskFullAccess,
  IconRiskReadOnly,
  IconRiskUnknown,
  IconSend,
  IconStop,
} from "./icons";
import { compactLabel } from "../lib/format";
import type { PermissionMode } from "../lib/types";
import type { QuoteTarget } from "../lib/messages";

type Props = {
  draft: string;
  busy: boolean;
  streaming: boolean;
  readOnly: boolean;
  settingsChangeDisabled: boolean;
  activeModelValue: string;
  activeModelLabel: string;
  activeModelReasoningEffort: string | null;
  activePermissionMode: PermissionMode;
  activeSupportsReasoningEffort: boolean;
  controlModelOptions: ChoiceOption[];
  controlPermissionOptions: ChoiceOption[];
  controlReasoningOptions: ChoiceOption[];
  quoteTarget: QuoteTarget | null;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearQuote: () => void;
  onModelChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionChange: (value: string) => void;
};

type ComposerContextMenu = {
  left: number;
  top: number;
  selectionStart: number;
  selectionEnd: number;
} | null;

function permissionRiskIcon(option: ChoiceOption) {
  const value = option.value as PermissionMode;
  switch (value) {
    case "read_only":
      return <IconRiskReadOnly className="permission-risk-icon" />;
    case "ask":
      return <IconRiskAsk className="permission-risk-icon" />;
    case "auto":
      return <IconRiskAuto className="permission-risk-icon" />;
    case "full_access":
      return <IconRiskFullAccess className="permission-risk-icon" />;
    default:
      return <IconRiskUnknown className="permission-risk-icon" />;
  }
}

function permissionRiskClassName(option: ChoiceOption) {
  const value = option.value as PermissionMode;
  switch (value) {
    case "read_only":
      return "permission-risk--safe";
    case "ask":
      return "permission-risk--ask";
    case "auto":
      return "permission-risk--auto";
    case "full_access":
      return "permission-risk--danger";
    default:
      return "permission-risk--unknown";
  }
}

export function ComposerPanel({
  draft,
  busy,
  streaming,
  readOnly,
  settingsChangeDisabled,
  activeModelValue,
  activeModelLabel,
  activeModelReasoningEffort,
  activePermissionMode,
  activeSupportsReasoningEffort,
  controlModelOptions,
  controlPermissionOptions,
  controlReasoningOptions,
  quoteTarget,
  composerInputRef,
  onDraftChange,
  onSend,
  onStop,
  onClearQuote,
  onModelChange,
  onReasoningEffortChange,
  onPermissionChange,
}: Props) {
  const [contextMenu, setContextMenu] = useState<ComposerContextMenu>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contextMenu) return;

    const close = () => setContextMenu(null);
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && contextMenuRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);

    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const openContextMenu = (event: MouseEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const input = event.currentTarget;
    const menuWidth = 148;
    const menuHeight = 42;
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));

    setContextMenu({
      left,
      top,
      selectionStart: input.selectionStart ?? draft.length,
      selectionEnd: input.selectionEnd ?? input.selectionStart ?? draft.length,
    });
  };

  const pasteFromContextMenu = async () => {
    const menu = contextMenu;
    setContextMenu(null);
    if (!menu) return;

    const readText = navigator.clipboard?.readText;
    if (!readText) return;

    const text = await readText.call(navigator.clipboard).catch(() => "");
    if (!text) return;

    const input = composerInputRef.current;
    const start = Math.min(menu.selectionStart, draft.length);
    const end = Math.min(Math.max(menu.selectionEnd, start), draft.length);
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
    onDraftChange(next);

    requestAnimationFrame(() => {
      input?.focus();
      const caret = start + text.length;
      input?.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="composer">
      <div className={"composer__shell" + (readOnly ? " is-read-only" : "")}>
        <div className="composer__toolbar">
          <ChoiceSelect
            className="composer-control composer-control--model"
            value={activeModelValue}
            options={controlModelOptions}
            disabled={settingsChangeDisabled}
            placement="top"
            aria-label="当前会话模型"
            title="切换当前会话模型"
            placeholder={activeModelLabel}
            onChange={onModelChange}
          />
          {activeSupportsReasoningEffort ? (
            <ChoiceSelect
              className="composer-control composer-control--effort"
              value={activeModelReasoningEffort ?? "high"}
              options={controlReasoningOptions}
              disabled={settingsChangeDisabled}
              placement="top"
              aria-label="当前会话推理档位"
              title="切换当前会话推理档位"
              placeholder="级别"
              onChange={onReasoningEffortChange}
            />
          ) : null}
          <ChoiceSelect
            className="composer-control composer-control--permission"
            value={activePermissionMode}
            options={controlPermissionOptions}
            disabled={settingsChangeDisabled}
            placement="top"
            aria-label="当前会话权限"
            title="切换当前会话权限"
            placeholder="权限"
            renderIcon={permissionRiskIcon}
            getOptionClassName={permissionRiskClassName}
            onChange={onPermissionChange}
          />
        </div>
        {quoteTarget ? (
          <div className="composer__quote">
            <div className="composer__quote-label">
              <IconQuote size={13} />
              <span>{quoteTarget.label}</span>
            </div>
            <div className="composer__quote-text">
              {compactLabel(quoteTarget.content.replace(/\s+/g, " "), 180)}
            </div>
            <button
              type="button"
              className="composer__quote-close"
              title="取消引用"
              onClick={onClearQuote}
            >
              <IconClose size={14} />
            </button>
          </div>
        ) : null}
        <textarea
          ref={composerInputRef}
          className="composer__input"
          placeholder={readOnly ? "归档会话为只读" : "请输入"}
          value={draft}
          disabled={readOnly}
          onChange={(e) => onDraftChange(e.target.value)}
          onContextMenu={openContextMenu}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className="composer__footer">
          <span className="muted" style={{ fontSize: 12 }}>
            {readOnly ? "归档会话 · 只读" : "Enter 发送 · Shift+Enter 换行"}
          </span>
          {streaming ? (
            <button
              type="button"
              className="composer__send is-stop"
              title="停止"
              onClick={onStop}
            >
              <IconStop size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              title="发送"
              disabled={readOnly || !draft.trim() || busy}
              onClick={onSend}
            >
              <IconSend size={16} />
            </button>
          )}
        </div>
      </div>
      {contextMenu
        ? createPortal(
            <div
              ref={contextMenuRef}
              className="composer-context-menu"
              role="menu"
              style={{ left: contextMenu.left, top: contextMenu.top }}
              onMouseDown={(ev) => ev.stopPropagation()}
            >
              <button
                type="button"
                className="composer-context-menu__item"
                role="menuitem"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  void pasteFromContextMenu();
                }}
              >
                <IconClipboard size={14} />
                <span>粘贴</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
