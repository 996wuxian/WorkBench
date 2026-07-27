/**
 * Browser-only fixtures so `pnpm dev:ui` renders without a Tauri host.
 * Never reached in the packaged app — `isTauri` gates every call site.
 */
import { nowIso } from "./format";
import type { RuntimeCapabilities, RuntimeInfo, SessionMeta } from "./types";

export function mockRuntimes(): RuntimeInfo[] {
  const capabilities: RuntimeCapabilities = {
    streaming: true,
    thoughts: true,
    tools: true,
    permissionGate: true,
    sessionResume: true,
    multiTurn: true,
    modelsList: false,
    reasoningEffort: false,
    planMode: false,
    slashCommands: false,
    imagesIn: false,
    imagesOut: false,
    protocol: "browser-mock",
  };
  return [
    {
      id: "grok",
      displayName: "Grok Build",
      enabled: true,
      capabilities,
      permissionModes: ["ask", "auto"],
      defaultPermissionMode: "ask",
    },
    {
      id: "codex",
      displayName: "Codex",
      enabled: true,
      capabilities,
      permissionModes: ["ask", "auto", "read_only", "full_access"],
      defaultPermissionMode: "ask",
    },
  ];
}

export function mockSessions(): SessionMeta[] {
  const t = nowIso();
  return [
    {
      id: "sess_demo_grok",
      title: "Grok · 示例会话",
      runtimeId: "grok",
      projectPath: "X:\\1_2026_project\\work",
      modelId: "grok-4.5",
      permissionMode: "auto",
      createdAt: t,
      updatedAt: t,
    },
    {
      id: "sess_demo_codex",
      title: "Codex · 示例会话",
      runtimeId: "codex",
      projectPath: "X:\\1_2026_project\\work",
      modelId: "default",
      modelReasoningEffort: "high",
      permissionMode: "ask",
      createdAt: t,
      updatedAt: t,
    },
  ];
}
