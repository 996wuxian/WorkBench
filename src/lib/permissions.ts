/** Permission-mode vocabulary and the fallback catalog used when the Host is unreachable. */
import { runtimeInfo } from "./runtimes";
import type {
  PermissionDecision,
  PermissionMode,
  RuntimeId,
  SessionSelectionCatalog,
} from "./types";

export const PERMISSION_MODE_ORDER: PermissionMode[] = [
  "ask",
  "auto",
  "read_only",
  "full_access",
];

export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  ask: "Ask",
  auto: "Approve for me",
  read_only: "Read Only",
  full_access: "Full Access",
};

export const PERMISSION_MODE_HINT: Record<PermissionMode, string> = {
  ask: "每次工具调用都询问",
  auto: "自动批准工具调用",
  read_only: "只读，不允许写入",
  full_access: "完全放开沙箱",
};

export const PERMISSION_DECISION_LABEL: Record<PermissionDecision, string> = {
  allow_once: "允许",
  allow_always: "始终允许",
  deny: "拒绝",
  cancel: "取消",
};

/** Why an approval was resolved. Keyed loosely so an unknown source degrades. */
export const PERMISSION_SOURCE_LABEL: Record<string, string> = {
  user: "你",
  mode: "会话权限模式",
  remembered: "本会话已记住的授权",
  timeout: "超时策略",
  aborted: "进程退出",
};

/** Manifest-declared default; "ask" is the safe fallback before the registry loads. */
export function defaultPermissionMode(
  runtimeId?: RuntimeId | null,
): PermissionMode {
  return runtimeInfo(runtimeId)?.defaultPermissionMode ?? "ask";
}

/**
 * Used only when the Host catalog call fails. The modes a runtime can honor are
 * declared in its manifest, so unsupported ones are disabled rather than hidden
 * — a mode silently missing looks like a bug, a greyed-out one explains itself.
 */
export function fallbackPermissionOptions(
  runtimeId: RuntimeId,
): SessionSelectionCatalog["permissionOptions"] {
  const info = runtimeInfo(runtimeId);
  const supported = info?.permissionModes ?? [];
  return PERMISSION_MODE_ORDER.map((mode) => {
    const usable = supported.length === 0 || supported.includes(mode);
    return {
      value: mode,
      label: PERMISSION_MODE_LABEL[mode],
      hint: usable
        ? PERMISSION_MODE_HINT[mode]
        : `${info?.displayName ?? runtimeId} 暂不支持`,
      disabled: !usable,
    };
  });
}
