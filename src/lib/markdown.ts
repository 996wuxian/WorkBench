/**
 * Minimal Markdown block parser.
 *
 * Deliberately hand-rolled and deliberately small: agent output is rendered as
 * it streams, so the parser runs on every frame of a long answer. It covers
 * fenced code, headings, quotes, tables, lists and paragraphs — everything else
 * falls through as plain text rather than pulling in a full CommonMark
 * implementation.
 */

export type MarkdownBlock =
  | { type: "code"; language: string; text: string }
  | { type: "heading"; depth: number; text: string }
  | { type: "quote"; text: string }
  | {
      type: "table";
      headers: string[];
      rows: string[][];
      alignments: TableAlignment[];
    }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string };

export type TableAlignment = "left" | "center" | "right" | null;

const READABLE_PARAGRAPH_MIN_LENGTH = 96;
const READABLE_PARAGRAPH_TARGET_LENGTH = 112;
const READABLE_PARAGRAPH_MAX_LENGTH = 156;

export function splitReadableParagraph(text: string): string[] {
  if (
    text.length < READABLE_PARAGRAPH_MIN_LENGTH ||
    text.includes("\n") ||
    !/[。！？!?；;]/.test(text)
  ) {
    return [text];
  }

  const sentences = splitSentences(text);
  if (sentences.length < 2) return [text];

  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current}${sentence}` : sentence;
    if (
      current &&
      (current.length >= READABLE_PARAGRAPH_TARGET_LENGTH ||
        next.length > READABLE_PARAGRAPH_MAX_LENGTH)
    ) {
      paragraphs.push(current.trim());
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current.trim()) paragraphs.push(current.trim());

  return paragraphs.length > 1 ? paragraphs : [text];
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let inCode = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode || !/[。！？!?；;]/.test(char)) continue;

    let end = index + 1;
    while (end < text.length && /[”’」』）)\]]/.test(text[end])) {
      end += 1;
    }
    while (end < text.length && /\s/.test(text[end])) {
      end += 1;
    }
    sentences.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }

  if (start < text.length) {
    sentences.push(text.slice(start));
  }

  return sentences.filter((sentence) => sentence.trim().length > 0);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseTableSeparator(line: string): TableAlignment[] | null {
  if (!line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const marker = cell.replace(/\s/g, "");
    if (!/^:?-{3,}:?$/.test(marker)) return null;
    const left = marker.startsWith(":");
    const right = marker.endsWith(":");
    alignments.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }
  return alignments;
}

function tableBlockAt(
  lines: string[],
  index: number,
): { block: MarkdownBlock; nextIndex: number } | null {
  if (index + 1 >= lines.length || !lines[index].includes("|")) return null;
  const alignments = parseTableSeparator(lines[index + 1]);
  if (!alignments) return null;

  const headers = splitTableRow(lines[index]);
  if (headers.length < 2 || headers.length !== alignments.length) return null;

  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && lines[nextIndex].trim().includes("|")) {
    const row = splitTableRow(lines[nextIndex]);
    if (row.length === 0) break;
    rows.push(headers.map((_, cellIndex) => row[cellIndex] ?? ""));
    nextIndex += 1;
  }

  return {
    block: { type: "table", headers, rows, alignments },
    nextIndex,
  };
}

function isImplicitIndentedListLine(line: string): boolean {
  return /^\s{2,}\S/.test(line) && !/^(\s*)([-*+]|\d+\.)\s+/.test(line);
}

function paragraphBlocksFromLines(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!isImplicitIndentedListLine(line)) {
      paragraph.push(line);
      index += 1;
      continue;
    }

    flushParagraph();
    const items: string[] = [];
    while (index < lines.length && isImplicitIndentedListLine(lines[index])) {
      items.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "list", ordered: false, items });
  }

  flushParagraph();
  return blocks;
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w.+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].match(/^```\s*$/)) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: "code",
        language: fence[1] ?? "",
        text: body.join("\n"),
      });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        depth: heading[1].length,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (line.match(/^>\s?/)) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].match(/^>\s?/)) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quote.join("\n").trim() });
      continue;
    }

    const table = tableBlockAt(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[2]) !== ordered) break;
        items.push(item[3].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].match(/^```/) &&
      !lines[index].match(/^(#{1,3})\s+(.+)$/) &&
      !lines[index].match(/^>\s?/) &&
      !tableBlockAt(lines, index) &&
      !lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/)
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(...paragraphBlocksFromLines(paragraph));
  }

  return blocks;
}

/**
 * Allow-list for link targets. Agent output is untrusted input, so anything
 * that is not plainly a web or mail link is rendered as text instead of
 * becoming a clickable `javascript:` / `file:` target.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}
