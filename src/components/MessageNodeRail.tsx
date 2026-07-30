import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";

import { IconChevronDown, IconChevronUp } from "./icons";
import type { SessionMessageNode } from "../lib/sessionMessageNodes";

interface MessageNodeRailLabels {
  aria: string;
  previous: string;
  next: string;
  user: string;
  assistant: string;
}

interface MessageNodeRailProps {
  nodes: readonly SessionMessageNode[];
  activeId: string | null;
  onSelect: (node: SessionMessageNode) => void;
  onPrevious: () => void;
  onNext: () => void;
  labels: MessageNodeRailLabels;
}

interface TipState {
  node: SessionMessageNode;
  top: number;
  left: number;
}

export function MessageNodeRail({
  nodes,
  activeId,
  onSelect,
  onPrevious,
  onNext,
  labels,
}: MessageNodeRailProps) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const activeIndex = useMemo(
    () => (activeId ? nodes.findIndex((node) => node.id === activeId) : -1),
    [activeId, nodes],
  );
  const canPrevious = activeIndex > 0 || (activeIndex < 0 && nodes.length > 0);
  const canNext =
    (activeIndex >= 0 && activeIndex < nodes.length - 1) ||
    (activeIndex < 0 && nodes.length > 0);

  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const activeNode = nodes[activeIndex];
    if (!activeNode) return;
    const tick = listRef.current.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(activeNode.id)}"]`,
    );
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tick?.scrollIntoView({
      block: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [activeIndex, nodes]);

  useEffect(() => {
    if (tip && !nodes.some((node) => node.id === tip.node.id)) setTip(null);
  }, [nodes, tip]);

  if (nodes.length < 2) return null;

  const showTip = (node: SessionMessageNode, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setTip({
      node,
      top: rect.top + rect.height / 2,
      left: rect.right + 8,
    });
  };
  const hideTip = (nodeId: string) => {
    setTip((current) => (current?.node.id === nodeId ? null : current));
  };
  const tipRole = tip?.node.role === "user" ? labels.user : labels.assistant;
  const tipStatus =
    tip?.node.status === "pending"
      ? " · 生成中"
      : tip?.node.status === "interrupted"
        ? " · 已中断"
        : "";

  return (
    <nav className="message-node-rail" aria-label={labels.aria}>
      <button
        type="button"
        className="message-node-rail__step"
        title={labels.previous}
        aria-label={labels.previous}
        disabled={!canPrevious}
        onClick={onPrevious}
      >
        <IconChevronUp size={14} />
      </button>

      <ol ref={listRef} className="message-node-rail__list">
        {nodes.map((node) => {
          const active = node.id === activeId;
          const roleLabel = node.role === "user" ? labels.user : labels.assistant;
          return (
            <li key={node.id} className="message-node-rail__item">
              <button
                type="button"
                data-node-id={node.id}
                className={
                  `message-node-rail__tick message-node-rail__tick--${node.role}` +
                  (active ? " is-active" : "") +
                  (node.status === "pending" ? " is-pending" : "") +
                  (node.status === "interrupted" ? " is-interrupted" : "")
                }
                aria-label={`${roleLabel}: ${node.preview}`}
                aria-current={active ? "true" : undefined}
                onMouseEnter={(event) => showTip(node, event.currentTarget)}
                onMouseLeave={() => hideTip(node.id)}
                onFocus={(event) => showTip(node, event.currentTarget)}
                onBlur={() => hideTip(node.id)}
                onClick={() => onSelect(node)}
              />
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        className="message-node-rail__step"
        title={labels.next}
        aria-label={labels.next}
        disabled={!canNext}
        onClick={onNext}
      >
        <IconChevronDown size={14} />
      </button>

      {tip
        ? createPortal(
            <div
              className="message-node-rail__tip"
              role="tooltip"
              style={{ top: tip.top, left: tip.left }}
            >
              <div className="message-node-rail__tip-role">
                {tipRole}
                {tipStatus}
              </div>
              <div className="message-node-rail__tip-body">{tip.node.preview}</div>
              <div className="message-node-rail__tip-count">
                {tip.node.nodeIndex + 1} / {nodes.length}
              </div>
            </div>,
            document.body,
          )
        : null}
    </nav>
  );
}
