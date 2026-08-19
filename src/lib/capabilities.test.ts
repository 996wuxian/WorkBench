import { describe, expect, it } from "vitest";

import {
  capabilityDescriptors,
  protocolLabel,
  runtimeCapabilitySummary,
} from "./capabilities";
import type { RuntimeInfo } from "./types";

const runtime: RuntimeInfo = {
  id: "sample",
  displayName: "Sample",
  enabled: true,
  capabilities: {
    streaming: true,
    thoughts: false,
    tools: true,
    permissionGate: false,
    sessionResume: true,
    multiTurn: true,
    modelsList: false,
    reasoningEffort: false,
    planMode: false,
    slashCommands: false,
    imagesIn: false,
    imagesOut: false,
    protocol: "acp",
  },
  permissionModes: ["ask"],
  defaultPermissionMode: "ask",
};

describe("runtime capabilities", () => {
  it("builds enabled and disabled descriptors with reasons", () => {
    const descriptors = capabilityDescriptors(runtime.capabilities, [
      "streaming",
      "permissionGate",
    ]);

    expect(descriptors).toMatchObject([
      { key: "streaming", label: "流式输出", enabled: true },
      {
        key: "permissionGate",
        label: "Host 权限",
        enabled: false,
        unavailableReason: "该 runtime 不支持 Host 侧权限闸",
      },
    ]);
  });

  it("summarizes the core capability matrix", () => {
    expect(runtimeCapabilitySummary(runtime)).toBe("4/10");
  });

  it("formats known protocols but preserves unknown manifest values", () => {
    expect(protocolLabel("acp")).toBe("ACP");
    expect(protocolLabel("custom_wire")).toBe("custom_wire");
  });
});
