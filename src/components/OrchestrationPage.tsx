import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  IconChevronRight,
  IconGitFork,
  IconPlus,
  IconTrash,
} from "./icons";
import {
  canRunFixedWorkflow,
  createOrchestrationNode,
  deriveTaskStatus,
  formatOrchestrationUpdatedAt,
  type OrchestrationEdge,
  type OrchestrationNode,
  type OrchestrationNodeMode,
  type OrchestrationNodeStatus,
  type OrchestrationTask,
} from "../lib/orchestration";
import { runtimeLabel } from "../lib/runtimes";
import type { RuntimeId } from "../lib/types";

const nodeWidth = 220;
const nodeHeight = 122;
const canvasPadding = 96;
const minZoom = 0.5;
const maxZoom = 1.6;
const dragThreshold = 3;
const runtimeOptions: RuntimeId[] = ["codex", "claude", "grok", "kimi"];

function clampZoom(value: number): number {
  return Math.min(maxZoom, Math.max(minZoom, value));
}

function cloneNodes(nodes: OrchestrationNode[]): OrchestrationNode[] {
  return nodes.map((node) => ({ ...node }));
}

function cloneEdges(edges: OrchestrationEdge[]): OrchestrationEdge[] {
  return edges.map((edge) => ({ ...edge }));
}

function nodeModeLabel(mode: OrchestrationNodeMode): string {
  if (mode === "review") return "审查节点";
  if (mode === "fix") return "修复节点";
  return "人工确认";
}

function nodeStatusLabel(status: OrchestrationNodeStatus): string {
  if (status === "running") return "运行中";
  if (status === "done") return "完成";
  if (status === "failed") return "失败";
  if (status === "ready") return "就绪";
  if (status === "blocked") return "等待上游";
  return "草稿";
}

function edgePath(from: OrchestrationNode, to: OrchestrationNode): string {
  const startX = from.x + nodeWidth;
  const startY = from.y + nodeHeight / 2;
  const endX = to.x;
  const endY = to.y + nodeHeight / 2;
  const mid = Math.max(72, Math.abs(endX - startX) * 0.48);
  return `M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`;
}

function connectionPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const mid = Math.max(72, Math.abs(to.x - from.x) * 0.48);
  return `M ${from.x} ${from.y} C ${from.x + mid} ${from.y}, ${to.x - mid} ${to.y}, ${to.x} ${to.y}`;
}

