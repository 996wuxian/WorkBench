/**
 * Runtimes are declared by manifests on the Host, so the set is open-ended —
 * a new CLI must not require a frontend type change. Use `runtimeLabel()` from
 * `lib/runtimes` to render one instead of a hardcoded map.
 */
export type RuntimeId = string;

export type SessionState =
  | "idle"
  | "connecting"
  | "ready"
  | "streaming"
  | "awaiting_permission"
  | "disconnected";

export type SessionUnreadKind = "completed" | "error";

export type AgentErrorCode =
  | "CLI_NOT_FOUND"
  | "AUTH_FAILED"
  | "NETWORK_PROVIDER"
  | "AGENT_CRASHED"
  | "QUOTA_EXCEEDED"
  | "CONNECT_FAILED"
  | "PROTOCOL_MISMATCH"
  | "CAPABILITY_MISSING";

export interface AgentError {
  code: AgentErrorCode;
  message: string;
}

export interface RuntimeCapabilities {
  streaming: boolean;
  thoughts: boolean;
  tools: boolean;
  permissionGate: boolean;
  sessionResume: boolean;
  multiTurn: boolean;
  modelsList: boolean;
  reasoningEffort: boolean;
  planMode: boolean;
  slashCommands: boolean;
  imagesIn: boolean;
  imagesOut: boolean;
  protocol: string;
}

export interface RuntimeInfo {
  id: RuntimeId;
  displayName: string;
  enabled: boolean;
  capabilities: RuntimeCapabilities;
  permissionModes: PermissionMode[];
  defaultPermissionMode: PermissionMode;
  /** Why a runtime is unavailable or degraded — shown in Doctor. */
  notes?: string | null;
}

export interface ProbeResult {
  runtimeId: RuntimeId;
  found: boolean;
  path?: string | null;
  version?: string | null;
  detail?: string | null;
}

export interface CodexRouteStatus {
  routeKind: string;
  ccSwitchDetected: boolean;
  modelProvider?: string | null;
  model?: string | null;
  modelReasoningEffort?: string | null;
  baseUrl?: string | null;
  wireApi?: string | null;
  latestForwardUrl?: string | null;
  latestForwardModel?: string | null;
  latestError?: string | null;
  note: string;
}

export interface ClaudeRouteStatus {
  baseUrl?: string | null;
  model?: string | null;
  outputLimit?: string | null;
  routeKind: string;
  note: string;
}

export type PermissionMode = "ask" | "auto" | "read_only" | "full_access";

export interface ChoiceOption {
  value: string;
  label: string;
  hint?: string | null;
  suffix?: string | null;
  disabled?: boolean;
}

export interface SessionSelectionCatalog {
  runtimeId: RuntimeId;
  modelOptions: ChoiceOption[];
  permissionOptions: ChoiceOption[];
}

export interface SessionMeta {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  summary?: string | null;
  runtimeId: RuntimeId;
  projectPath?: string | null;
  modelId?: string | null;
  modelReasoningEffort?: string | null;
  permissionMode?: PermissionMode | null;
  nativeSessionId?: string | null;
  nativeThreadId?: string | null;
  nativeHome?: string | null;
  resumeSupported?: boolean;
  lastResumeError?: string | null;
  nativeSource?: string | null;
  nativeUpdatedAt?: string | null;
  nativeHistoryImportedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeSessionSyncResult {
  runtimeId: RuntimeId;
  sessions: SessionMeta[];
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "project" | "user" | string;
  path?: string | null;
}

export interface SkillsListResult {
  runtimeId: RuntimeId;
  skills: SkillInfo[];
  searchedPaths: string[];
}

export interface SessionDeleteResult {
  deletedSessionId: string;
  deletedPath: string;
  activeSessionId?: string | null;
}

export type NativeDeleteMode = "official" | "direct" | "skip";

export interface SessionDeleteOptions {
  nativeDeleteMode?: NativeDeleteMode;
}

export interface SessionExportResult {
  sessionId: string;
  path: string;
  messageCount: number;
}

export interface SessionTraceExportResult {
  sessionId: string;
  path: string;
  eventCount: number;
}

export interface SessionSnapshot {
  sessionId?: string | null;
  runtimeId?: RuntimeId | null;
  state: SessionState;
  promptStartedAt?: string | null;
  lastError?: AgentError | null;
  backend: string;
  modelId?: string | null;
  modelReasoningEffort?: string | null;
  permissionMode?: PermissionMode | null;
  projectPath?: string | null;
  title: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "thought" | "tool";
  content: string;
  runtimeId?: RuntimeId;
  createdAt?: string;
  completedAt?: string | null;
  /** Milliseconds inside this turn spent waiting for user permission. */
  elapsedPausedMs?: number;
  /** Current permission wait start; live-only, not persisted by the UI. */
  elapsedPauseStartedAt?: string | null;
  /** Runtime-native tool call id; repeated status updates share it. */
  toolCallId?: string | null;
  toolName?: string | null;
  toolTitle?: string | null;
  toolStatus?: string | null;
  /**
   * Restored from a mid-stream checkpoint: the turn never completed, so this is
   * as much as the Host managed to persist before the process died.
   */
  partial?: boolean;
  /** True while assistant stream is still open */
  streaming?: boolean;
  /** True before first assistant content arrives */
  pending?: boolean;
  /** Live-only: revisiting this stream should not replay received text from zero. */
  revealImmediately?: boolean;
}

/** A pending tool approval waiting on the user. */
export interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  toolName: string;
  title: string;
  preview: string;
  /** True when the session mode already answered it — display only. */
  autoAllowed: boolean;
}

export type PermissionDecision =
  | "allow_once"
  | "allow_always"
  | "deny"
  | "cancel";

export type PermissionDecisionSource =
  | "user"
  | "mode"
  | "remembered"
  | "timeout"
  | "aborted";

export interface PermissionResolvedEvent {
  sessionId: string;
  requestId: string;
  decision: PermissionDecision;
  source: PermissionDecisionSource;
}

export interface TurnSettledEvent {
  sessionId: string;
  stopReason: string;
  meta: SessionMeta;
}

export interface RuntimeOverride {
  enabled?: boolean | null;
  cliPath?: string | null;
  homeDir?: string | null;
}

export interface AppSettings {
  runtimes: Record<string, RuntimeOverride>;
}
