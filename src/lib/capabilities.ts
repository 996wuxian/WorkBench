import type { RuntimeCapabilities, RuntimeInfo } from "./types";

export type CapabilityKey =
  | "streaming"
  | "thoughts"
  | "tools"
  | "permissionGate"
  | "sessionResume"
  | "multiTurn"
  | "modelsList"
  | "reasoningEffort"
  | "planMode"
  | "slashCommands"
  | "imagesIn"
  | "imagesOut";

export interface CapabilityDescriptor {
  key: CapabilityKey;
  label: string;
  enabled: boolean;
  unavailableReason: string;
}

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  streaming: "流式输出",
  thoughts: "思考流",
  tools: "工具事件",
  permissionGate: "Host 权限",
  sessionResume: "恢复",
  multiTurn: "多轮",
  modelsList: "模型列表",
  reasoningEffort: "推理档位",
  planMode: "计划模式",
  slashCommands: "斜杠命令",
  imagesIn: "图片输入",
  imagesOut: "图片输出",
};

const UNAVAILABLE_REASONS: Record<CapabilityKey, string> = {
  streaming: "该 runtime 不提供流式输出",
  thoughts: "该 runtime 不提供独立思考流",
  tools: "该 runtime 不提供结构化工具事件",
  permissionGate: "该 runtime 不支持 Host 侧权限闸",
  sessionResume: "该 runtime 不支持原生会话恢复",
  multiTurn: "该 runtime 不支持持续多轮会话",
  modelsList: "该 runtime 不能动态列出模型",
  reasoningEffort: "该 runtime 不支持独立推理档位",
  planMode: "该 runtime 不支持计划模式",
  slashCommands: "该 runtime 不支持斜杠命令",
  imagesIn: "该 runtime 不支持图片输入",
  imagesOut: "该 runtime 不支持图片输出",
};

export const CORE_CAPABILITIES: CapabilityKey[] = [
  "streaming",
  "tools",
  "permissionGate",
  "sessionResume",
  "multiTurn",
  "modelsList",
  "reasoningEffort",
  "planMode",
  "imagesIn",
  "imagesOut",
];

export const INSPECTOR_CAPABILITIES: CapabilityKey[] = [
  "streaming",
  "tools",
  "permissionGate",
  "sessionResume",
  "modelsList",
  "reasoningEffort",
];

export function capabilityDescriptors(
  capabilities: RuntimeCapabilities,
  keys: readonly CapabilityKey[] = CORE_CAPABILITIES,
): CapabilityDescriptor[] {
  return keys.map((key) => ({
    key,
    label: CAPABILITY_LABELS[key],
    enabled: Boolean(capabilities[key]),
    unavailableReason: UNAVAILABLE_REASONS[key],
  }));
}

export function runtimeCapabilitySummary(runtime: RuntimeInfo): string {
  const supported = capabilityDescriptors(runtime.capabilities).filter(
    (capability) => capability.enabled,
  ).length;
  return `${supported}/${CORE_CAPABILITIES.length}`;
}

export function capabilityLabel(key: CapabilityKey): string {
  return CAPABILITY_LABELS[key];
}

export function protocolLabel(protocol: string): string {
  switch (protocol) {
    case "acp":
      return "ACP";
    case "codex_app_server":
      return "Codex App Server";
    case "claude_code":
      return "Claude Code";
    case "stream_json":
      return "stream-json";
    case "stub":
      return "stub";
    default:
      return protocol || "unknown";
  }
}
