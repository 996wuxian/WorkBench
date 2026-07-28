/** Markdown rendering for agent output. Parsing lives in `lib/markdown`. */
import { useMemo, useState, type ReactNode } from "react";

import { IconCheck, IconCopy } from "./icons";
import { copyTextToClipboard } from "../lib/format";
import { parseMarkdownBlocks, safeHref } from "../lib/markdown";
import { emitToast } from "../lib/toast";

type CodeTokenKind =
  | "comment"
  | "function"
  | "keyword"
  | "number"
  | "operator"
  | "property"
  | "punctuation"
  | "string";

const CODE_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "switch",
  "throw",
  "true",
  "try",
  "type",
  "undefined",
  "var",
  "while",
]);

const CODE_TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:as|async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|new|null|of|private|protected|public|readonly|return|switch|throw|true|try|type|undefined|var|while)\b|\b\d+(?:\.\d+)?\b|\.[A-Za-z_$][\w$]*|\b[A-Za-z_$][\w$]*(?=\s*[(])|\b[A-Za-z_$][\w$]*(?=\s*:)|[{}()[\].,;:?]|=>|===|!==|==|!=|<=|>=|&&|\|\||[+\-*/%=<>!&|^~]/g;

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

function nextMeaningfulChar(source: string, index: number): string {
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (!/\s/.test(char)) return char;
  }
  return "";
}

function codeTokenKind(source: string, text: string, index: number): CodeTokenKind {
  if (text.startsWith("//") || text.startsWith("/*")) return "comment";
  if (/^["'`]/.test(text)) {
    return nextMeaningfulChar(source, index + text.length) === ":"
      ? "property"
      : "string";
  }
  if (CODE_KEYWORDS.has(text)) return "keyword";
  if (/^\d/.test(text)) return "number";
  if (text.startsWith(".")) return "property";
  if (/^[A-Za-z_$]/.test(text)) {
    return nextMeaningfulChar(source, index + text.length) === ":"
      ? "property"
      : "function";
  }
  if (/^[{}()[\].,;:?]$/.test(text)) return "punctuation";
  return "operator";
}

function renderHighlightedCode(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  CODE_TOKEN.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_TOKEN.exec(source))) {
    if (match.index > lastIndex) {
      nodes.push(source.slice(lastIndex, match.index));
    }
    const text = match[0];
    const kind = codeTokenKind(source, text, match.index);
    nodes.push(
      <span key={`${match.index}-${text}`} className={`code-token code-token--${kind}`}>
        {text}
      </span>,
    );
    lastIndex = CODE_TOKEN.lastIndex;
  }

  if (lastIndex < source.length) {
    nodes.push(source.slice(lastIndex));
  }
  return nodes;
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => renderHighlightedCode(text), [text]);
  const label = language.trim() || "code";

  return (
    <div className="markdown-message__code-window">
      <div className="markdown-message__code-chrome">
        <span className="markdown-message__traffic" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="markdown-message__code-tools">
          <span className="markdown-message__lang">{label}</span>
          <button
            type="button"
            className="markdown-message__copy"
            title="复制代码"
            aria-label="复制代码"
            onClick={(ev) => {
              ev.stopPropagation();
              void copyTextToClipboard(text).then(
                () => {
                  setCopied(true);
                  emitToast("已复制");
                  window.setTimeout(() => setCopied(false), 1200);
                },
                () => setCopied(false),
              );
            }}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </span>
      </div>
      <pre className="markdown-message__pre">
        <code>{highlighted}</code>
      </pre>
    </div>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);
  return (
    <div className="markdown-message">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "code":
            return <CodeBlock key={index} language={block.language} text={block.text} />;
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
          case "table":
            return (
              <div key={index} className="markdown-message__table-wrap">
                <table className="markdown-message__table">
                  <thead>
                    <tr>
                      {block.headers.map((header, headerIndex) => (
                        <th
                          key={headerIndex}
                          style={{
                            textAlign:
                              block.alignments[headerIndex] ?? undefined,
                          }}
                        >
                          {renderInlineMarkdown(header)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {block.headers.map((_, cellIndex) => (
                          <td
                            key={cellIndex}
                            style={{
                              textAlign:
                                block.alignments[cellIndex] ?? undefined,
                            }}
                          >
                            {renderInlineMarkdown(row[cellIndex] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "paragraph":
            return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
        }
      })}
    </div>
  );
}
