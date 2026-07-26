/** P0 runtimes. Claude/Kimi reserved in registry for later. */
export type RuntimeId = "grok" | "codex" | "claude" | "kimi";

export type SessionState =
  | "idle"
  | "connecting"
  | "ready"
  | "streaming"
  | "awaiting_permission"
  | "disconnected";

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
  codexConfigPath?: string | null;
  modelProvider?: string | null;
  model?: string | null;
  modelReasoningEffort?: string | null;
  baseUrl?: string | null;
  wireApi?: string | null;
  ccSwitchDir?: string | null;
  ccSwitchDbPath?: string | null;
  ccSwitchLogPath?: string | null;
  latestForwardUrl?: string | null;
  latestForwardModel?: string | null;
  latestError?: string | null;
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

export interface SessionSnapshot {
  sessionId?: string | null;
  runtimeId?: RuntimeId | null;
  state: SessionState;
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
  toolName?: string | null;
  toolTitle?: string | null;
  toolStatus?: string | null;
  /** True while assistant stream is still open */
  streaming?: boolean;
  /** True before first assistant content arrives */
  pending?: boolean;
}

export const P0_RUNTIMES: RuntimeId[] = ["grok", "codex"];

export const RUNTIME_LABEL: Record<RuntimeId, string> = {
  grok: "Grok Build",
  codex: "Codex",
  claude: "Claude Code",
  kimi: "Kimi",
};
