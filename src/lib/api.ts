import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ClaudeRouteStatus,
  CodexRouteStatus,
  ChatMessage,
  PermissionDecision,
  ProbeResult,
  RuntimeOverride,
  NativeSessionSyncResult,
  SessionDeleteResult,
  SessionExportResult,
  SessionTraceExportResult,
  SessionSelectionCatalog,
  PermissionMode,
  RuntimeInfo,
  SessionMeta,
  SessionSnapshot,
  SkillsListResult,
} from "./types";

/** True when running inside Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`Tauri command unavailable in browser: ${cmd}`);
  }
  return invoke<T>(cmd, args);
}

export const api = {
  listRuntimes: () => call<RuntimeInfo[]>("list_runtimes"),
  probeAll: () => call<ProbeResult[]>("probe_all"),
  probeRuntime: (runtimeId: string) =>
    call<ProbeResult>("probe_runtime", { runtimeId }),
  claudeRouteStatus: () => call<ClaudeRouteStatus>("claude_route_status"),
  codexRouteStatus: () => call<CodexRouteStatus>("codex_route_status"),
  openCcSwitch: () => call<string>("open_cc_switch"),
  pickProjectDirectory: (initialPath?: string | null) =>
    call<string | null>("project_pick_directory", { initialPath }),
  skillsList: (runtimeId: string, projectPath?: string | null) =>
    call<SkillsListResult>("skills_list", { runtimeId, projectPath }),
  openSessionLocation: (sessionId: string) =>
    call<string>("session_open_location", { sessionId }),

  listSessions: () => call<SessionMeta[]>("session_list"),
  createSession: (runtimeId: string, projectPath?: string | null) =>
    call<SessionMeta>("session_create", { runtimeId, projectPath }),
  updateSessionPresentation: (
    sessionId: string,
    patch: { title?: string; pinned?: boolean },
  ) =>
    call<SessionMeta>("session_update_presentation", {
      sessionId,
      patch,
    }),
  updateSessionProject: (sessionId: string, projectPath: string) =>
    call<SessionMeta>("session_update_project", { sessionId, projectPath }),
  setSessionArchived: (sessionId: string, archived: boolean) =>
    call<SessionMeta>("session_set_archived", { sessionId, archived }),
  getSnapshot: (sessionId?: string | null) =>
    call<SessionSnapshot>("session_get_state", { sessionId }),
  listSnapshots: () => call<SessionSnapshot[]>("session_list_states"),
  getSessionControlOptions: (sessionId: string) =>
    call<SessionSelectionCatalog>("session_control_options", { sessionId }),
  updateSessionSettings: (
    sessionId: string,
    patch: {
      modelId?: string;
      modelReasoningEffort?: string | null;
      permissionMode?: PermissionMode;
    },
  ) =>
    call<SessionMeta>("session_update_settings", {
      sessionId,
      patch,
    }),
  getMessages: (sessionId: string) =>
    call<ChatMessage[]>("session_get_messages", { sessionId }),
  exportSessionMarkdown: (sessionId: string) =>
    call<SessionExportResult>("session_export_markdown", { sessionId }),
  exportSessionTrace: (sessionId: string) =>
    call<SessionTraceExportResult>("session_export_trace", { sessionId }),
  deleteSession: (sessionId: string) =>
    call<SessionDeleteResult>("session_delete", { sessionId }),
  syncNativeSessions: (
    runtimeId: string,
    limit?: number,
    cursor?: string | null,
  ) =>
    call<NativeSessionSyncResult>("session_sync_native", {
      runtimeId,
      limit,
      cursor,
    }),
  respondPermission: (
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ) =>
    call<void>("session_permission_respond", {
      sessionId,
      requestId,
      decision,
    }),
  connect: (sessionId: string) =>
    call<SessionSnapshot>("session_connect", { sessionId }),
  send: (sessionId: string, text: string) =>
    call<void>("session_send", { sessionId, text }),
  stop: (sessionId: string) => call<void>("session_stop", { sessionId }),
  disconnect: (sessionId: string) =>
    call<void>("session_disconnect", { sessionId }),

  getSettings: () => call<AppSettings>("settings_get"),
  reloadSettings: () => call<AppSettings>("settings_reload"),
  setRuntimeOverride: (runtimeId: string, patch: RuntimeOverride) =>
    call<AppSettings>("settings_set_runtime_override", { runtimeId, patch }),

  appInfo: () =>
    call<{ name: string; version: string; dataDir: string }>("app_info"),
};
