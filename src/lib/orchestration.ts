import type { RuntimeId } from "./types";

export type OrchestrationNodeMode = "manual-gate" | "review" | "fix";
export type OrchestrationNodeStatus = "draft" | "ready" | "blocked";

export interface OrchestrationNode {
  id: string;
  runtimeId: RuntimeId;
  title: string;
  prompt: string;
  mode: OrchestrationNodeMode;
  status: OrchestrationNodeStatus;
  x: number;
  y: number;
}

export interface OrchestrationEdge {
  from: string;
  to: string;
  label: string;
}

export interface OrchestrationTask {
  id: string;
  title: string;
  summary: string;
  status: OrchestrationNodeStatus;
  updatedAt: string;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
}

const ORCHESTRATION_STORAGE_KEY = "workbench.orchestrationTasks.v1";
const validRuntimes = new Set<RuntimeId>(["grok", "codex", "claude", "kimi"]);
const validModes = new Set<OrchestrationNodeMode>(["manual-gate", "review", "fix"]);
const validStatuses = new Set<OrchestrationNodeStatus>([
  "draft",
  "ready",
  "blocked",
]);

export const orchestrationTemplates: OrchestrationTask[] = [
  {
    id: "delivery-loop",
    title: "方案设计到审查修复",
    summary: "Claude 出方案，Codex 实现，再由 Claude 审查并回修。",
    status: "ready",
    updatedAt: "模板",
    nodes: [
      {
        id: "plan",
        runtimeId: "claude",
        title: "方案设计",
        prompt: "分析需求、约束和现有代码，输出可执行方案。",
        mode: "manual-gate",
        status: "ready",
        x: 60,
        y: 72,
      },
      {
        id: "implement",
        runtimeId: "codex",
        title: "执行实现",
        prompt: "根据方案修改代码、补测试并记录验证结果。",
        mode: "manual-gate",
        status: "draft",
        x: 360,
        y: 72,
      },
      {
        id: "review",
        runtimeId: "claude",
        title: "审查验收",
        prompt: "审查实现质量、回归风险、测试证据和可维护性。",
        mode: "review",
        status: "draft",
        x: 660,
        y: 72,
      },
      {
        id: "fix",
        runtimeId: "codex",
        title: "按审查修复",
        prompt: "根据审查意见继续修复，直到人工确认完成。",
        mode: "fix",
        status: "blocked",
        x: 360,
        y: 280,
      },
    ],
    edges: [
      { from: "plan", to: "implement", label: "方案" },
      { from: "implement", to: "review", label: "改动 + 验证" },
      { from: "review", to: "fix", label: "审查意见" },
      { from: "fix", to: "review", label: "复审" },
    ],
  },
  {
    id: "quick-fix-review",
    title: "快速修复与复审",
    summary: "Codex 先定位和修复，Claude 只做验收门禁。",
    status: "draft",
    updatedAt: "模板",
    nodes: [
      {
        id: "diagnose",
        runtimeId: "codex",
        title: "定位问题",
        prompt: "读取报错、复现路径和相关模块，定位最小修复范围。",
        mode: "manual-gate",
        status: "ready",
        x: 80,
        y: 110,
      },
      {
        id: "patch",
        runtimeId: "codex",
        title: "补丁实现",
        prompt: "按现有工程风格实现修复，并补充必要回归测试。",
        mode: "fix",
        status: "draft",
        x: 360,
        y: 110,
      },
      {
        id: "gate",
        runtimeId: "claude",
        title: "验收门禁",
        prompt: "检查修复是否覆盖根因、是否有回归风险、测试证据是否足够。",
        mode: "review",
        status: "blocked",
        x: 640,
        y: 110,
      },
    ],
    edges: [
      { from: "diagnose", to: "patch", label: "根因" },
      { from: "patch", to: "gate", label: "补丁" },
    ],
  },
  {
    id: "requirements-to-build",
    title: "需求整理到落地",
    summary: "Kimi 整理用户需求，Codex 负责工程落地。",
    status: "draft",
    updatedAt: "模板",
    nodes: [
      {
        id: "sort",
        runtimeId: "kimi",
        title: "需求整理",
        prompt: "把口语化需求整理成目标、范围、交互和验收点。",
        mode: "manual-gate",
        status: "ready",
        x: 70,
        y: 72,
      },
      {
        id: "scope",
        runtimeId: "claude",
        title: "方案压测",
        prompt: "检查范围是否过大、是否缺边界、是否需要拆阶段。",
        mode: "review",
        status: "draft",
        x: 360,
        y: 72,
      },
      {
        id: "build",
        runtimeId: "codex",
        title: "工程落地",
        prompt: "按确认后的范围实现、验证并给出变更摘要。",
        mode: "fix",
        status: "blocked",
        x: 650,
        y: 72,
      },
    ],
    edges: [
      { from: "sort", to: "scope", label: "需求稿" },
      { from: "scope", to: "build", label: "执行方案" },
    ],
  },
];

