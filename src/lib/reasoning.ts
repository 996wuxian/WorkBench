import type { RuntimeId, SessionSelectionCatalog } from "./types";
import { CODEX_REASONING_OPTIONS } from "./codex";

export const DEEPSEEK_REASONING_OPTIONS: SessionSelectionCatalog["modelOptions"] = [
  { value: "off", label: "关闭", hint: "禁用思考", disabled: false },
  { value: "low", label: "低", hint: null, disabled: false },
  { value: "high", label: "高", hint: null, disabled: false },
  { value: "max", label: "超高", hint: "DeepSeek Harness max", disabled: false },
];

export function reasoningOptionsForRuntime(
  runtimeId: RuntimeId | null | undefined,
): SessionSelectionCatalog["modelOptions"] {
  if (runtimeId === "deepseek-harness") return DEEPSEEK_REASONING_OPTIONS;
  return CODEX_REASONING_OPTIONS;
}

export function defaultReasoningEffortForRuntime(
  runtimeId: RuntimeId | null | undefined,
): string | null {
  if (runtimeId === "codex") return "high";
  if (runtimeId === "deepseek-harness") return "high";
  return null;
}
