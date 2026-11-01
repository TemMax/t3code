import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withWorkingSubagents, workingSubagentCountsByThread } from "./subagentActivity.logic";

const PARENT = ThreadId.make("parent");

function shell(
  id: string,
  overrides: Partial<Parameters<typeof workingSubagentCountsByThread>[0][number]> = {},
): Parameters<typeof workingSubagentCountsByThread>[0][number] {
  return {
    id: ThreadId.make(id),
    lineage: { rootThreadId: PARENT, parentThreadId: null, relationshipToParent: null },
    status: "completed",
    activityRunStatus: null,
    pendingBackgroundTasks: [],
    ...overrides,
  };
}

const child = (
  id: string,
  overrides: Partial<Parameters<typeof workingSubagentCountsByThread>[0][number]> = {},
) =>
  shell(id, {
    lineage: { rootThreadId: PARENT, parentThreadId: PARENT, relationshipToParent: "subagent" },
    ...overrides,
  });

describe("workingSubagentCountsByThread", () => {
  it.each([
    {
      name: "counts background subagents and skips other background work",
      threads: [
        shell("parent", {
          pendingBackgroundTasks: [
            { taskId: "a", kind: "subagent" },
            { taskId: "b", kind: "subagent" },
            { taskId: "c", kind: "command" },
          ],
        }),
      ],
      expected: 2,
    },
    {
      name: "counts delegated children with a live run",
      threads: [
        shell("parent", { status: "running", activityRunStatus: "running" }),
        child("live", { status: "running", activityRunStatus: "running" }),
        child("done"),
      ],
      expected: 1,
    },
    {
      name: "falls back to the run status when the server omits the activity run",
      threads: [
        shell("parent"),
        child("live", { status: "starting", activityRunStatus: undefined }),
      ],
      expected: 1,
    },
    {
      name: "counts a child once when it is also a background task",
      threads: [
        shell("parent", {
          pendingBackgroundTasks: [
            { taskId: "a", kind: "subagent", childThreadId: ThreadId.make("live") },
          ],
        }),
        child("live", { status: "running", activityRunStatus: "running" }),
      ],
      expected: 1,
    },
    {
      name: "ignores live side chats and forks",
      threads: [
        shell("parent"),
        child("side", {
          lineage: {
            rootThreadId: PARENT,
            parentThreadId: PARENT,
            relationshipToParent: "subagent",
            sideChat: true,
          },
          activityRunStatus: "running",
        }),
        child("fork", {
          lineage: { rootThreadId: PARENT, parentThreadId: PARENT, relationshipToParent: "fork" },
          activityRunStatus: "running",
        }),
      ],
      expected: 0,
    },
  ])("$name", ({ threads, expected }) => {
    expect(workingSubagentCountsByThread(threads).get(PARENT) ?? 0).toBe(expected);
  });
});

describe("withWorkingSubagents", () => {
  it.each([
    { status: "waiting", count: 2, expected: "working" },
    { status: "ready", count: 1, expected: "working" },
    { status: "waiting", count: 0, expected: "waiting" },
    { status: "approval", count: 3, expected: "approval" },
    { status: "input", count: 3, expected: "input" },
    { status: "failed", count: 3, expected: "failed" },
  ] as const)("$status with $count subagents is $expected", ({ status, count, expected }) => {
    expect(withWorkingSubagents(status, count)).toBe(expected);
  });
});
