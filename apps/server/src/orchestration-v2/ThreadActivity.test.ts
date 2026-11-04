import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadActivityPhase,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:thread-activity");
const threadId = ThreadId.make("thread:thread-activity");
const runId = RunId.make("run:thread-activity");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in thread activity tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "thread-activity" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layer = Layer.mergeAll(
  layerOrchestrator,
  ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  ),
  layerDatabase,
);

const startRun = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("command:thread-activity:create"),
    threadId,
    projectId,
    title: "Seed title",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make(`${threadId}:provider`),
    userMessageId: MessageId.make(`${runId}:user`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`${runId}:created`),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: run,
      },
    ],
  });
  return run;
});

const recordActivity = (input: {
  readonly command: string;
  readonly runId: RunId;
  readonly phase: OrchestrationV2ThreadActivityPhase;
  readonly label: string;
}) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* threads.dispatch({
      type: "thread.activity.record",
      commandId: CommandId.make(input.command),
      threadId,
      runId: input.runId,
      phase: input.phase,
      label: input.label,
    });
  });

describe("thread activity", () => {
  it.effect("records activity for the active run without bumping updatedAt", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* startRun;
      const before = yield* threads.getThreadShell(threadId);
      yield* TestClock.adjust("1 minute");
      const result = yield* recordActivity({
        command: "command:thread-activity:record",
        runId,
        phase: "implementing",
        label: "sidebar status chip",
      });
      const shell = yield* threads.getThreadShell(threadId);
      assert.equal(result.storedEvents.length, 1);
      assert.equal(shell?.activity?.runId, runId);
      assert.equal(shell?.activity?.phase, "implementing");
      assert.equal(shell?.activity?.label, "sidebar status chip");
      assert.deepEqual(shell?.updatedAt, before?.updatedAt);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores a record for a run that is no longer active", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* startRun;
      const result = yield* recordActivity({
        command: "command:thread-activity:stale",
        runId: RunId.make("run:thread-activity:old"),
        phase: "testing",
        label: "gradle build",
      });
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(result.storedEvents.length, 0);
      assert.isNotOk(projection.thread.activity);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips an identical record", () =>
    Effect.gen(function* () {
      yield* startRun;
      const record = { runId, phase: "planning", label: "split the work" } as const;
      const first = yield* recordActivity({ command: "command:thread-activity:one", ...record });
      const second = yield* recordActivity({ command: "command:thread-activity:two", ...record });
      assert.equal(first.storedEvents.length, 1);
      assert.equal(second.storedEvents.length, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("hides activity once the run ends", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const eventSink = yield* EventSink.EventSinkV2;
      const run = yield* startRun;
      yield* recordActivity({
        command: "command:thread-activity:running",
        runId,
        phase: "debugging",
        label: "flaky login test",
      });
      assert.equal((yield* threads.getThreadShell(threadId))?.activity?.phase, "debugging");
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${runId}:completed`),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      const shell = yield* threads.getThreadShell(threadId);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.isNull(shell?.activity);
      assert.equal(projection.thread.activity?.runId, runId);
    }).pipe(Effect.provide(layer)),
  );
});
