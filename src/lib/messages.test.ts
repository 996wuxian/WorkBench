import { describe, expect, it } from "vitest";

import {
  assistantElapsedLabel,
  finalizeStreamingMessage,
  isPermissionResolutionNotice,
  normalizeLoadedMessages,
  restoreSessionMessages,
  toolMessageLabel,
} from "./messages";
import type { ChatMessage, SessionSnapshot } from "./types";

const streamingSnapshot: SessionSnapshot = {
  sessionId: "session-1",
  runtimeId: "codex",
  state: "streaming",
  promptStartedAt: "2026-07-29T00:00:00.000Z",
  backend: "codex_app_server",
  title: "Codex",
};

describe("finalizeStreamingMessage", () => {
  it("finishes assistant messages with a completion timestamp", () => {
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "done",
      streaming: true,
      pending: true,
      createdAt: "2026-07-29T00:00:00.000Z",
    };

    const result = finalizeStreamingMessage(message);

    expect(result.streaming).toEqual(false);
    expect(result.pending).toEqual(false);
    expect(result.completedAt).toBeTruthy();
  });

  it("clears the streaming flag from thought messages", () => {
    const message: ChatMessage = {
      id: "thought-1",
      role: "thought",
      content: "reasoning",
      streaming: true,
    };

    expect(finalizeStreamingMessage(message)).toStrictEqual({
      ...message,
      streaming: false,
      pending: false,
    });
  });
});

describe("permission resolution notices", () => {
  it("recognizes Host permission resolution system notices", () => {
    expect(
      isPermissionResolutionNotice({
        role: "system",
        content:
          "权限请求「工具调用」已由 本会话已记住的授权 处理为 允许。",
      }),
    ).toBe(true);
  });

  it("does not treat other system messages as permission notices", () => {
    expect(
      isPermissionResolutionNotice({
        role: "system",
        content: "Agent 进程已退出。下次发送会自动重连。",
      }),
    ).toBe(false);
  });
});

describe("tool message labels", () => {
  it("compacts long PowerShell write commands", () => {
    const label = toolMessageLabel({
      id: "tool-1",
      role: "tool",
      content: "",
      toolName: "command",
      toolTitle:
        "C:\\Program Files\\PowerShell\\pwsh.exe -Command \"@'\\n<html>very long generated html</html>\\n'@ | Set-Content -LiteralPath 'X:\\test\\neon-voyage.html' -Encoding UTF8\"",
      toolStatus: "completed",
    });

    expect(label).toBe("PowerShell · write X:\\test\\neon-voyage.html · completed");
  });
});

describe("live session restoration", () => {
  it("keeps the in-memory stream when revisiting a session", () => {
    const cached: ChatMessage[] = [
      {
        id: "assistant-live",
        role: "assistant",
        content: "still running",
        createdAt: "2026-07-29T00:00:00.000Z",
        streaming: true,
      },
    ];
    const stored: ChatMessage[] = [
      {
        id: "assistant-checkpoint",
        role: "assistant",
        content: "older checkpoint",
        createdAt: "2026-07-29T00:00:00.000Z",
        partial: true,
      },
    ];

    const restored = restoreSessionMessages(cached, stored, streamingSnapshot);

    expect(restored).not.toBe(cached);
    expect(restored[0]).toMatchObject({
      content: "still running",
      streaming: true,
      revealImmediately: true,
    });
    expect(
      assistantElapsedLabel(restored[0], Date.parse("2026-07-29T00:01:05.000Z")),
    ).toEqual("耗时 1m 5.00s");
  });

  it("reconstructs an open stream from the Host snapshot", () => {
    const restored = normalizeLoadedMessages(
      [
        {
          id: "user-1",
          role: "user",
          content: "tell a story",
        },
        {
          id: "assistant-checkpoint",
          role: "assistant",
          content: "chapter one",
          partial: true,
          createdAt: "2026-07-29T00:00:00.000Z",
        },
      ],
      streamingSnapshot,
    );

    expect(restored.at(-1)).toMatchObject({
      id: "assistant-checkpoint",
      partial: false,
      streaming: true,
      pending: false,
      createdAt: "2026-07-29T00:00:00.000Z",
    });
  });

  it("clears stale streaming flags from completed messages", () => {
    const restored = normalizeLoadedMessages([
      {
        id: "assistant-done",
        role: "assistant",
        content: "finished",
        streaming: true,
        pending: true,
        completedAt: "2026-07-29T00:02:00.000Z",
        createdAt: "2026-07-29T00:00:00.000Z",
      },
    ]);

    expect(restored[0]).toMatchObject({
      streaming: false,
      pending: false,
      completedAt: "2026-07-29T00:02:00.000Z",
    });
  });
});
