import type {
  PermissionMode,
  RuntimeId,
  RuntimeInfo,
  SessionSelectionCatalog,
} from "./types";

export type RunProfileId =
  | "safe-coding"
  | "review-only"
  | "fast-local"
  | "full-access";

export type RunProfileSettingsPatch = {
  modelId?: string;
  modelReasoningEffort?: string | null;
  permissionMode?: PermissionMode;
};

export interface RunProfile {
  id: RunProfileId;
  label: string;
  summary: string;
  preferredRuntimeIds: RuntimeId[];
  modelId: string;
  modelReasoningEffort?: "low" | "medium" | "high";
  permissionMode: PermissionMode;
}

export interface RunProfileResolution {
  profile: RunProfile;
  runtimeId: RuntimeId;
  degradations: string[];
}

export interface RunProfileSettingsPlan {
  patch: RunProfileSettingsPatch;
  applied: string[];
  degradations: string[];
}

export interface RunProfileOptionState {
  profile: RunProfile;
  runtimeId: RuntimeId;
  disabled: boolean;
  hint: string;
  degradations: string[];
}

const RUN_PROFILE_STORAGE_KEY = "workbench.runProfile";

export const RUN_PROFILES: RunProfile[] = [
  {
    id: "safe-coding",
    label: "安全编码",
    summary: "默认询问权限，偏向 Codex 实现，推理档位优先高。",
    preferredRuntimeIds: ["codex", "claude", "grok", "kimi"],
    modelId: "default",
    modelReasoningEffort: "high",
    permissionMode: "ask",
  },
  {
    id: "review-only",
    label: "只读审查",
    summary: "只读审查优先，适合验收、代码审查和风险扫描。",
    preferredRuntimeIds: ["claude", "codex", "kimi", "grok"],
    modelId: "default",
    modelReasoningEffort: "medium",
    permissionMode: "read_only",
  },
  {
    id: "fast-local",
    label: "快速模式",
    summary: "低推理档位与自动权限，适合低风险快速问答和小改动。",
    preferredRuntimeIds: ["kimi", "grok", "codex", "claude"],
    modelId: "default",
    modelReasoningEffort: "low",
    permissionMode: "auto",
  },
  {
    id: "full-access",
    label: "完整权限",
    summary: "完整权限，适合明确授权的工程落地任务。",
    preferredRuntimeIds: ["codex", "grok", "claude", "kimi"],
    modelId: "default",
    modelReasoningEffort: "high",
    permissionMode: "full_access",
  },
];

const RUN_PROFILE_IDS = new Set(RUN_PROFILES.map((profile) => profile.id));

export function normalizeRunProfileId(value: unknown): RunProfileId {
  return typeof value === "string" && RUN_PROFILE_IDS.has(value as RunProfileId)
    ? (value as RunProfileId)
    : "safe-coding";
}

export function runProfileById(id: RunProfileId): RunProfile {
  return RUN_PROFILES.find((profile) => profile.id === id) ?? RUN_PROFILES[0];
}

export function loadRunProfileId(): RunProfileId {
  try {
    return normalizeRunProfileId(localStorage.getItem(RUN_PROFILE_STORAGE_KEY));
  } catch {
    return "safe-coding";
  }
}

export function saveRunProfileId(id: RunProfileId): void {
  try {
    localStorage.setItem(RUN_PROFILE_STORAGE_KEY, id);
  } catch {
    // Best-effort UI preference.
  }
}

export function resolveRunProfileRuntime(
  profileId: RunProfileId,
  runtimes: RuntimeInfo[],
  currentRuntimeId: RuntimeId,
): RunProfileResolution {
  const profile = runProfileById(profileId);
  const enabled = runtimes.filter((runtime) => runtime.enabled);
  const compatible = enabled.filter((runtime) =>
    runtimeSupportsProfilePermission(runtime, profile),
  );
  const preferred = profile.preferredRuntimeIds
    .map((id) => compatible.find((runtime) => runtime.id === id))
    .find((runtime): runtime is RuntimeInfo => Boolean(runtime));
  const currentCompatible = compatible.find((runtime) => runtime.id === currentRuntimeId);
  const runtime = preferred ?? currentCompatible ?? compatible[0] ?? enabled[0] ?? null;
  const runtimeId = runtime?.id ?? currentRuntimeId;
  const degradations: string[] = [];
  if (!preferred) {
    degradations.push(`${profile.label} 的首选 runtime 当前不可用，沿用 ${runtimeId}`);
  }
  if (runtime && !runtimeSupportsProfilePermission(runtime, profile)) {
    degradations.push(
      `${runtime.displayName} 不支持权限模式 ${profile.permissionMode}`,
    );
  }

  return { profile, runtimeId, degradations };
}

