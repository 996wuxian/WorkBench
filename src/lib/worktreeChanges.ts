import type {
  ChatMessage,
  WorktreeChangeBlock,
  WorktreeChangeSnapshot,
  WorktreeChangeStat,
} from "./types";

const WORKTREE_CHANGE_MARKER_PREFIX = "workbench-file-change:";

export type WorktreeChangeContentPart =
  | { kind: "text"; text: string }
  | { kind: "marker"; id: string };

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
        ...(file.fullPath ? { fullPath: file.fullPath } : {}),
        additions: Math.max(0, file.additions - (old?.additions ?? 0)),
        deletions: Math.max(0, file.deletions - (old?.deletions ?? 0)),
        ...(file.hunks?.length ? { hunks: file.hunks } : {}),
        ...(file.truncated ? { truncated: true } : {}),
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

export function mergeWorktreeChanges(
  current: WorktreeChangeStat[] | undefined,
  incoming: WorktreeChangeStat[],
): WorktreeChangeStat[] {
  if (!current?.length) return incoming;
  if (incoming.length === 0) return current;

  const merged = [...current];
  const indexByPath = new Map(
    merged.map((file, index) => [statKey(file.fullPath ?? file.path), index]),
  );

  for (const file of incoming) {
    const key = statKey(file.fullPath ?? file.path);
    const index = indexByPath.get(key);
    if (index == null) {
      indexByPath.set(key, merged.length);
      merged.push(file);
      continue;
    }
    merged[index] = file;
  }

  return merged;
}

export function worktreeChangeMarker(id: string): string {
  return `[[${WORKTREE_CHANGE_MARKER_PREFIX}${id}]]`;
}

export function splitWorktreeChangeMarkers(
  content: string,
): WorktreeChangeContentPart[] {
  const parts: WorktreeChangeContentPart[] = [];
  const pattern = /\[\[workbench-file-change:([^\]]+)\]\]/g;
  let cursor = 0;

  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push({ kind: "text", text: content.slice(cursor, index) });
    }
    parts.push({ kind: "marker", id: match[1] });
    cursor = index + match[0].length;
  }

  if (cursor < content.length) {
    parts.push({ kind: "text", text: content.slice(cursor) });
  }
  return parts.length ? parts : [{ kind: "text", text: content }];
}

export function stripWorktreeChangeMarkers(content: string): string {
  return content.replace(/\s*\[\[workbench-file-change:[^\]]+\]\]\s*/g, "\n\n").trim();
}

export function insertOrUpdateWorktreeChangeBlock(
  message: ChatMessage,
  blockId: string,
  files: WorktreeChangeStat[],
): ChatMessage {
  const blocks = message.worktreeChangeBlocks ?? [];
  const latestBlock = blocks.at(-1);
  if (latestBlock) {
    const marker = worktreeChangeMarker(latestBlock.id);
    const markerIndex = message.content.lastIndexOf(marker);
    const textAfterMarker =
      markerIndex >= 0
        ? message.content.slice(markerIndex + marker.length).trim()
        : "";
    if (markerIndex >= 0 && textAfterMarker.length === 0) {
      return {
        ...message,
        worktreeChangeBlocks: [
          ...blocks.slice(0, -1),
          {
            ...latestBlock,
            files: mergeWorktreeChanges(latestBlock.files, files),
          },
        ],
        worktreeChangeStats: mergeWorktreeChanges(
          message.worktreeChangeStats,
          files,
        ),
      };
    }
  }

  const marker = worktreeChangeMarker(blockId);
  const content = message.content.trim().length === 0
    ? `${marker}\n\n`
    : message.content.endsWith("\n")
    ? `${message.content}${marker}\n\n`
    : `${message.content}\n\n${marker}\n\n`;
  const nextBlock: WorktreeChangeBlock = { id: blockId, files };
  return {
    ...message,
    content,
    worktreeChangeBlocks: [...blocks, nextBlock],
    worktreeChangeStats: mergeWorktreeChanges(message.worktreeChangeStats, files),
  };
}
