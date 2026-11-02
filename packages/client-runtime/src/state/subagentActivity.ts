import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";

const EMPTY_COUNTS: ReadonlyMap<ThreadId, number> = new Map();

type SubagentActivityThread = {
  readonly id: ThreadId;
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly pendingBackgroundTasks?:
    | OrchestrationV2ThreadShell["pendingBackgroundTasks"]
    | undefined;
};

/**
 * Subagents working for each thread: provider-native background subagents the
 * parent's settled turn left running, plus delegated children with a live run.
 * Native children have no runs, so they only count through the parent's tasks.
 */
export function workingSubagentCountsByThread<T extends SubagentActivityThread>(
  threads: ReadonlyArray<T>,
  isRunLive: (thread: T) => boolean,
): ReadonlyMap<ThreadId, number> {
  let byParent: Map<ThreadId, Set<string>> | undefined;
  const add = (parentId: ThreadId, subagentKey: string) => {
    byParent ??= new Map();
    const keys = byParent.get(parentId);
    if (keys) keys.add(subagentKey);
    else byParent.set(parentId, new Set([subagentKey]));
  };
  for (const thread of threads) {
    for (const task of thread.pendingBackgroundTasks ?? []) {
      if (task.kind !== "subagent") continue;
      add(thread.id, task.childThreadId ?? `task:${task.taskId}`);
    }
    const parentId = thread.lineage.parentThreadId;
    if (
      parentId !== null &&
      thread.lineage.relationshipToParent === "subagent" &&
      thread.lineage.sideChat !== true &&
      isRunLive(thread)
    ) {
      add(parentId, thread.id);
    }
  }
  if (byParent === undefined) return EMPTY_COUNTS;
  return new Map([...byParent].map(([parentId, keys]) => [parentId, keys.size] as const));
}

/** A thread only waiting on its subagents reads as working; anything needing the user wins. */
export function withWorkingSubagents<S extends string>(
  status: S,
  subagentCount: number,
): S | "working" {
  return subagentCount > 0 && (status === "waiting" || status === "ready") ? "working" : status;
}

/**
 * What a thread's own shell says about subagents working for it, for callers without the
 * environment's thread list: subagents of its live run or left in the background, or a wait
 * on delegated threads.
 */
export function ownWorkingSubagentCount(thread: {
  readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask> | undefined;
  readonly runningSubagentCount?: number | undefined;
  readonly blockedOnThreadWait?: boolean | undefined;
}): number {
  const background = (thread.pendingBackgroundTasks ?? []).filter(
    (task) => task.kind === "subagent",
  ).length;
  const count = Math.max(background, thread.runningSubagentCount ?? 0);
  return count > 0 ? count : thread.blockedOnThreadWait === true ? 1 : 0;
}
