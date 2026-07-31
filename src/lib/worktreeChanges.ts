import type { WorktreeChangeSnapshot, WorktreeChangeStat } from "./types";

function statKey(path: string): string {
  return path.replace(/\\/g, "/");
}

export function diffWorktreeSnapshots(
  before: WorktreeChangeSnapshot,
  after: WorktreeChangeSnapshot,
): WorktreeChangeStat[] {
  const previous = new Map(
    before.files.map((file) => [statKey(file.path), file]),
  );

  return after.files
    .map((file) => {
      const old = previous.get(statKey(file.path));
      return {
        path: file.path,
        additions: Math.max(0, file.additions - (old?.additions ?? 0)),
        deletions: Math.max(0, file.deletions - (old?.deletions ?? 0)),
      };
    })
    .filter((file) => file.additions > 0 || file.deletions > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function worktreeChangeTotals(files: WorktreeChangeStat[]) {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}
