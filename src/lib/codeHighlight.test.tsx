import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import { isCodeLikePath, renderHighlightedCode } from "./codeHighlight";

describe("codeHighlight", () => {
  it("detects common code file paths", () => {
    expect(isCodeLikePath("X:\\WorkBench\\src\\App.tsx")).toBe(true);
    expect(isCodeLikePath("src-tauri/Cargo.toml")).toBe(true);
    expect(isCodeLikePath("X:\\notes\\draft.txt")).toBe(false);
  });

  it("renders code tokens as themed spans", () => {
    const nodes = renderHighlightedCode("const amount = 35;");
    expect(nodes.some((node) => isValidElement(node))).toBe(true);
  });
});
