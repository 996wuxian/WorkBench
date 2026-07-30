import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
} from "react";

import {
  adjacentMessageNode,
  buildSessionMessageNodes,
  pickActiveMessageNodeId,
  type SessionMessageNode,
} from "../lib/sessionMessageNodes";
import type { ChatMessage } from "../lib/types";

interface UseMessageNodeNavigationOptions {
  sessionKey: string;
  messages: readonly ChatMessage[];
  renderedMessageCount: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onViewportScroll: (event: UIEvent<HTMLDivElement>) => void;
  onRevealMessage: (messageIndex: number) => void;
}

export function useMessageNodeNavigation({
  sessionKey,
  messages,
  renderedMessageCount,
  scrollRef,
  onViewportScroll,
  onRevealMessage,
}: UseMessageNodeNavigationOptions) {
  const nodes = useMemo(() => buildSessionMessageNodes(messages), [messages]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const nodeCursorRef = useRef<string | null>(null);
  const navigationLockUntilRef = useRef(0);
  const jumpFrameRef = useRef<number | null>(null);
  const focusTimerRef = useRef<number | null>(null);

  const syncActiveNode = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport || nodes.length === 0) return;
    if (performance.now() < navigationLockUntilRef.current) return;

    const viewportRect = viewport.getBoundingClientRect();
    const focusY = viewportRect.top + viewport.clientHeight * 0.28;
    const rects = nodes.flatMap((node) => {
      const row = viewport.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(node.id)}"]`,
      );
      if (!row) return [];
      const rect = row.getBoundingClientRect();
      return [{ id: node.id, top: rect.top, bottom: rect.bottom }];
    });
    const nextId = pickActiveMessageNodeId(rects, focusY);
    if (!nextId) return;
    nodeCursorRef.current = nextId;
    setActiveNodeId((current) => (current === nextId ? current : nextId));
  }, [nodes, scrollRef]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      onViewportScroll(event);
      syncActiveNode();
    },
    [onViewportScroll, syncActiveNode],
  );

  const applyMessageJump = useCallback(
    (node: SessionMessageNode, attempt = 0) => {
      const viewport = scrollRef.current;
      if (!viewport) return;
      const row = viewport.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(node.id)}"]`,
      );
      if (!row) {
        if (attempt < 8) {
          jumpFrameRef.current = window.requestAnimationFrame(() => {
            jumpFrameRef.current = null;
            applyMessageJump(node, attempt + 1);
          });
        }
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const desiredTop = viewportRect.top + Math.min(48, viewport.clientHeight * 0.1);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      viewport.scrollTo({
        top: viewport.scrollTop + rowRect.top - desiredTop,
        behavior: reducedMotion ? "auto" : "smooth",
      });
    },
    [scrollRef],
  );

  const scrollToNode = useCallback(
    (node: SessionMessageNode) => {
      nodeCursorRef.current = node.id;
      navigationLockUntilRef.current = performance.now() + 1200;
      setActiveNodeId(node.id);
      setFocusedMessageId(node.id);
      onRevealMessage(node.messageIndex);

      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(() => {
        setFocusedMessageId((current) => (current === node.id ? null : current));
        focusTimerRef.current = null;
      }, 1500);
      if (jumpFrameRef.current !== null) window.cancelAnimationFrame(jumpFrameRef.current);
      jumpFrameRef.current = window.requestAnimationFrame(() => {
        jumpFrameRef.current = null;
        applyMessageJump(node);
      });
    },
    [applyMessageJump, onRevealMessage],
  );

  const selectAdjacentNode = useCallback(
    (delta: -1 | 1) => {
      const node = adjacentMessageNode(
        nodes,
        nodeCursorRef.current ?? activeNodeId,
        delta,
      );
      if (node) scrollToNode(node);
    },
    [activeNodeId, nodes, scrollToNode],
  );

  useEffect(() => {
    if (jumpFrameRef.current !== null) {
      window.cancelAnimationFrame(jumpFrameRef.current);
      jumpFrameRef.current = null;
    }
    if (focusTimerRef.current !== null) {
      window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    }
    nodeCursorRef.current = null;
    navigationLockUntilRef.current = 0;
    setActiveNodeId(null);
    setFocusedMessageId(null);
  }, [sessionKey]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(syncActiveNode);
    return () => window.cancelAnimationFrame(frame);
  }, [nodes.length, renderedMessageCount, sessionKey, syncActiveNode]);

  useEffect(
    () => () => {
      if (jumpFrameRef.current !== null) window.cancelAnimationFrame(jumpFrameRef.current);
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    },
    [],
  );

  return {
    nodes,
    activeNodeId,
    focusedMessageId,
    handleScroll,
    scrollToNode,
    selectPreviousNode: () => selectAdjacentNode(-1),
    selectNextNode: () => selectAdjacentNode(1),
  };
}
