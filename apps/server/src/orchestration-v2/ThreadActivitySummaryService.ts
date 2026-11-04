import {
  CommandId,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProviderDriverKind,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  type ActivityBuffer,
  MAX_CONCURRENT_SUMMARIES,
  activityDueAtMs,
  applyActivityEvent,
  buildActivityDigest,
  emptyActivityBuffer,
  markActivityFailed,
  markActivityRequested,
} from "./ThreadActivityBuffer.ts";

export class ThreadActivitySummaryService extends Context.Service<
  ThreadActivitySummaryService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadActivitySummaryService") {}

const ACTIVE_RUN_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "preparing",
  "starting",
  "running",
  "waiting",
];
const TERMINAL_RUN_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
];

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

function activityModelSelection(
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
): ModelSelection | null {
  if (driver === CLAUDE_DRIVER) {
    const model = DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[CLAUDE_DRIVER];
    return model === undefined ? null : { instanceId, model };
  }
  if (driver === CODEX_DRIVER) {
    return {
      instanceId,
      model: DEFAULT_TEXT_GENERATION_MODEL,
      options: [{ id: "reasoningEffort", value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT }],
    };
  }
  return null;
}

interface Timer {
  readonly dueAtMs: number;
  readonly fiber: Fiber.Fiber<void>;
  firing: boolean;
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const scope = yield* Effect.scope;

  const buffers = yield* Ref.make<ReadonlyMap<ThreadId, ActivityBuffer>>(new Map());
  // Timers change only while holding `lock`, so a firing timer is never replaced mid-request.
  const timers = new Map<ThreadId, Timer>();
  const lock = yield* Semaphore.make(1);
  const permits = yield* Semaphore.make(MAX_CONCURRENT_SUMMARIES);

  const updateBuffer = (
    threadId: ThreadId,
    runId: RunId,
    update: (buffer: ActivityBuffer) => ActivityBuffer,
  ) =>
    Ref.update(buffers, (current) => {
      const buffer = current.get(threadId);
      return buffer?.runId === runId ? new Map(current).set(threadId, update(buffer)) : current;
    });

