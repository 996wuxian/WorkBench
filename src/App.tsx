import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  WindowControls,
  toggleMaximizeFromTitlebar,
} from "./components/WindowControls";
import { RuntimeSelect } from "./components/RuntimeSelect";
import { ChoiceSelect } from "./components/ChoiceSelect";
import {
  IconChat,
  IconDoctor,
  IconCopy,
  IconFolder,
  IconNewChat,
  IconPanel,
  IconPanelRight,
  IconQuote,
  IconRefresh,
  IconSearch,
  IconSend,
  IconSettings,
  IconStop,
  IconClose,
  IconThemeMoon,
  IconThemeSun,
} from "./components/icons";
import { api, isTauri } from "./lib/api";
import { applyTheme, loadTheme, toggleTheme, type ThemeMode } from "./lib/theme";
import type {
  ChatMessage,
  CodexRouteStatus,
  PermissionMode,
  ProbeResult,
  RuntimeId,
  SessionMeta,
  SessionDeleteResult,
  SessionSelectionCatalog,
  SessionSnapshot,
  SessionState,
} from "./lib/types";
import { P0_RUNTIMES, RUNTIME_LABEL } from "./lib/types";

function stateDotClass(state: SessionState): string {
  if (state === "ready" || state === "streaming") return "status-dot--ok";
  if (state === "connecting" || state === "awaiting_permission")
    return "status-dot--warn";
  if (state === "disconnected") return "status-dot--err";
  return "status-dot--idle";
}

function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatElapsedSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remain = seconds - minutes * 60;
    return `${minutes}m ${remain.toFixed(remain >= 10 ? 1 : 2)}s`;
  }
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

const runtimeAvatarSrc: Partial<Record<RuntimeId, string>> = {
  grok: "/runtime-icons/grok.webp",
  codex: "/runtime-icons/codex.png",
};

const ASSISTANT_LOADING_TEXT = "thinking";
const SESSION_PAGE_SIZE = 30;
const INITIAL_VISIBLE_MESSAGES = 60;
const HISTORY_BATCH_SIZE = 40;
const CHAT_BOTTOM_THRESHOLD = 80;
const CHAT_TOP_THRESHOLD = 48;
const RUNTIME_PICK_STORAGE_KEY = "workbench.runtimePick";

async function deleteSessionById(sessionId: string): Promise<SessionDeleteResult> {
  return invoke<SessionDeleteResult>("session_delete", { sessionId });
}

type QuoteTarget = {
  messageId: string;
  role: ChatMessage["role"];
  runtimeId: RuntimeId | null;
  label: string;
  content: string;
};

function messageRoleLabel(message: ChatMessage, runtimeLabel: string): string {
  switch (message.role) {
    case "user":
      return "我";
    case "assistant":
      return runtimeLabel;
    case "thought":
      return "思考";
    case "tool":
      return "工具";
    default:
      return "系统";
  }
}

function quoteText(message: QuoteTarget): string {
  const body = message.content.trim();
  if (!body) return "";
  const quoted = body.replace(/\n/g, "\n> ");
  return `> ${message.label}\n> ${quoted}`;
}

function composeMessageText(
  quoted: QuoteTarget | null,
  text: string,
): string {
  const parts = [quoted ? quoteText(quoted) : "", text.trim()].filter(Boolean);
  return parts.join("\n\n");
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (!text.trim()) {
    throw new Error("empty content");
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "true");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  if (!ok) {
    throw new Error("clipboard unavailable");
  }
}

function defaultPermissionMode(runtimeId?: RuntimeId | null): PermissionMode {
  return runtimeId === "grok" ? "auto" : "ask";
}

function isHiddenCodexModel(model?: string | null): boolean {
  return model?.trim().toLowerCase() === "gpt-5";
}

function normalizeCodexModelId(model?: string | null): string {
  const value = model?.trim();
  if (!value || isHiddenCodexModel(value)) return "";
  const parts = value.split("-");
  if (parts.length === 3 && parts[0] === "gpt") {
    const suffix = parts[2].toLowerCase();
    if (suffix === "low" || suffix === "medium" || suffix === "high") {
      return `${parts[0]}-${parts[1]}`;
    }
  }
  return value;
}

function codexReasoningEffortFromModel(model?: string | null): string | null {
  const value = model?.trim().toLowerCase();
  if (!value) return null;
  const parts = value.split("-");
  if (parts.length === 3 && parts[0] === "gpt") {
    const suffix = parts[2];
    if (suffix === "low" || suffix === "medium" || suffix === "high") {
      return suffix;
    }
  }
  return null;
}

function canChangeSessionSettings(state: SessionState): boolean {
  return !["connecting", "streaming", "awaiting_permission"].includes(state);
}

function fallbackModelOptions(
  runtimeId: RuntimeId,
  currentModel?: string | null,
): SessionSelectionCatalog["modelOptions"] {
  const values = new Map<string, { value: string; label: string; hint?: string }>();
  const add = (value?: string | null, hint?: string) => {
    const v = runtimeId === "codex" ? normalizeCodexModelId(value) : value?.trim();
    if (!v || isHiddenCodexModel(v)) return;
    if (!values.has(v)) {
      values.set(v, { value: v, label: v, hint });
    }
  };

  add(currentModel, "当前会话");
  if (runtimeId === "codex") {
    add("gpt-5.5", "fallback");
    add("gpt-5.4", "fallback");
    add("default", "fallback");
  } else {
    add("grok-4.5", "fallback");
    add("default", "fallback");
  }

  return Array.from(values.values()).map((item) => ({
    value: item.value,
    label: item.label,
    hint: item.hint ?? null,
    disabled: false,
  }));
}

const CODEX_REASONING_OPTIONS: SessionSelectionCatalog["modelOptions"] = [
  { value: "low", label: "低", hint: null, disabled: false },
  { value: "medium", label: "中", hint: null, disabled: false },
  { value: "high", label: "高", hint: null, disabled: false },
];

function fallbackPermissionOptions(
  runtimeId: RuntimeId,
): SessionSelectionCatalog["permissionOptions"] {
  if (runtimeId === "grok") {
    return [
      {
        value: "auto",
        label: "Auto",
        hint: "auto_allow_permissions=true",
        disabled: false,
      },
      {
        value: "ask",
        label: "Ask",
        hint: "需要权限审批 UI",
        disabled: true,
      },
      {
        value: "read_only",
        label: "Read Only",
        hint: "Grok ACP 暂不支持",
        disabled: true,
      },
      {
        value: "full_access",
        label: "Full Access",
        hint: "Grok ACP 暂不支持",
        disabled: true,
      },
    ];
  }
  return [
    {
      value: "ask",
      label: "Ask",
      hint: "approvalPolicy=on-request; sandbox=workspace-write",
      disabled: false,
    },
    {
      value: "read_only",
      label: "Read Only",
      hint: "approvalPolicy=on-request; sandbox=read-only",
      disabled: false,
    },
    {
      value: "auto",
      label: "Approve for me",
      hint: "approvalPolicy=on-request; sandbox=workspace-write; approvalsReviewer=auto_review",
      disabled: false,
    },
    {
      value: "full_access",
      label: "Full Access",
      hint: "approvalPolicy=never; sandbox=danger-full-access",
      disabled: false,
    },
  ];
}

type MarkdownBlock =
  | { type: "code"; language: string; text: string }
  | { type: "heading"; depth: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string };

function runtimeAvatarLabel(runtimeId: RuntimeId): string {
  return `${RUNTIME_LABEL[runtimeId]} avatar`;
}

function formatSessionTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function compactLabel(value: string, maxChars: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function sessionDisplayTitle(session: SessionMeta): string {
  const title = session.title?.trim();
  const genericTitle =
    !title ||
    title === "Codex session" ||
    title === "Grok session" ||
    title.endsWith("· 新会话");
  if (!genericTitle) return title;
  if (session.summary?.trim()) {
    return compactLabel(session.summary, 64);
  }
  return title || `${RUNTIME_LABEL[session.runtimeId]} session`;
}

function sessionDisplaySummary(session: SessionMeta): string | null {
  const title = sessionDisplayTitle(session);
  const summary = session.summary?.trim();
  if (summary && summary !== title) return summary;
  if (session.lastResumeError) return `resume error: ${session.lastResumeError}`;
  if (session.projectPath) return session.projectPath;
  const nativeId = session.nativeSessionId ?? session.nativeThreadId;
  if (nativeId) return `native ${nativeId}`;
  return null;
}

function mergeSessions(prev: SessionMeta[], incoming: SessionMeta[]): SessionMeta[] {
  const map = new Map(prev.map((session) => [session.id, session]));
  for (const session of incoming) {
    map.set(session.id, { ...(map.get(session.id) ?? {}), ...session });
  }
  return [...map.values()].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function loadRuntimePick(): RuntimeId {
  try {
    const value = localStorage.getItem(RUNTIME_PICK_STORAGE_KEY);
    if (value && P0_RUNTIMES.includes(value as RuntimeId)) {
      return value as RuntimeId;
    }
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
  return "grok";
}

function saveRuntimePick(runtimeId: RuntimeId): void {
  try {
    localStorage.setItem(RUNTIME_PICK_STORAGE_KEY, runtimeId);
  } catch {
    // Ignore storage failures; the selected runtime still works in memory.
  }
}

function parseMarkdownBlocks(source: string): MarkdownBlock[] {
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

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function renderInlineMarkdown(text: string): ReactNode[] {
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

function MarkdownMessage({ content }: { content: string }) {
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
            return <blockquote key={index}>{renderInlineMarkdown(block.text)}</blockquote>;
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

function ThinkingIndicator() {
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

function findLastStreamingMessageIndex(
  messages: ChatMessage[],
  role: ChatMessage["role"],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === role && message.streaming) {
      return index;
    }
  }
  return -1;
}

function toolMessageKey(message: ChatMessage): string {
  return (
    message.toolName?.trim() ||
    message.toolTitle?.trim() ||
    message.content.trim() ||
    message.id
  );
}

function assistantElapsedLabel(message: ChatMessage, now = Date.now()): string | null {
  if (message.role !== "assistant" || !message.createdAt) return null;
  const startedAt = new Date(message.createdAt).getTime();
  if (Number.isNaN(startedAt)) return null;
  const endedAt = message.completedAt ? new Date(message.completedAt).getTime() : null;
  const referenceTime =
    endedAt !== null && !Number.isNaN(endedAt)
      ? endedAt
      : message.streaming || message.pending
        ? now
        : startedAt;
  const elapsed = Math.max(0, referenceTime - startedAt);
  const prefix = message.streaming || message.pending ? "耗时" : "总耗时";
  return `${prefix} ${formatElapsedSeconds(elapsed)}`;
}

function normalizeLoadedMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (
      message.role === "assistant" &&
      !message.streaming &&
      !message.pending &&
      !message.completedAt &&
      message.createdAt
    ) {
      return { ...message, completedAt: message.createdAt };
    }
    return message;
  });
}

function AssistantTiming({ message }: { message: ChatMessage }) {
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

  return <span className="message__duration message__duration--inline">{label}</span>;
}

function finalizeAssistantMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    pending: false,
    streaming: false,
    completedAt: message.completedAt ?? nowIso(),
  };
}

function StreamingText({
  content,
  onProgress,
}: {
  content: string;
  onProgress?: () => void;
}) {
  const characters = useMemo(() => Array.from(content), [content]);
  const [visibleCount, setVisibleCount] = useState(0);

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
        "typing-stream" + (visibleCount >= characters.length ? " typing-stream--done" : "")
      }
    >
      <span className="typing-stream__text" aria-live="polite">
        {characters.slice(0, visibleCount).join("")}
      </span>
      <span className="typing-stream__cursor" aria-hidden="true" />
    </span>
  );
}

function toolMessageLabel(message: ChatMessage): string {
  const title = message.toolTitle?.trim();
  const status = message.toolStatus?.trim();
  if (title && status) {
    return `${title} · ${status}`;
  }
  if (title) {
    return title;
  }
  if (status) {
    return status;
  }

  const content = message.content.trim();
  if (content) return content.replace(/^⚙\s*/, "");
  return "Tool";
}

/** Browser-only fallback so `pnpm dev:ui` works without Tauri. */
function mockSessions(): SessionMeta[] {
  const t = nowIso();
  return [
    {
      id: "sess_demo_grok",
      title: "Grok · 示例会话",
      runtimeId: "grok",
      projectPath: "X:\\1_2026_project\\work",
      modelId: "grok-4.5",
      permissionMode: "auto",
      createdAt: t,
      updatedAt: t,
    },
    {
      id: "sess_demo_codex",
      title: "Codex · 示例会话",
      runtimeId: "codex",
      projectPath: "X:\\1_2026_project\\work",
      modelId: "default",
      modelReasoningEffort: "high",
      permissionMode: "ask",
      createdAt: t,
      updatedAt: t,
    },
  ];
}

