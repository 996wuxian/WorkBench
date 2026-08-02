import { describe, expect, it } from "vitest";

import {
  diffWorktreeSnapshots,
  insertOrUpdateWorktreeChangeBlock,
  mergeWorktreeChanges,
  splitWorktreeChangeMarkers,
  stripWorktreeChangeMarkers,
  worktreeChangeMarker,
  worktreeChangeTotals,
} from "./worktreeChanges";

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

  it("keeps hunk previews from the current snapshot", () => {
    const changes = diffWorktreeSnapshots(
      {
        projectPath: "X:/repo",
        files: [{ path: "AGENTS.md", additions: 0, deletions: 0 }],
      },
      {
        projectPath: "X:/repo",
        files: [
          {
            path: "AGENTS.md",
            additions: 1,
            deletions: 1,
            hunks: [
              {
                oldStart: 10,
                newStart: 10,
                lines: [
                  { kind: "delete", oldLine: 11, content: "old" },
                  { kind: "add", newLine: 11, content: "new" },
                ],
              },
            ],
          },
        ],
      },
    );

    expect(changes).toStrictEqual([
      {
        path: "AGENTS.md",
        additions: 1,
        deletions: 1,
        hunks: [
          {
            oldStart: 10,
            newStart: 10,
            lines: [
              { kind: "delete", oldLine: 11, content: "old" },
              { kind: "add", newLine: 11, content: "new" },
            ],
          },
        ],
      },
    ]);
  });

  it("merges streamed file changes without dropping earlier files", () => {
    const changes = mergeWorktreeChanges(
      [
        {
          path: "src/a.ts",
          additions: 1,
          deletions: 0,
          hunks: [
            {
              newStart: 1,
              lines: [{ kind: "add", newLine: 1, content: "old a" }],
            },
          ],
        },
      ],
      [
        {
          path: "src/b.ts",
          additions: 2,
          deletions: 0,
          hunks: [
            {
              newStart: 1,
              lines: [{ kind: "add", newLine: 1, content: "b" }],
            },
          ],
        },
        {
          path: "src/a.ts",
          additions: 3,
          deletions: 1,
          hunks: [
            {
              oldStart: 1,
              newStart: 1,
              lines: [{ kind: "add", newLine: 1, content: "new a" }],
            },
          ],
        },
      ],
    );

    expect(changes.map((file) => file.path)).toStrictEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(changes[0].additions).toBe(3);
    expect(changes[0].deletions).toBe(1);
    expect(changes[0].hunks?.[0]?.lines[0].content).toBe("new a");
    expect(changes[1].additions).toBe(2);
  });

  it("splits and strips inline file change markers", () => {
    const marker = worktreeChangeMarker("abc");
    expect(splitWorktreeChangeMarkers(`before ${marker} after`)).toStrictEqual([
      { kind: "text", text: "before " },
      { kind: "marker", id: "abc" },
      { kind: "text", text: " after" },
    ]);
    expect(stripWorktreeChangeMarkers(`before\n\n${marker}\n\nafter`)).toBe(
      "before\n\nafter",
    );
  });

  it("inserts a new block only after assistant text continued", () => {
    const first = insertOrUpdateWorktreeChangeBlock(
      {
        id: "a1",
        role: "assistant",
        content: "逻辑已改。",
      },
      "chg1",
      [{ path: "src/a.ts", additions: 1, deletions: 0 }],
    );
    const updated = insertOrUpdateWorktreeChangeBlock(first, "chg2", [
      { path: "src/a.ts", additions: 2, deletions: 0 },
    ]);
    expect(updated.worktreeChangeBlocks).toHaveLength(1);
    expect(updated.worktreeChangeBlocks?.[0].files[0].additions).toBe(2);

    const continued = { ...updated, content: `${updated.content}继续补测试。` };
    const second = insertOrUpdateWorktreeChangeBlock(continued, "chg3", [
      { path: "src/b.ts", additions: 1, deletions: 1 },
    ]);
    expect(second.worktreeChangeBlocks).toHaveLength(2);
    expect(second.content).toContain(worktreeChangeMarker("chg1"));
    expect(second.content).toContain(worktreeChangeMarker("chg3"));
  });
});
