/** Streaming-turn affordances: the thinking dots, the typewriter, the timer. */
import { useEffect, useMemo, useState } from "react";

import { IconFileText } from "./icons";
import { assistantElapsedLabel } from "../lib/messages";
import { worktreeChangeTotals } from "../lib/worktreeChanges";
import type { ChatMessage, WorktreeChangeStat } from "../lib/types";

export function ThinkingIndicator() {
  return (
    <span className="thinking-indicator" aria-label="thinking...">
      <span className="thinking-indicator__label">thinking</span>
      <span className="thinking-indicator__dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  );
}

/**
 * Elapsed time for one assistant turn. Ticks only while the turn is open, so a
 * long transcript of finished messages costs no timers at all.
 */
export function AssistantTiming({ message }: { message: ChatMessage }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!message.streaming && !message.pending) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, [message.streaming, message.pending, message.id]);

  const label = assistantElapsedLabel(message, now);
  if (!label) return null;

  return (
    <span className="message__duration message__duration--inline">{label}</span>
  );
}

export function AssistantWorktreeChanges({
  files,
}: {
  files: WorktreeChangeStat[];
}) {
  const totals = worktreeChangeTotals(files);
  if (files.length === 0) return null;

  return (
    <div
      className="message-change-summary"
      aria-label={`改动 ${files.length} 个文件，新增 ${totals.additions} 行，删除 ${totals.deletions} 行`}
    >
      <div className="message-change-summary__head">
        <IconFileText size={13} />
        <span>改动 {files.length} 个文件</span>
        <span className="message-change-summary__count message-change-summary__count--add">
          +{totals.additions}
        </span>
        <span className="message-change-summary__count message-change-summary__count--delete">
          -{totals.deletions}
        </span>
      </div>
      <ul className="message-change-summary__list">
        {files.map((file) => (
          <li key={file.path} className="message-change-summary__file">
            <span className="message-change-summary__path" title={file.path}>
              {file.path}
            </span>
            <span className="message-change-summary__lines">
              {file.additions + file.deletions} 行
            </span>
            <span className="message-change-summary__count message-change-summary__count--add">
              +{file.additions}
            </span>
            <span className="message-change-summary__count message-change-summary__count--delete">
              -{file.deletions}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Typewriter reveal for text that already arrived.
 *
 * Agents deliver a turn in bursty chunks; replaying them at a steady rate reads
 * far better than the text snapping into place. The step size scales with how
 * far behind we are so a large paste still catches up quickly.
 */
export function StreamingText({
  content,
  revealImmediately = false,
  onProgress,
}: {
  content: string;
  revealImmediately?: boolean;
  onProgress?: () => void;
}) {
  const characters = useMemo(() => Array.from(content), [content]);
  const [visibleCount, setVisibleCount] = useState(() =>
    revealImmediately ? characters.length : 0,
  );

  useEffect(() => {
    setVisibleCount((current) => Math.min(current, characters.length));
  }, [characters.length]);

  useEffect(() => {
    onProgress?.();
  }, [onProgress, visibleCount, characters.length]);

  useEffect(() => {
    if (visibleCount >= characters.length) return;

    const timer = window.setInterval(() => {
      setVisibleCount((current) => {
        if (current >= characters.length) {
          window.clearInterval(timer);
          return current;
        }
        const remaining = characters.length - current;
        const step = remaining > 160 ? 8 : remaining > 48 ? 4 : 2;
        const next = Math.min(characters.length, current + step);
        if (next >= characters.length) {
          window.clearInterval(timer);
        }
        return next;
      });
    }, 18);

    return () => {
      window.clearInterval(timer);
    };
  }, [characters.length]);

  return (
    <span
      className={
        "typing-stream" +
        (visibleCount >= characters.length ? " typing-stream--done" : "")
      }
    >
      <span className="typing-stream__text" aria-live="polite">
        {characters.slice(0, visibleCount).join("")}
      </span>
      <span className="typing-stream__cursor" aria-hidden="true" />
    </span>
  );
}
