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
const BUSY_RUN_STATUSES = ["queued", "preparing", "starting", "running"] as const;

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // Runs for every domain event; most events return before any read.
  const handle: GroupReportReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated" || !STOPPED_RUN_STATUSES.has(event.payload.status)) return;
      const worker = yield* projections.getThreadRecords(
        event.threadId,
        ["runs", "runtimeRequests", "subagents", "providerThreads"],
        {
          runStatuses: BUSY_RUN_STATUSES,
          includeLatestRun: true,
          runtimeRequestStatuses: ["pending"],
          omitSettledSubagents: true,
        },
      );
      const leadId = worker.thread.groupParentThreadId;
      const run = worker.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (
        leadId == null ||
        worker.thread.deletedAt !== null ||
        run === undefined ||
        run.id !== event.payload.id ||
        !STOPPED_RUN_STATUSES.has(run.status) ||
        worker.runs.some(
          (other) =>
            other.id !== run.id &&
            (BUSY_RUN_STATUSES as ReadonlyArray<string>).includes(other.status),
        ) ||
        worker.runtimeRequests.some((request) => request.status === "pending")
      ) {
        return;
      }
      if (worker.subagents.length > 0) {
        const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
          messageRoles: ["user"],
          monitorNotificationsOnly: true,
        });
        const { runs } = yield* projections.getThreadRecords(event.threadId, ["runs"]);
        if (delegatedTaskProgress({ ...worker, runs, messages }).state !== "result_available") {
          return;
        }
      }
      const lead = yield* projections.getThreadRecords(leadId, []);
      if (lead.thread.archivedAt !== null || lead.thread.deletedAt !== null) return;

      const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
      });
      const reply =
        messages
          .toSorted(
            (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
          )
          .findLast((message) => message.text.trim().length > 0)
          ?.text.trim() ?? "(no reply)";
      const failed = run.status === "failed";
      const title = worker.thread.title.replace(/\s+/g, " ").trim() || "Untitled worker";
      const text = [
        Orchestrator.groupWorkerReportHeader({ title, failed, threadId: worker.thread.id }),
        reply.length > REPORT_CHARACTER_LIMIT
          ? `${reply.slice(0, REPORT_CHARACTER_LIMIT)}…\nRead the rest with t3_thread_read.`
          : reply,
      ].join("\n");
      const key = `group-report:${worker.thread.id}:${run.id}`;
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:${key}`),
        threadId: leadId,
        messageId: MessageId.make(`message:${key}`),
        text,
        notification: {
          source: { kind: "group_worker", workerThreadIds: [worker.thread.id] },
          outcome: failed ? "failed" : "completed",
          summary: `${title} ${failed ? "failed" : "finished"}`,
          detail: text,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
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
          event.type === "run.updated" && STOPPED_RUN_STATUSES.has(event.payload.status)
            ? workerReactions.run(event.threadId, handle(event))
            : Effect.void,
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
