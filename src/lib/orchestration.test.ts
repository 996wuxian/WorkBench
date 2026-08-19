import { describe, expect, it } from "vitest";

import {
  buildWorkflowNodePrompt,
  canRunFixedWorkflow,
  createOrchestrationTask,
  deriveTaskStatus,
  extractLastAssistantText,
  fixedWorkflowNodes,
  updateWorkflowNode,
  type WorkflowStepOutput,
} from "./orchestration";
import type { ChatMessage } from "./types";

describe("orchestration workflow helpers", () => {
  it("creates the fixed implement-review-fix workflow", () => {
    const task = createOrchestrationTask(1);

    expect(canRunFixedWorkflow(task)).toBe(true);
    expect(fixedWorkflowNodes(task).map((node) => node.id)).toStrictEqual([
      "implement",
      "review",
      "fix",
    ]);
    expect(task.edges).toMatchObject([
      { from: "implement", to: "review" },
      { from: "review", to: "fix" },
    ]);
  });

  it("builds the first workflow prompt from the node prompt only", () => {
    const task = createOrchestrationTask(1);
    const [implement] = fixedWorkflowNodes(task);

    expect(buildWorkflowNodePrompt(task, implement, [])).toBe(implement.prompt);
  });

  it("injects upstream outputs into later workflow prompts", () => {
    const task = createOrchestrationTask(1);
    const [implement, review] = fixedWorkflowNodes(task);
    const upstream: WorkflowStepOutput[] = [
      {
        node: implement,
        session: { id: "session-1", runtimeId: "codex", title: "Codex" },
        output: "Implemented feature and ran pnpm typecheck.",
      },
    ];

    const prompt = buildWorkflowNodePrompt(task, review, upstream);

    expect(prompt).toContain("Review");
    expect(prompt).toContain("Session: session-1");
    expect(prompt).toContain("Implemented feature and ran pnpm typecheck.");
  });

  it("extracts the last non-empty assistant message", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "request" },
      { id: "a1", role: "assistant", content: "first" },
      { id: "t1", role: "tool", content: "" },
      { id: "a2", role: "assistant", content: "  final answer  " },
    ];

    expect(extractLastAssistantText(messages)).toBe("final answer");
  });

  it("derives task status from node execution states", () => {
    expect(deriveTaskStatus([{ status: "running" }, { status: "failed" }])).toBe(
      "running",
    );
    expect(deriveTaskStatus([{ status: "done" }, { status: "done" }])).toBe(
      "done",
    );
    expect(deriveTaskStatus([{ status: "failed" }, { status: "blocked" }])).toBe(
      "failed",
    );
  });

  it("updates one node without mutating the source task", () => {
    const task = createOrchestrationTask(1);
    const updated = updateWorkflowNode(task, "implement", {
      status: "done",
      sessionId: "session-1",
    });

    expect(task.nodes.find((node) => node.id === "implement")?.status).toBe(
      "ready",
    );
    expect(updated.nodes.find((node) => node.id === "implement")).toMatchObject({
      status: "done",
      sessionId: "session-1",
    });
  });
});
