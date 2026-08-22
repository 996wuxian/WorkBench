/**
 * The transcript.
 *
 * Rendering a message is a pure function of the message plus the session's
 * fallback runtime (used for the avatar when a record predates per-message
 * runtime ids). Everything with a side effect — copying, quoting, status text —
 * is a callback, so this file stays a view.
 */
import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";

import { MarkdownMessage, renderInlineMarkdown } from "./Markdown";
import {
  AssistantTiming,
  AssistantWorktreeChanges,
  LoadingState,
  StreamingText,
} from "./ChatStream";
import {
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClose,
  IconCopy,
  IconExpand,
  IconQuote,
} from "./icons";
import { api, isTauri } from "../lib/api";
import { copyImageSourceToClipboard } from "../lib/clipboardImages";
import { MessageNodeRail } from "./MessageNodeRail";
import { copyTextToClipboard } from "../lib/format";
import { useMessageNodeNavigation } from "../hooks/useMessageNodeNavigation";
import {
  messageRoleLabel,
  toolMessageLabel,
  type QuoteTarget,
} from "../lib/messages";
import { emitToast } from "../lib/toast";
import { runtimeAvatarLabel, runtimeAvatarSrc, runtimeLabel } from "../lib/runtimes";
import {
  splitWorktreeChangeMarkers,
  stripWorktreeChangeMarkers,
} from "../lib/worktreeChanges";
import type { ChatMessage, RuntimeId, SkillInfo } from "../lib/types";

/** An assistant turn plus the tool calls it made, folded in as meta lines. */
export interface MessageGroup {
  message: ChatMessage;
  toolMessages: ChatMessage[];
}

function isAgentTurnRole(role: ChatMessage["role"]): boolean {
  return role === "assistant" || role === "thought" || role === "tool";
}

function isInternalProcessMessage(message: ChatMessage): boolean {
  return (
    message.role === "tool" &&
    (message.toolName === "dsh_headless" ||
      message.toolCallId?.startsWith("dsh_headless:") ||
      message.toolTitle === "DeepSeek Harness headless")
  );
}

function isFirstAgentTurnItem(
  groups: readonly MessageGroup[],
  index: number,
): boolean {
  const message = groups[index]?.message;
  if (!message || !isAgentTurnRole(message.role)) return false;

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const role = groups[cursor]?.message.role;
    if (role === "user") return true;
    if (role && isAgentTurnRole(role)) return false;
  }
  return true;
}

function isThinkingShell(message: ChatMessage): boolean {
  return Boolean(
    message.role === "assistant" &&
      message.pending &&
      message.streaming &&
      !message.content,
  );
}

function isHiddenEmptyAssistantArtifact(message: ChatMessage): boolean {
  return Boolean(
    message.role === "assistant" &&
      !message.streaming &&
      !message.pending &&
      !message.content,
  );
}

function isProcessGroupMessage(
  message: ChatMessage,
  turnStreaming: boolean,
): boolean {
  return (
    message.role === "thought" ||
    message.role === "tool" ||
    (turnStreaming && isThinkingShell(message))
  );
}

export interface MessageListProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  sessionKey: string;
  messages: ChatMessage[];
  groups: MessageGroup[];
  /** True when the session has no messages at all, not merely none visible. */
  empty: boolean;
  hiddenCount: number;
  onRevealOlder: () => void;
  onRevealMessage: (messageIndex: number) => void;
  /** Runtime to attribute a message to when it carries no id of its own. */
  fallbackRuntimeId: RuntimeId | null;
  assistantTypingUntil: Record<string, number>;
  turnStreaming: boolean;
  skills: SkillInfo[];
  onTypingProgress: () => void;
  onQuote: (target: QuoteTarget) => void;
}

type MessageImageRef = {
  id: string;
  path: string;
  src: string;
  name: string;
};

