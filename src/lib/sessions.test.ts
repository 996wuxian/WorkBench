import { describe, expect, it } from "vitest";

import {
  mergeSessions,
  sessionProcessStats,
  sessionDisplayTitle,
  sessionStateLabel,
} from "./sessions";
import type { SessionMeta, SessionSnapshot } from "./types";

function session(
  id: string,
  updatedAt: string,
  patch: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    id,
    title: "Codex · 新会话",
    pinned: false,
    archived: false,
    runtimeId: "codex",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt,
    ...patch,
  };
}

function snapshot(state: SessionSnapshot["state"]): SessionSnapshot {
  return {
    sessionId: "active",
    runtimeId: "codex",
    state,
    backend: "codex_app_server",
    title: "Codex",
  };
}

describe("settled session metadata", () => {
  it("merges the settled metadata and moves the session to the top", () => {
    const older = session("older", "2026-07-29T01:00:00.000Z");
    const active = session("active", "2026-07-29T00:30:00.000Z");
    const settled = session("active", "2026-07-29T02:00:00.000Z", {
      nativeThreadId: "thread-1",
      summary: "Implement the settled turn event",
    });

    const result = mergeSessions([older, active], [settled]);

    expect(result.map((item) => item.id)).toStrictEqual(["active", "older"]);
    expect(result[0]).toMatchObject({
      nativeThreadId: "thread-1",
      summary: "Implement the settled turn event",
    });
  });

  it("uses the local prompt summary for a generic new-session title", () => {
    const meta = session("active", "2026-07-29T02:00:00.000Z", {
      summary: "Inspect the current project",
    });

    expect(sessionDisplayTitle(meta)).toEqual("Inspect the current project");
  });

  it("keeps pinned sessions ahead of newer unpinned sessions", () => {
    const pinned = session("pinned", "2026-07-29T00:30:00.000Z", {
      pinned: true,
    });
    const recent = session("recent", "2026-07-29T02:00:00.000Z");

    expect(mergeSessions([], [recent, pinned]).map((item) => item.id)).toStrictEqual([
      "pinned",
      "recent",
    ]);
  });
});

describe("session state labels", () => {
  it.each([
    ["connecting", "连接中"],
    ["ready", "就绪"],
    ["streaming", "生成中"],
    ["awaiting_permission", "等待授权"],
    ["idle", "未连接"],
  ] as const)("maps %s to %s", (state, label) => {
    expect(sessionStateLabel(snapshot(state))).toEqual(label);
  });

  it("distinguishes an abnormal disconnect", () => {
    expect(
      sessionStateLabel({
        ...snapshot("disconnected"),
        lastError: {
          code: "AGENT_CRASHED",
          message: "process exited",
        },
      }),
    ).toEqual("异常断开");
  });
});

describe("session process stats", () => {
  it("counts running turns and live processes independently", () => {
    const sessions = [
      session("connecting", "2026-07-29T00:00:00.000Z"),
      session("ready", "2026-07-29T00:00:00.000Z"),
      session("streaming", "2026-07-29T00:00:00.000Z"),
      session("permission", "2026-07-29T00:00:00.000Z"),
      session("disconnected", "2026-07-29T00:00:00.000Z"),
      session("idle", "2026-07-29T00:00:00.000Z"),
    ];
    const snapshots = Object.fromEntries(
      [
        ["connecting", "connecting"],
        ["ready", "ready"],
        ["streaming", "streaming"],
        ["permission", "awaiting_permission"],
        ["disconnected", "disconnected"],
      ].map(([id, state]) => [id, snapshot(state as SessionSnapshot["state"])]),
    );

    expect(sessionProcessStats(sessions, snapshots)).toStrictEqual({
      total: 6,
      running: 3,
      processes: 4,
    });
  });
});
