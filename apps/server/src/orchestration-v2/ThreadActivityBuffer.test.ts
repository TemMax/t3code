import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  type ActivityBuffer,
  activityDueAtMs,
  applyActivityEvent,
  buildActivityDigest,
  emptyActivityBuffer,
  markActivityFailed,
  markActivityRequested,
} from "./ThreadActivityBuffer.ts";

const threadId = ThreadId.make("thread:activity-buffer");
const runId = RunId.make("run:activity-buffer");
const at = DateTime.makeUnsafe("2026-11-04T00:00:00.000Z");

const itemBase = (id: string, run: RunId) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: run,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running" as const,
  title: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
});

const itemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${payload.id}`),
  type: "turn-item.updated",
  threadId,
  ...(payload.runId === null ? {} : { runId: payload.runId }),
  occurredAt: at,
  payload,
});

const command = (id: string, input: string, run = runId) =>
  itemEvent({ ...itemBase(id, run), type: "command_execution", input });

const todo = (id: string, running: string) =>
  itemEvent({
    ...itemBase(id, runId),
    type: "todo_list",
    planId: PlanId.make("plan:activity-buffer"),
    steps: [
      { id: "1", text: "Read the code", status: "completed" },
      { id: "2", text: running, status: "running" },
      { id: "3", text: "Ship it", status: "pending" },
    ],
  });

const subagent = (id: string, title: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${id}`),
  type: "subagent.updated",
  threadId,
  runId,
  occurredAt: at,
  payload: {
    id: NodeId.make(id),
    threadId,
    runId,
    parentNodeId: NodeId.make("node:root"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "prompt that is never shown when a title exists",
    title,
    model: null,
    status: "running",
    result: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
  },
});

const assistant = (text: string): OrchestrationV2DomainEvent => ({
  id: EventId.make("event:assistant"),
  type: "message.updated",
  threadId,
  runId,
  occurredAt: at,
  payload: {
    id: MessageId.make("message:assistant"),
    threadId,
    runId,
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming: true,
    createdBy: "agent",
    creationSource: "server",
    createdAt: at,
    updatedAt: at,
  },
});

const buffer = (overrides: Partial<ActivityBuffer>): ActivityBuffer => ({
  ...emptyActivityBuffer(runId, 1_000),
  ...overrides,
});

describe("ThreadActivityBuffer", () => {
  it.each<[string, ActivityBuffer, number | null]>([
    ["no new signals", buffer({ newSignals: 0 }), null],
    ["three signals before the first request", buffer({ newSignals: 3 }), 1_000],
    ["fewer signals before the first request", buffer({ newSignals: 2 }), 9_000],
    ["a refresh after a request", markActivityRequested(buffer({ newSignals: 5 }), 20_000), null],
    ["a signal after a request", buffer({ newSignals: 1, lastRequestAtMs: 20_000 }), 50_000],
    [
      "a priority signal after a request",
      buffer({ newSignals: 1, prioritySignal: true, lastRequestAtMs: 20_000 }),
      30_000,
    ],
    [
      "a failure after a request",
      markActivityFailed(markActivityRequested(buffer({ newSignals: 4 }), 20_000), 25_000),
      85_000,
    ],
    ["a failure before the first request", buffer({ newSignals: 3, failedAtMs: 2_000 }), 62_000],
    [
      "a failure longer ago than the backoff",
      buffer({ newSignals: 1, prioritySignal: true, lastRequestAtMs: 100_000, failedAtMs: 10_000 }),
      110_000,
    ],
  ])("decides when a summary is due: %s", (_name, input, expected) => {
    assert.strictEqual(activityDueAtMs(input), expected);
  });

  it("summarizes tools, todo and subagents", () => {
    let current = emptyActivityBuffer(runId, 0);
    for (let index = 0; index < 14; index += 1) {
      current = applyActivityEvent(current, command(`item:command:${index}`, `echo step-${index}`));
    }
    current = applyActivityEvent(current, command("item:command:13", "echo step-13 updated"));
    assert.strictEqual(current.newSignals, 14);
    assert.isFalse(current.prioritySignal);

    current = applyActivityEvent(current, todo("item:todo", "Wire the sidebar chip"));
    assert.isTrue(current.prioritySignal);
    const afterTodo = current.newSignals;
    current = applyActivityEvent(current, todo("item:todo", "Wire the sidebar chip"));
    assert.strictEqual(current.newSignals, afterTodo);

    current = markActivityRequested(current, 1_000);
    current = applyActivityEvent(current, subagent("node:subagent", `Audit ${"x".repeat(300)}`));
    assert.isTrue(current.prioritySignal);
    assert.strictEqual(current.newSignals, 1);

    current = applyActivityEvent(current, assistant(`${"a".repeat(2_000)}TAIL-END`));
    assert.strictEqual(current.newSignals, 1);

    const digest = buildActivityDigest(current, `Fix the sidebar ${"r".repeat(1_000)}`);
    const lines = digest.split("\n");
    assert.include(digest, "▶ Wire the sidebar chip");
    assert.notInclude(digest, "Read the code");
    assert.notInclude(digest, "echo step-0\n");
    assert.notInclude(digest, "echo step-1\n");
    assert.include(digest, "echo step-2");
    assert.include(digest, "echo step-13 updated");
    assert.lengthOf(
      lines.filter((line) => line.startsWith("$ ")),
      12,
    );
    const subagentLine = lines.find((line) => line.startsWith("- Audit"));
    assert.isAtMost(subagentLine?.length ?? Infinity, 120);
    assert.notInclude(digest, "prompt that is never shown");
    const request = lines.find((line) => line.startsWith("Fix the sidebar"));
    assert.strictEqual(request?.length, 600);
    const tailIndex = lines.indexOf("Latest assistant text:");
    const tail = lines[tailIndex + 1] ?? "";
    assert.isAtMost(tail.length, 500);
    assert.isTrue(tail.endsWith("TAIL-END"));
  });

  it("ignores events of other runs", () => {
    const other = RunId.make("run:activity-buffer:other");
    const current = emptyActivityBuffer(runId, 0);
    for (const event of [
      command("item:other", "rm -rf build", other),
      { ...assistant("other run text"), runId: other },
    ]) {
      assert.strictEqual(applyActivityEvent(current, event), current);
    }
  });
});
