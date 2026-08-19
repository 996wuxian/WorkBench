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
  type RefObject,
  type UIEvent,
} from "react";

import { MarkdownMessage, renderInlineMarkdown } from "./Markdown";
import {
  AssistantTiming,
  AssistantWorktreeChanges,
  StreamingText,
  ThinkingIndicator,
} from "./ChatStream";
import {
  IconChat,
  IconChevronDown,
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

function ThoughtBubbleContent({
  message,
  skills,
  revealImmediately,
  onTypingProgress,
}: {
  message: ChatMessage;
  skills: SkillInfo[];
  revealImmediately?: boolean;
  onTypingProgress: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const content = stripWorktreeChangeMarkers(message.content || "").trim();
  const hasContent = content.length > 0;

  return (
    <div className="message__thought">
      <button
        type="button"
        className="message__thought-toggle"
        aria-expanded={expanded}
        title={expanded ? "收起思考内容" : "展开思考内容"}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="message__thought-toggle-head">
          <span className="message__thought-title">{message.streaming ? "思考中" : "思考内容"}</span>
          {message.streaming ? <ThinkingIndicator /> : null}
        </span>
        <span className="message__thought-toggle-state">
          {expanded ? "收起" : hasContent ? "查看" : "已隐藏"}
        </span>
      </button>
      {expanded && hasContent ? (
        <div className="message__thought-body">
          {message.streaming ? (
            <StreamingText
              content={content}
              revealImmediately={revealImmediately}
              onProgress={onTypingProgress}
            />
          ) : (
            <MarkdownMessage
              content={content}
              skills={skills}
              formatLongParagraphs
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function AssistantBubbleContent({
  message,
  typing,
  thinking,
  skills,
  revealImmediately,
  onTypingProgress,
}: {
  message: ChatMessage;
  typing: boolean;
  thinking: boolean;
  skills: SkillInfo[];
  revealImmediately?: boolean;
  onTypingProgress: () => void;
}) {
  if (thinking) return <ThinkingIndicator />;

  const blocks = new Map(
    (message.worktreeChangeBlocks ?? []).map((block) => [block.id, block.files]),
  );
  if (blocks.size === 0) {
    return typing ? (
      <StreamingText
        content={message.content || ""}
        revealImmediately={revealImmediately}
        onProgress={onTypingProgress}
      />
    ) : (
      <MarkdownMessage
        content={message.content || ""}
        skills={skills}
        formatLongParagraphs
      />
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
              <StreamingText
                content={text}
                revealImmediately={revealImmediately}
                showCursor={index === lastTextPartIndex}
                onProgress={onTypingProgress}
              />
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
          {groups.map(({ message: m, toolMessages }) => {
            // An assistant record with neither text nor an open stream is an
            // artifact of replay; drop it rather than render an empty bubble.
            if (m.role === "assistant" && !m.streaming && !m.content) {
              return null;
            }
            const isThought = m.role === "thought";
            const isSystemNotice = m.role === "system";
            const visualRole =
              m.role === "thought" || m.role === "tool" ? "system" : m.role;
            const messageRuntime = m.runtimeId ?? fallbackRuntimeId ?? "grok";
            const messageRuntimeLabel = runtimeLabel(messageRuntime);
            const avatarSrc =
              m.role === "assistant" ? runtimeAvatarSrc[messageRuntime] : null;
            const thinking = Boolean(
              m.role === "assistant" && m.pending && m.streaming,
            );
            const typing =
              m.role === "assistant" &&
              (m.streaming || (assistantTypingUntil[m.id] ?? 0) > Date.now()) &&
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
            const messageBubble = (
              <>
                {m.role === "assistant" ? (
                  <AssistantBubbleContent
                    message={m}
                    typing={typing}
                    thinking={thinking}
                    skills={[]}
                    revealImmediately={m.revealImmediately}
                    onTypingProgress={onTypingProgress}
                  />
                ) : isThought ? (
                  <ThoughtBubbleContent
                    message={m}
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
            const messageActions =
              messageActionButtons || m.role === "assistant" ? (
                <div className={`message__actions message__actions--${visualRole}`}>
                  <div className="message__actions-row">
                    {messageActionButtons}
                    {m.role === "assistant" ? <AssistantTiming message={m} /> : null}
                  </div>
                </div>
              ) : null;

            // Runtimes without bundled artwork fall back to the avatar-less
            // layout rather than rendering a broken image.
            if (!avatarSrc) {
              return (
                <div
                  key={m.id}
                  data-message-id={m.id}
                  className={
                    `message-block message-block--${visualRole}` +
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
                <img
                  className={`message-avatar message-avatar--${messageRuntime}`}
                  src={avatarSrc}
                  alt=""
                  title={runtimeAvatarLabel(messageRuntime)}
                  width={30}
                  height={30}
                  draggable={false}
                />
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
