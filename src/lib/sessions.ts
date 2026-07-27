/** Session list plumbing: display text, merging, and the pre-connect snapshot. */
import { invoke } from "@tauri-apps/api/core";

import { compactLabel } from "./format";
import { defaultPermissionMode } from "./permissions";
import { runtimeLabel } from "./runtimes";
import type {
  RuntimeId,
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

/** Settings are owned by the Host while a turn is in flight; don't let the UI race it. */
export function canChangeSessionSettings(state: SessionState): boolean {
  return !["connecting", "streaming", "awaiting_permission"].includes(state);
}

export async function deleteSessionById(
  sessionId: string,
): Promise<SessionDeleteResult> {
  return invoke<SessionDeleteResult>("session_delete", { sessionId });
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
  return [...map.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
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
  lastError: null,
  backend: session ? `${session.runtimeId}_stub` : "none",
  modelId: session?.modelId ?? null,
  modelReasoningEffort: session?.modelReasoningEffort ?? null,
  permissionMode:
    session?.permissionMode ?? defaultPermissionMode(session?.runtimeId),
  projectPath: session?.projectPath ?? null,
  title: session?.title ?? "Workbench",
});
