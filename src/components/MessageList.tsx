/**
 * The transcript.
 *
 * Rendering a message is a pure function of the message plus the session's
 * fallback runtime (used for the avatar when a record predates per-message
 * runtime ids). Everything with a side effect — copying, quoting, status text —
 * is a callback, so this file stays a view.
 */
import type { RefObject, UIEvent } from "react";

import { MarkdownMessage } from "./Markdown";
import { AssistantTiming, StreamingText, ThinkingIndicator } from "./ChatStream";
import { IconChat, IconCopy, IconQuote } from "./icons";
import { MessageNodeRail } from "./MessageNodeRail";
import { copyTextToClipboard } from "../lib/format";
import { useMessageNodeNavigation } from "../hooks/useMessageNodeNavigation";
import { messageRoleLabel, toolMessageLabel, type QuoteTarget } from "../lib/messages";
import { emitToast } from "../lib/toast";
import { runtimeAvatarLabel, runtimeAvatarSrc, runtimeLabel } from "../lib/runtimes";
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
            const visualRole =
              m.role === "thought" || m.role === "tool" ? "system" : m.role;
            const messageRuntime = m.runtimeId ?? fallbackRuntimeId ?? "grok";
            const messageRuntimeLabel = runtimeLabel(messageRuntime);
            const avatarSrc =
              m.role === "assistant" ? runtimeAvatarSrc[messageRuntime] : null;
            const thinking = m.role === "assistant" && m.pending && m.streaming;
            const typing =
              m.role === "assistant" &&
              (m.streaming || (assistantTypingUntil[m.id] ?? 0) > Date.now()) &&
              !thinking;
            const messageMetaLines =
              m.role === "assistant" && toolMessages.length
                ? toolMessages.map((tool) => (
                    <div key={tool.id} className="message__meta-line">
                      <span className="message__meta-icon" aria-hidden="true">
                        ⚙
                      </span>
                      <span className="message__meta-text">
                        {toolMessageLabel(tool)}
                      </span>
                    </div>
                  ))
                : null;
            const quoteLabel = messageRoleLabel(m, messageRuntimeLabel);
            const canCopy = Boolean(m.content?.trim()) && !thinking && !isThought;
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
                        void copyTextToClipboard(m.content).then(
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
                          content: m.content,
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
                {thinking ? (
                  <ThinkingIndicator />
                ) : typing ? (
                  <StreamingText
                    content={m.content || ""}
                    revealImmediately={m.revealImmediately}
                    onProgress={onTypingProgress}
                  />
                ) : (
                  <MarkdownMessage
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
                  <div className="message__meta-stack">{messageMetaLines}</div>
                ) : null}
              </>
            );
            const messageActions =
              messageActionButtons || m.role === "assistant" ? (
                <div className={`message__actions message__actions--${visualRole}`}>
                  {messageActionButtons}
                  {m.role === "assistant" ? <AssistantTiming message={m} /> : null}
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