const idleSnapshot = (session?: SessionMeta | null): SessionSnapshot => ({
  sessionId: session?.id ?? null,
  runtimeId: session?.runtimeId ?? null,
  state: "idle",
  lastError: null,
  backend: session ? `${session.runtimeId}_stub` : "none",
  modelId: session?.modelId ?? null,
  modelReasoningEffort: session?.modelReasoningEffort ?? null,
  permissionMode: session?.permissionMode ?? defaultPermissionMode(session?.runtimeId),
  projectPath: session?.projectPath ?? null,
  title: session?.title ?? "Workbench",
});

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [pendingSession, setPendingSession] = useState<SessionMeta | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(idleSnapshot());
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [codexRoute, setCodexRoute] = useState<CodexRouteStatus | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [visibleMessageCounts, setVisibleMessageCounts] = useState<
    Record<string, number>
  >({});
  const [assistantTypingUntil, setAssistantTypingUntil] = useState<
    Record<string, number>
  >({});
  const [draft, setDraft] = useState("");
  const [quoteTarget, setQuoteTarget] = useState<QuoteTarget | null>(null);
  const [runtimePick, setRuntimePick] = useState<RuntimeId>(() =>
    loadRuntimePick(),
  );
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [controlCatalog, setControlCatalog] =
    useState<SessionSelectionCatalog | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [asideHidden, setAsideHidden] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionFilter, setSessionFilter] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    sessionId: string;
    left: number;
    top: number;
  } | null>(null);
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [deleteSessionBusy, setDeleteSessionBusy] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
  const [syncingRuntime, setSyncingRuntime] = useState<RuntimeId | null>(null);
  const [loadingMoreRuntime, setLoadingMoreRuntime] = useState<RuntimeId | null>(
    null,
  );
  const [nativeCursors, setNativeCursors] = useState<
    Partial<Record<RuntimeId, string | null>>
  >({});
  const [nativeHasMore, setNativeHasMore] = useState<
    Partial<Record<RuntimeId, boolean>>
  >({});
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [appDataDir, setAppDataDir] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState(
    isTauri() ? "Connecting Host…" : "UI preview mode (no Tauri)",
  );

  // Keep native window fill in sync (boot + theme toggles already call applyTheme).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    saveRuntimePick(runtimePick);
  }, [runtimePick]);

  const active = useMemo(
    () =>
      sessions.find((s) => s.id === activeId) ??
      (pendingSession?.id === activeId ? pendingSession : null),
    [sessions, pendingSession, activeId],
  );
  const activeModelValue = useMemo(
    () =>
      active?.runtimeId === "codex"
        ? normalizeCodexModelId(active?.modelId ?? snapshot.modelId ?? "")
        : active?.modelId ?? snapshot.modelId ?? "",
    [active?.modelId, active?.runtimeId, snapshot.modelId],
  );
  const activeRuntimeId = active?.runtimeId ?? snapshot.runtimeId ?? runtimePick;
  const messages = activeId ? (messagesBySession[activeId] ?? []) : [];
  const visibleMessageCount = activeId
    ? (visibleMessageCounts[activeId] ?? INITIAL_VISIBLE_MESSAGES)
    : INITIAL_VISIBLE_MESSAGES;
  const visibleMessages =
    messages.length > visibleMessageCount
      ? messages.slice(messages.length - visibleMessageCount)
      : messages;
  const visibleMessageGroups = useMemo(() => {
    const groups: Array<{ message: ChatMessage; toolMessages: ChatMessage[] }> = [];
    for (const message of visibleMessages) {
      if (message.role === "tool") {
        const previous = groups[groups.length - 1];
        if (previous?.message.role === "assistant") {
          const key = toolMessageKey(message);
          const existingIndex = previous.toolMessages.findIndex(
            (item) => toolMessageKey(item) === key,
          );
          if (existingIndex >= 0) {
            previous.toolMessages[existingIndex] = message;
          } else {
            previous.toolMessages.push(message);
          }
        } else {
          continue;
        }
        continue;
      }
      groups.push({ message, toolMessages: [] });
    }
    return groups;
  }, [visibleMessages]);
  const hiddenMessageCount = Math.max(0, messages.length - visibleMessages.length);
  const lastMessage = messages[messages.length - 1];
  const activeCodexModelFallback =
    active?.runtimeId === "codex"
      ? normalizeCodexModelId(
          codexRoute?.model ?? codexRoute?.latestForwardModel ?? null,
        ) || null
      : null;
  const activeModelLabel = active
    ? activeModelValue || activeCodexModelFallback || "default"
    : "default";
  const activeModelReasoningEffort = active?.runtimeId === "codex"
    ? (active?.modelReasoningEffort ??
        snapshot.modelReasoningEffort ??
        codexRoute?.modelReasoningEffort ??
        codexReasoningEffortFromModel(active?.modelId ?? snapshot.modelId) ??
        "high")
    : null;
  const activePermissionMode =
    active?.permissionMode ??
    snapshot.permissionMode ??
    defaultPermissionMode(active?.runtimeId ?? snapshot.runtimeId);
  const controlModelOptions = useMemo(
    () =>
      controlCatalog?.modelOptions.length
        ? controlCatalog.modelOptions
        : fallbackModelOptions(activeRuntimeId, activeModelValue),
    [activeRuntimeId, activeModelValue, controlCatalog],
  );
  const controlPermissionOptions = useMemo(
    () =>
      controlCatalog?.permissionOptions.length
        ? controlCatalog.permissionOptions
        : fallbackPermissionOptions(activeRuntimeId),
    [activeRuntimeId, controlCatalog],
  );
  const controlReasoningOptions = useMemo(
    () => CODEX_REASONING_OPTIONS,
    [],
  );
  const settingsChangeDisabled =
    !active || settingsBusy || !canChangeSessionSettings(snapshot.state);
  const activeIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionMeta[]>([]);
  const pendingSessionRef = useRef<SessionMeta | null>(null);
  const mockReplyTimerRef = useRef<number | null>(null);
  const sessionScrollRef = useRef<HTMLDivElement | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionContextMenuRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const pendingHistoryRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const assistantTypingTimersRef = useRef<Record<string, number>>({});
  const assistantTypingQueueRef = useRef<Record<string, string>>({});
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    pendingSessionRef.current = pendingSession;
  }, [pendingSession]);

  useEffect(() => {
    if (!active) {
      setControlCatalog(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        if (!isTauri()) {
          setControlCatalog({
            runtimeId: active.runtimeId,
            modelOptions: fallbackModelOptions(active.runtimeId, activeModelValue),
            permissionOptions: fallbackPermissionOptions(active.runtimeId),
          });
          return;
        }

        const catalog = await api.getSessionControlOptions(active.id);
        if (!cancelled) {
          setControlCatalog(catalog);
        }
      } catch (e) {
        if (!cancelled) {
          setStatusLine(String(e));
          setControlCatalog({
            runtimeId: active.runtimeId,
            modelOptions: fallbackModelOptions(active.runtimeId, activeModelValue),
            permissionOptions: fallbackPermissionOptions(active.runtimeId),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.runtimeId, activeModelValue]);

  useEffect(() => {
    return () => {
      if (mockReplyTimerRef.current !== null) {
        window.clearTimeout(mockReplyTimerRef.current);
      }
    };
  }, []);

  const updateSessionMessages = useCallback(
    (sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: updater(prev[sessionId] ?? []),
      }));
    },
    [],
  );

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroll = () => {
      const el = messageScrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
    };
    window.requestAnimationFrame(() => {
      scroll();
      window.requestAnimationFrame(scroll);
    });
  }, []);

  const resetChatViewport = useCallback(
    (sessionId: string, totalMessages: number) => {
      setVisibleMessageCounts((prev) => ({
        ...prev,
        [sessionId]:
          totalMessages > 0
            ? Math.min(totalMessages, INITIAL_VISIBLE_MESSAGES)
            : INITIAL_VISIBLE_MESSAGES,
      }));
      stickToBottomRef.current = true;
      scrollChatToBottom();
    },
    [scrollChatToBottom],
  );

  const revealOlderMessages = useCallback(() => {
    if (!activeId || hiddenMessageCount <= 0) return;
    const el = messageScrollRef.current;
    if (el) {
      pendingHistoryRestoreRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
    }
    setVisibleMessageCounts((prev) => {
      const current = prev[activeId] ?? INITIAL_VISIBLE_MESSAGES;
      return {
        ...prev,
        [activeId]: Math.min(messages.length, current + HISTORY_BATCH_SIZE),
      };
    });
  }, [activeId, hiddenMessageCount, messages.length]);

  const handleMessageScroll = useCallback(() => {
    const el = messageScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= CHAT_BOTTOM_THRESHOLD;
    if (el.scrollTop <= CHAT_TOP_THRESHOLD && hiddenMessageCount > 0) {
      revealOlderMessages();
    }
  }, [hiddenMessageCount, revealOlderMessages]);

  const handleTypingProgress = useCallback(() => {
    if (!stickToBottomRef.current) return;
    scrollChatToBottom();
  }, [scrollChatToBottom]);

  const markAssistantTyping = useCallback((messageId: string, content: string) => {
    const length = Array.from(content).length;
    const duration = Math.max(900, Math.min(3200, 240 + length * 22));
    const until = Date.now() + duration;
    setAssistantTypingUntil((prev) => ({ ...prev, [messageId]: until }));
    const existing = assistantTypingTimersRef.current[messageId];
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    assistantTypingTimersRef.current[messageId] = window.setTimeout(() => {
      setAssistantTypingUntil((prev) => {
        if (!(messageId in prev)) return prev;
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      delete assistantTypingTimersRef.current[messageId];
    }, duration);
  }, []);

  const queueAssistantTyping = useCallback((messageId: string, content: string) => {
    assistantTypingQueueRef.current[messageId] = content;
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(assistantTypingTimersRef.current)) {
        window.clearTimeout(timer);
      }
      assistantTypingTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    const queue = assistantTypingQueueRef.current;
    const entries = Object.entries(queue);
    if (entries.length === 0) return;
    assistantTypingQueueRef.current = {};
    for (const [messageId, content] of entries) {
      markAssistantTyping(messageId, content);
    }
  }, [messagesBySession, markAssistantTyping]);

  useEffect(() => {
    const pending = pendingHistoryRestoreRef.current;
    if (!pending) return;
    pendingHistoryRestoreRef.current = null;
    window.requestAnimationFrame(() => {
      const el = messageScrollRef.current;
      if (!el) return;
      const delta = el.scrollHeight - pending.scrollHeight;
      el.scrollTop = pending.scrollTop + delta;
    });
  }, [visibleMessages.length]);

  useEffect(() => {
    if (!activeId || pendingHistoryRestoreRef.current) return;
    if (stickToBottomRef.current) {
      scrollChatToBottom();
    }
  }, [
    activeId,
    assistantTypingUntil,
    lastMessage?.content,
    lastMessage?.id,
    lastMessage?.streaming,
    scrollChatToBottom,
    visibleMessages.length,
  ]);

  const refreshSessionMeta = useCallback(async (sessionId: string) => {
    if (!isTauri()) return;
    const session =
      sessionsRef.current.find((item) => item.id === sessionId) ??
      (pendingSessionRef.current?.id === sessionId ? pendingSessionRef.current : null);
    const runtimeId = session?.runtimeId;

    try {
      if (runtimeId === "grok" || runtimeId === "codex") {
        const result = await api.syncNativeSessions(runtimeId, SESSION_PAGE_SIZE, null);
        setSessions((prev) => mergeSessions(prev, result.sessions));
        setNativeCursors((prev) => ({
          ...prev,
          [runtimeId]: result.nextCursor ?? null,
        }));
        setNativeHasMore((prev) => ({
          ...prev,
          [runtimeId]: result.hasMore,
        }));
        setPendingSession((prev) =>
          prev && result.sessions.some((item) => item.id === prev.id) ? null : prev,
        );
        return;
      }

      const list = await api.listSessions();
      setSessions(list);
      setPendingSession((prev) =>
        prev && list.some((item) => item.id === prev.id) ? null : prev,
      );
    } catch (error) {
      try {
        const list = await api.listSessions();
        setSessions(list);
        setPendingSession((prev) =>
          prev && list.some((item) => item.id === prev.id) ? null : prev,
        );
      } catch {
        setStatusLine(`refresh session meta failed: ${String(error)}`);
      }
    }
  }, []);

  // Host → UI stream / state events (real ACP path)
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    void (async () => {
      const u1 = await listen<{
        sessionId: string;
        kind: string;
        text: string;
        done: boolean;
      }>("session://stream", (ev) => {
        if (cancelled) return;
        const p = ev.payload;
        if (p.kind === "thought") {
          updateSessionMessages(p.sessionId, (m) => {
            const streamIndex = findLastStreamingMessageIndex(m, "thought");
            if (streamIndex >= 0) {
              const last = m[streamIndex];
              return [
                ...m.slice(0, streamIndex),
                { ...last, content: last.content + p.text },
                ...m.slice(streamIndex + 1),
              ];
            }
            return [
              ...m,
              {
                id: uid("th"),
                role: "thought",
                content: p.text,
                streaming: true,
              },
            ];
          });
          return;
        }
        // assistant
        updateSessionMessages(p.sessionId, (m) => {
          const streamIndex = findLastStreamingMessageIndex(m, "assistant");
          if (streamIndex >= 0) {
            const last = m[streamIndex];
            if (last.pending) {
              if (!p.text && p.done) {
                return [...m.slice(0, streamIndex), ...m.slice(streamIndex + 1)];
              }
              const nextContent = p.text || last.content || ASSISTANT_LOADING_TEXT;
              queueAssistantTyping(last.id, nextContent);
              return [
                ...m.slice(0, streamIndex),
                {
                  ...last,
                  content: nextContent,
                  pending: false,
                  streaming: !p.done,
                  createdAt: last.createdAt ?? nowIso(),
                  completedAt: p.done ? last.completedAt ?? nowIso() : null,
                },
                ...m.slice(streamIndex + 1),
              ];
            }
            const nextContent = last.content + (p.text || "");
            if (p.text) {
              queueAssistantTyping(last.id, nextContent);
            }
            const next = {
              ...last,
              content: nextContent,
              streaming: !p.done,
              completedAt: p.done ? last.completedAt ?? nowIso() : null,
            };
            return [...m.slice(0, streamIndex), next, ...m.slice(streamIndex + 1)];
          }
          if (p.text) {
            const messageId = uid("a");
            queueAssistantTyping(messageId, p.text);
            return [
              ...m,
              {
                id: messageId,
                role: "assistant",
                content: p.text || "",
                streaming: !p.done,
                pending: false,
                createdAt: nowIso(),
                completedAt: p.done ? nowIso() : null,
              },
            ];
          }
          return m;
        });
      });
      if (!cancelled) unsubs.push(u1);

      const u2 = await listen<SessionSnapshot>("session://state", (ev) => {
        if (cancelled) return;
        const snap = ev.payload;
        if (snap.sessionId && snap.sessionId === activeIdRef.current) {
          setSnapshot(snap);
        }
      });
      if (!cancelled) unsubs.push(u2);

      const u3 = await listen<{
        sessionId: string;
        title: string;
        name: string;
        status: string;
      }>("session://tool", (ev) => {
        if (cancelled) return;
        const toolTitle = (ev.payload.title || ev.payload.name || "Tool").trim();
        const toolName = (ev.payload.name || ev.payload.title || toolTitle || "tool").trim();
        const toolStatus = ev.payload.status.trim();
        updateSessionMessages(ev.payload.sessionId, (m) => {
          const nextMessage: ChatMessage = {
            id: uid("tool"),
            role: "tool",
            content: "",
            toolTitle,
            toolName,
            toolStatus,
          };
          const last = m[m.length - 1];
          if (
            last?.role === "tool" &&
            last.toolTitle === toolTitle &&
            last.toolName === toolName
          ) {
            if (last.toolStatus === toolStatus) return m;
            return [...m.slice(0, -1), { ...last, ...nextMessage }];
          }
          return [...m, nextMessage];
        });
      });
      if (!cancelled) unsubs.push(u3);

      const u4 = await listen<{
        sessionId: string;
        code: string;
        message: string;
      }>("session://error", (ev) => {
        if (cancelled) return;
        updateSessionMessages(ev.payload.sessionId, (m) => {
          const closed = m
            .filter((msg) => !(msg.role === "assistant" && msg.pending))
            .map((msg) => (msg.streaming ? finalizeAssistantMessage(msg) : msg));
          return [
            ...closed,
            {
              id: uid("sys"),
              role: "system",
              content: `error ${ev.payload.code}: ${ev.payload.message}`,
            },
          ];
        });
      });
      if (!cancelled) unsubs.push(u4);

      const u5 = await listen<{ sessionId: string; stopReason: string }>(
        "session://prompt_complete",
        (ev) => {
          if (cancelled) return;
          const sessionId = ev.payload.sessionId;
          updateSessionMessages(ev.payload.sessionId, (m) =>
            m.map((msg) => {
              if (msg.role === "assistant" && msg.pending) {
                const runtimeName = msg.runtimeId
                  ? RUNTIME_LABEL[msg.runtimeId]
                  : "Agent";
                return {
                  id: uid("sys"),
                  role: "system",
                  content: `error EMPTY_RESPONSE: ${runtimeName} 本轮已结束，但没有返回任何可显示内容（stopReason: ${ev.payload.stopReason}）。`,
                };
              }
              return msg.streaming ? finalizeAssistantMessage(msg) : msg;
            }),
          );
          void (async () => {
            if (!isTauri()) return;
            try {
              const restored = normalizeLoadedMessages(await api.getMessages(sessionId));
              setMessagesBySession((prev) => ({
                ...prev,
                [sessionId]: restored,
              }));
              const staleIds = (messagesBySession[sessionId] ?? []).map((message) => message.id);
              if (staleIds.length > 0) {
                setAssistantTypingUntil((prev) => {
                  const next = { ...prev };
                  for (const id of staleIds) {
                    delete next[id];
                  }
                  return next;
                });
              }
              await refreshSessionMeta(sessionId);
            } catch (error) {
              setStatusLine(`reload messages failed: ${String(error)}`);
            }
          })();
        },
      );
      if (!cancelled) unsubs.push(u5);
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [refreshSessionMeta, updateSessionMessages]);

  const refreshProbes = useCallback(async () => {
    if (!isTauri()) {
      setProbes([
        {
          runtimeId: "grok",
          found: true,
          path: "D:\\tools\\grok\\bin\\grok.exe",
          version: "0.2.111",
          detail: "browser mock",
        },
        {
          runtimeId: "codex",
          found: true,
          path: "D:\\codex\\codex.exe",
          version: "0.144.4",
          detail: "browser mock",
        },
      ]);
      return;
    }
    try {
      const list = await api.probeAll();
      setProbes(list);
    } catch (e) {
      setStatusLine(`probe failed: ${String(e)}`);
    }
  }, []);

  const refreshCodexRoute = useCallback(async () => {
    if (!isTauri()) {
      setCodexRoute({
        routeKind: "cc-switch",
        ccSwitchDetected: true,
        codexConfigPath: "C:\\Users\\kata\\.codex\\config.toml",
        modelProvider: "custom",
        model: "gpt-5.5",
        baseUrl: "http://127.0.0.1:15721/v1",
        wireApi: "responses",
        ccSwitchDir: "C:\\Users\\kata\\.cc-switch",
        ccSwitchDbPath: "C:\\Users\\kata\\.cc-switch\\cc-switch.db",
        ccSwitchLogPath: "C:\\Users\\kata\\.cc-switch\\logs\\cc-switch.log",
        latestForwardUrl: "https://api.999555999.com/v1/responses",
        latestForwardModel: "gpt-5.5",
        latestError: null,
        note: "Codex 通过 cc-switch 本地代理路由；Grok 保持原生 ACP，不走 cc-switch。",
      });
      return;
    }
    try {
      setCodexRoute(await api.codexRouteStatus());
    } catch (e) {
      setStatusLine(`codex route probe failed: ${String(e)}`);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    if (!isTauri()) {
      const list = mockSessions();
      setPendingSession(null);
      setSessions(list);
      setActiveId(list[0]?.id ?? null);
      setSnapshot(idleSnapshot(list[0]));
      if (list[0]) {
        setMessagesBySession({
          [list[0].id]: [
            {
              id: uid("sys"),
              role: "system",
              content:
                "Workbench 骨架已就绪。当前为浏览器预览；`pnpm dev`（Tauri）后走真实 Host 命令。P0 引擎：Grok + Codex。",
            },
          ],
        });
      }
      setStatusLine("UI preview · mock sessions");
      return;
    }

    try {
      const info = await api.appInfo();
      setAppDataDir(info.dataDir);
      setStatusLine(`${info.name} ${info.version} · ${info.dataDir}`);
      const list = await api.listSessions();
      setPendingSession(null);
      setSessions(list);
      if (list.length > 0) {
        const first = list[0];
        setActiveId(first.id);
        const snap = await api.getSnapshot(first.id);
        setSnapshot(snap);
        const restored = normalizeLoadedMessages(await api.getMessages(first.id));
        setMessagesBySession((prev) => ({
          ...prev,
          [first.id]: restored,
        }));
        resetChatViewport(first.id, restored.length);
      } else {
        setActiveId(null);
        setSnapshot(idleSnapshot());
      }
    } catch (e) {
      setStatusLine(`host error: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void refreshProbes();
    void refreshCodexRoute();
  }, [loadSessions, refreshProbes, refreshCodexRoute]);

  const activateSession = useCallback(
    async (id: string, metaOverride?: SessionMeta | null) => {
      setPendingSession(null);
      setActiveId(id);
      setQuoteTarget(null);
      const meta = metaOverride ?? sessions.find((s) => s.id === id) ?? null;
      if (!isTauri()) {
        setSnapshot(idleSnapshot(meta));
        resetChatViewport(id, messagesBySession[id]?.length ?? 0);
        return;
      }
      try {
        const snap = await api.getSnapshot(id);
        setSnapshot(snap);
        const restored = normalizeLoadedMessages(await api.getMessages(id));
        setMessagesBySession((prev) => ({
          ...prev,
          [id]: restored,
        }));
        resetChatViewport(id, restored.length);
      } catch (e) {
        setStatusLine(String(e));
      }
    },
    [messagesBySession, resetChatViewport, sessions],
  );

  async function selectSession(id: string) {
    void activateSession(id);
  }

  const openSelectedSessionLocation = useCallback(async (sessionId: string) => {
    setSessionContextMenu(null);
    if (!isTauri()) {
      setStatusLine("UI preview · open location unavailable");
      return;
    }
    try {
      const path = await api.openSessionLocation(sessionId);
      setStatusLine(`opened location · ${path}`);
    } catch (e) {
      setStatusLine(`open location failed: ${String(e)}`);
    }
  }, []);

  const requestDeleteSession = useCallback((sessionId: string) => {
    setSessionContextMenu(null);
    setDeleteSessionError(null);
    setDeleteSessionId(sessionId);
  }, []);

  const confirmDeleteSession = useCallback(async () => {
    if (!deleteSessionId || deleteSessionBusy) return;
    if (!isTauri()) {
      setStatusLine("UI preview · delete unavailable");
      setDeleteSessionId(null);
      return;
    }
    const sessionId = deleteSessionId;
    const target = sessions.find((s) => s.id === sessionId) ?? pendingSession;
    const removedMessages = messagesBySession[sessionId] ?? [];
    setDeleteSessionBusy(true);
    setDeleteSessionError(null);
    try {
      const result = await deleteSessionById(sessionId);
      setDeleteSessionId(null);
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setAssistantTypingUntil((prev) => {
        const next = { ...prev };
        for (const message of removedMessages) {
          delete next[message.id];
        }
        return next;
      });
      setPendingSession((prev) => (prev?.id === sessionId ? null : prev));
      const nextSessions = sessions.filter((item) => item.id !== sessionId);
      setSessions(nextSessions);

      if (result.activeSessionId) {
        const nextMeta =
          nextSessions.find((item) => item.id === result.activeSessionId) ??
          nextSessions[0] ??
          null;
        if (nextMeta) {
          await activateSession(nextMeta.id, nextMeta);
        } else {
          setActiveId(null);
          setSnapshot(idleSnapshot());
        }
      } else if (activeId === sessionId) {
        if (nextSessions.length > 0) {
          const nextMeta = nextSessions[0];
          await activateSession(nextMeta.id, nextMeta);
        } else {
          setActiveId(null);
          setSnapshot(idleSnapshot());
        }
      }

      setStatusLine(
        `deleted session${target ? ` · ${target.title}` : ""} · ${result.deletedPath}`,
      );
      setQuoteTarget((prev) => (prev?.messageId === sessionId ? null : prev));
    } catch (e) {
      const message = `delete failed: ${String(e)}`;
      setDeleteSessionError(message);
      setStatusLine(message);
    } finally {
      setDeleteSessionBusy(false);
    }
  }, [
    activateSession,
    activeId,
    deleteSessionBusy,
    deleteSessionId,
    messagesBySession,
    pendingSession,
    sessions,
  ]);

  const sessionContextTarget = useMemo(() => {
    if (!sessionContextMenu) return null;
    return (
      sessions.find((session) => session.id === sessionContextMenu.sessionId) ??
      (pendingSession?.id === sessionContextMenu.sessionId ? pendingSession : null)
    );
  }, [pendingSession, sessionContextMenu, sessions]);

  const sessionPathFor = useCallback(
    (sessionId: string) =>
      appDataDir ? `${appDataDir}\\sessions\\${sessionId}` : sessionId,
    [appDataDir],
  );

  const deleteTargetSession = useMemo(() => {
    if (!deleteSessionId) return null;
    return (
      sessions.find((session) => session.id === deleteSessionId) ??
      (pendingSession?.id === deleteSessionId ? pendingSession : null)
    );
  }, [deleteSessionId, pendingSession, sessions]);

  useEffect(() => {
    if (!sessionContextMenu) return;
    const close = () => setSessionContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sessionContextMenuRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [sessionContextMenu]);

  useEffect(() => {
    const suppressGlobalContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".session-item")) {
        return;
      }
      event.preventDefault();
      setSessionContextMenu(null);
    };
    window.addEventListener("contextmenu", suppressGlobalContextMenu);
    return () => {
      window.removeEventListener("contextmenu", suppressGlobalContextMenu);
    };
  }, []);

  async function createSession() {
    setBusy(true);
    try {
      setQuoteTarget(null);
      if (!isTauri()) {
        const meta: SessionMeta = {
          id: uid("sess"),
          title: `${RUNTIME_LABEL[runtimePick]} · 新会话`,
          runtimeId: runtimePick,
          projectPath: "X:\\1_2026_project\\work",
          modelId: runtimePick === "grok" ? "grok-4.5" : "default",
          modelReasoningEffort: runtimePick === "codex" ? "high" : null,
          permissionMode: defaultPermissionMode(runtimePick),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        setPendingSession(meta);
        setActiveId(meta.id);
        setSnapshot(idleSnapshot(meta));
        resetChatViewport(meta.id, 0);
        updateSessionMessages(meta.id, () => []);
        return;
      }
      const meta = await api.createSession(runtimePick, null);
      setPendingSession(meta);
      setActiveId(meta.id);
      const snap = await api.getSnapshot(meta.id);
      setSnapshot(snap);
      resetChatViewport(meta.id, 0);
      updateSessionMessages(meta.id, () => []);
    } catch (e) {
      setStatusLine(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateActiveSessionSettings(patch: {
    modelId?: string;
    modelReasoningEffort?: string | null;
    permissionMode?: PermissionMode;
  }) {
    if (!active || settingsChangeDisabled) return;
    const wasLive =
      snapshot.state === "ready" || snapshot.state === "streaming";
    setSettingsBusy(true);
    try {
      if (!isTauri()) {
        const nextMeta: SessionMeta = {
          ...active,
          modelId: patch.modelId ?? active.modelId,
          modelReasoningEffort:
            patch.modelReasoningEffort ?? active.modelReasoningEffort,
          permissionMode: patch.permissionMode ?? active.permissionMode,
          updatedAt: nowIso(),
        };
        setPendingSession((prev) => (prev?.id === active.id ? nextMeta : prev));
        setSessions((prev) =>
          prev.map((session) => (session.id === active.id ? nextMeta : session)),
        );
        setSnapshot((prev) => ({
          ...prev,
          modelId: nextMeta.modelId,
          modelReasoningEffort: nextMeta.modelReasoningEffort,
          permissionMode: nextMeta.permissionMode,
          state:
            prev.state === "ready" || prev.state === "streaming"
              ? "disconnected"
              : prev.state,
          backend:
            prev.state === "ready" || prev.state === "streaming" ? "none" : prev.backend,
        }));
        return;
      }

      const nextMeta = await api.updateSessionSettings(active.id, patch);
      setPendingSession((prev) => (prev?.id === nextMeta.id ? nextMeta : prev));
      setSessions((prev) =>
        prev.map((session) => (session.id === nextMeta.id ? nextMeta : session)),
      );
      if (activeIdRef.current === nextMeta.id) {
        const baseSnapshot = {
          ...snapshot,
          modelId: nextMeta.modelId,
          modelReasoningEffort: nextMeta.modelReasoningEffort,
          permissionMode: nextMeta.permissionMode,
          state: wasLive ? ("disconnected" as SessionState) : snapshot.state,
          backend: wasLive ? "none" : snapshot.backend,
        };
        setSnapshot(baseSnapshot);
        if (wasLive) {
          const snap = await api.connect(nextMeta.id);
          if (activeIdRef.current === nextMeta.id) {
            setSnapshot(snap);
          }
        }
      }
    } catch (e) {
      setStatusLine(String(e));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || !active) return;
    const text = composeMessageText(quoteTarget, body);
    const session = active;
    setDraft("");
    stickToBottomRef.current = true;
    scrollChatToBottom("smooth");
    const userMsg: ChatMessage = {
      id: uid("u"),
      role: "user",
      content: text,
      runtimeId: session.runtimeId,
    };
    updateSessionMessages(session.id, (m) => [...m, userMsg]);

    if (!isTauri()) {
      updateSessionMessages(session.id, (m) => [
        ...m,
        {
          id: uid("a"),
          role: "assistant",
          content: ASSISTANT_LOADING_TEXT,
          runtimeId: session.runtimeId,
          streaming: true,
          pending: true,
          createdAt: nowIso(),
          completedAt: null,
        },
      ]);
      setSnapshot((s) => ({ ...s, state: "streaming" }));
      mockReplyTimerRef.current = window.setTimeout(() => {
        updateSessionMessages(session.id, (m) => {
          const replyId = uid("a");
          const replyContent = `[${RUNTIME_LABEL[session.runtimeId]} stub]\n收到：${text}\n\n下一步会接入真实 Adapter（Grok ACP / Codex App Server）。`;
          queueAssistantTyping(replyId, replyContent);
          const last = m[m.length - 1];
          const reply: ChatMessage = {
            id: replyId,
            role: "assistant",
            content: replyContent,
            runtimeId: session.runtimeId,
            createdAt: last?.role === "assistant" ? last.createdAt ?? nowIso() : nowIso(),
            completedAt: nowIso(),
          };
          if (last?.role === "assistant" && last.pending) {
            return [...m.slice(0, -1), reply];
          }
          return [...m, reply];
        });
        if (activeIdRef.current === session.id) {
          setSnapshot((s) => ({ ...s, state: "ready" }));
        }
      setPendingSession((prev) => (prev?.id === session.id ? null : prev));
      setSessions((prev) =>
        prev.some((item) => item.id === session.id)
          ? prev
          : [{ ...session, updatedAt: nowIso() }, ...prev],
      );
      setQuoteTarget(null);
      mockReplyTimerRef.current = null;
      }, 400);
      return;
    }

    try {
      setBusy(true);
      updateSessionMessages(session.id, (m) => [
        ...m,
        {
          id: uid("a"),
          role: "assistant",
          content: ASSISTANT_LOADING_TEXT,
          runtimeId: session.runtimeId,
          streaming: true,
          pending: true,
          createdAt: nowIso(),
          completedAt: null,
        },
      ]);
      setSnapshot((s) => ({ ...s, state: "streaming" }));
      await api.send(session.id, text);
      const list = await api.listSessions();
      setSessions(list);
      setPendingSession((prev) => (prev?.id === session.id ? null : prev));
      setQuoteTarget(null);
    } catch (e) {
      updateSessionMessages(session.id, (m) => [
        ...m.filter(
          (msg) =>
            !(
              msg.role === "assistant" &&
              ((msg.pending && msg.streaming) || (msg.streaming && !msg.content))
            ),
        ),
        {
          id: uid("sys"),
          role: "system",
          content: `send failed: ${String(e)}`,
        },
      ]);
      if (activeIdRef.current === session.id) {
        setSnapshot((s) => ({ ...s, state: "disconnected" }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function stopActive() {
    if (!active) return;

    if (!isTauri() && mockReplyTimerRef.current !== null) {
      window.clearTimeout(mockReplyTimerRef.current);
      mockReplyTimerRef.current = null;
    }

    const sessionId = active.id;
    updateSessionMessages(sessionId, (m) =>
      m
        .filter((msg) => !(msg.role === "assistant" && msg.pending))
        .map((msg) => (msg.streaming ? finalizeAssistantMessage(msg) : msg)),
    );
    setSnapshot((s) =>
      s.state === "streaming" || s.state === "awaiting_permission"
        ? { ...s, state: "ready" }
        : s,
    );
    setBusy(false);

    if (!isTauri()) return;

    try {
      await api.stop(active.id);
      const snap = await api.getSnapshot(active.id);
      setSnapshot(snap);
    } catch (e) {
      setStatusLine(`stop failed: ${String(e)}`);
    }
  }

  const syncNativeSessions = useCallback(
    async (mode: "reset" | "more" = "reset") => {
      if (!isTauri()) {
        setStatusLine("UI preview · native sync unavailable");
        return;
      }
      const runtime = runtimePick;
      const loadingMore = mode === "more";
      if (loadingMore && nativeHasMore[runtime] === false) return;
      if (syncingRuntime || loadingMoreRuntime) return;

      if (loadingMore) {
        setLoadingMoreRuntime(runtime);
      } else {
        setSyncingRuntime(runtime);
      }
      try {
        const result = await api.syncNativeSessions(
          runtime,
          SESSION_PAGE_SIZE,
          loadingMore ? (nativeCursors[runtime] ?? null) : null,
        );
        setSessions((prev) => mergeSessions(prev, result.sessions));
        setNativeCursors((prev) => ({
          ...prev,
          [runtime]: result.nextCursor ?? null,
        }));
        setNativeHasMore((prev) => ({
          ...prev,
          [runtime]: result.hasMore,
        }));
        setStatusLine(
          `${RUNTIME_LABEL[runtime]} synced · ${result.sessions.length} sessions`,
        );
      } catch (e) {
        setStatusLine(`sync failed: ${String(e)}`);
      } finally {
        setSyncingRuntime(null);
        setLoadingMoreRuntime(null);
      }
    },
    [
      loadingMoreRuntime,
      nativeCursors,
      nativeHasMore,
      runtimePick,
      syncingRuntime,
    ],
  );

  const handleSessionScroll = useCallback(() => {
    const el = sessionScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    if (!nearBottom) return;
    if (nativeHasMore[runtimePick] === false) return;
    if (loadingMoreRuntime || syncingRuntime) return;
    void syncNativeSessions("more");
  }, [
    loadingMoreRuntime,
    nativeHasMore,
    runtimePick,
    syncNativeSessions,
    syncingRuntime,
  ]);

  const filteredSessions = useMemo(() => {
    const q = sessionFilter.trim().toLowerCase();
    const scoped = sessions.filter((s) => s.runtimeId === runtimePick);
    if (!q) return scoped;
    return scoped.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.summary ?? "").toLowerCase().includes(q) ||
        s.runtimeId.includes(q) ||
        (s.modelId ?? "").toLowerCase().includes(q) ||
        (s.nativeSessionId ?? "").toLowerCase().includes(q) ||
        (s.nativeThreadId ?? "").toLowerCase().includes(q),
    );
  }, [runtimePick, sessions, sessionFilter]);

  const runtimeSessionCount = useMemo(
    () => sessions.filter((s) => s.runtimeId === runtimePick).length,
    [runtimePick, sessions],
  );

  const streaming = snapshot.state === "streaming";
  const routeDiagnosticsPanel = (
    <>
      <div className="probe-card">
        <div className="probe-card__row">
          <strong>Codex 路由</strong>
          <span
            style={{
              color:
                codexRoute?.routeKind === "cc-switch"
                  ? "var(--success)"
                  : "var(--text-secondary)",
              fontSize: 11,
            }}
          >
            {codexRoute?.routeKind ?? "unknown"}
          </span>
        </div>
        <div className="route-kv">
          <span>provider</span>
          <strong>{codexRoute?.modelProvider ?? "—"}</strong>
        </div>
        <div className="route-kv">
          <span>model</span>
          <strong>{codexRoute?.model ?? codexRoute?.latestForwardModel ?? "—"}</strong>
        </div>
        <div className="route-kv">
          <span>base_url</span>
          <strong>{codexRoute?.baseUrl ?? "—"}</strong>
        </div>
        <div className="route-kv">
          <span>wire_api</span>
          <strong>{codexRoute?.wireApi ?? "—"}</strong>
        </div>
        {codexRoute?.latestForwardUrl ? (
          <div className="route-kv">
            <span>forward</span>
            <strong>{codexRoute.latestForwardUrl}</strong>
          </div>
        ) : null}
        {codexRoute?.latestError ? (
          <div className="route-note route-note--warn">
            {codexRoute.latestError}
          </div>
        ) : null}
        <div className="route-note">{codexRoute?.note ?? "正在检测 Codex 路由。"}</div>
        <div className="route-actions">
          <button
            type="button"
            className="chip chip--btn"
            onClick={() => void refreshCodexRoute()}
          >
            <IconRefresh size={13} />
            刷新
          </button>
          <button
            type="button"
            className="chip chip--btn"
            onClick={async () => {
              try {
                setStatusLine(await api.openCcSwitch());
              } catch (e) {
                setStatusLine(String(e));
              }
            }}
          >
            <IconSettings size={13} />
            打开 cc-switch
          </button>
        </div>
      </div>
      <div className="probe-card">
        <div className="probe-card__row">
          <strong>Grok 路由</strong>
          <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
            native
          </span>
        </div>
        <div className="route-note">
          Grok 使用原生 ACP 会话，不读取也不经过 cc-switch。
        </div>
      </div>
    </>
  );

  return (
    <div
      className="app-shell platform-win has-custom-chrome"
      data-theme={theme}
    >
      <WindowControls visible={isTauri()} />

      <div className="workbench">
        {/* ── Left rail ── */}
        <aside
          className={"sidebar" + (sidebarHidden ? " sidebar--hidden" : "")}
          aria-hidden={sidebarHidden}
        >
          <div
            className="sidebar-chrome"
            data-tauri-drag-region
            onDoubleClick={() => void toggleMaximizeFromTitlebar()}
          >
            <button
              type="button"
              className="chrome-btn chrome-btn--traffic is-on"
              title="隐藏侧栏"
              onClick={() => setSidebarHidden(true)}
            >
              <IconPanel size={16} />
            </button>
            <div className="sidebar-chrome__drag" data-tauri-drag-region />
          </div>

          <div className="sidebar-brand-row">
            <div className="sidebar-brand-row__left">
              <img
                className="app-logo"
                src="/logo.png"
                alt=""
                width={28}
                height={28}
                draggable={false}
              />
              <span>Workbench</span>
            </div>
          </div>

          <div className="sidebar-nav">
            <div className="sidebar-runtime-pick">
              <RuntimeSelect
                value={runtimePick}
                onChange={setRuntimePick}
                aria-label="默认引擎"
                title="新建会话使用的引擎"
                options={(
                  [
                    { id: "grok", label: "Grok Build", hint: "ACP · 真连接" },
                    { id: "codex", label: "Codex", hint: "App Server · stub" },
                  ] as const
                ).filter((o) => P0_RUNTIMES.includes(o.id))}
              />
            </div>
            <div className="sidebar-nav__new-row">
              <button
                type="button"
                className="nav-new"
                disabled={busy}
                onClick={() => void createSession()}
              >
                <span className="nav-item__icon">
                  <IconNewChat size={16} />
                </span>
                新建会话
              </button>
              <button
                type="button"
                className={"chrome-btn" + (showSearch ? " is-on" : "")}
                title="搜索会话"
                onClick={() => {
                  setShowSearch((v) => !v);
                  if (showSearch) setSessionFilter("");
                }}
              >
                <IconSearch size={16} />
              </button>
            </div>
          </div>

          {showSearch && (
            <div className="session-filter">
              <input
                className="session-filter__input"
                aria-label="过滤会话"
                placeholder="过滤会话…"
                value={sessionFilter}
                onChange={(e) => setSessionFilter(e.target.value)}
                autoFocus
              />
            </div>
          )}

          <div
            className="sidebar__scroll"
            ref={sessionScrollRef}
            onScroll={handleSessionScroll}
          >
            <div className="sidebar__section-row">
              <div className="sidebar__section-label">Sessions</div>
              <button
                type="button"
                className="section-icon-btn"
                title={`同步 ${RUNTIME_LABEL[runtimePick]} 原生会话`}
                disabled={syncingRuntime === runtimePick}
                onClick={() => void syncNativeSessions("reset")}
              >
                <IconRefresh size={14} />
              </button>
            </div>
            {filteredSessions.length === 0 && (
              <div className="sidebar-empty">
                {runtimeSessionCount === 0
                  ? `还没有 ${RUNTIME_LABEL[runtimePick]} 会话。点同步或新建会话。`
                  : "没有匹配的会话。"}
              </div>
            )}
            {filteredSessions.map((s) => {
              const displayTitle = sessionDisplayTitle(s);
              const displaySummary = sessionDisplaySummary(s);
              return (
                <button
                  type="button"
                  key={s.id}
                  className={
                    "session-item" + (activeId === s.id ? " session-item--active" : "")
                  }
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setSessionContextMenu({
                      sessionId: s.id,
                      left: Math.max(8, Math.min(ev.clientX, window.innerWidth - 224)),
                      top: Math.max(8, Math.min(ev.clientY, window.innerHeight - 120)),
                    });
                  }}
                  onClick={() => void selectSession(s.id)}
                >
                  <span className={`runtime-dot runtime-dot--${s.runtimeId}`} />
                  <span className="session-item__body">
                    <span className="session-item__topline">
                      <span className="session-item__title">{displayTitle}</span>
                      <span className="session-item__time">
                        {formatSessionTime(s.nativeUpdatedAt ?? s.updatedAt)}
                      </span>
                    </span>
                    {displaySummary ? (
                      <span className="session-item__summary">{displaySummary}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {loadingMoreRuntime === runtimePick ? (
              <div className="session-load-state">加载更多…</div>
            ) : nativeHasMore[runtimePick] ? (
              <button
                type="button"
                className="session-load-more"
                onClick={() => void syncNativeSessions("more")}
              >
                加载更多
              </button>
            ) : runtimeSessionCount > 0 ? (
              <div className="session-load-state">已到列表底部</div>
            ) : null}
          </div>

          <button
            type="button"
            className="sidebar__footer"
            title="设置"
            onClick={() => {
              setSettingsOpen(true);
              void refreshCodexRoute();
            }}
          >
            <IconSettings size={16} />
            <span className="sidebar__footer-meta">
              <span className="sidebar__footer-name">设置</span>
              <span className="sidebar__footer-sub">主题 · 引擎 · 权限</span>
            </span>
          </button>
        </aside>

        {/* ── Main ── */}
        <main className={"main" + (asideHidden ? " main--aside-hidden" : "")}>
          <div
            className="main__top"
            data-tauri-drag-region
            onDoubleClick={() => void toggleMaximizeFromTitlebar()}
          >
            <div className="main__title-row" data-tauri-drag-region>
              {sidebarHidden && (
                <button
                  type="button"
                  className="chrome-btn chrome-btn--traffic"
                  title="显示侧栏"
                  onClick={() => setSidebarHidden(false)}
                >
                  <IconPanel size={16} />
                </button>
              )}
              {active ? (
                <>
                  <h1 className="main__title" data-tauri-drag-region>
                    {active.title}
                  </h1>
                  <span className={`status-dot ${stateDotClass(snapshot.state)}`} />
                  <span className="main__sub">
                    {snapshot.state} · {snapshot.backend}
                  </span>
                </>
              ) : (
                <>
                  <IconChat size={16} />
                  <h1 className="main__title">Workbench</h1>
                  <span className="main__sub">{statusLine}</span>
                </>
              )}
            </div>
            <div className="main__top-actions">
              <button
                type="button"
                className="chrome-btn"
                title={theme === "dark" ? "切换亮色" : "切换暗色"}
                onClick={() => setTheme((t) => toggleTheme(t))}
              >
                {theme === "dark" ? (
                  <IconThemeSun size={16} />
                ) : (
                  <IconThemeMoon size={16} />
                )}
              </button>
              <button
                type="button"
                className={"chrome-btn" + (!asideHidden ? " is-on" : "")}
                title={asideHidden ? "显示 Doctor" : "隐藏 Doctor"}
                onClick={() => setAsideHidden((v) => !v)}
              >
                <IconPanelRight size={16} />
              </button>
            </div>
          </div>

          {!active ? (
            <div className="empty-state">
              <div>
                <div className="empty-state__icon">
                  <img
                    className="app-logo app-logo--lg"
                    src="/logo.png"
                    alt=""
                    width={48}
                    height={48}
                    draggable={false}
                  />
                </div>
                <div className="empty-state__title">Workbench</div>
                <div>本机多 Agent 指挥台</div>
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  左侧选择引擎并新建会话 · Grok 已接真 ACP
                </div>
              </div>
            </div>
          ) : (
            <>
              <div
                className="message-list"
                ref={messageScrollRef}
                onScroll={handleMessageScroll}
              >
                {messages.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state__icon">
                      <IconChat size={28} />
                    </div>
                    直接输入发送。Grok 走真 ACP；Codex 仍为 stub。
                  </div>
                ) : (
                  <>
                    {hiddenMessageCount > 0 ? (
                      <button
                        type="button"
                        className="message-history-load"
                        onClick={revealOlderMessages}
                      >
                        加载更早消息 · {hiddenMessageCount}
                      </button>
                    ) : (
                      <div className="message-history-state">已加载全部历史</div>
                    )}
                    {visibleMessageGroups.map(({ message: m, toolMessages }) => {
                      if (m.role === "assistant" && !m.streaming && !m.content) {
                        return null;
                      }
                      const visualRole =
                        m.role === "thought" || m.role === "tool"
                          ? "system"
                          : m.role;
                      const messageRuntime =
                        m.runtimeId ?? active.runtimeId ?? snapshot.runtimeId ?? "grok";
                      const messageRuntimeLabel = RUNTIME_LABEL[messageRuntime];
                      const avatarSrc =
                        m.role === "assistant" ? runtimeAvatarSrc[messageRuntime] : null;
                      const thinking = m.role === "assistant" && m.pending && m.streaming;
                      const typing =
                        m.role === "assistant" &&
                        (m.streaming ||
                          (assistantTypingUntil[m.id] ?? 0) > Date.now()) &&
                        !thinking;
                      const messageMetaLines = m.role === "assistant" && toolMessages.length
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
                      const canCopy = Boolean(m.content?.trim()) && !thinking;
                      const canQuote = canCopy;
                      const messageActionButtons = canCopy || canQuote ? (
                        <>
                          {canCopy ? (
                            <button
                              type="button"
                              className="message__action"
                              title="复制消息"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                void copyTextToClipboard(m.content).then(
                                  () => setStatusLine("已复制消息"),
                                  (error) =>
                                    setStatusLine(`复制失败: ${String(error)}`),
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
                                setQuoteTarget({
                                  messageId: m.id,
                                  role: m.role,
                                  runtimeId: m.runtimeId ?? active.runtimeId ?? snapshot.runtimeId ?? null,
                                  label: quoteLabel,
                                  content: m.content,
                                });
                                composerInputRef.current?.focus();
                                setStatusLine(`已引用 ${quoteLabel}`);
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
                              onProgress={handleTypingProgress}
                            />
                          ) : (
                            <MarkdownMessage content={m.content || ""} />
                          )}
                          {messageMetaLines ? (
                            <div className="message__meta-stack">{messageMetaLines}</div>
                          ) : null}
                        </>
                      );

                      if (!avatarSrc) {
                        return (
                          <div
                            key={m.id}
                            className={`message-block message-block--${visualRole}`}
                          >
                            <div
                              className={`message message--${visualRole}`}
                              style={
                                m.role === "thought"
                                  ? { opacity: 0.75, fontStyle: "italic" }
                                  : undefined
                              }
                            >
                              {messageBubble}
                            </div>
                            {messageActionButtons || m.role === "assistant" ? (
                              <div className={`message__actions message__actions--${visualRole}`}>
                                {messageActionButtons}
                                {m.role === "assistant" ? (
                                  <AssistantTiming message={m} />
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      }

                      return (
                        <div key={m.id} className="message-row message-row--assistant">
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
                            {messageActionButtons || m.role === "assistant" ? (
                              <div className="message__actions message__actions--assistant">
                                {messageActionButtons}
                                {m.role === "assistant" ? (
                                  <AssistantTiming message={m} />
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>

              <div className="composer">
                <div className="composer__shell">
                  <div className="composer__toolbar">
                    <ChoiceSelect
                      className="composer-control composer-control--model"
                      value={activeModelValue}
                      options={controlModelOptions}
                      disabled={settingsChangeDisabled}
                      placement="top"
                      aria-label="当前会话模型"
                      title="切换当前会话模型"
                      placeholder={activeModelLabel}
                      onChange={(value) =>
                        void updateActiveSessionSettings({ modelId: value })
                      }
                    />
                    {activeRuntimeId === "codex" ? (
                      <ChoiceSelect
                        className="composer-control composer-control--effort"
                        value={activeModelReasoningEffort ?? "high"}
                        options={controlReasoningOptions}
                        disabled={settingsChangeDisabled}
                        placement="top"
                        aria-label="当前会话推理档位"
                        title="切换当前会话推理档位"
                        placeholder="级别"
                        onChange={(value) =>
                          void updateActiveSessionSettings({
                            modelReasoningEffort: value,
                          })
                        }
                      />
                    ) : null}
                    <ChoiceSelect
                      className="composer-control composer-control--permission"
                      value={activePermissionMode}
                      options={controlPermissionOptions}
                      disabled={settingsChangeDisabled}
                      placement="top"
                      aria-label="当前会话权限"
                      title="切换当前会话权限"
                      placeholder="权限"
                      onChange={(value) =>
                        void updateActiveSessionSettings({
                          permissionMode: value as PermissionMode,
                        })
                      }
                    />
                  </div>
                  {quoteTarget ? (
                    <div className="composer__quote">
                      <div className="composer__quote-label">
                        <IconQuote size={13} />
                        <span>{quoteTarget.label}</span>
                      </div>
                      <div className="composer__quote-text">
                        {compactLabel(quoteTarget.content.replace(/\s+/g, " "), 180)}
                      </div>
                      <button
                        type="button"
                        className="composer__quote-close"
                        title="取消引用"
                        onClick={() => setQuoteTarget(null)}
                      >
                        <IconClose size={14} />
                      </button>
                    </div>
                  ) : null}
                  <textarea
                    ref={composerInputRef}
                    className="composer__input"
                    placeholder={`Message ${RUNTIME_LABEL[active.runtimeId]}…`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                  <div className="composer__footer">
                    <span className="muted" style={{ fontSize: 12 }}>
                      Enter 发送 · Shift+Enter 换行
                    </span>
                    {streaming ? (
                      <button
                        type="button"
                        className="composer__send is-stop"
                        title="停止"
                        onClick={() => void stopActive()}
                      >
                        <IconStop size={16} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="composer__send"
                        title="发送"
                        disabled={!draft.trim() || busy}
                        onClick={() => void sendMessage()}
                      >
                        <IconSend size={16} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </main>

        {/* ── Right Doctor rail ── */}
        <aside
          className={"aside" + (asideHidden ? " aside--hidden" : "")}
          aria-hidden={asideHidden}
        >
          <div
            className="aside__chrome"
            data-tauri-drag-region
            onDoubleClick={() => void toggleMaximizeFromTitlebar()}
          >
            <span className="aside__chrome-title">
              <IconDoctor size={14} /> Doctor
            </span>
          </div>
          <div className="aside__body">
            <button
              type="button"
              className="btn btn--block"
              style={{ marginBottom: 12 }}
              onClick={() => {
                void refreshProbes();
                void refreshCodexRoute();
              }}
            >
              <IconRefresh size={15} />
              重新探测
            </button>
            {probes.map((p) => (
              <div key={p.runtimeId} className="probe-card">
                <div className="probe-card__row">
                  <strong>{RUNTIME_LABEL[p.runtimeId]}</strong>
                  <span
                    style={{
                      color: p.found ? "var(--success)" : "var(--danger)",
                      fontSize: 11,
                    }}
                  >
                    {p.found ? "found" : "missing"}
                  </span>
                </div>
                <div
                  className="muted"
                  style={{ fontSize: 11, marginTop: 6, wordBreak: "break-all" }}
                >
                  {p.path ?? "—"}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {p.version ?? p.detail ?? ""}
                </div>
              </div>
            ))}
            <div className="sidebar__section-label" style={{ marginTop: 8 }}>
              路由
            </div>
            {routeDiagnosticsPanel}
            <div className="sidebar__section-label" style={{ marginTop: 8 }}>
              Host
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {statusLine}
            </div>
          </div>
        </aside>
      </div>
      {settingsOpen ? (
        <div
          className="settings-overlay"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) {
              setSettingsOpen(false);
            }
          }}
        >
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="设置"
          >
            <div className="settings-dialog__head">
              <div>
                <div className="settings-dialog__title">设置</div>
                <div className="settings-dialog__sub">引擎路由</div>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setSettingsOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="settings-dialog__body">
              <div className="sidebar__section-label">Codex / Grok</div>
              {routeDiagnosticsPanel}
            </div>
          </section>
        </div>
      ) : null}
      {sessionContextMenu
        ? createPortal(
            <div
              ref={sessionContextMenuRef}
              className="session-context-menu"
              role="menu"
              style={{
                left: sessionContextMenu.left,
                top: sessionContextMenu.top,
              }}
              onMouseDown={(ev) => ev.stopPropagation()}
            >
              <div className="session-context-menu__title">
                {sessionContextTarget?.title ?? "会话"}
              </div>
              <button
                type="button"
                className="session-context-menu__item"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  void openSelectedSessionLocation(sessionContextMenu.sessionId)
                }}
              >
                <IconFolder size={14} />
                <span>打开文件所在位置</span>
              </button>
              <button
                type="button"
                className="session-context-menu__item session-context-menu__item--danger"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  requestDeleteSession(sessionContextMenu.sessionId);
                }}
              >
                <IconClose size={14} />
                <span>删除会话</span>
              </button>
            </div>,
            document.body,
          )
        : null}
      {deleteSessionId
        ? createPortal(
          <div
            className="settings-overlay"
            role="presentation"
            onMouseDown={(ev) => {
              if (ev.target === ev.currentTarget) {
                setDeleteSessionError(null);
                setDeleteSessionId(null);
              }
            }}
          >
              <section
                className="settings-dialog session-delete-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="删除会话"
              >
                <div className="settings-dialog__head">
                  <div>
                    <div className="settings-dialog__title">删除会话</div>
                    <div className="settings-dialog__sub">
                      删除后会移除会话文件夹和记录
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={deleteSessionBusy}
                    onClick={() => {
                      setDeleteSessionError(null);
                      setDeleteSessionId(null);
                    }}
                  >
                    关闭
                  </button>
                </div>
                <div className="settings-dialog__body session-delete-dialog__body">
                  <div className="session-delete-dialog__title">
                    {deleteTargetSession?.title ?? deleteSessionId}
                  </div>
                  <div className="session-delete-dialog__path">
                    {sessionPathFor(deleteSessionId)}
                  </div>
                  <div className="session-delete-dialog__note">
                    此操作会删除会话及其文件夹内容，无法恢复。
                  </div>
                  {deleteSessionError ? (
                    <div className="session-delete-dialog__error">
                      {deleteSessionError}
                    </div>
                  ) : null}
                  <div className="session-delete-dialog__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={deleteSessionBusy}
                      onClick={() => {
                        setDeleteSessionError(null);
                        setDeleteSessionId(null);
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={deleteSessionBusy}
                      onClick={() => void confirmDeleteSession()}
                    >
                      {deleteSessionBusy ? "删除中..." : "删除"}
                    </button>
                  </div>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
