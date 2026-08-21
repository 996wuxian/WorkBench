import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { ChoiceSelect, type ChoiceOption } from "./ChoiceSelect";
import {
  IconClipboard,
  IconClose,
  IconExpand,
  IconFileAdd,
  IconFileText,
  IconFolder,
  IconGoal,
  IconPhoto,
  IconPlus,
  IconQuote,
  IconPuzzle,
  IconRefresh,
  IconRiskAsk,
  IconRiskAuto,
  IconRiskFullAccess,
  IconRiskReadOnly,
  IconRiskUnknown,
  IconSend,
  IconStop,
} from "./icons";
import { compactLabel } from "../lib/format";
import { copyImageSourceToClipboard } from "../lib/clipboardImages";
import { findSkillByName } from "../lib/skills";
import { emitToast } from "../lib/toast";
import type { PermissionMode, RuntimeUsageStatus, SkillInfo } from "../lib/types";
import type { QuoteTarget } from "../lib/messages";

export type ComposerImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
  previewUrl: string;
};

export type ComposerFileAttachment = {
  id: string;
  name: string;
  path: string;
  extension?: string | null;
  mimeType?: string | null;
  sizeBytes: number;
};

type Props = {
  draft: string;
  busy: boolean;
  streaming: boolean;
  readOnly: boolean;
  inputDisabled: boolean;
  settingsChangeDisabled: boolean;
  activeModelValue: string;
  activeModelLabel: string;
  activeModelReasoningEffort: string | null;
  activePermissionMode: PermissionMode;
  activeSupportsReasoningEffort: boolean;
  controlModelOptions: ChoiceOption[];
  controlReasoningOptions: ChoiceOption[];
  controlPermissionOptions: ChoiceOption[];
  skills: SkillInfo[];
  skillsLoading: boolean;
  skillsError: string | null;
  selectedSkillNames: string[];
  goalModeAvailable: boolean;
  goalModeActive: boolean;
  runtimeUsageStatus: RuntimeUsageStatus | null;
  runtimeUsageLoading: boolean;
  projectPath: string | null;
  projectPathEditable: boolean;
  projectPathBusy: boolean;
  quoteTarget: QuoteTarget | null;
  imageAttachments: ComposerImageAttachment[];
  fileAttachments: ComposerFileAttachment[];
  imagePasteEnabled: boolean;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearQuote: () => void;
  onPasteImages: (files: File[]) => void;
  onRemoveImageAttachment: (id: string) => void;
  onPickFiles: () => void;
  onRemoveFileAttachment: (id: string) => void;
  onInputFocus: () => void;
  onModelChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionChange: (value: string) => void;
  onSkillSelect: (name: string) => void;
  onSkillRemove: (name: string) => void;
  onGoalModeToggle: () => void;
  onRefreshRuntimeUsage: () => void;
  onPickProjectPath: () => void;
};

type ComposerContextMenu = {
  left: number;
  top: number;
  selectionStart: number;
  selectionEnd: number;
} | null;