function edgeKey(edge: Pick<OrchestrationEdge, "from" | "to">): string {
  return `${edge.from}->${edge.to}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest("input, textarea, select, button, [contenteditable='true']"),
  );
}

export function OrchestrationPage({
  task,
  onBackToChat,
  onTaskChange,
  onRunWorkflow,
  onOpenSession,
  runningWorkflowId,
}: {
  task: OrchestrationTask;
  onBackToChat: () => void;
  onTaskChange: (task: OrchestrationTask) => void;
  onRunWorkflow: (task: OrchestrationTask) => void;
  onOpenSession: (sessionId: string) => void;
  runningWorkflowId: string | null;
}) {
  const [nodes, setNodes] = useState<OrchestrationNode[]>(() => cloneNodes(task.nodes));
  const [edges, setEdges] = useState<OrchestrationEdge[]>(() => cloneEdges(task.edges));
  const [selectedId, setSelectedId] = useState(task.nodes[0]?.id ?? "");
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [connectingHoverId, setConnectingHoverId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{
    pointerId: number;
    fromId: string;
    pointer: { x: number; y: number };
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const nodeDragStartRef = useRef<{
    pointerId: number;
    nodeId: string;
    clientX: number;
    clientY: number;
    nodeX: number;
    nodeY: number;
  } | null>(null);
  const suppressNodeClickRef = useRef(false);
  const selected = selectedEdgeKey
    ? null
    : (nodes.find((node) => node.id === selectedId) ?? nodes[0]);
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edgeKey(edge) === selectedEdgeKey) ?? null,
    [edges, selectedEdgeKey],
  );
  const runnable = canRunFixedWorkflow(task);
  const hasRunningWorkflow = runningWorkflowId !== null;
  const canvasSize = useMemo(
    () => ({
      width:
        Math.max(...nodes.map((node) => node.x + nodeWidth), 860) +
        canvasPadding,
      height:
        Math.max(...nodes.map((node) => node.y + nodeHeight), 390) +
        canvasPadding,
    }),
    [nodes],
  );

  const commitTask = (nextNodes: OrchestrationNode[], nextEdges: OrchestrationEdge[]) => {
    onTaskChange({
      ...task,
      nodes: nextNodes,
      edges: nextEdges,
      status: deriveTaskStatus(nextNodes),
      updatedAt: formatOrchestrationUpdatedAt(),
    });
  };

  const applyNodes = (updater: (current: OrchestrationNode[]) => OrchestrationNode[]) => {
    setNodes((currentNodes) => {
      const nextNodes = updater(currentNodes);
      commitTask(nextNodes, edges);
      return nextNodes;
    });
  };

  const applyEdges = (updater: (current: OrchestrationEdge[]) => OrchestrationEdge[]) => {
    setEdges((currentEdges) => {
      const nextEdges = updater(currentEdges);
      commitTask(nodes, nextEdges);
      return nextEdges;
    });
  };

  useEffect(() => {
    setNodes(cloneNodes(task.nodes));
    setEdges(cloneEdges(task.edges));
    setSelectedId(task.nodes[0]?.id ?? "");
    setPanOffset({ x: 0, y: 0 });
    setZoom(1);
    setIsPanning(false);
    setDraggingNodeId(null);
    setSelectedEdgeKey(null);
    setConnectingHoverId(null);
    setConnecting(null);
    panStartRef.current = null;
    nodeDragStartRef.current = null;
  }, [task.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      setSpacePressed(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      setSpacePressed(false);
      if (!panStartRef.current) setIsPanning(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const clientToCanvasPoint = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panOffset.x) / zoom,
      y: (clientY - rect.top - panOffset.y) / zoom,
    };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      setZoom((currentZoom) => {
        const factor = Math.exp(-event.deltaY * 0.0012);
        const nextZoom = clampZoom(currentZoom * factor);
        if (Math.abs(nextZoom - currentZoom) < 0.001) return currentZoom;
        setPanOffset((currentOffset) => ({
          x: pointerX - ((pointerX - currentOffset.x) / currentZoom) * nextZoom,
          y: pointerY - ((pointerY - currentOffset.y) / currentZoom) * nextZoom,
        }));
        return nextZoom;
      });
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, []);

  const startPanning = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!spacePressed || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: panOffset.x,
      offsetY: panOffset.y,
    };
    setIsPanning(true);
  };

  const movePanning = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - start.clientX;
    const deltaY = event.clientY - start.clientY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 3) {
      suppressNodeClickRef.current = true;
    }
    setPanOffset({
      x: start.offsetX + deltaX,
      y: start.offsetY + deltaY,
    });
  };

  const finishPanning = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (start?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panStartRef.current = null;
    setIsPanning(false);
    window.setTimeout(() => {
      suppressNodeClickRef.current = false;
    }, 0);
  };

  const startNodeDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    node: OrchestrationNode,
  ) => {
    if (event.button !== 0 || spacePressed || connecting) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    nodeDragStartRef.current = {
      pointerId: event.pointerId,
      nodeId: node.id,
      clientX: event.clientX,
      clientY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
    };
    setDraggingNodeId(node.id);
    setSelectedId(node.id);
    setSelectedEdgeKey(null);
  };

  const moveNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = nodeDragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - start.clientX) / zoom;
    const deltaY = (event.clientY - start.clientY) / zoom;
    if (Math.abs(event.clientX - start.clientX) + Math.abs(event.clientY - start.clientY) > dragThreshold) {
      suppressNodeClickRef.current = true;
    }
    applyNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === start.nodeId
          ? {
              ...node,
              x: Math.max(0, start.nodeX + deltaX),
              y: Math.max(0, start.nodeY + deltaY),
            }
          : node,
      ),
    );
  };

  const finishNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = nodeDragStartRef.current;
    if (start?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    nodeDragStartRef.current = null;
    setDraggingNodeId(null);
    window.setTimeout(() => {
      suppressNodeClickRef.current = false;
    }, 0);
  };

  const startConnecting = (
    event: ReactPointerEvent<HTMLSpanElement>,
    nodeId: string,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(nodeId);
    setSelectedEdgeKey(null);
    setConnectingHoverId(null);
    setConnecting({
      pointerId: event.pointerId,
      fromId: nodeId,
      pointer: clientToCanvasPoint(event.clientX, event.clientY),
    });
  };

  const moveConnecting = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!connecting || connecting.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const hoverId = target
      ?.closest<HTMLElement>("[data-connection-input]")
      ?.dataset.connectionInput;
    setConnectingHoverId(
      hoverId && hoverId !== connecting.fromId ? hoverId : null,
    );
    setConnecting({
      ...connecting,
      pointer: clientToCanvasPoint(event.clientX, event.clientY),
    });
  };

  const finishConnecting = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (connecting?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const toId = target
      ?.closest<HTMLElement>("[data-connection-input]")
      ?.dataset.connectionInput;
    if (connecting && toId && connecting.fromId !== toId) {
      const nextEdgeKey = edgeKey({ from: connecting.fromId, to: toId });
      applyEdges((currentEdges) => {
        if (
          currentEdges.some(
            (edge) => edge.from === connecting.fromId && edge.to === toId,
          )
        ) {
          return currentEdges;
        }
        return [
          ...currentEdges,
          { from: connecting.fromId, to: toId, label: "输出" },
        ];
      });
      setSelectedId("");
      setSelectedEdgeKey(nextEdgeKey);
    }
    setConnecting(null);
    setConnectingHoverId(null);
  };

  const addNode = () => {
    const nextNode = createOrchestrationNode(nodes.length + 1);
    const nextNodes = [...nodes, nextNode];
    setNodes(nextNodes);
    setSelectedId(nextNode.id);
    setSelectedEdgeKey(null);
    commitTask(nextNodes, edges);
  };

  const updateSelectedNode = (patch: Partial<OrchestrationNode>) => {
    if (!selected) return;
    applyNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selected.id ? { ...node, ...patch } : node,
      ),
    );
  };

  const deleteSelectedNode = () => {
    if (!selected) return;
    const nextNodes = nodes.filter((node) => node.id !== selected.id);
    const nextEdges = edges.filter(
      (edge) => edge.from !== selected.id && edge.to !== selected.id,
    );
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedId(nextNodes[0]?.id ?? "");
    setSelectedEdgeKey(null);
    commitTask(nextNodes, nextEdges);
  };

  const deleteEdge = (from: string, to: string) => {
    const deletingKey = edgeKey({ from, to });
    applyEdges((currentEdges) =>
      currentEdges.filter((edge) => edge.from !== from || edge.to !== to),
    );
    if (selectedEdgeKey === deletingKey) {
      setSelectedEdgeKey(null);
      setSelectedId(nodes[0]?.id ?? "");
    }
  };

  const selectEdge = (edge: OrchestrationEdge) => {
    setSelectedEdgeKey(edgeKey(edge));
    setSelectedId("");
  };

  const updateSelectedEdge = (patch: Partial<OrchestrationEdge>) => {
    if (!selectedEdge) return;
    const currentKey = edgeKey(selectedEdge);
    applyEdges((currentEdges) =>
      currentEdges.map((edge) =>
        edgeKey(edge) === currentKey ? { ...edge, ...patch } : edge,
      ),
    );
  };

  return (
    <section className="orchestration-page" aria-label="编排工作台">
      <header className="orchestration-page__header">
        <div className="orchestration-page__title-wrap">
          <span className="orchestration-page__mark">
            <IconGitFork size={18} />
          </span>
          <div>
            <h2 className="orchestration-page__title">{task.title}</h2>
            <p className="orchestration-page__subtitle">
              {task.summary}
            </p>
          </div>
        </div>
        <div className="orchestration-page__actions">
          <button type="button" className="btn btn--ghost" onClick={onBackToChat}>
            返回聊天
          </button>
          <button type="button" className="btn btn--ghost" onClick={addNode}>
            <IconPlus size={15} />
            新建节点
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!runnable || hasRunningWorkflow}
            title={runnable ? "运行固定链路" : "需要 implement/review/fix 三个固定节点"}
            onClick={() => onRunWorkflow(task)}
          >
            {hasRunningWorkflow ? "链路运行中" : "运行链路"}
            <IconChevronRight size={15} />
          </button>
        </div>
      </header>

      <div className="orchestration-page__body">
        <div
          className={
            "orchestration-canvas" +
            (spacePressed ? " is-space-panning" : "") +
            (isPanning ? " is-panning" : "")
          }
          role="application"
          aria-label="编排画布"
          ref={canvasRef}
          onPointerDown={startPanning}
          onPointerMove={movePanning}
          onPointerUp={finishPanning}
          onPointerCancel={finishPanning}
        >
          <div
            className="orchestration-canvas__viewport"
            style={{
              width: canvasSize.width,
              height: canvasSize.height,
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
            }}
          >
            <svg
              className="orchestration-canvas__edges"
              viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="orchestration-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                >
                  <path d="M 0 0 L 8 4 L 0 8 z" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const from = nodesById.get(edge.from);
                const to = nodesById.get(edge.to);
                if (!from || !to) return null;
                const key = edgeKey(edge);
                const path = edgePath(from, to);
                return (
                  <g key={key}>
                    <path
                      className={
                        "orchestration-canvas__edge-path" +
                        (selectedEdgeKey === key ? " is-selected" : "")
                      }
                      d={path}
                      markerEnd="url(#orchestration-arrow)"
                    />
                    <path
                      className="orchestration-canvas__edge-hit"
                      d={path}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectEdge(edge);
                      }}
                    />
                  </g>
                );
              })}
              {connecting ? (() => {
                const from = nodesById.get(connecting.fromId);
                if (!from) return null;
                const start = {
                  x: from.x + nodeWidth,
                  y: from.y + nodeHeight / 2,
                };
                return (
                  <path
                    className="orchestration-canvas__preview-edge"
                    d={connectionPath(start, connecting.pointer)}
                  />
                );
              })() : null}
            </svg>
            <svg
              className="orchestration-canvas__edge-labels"
              viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
              aria-hidden="true"
            >
              {edges.map((edge) => {
                const from = nodesById.get(edge.from);
                const to = nodesById.get(edge.to);
                if (!from || !to) return null;
                const labelX = (from.x + nodeWidth + to.x) / 2;
                const labelY = (from.y + to.y) / 2 + nodeHeight / 2 - 8;
                return (
                  <text key={`${edge.from}:${edge.to}:label`} x={labelX} y={labelY}>
                    {edge.label}
                  </text>
                );
              })}
            </svg>
            {nodes.map((node) => (
              <button
                type="button"
                key={node.id}
                className={
                  "orchestration-node" +
                  (selectedId === node.id ? " is-selected" : "") +
                  (connectingHoverId === node.id ? " is-connect-target" : "") +
                  (draggingNodeId === node.id ? " is-dragging" : "") +
                  ` orchestration-node--${node.status}`
                }
                style={{ left: node.x, top: node.y }}
                onPointerDown={(event) => startNodeDrag(event, node)}
                onPointerMove={moveNodeDrag}
                onPointerUp={finishNodeDrag}
                onPointerCancel={finishNodeDrag}
                onClick={(event) => {
                  if (suppressNodeClickRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  setSelectedId(node.id);
                  setSelectedEdgeKey(null);
                }}
              >
                <span
                  className={
                    "orchestration-node__port orchestration-node__port--input" +
                    (connecting && connecting.fromId !== node.id ? " is-connectable" : "")
                  }
                  data-connection-input={node.id}
                  aria-hidden="true"
                />
                <span
                  className="orchestration-node__port orchestration-node__port--output"
                  aria-hidden="true"
                  onPointerDown={(event) => startConnecting(event, node.id)}
                  onPointerMove={moveConnecting}
                  onPointerUp={finishConnecting}
                  onPointerCancel={finishConnecting}
                />
                <span className={`runtime-dot runtime-dot--${node.runtimeId}`} />
                <span className="orchestration-node__runtime">
                  {runtimeLabel(node.runtimeId)}
                </span>
                <strong className="orchestration-node__title">{node.title}</strong>
                <span className="orchestration-node__prompt">{node.prompt}</span>
                <span className="orchestration-node__meta">
                  {nodeModeLabel(node.mode)}
                  <IconChevronRight size={13} />
                  {nodeStatusLabel(node.status)}
                </span>
                {node.sessionId ? (
                  <span className="orchestration-node__session">
                    session {node.sessionId.slice(0, 8)}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {nodes.length === 0 ? (
            <div className="orchestration-canvas__empty">
              <h3>空白编排</h3>
              <p>点击右上角“新建节点”创建第一个 CLI 节点。</p>
            </div>
          ) : null}
          <div className="orchestration-canvas__hint">
            Space + 拖动画布 · Ctrl + 滚轮缩放 · {Math.round(zoom * 100)}%
          </div>
        </div>

        <aside className="orchestration-inspector" aria-label="节点详情">
          {selectedEdge ? (
            <>
              <div className="orchestration-inspector__head">
                <span className="orchestration-inspector__edge-dot" />
                <div>
                  <h3>连线</h3>
                  <p>
                    {nodesById.get(selectedEdge.from)?.title ?? selectedEdge.from}
                    {" -> "}
                    {nodesById.get(selectedEdge.to)?.title ?? selectedEdge.to}
                  </p>
                </div>
              </div>
              <section className="orchestration-inspector__section orchestration-inspector__form">
                <label>
                  <span>标题</span>
                  <input
                    value={selectedEdge.label}
                    onChange={(event) =>
                      updateSelectedEdge({ label: event.currentTarget.value })
                    }
                  />
                </label>
              </section>
              <button
                type="button"
                className="btn btn--danger orchestration-inspector__delete"
                onClick={() => deleteEdge(selectedEdge.from, selectedEdge.to)}
              >
                <IconTrash size={15} />
                删除连线
              </button>
            </>
          ) : selected ? (
            <>
              <div className="orchestration-inspector__head">
                <span className={`runtime-dot runtime-dot--${selected.runtimeId}`} />
                <div>
                  <h3>{selected.title}</h3>
                  <p>{runtimeLabel(selected.runtimeId)}</p>
                </div>
              </div>
              <section className="orchestration-inspector__section orchestration-inspector__form">
                <label>
                  <span>标题</span>
                  <input
                    value={selected.title}
                    onChange={(event) =>
                      updateSelectedNode({ title: event.currentTarget.value })
                    }
                  />
                </label>
                <label>
                  <span>CLI</span>
                  <select
                    value={selected.runtimeId}
                    onChange={(event) =>
                      updateSelectedNode({
                        runtimeId: event.currentTarget.value as RuntimeId,
                      })
                    }
                  >
                    {runtimeOptions.map((runtimeId) => (
                      <option key={runtimeId} value={runtimeId}>
                        {runtimeLabel(runtimeId)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Prompt</span>
                  <textarea
                    value={selected.prompt}
                    rows={5}
                    onChange={(event) =>
                      updateSelectedNode({ prompt: event.currentTarget.value })
                    }
                  />
                </label>
              </section>
              <dl className="orchestration-inspector__grid">
                <div>
                  <dt>模式</dt>
                  <dd>{nodeModeLabel(selected.mode)}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{nodeStatusLabel(selected.status)}</dd>
                </div>
                <div>
                  <dt>会话</dt>
                  <dd>{selected.sessionId ? selected.sessionId.slice(0, 8) : "未运行"}</dd>
                </div>
                <div>
                  <dt>最近执行</dt>
                  <dd>{selected.lastRunAt ?? "无"}</dd>
                </div>
              </dl>
              {selected.lastError ? (
                <section className="orchestration-inspector__section orchestration-inspector__section--danger">
                  <h4>失败原因</h4>
                  <p>{selected.lastError}</p>
                </section>
              ) : null}
              {selected.sessionId ? (
                <button
                  type="button"
                  className="btn btn--ghost orchestration-inspector__session"
                  onClick={() => onOpenSession(selected.sessionId as string)}
                >
                  打开会话
                </button>
              ) : null}
              <section className="orchestration-inspector__section">
                <h4>输入</h4>
                <p>{selected.prompt}</p>
              </section>
              <section className="orchestration-inspector__section">
                <h4>执行边界</h4>
                <p>
                  最小闭环会为每个节点创建普通 Workbench 会话，并通过现有会话发送 API 串行执行；权限审批仍走 Host 统一管线。
                </p>
              </section>
              <section className="orchestration-inspector__section">
                <div className="orchestration-inspector__section-title">
                  <h4>连线</h4>
                  <span>{edges.length}</span>
                </div>
                {edges.length > 0 ? (
                  <div className="orchestration-edge-list">
                    {edges.map((edge) => {
                      const from = nodesById.get(edge.from);
                      const to = nodesById.get(edge.to);
                      if (!from || !to) return null;
                      return (
                        <div
                          className="orchestration-edge-list__item"
                          key={`${edge.from}:${edge.to}`}
                        >
                          <span>
                            {from.title}
                            <IconChevronRight size={12} />
                            {to.title}
                          </span>
                          <button
                            type="button"
                            className="chrome-btn"
                            title="删除连线"
                            aria-label="删除连线"
                            onClick={() => deleteEdge(edge.from, edge.to)}
                          >
                            <IconTrash size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p>暂无连线。</p>
                )}
              </section>
              <button
                type="button"
                className="btn btn--danger orchestration-inspector__delete"
                onClick={deleteSelectedNode}
              >
                <IconTrash size={15} />
                删除节点
              </button>
            </>
          ) : (
            <div className="orchestration-inspector__empty">
              <h3>没有节点</h3>
              <p>点击“新建节点”开始创建本地编排草稿。</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
