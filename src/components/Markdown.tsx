/** Markdown rendering for agent output. Parsing lives in `lib/markdown`. */
import type { ReactNode } from "react";

import { parseMarkdownBlocks, safeHref } from "../lib/markdown";

export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const token = /(`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      nodes.push(<code key={`code-${match.index}`}>{match[2]}</code>);
    } else {
      const label = match[3];
      const href = safeHref(match[4]);
      nodes.push(
        href ? (
          <a
            key={`link-${match.index}`}
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {label}
          </a>
        ) : (
          // Rejected scheme: show the target instead of hiding it, so the user
          // can see what the agent actually tried to link to.
          `${label} (${match[4]})`
        ),
      );
    }
    lastIndex = token.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);
  return (
    <div className="markdown-message">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "code":
            return (
              <pre key={index} className="markdown-message__pre">
                {block.language ? (
                  <span className="markdown-message__lang">{block.language}</span>
                ) : null}
                <code>{block.text}</code>
              </pre>
            );
          case "heading": {
            const content = renderInlineMarkdown(block.text);
            if (block.depth === 1) return <h3 key={index}>{content}</h3>;
            if (block.depth === 2) return <h4 key={index}>{content}</h4>;
            return <h5 key={index}>{content}</h5>;
          }
          case "quote":
            return (
              <blockquote key={index}>
                {renderInlineMarkdown(block.text)}
              </blockquote>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
                ))}
              </ListTag>
            );
          }
          case "paragraph":
            return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
        }
      })}
    </div>
  );
}
