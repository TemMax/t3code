import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Thread-list project folders. Folders follow `groups` order and threads keep their input order.
 * A project with no threads gets a folder only when `keepEmpty` says so. A thread whose project
 * is in no group has no folder and is left out.
 */
export function groupThreadsByProject<
  TGroup extends {
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: string;
    }>;
  },
  TThread extends { readonly environmentId: EnvironmentId; readonly projectId: string },
>(
  groups: readonly TGroup[],
  threads: readonly TThread[],
  keepEmpty: (group: TGroup) => boolean,
): Array<{ group: TGroup; threads: TThread[] }> {
  const folders = groups.map((group) => ({ group, threads: [] as TThread[] }));
  const folderByProject = new Map<string, (typeof folders)[number]>();
  for (const folder of folders) {
    for (const ref of folder.group.memberProjectRefs) {
      folderByProject.set(`${ref.environmentId}:${ref.projectId}`, folder);
    }
  }
  for (const thread of threads) {
    folderByProject.get(`${thread.environmentId}:${thread.projectId}`)?.threads.push(thread);
  }
  return folders.filter((folder) => folder.threads.length > 0 || keepEmpty(folder.group));
}

export type ProjectFolderDot = "attention" | "failed" | "unread" | "working";

/** A closed folder's dot: its most urgent hidden thread. Waiting threads stay quiet, like their rows. */
export function projectFolderDot(
  threads: ReadonlyArray<{ readonly status: string; readonly unread: boolean }>,
): ProjectFolderDot | null {
  const statuses = new Set(threads.map((thread) => thread.status));
  if (
    statuses.has("input") ||
    statuses.has("approval") ||
    statuses.has("request") ||
    statuses.has("limited")
  ) {
    return "attention";
  }
  if (statuses.has("failed")) return "failed";
  if (threads.some((thread) => thread.status === "ready" && thread.unread)) return "unread";
  if (statuses.has("working") || statuses.has("preparing")) return "working";
  return null;
}
