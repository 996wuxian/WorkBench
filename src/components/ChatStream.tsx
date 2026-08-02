/** Streaming-turn affordances: the thinking dots, the typewriter, the timer. */
import { useEffect, useMemo, useState } from "react";

import { IconChevronDown, IconChevronRight, IconFileText } from "./icons";
import { isCodeLikePath, renderHighlightedCode } from "../lib/codeHighlight";
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
  const latestHunkPath = useMemo(
    () => [...files].reverse().find((file) => hasDiffHunks(file))?.path ?? null,
    [files],
  );
  const [expandedPath, setExpandedPath] = useState<string | null>(latestHunkPath);

  useEffect(() => {
    setExpandedPath(latestHunkPath);
  }, [latestHunkPath]);

  if (files.length === 0) return null;

  return (
    <div
      className="message-change-summary"
      aria-label={`改动 ${files.length} 个文件，新增 ${totals.additions} 行，删除 ${totals.deletions} 行`}
    >
      <div className="message-change-summary__head">
        <IconFileText size={13} />
        <span className="message-change-summary__title">文件改动</span>
        <span className="message-change-summary__total">
          {files.length} 个文件
        </span>
      </div>
      <ul className="message-change-summary__list">
        {files.map((file) => {
          const displayPath = file.fullPath ?? file.path;
          const { name, directory } = splitFileDisplayPath(displayPath);
          const hasHunks = hasDiffHunks(file);
          const expanded = hasHunks && expandedPath === file.path;
          const changeKind =
            file.deletions > 0 && file.additions > 0
              ? "mixed"
              : file.deletions > 0
                ? "delete"
                : "add";
          return (
            <li key={file.path} className="message-change-summary__file">
              <button
                type="button"
                className="message-change-summary__file-row"
                disabled={!hasHunks}
                aria-expanded={hasHunks ? expanded : undefined}
                title={displayPath}
                onClick={() => {
                  if (!hasHunks) return;
                  setExpandedPath((current) =>
                    current === file.path ? null : file.path,
                  );
                }}
              >
                <span
                  className="message-change-summary__toggle"
                  aria-hidden="true"
                >
                  {hasHunks ? (
                    expanded ? (
                      <IconChevronDown size={13} />
                    ) : (
                      <IconChevronRight size={13} />
                    )
                  ) : null}
                </span>
                <span
                  className={`message-change-summary__file-icon message-change-summary__file-icon--${changeKind}`}
                  aria-hidden="true"
                >
                  <IconFileText size={14} />
                </span>
                <span className="message-change-summary__file-main">
                  <span className="message-change-summary__name">{name}</span>
                  {directory ? (
                    <span className="message-change-summary__path">
                      {directory}
                    </span>
                  ) : null}
                </span>
                <span className="message-change-summary__lines">
                  {file.additions + file.deletions} 行
                </span>
                <span className="message-change-summary__counts">
                  <span className="message-change-summary__count message-change-summary__count--add">
                    +{file.additions}
                  </span>
                  <span className="message-change-summary__count message-change-summary__count--delete">
                    -{file.deletions}
                  </span>
                </span>
              </button>
              {expanded ? <DiffPreview file={file} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function hasDiffHunks(file: WorktreeChangeStat): boolean {
  return Boolean(file.hunks?.some((hunk) => hunk.lines.length > 0));
}

function DiffPreview({ file }: { file: WorktreeChangeStat }) {
  const isCodeFile = isCodeLikePath(file.fullPath ?? file.path);

  return (
    <div className="message-change-diff" role="region" aria-label={file.path}>
      {file.hunks?.map((hunk, hunkIndex) => (
        <div
          key={`${file.path}:${hunkIndex}`}
          className="message-change-diff__hunk"
        >
          <div className="message-change-diff__hunk-head">
            {formatDiffHunkLabel(file, hunk, hunkIndex, file.hunks?.length ?? 1)}
          </div>
          <div className="message-change-diff__lines">
            {hunk.lines.map((line, lineIndex) => {
              const number =
                line.kind === "add"
                  ? line.newLine
                  : line.kind === "delete"
                    ? line.oldLine
                    : (line.oldLine ?? line.newLine);
              const marker =
                line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
              return (
                <div
                  key={`${file.path}:${hunkIndex}:${lineIndex}`}
                  className={`message-change-diff__line message-change-diff__line--${line.kind}`}
                >
                  <span className="message-change-diff__line-number">
                    {number ?? ""}
                  </span>
                  <span className="message-change-diff__marker">{marker}</span>
                  <span className="message-change-diff__content">
                    {isCodeFile
                      ? renderHighlightedCode(line.content || " ")
                      : (line.content || " ")}
                  </span>
                </div>
              );
            })}
          </div>
          {hunk.truncated ? (
            <div className="message-change-diff__truncated">
              ... hunk truncated
            </div>
          ) : null}
        </div>
      ))}
      {file.truncated ? (
        <div className="message-change-diff__truncated">
          ... diff truncated
        </div>
      ) : null}
    </div>
  );
}

function formatDiffHunkLabel(
  file: WorktreeChangeStat,
  hunk: NonNullable<WorktreeChangeStat["hunks"]>[number],
  hunkIndex: number,
  hunkCount: number,
) {
  const { name } = splitFileDisplayPath(file.fullPath ?? file.path);
  const hasOnlyAdds = hunk.lines.every((line) => line.kind === "add");
  const hasOnlyDeletes = hunk.lines.every((line) => line.kind === "delete");
  const action = hasOnlyAdds
    ? "新增预览"
    : hasOnlyDeletes
      ? "删除预览"
      : "变更片段";
  const index = hunkCount > 1 ? ` ${hunkIndex + 1}/${hunkCount}` : "";

  return `${name} · ${action}${index} · ${hunk.lines.length} 行`;
}

function splitFileDisplayPath(path: string) {
  const normalized = path.replaceAll("/", "\\");
  const index = normalized.lastIndexOf("\\");
  if (index < 0) {
    return { name: normalized, directory: "" };
  }
  return {
    name: normalized.slice(index + 1) || normalized,
    directory: normalized.slice(0, index),
  };
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