  const summarize = Effect.fn("ThreadActivitySummaryService.summarize")(
    function* (threadId: ThreadId, runId: RunId, requestedAtMs: number) {
      const buffer = yield* Ref.modify(buffers, (current) => {
        const existing = current.get(threadId);
        return existing?.runId === runId
          ? ([
              existing,
              new Map(current).set(threadId, markActivityRequested(existing, requestedAtMs)),
            ] as const)
          : ([undefined, current] as const);
      });
      if (buffer === undefined) return;
      const settings = yield* serverSettings.getSettings;
      if (!settings.threadActivitySummaryEnabled) return;
      const shell = yield* engine.getThreadShell(threadId);
      if (shell === null || shell.activeRunId !== runId) return;
      const instanceId = shell.modelSelection.instanceId;
      const instance = yield* instances.getInstance(instanceId);
      const modelSelection =
        instance === undefined ? null : activityModelSelection(instance.driverKind, instanceId);
      if (modelSelection === null) return;
      yield* permits.withPermits(1)(
        Effect.gen(function* () {
          const { messages } = yield* engine.getThreadRecords(threadId, ["messages"], {
            messageRoles: ["user"],
            messageRunIds: [runId],
          });
          const project = yield* projects.get(shell.projectId);
          const cwd = shell.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
          if (cwd === undefined) return;
          const result = yield* textGeneration.generateThreadActivity({
            cwd,
            digest: buildActivityDigest(buffer, messages.at(-1)?.text ?? null),
            previous: buffer.previous,
            modelSelection,
          });
          const previous = { phase: result.phase, label: result.label };
          yield* updateBuffer(threadId, runId, (current) => ({ ...current, previous }));
          yield* engine.dispatch({
            type: "thread.activity.record",
            commandId: CommandId.make(`${runId}:activity:${requestedAtMs}`),
            threadId,
            runId,
            ...previous,
          });
        }),
      );
    },
    (effect, threadId, runId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.gen(function* () {
                const failedAtMs = yield* Clock.currentTimeMillis;
                yield* updateBuffer(threadId, runId, (buffer) =>
                  markActivityFailed(buffer, failedAtMs),
                );
                yield* Effect.logWarning("thread activity summary failed", {
                  threadId,
                  runId,
                  cause,
                });
              }),
        ),
      ),
  );

  // Runs per event while the caller holds `lock`; a span here would be per-event noise.
  const reschedule: (threadId: ThreadId) => Effect.Effect<void> = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const timer = timers.get(threadId);
    if (timer?.firing === true) return;
    const buffer = (yield* Ref.get(buffers)).get(threadId);
    const dueAtMs = buffer === undefined ? null : activityDueAtMs(buffer);
    if (timer !== undefined && timer.dueAtMs === dueAtMs) return;
    if (timer !== undefined) {
      timers.delete(threadId);
      yield* Fiber.interrupt(timer.fiber);
    }
    if (buffer === undefined || dueAtMs === null) return;
    const delayMs = dueAtMs - (yield* Clock.currentTimeMillis);
    const fiber = yield* Effect.gen(function* () {
      if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs));
      const requestedAtMs = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const own = timers.get(threadId);
          if (own !== undefined) own.firing = true;
          return yield* Clock.currentTimeMillis;
        }),
      );
      yield* summarize(threadId, buffer.runId, requestedAtMs);
      yield* lock.withPermits(1)(
        Effect.suspend(() => {
          timers.delete(threadId);
          return reschedule(threadId);
        }),
      );
    }).pipe(Effect.forkIn(scope));
    timers.set(threadId, { dueAtMs, fiber, firing: false });
  });

  const forget = Effect.fn("ThreadActivitySummaryService.forget")(function* (threadId: ThreadId) {
    const timer = timers.get(threadId);
    timers.delete(threadId);
    if (timer !== undefined) yield* Fiber.interrupt(timer.fiber);
  });

  // Runs for every domain event; most return after one map lookup.
  const handle: ThreadActivitySummaryService["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        const run = event.payload;
        if (TERMINAL_RUN_STATUSES.includes(run.status)) {
          const tracked = (yield* Ref.get(buffers)).get(event.threadId);
          if (tracked?.runId !== run.id) return;
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.update(buffers, (current) => {
                const next = new Map(current);
                next.delete(event.threadId);
                return next;
              });
              yield* forget(event.threadId);
            }),
          );
          return;
        }
        if (!ACTIVE_RUN_STATUSES.includes(run.status)) return;
        if ((yield* Ref.get(buffers)).get(event.threadId)?.runId === run.id) return;
        const nowMs = yield* Clock.currentTimeMillis;
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            yield* forget(event.threadId);
            yield* Ref.update(buffers, (current) =>
              new Map(current).set(event.threadId, emptyActivityBuffer(run.id, nowMs)),
            );
          }),
        );
        return;
      }
      const dueChanged = yield* Ref.modify(buffers, (current) => {
        const buffer = current.get(event.threadId);
        const next = buffer === undefined ? buffer : applyActivityEvent(buffer, event);
        return buffer === undefined || next === undefined || next === buffer
          ? ([false, current] as const)
          : ([
              activityDueAtMs(next) !== activityDueAtMs(buffer),
              new Map(current).set(event.threadId, next),
            ] as const);
      });
      if (dueChanged) yield* lock.withPermits(1)(reschedule(event.threadId));
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("tracking thread activity failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: ThreadActivitySummaryService["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread activity event stream failed", { cause }),
        ),
      ),
    );

  return ThreadActivitySummaryService.of({ start, handle });
});

export const layer = Layer.effect(ThreadActivitySummaryService, make);
