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
      id: "claude",
      displayName: "Claude Code",
      enabled: true,
      capabilities: {
        ...capabilities,
        permissionGate: true,
        sessionResume: true,
        protocol: "claude_code",
      },
      permissionModes: ["ask", "auto", "read_only", "full_access"],
      defaultPermissionMode: "ask",
      notes: "使用本机 Claude Code CLI 的 headless stream-json 模式。",
    },
    {
      id: "codex",
      displayName: "Codex",
      enabled: true,
      capabilities,
      permissionModes: ["ask", "auto", "read_only", "full_access"],
      defaultPermissionMode: "ask",
    },
    {
      id: "kimi",
      displayName: "Kimi Code",
      enabled: true,
      capabilities,
      permissionModes: ["ask", "auto"],
      defaultPermissionMode: "ask",
      notes: "未在浏览器 mock 中连接真实 CLI。",
    },
    {
      id: "grok",
      displayName: "Grok Build",
      enabled: true,
      capabilities,
      permissionModes: ["ask", "auto"],
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
      pinned: false,
      archived: false,
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
      pinned: false,
      archived: false,
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
