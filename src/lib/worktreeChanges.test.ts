import { describe, expect, it } from "vitest";

import { diffWorktreeSnapshots, worktreeChangeTotals } from "./worktreeChanges";

describe("worktree change snapshots", () => {
  it("returns net additions and deletions after the baseline", () => {
    const changes = diffWorktreeSnapshots(
      {
        projectPath: "X:/repo",
        files: [
          { path: "src/App.tsx", additions: 4, deletions: 1 },
          { path: "README.md", additions: 2, deletions: 0 },
        ],
      },
      {
        projectPath: "X:/repo",
        files: [
          { path: "src/App.tsx", additions: 9, deletions: 3 },
          { path: "README.md", additions: 2, deletions: 0 },
          { path: "src/new.ts", additions: 7, deletions: 0 },
        ],
      },
    );

    expect(changes).toStrictEqual([
      { path: "src/App.tsx", additions: 5, deletions: 2 },
      { path: "src/new.ts", additions: 7, deletions: 0 },
    ]);
    expect(worktreeChangeTotals(changes)).toStrictEqual({
      additions: 12,
      deletions: 2,
    });
  });

  it("does not report files that only shrink back toward the baseline", () => {
    expect(
      diffWorktreeSnapshots(
        {
          projectPath: "X:/repo",
          files: [{ path: "src/App.tsx", additions: 9, deletions: 3 }],
        },
        {
          projectPath: "X:/repo",
          files: [{ path: "src/App.tsx", additions: 5, deletions: 3 }],
        },
      ),
    ).toStrictEqual([]);
  });
});
