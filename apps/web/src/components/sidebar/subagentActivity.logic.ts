import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

import {
  ownWorkingSubagentCount,
  withWorkingSubagents,
  workingSubagentCountsByThread as sharedWorkingSubagentCountsByThread,
} from "@t3tools/client-runtime/state/subagent-activity";

type SubagentActivityShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "status" | "activityRunStatus" | "pendingBackgroundTasks"
>;

// Older servers omit activityRunStatus, so fall back to the latest run's status.
const isRunLive = (thread: SubagentActivityShell) =>
  thread.activityRunStatus !== undefined
    ? thread.activityRunStatus !== null
    : thread.status === "preparing" ||
      thread.status === "queued" ||
      thread.status === "starting" ||
      thread.status === "running";

export function workingSubagentCountsByThread(
  threads: ReadonlyArray<SubagentActivityShell>,
): ReadonlyMap<ThreadId, number> {
  return sharedWorkingSubagentCountsByThread(threads, isRunLive);
}

export { ownWorkingSubagentCount, withWorkingSubagents };
