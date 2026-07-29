import { describe, expect, it } from "vitest";

import {
  clearPermissionRequests,
  enqueuePermissionRequest,
  resolvePermissionRequest,
  type PermissionQueue,
} from "./permissions";
import type { PermissionRequestEvent } from "./types";

function request(
  requestId: string,
  sessionId = "session-1",
): PermissionRequestEvent {
  return {
    sessionId,
    requestId,
    toolName: "commandExecution",
    title: "Run command",
    preview: "pnpm test",
    autoAllowed: false,
  };
}

describe("permission queue", () => {
  it("deduplicates requests by session and request id", () => {
    const first = request("request-1");
    const queued = enqueuePermissionRequest({}, first);

    expect(enqueuePermissionRequest(queued, first)).toBe(queued);
    expect(queued[first.sessionId]).toStrictEqual([first]);
  });

  it("resolves one request without dropping overlapping approvals", () => {
    const first = request("request-1");
    const second = request("request-2");
    const queue = enqueuePermissionRequest(
      enqueuePermissionRequest({}, first),
      second,
    );

    const result = resolvePermissionRequest(queue, first.sessionId, first.requestId);

    expect(result.resolved).toStrictEqual(first);
    expect(result.remainingCount).toEqual(1);
    expect(result.queue[first.sessionId]).toStrictEqual([second]);
  });

  it("removes the session key after the last request resolves", () => {
    const pending = request("request-1");
    const queue = enqueuePermissionRequest({}, pending);

    const result = resolvePermissionRequest(
      queue,
      pending.sessionId,
      pending.requestId,
    );

    expect(result.remainingCount).toEqual(0);
    expect(result.queue).toStrictEqual({});
  });

  it("clears only the exited session", () => {
    const queue: PermissionQueue = {
      "session-1": [request("request-1", "session-1")],
      "session-2": [request("request-2", "session-2")],
    };

    expect(clearPermissionRequests(queue, "session-1")).toStrictEqual({
      "session-2": queue["session-2"],
    });
  });
});
