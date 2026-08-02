import type { ReactNode } from "react";

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
  /\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|\.[A-Za-z_$][\w$]*|[{}()[\].,;:?]|[+\-*/%=!<>|&~^]+/g;

const CODE_FILE_EXTENSIONS = new Set([
  "astro",
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "dart",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "lua",
  "md",
  "mjs",
  "php",
  "ps1",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const CODE_FILE_NAMES = new Set([
  "dockerfile",
  "makefile",
  "package.json",
  "pnpm-lock.yaml",
  "cargo.toml",
  "cargo.lock",
]);

export function isCodeLikePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (CODE_FILE_NAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return CODE_FILE_EXTENSIONS.has(name.slice(dot + 1));
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

export function renderHighlightedCode(source: string): ReactNode[] {
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
