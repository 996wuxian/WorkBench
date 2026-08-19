import type { ChatMessage } from "./types";

export type SessionMessageNodeRole = "user" | "assistant";
export type SessionMessageNodeStatus = "pending" | "done" | "interrupted";

export interface SessionMessageNode {
  id: string;
  messageIndex: number;
  nodeIndex: number;
  role: SessionMessageNodeRole;
  preview: string;
  status: SessionMessageNodeStatus;
}

export interface MessageNodeViewportRect {
  id: string;
  top: number;
  bottom: number;
}

const PREVIEW_MAX = 72;

export function truncateMessageNodePreview(
  content: string | undefined | null,
  max = PREVIEW_MAX,
): string {
  const text = (content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "…";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function isSessionMessageNodeCandidate(
  message: ChatMessage | undefined | null,
): boolean {
  if (!message) return false;
  if (message.role === "user") return true;
  if (message.role !== "assistant") return false;

  // Empty assistant shells represent "thinking" before visible reply text.
  return Boolean(message.content.trim() || message.partial);
}

export function buildSessionMessageNodes(
  messages: readonly ChatMessage[],
): SessionMessageNode[] {
  const nodes: SessionMessageNode[] = [];
  let hasAssistantNodeInTurn = false;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isSessionMessageNodeCandidate(message)) continue;
    if (message.role === "user") {
      hasAssistantNodeInTurn = false;
    }
    if (message.role === "assistant") {
      if (hasAssistantNodeInTurn) continue;
      hasAssistantNodeInTurn = true;
    }

    nodes.push({
      id: message.id,
      messageIndex,
      nodeIndex: nodes.length,
      role: message.role as SessionMessageNodeRole,
      preview: truncateMessageNodePreview(message.content),
      status: message.streaming
        ? "pending"
        : message.partial
          ? "interrupted"
          : "done",
    });
  }
  return nodes;
}

export function pickActiveMessageNodeId(
  rects: readonly MessageNodeViewportRect[],
  focusY: number,
): string | null {
  if (rects.length === 0) return null;

  let readingId: string | null = null;
  for (const rect of rects) {
    if (rect.top <= focusY + 1) readingId = rect.id;
  }
  if (readingId) return readingId;

  let nearestId: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    const distance = Math.abs((rect.top + rect.bottom) / 2 - focusY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestId = rect.id;
    }
  }
  return nearestId;
}

export function adjacentMessageNode(
  nodes: readonly SessionMessageNode[],
  currentId: string | null | undefined,
  delta: -1 | 1,
): SessionMessageNode | null {
  if (nodes.length === 0) return null;
  const currentIndex = currentId
    ? nodes.findIndex((node) => node.id === currentId)
    : -1;
  if (currentIndex < 0) {
    return delta > 0 ? (nodes[0] ?? null) : (nodes.at(-1) ?? null);
  }
  return nodes[currentIndex + delta] ?? null;
}