export function runtimeSupportsProfilePermission(
  runtime: RuntimeInfo,
  profile: RunProfile,
): boolean {
  return (
    runtime.permissionModes.length === 0 ||
    runtime.permissionModes.includes(profile.permissionMode)
  );
}

export function runProfileOptionStates(
  runtimes: RuntimeInfo[],
  currentRuntimeId: RuntimeId,
): RunProfileOptionState[] {
  const enabled = runtimes.filter((runtime) => runtime.enabled);
  return RUN_PROFILES.map((profile) => {
    const compatible = enabled.filter((runtime) =>
      runtimeSupportsProfilePermission(runtime, profile),
    );
    const resolution = resolveRunProfileRuntime(profile.id, runtimes, currentRuntimeId);
    const runtime = enabled.find((item) => item.id === resolution.runtimeId);
    const disabled = enabled.length > 0 && compatible.length === 0;
    const reasoningDegrade =
      runtime && profile.modelReasoningEffort && !runtime.capabilities.reasoningEffort
        ? `${runtime.displayName} 不支持推理档位`
        : null;
    const hint = disabled
      ? `没有启用支持 ${profile.permissionMode} 的 CLI`
      : [
          runtime?.displayName ?? resolution.runtimeId,
          `permission ${profile.permissionMode}`,
          reasoningDegrade,
        ]
          .filter(Boolean)
          .join(" · ");
    return {
      profile,
      runtimeId: resolution.runtimeId,
      disabled,
      hint,
      degradations: [
        ...resolution.degradations,
        ...(reasoningDegrade ? [reasoningDegrade] : []),
      ],
    };
  });
}

export function buildRunProfileSettingsPlan(
  profileId: RunProfileId,
  runtime: RuntimeInfo | undefined,
  catalog?: SessionSelectionCatalog | null,
): RunProfileSettingsPlan {
  const profile = runProfileById(profileId);
  const runtimeName = runtime?.displayName ?? "当前 runtime";
  const patch: RunProfileSettingsPatch = {};
  const applied: string[] = [];
  const degradations: string[] = [];

  const modelOption = catalog?.modelOptions.find(
    (option) => option.value === profile.modelId,
  );
  if (!catalog || modelOption) {
    if (modelOption?.disabled) {
      degradations.push(`${runtimeName} 暂不支持模型 ${profile.modelId}`);
    } else {
      patch.modelId = profile.modelId;
      applied.push(`model=${profile.modelId}`);
    }
  } else {
    degradations.push(`${runtimeName} 的模型列表中没有 ${profile.modelId}`);
  }

  if (profile.modelReasoningEffort) {
    if (runtime?.capabilities.reasoningEffort) {
      patch.modelReasoningEffort = profile.modelReasoningEffort;
      applied.push(`reasoning=${profile.modelReasoningEffort}`);
    } else {
      degradations.push(`${runtimeName} 不支持推理档位，沿用 runtime 默认值`);
    }
  }

  const manifestAllowsPermission =
    !runtime ||
    runtime.permissionModes.length === 0 ||
    runtime.permissionModes.includes(profile.permissionMode);
  const permissionOption = catalog?.permissionOptions.find(
    (option) => option.value === profile.permissionMode,
  );
  if (!manifestAllowsPermission || permissionOption?.disabled) {
    degradations.push(
      `${runtimeName} 不支持权限模式 ${profile.permissionMode}，沿用 runtime 默认值`,
    );
  } else if (catalog && !permissionOption) {
    degradations.push(
      `${runtimeName} 的权限列表中没有 ${profile.permissionMode}，沿用 runtime 默认值`,
    );
  } else {
    patch.permissionMode = profile.permissionMode;
    applied.push(`permission=${profile.permissionMode}`);
  }

  return { patch, applied, degradations };
}

export function runProfileHint(plan: Pick<RunProfileSettingsPlan, "degradations">): string {
  return plan.degradations[0] ?? "新建会话会自动套用该运行组合";
}

export function hasRunProfilePatch(patch: RunProfileSettingsPatch): boolean {
  return (
    patch.modelId !== undefined ||
    patch.modelReasoningEffort !== undefined ||
    patch.permissionMode !== undefined
  );
}
