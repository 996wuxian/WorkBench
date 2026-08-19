import { describe, expect, it } from "vitest";

import {
  adjacentMessageNode,
  buildSessionMessageNodes,
  isSessionMessageNodeCandidate,
  pickActiveMessageNodeId,
  truncateMessageNodePreview,
} from "./sessionMessageNodes";
import type { ChatMessage } from "./types";

function message(
  value: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">,
): ChatMessage {
  return { content: "", ...value };
}

describe("session message nodes", () => {
  it("keeps user and visible assistant messages only", () => {
    const nodes = buildSessionMessageNodes([
      message({ id: "u1", role: "user", content: "First question" }),
      message({ id: "thought", role: "thought", content: "private reasoning" }),
      message({ id: "tool", role: "tool", content: "read file" }),
      message({ id: "a1", role: "assistant", content: "First answer" }),
      message({ id: "system", role: "system", content: "process exited" }),
    ]);

    expect(nodes.map((node) => node.id)).toEqual(["u1", "a1"]);
    expect(nodes.map((node) => node.messageIndex)).toEqual([0, 3]);
  });

  it("does not expose an empty assistant thinking shell", () => {
    const thinking = message({
      id: "a1",
      role: "assistant",
      content: "",
      pending: true,
      streaming: true,
    });

    expect(isSessionMessageNodeCandidate(thinking)).toBe(false);
    expect(buildSessionMessageNodes([thinking])).toEqual([]);
  });

  it("tracks pending and interrupted assistant states", () => {
    const nodes = buildSessionMessageNodes([
      message({
        id: "pending",
        role: "assistant",
        content: "partial answer",
        streaming: true,
      }),
      message({ id: "u2", role: "user", content: "next question" }),
      message({
        id: "interrupted",
        role: "assistant",
        content: "saved tail",
        partial: true,
      }),
    ]);

    expect(
      nodes
        .filter((node) => node.role === "assistant")
        .map((node) => node.status),
    ).toEqual(["pending", "interrupted"]);
  });

  it("collapses split assistant segments within one user turn", () => {
    const nodes = buildSessionMessageNodes([
      message({ id: "u1", role: "user", content: "inspect project" }),
      message({ id: "a1", role: "assistant", content: "I will check it." }),
      message({ id: "tool1", role: "tool", content: "list files" }),
      message({ id: "a2", role: "assistant", content: "Now I found the README." }),
      message({ id: "u2", role: "user", content: "continue" }),
      message({ id: "a3", role: "assistant", content: "Continuing." }),
    ]);

    expect(nodes.map((node) => node.id)).toEqual(["u1", "a1", "u2", "a3"]);
    expect(nodes.map((node) => node.messageIndex)).toEqual([0, 1, 4, 5]);
  });

  it("normalizes and truncates previews", () => {
    expect(truncateMessageNodePreview("  hello   world  ")).toBe("hello world");
    expect(truncateMessageNodePreview("x".repeat(90))).toHaveLength(72);
    expect(truncateMessageNodePreview("x".repeat(90)).endsWith("…")).toBe(true);
  });

  it("picks the reading node and steps through adjacent nodes", () => {
    const nodes = buildSessionMessageNodes([
      message({ id: "u1", role: "user", content: "one" }),
      message({ id: "a1", role: "assistant", content: "two" }),
      message({ id: "u2", role: "user", content: "three" }),
    ]);

    expect(
      pickActiveMessageNodeId(
        [
          { id: "u1", top: 0, bottom: 600 },
          { id: "a1", top: 180, bottom: 260 },
        ],
        220,
      ),
    ).toBe("a1");
    expect(adjacentMessageNode(nodes, "u1", 1)?.id).toBe("a1");
    expect(adjacentMessageNode(nodes, "u1", -1)).toBeNull();
    expect(adjacentMessageNode(nodes, null, -1)?.id).toBe("u2");
  });
});