function parseMessageImages(content: string): {
  text: string;
  images: MessageImageRef[];
} {
  const images: MessageImageRef[] = [];
  const textLines: string[] = [];

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(/^\[image\]\s+(.+?)\s*$/);
    if (!match) {
      textLines.push(line);
      continue;
    }
    const path = match[1].trim();
    if (!path) continue;
    const normalized = path.replaceAll("/", "\\");
    const slashIndex = normalized.lastIndexOf("\\");
    images.push({
      id: `${index}:${path}`,
      path,
      src: path,
      name: slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized,
    });
  }

  return {
    text: textLines.join("\n").trim(),
    images,
  };
}

function MessageImageViewer({
  image,
  onClose,
}: {
  image: MessageImageRef;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div
      className="composer-image-viewer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="composer-image-viewer__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`查看图片 ${image.name}`}
      >
        <div className="composer-image-viewer__head">
          <div className="composer-image-viewer__title" title={image.path}>
            {image.name}
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon composer-image-viewer__close"
            title="关闭图片预览"
            aria-label="关闭图片预览"
            autoFocus
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>
        <div className="composer-image-viewer__body">
          <img
            className="composer-image-viewer__image"
            src={image.src}
            alt={image.name}
            title="右键复制图片"
            draggable={false}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void copyImageSourceToClipboard(image.src).then(
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
    </div>
  );
}

