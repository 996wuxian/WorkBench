/** Session list plumbing: display text, merging, and the pre-connect snapshot. */
import { invoke } from "@tauri-apps/api/core";

import { compactLabel } from "./format";
import { defaultPermissionMode } from "./permissions";
import { runtimeLabel } from "./runtimes";
import type {
  RuntimeId,
  SessionDeleteOptions,
  SessionDeleteResult,
  SessionMeta,
  SessionSnapshot,
  SessionState,
} from "./types";

export const SESSION_PAGE_SIZE = 30;
export const RUNTIME_PICK_STORAGE_KEY = "workbench.runtimePick";

export function stateDotClass(state: SessionState): string {
  if (state === "ready" || state === "streaming") return "status-dot--ok";
  if (state === "connecting" || state === "awaiting_permission")
    return "status-dot--warn";
  if (state === "disconnected") return "status-dot--err";
  return "status-dot--idle";
}

export function sessionStateLabel(snapshot?: SessionSnapshot): string {
  switch (snapshot?.state ?? "idle") {
    case "connecting":
      return "连接中";
    case "ready":
      return "就绪";
    case "streaming":
      return "生成中";
    case "awaiting_permission":
      return "等待授权";
    case "disconnected":
      return snapshot?.lastError ? "异常断开" : "已断开";
    default:
      return "未连接";
  }
}

export type SessionProcessStats = {
  total: number;
  running: number;
  processes: number;
};

/** Counts for one runtime's sidebar list. Search filtering does not change them. */
export function sessionProcessStats(
  sessions: SessionMeta[],
  snapshots: Record<string, SessionSnapshot>,
): SessionProcessStats {
  let running = 0;
  let processes = 0;
  for (const session of sessions) {
    const state = snapshots[session.id]?.state ?? "idle";
    if (["connecting", "streaming", "awaiting_permission"].includes(state)) {
      running += 1;
    }
    if (["connecting", "ready", "streaming", "awaiting_permission"].includes(state)) {
      processes += 1;
    }
  }
  return { total: sessions.length, running, processes };
}

/** Settings are owned by the Host while a turn is in flight; don't let the UI race it. */
export function canChangeSessionSettings(state: SessionState): boolean {
  return !["connecting", "streaming", "awaiting_permission"].includes(state);
}

export async function deleteSessionById(
  sessionId: string,
  options: SessionDeleteOptions = {},
): Promise<SessionDeleteResult> {
  return invoke<SessionDeleteResult>("session_delete", {
    sessionId,
    nativeDeleteMode: options.nativeDeleteMode ?? "official",
  });
}

export function sessionDisplayTitle(session: SessionMeta): string {
  const title = session.title?.trim();
  const genericTitle =
    !title ||
    title === "Codex session" ||
    title === "Grok session" ||
    title.endsWith("· 新会话");
  if (!genericTitle) return title;
  if (session.summary?.trim()) {
    return compactLabel(session.summary, 64);
  }
  return title || `${runtimeLabel(session.runtimeId)} session`;
}

export function sessionDisplaySummary(session: SessionMeta): string | null {
  const title = sessionDisplayTitle(session);
  const summary = session.summary?.trim();
  if (summary && summary !== title) return summary;
  if (session.lastResumeError) return `resume error: ${session.lastResumeError}`;
  if (session.projectPath) return session.projectPath;
  const nativeId = session.nativeSessionId ?? session.nativeThreadId;
  if (nativeId) return `native ${nativeId}`;
  return null;
}

/** Field-wise merge so a partial update never blanks data the list already had. */
export function mergeSessions(
  prev: SessionMeta[],
  incoming: SessionMeta[],
): SessionMeta[] {
  const map = new Map(prev.map((session) => [session.id, session]));
  for (const session of incoming) {
    map.set(session.id, { ...(map.get(session.id) ?? {}), ...session });
  }
  return [...map.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

/**
 * Any manifest id is valid, so the stored value is not validated against a
 * hardcoded list — an effect corrects it once the Host registry has loaded.
 */
export function loadRuntimePick(): RuntimeId {
  try {
    const value = localStorage.getItem(RUNTIME_PICK_STORAGE_KEY)?.trim();
    if (value) return value;
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
  return "grok";
}

export function saveRuntimePick(runtimeId: RuntimeId): void {
  try {
    localStorage.setItem(RUNTIME_PICK_STORAGE_KEY, runtimeId);
  } catch {
    // Ignore storage failures; the selected runtime still works in memory.
  }
}

/** What the UI shows for a session that has no live process behind it yet. */
export const idleSnapshot = (session?: SessionMeta | null): SessionSnapshot => ({
  sessionId: session?.id ?? null,
  runtimeId: session?.runtimeId ?? null,
  state: "idle",
  promptStartedAt: null,
  lastError: null,
  backend: session ? `${session.runtimeId}_stub` : "none",
  modelId: session?.modelId ?? null,
  modelReasoningEffort: session?.modelReasoningEffort ?? null,
  permissionMode:
    session?.permissionMode ?? defaultPermissionMode(session?.runtimeId),
  projectPath: session?.projectPath ?? null,
  title: session?.title ?? "Workbench",
});
