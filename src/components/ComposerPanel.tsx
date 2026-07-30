import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

import { ChoiceSelect, type ChoiceOption } from "./ChoiceSelect";
import {
  IconClipboard,
  IconClose,
  IconFolder,
  IconQuote,
  IconPuzzle,
  IconRiskAsk,
  IconRiskAuto,
  IconRiskFullAccess,
  IconRiskReadOnly,
  IconRiskUnknown,
  IconSend,
  IconStop,
} from "./icons";
import { compactLabel } from "../lib/format";
import { findSkillByName } from "../lib/skills";
import type { PermissionMode, SkillInfo } from "../lib/types";
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
  skills: SkillInfo[];
  skillsLoading: boolean;
  skillsError: string | null;
  selectedSkillNames: string[];
  projectPath: string | null;
  projectPathEditable: boolean;
  projectPathBusy: boolean;
  quoteTarget: QuoteTarget | null;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearQuote: () => void;
  onModelChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionChange: (value: string) => void;
  onSkillSelect: (name: string) => void;
  onSkillRemove: (name: string) => void;
  onPickProjectPath: () => void;
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
  skills,
  skillsLoading,
  skillsError,
  selectedSkillNames,
  projectPath,
  projectPathEditable,
  projectPathBusy,
  quoteTarget,
  composerInputRef,
  onDraftChange,
  onSend,
  onStop,
  onClearQuote,
  onModelChange,
  onReasoningEffortChange,
  onPermissionChange,
  onSkillSelect,
  onSkillRemove,
  onPickProjectPath,
}: Props) {
  const [contextMenu, setContextMenu] = useState<ComposerContextMenu>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const skillsRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!skillsOpen) return;
    const close = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && skillsRef.current?.contains(target)) return;
      setSkillsOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [skillsOpen]);

  const filteredSkills = skills.filter((skill) => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return true;
    return `${skill.name} ${skill.description}`.toLowerCase().includes(q);
  });
  const selectedSkills = selectedSkillNames
    .map((name) => findSkillByName(skills, name))
    .filter((skill): skill is SkillInfo => Boolean(skill));
  const canSend = draft.trim().length > 0 || selectedSkills.length > 0;

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
          <div className="composer-skills" ref={skillsRef}>
            <button
              type="button"
              className={"composer-skill-trigger" + (skillsOpen ? " is-open" : "")}
              title="选择当前 CLI 的 Skills"
              aria-label="选择当前 CLI 的 Skills"
              aria-haspopup="dialog"
              aria-expanded={skillsOpen}
              disabled={readOnly}
              onClick={() => {
                setSkillQuery("");
                setSkillsOpen((open) => !open);
              }}
            >
              <IconPuzzle size={15} />
              <span>Skills</span>
              {skills.length > 0 ? <span className="composer-skill-count">{skills.length}</span> : null}
            </button>
            {skillsOpen ? (
              <div className="composer-skills__panel" role="dialog" aria-label="Skills">
                <div className="composer-skills__head">
                  <span>当前目录 Skills</span>
                  <span className="composer-skills__meta">{skills.length}</span>
                </div>
                <input
                  className="composer-skills__search"
                  placeholder="搜索 Skill"
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  autoFocus
                />
                <div className="composer-skills__list">
                  {skillsLoading ? <div className="composer-skills__empty">正在扫描…</div> : null}
                  {!skillsLoading && skillsError ? (
                    <div className="composer-skills__empty" title={skillsError}>{skillsError}</div>
                  ) : null}
                  {!skillsLoading && !skillsError && filteredSkills.length === 0 ? (
                    <div className="composer-skills__empty">未发现可用 Skill</div>
                  ) : null}
                  {!skillsLoading && !skillsError
                    ? filteredSkills.map((skill) => (
                        <button
                          key={`${skill.source}:${skill.name}`}
                          type="button"
                          className="composer-skills__item"
                          onClick={() => {
                            onSkillSelect(skill.name);
                            setSkillsOpen(false);
                          }}
                        >
                          <span className="composer-skills__item-main">
                            <strong>{skill.name}</strong>
                            {skill.description ? <small>{skill.description}</small> : null}
                          </span>
                          <span className="composer-skills__source">{skill.source === "project" ? "项目" : "用户"}</span>
                        </button>
                      ))
                    : null}
                </div>
              </div>
            ) : null}
          </div>
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
        {selectedSkills.length > 0 ? (
          <div className="composer-skill-chips" aria-label="已引用的 Skills">
            <span className="composer-skill-chips__label">Skills</span>
            {selectedSkills.map((skill) => (
              <button
                type="button"
                key={`${skill.source}:${skill.name}`}
                className="skill-chip skill-chip--composer"
                title={`${skill.description ?? skill.name} · 左键或中键移除`}
                disabled={readOnly}
                onMouseDown={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  onSkillRemove(skill.name);
                  requestAnimationFrame(() => composerInputRef.current?.focus());
                }}
                onClick={() => {
                  onSkillRemove(skill.name);
                  requestAnimationFrame(() => composerInputRef.current?.focus());
                }}
              >
                <IconPuzzle size={12} />
                <span>{skill.name}</span>
                <span className="skill-chip__source">
                  {skill.source === "project" ? "项目" : "用户"}
                </span>
                <IconClose size={12} />
              </button>
            ))}
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
          {projectPathEditable ? (
            <button
              type="button"
              className="composer-project-path__button"
              title={
                projectPath ??
                "未选择工作目录；发送时将优先使用 D:\\workbench，其次 X:\\workbench"
              }
              disabled={projectPathBusy || readOnly}
              onClick={onPickProjectPath}
            >
              <IconFolder size={15} />
              <span>{projectPath ?? "未选择工作目录"}</span>
            </button>
          ) : (
            <div
              className="composer-project-path__display"
              title={projectPath ?? "该旧会话没有记录工作目录"}
            >
              <IconFolder size={15} />
              <span>{projectPath ?? "未记录工作目录"}</span>
            </div>
          )}
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
              disabled={readOnly || !canSend || busy}
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