function MessageContentWithImages({
  sessionId,
  content,
  skills,
}: {
  sessionId: string;
  content: string;
  skills: SkillInfo[];
}) {
  const [previewImage, setPreviewImage] = useState<MessageImageRef | null>(null);
  const { text, images } = useMemo(() => parseMessageImages(content), [content]);
  const imagePathsKey = useMemo(
    () => images.map((image) => image.path).join("\n"),
    [images],
  );
  const [imageSources, setImageSources] = useState<Record<string, string>>({});

  useEffect(() => {
    if (images.length === 0) {
      setImageSources({});
      return;
    }

    let cancelled = false;
    const objectUrls: string[] = [];
    setImageSources({});

    void Promise.all(
      images.map(async (image) => {
        if (!isTauri()) return [image.path, image.path] as const;
        const data = await api.loadImageAttachment(sessionId, image.path);
        if (cancelled) return null;
        const blob = new Blob([new Uint8Array(data.bytes)], {
          type: data.mimeType,
        });
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        return [image.path, url] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setImageSources(
          Object.fromEntries(entries.filter((entry): entry is [string, string] =>
            Boolean(entry),
          )),
        );
      })
      .catch(() => {
        if (!cancelled) setImageSources({});
      });

    return () => {
      cancelled = true;
      for (const url of objectUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [images, imagePathsKey, sessionId]);

  if (images.length === 0) {
    return (
      <MarkdownMessage
        content={content}
        skills={skills}
        formatLongParagraphs={false}
      />
    );
  }

  return (
    <>
      <div className="message-attachments-inline">
        <span className="message-attachments-inline__images" aria-label="消息图片">
          {images.map((image) => (
            <button
              key={image.id}
              type="button"
              className={
                "message-attachment-thumb" +
                (imageSources[image.path] ? "" : " is-loading")
              }
              title={`查看图片 ${image.name}`}
              aria-label={`查看图片 ${image.name}`}
              disabled={!imageSources[image.path]}
              onClick={() =>
                setPreviewImage({ ...image, src: imageSources[image.path] })
              }
            >
              {imageSources[image.path] ? (
                <img src={imageSources[image.path]} alt="" draggable={false} />
              ) : (
                <span className="message-attachment-thumb__placeholder">
                  图片
                </span>
              )}
              <span className="message-attachment-thumb__zoom" aria-hidden>
                <IconExpand size={16} />
              </span>
            </button>
          ))}
        </span>
        {text ? (
          <span className="message-attachments-inline__text">
            {renderInlineMarkdown(text, skills)}
          </span>
        ) : null}
      </div>
      {previewImage ? (
        <MessageImageViewer
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      ) : null}
    </>
  );
}

function MessageMetaStack({
  lines,
}: {
  lines: Array<{ id: string; label: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (lines.length === 0) return null;

  return (
    <div className="message__meta-stack message__meta-stack--collapsed">
      <button
        type="button"
        className="message__meta-toggle"
        aria-expanded={expanded}
        title={expanded ? "收起工具过程" : "展开工具过程"}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="message__meta-toggle-head">
          {expanded ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
          <span>工具过程</span>
        </span>
        <span className="message__meta-toggle-state">
          {expanded ? "收起" : `${lines.length} 条 · 查看`}
        </span>
      </button>
      {expanded ? (
        <div className="message__meta-lines">
          {lines.map((line) => (
            <div key={line.id} className="message__meta-line" title={line.label}>
              <span className="message__meta-icon" aria-hidden="true">
                ⚙
              </span>
              <span className="message__meta-text">{line.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProcessRow({
  kind,
  label,
  detail,
  active = false,
}: {
  kind: "think" | "tool";
  label: string;
  detail?: string;
  active?: boolean;
}) {
  return (
    <div
      className={
        "message__process-row message__process-row--" +
        kind +
        (active ? " message__process-row--active" : "")
      }
      role={active ? "status" : undefined}
      aria-live={active ? "polite" : undefined}
      title={detail ? `${label} · ${detail}` : label}
    >
      <span className="message__process-kind">{label}</span>
      {detail ? (
        <span className="message__process-detail">{detail}</span>
      ) : null}
      {active ? (
        <span className="message__process-dots" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      ) : null}
    </div>
  );
}

type ProcessChip = {
  key: string;
  label: string;
  count: number;
  active: boolean;
};

function ProcessChipStack({
  items,
  activeItemId,
  firstAgentTurnItem,
  avatarSrc,
  focusedMessageId,
  renderProcessContent,
}: {
  items: ChatMessage[];
  activeItemId: string | null;
  firstAgentTurnItem: boolean;
  avatarSrc: string | null;
  focusedMessageId: string | null;
  renderProcessContent: (message: ChatMessage, itemActive: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const chips = useMemo(
    () => summarizeProcessChips(items, activeItemId),
    [activeItemId, items],
  );
  const itemCount = items.length;
  const activeItem =
    activeItemId === null ? null : items.find((item) => item.id === activeItemId) ?? null;
  const activeLabel = activeItem ? processItemLabel(activeItem) : null;
  const summary =
    itemCount === 1
      ? "1 个过程"
      : `${itemCount} 个过程`;

  return (
    <div
      className={
        "message-process-stack message-process-stack--chips" +
        (!firstAgentTurnItem || !avatarSrc
          ? " message-process-stack--continuation"
          : "")
      }
    >
      <button
        type="button"
        className={
          "message-tool-chips" +
          (activeItemId ? " message-tool-chips--active" : "")
        }
        aria-expanded={expanded}
        title={expanded ? "收起工具过程" : "展开工具过程"}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="message-tool-chips__chevron" aria-hidden="true">
          {expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        </span>
        <span className="message-tool-chips__items">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className={
                "message-tool-chip" +
                (chip.active ? " message-tool-chip--active" : "")
              }
            >
              <span className="message-tool-chip__dot" aria-hidden="true" />
              <span className="message-tool-chip__label">{chip.label}</span>
              {chip.count > 1 ? (
                <span className="message-tool-chip__count">{chip.count}</span>
              ) : null}
            </span>
          ))}
        </span>
        <span className="message-tool-chips__summary">
          {activeLabel ? `正在 ${activeLabel}` : summary}
        </span>
      </button>
      {expanded ? (
        <div className="message-tool-chips__details">
          {items.map((item) => (
            <div
              key={item.id}
              data-message-id={item.id}
              className={
                "message-block message-block--assistant message-block--process" +
                (focusedMessageId === item.id ? " message-node-focus" : "")
              }
            >
              {renderProcessContent(item, item.id === activeItemId)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function summarizeProcessChips(
  items: ChatMessage[],
  activeItemId: string | null,
): ProcessChip[] {
  const chips: ProcessChip[] = [];
  const positions = new Map<string, number>();
  for (const item of items) {
    const label = processItemLabel(item);
    const key = label.toLowerCase();
    const active = item.id === activeItemId;
    const index = positions.get(key);
    if (index === undefined) {
      positions.set(key, chips.length);
      chips.push({ key, label, count: 1, active });
      continue;
    }
    const chip = chips[index];
    chips[index] = {
      ...chip,
      count: chip.count + 1,
      active: chip.active || active,
    };
  }
  return chips;
}

function processItemLabel(message: ChatMessage): string {
  if (message.role === "thought") return "Think";
  if (message.role === "tool") return processToolLabel(message);
  return "Base";
}

function MessageAvatar({
  runtimeId,
  src,
}: {
  runtimeId: RuntimeId;
  src: string;
}) {
  return (
    <img
      className={`message-avatar message-avatar--${runtimeId}`}
      src={src}
      alt=""
      title={runtimeAvatarLabel(runtimeId)}
      width={30}
      height={30}
      draggable={false}
    />
  );
}

function summarizeProcessText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+·\s+(?:completed|done|success|running|pending|in_progress)$/i, "")
    .replace(/\s+·\s+auto approved$/i, "")
    .replace(/\s+·\s+blocked by policy$/i, "");
}

function processToolLabel(message: ChatMessage): string {
  const name = (message.toolName ?? "").trim().toLowerCase();
  const rawTitle = (message.toolTitle ?? "").trim();
  const title = rawTitle.toLowerCase();
  if (name === "command") {
    if (
      title.includes("powershell") ||
      title.includes("pwsh") ||
      title.includes("set-content") ||
      title.includes("get-content") ||
      title.includes("new-item") ||
      title.includes("copy-item") ||
      title.includes("move-item") ||
      title.includes("remove-item")
    ) {
      return "PowerShell";
    }
    return "Bash";
  }
  if (name.includes("read") || title.startsWith("read")) return "Read";
  if (name.includes("write") || title.startsWith("write")) return "Write";
  if (name.includes("edit") || title.startsWith("edit")) return "Edit";
  if (name.includes("search") || title.includes("search")) return "Search";
  if (rawTitle) {
    const first = rawTitle.split(/[\\/\s·|]/, 1)[0]?.trim();
    if (first) return first.slice(0, 1).toUpperCase() + first.slice(1);
  }
  return "Tool";
}

function processToolDetail(message: ChatMessage): string | undefined {
  const detail = summarizeProcessText(
    message.toolTitle?.trim() ||
      message.toolStatus?.trim() ||
      message.content.trim() ||
      "",
  );
  return detail || undefined;
}

function processThoughtDetail(message: ChatMessage): string | undefined {
  const detail = summarizeProcessText(message.content);
  return detail || undefined;
}

function assistantLoadingState(message: ChatMessage):
  | {
      kind: "base" | "thinking";
      label: string;
      detail: string;
    }
  | null {
  if (
    message.role !== "assistant" ||
    (!message.streaming && !message.pending) ||
    message.completedAt
  ) {
    return null;
  }

  if (!message.content.trim()) {
    return {
      kind: "thinking",
      label: "Thinking",
      detail: "等待模型输出",
    };
  }

  return {
    kind: "base",
    label: "Base",
    detail: "正在生成回复",
  };
}

function isProcessToolActive(message: ChatMessage): boolean {
  const status = message.toolStatus?.trim().toLowerCase();
  return (
    !status ||
    status === "pending" ||
    status === "running" ||
    status === "in_progress"
  );
}

function ThoughtBubbleContent({
  message,
  active,
}: {
  message: ChatMessage;
  active: boolean;
}) {
  if (active && (message.streaming || message.pending)) {
    return (
      <LoadingState
        kind="thinking"
        label="Thinking"
        detail={processThoughtDetail(message)}
        startedAt={message.createdAt}
      />
    );
  }

  return (
    <ProcessRow
      kind="think"
      label="Think"
      detail={processThoughtDetail(message)}
      active={Boolean(message.streaming)}
    />
  );
}

function AssistantBubbleContent({
  message,
  typing,
  thinking,
  active,
  skills,
  revealImmediately,
  onTypingProgress,
}: {
  message: ChatMessage;
  typing: boolean;
  thinking: boolean;
  active: boolean;
  skills: SkillInfo[];
  revealImmediately?: boolean;
  onTypingProgress: () => void;
}) {
  const blocks = new Map(
    (message.worktreeChangeBlocks ?? []).map((block) => [block.id, block.files]),
  );
  const loadingState = active ? assistantLoadingState(message) : null;
  if (thinking && loadingState) {
    return (
      <div className="message__assistant-loading">
        <LoadingState
          kind={loadingState.kind}
          label={loadingState.label}
          detail={loadingState.detail}
          startedAt={message.createdAt}
        />
      </div>
    );
  }
  if (blocks.size === 0) {
    return typing ? (
      <>
        <div className="message__streaming-copy">
          <StreamingText
            content={message.content || ""}
            revealImmediately={revealImmediately}
            onProgress={onTypingProgress}
          />
        </div>
        {loadingState ? (
          <div className="message__assistant-loading">
            <LoadingState
              kind={loadingState.kind}
              label={loadingState.label}
              detail={loadingState.detail}
              startedAt={message.createdAt}
            />
          </div>
        ) : null}
      </>
    ) : (
      <>
        <MarkdownMessage
          content={message.content || ""}
          skills={skills}
          formatLongParagraphs
        />
        {loadingState ? (
          <div className="message__assistant-loading">
            <LoadingState
              kind={loadingState.kind}
              label={loadingState.label}
              detail={loadingState.detail}
              startedAt={message.createdAt}
            />
          </div>
        ) : null}
      </>
    );
  }

  const parts = splitWorktreeChangeMarkers(message.content || "");
  let lastTextPartIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.kind === "text" && part.text) {
      lastTextPartIndex = index;
      break;
    }
  }

  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === "marker") {
          const files = blocks.get(part.id);
          return files?.length ? (
            <AssistantWorktreeChanges key={`${part.id}:${index}`} files={files} />
          ) : null;
        }
        const text = normalizeTextAroundWorktreeMarker(parts, index, part.text);
        if (!text) return null;
        return (
          <div key={`text:${index}`} className="message__content-segment">
            {typing ? (
              <div className="message__streaming-copy">
                <StreamingText
                  content={text}
                  revealImmediately={revealImmediately}
                  showCursor={index === lastTextPartIndex}
                  onProgress={onTypingProgress}
                />
              </div>
            ) : (
              <MarkdownMessage
                content={text}
                skills={skills}
                formatLongParagraphs
              />
            )}
          </div>
        );
      })}
      {loadingState ? (
        <div className="message__assistant-loading">
          <LoadingState
            kind={loadingState.kind}
            label={loadingState.label}
            detail={loadingState.detail}
            startedAt={message.createdAt}
          />
        </div>
      ) : null}
    </>
  );
}

function normalizeTextAroundWorktreeMarker(
  parts: ReturnType<typeof splitWorktreeChangeMarkers>,
  index: number,
  text: string,
) {
  let normalized = text;
  if (parts[index - 1]?.kind === "marker") {
    normalized = normalized.replace(/^(?:[ \t]*\n)+/, "");
  }
  if (parts[index + 1]?.kind === "marker") {
    normalized = normalized.replace(/(?:\n[ \t]*)+$/, "");
  }
  return normalized;
}

export function MessageList({
  scrollRef,
  onScroll,
  sessionKey,
  messages,
  groups,
  empty,
  hiddenCount,
  onRevealOlder,
  onRevealMessage,
  fallbackRuntimeId,
  assistantTypingUntil,
  turnStreaming,
  skills,
  onTypingProgress,
  onQuote,
}: MessageListProps) {
  const {
    nodes,
    activeNodeId,
    focusedMessageId,
    handleScroll,
    scrollToNode,
    selectPreviousNode,
    selectNextNode,
  } = useMessageNodeNavigation({
    sessionKey,
    messages,
    renderedMessageCount: groups.length,
    scrollRef,
    onViewportScroll: onScroll,
    onRevealMessage,
  });

  const assistantLabel = fallbackRuntimeId
    ? runtimeLabel(fallbackRuntimeId)
    : "Agent";
  const visibleGroups = useMemo(
    () =>
      groups
        .filter(
          ({ message }) =>
            !isInternalProcessMessage(message) &&
            !isHiddenEmptyAssistantArtifact(message),
        )
        .map(({ message, toolMessages }) => ({
          message,
          toolMessages: toolMessages.filter(
            (tool) => !isInternalProcessMessage(tool),
          ),
        })),
    [groups],
  );
  const activeTurnStartIndex = useMemo(() => {
    for (let index = visibleGroups.length - 1; index >= 0; index -= 1) {
      if (visibleGroups[index].message.role === "user") return index;
    }
    return -1;
  }, [visibleGroups]);
  const activeStatusIndex = useMemo(() => {
    if (!turnStreaming) return -1;
    for (let index = visibleGroups.length - 1; index > activeTurnStartIndex; index -= 1) {
      const message = visibleGroups[index].message;
      if (
        message.role === "assistant" ||
        isProcessGroupMessage(message, true)
      ) {
        return index;
      }
    }
    return -1;
  }, [activeTurnStartIndex, turnStreaming, visibleGroups]);
  const activeProcessStartIndex = useMemo(() => {
    if (activeStatusIndex < 0) return -1;
    const message = visibleGroups[activeStatusIndex]?.message;
    if (!message || !isProcessGroupMessage(message, true)) return -1;

    let start = activeStatusIndex;
    for (let index = activeStatusIndex - 1; index > activeTurnStartIndex; index -= 1) {
      if (!isProcessGroupMessage(visibleGroups[index].message, true)) break;
      start = index;
    }
    return start;
  }, [activeStatusIndex, activeTurnStartIndex, visibleGroups]);

  return (
    <div className="message-list-shell">
      <div className="message-list" ref={scrollRef} onScroll={handleScroll}>
      {empty ? (
        <div className="empty-state empty-state--chat">
          <div className="empty-state__icon">
            {fallbackRuntimeId && runtimeAvatarSrc[fallbackRuntimeId] ? (
              <img
                className={`empty-state__runtime-avatar empty-state__runtime-avatar--${fallbackRuntimeId}`}
                src={runtimeAvatarSrc[fallbackRuntimeId]}
                alt=""
                title={runtimeAvatarLabel(fallbackRuntimeId)}
                width={44}
                height={44}
                draggable={false}
              />
            ) : (
              <IconChat size={42} />
            )}
          </div>
          直接输入发送。
        </div>
      ) : (
        <>
          {hiddenCount > 0 ? (
            <button
              type="button"
              className="message-history-load"
              onClick={onRevealOlder}
            >
              加载更早消息 · {hiddenCount}
            </button>
          ) : (
            <div className="message-history-state">已加载全部历史</div>
          )}
          {visibleGroups.map(({ message: m, toolMessages }, groupIndex) => {
            const currentTurn = turnStreaming && groupIndex > activeTurnStartIndex;
            const activeAssistant = currentTurn && groupIndex === activeStatusIndex;
            const activeProcessGroup = currentTurn && groupIndex === activeProcessStartIndex;
            if (!activeProcessGroup && isThinkingShell(m)) return null;

            const isThought = m.role === "thought";
            const isSystemNotice = m.role === "system";
            const visualRole =
              m.role === "thought" || m.role === "tool" ? "system" : m.role;
            const messageRuntime = m.runtimeId ?? fallbackRuntimeId ?? "grok";
            const messageRuntimeLabel = runtimeLabel(messageRuntime);
            const avatarSrc =
              isAgentTurnRole(m.role) ? runtimeAvatarSrc[messageRuntime] : null;
            const firstAgentTurnItem = isFirstAgentTurnItem(
              visibleGroups,
              groupIndex,
            );
            const thinking = Boolean(
              activeAssistant && m.role === "assistant" && m.pending && m.streaming,
            );
            const typing =
              m.role === "assistant" &&
              ((activeAssistant && m.streaming) ||
                (assistantTypingUntil[m.id] ?? 0) > Date.now()) &&
              !thinking;
            const messageMetaLines =
              m.role === "assistant" && toolMessages.length
                ? toolMessages.map((tool) => ({
                    id: tool.id,
                    label: toolMessageLabel(tool),
                  }))
                : null;
            const quoteLabel = messageRoleLabel(m, messageRuntimeLabel);
            const canCopy =
              Boolean(stripWorktreeChangeMarkers(m.content || "").trim()) &&
              !thinking &&
              !isThought &&
              !isSystemNotice;
            const canQuote = canCopy;
            const messageActionButtons =
              canCopy || canQuote ? (
                <>
                  {canCopy ? (
                    <button
                      type="button"
                      className="message__action"
                      title="复制消息"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void copyTextToClipboard(
                          stripWorktreeChangeMarkers(m.content),
                        ).then(
                          () => emitToast("已复制"),
                          (error) => emitToast({
                            message: `复制失败: ${String(error)}`,
                            tone: "danger",
                          }),
                        );
                      }}
                    >
                      <IconCopy size={14} />
                    </button>
                  ) : null}
                  {canQuote ? (
                    <button
                      type="button"
                      className="message__action"
                      title="引用消息"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onQuote({
                          messageId: m.id,
                          role: m.role,
                          runtimeId: m.runtimeId ?? fallbackRuntimeId,
                          label: quoteLabel,
                          content: stripWorktreeChangeMarkers(m.content),
                        });
                      }}
                    >
                      <IconQuote size={14} />
                    </button>
                  ) : null}
                </>
              ) : null;
            const messageActions =
              messageActionButtons || m.role === "assistant" ? (
                <div className={`message__actions message__actions--${visualRole}`}>
                  <div className="message__actions-row">
                    {m.role === "assistant" ? <AssistantTiming message={m} /> : null}
                    {messageActionButtons}
                  </div>
                </div>
              ) : null;
            const renderProcessContent = (
              message: ChatMessage,
              itemActive: boolean,
            ) => {
              if (message.role === "thought") {
                return <ThoughtBubbleContent message={message} active={itemActive} />;
              }
              if (message.role === "tool") {
                if (itemActive && isProcessToolActive(message)) {
                  return (
                    <LoadingState
                      kind="tool"
                      label={processToolLabel(message)}
                      detail={processToolDetail(message)}
                      startedAt={message.createdAt}
                    />
                  );
                }
                return (
                  <ProcessRow
                    kind="tool"
                    label={processToolLabel(message)}
                    detail={processToolDetail(message)}
                    active={itemActive && isProcessToolActive(message)}
                  />
                );
              }
              return itemActive ? (
                <LoadingState
                  kind="base"
                  label="Base"
                  detail="等待模型输出"
                  startedAt={message.createdAt}
                />
              ) : null;
            };

            if (isProcessGroupMessage(m, currentTurn)) {
              const previous = visibleGroups[groupIndex - 1]?.message;
              if (previous && isProcessGroupMessage(previous, currentTurn)) return null;

              const processItems: ChatMessage[] = [];
              for (
                let cursor = groupIndex;
                cursor < visibleGroups.length;
                cursor += 1
              ) {
                const nextMessage = visibleGroups[cursor].message;
                if (!isProcessGroupMessage(nextMessage, currentTurn)) break;
                processItems.push(nextMessage);
              }
              const activeProcessItemId = activeProcessGroup
                ? (processItems[processItems.length - 1]?.id ?? null)
                : null;

              const stack = (
                <ProcessChipStack
                  items={processItems}
                  activeItemId={activeProcessItemId}
                  firstAgentTurnItem={firstAgentTurnItem}
                  avatarSrc={avatarSrc ?? null}
                  focusedMessageId={focusedMessageId}
                  renderProcessContent={renderProcessContent}
                />
              );

              if (!firstAgentTurnItem || !avatarSrc) {
                return stack;
              }

              return (
                <div
                  key={`process:${m.id}`}
                  className="message-row message-row--assistant message-row--process"
                >
                  <MessageAvatar runtimeId={messageRuntime} src={avatarSrc} />
                  {stack}
                </div>
              );
            }

            const messageBubble = (
              <>
                {m.role === "assistant" ? (
                  <AssistantBubbleContent
                    message={m}
                    typing={typing}
                    thinking={thinking}
                    active={activeAssistant}
                    skills={[]}
                    revealImmediately={m.revealImmediately}
                    onTypingProgress={onTypingProgress}
                  />
                ) : (
                  <MessageContentWithImages
                    sessionId={sessionKey}
                    content={m.content || ""}
                    skills={m.role === "user" ? skills : []}
                  />
                )}
                {m.partial && !m.streaming && !m.pending ? (
                  <div className="message__interrupted">
                    该回合未正常结束，以上为中断前已保存的内容
                  </div>
                ) : null}
                {messageMetaLines ? (
                  <MessageMetaStack lines={messageMetaLines} />
                ) : null}
              </>
            );

            // Runtimes without bundled artwork fall back to the avatar-less
            // layout rather than rendering a broken image.
            const showAssistantAvatar = firstAgentTurnItem && avatarSrc;
            if (!showAssistantAvatar) {
              return (
                <div
                  key={m.id}
                  data-message-id={m.id}
                  className={
                    `message-block message-block--${visualRole}` +
                    (m.role === "assistant" && avatarSrc
                      ? " message-block--agent-continuation"
                      : "") +
                    (focusedMessageId === m.id ? " message-node-focus" : "")
                  }
                >
                  <div
                    className={
                      `message message--${visualRole}` +
                      (isThought ? " message--thought" : "")
                    }
                    style={
                      isThought
                        ? { opacity: 0.75, fontStyle: "italic" }
                        : undefined
                    }
                  >
                    {messageBubble}
                  </div>
                  {messageActions}
                </div>
              );
            }

            return (
              <div
                key={m.id}
                data-message-id={m.id}
                className={
                  "message-row message-row--assistant" +
                  (focusedMessageId === m.id ? " message-node-focus" : "")
                }
              >
                <MessageAvatar runtimeId={messageRuntime} src={avatarSrc} />
                <div className="message-block message-block--assistant">
                  <div className="message message--assistant">{messageBubble}</div>
                  {messageActions}
                </div>
              </div>
            );
          })}
        </>
      )}
      </div>
      <MessageNodeRail
        nodes={nodes}
        activeId={activeNodeId}
        onSelect={scrollToNode}
        onPrevious={selectPreviousNode}
        onNext={selectNextNode}
        labels={{
          aria: "会话目录",
          previous: "上一条会话消息",
          next: "下一条会话消息",
          user: "你",
          assistant: assistantLabel,
        }}
      />
    </div>
  );
}
