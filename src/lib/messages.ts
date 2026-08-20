/** Transcript helpers: labelling, quoting and reconciling chat messages. */
import type { ChatMessage, RuntimeId, SessionSnapshot } from "./types";
import { formatElapsedSeconds, nowIso } from "./format";
import { stripWorktreeChangeMarkers } from "./worktreeChanges";

export type QuoteTarget = {
  messageId: string;
  role: ChatMessage["role"];
  runtimeId: RuntimeId | null;
  label: string;
  content: string;
};

export function messageRoleLabel(
  message: ChatMessage,
  runtimeLabel: string,
): string {
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

export function isPermissionResolutionNotice(
  message: Pick<ChatMessage, "role" | "content">,
): boolean {
  return (
    message.role === "system" &&
    /^权限请求「.+」已由 .+ 处理为 .+。$/.test(message.content.trim())
  );
}

export function quoteText(message: QuoteTarget): string {
  const body = stripWorktreeChangeMarkers(message.content).trim();
  if (!body) return "";
  const quoted = body.replace(/\n/g, "\n> ");
  return `> ${message.label}\n> ${quoted}`;
}

export function composeMessageText(
  quoted: QuoteTarget | null,
  text: string,
): string {
  const parts = [quoted ? quoteText(quoted) : "", text.trim()].filter(Boolean);
  return parts.join("\n\n");
}

export function findLastStreamingMessageIndex(
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

/**
 * Identity of a tool call across status updates. The runtime-native id is the
 * only reliable key — titles change as a call progresses ("Read main.rs" →
 * "Read main.rs (120 lines)") and would otherwise stack up as separate rows.
 */
export function toolMessageKey(message: ChatMessage): string {
  const callId = message.toolCallId?.trim();
  if (callId) return `id:${callId}`;
  return (
    message.toolName?.trim() ||
    message.toolTitle?.trim() ||
    message.content.trim() ||
    message.id
  );
}

export function toolMessageLabel(message: ChatMessage): string {
  const title = compactToolTitle(message);
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

  // Journals written before tool records were structured only carry the
  // rendered line, so fall back to it instead of showing a bare "Tool".
  const content = message.content.trim();
  if (content) return content.replace(/^⚙\s*/, "");
  return "Tool";
}

function compactToolTitle(message: ChatMessage): string | undefined {
  const title = message.toolTitle?.trim();
  if (!title) return undefined;

  if (message.toolName?.trim() === "command") {
    const writtenPath = title.match(/Set-Content\s+-LiteralPath\s+['"]([^'"]+)['"]/i)?.[1];
    if (writtenPath) return `PowerShell · write ${writtenPath}`;
    if (title.length > 180) {
      const cmdlet = title.match(/\b([A-Za-z]+-[A-Za-z]+)\b/)?.[1];
      if (cmdlet) return `PowerShell · ${cmdlet}`;
      return "Command";
    }
  }

  if (title.length <= 180) return title;
  return `${Array.from(title).slice(0, 177).join("")}...`;
}

export function assistantElapsedLabel(
  message: ChatMessage,
  now = Date.now(),
): string | null {
  if (message.role !== "assistant" || !message.createdAt) return null;
  const startedAt = new Date(message.createdAt).getTime();
  if (Number.isNaN(startedAt)) return null;
  const endedAt = message.completedAt
    ? new Date(message.completedAt).getTime()
    : null;
  const referenceTime =
    endedAt !== null && !Number.isNaN(endedAt)
      ? endedAt
      : message.streaming || message.pending
        ? now
        : startedAt;
  const pausedMs = Math.max(0, message.elapsedPausedMs ?? 0);
  const pauseStartedAt = message.elapsedPauseStartedAt
    ? new Date(message.elapsedPauseStartedAt).getTime()
    : null;
  const activePausedMs =
    pauseStartedAt !== null &&
    !Number.isNaN(pauseStartedAt) &&
    (message.streaming || message.pending) &&
    endedAt === null
      ? Math.max(0, now - pauseStartedAt)
      : 0;
  const elapsed = Math.max(0, referenceTime - startedAt - pausedMs - activePausedMs);
  if (!message.streaming && !message.pending && elapsed === 0) return null;
  const prefix = message.streaming || message.pending ? "耗时" : "总耗时";
  return `${prefix} ${formatElapsedSeconds(elapsed)}`;
}

/**
 * Adapt journal records to what the transcript expects.
 *
 * A record restored from a mid-stream checkpoint has no completion time because
 * the turn never finished; it is shown with an interrupted marker rather than
 * silently dressed up as a normal answer.
 */
export function normalizeLoadedMessages(
  messages: ChatMessage[],
  snapshot?: SessionSnapshot,
): ChatMessage[] {
  const normalized = messages.map((message) => {
    if (message.completedAt && (message.streaming || message.pending)) {
      return { ...message, streaming: false, pending: false };
    }
    if (
      message.role === "assistant" &&
      !message.streaming &&
      !message.pending &&
      !message.partial &&
      !message.completedAt &&
      message.createdAt
    ) {
      return { ...message, completedAt: message.createdAt };
    }
    return message;
  });

  if (
    !snapshot?.promptStartedAt ||
    (snapshot.state !== "streaming" && snapshot.state !== "awaiting_permission")
  ) {
    return normalized;
  }
  const promptStartedAt = snapshot.promptStartedAt;

  let lastUserIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  let hasActiveAssistant = false;
  const live = normalized.map((message, index) => {
    if (
      index <= lastUserIndex ||
      !message.partial ||
      message.completedAt ||
      (message.role !== "assistant" && message.role !== "thought")
    ) {
      return message;
    }
    if (message.role === "assistant") hasActiveAssistant = true;
    return {
      ...message,
      createdAt: message.createdAt ?? promptStartedAt,
      partial: false,
      streaming: true,
      pending: message.role === "assistant" && !message.content,
    };
  });

  if (hasActiveAssistant) return live;
  return [
    ...live,
    {
      id: `live:${snapshot.sessionId ?? "session"}`,
      role: "assistant",
      content: "",
      runtimeId: snapshot.runtimeId ?? undefined,
      createdAt: promptStartedAt,
      completedAt: null,
      streaming: true,
      pending: true,
    },
  ];
}

/** Keep live event state when revisiting a session; journal data is a fallback. */
export function restoreSessionMessages(
  cached: ChatMessage[] | undefined,
  stored: ChatMessage[],
  snapshot: SessionSnapshot,
): ChatMessage[] {
  if (!cached) return normalizeLoadedMessages(stored, snapshot);
  return cached.map((message) =>
    message.streaming && message.content
      ? { ...message, revealImmediately: true }
      : message,
  );
}

export function finalizeAssistantMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    pending: false,
    streaming: false,
    completedAt: message.completedAt ?? nowIso(),
  };
}

