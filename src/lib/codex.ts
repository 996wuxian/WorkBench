/**
 * Codex-specific display quirks — the one place the frontend special-cases a
 * runtime.
 *
 * Codex encodes reasoning effort into the model id it reports (`gpt-5-high`),
 * while Workbench models it as a separate setting. Everything here exists to
 * reconcile those two views and should shrink as the Host catalog takes over.
 */
import type { RuntimeId, SessionSelectionCatalog } from "./types";

export const CODEX_REASONING_OPTIONS: SessionSelectionCatalog["modelOptions"] = [
  { value: "low", label: "低", hint: null, disabled: false },
  { value: "medium", label: "中", hint: null, disabled: false },
  { value: "high", label: "高", hint: null, disabled: false },
];

/** `gpt-5` is the implicit default; showing it as a choice only confuses. */
export function isHiddenCodexModel(model?: string | null): boolean {
  return model?.trim().toLowerCase() === "gpt-5";
}

/** Strip the effort suffix so `gpt-5-high` selects the `gpt-5` model entry. */
export function normalizeCodexModelId(model?: string | null): string {
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

export function codexReasoningEffortFromModel(
  model?: string | null,
): string | null {
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

/**
 * Only used when the Host catalog call fails — it normally answers from the
 * runtime manifest. Keep it to what we can know without the Host: the model the
 * session already uses, plus a small codex fallback catalog and "default".
 */
export function fallbackModelOptions(
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
  }
  if (runtimeId === "deepseek-harness") {
    add("deepseek-v4-flash", "fallback");
    add("deepseek-v4-pro", "fallback");
  }
  add("default", "fallback");

  return Array.from(values.values()).map((item) => ({
    value: item.value,
    label: item.label,
    hint: item.hint ?? null,
    disabled: false,
  }));
}
