import { describe, expect, it } from "vitest";

import {
  buildRunProfileSettingsPlan,
  normalizeRunProfileId,
  resolveRunProfileRuntime,
  runProfileOptionStates,
} from "./runProfiles";
import type { RuntimeInfo, SessionSelectionCatalog } from "./types";

function runtime(value: Partial<RuntimeInfo> & Pick<RuntimeInfo, "id">): RuntimeInfo {
  return {
    id: value.id,
    displayName: value.displayName ?? value.id,
    enabled: value.enabled ?? true,
    capabilities: {
      streaming: true,
      thoughts: false,
      tools: true,
      permissionGate: true,
      sessionResume: true,
      multiTurn: true,
      modelsList: true,
      reasoningEffort: value.capabilities?.reasoningEffort ?? false,
      planMode: false,
      slashCommands: false,
      imagesIn: false,
      imagesOut: false,
      protocol: "stub",
    },
    permissionModes: value.permissionModes ?? ["ask", "auto"],
    defaultPermissionMode: value.defaultPermissionMode ?? "ask",
    notes: value.notes ?? null,
  };
}

const catalog: SessionSelectionCatalog = {
  runtimeId: "codex",
  modelOptions: [{ value: "default", label: "default", disabled: false }],
  permissionOptions: [
    { value: "ask", label: "Ask", disabled: false },
    { value: "full_access", label: "Full Access", disabled: false },
  ],
};

describe("run profiles", () => {
  it("normalizes unknown ids to safe coding", () => {
    expect(normalizeRunProfileId("unknown")).toBe("safe-coding");
  });

  it("selects the first enabled preferred runtime", () => {
    const resolution = resolveRunProfileRuntime(
      "review-only",
      [
        runtime({ id: "claude", enabled: false }),
        runtime({ id: "codex", enabled: true }),
      ],
      "grok",
    );

    expect(resolution.runtimeId).toBe("codex");
  });

  it("falls back to the current runtime when no preferred runtime is enabled", () => {
    const resolution = resolveRunProfileRuntime(
      "full-access",
      [
        runtime({ id: "codex", enabled: false }),
        runtime({ id: "custom", enabled: true }),
      ],
      "custom",
    );

    expect(resolution.runtimeId).toBe("custom");
    expect(resolution.degradations[0]).toContain("首选 runtime 当前不可用");
  });

  it("builds a supported settings patch", () => {
    const plan = buildRunProfileSettingsPlan(
      "full-access",
      runtime({
        id: "codex",
        capabilities: { reasoningEffort: true } as RuntimeInfo["capabilities"],
        permissionModes: ["ask", "full_access"],
      }),
      catalog,
    );

    expect(plan.patch).toStrictEqual({
      modelId: "default",
      modelReasoningEffort: "high",
      permissionMode: "full_access",
    });
    expect(plan.degradations).toStrictEqual([]);
  });

  it("degrades unsupported permission and reasoning settings", () => {
    const plan = buildRunProfileSettingsPlan(
      "review-only",
      runtime({ id: "grok", permissionModes: ["ask", "auto"] }),
      {
        runtimeId: "grok",
        modelOptions: [{ value: "default", label: "default", disabled: false }],
        permissionOptions: [{ value: "ask", label: "Ask", disabled: false }],
      },
    );

    expect(plan.patch).toStrictEqual({ modelId: "default" });
    expect(plan.degradations).toHaveLength(2);
  });

  it("disables profile options when no enabled runtime supports the permission mode", () => {
    const options = runProfileOptionStates(
      [runtime({ id: "grok", permissionModes: ["ask", "auto"] })],
      "grok",
    );

    expect(options.find((option) => option.profile.id === "safe-coding")).toMatchObject({
      disabled: false,
    });
    expect(options.find((option) => option.profile.id === "review-only")).toMatchObject({
      disabled: true,
      hint: "没有启用支持 read_only 的 CLI",
    });
    expect(options.find((option) => option.profile.id === "full-access")).toMatchObject({
      disabled: true,
      hint: "没有启用支持 full_access 的 CLI",
    });
  });
});