export function cloneOrchestrationTask(task: OrchestrationTask): OrchestrationTask {
  return {
    ...task,
    nodes: task.nodes.map((node) => ({ ...node })),
    edges: task.edges.map((edge) => ({ ...edge })),
  };
}

export function createOrchestrationNode(
  index: number,
  position?: { x: number; y: number },
): OrchestrationNode {
  return {
    id: `node-${Date.now().toString(36)}-${index}`,
    runtimeId: "codex",
    title: `节点 ${index}`,
    prompt: "输入这个节点要交给 CLI 的任务内容。",
    mode: "manual-gate",
    status: "draft",
    x: position?.x ?? 90 + (index % 3) * 260,
    y: position?.y ?? 90 + Math.floor(index / 3) * 170,
  };
}

export function createOrchestrationTask(index: number): OrchestrationTask {
  return {
    id: `task-${Date.now().toString(36)}-${index}`,
    title: `新编排 ${index}`,
    summary: "本地编排草稿，尚未接入真实执行。",
    status: "draft",
    updatedAt: formatOrchestrationUpdatedAt(),
    nodes: [createOrchestrationNode(1)],
    edges: [],
  };
}

export function formatOrchestrationUpdatedAt(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeRuntimeId(value: unknown): RuntimeId {
  return typeof value === "string" && validRuntimes.has(value as RuntimeId)
    ? (value as RuntimeId)
    : "codex";
}

function normalizeMode(value: unknown): OrchestrationNodeMode {
  return typeof value === "string" && validModes.has(value as OrchestrationNodeMode)
    ? (value as OrchestrationNodeMode)
    : "manual-gate";
}

function normalizeStatus(value: unknown): OrchestrationNodeStatus {
  return typeof value === "string" &&
    validStatuses.has(value as OrchestrationNodeStatus)
    ? (value as OrchestrationNodeStatus)
    : "draft";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeNode(value: unknown, fallbackIndex: number): OrchestrationNode {
  const record = asRecord(value);
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? record.id
        : `node-${fallbackIndex}`,
    runtimeId: normalizeRuntimeId(record.runtimeId),
    title:
      typeof record.title === "string" && record.title.trim()
        ? record.title
        : `节点 ${fallbackIndex}`,
    prompt: typeof record.prompt === "string" ? record.prompt : "",
    mode: normalizeMode(record.mode),
    status: normalizeStatus(record.status),
    x: typeof record.x === "number" && Number.isFinite(record.x) ? record.x : 80,
    y: typeof record.y === "number" && Number.isFinite(record.y) ? record.y : 80,
  };
}

function normalizeTask(value: unknown, fallbackIndex: number): OrchestrationTask {
  const record = asRecord(value);
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map((node, index) => normalizeNode(node, index + 1))
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(record.edges)
    ? record.edges
        .map((edge) => {
          const edgeRecord = asRecord(edge);
          return {
            from: typeof edgeRecord.from === "string" ? edgeRecord.from : "",
            to: typeof edgeRecord.to === "string" ? edgeRecord.to : "",
            label: typeof edgeRecord.label === "string" ? edgeRecord.label : "",
          };
        })
        .filter(
          (edge) =>
            edge.from &&
            edge.to &&
            edge.from !== edge.to &&
            nodeIds.has(edge.from) &&
            nodeIds.has(edge.to),
        )
    : [];
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? record.id
        : `task-${fallbackIndex}`,
    title:
      typeof record.title === "string" && record.title.trim()
        ? record.title
        : `编排 ${fallbackIndex}`,
    summary: typeof record.summary === "string" ? record.summary : "",
    status: normalizeStatus(record.status),
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.trim()
        ? record.updatedAt
        : "本地",
    nodes,
    edges,
  };
}

export function loadOrchestrationTasks(): OrchestrationTask[] {
  try {
    const raw = localStorage.getItem(ORCHESTRATION_STORAGE_KEY);
    if (!raw) return orchestrationTemplates.map(cloneOrchestrationTask);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return orchestrationTemplates.map(cloneOrchestrationTask);
    const tasks = parsed.map((item, index) => normalizeTask(item, index + 1));
    return tasks.length > 0 ? tasks : orchestrationTemplates.map(cloneOrchestrationTask);
  } catch {
    return orchestrationTemplates.map(cloneOrchestrationTask);
  }
}

export function saveOrchestrationTasks(tasks: OrchestrationTask[]): boolean {
  try {
    localStorage.setItem(ORCHESTRATION_STORAGE_KEY, JSON.stringify(tasks));
    return true;
  } catch {
    return false;
  }
}
