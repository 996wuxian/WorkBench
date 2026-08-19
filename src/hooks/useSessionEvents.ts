/**
 * Subscription to every `session://*` event the Host emits.
 *
 * All of it lives here because the transcript is a projection of these events
 * and nothing else: the UI never invents a message, it only folds what the Host
 * reports. Keeping the fold in one file makes it possible to check that against
 * the Host's `HostEvent` enum.
 *
 * The listeners are registered once, on mount. Callbacks are read through a ref
 * that is refreshed every render, so a changing handler identity can never tear
 * down and rebuild the subscriptions mid-stream — which would drop the events
 * that arrive in the gap.
 */
import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";

import { isTauri } from "../lib/api";
import {
  finalizeStreamingMessage,
  findLastStreamingMessageIndex,
  finishAssistantElapsedPause,
  startAssistantElapsedPause,
} from "../lib/messages";
import { nowIso, uid } from "../lib/format";
import {
  clearPermissionRequests,
  enqueuePermissionRequest,
  PERMISSION_DECISION_LABEL,
  PERMISSION_SOURCE_LABEL,
  resolvePermissionRequest,
  type PermissionQueue,
} from "../lib/permissions";
import { runtimeLabel } from "../lib/runtimes";
import { insertOrUpdateWorktreeChangeBlock } from "../lib/worktreeChanges";
import type {
  ChatMessage,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  SessionMeta,
  SessionSnapshot,
  SessionState,
  SessionUnreadKind,
  TurnSettledEvent,
  WorktreeChangeStat,
} from "../lib/types";

/** Placeholder shown between "turn started" and the first token. */
const ASSISTANT_LOADING_TEXT = "thinking";

