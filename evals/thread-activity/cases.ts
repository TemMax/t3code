import { NodeId, RunId, TurnItemId } from "@t3tools/contracts";
import {
  buildActivityDigest,
  emptyActivityBuffer,
} from "../../apps/server/src/orchestration-v2/ThreadActivityBuffer.ts";
import type { Expectation } from "./grade.ts";

export interface Case extends Expectation {
  readonly id: string;
  readonly source: string;
  readonly digest: string;
}

const digest = (input: {
  readonly request?: string;
  readonly todo?: string;
  readonly subagents?: ReadonlyArray<string>;
  readonly tools?: ReadonlyArray<string>;
  readonly tail?: string;
}) =>
  buildActivityDigest(
    {
      ...emptyActivityBuffer(RunId.make("run-eval"), 0),
      todoStep: input.todo ?? null,
      subagents: (input.subagents ?? []).map((label, index) => ({
        id: NodeId.make(`subagent-${index}`),
        label,
      })),
      toolLines: (input.tools ?? []).map((line, index) => ({
        itemId: TurnItemId.make(`item-${index}`),
        line,
      })),
      assistantTail: input.tail ?? "",
    },
    input.request ?? null,
  );

export const cases: ReadonlyArray<Case> = [
  {
    id: "researching-first-search",
    source: "synthetic: first signal of a run",
    phase: "researching",
    keywords: ["auth", "session", "login", "token", "code"],
    digest: digest({
      request: "How does session auth work in this repo? I need to add token refresh.",
      tools: ["search files: session"],
    }),
  },
  {
    id: "researching-subagents",
    source: "synthetic: exploration subagents",
    phase: "researching",
    keywords: ["billing", "invoice", "payment", "codebase", "code"],
    digest: digest({
      request: "Map out how invoices are generated before we touch billing.",
      subagents: ["Explore the invoice generation code", "Find billing webhook handlers"],
      tools: ["search files: invoice", "$ rg -n webhook src/billing", "search files: *.ts"],
    }),
  },
  {
    id: "planning-todo-only",
    source: "synthetic: plan without edits",
    phase: "planning",
    keywords: ["plan", "migration", "database", "schema", "rollout"],
    digest: digest({
      request: "Plan the migration from the old schema to the new orders tables.",
      todo: "Draft the migration plan and rollout steps",
      tools: ["$ rg -n orders src/db"],
      tail: "I will outline the migration in phases: add tables, backfill, switch reads, drop old columns.",
    }),
  },
  {
    id: "planning-after-reading",
    source: "synthetic: boundary with researching",
    phase: "planning",
    keywords: ["plan", "refactor", "settings", "approach", "design"],
    digest: digest({
      request: "Figure out how to split the settings panel into sections.",
      todo: "Write an implementation plan for the settings refactor",
      tools: [
        "$ cat src/settings/Panel.tsx",
        "$ rg -n SettingsPanel src",
        "search files: Settings*",
      ],
      tail: "I have read the panel and its callers. Here is the plan I propose: 1. extract sections 2. move state 3. update routes.",
    }),
  },
  {
    id: "implementing-edits",
    source: "synthetic: steady editing",
    phase: "implementing",
    keywords: ["pagination", "list", "api", "endpoint", "cursor"],
    digest: digest({
      request: "Add cursor pagination to the list endpoint.",
      todo: "Add cursor pagination to the list endpoint",
      tools: [
        "edit src/api/list.ts",
        "edit src/api/cursor.ts",
        "edit src/api/list.types.ts",
        "edit src/api/index.ts",
      ],
      tail: "Wiring the cursor into the handler now.",
    }),
  },
  {
    id: "implementing-tests-written",
    source: "synthetic: editing test files is still implementing",
    phase: "implementing",
    keywords: ["retry", "backoff", "client", "http", "request"],
    digest: digest({
      request: "Add retry with backoff to the http client.",
      tools: ["edit src/http/retry.ts", "edit src/http/client.ts", "edit src/http/retry.test.ts"],
    }),
  },
  {
    id: "testing-running-suite",
    source: "synthetic: plain test run",
    phase: "testing",
    keywords: ["test", "suite", "verification", "checks", "export", "csv"],
    digest: digest({
      request: "Add CSV export to the reports page.",
      tools: ["edit src/reports/export.ts", "$ pnpm test reports", "$ pnpm typecheck"],
      tail: "Implementation is done. Running the checks.",
    }),
  },
  {
    id: "testing-todo-beats-edits",
    source: "synthetic: running todo step says testing while the last tools were edits",
    phase: "testing",
    keywords: ["test", "suite", "verification", "checks"],
    digest: digest({
      request: "Rename the Workspace type to Project across the app.",
      todo: "Run the test suite",
      tools: [
        "edit src/workspace/types.ts",
        "edit src/workspace/store.ts",
        "edit src/ui/WorkspaceList.tsx",
        "edit src/ui/WorkspaceHeader.tsx",
      ],
      tail: "All renames are in.",
    }),
  },
  {
    id: "debugging-failing-test",
    source: "synthetic: failure investigation",
    phase: "debugging",
    keywords: ["fail", "failing", "test", "bug", "error", "timeout", "debug"],
    digest: digest({
      request: "Add a debounce to the search box.",
      tools: [
        "$ pnpm test search",
        "$ pnpm test search -t debounce --reporter verbose",
        "$ rg -n setTimeout src/search",
      ],
      tail: "The debounce test fails with a timeout. The timer is never cleared, so I am tracing where it is created.",
    }),
  },
  {
    id: "debugging-reproduce-crash",
    source: "synthetic: reproducing a bug",
    phase: "debugging",
    keywords: ["crash", "bug", "error", "null", "startup", "repro", "debug", "fail"],
    digest: digest({
      request: "The app crashes on startup when the config file is missing. Fix it.",
      tools: ["$ node bin.js", "$ cat logs/crash.log", "search files: loadConfig"],
      tail: "I reproduced the crash: loadConfig returns null and the caller dereferences it.",
    }),
  },
  {
    id: "testing-after-failure-fixed",
    source: "synthetic: boundary with debugging, rerun after a fix",
    phase: "testing",
    keywords: ["test", "suite", "verification", "checks", "rerun"],
    digest: digest({
      request: "Fix the flaky upload test.",
      todo: "Re-run the upload tests to confirm the fix",
      tools: ["edit src/upload/queue.ts", "$ pnpm test upload"],
      tail: "The race is fixed. Confirming with a full run of the upload tests.",
    }),
  },
  {
    id: "debugging-edits-while-failing",
    source: "synthetic: boundary with testing, edits answering a red run",
    phase: "debugging",
    keywords: ["fail", "failing", "test", "bug", "error", "debug", "regression", "snapshot"],
    digest: digest({
      request: "Upgrade the date library.",
      tools: [
        "$ pnpm test",
        "edit src/format/date.ts",
        "$ pnpm test format",
        "edit src/format/date.ts",
      ],
      tail: "Two snapshot tests still fail after the upgrade. The format output changed, so I am working out why.",
    }),
  },
  {
    id: "reviewing-diff",
    source: "synthetic: reading a diff",
    phase: "reviewing",
    keywords: ["review", "diff", "changes", "pr", "pull", "auth", "middleware"],
    digest: digest({
      request: "Review my changes to the auth middleware before I open a PR.",
      tools: ["$ git diff main...HEAD", "$ git log --oneline main..HEAD", "$ git diff --stat"],
      tail: "Going through the diff file by file looking for regressions.",
    }),
  },
  {
    id: "reviewing-final-self-check",
    source: "synthetic: final self-check",
    phase: "reviewing",
    keywords: ["review", "diff", "changes", "check", "final", "self"],
    digest: digest({
      request: "Add a dark mode toggle.",
      todo: "Review the full diff before finishing",
      tools: ["$ pnpm test", "$ git diff", "$ git status --short"],
      tail: "Tests pass. Doing a last read of everything I changed.",
    }),
  },
  {
    id: "researching-vs-planning-reading-only",
    source: "synthetic: boundary, reading with no plan yet",
    phase: "researching",
    keywords: ["queue", "worker", "job", "code", "codebase", "scheduler"],
    digest: digest({
      request: "I want to understand how background jobs get scheduled.",
      tools: ["search files: scheduler", "$ cat src/jobs/scheduler.ts", "$ cat src/jobs/worker.ts"],
      tail: "Reading how the scheduler hands jobs to workers.",
    }),
  },
  {
    id: "empty-subject",
    source: "synthetic: nothing to name, the answer must still be schema valid",
    phase: null,
    keywords: [],
    digest: digest({}),
  },
];