export function ComposerPanel({
  draft,
  busy,
  streaming,
  readOnly,
  inputDisabled,
  settingsChangeDisabled,
  activeModelValue,
  activeModelLabel,
  activeModelReasoningEffort,
  activePermissionMode,
  activeSupportsReasoningEffort,
  controlModelOptions,
  controlReasoningOptions,
  controlPermissionOptions,
  skills,
  skillsLoading,
  skillsError,
  selectedSkillNames,
  goalModeAvailable,
  goalModeActive,
  runtimeUsageStatus,
  runtimeUsageLoading,
  projectPath,
  projectPathEditable,
  projectPathBusy,
  quoteTarget,
  imageAttachments,
  fileAttachments,
  imagePasteEnabled,
  composerInputRef,
  onDraftChange,
  onSend,
  onStop,
  onClearQuote,
  onPasteImages,
  onRemoveImageAttachment,
  onPickFiles,
  onRemoveFileAttachment,
  onInputFocus,
  onModelChange,
  onReasoningEffortChange,
  onPermissionChange,
  onSkillSelect,
  onSkillRemove,
  onGoalModeToggle,
  onRefreshRuntimeUsage,
  onPickProjectPath,
}: Props) {
  const [contextMenu, setContextMenu] = useState<ComposerContextMenu>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [previewImage, setPreviewImage] = useState<ComposerImageAttachment | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (!addMenuOpen) return;
    const close = () => setAddMenuOpen(false);
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && addMenuRef.current?.contains(target)) return;
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
  }, [addMenuOpen]);

  useEffect(() => {
    if (!inputDisabled) return;
    setContextMenu(null);
    setSkillsOpen(false);
    setAddMenuOpen(false);
  }, [inputDisabled]);

  useEffect(() => {
    if (!previewImage) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewImage(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewImage]);

  useEffect(() => {
    if (!previewImage) return;
    if (!imageAttachments.some((image) => image.id === previewImage.id)) {
      setPreviewImage(null);
    }
  }, [imageAttachments, previewImage]);

  const filteredSkills = skills.filter((skill) => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return true;
    return `${skill.name} ${skill.description}`.toLowerCase().includes(q);
  });
  const selectedSkills = selectedSkillNames
    .map((name) => findSkillByName(skills, name))
    .filter((skill): skill is SkillInfo => Boolean(skill));
  const canSend =
    draft.trim().length > 0 ||
    selectedSkills.length > 0 ||
    imageAttachments.length > 0 ||
    fileAttachments.length > 0;

  const insertTextAtSelection = (text: string, input: HTMLTextAreaElement | null) => {
    if (!text) return;
    const start = Math.min(input?.selectionStart ?? draft.length, draft.length);
    const end = Math.min(
      Math.max(input?.selectionEnd ?? start, start),
      draft.length,
    );
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
    onDraftChange(next);
    requestAnimationFrame(() => {
      input?.focus();
      const caret = start + text.length;
      input?.setSelectionRange(caret, caret);
    });
  };

  const permissionRiskIcon = (option: ChoiceOption) => {
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
  };

  const permissionRiskClassName = (option: ChoiceOption) => {
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
  };

  const formatUsageExpiresAt = (value?: string | null) => {
    if (!value) return null;
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return value;
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  const usageRemainingNumber = runtimeUsageStatus?.remaining
    ? Number.parseFloat(runtimeUsageStatus.remaining)
    : Number.NaN;
  const usageRemainingTone = Number.isFinite(usageRemainingNumber)
    ? usageRemainingNumber > 20
      ? "good"
      : usageRemainingNumber >= 10
        ? "warn"
        : "danger"
    : null;
  const usageExpiresAt = formatUsageExpiresAt(runtimeUsageStatus?.expiresAt);
  const usageStructured = runtimeUsageStatus
    ? [
        runtimeUsageStatus.used ? (
          <span key="used">已使用：{runtimeUsageStatus.used}</span>
        ) : null,
        runtimeUsageStatus.remaining ? (
          <span
            key="remaining"
            className={
              usageRemainingTone
                ? `composer-usage__remaining composer-usage__remaining--${usageRemainingTone}`
                : "composer-usage__remaining"
            }
          >
            剩余：{runtimeUsageStatus.remaining}
            {runtimeUsageStatus.unit ? ` ${runtimeUsageStatus.unit}` : ""}
          </span>
        ) : null,
        usageExpiresAt ? <span key="expires">到期：{usageExpiresAt}</span> : null,
      ].filter(Boolean)
    : [];
  const usageSummary =
    runtimeUsageLoading && !runtimeUsageStatus
      ? "正在刷新"
      : runtimeUsageStatus
        ? runtimeUsageStatus.summary
        : "未接入";
  const usageTitle = runtimeUsageStatus
    ? [
        runtimeUsageStatus.label,
        runtimeUsageStatus.summary,
        runtimeUsageStatus.detail,
        ...runtimeUsageStatus.balances.map((balance) =>
          [
            `${balance.currency} ${balance.totalBalance}`,
            balance.grantedBalance ? `赠送 ${balance.grantedBalance}` : null,
            balance.toppedUpBalance ? `充值 ${balance.toppedUpBalance}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ]
        .filter(Boolean)
        .join("\n")
    : "正在读取用量";
  const usageTone = runtimeUsageStatus?.status ?? (runtimeUsageLoading ? "loading" : "unavailable");
  const usageLabel = runtimeUsageLoading && !runtimeUsageStatus ? "用量读取中" : null;

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

    insertTextAtSelection(text, composerInputRef.current);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (inputDisabled || !imagePasteEnabled) return;
    const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (imageFiles.length === 0) return;
    event.preventDefault();
    insertTextAtSelection(event.clipboardData.getData("text/plain"), event.currentTarget);
    onPasteImages(imageFiles);
  };

  return (
    <div className="composer">
      {imageAttachments.length > 0 ? (
        <div className="composer-attachments" aria-label="已粘贴图片">
          {imageAttachments.map((image) => (
            <div className="composer-attachment" key={image.id} title={image.path}>
              <button
                type="button"
                className="composer-attachment__preview"
                title={`查看图片 ${image.name}`}
                aria-label={`查看图片 ${image.name}`}
                onClick={() => setPreviewImage(image)}
              >
                <img
                  className="composer-attachment__image"
                  src={image.previewUrl}
                  alt=""
                  draggable={false}
                />
                <span className="composer-attachment__zoom" aria-hidden>
                  <IconExpand size={17} />
                </span>
                <span className="composer-attachment__meta">
                  <IconPhoto size={12} />
                  <span>{image.name}</span>
                </span>
              </button>
              <button
                type="button"
                className="composer-attachment__remove"
                title="移除图片"
                aria-label={`移除图片 ${image.name}`}
                disabled={inputDisabled}
                onClick={() => onRemoveImageAttachment(image.id)}
              >
                <IconClose size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div
        className={
          "composer__shell" +
          (readOnly ? " is-read-only" : "") +
          (inputDisabled && !readOnly ? " is-input-disabled" : "")
        }
      >
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
              disabled={inputDisabled}
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
          <button
            type="button"
            className={"composer-goal-trigger" + (goalModeActive ? " is-active" : "")}
            title={
              goalModeAvailable
                ? goalModeActive
                  ? "关闭 Codex Goal 模式"
                  : "开启 Codex Goal 模式"
                : "Goal 目前仅支持 Codex 会话"
            }
            aria-label={goalModeActive ? "关闭 Codex Goal 模式" : "开启 Codex Goal 模式"}
            aria-pressed={goalModeActive}
            disabled={inputDisabled || !goalModeAvailable}
            onClick={onGoalModeToggle}
          >
            <IconGoal size={15} />
            <span>Goal</span>
          </button>
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
                disabled={inputDisabled}
                onMouseDown={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  if (inputDisabled) return;
                  onSkillRemove(skill.name);
                  requestAnimationFrame(() => composerInputRef.current?.focus());
                }}
                onClick={() => {
                  if (inputDisabled) return;
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
        {fileAttachments.length > 0 ? (
          <div className="composer-file-chips" aria-label="已添加的文件">
            <span className="composer-file-chips__label">Files</span>
            {fileAttachments.map((file) => (
              <button
                type="button"
                key={file.id}
                className="skill-chip skill-chip--composer file-chip"
                title={`${file.path} · 左键或中键移除`}
                disabled={inputDisabled}
                onMouseDown={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  if (inputDisabled) return;
                  onRemoveFileAttachment(file.id);
                  requestAnimationFrame(() => composerInputRef.current?.focus());
                }}
                onClick={() => {
                  if (inputDisabled) return;
                  onRemoveFileAttachment(file.id);
                  requestAnimationFrame(() => composerInputRef.current?.focus());
                }}
              >
                <IconFileText size={12} />
                <span className="file-chip__name">{file.name}</span>
                <IconClose size={12} />
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={composerInputRef}
          className="composer__input"
          placeholder={
            readOnly
              ? "归档会话为只读"
              : inputDisabled
                ? "等待当前任务完成"
                : "请输入"
          }
          value={draft}
          disabled={inputDisabled}
          onChange={(e) => onDraftChange(e.target.value)}
          onFocus={onInputFocus}
          onPaste={handlePaste}
          onContextMenu={openContextMenu}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (streaming) return;
              onSend();
            }
          }}
        />
        <div className="composer__footer">
          <div className="composer__footer-left">
            <div className="composer-add" ref={addMenuRef}>
              <button
                type="button"
                className={"composer-add__trigger" + (addMenuOpen ? " is-open" : "")}
                title="添加"
                aria-label="添加"
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                disabled={inputDisabled}
                onClick={() => setAddMenuOpen((open) => !open)}
              >
                <IconPlus size={16} />
              </button>
              {addMenuOpen ? (
                <div className="composer-add__menu" role="menu" aria-label="添加">
                  <button
                    type="button"
                    className="composer-add__item"
                    role="menuitem"
                    onClick={() => {
                      setAddMenuOpen(false);
                      onPickFiles();
                      requestAnimationFrame(() => composerInputRef.current?.focus());
                    }}
                  >
                    <IconFileAdd size={14} />
                    <span>添加文件</span>
                  </button>
                </div>
              ) : null}
            </div>
            {projectPathEditable ? (
              <button
                type="button"
                className="composer-project-path__button"
                title={
                  projectPath ??
                  "未选择工作目录；发送时将优先使用 D:\\workbench，其次 X:\\workbench"
                }
                disabled={projectPathBusy || inputDisabled}
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
          </div>
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
              disabled={inputDisabled || !canSend || busy}
              onClick={onSend}
            >
              <IconSend size={16} />
            </button>
          )}
        </div>
      </div>
      {runtimeUsageStatus || runtimeUsageLoading ? (
        <div className="composer__usage-row">
          <div
            className={`composer-usage composer-usage--${usageTone}`}
            title={usageTitle}
            aria-live="polite"
          >
            <span className="composer-usage__text">
              {usageLabel ? <strong>{usageLabel}</strong> : null}
              {usageStructured.length > 0 ? usageStructured : <span>{usageSummary}</span>}
            </span>
            <button
              type="button"
              className="composer-usage__refresh"
              title="刷新用量"
              aria-label="刷新用量"
              disabled={runtimeUsageLoading}
              onClick={onRefreshRuntimeUsage}
            >
              <IconRefresh size={13} />
            </button>
          </div>
        </div>
      ) : null}
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
      {previewImage
        ? createPortal(
            <div
              className="composer-image-viewer"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setPreviewImage(null);
              }}
            >
              <section
                className="composer-image-viewer__dialog"
                role="dialog"
                aria-modal="true"
                aria-label={`查看图片 ${previewImage.name}`}
              >
                <div className="composer-image-viewer__head">
                  <div className="composer-image-viewer__title" title={previewImage.path}>
                    {previewImage.name}
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon composer-image-viewer__close"
                    title="关闭图片预览"
                    aria-label="关闭图片预览"
                    autoFocus
                    onClick={() => setPreviewImage(null)}
                  >
                    <IconClose size={16} />
                  </button>
                </div>
                <div className="composer-image-viewer__body">
                  <img
                    className="composer-image-viewer__image"
                    src={previewImage.previewUrl}
                    alt={previewImage.name}
                    title="右键复制图片"
                    draggable={false}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void copyImageSourceToClipboard(
                        previewImage.previewUrl,
                        previewImage.mimeType,
                      ).then(
                        () => emitToast("已复制图片"),
                        (error) =>
                          emitToast({
                            message: `复制图片失败: ${String(error)}`,
                            tone: "danger",
                          }),
                      );
                    }}
                  />
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