export interface SessionEventHandlers {
  /** Snapshot events are only applied to the session the user is looking at. */
  activeSessionIdRef: RefObject<string | null>;
  updateSessionMessages: (
    sessionId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void;
  setSnapshot: Dispatch<SetStateAction<SessionSnapshot>>;
  applySessionSnapshot: (snapshot: SessionSnapshot) => void;
  setPermissionQueue: Dispatch<
    SetStateAction<Record<string, PermissionRequestEvent[]>>
  >;
  setPermissionBusy: Dispatch<SetStateAction<string | null>>;
  queueAssistantTyping: (
    sessionId: string,
    messageId: string,
    content: string,
  ) => void;
  clearAssistantTypingForSession: (sessionId: string) => void;
  applySettledSessionMeta: (meta: SessionMeta) => void;
  onTurnSettled: (event: TurnSettledEvent) => void;
  markSessionResult: (
    sessionId: string,
    kind: SessionUnreadKind,
    meta?: SessionMeta,
  ) => void;
}

export function useSessionEvents(handlers: SessionEventHandlers): void {
  const ref = useRef(handlers);
  const permissionQueueRef = useRef<PermissionQueue>({});
  ref.current = handlers;

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
        const { updateSessionMessages, queueAssistantTyping } = ref.current;
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
              queueAssistantTyping(p.sessionId, last.id, nextContent);
              return [
                ...m.slice(0, streamIndex),
                {
                  ...last,
                  content: nextContent,
                  pending: false,
                  streaming: !p.done,
                  createdAt: last.createdAt ?? nowIso(),
                  completedAt: p.done ? (last.completedAt ?? nowIso()) : null,
                },
                ...m.slice(streamIndex + 1),
              ];
            }
            const nextContent = last.content + (p.text || "");
            if (p.text) {
              queueAssistantTyping(p.sessionId, last.id, nextContent);
            }
            const next = {
              ...last,
              content: nextContent,
              streaming: !p.done,
              completedAt: p.done ? (last.completedAt ?? nowIso()) : null,
            };
            return [...m.slice(0, streamIndex), next, ...m.slice(streamIndex + 1)];
          }
          if (p.text) {
            const messageId = uid("a");
            queueAssistantTyping(p.sessionId, messageId, p.text);
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
        ref.current.applySessionSnapshot(ev.payload);
      });
      if (!cancelled) unsubs.push(u2);

      const u3 = await listen<{
        sessionId: string;
        id: string;
        title: string;
        name: string;
        status: string;
      }>("session://tool", (ev) => {
        if (cancelled) return;
        const toolCallId = ev.payload.id?.trim() || null;
        const toolTitle = (ev.payload.title || ev.payload.name || "Tool").trim();
        const toolName = (
          ev.payload.name ||
          ev.payload.title ||
          toolTitle ||
          "tool"
        ).trim();
        const toolStatus = ev.payload.status.trim();
        ref.current.updateSessionMessages(ev.payload.sessionId, (m) => {
          const nextMessage: ChatMessage = {
            id: toolCallId ? `tool:${toolCallId}` : uid("tool"),
            role: "tool",
            content: "",
            toolCallId,
            toolTitle,
            toolName,
            toolStatus,
          };
          // Update in place when the runtime gave us a call id — a tool can
          // report `pending` → `in_progress` → `completed` long after other
          // messages arrived, so matching only the tail would duplicate it.
          const existingIndex = toolCallId
            ? m.findIndex(
                (msg) => msg.role === "tool" && msg.toolCallId === toolCallId,
              )
            : m[m.length - 1]?.role === "tool" &&
                m[m.length - 1]?.toolTitle === toolTitle &&
                m[m.length - 1]?.toolName === toolName
              ? m.length - 1
              : -1;
          if (existingIndex >= 0) {
            const existing = m[existingIndex];
            if (existing.toolStatus === toolStatus) return m;
            const next = m.slice();
            next[existingIndex] = { ...existing, ...nextMessage, id: existing.id };
            return next;
          }
          return [...m, nextMessage];
        });
      });
      if (!cancelled) unsubs.push(u3);

      const u4 = await listen<{
        sessionId: string;
        files: WorktreeChangeStat[];
      }>("session://file_change", (ev) => {
        if (cancelled) return;
        const files = ev.payload.files ?? [];
        if (files.length === 0) return;
        ref.current.updateSessionMessages(ev.payload.sessionId, (m) => {
          for (let index = m.length - 1; index >= 0; index -= 1) {
            if (m[index].role !== "assistant") continue;
            const next = m.slice();
            next[index] = insertOrUpdateWorktreeChangeBlock(
              m[index],
              uid("chg"),
              files,
            );
            return next;
          }
          return m;
        });
      });
      if (!cancelled) unsubs.push(u4);

      const u5 = await listen<{
        sessionId: string;
        code: string;
        message: string;
      }>("session://error", (ev) => {
        if (cancelled) return;
        ref.current.markSessionResult(ev.payload.sessionId, "error");
        ref.current.updateSessionMessages(ev.payload.sessionId, (m) => {
          const closed = m
            .filter((msg) => !(msg.role === "assistant" && msg.pending))
            .map(finalizeStreamingMessage);
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
      if (!cancelled) unsubs.push(u5);

      const u6 = await listen<{ sessionId: string; stopReason: string }>(
        "session://prompt_complete",
        (ev) => {
          if (cancelled) return;
          const sessionId = ev.payload.sessionId;
          const {
            updateSessionMessages,
            clearAssistantTypingForSession,
          } = ref.current;
          updateSessionMessages(sessionId, (m) =>
            m.map((msg) => {
              if (msg.role === "assistant" && msg.pending) {
                const runtimeName = msg.runtimeId
                  ? runtimeLabel(msg.runtimeId)
                  : "Agent";
                return {
                  id: uid("sys"),
                  role: "system",
                  content: `error EMPTY_RESPONSE: ${runtimeName} 本轮已结束，但没有返回任何可显示内容（stopReason: ${ev.payload.stopReason}）。`,
                };
              }
              return finalizeStreamingMessage(msg);
            }),
          );
          clearAssistantTypingForSession(sessionId);
        },
      );
      if (!cancelled) unsubs.push(u6);

      const u7 = await listen<PermissionRequestEvent>(
        "session://permission",
        (ev) => {
          if (cancelled) return;
          const request = ev.payload;
          const policyAction = request.policy?.action ?? (request.autoAllowed ? "allow" : "ask");
          // Automatically resolved requests are informational: the Host already answered.
          if (policyAction !== "ask") {
            ref.current.updateSessionMessages(request.sessionId, (m) => [
              ...m,
              {
                id: uid("tool"),
                role: "tool",
                content: "",
                toolName: request.toolName,
                toolTitle: request.title,
                toolStatus:
                  policyAction === "deny" ? "blocked by policy" : "auto approved",
              },
            ]);
            return;
          }
          const nextQueue = enqueuePermissionRequest(
            permissionQueueRef.current,
            request,
          );
          if (nextQueue !== permissionQueueRef.current) {
            permissionQueueRef.current = nextQueue;
            ref.current.setPermissionQueue(nextQueue);
          }
          ref.current.updateSessionMessages(request.sessionId, (m) =>
            startAssistantElapsedPause(m),
          );
        },
      );
      if (!cancelled) unsubs.push(u7);

      const u8 = await listen<PermissionResolvedEvent>(
        "session://permission_resolved",
        (ev) => {
          if (cancelled) return;
          const { sessionId, requestId, decision, source } = ev.payload;
          const { setPermissionQueue, setPermissionBusy, updateSessionMessages } =
            ref.current;
          const resolution = resolvePermissionRequest(
            permissionQueueRef.current,
            sessionId,
            requestId,
          );
          if (resolution.queue !== permissionQueueRef.current) {
            permissionQueueRef.current = resolution.queue;
            setPermissionQueue(resolution.queue);
          }
          setPermissionBusy((prev) => (prev === requestId ? null : prev));
          if (resolution.resolved && resolution.remainingCount === 0) {
            updateSessionMessages(sessionId, (m) => finishAssistantElapsedPause(m));
          }
          // User/mode decisions are already visible in context. Aborted
          // approvals are covered by the process-exited notice for the turn.
          if (source === "user" || source === "mode" || source === "aborted") return;
          const title =
            resolution.resolved?.title ??
            resolution.resolved?.toolName ??
            "工具调用";
          updateSessionMessages(sessionId, (m) => [
            ...m,
            {
              id: uid("sys"),
              role: "system",
              content: `权限请求「${title}」已由 ${PERMISSION_SOURCE_LABEL[source] ?? source} 处理为 ${PERMISSION_DECISION_LABEL[decision] ?? decision}。`,
            },
          ]);
        },
      );
      if (!cancelled) unsubs.push(u8);

      const u9 = await listen<{ sessionId: string; code?: number | null }>(
        "session://exited",
        (ev) => {
          if (cancelled) return;
          const { sessionId, code } = ev.payload;
          // The process is gone: nothing can answer a queued approval anymore.
          const nextQueue = clearPermissionRequests(
            permissionQueueRef.current,
            sessionId,
          );
          if (nextQueue !== permissionQueueRef.current) {
            permissionQueueRef.current = nextQueue;
            ref.current.setPermissionQueue(nextQueue);
          }
          ref.current.clearAssistantTypingForSession(sessionId);
          ref.current.markSessionResult(sessionId, "error");
          ref.current.updateSessionMessages(sessionId, (m) => [
            ...m.map(finalizeStreamingMessage),
            {
              id: uid("sys"),
              role: "system",
              content:
                code === null || code === undefined
                  ? "Agent 进程已退出。下次发送会自动重连。"
                  : `Agent 进程已退出（exit code ${code}）。下次发送会自动重连。`,
            },
          ]);
        },
      );
      if (!cancelled) unsubs.push(u9);

      const u10 = await listen<{
        sessionId: string;
        state: SessionState;
        runtimeId: string;
        backend: string;
      }>("session://runtime_state", (ev) => {
        if (cancelled) return;
        const { sessionId, state, backend } = ev.payload;
        if (sessionId !== ref.current.activeSessionIdRef.current) return;
        ref.current.setSnapshot((prev) =>
          prev.sessionId === sessionId ? { ...prev, state, backend } : prev,
        );
      });
      if (!cancelled) unsubs.push(u10);

      const u11 = await listen<TurnSettledEvent>(
        "session://turn_settled",
        (ev) => {
          if (cancelled) return;
          ref.current.applySettledSessionMeta(ev.payload.meta);
          ref.current.markSessionResult(
            ev.payload.sessionId,
            "completed",
            ev.payload.meta,
          );
          ref.current.onTurnSettled(ev.payload);
        },
      );
      if (!cancelled) unsubs.push(u11);
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, []);
}
