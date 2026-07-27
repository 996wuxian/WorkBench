/**
 * Minimal Markdown block parser.
 *
 * Deliberately hand-rolled and deliberately small: agent output is rendered as
 * it streams, so the parser runs on every frame of a long answer. It covers
 * fenced code, headings, quotes, lists and paragraphs — everything else falls
 * through as plain text rather than pulling in a full CommonMark implementation.
 */

export type MarkdownBlock =
  | { type: "code"; language: string; text: string }
  | { type: "heading"; depth: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string };

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
      !lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/)
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
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