export function finalizeStreamingMessage(message: ChatMessage): ChatMessage {
  if (!message.streaming) return message;
  if (message.role === "assistant") {
    return finalizeAssistantMessage(message);
  }
  return { ...message, streaming: false, pending: false };
}

export function startAssistantElapsedPause(
  messages: ChatMessage[],
  pausedAt = nowIso(),
): ChatMessage[] {
  const index = findLastStreamingMessageIndex(messages, "assistant");
  if (index < 0) return messages;
  const message = messages[index];
  if (message.elapsedPauseStartedAt) return messages;
  const next = messages.slice();
  next[index] = { ...message, elapsedPauseStartedAt: pausedAt };
  return next;
}

export function finishAssistantElapsedPause(
  messages: ChatMessage[],
  resumedAt = nowIso(),
): ChatMessage[] {
  const index = findLastStreamingMessageIndex(messages, "assistant");
  if (index < 0) return messages;
  const message = messages[index];
  if (!message.elapsedPauseStartedAt) return messages;

  const pausedAt = new Date(message.elapsedPauseStartedAt).getTime();
  const resumed = new Date(resumedAt).getTime();
  const pausedMs =
    Number.isNaN(pausedAt) || Number.isNaN(resumed)
      ? 0
      : Math.max(0, resumed - pausedAt);
  const next = messages.slice();
  next[index] = {
    ...message,
    elapsedPausedMs: Math.max(0, message.elapsedPausedMs ?? 0) + pausedMs,
    elapsedPauseStartedAt: null,
  };
  return next;
}
