import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class GroupReportReactor extends Context.Service<
  GroupReportReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/GroupReportReactor") {}

const REPORT_CHARACTER_LIMIT = 2_000;
const STOPPED_RUN_STATUSES: ReadonlySet<string> = new Set(["waiting", "completed", "failed"]);
// A stopped or cancelled worker reports nothing, but it can be the last one a held report waited for.
const QUIET_RUN_STATUSES: ReadonlySet<string> = new Set([
  ...STOPPED_RUN_STATUSES,
  "cancelled",
  "interrupted",
]);
const BUSY_RUN_STATUSES = ["queued", "preparing", "starting", "running"] as const;

// A queue held after a failure waits for the user, so it neither keeps the worker busy nor goes unreported.
const isHeldQueuedRun = (run: {
  readonly status: string;
  readonly queueHeld?: boolean | undefined;
}) => run.status === "queued" && run.queueHeld === true;
const triggersReport = (event: OrchestrationV2DomainEvent) =>
  event.type === "run.updated" &&
  (QUIET_RUN_STATUSES.has(event.payload.status) || isHeldQueuedRun(event.payload));

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  // Two workers stopping together must not each send the same held reports.
  const leadLocks = yield* KeyedLock.make<ThreadId>();

  /** A worker's latest run when it has something to report, and whether the worker still works. */
  const readWorker = Effect.fnUntraced(function* (threadId: ThreadId) {
    const worker = yield* projections.getThreadRecords(
      threadId,
      ["runs", "runtimeRequests", "subagents", "providerThreads"],
      {
        // Failed runs too: behind a held queue the latest run is queued, not the failed one.
        runStatuses: [...BUSY_RUN_STATUSES, "failed"],
        includeLatestRun: true,
        runtimeRequestStatuses: ["pending"],
        omitSettledSubagents: true,
      },
    );
    const run = worker.runs
      .filter((candidate) => candidate.status !== "queued")
      .toSorted((a, b) => b.ordinal - a.ordinal)[0];
    let busy =
      worker.runs.some(
        (other) =>
          !isHeldQueuedRun(other) &&
          (BUSY_RUN_STATUSES as ReadonlyArray<string>).includes(other.status),
      ) ||
      worker.runtimeRequests.some((request) => request.status === "pending") ||
      // The turn ended but the agent waits on checks it started; its next turn reports.
      worker.providerThreads.some((thread) =>
        backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []),
      );
    if (!busy && worker.subagents.length > 0) {
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user"],
        monitorNotificationsOnly: true,
      });
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      busy = delegatedTaskProgress({ ...worker, runs, messages }).state !== "result_available";
    }
    const failed = run?.status === "failed";
    return {
      thread: worker.thread,
      busy,
      report:
        busy || run === undefined || !STOPPED_RUN_STATUSES.has(run.status)
          ? undefined
          : {
              run,
              failed,
              // A workspace-preparation retry reruns the same run id, so its new outcome needs its own key.
              key: `${threadId}:${run.id}:${failed ? "failed" : "finished"}`,
            },
    };
  });

  const reportGroup = Effect.fnUntraced(function* (leadId: ThreadId) {
    const lead = yield* projections.getThreadRecords(leadId, ["messages"], {
      messageRoles: ["user"],
      groupWorkerNotificationsOnly: true,
    });
    if (lead.thread.archivedAt !== null || lead.thread.deletedAt !== null) return;
    const reported = new Set<string>();
    // Reports sent before keys existed: a run that began before one was covered by it.
    const reportedBefore = new Map<ThreadId, number>();
    for (const message of lead.messages) {
      const source = message.notification?.source;
      if (source?.kind !== "group_worker") continue;
      if (source.reportKeys !== undefined) {
        for (const key of source.reportKeys) reported.add(key);
        continue;
      }
      const sentAt = DateTime.toEpochMillis(message.createdAt);
      for (const workerId of source.workerThreadIds) {
        reportedBefore.set(workerId, Math.max(reportedBefore.get(workerId) ?? 0, sentAt));
      }
    }
    const workers = yield* Effect.forEach(
      (yield* projections.listGroupMemberThreadIds(leadId)).toSorted(),
      readWorker,
    );
    const pending = workers.flatMap((worker) =>
      worker.report === undefined ||
      reported.has(worker.report.key) ||
      DateTime.toEpochMillis(worker.report.run.requestedAt) <=
        (reportedBefore.get(worker.thread.id) ?? -1)
        ? []
        : [{ thread: worker.thread, ...worker.report }],
    );
    const first = pending[0];
    // One report when the whole group has stopped. A failure, or a worker its lead asked to
    // hear from at once, does not wait for the others.
    if (
      first === undefined ||
      (workers.some((worker) => worker.busy) &&
        !pending.some((report) => report.failed || report.thread.groupReportNow === true))
    ) {
      return;
    }
    const sections = yield* Effect.forEach(pending, (report) =>
      Effect.gen(function* () {
        const { messages } = yield* projections.getThreadRecords(report.thread.id, ["messages"], {
          messageRoles: ["assistant"],
          messageRunIds: [report.run.id],
        });
        const reply =
          messages
            .toSorted(
              (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
            )
            .findLast((message) => message.text.trim().length > 0)
            ?.text.trim() ?? "(no reply)";
        const title = report.thread.title.replace(/\s+/g, " ").trim() || "Untitled worker";
        return {
          title,
          text: [
            Orchestrator.groupWorkerReportHeader({
              title,
              failed: report.failed,
              threadId: report.thread.id,
            }),
            reply.length > REPORT_CHARACTER_LIMIT
              ? `${reply.slice(0, REPORT_CHARACTER_LIMIT)}…\nRead the rest with t3_thread_read.`
              : reply,
          ].join("\n"),
        };
      }),
    );
    const text = sections.map((section) => section.text).join("\n\n");
    const failures = pending.filter((report) => report.failed).length;
    const key = `group-report:${first.key}`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:${key}`),
      threadId: leadId,
      messageId: MessageId.make(`message:${key}`),
      text,
      notification: {
        source: {
          kind: "group_worker",
          workerThreadIds: pending.map((report) => report.thread.id),
          reportKeys: pending.map((report) => report.key),
        },
        outcome: failures === 0 ? "completed" : "failed",
        summary:
          pending.length === 1
            ? `${sections[0]!.title} ${first.failed ? "failed" : "finished"}`
            : Orchestrator.groupWorkerReportSummary(pending.length, failures),
        detail: text,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  // Runs for every domain event; most events return before any read.
  const handle: GroupReportReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (!triggersReport(event)) return;
      const { thread } = yield* projections.getThreadRecords(event.threadId, []);
      const leadId = thread.groupParentThreadId;
      if (leadId == null) return;
      yield* leadLocks.withLock(
        leadId,
        reportGroup(leadId).pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.void }),
        ),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("reporting a group worker to its lead failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: GroupReportReactor["Service"]["start"] = Effect.fn("GroupReportReactor.start")(
    function* () {
      // Keyed by worker so one worker's run updates report in order.
      const workerReactions = yield* KeyedLock.makeRunner<ThreadId>();
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          triggersReport(event) ? workerReactions.run(event.threadId, handle(event)) : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("group report event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return { start, handle } satisfies GroupReportReactor["Service"];
});

export const layer = Layer.effect(GroupReportReactor, make);
