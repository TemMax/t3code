import type {
  NodeId,
  OrchestrationV2DomainEvent,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadActivitySummary,
  OrchestrationV2TurnItem,
  RunId,
  TurnItemId,
} from "@t3tools/contracts";

const FIRST_MIN_SIGNALS = 3;
const FIRST_DELAY_MS = 8_000;
const REFRESH_INTERVAL_MS = 30_000;
const PRIORITY_INTERVAL_MS = 10_000;
const FAILURE_BACKOFF_MS = 60_000;
const MAX_DIGEST_TOOL_LINES = 12;
export const MAX_CONCURRENT_SUMMARIES = 3;

const MAX_TOOL_LINE_CHARS = 200;
const MAX_SUBAGENT_LINE_CHARS = 120;
const MAX_ASSISTANT_TAIL_CHARS = 500;
const MAX_USER_REQUEST_CHARS = 600;

export interface ActivityBuffer {
  readonly runId: RunId;
  readonly runStartedAtMs: number;
  readonly toolLines: ReadonlyArray<{ readonly itemId: TurnItemId; readonly line: string }>;
  readonly todoStep: string | null;
  readonly subagents: ReadonlyArray<{ readonly id: NodeId; readonly label: string }>;
  readonly assistantTail: string;
  readonly newSignals: number;
  readonly prioritySignal: boolean;
  readonly lastRequestAtMs: number | null;
  readonly failedAtMs: number | null;
  readonly previous: OrchestrationV2ThreadActivitySummary | null;
}

export function emptyActivityBuffer(runId: RunId, nowMs: number): ActivityBuffer {
  return {
    runId,
    runStartedAtMs: nowMs,
    toolLines: [],
    todoStep: null,
    subagents: [],
    assistantTail: "",
    newSignals: 0,
    prioritySignal: false,
    lastRequestAtMs: null,
    failedAtMs: null,
    previous: null,
  };
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function toolLine(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "command_execution":
      return `$ ${item.input}`;
    case "file_change":
      return `edit ${item.fileName}`;
    case "dynamic_tool":
      return `tool ${item.toolName ?? item.title ?? "unknown"}`;
    case "file_search":
      return item.pattern ? `search files: ${item.pattern}` : "search files";
    case "web_search":
      return item.patterns?.length ? `web search: ${item.patterns.join(", ")}` : "web search";
    default:
      return null;
  }
}

function eventRunId(event: OrchestrationV2DomainEvent): RunId | null {
  if (event.runId !== undefined) return event.runId;
  switch (event.type) {
    case "turn-item.updated":
    case "message.updated":
    case "subagent.updated":
      return event.payload.runId;
    default:
      return null;
  }
}

const ACTIVE_SUBAGENT_STATUSES: ReadonlyArray<OrchestrationV2Subagent["status"]> = [
  "pending",
  "running",
  "waiting",
];

export function applyActivityEvent(
  buffer: ActivityBuffer,
  event: OrchestrationV2DomainEvent,
): ActivityBuffer {
  if (eventRunId(event) !== buffer.runId) return buffer;
  switch (event.type) {
    case "turn-item.updated": {
      const item = event.payload;
      if (item.type === "todo_list") {
        const step = item.steps.find((candidate) => candidate.status === "running")?.text ?? null;
        if (step === buffer.todoStep) return buffer;
        return step === null
          ? { ...buffer, todoStep: null }
          : {
              ...buffer,
              todoStep: step,
              newSignals: buffer.newSignals + 1,
              prioritySignal: true,
            };
      }
      const raw = toolLine(item);
      if (raw === null) return buffer;
      const line = oneLine(raw, MAX_TOOL_LINE_CHARS);
      const known = buffer.toolLines.some((entry) => entry.itemId === item.id);
      if (known) {
        return {
          ...buffer,
          toolLines: buffer.toolLines.map((entry) =>
            entry.itemId === item.id ? { itemId: item.id, line } : entry,
          ),
        };
      }
      return {
        ...buffer,
        toolLines: [...buffer.toolLines, { itemId: item.id, line }].slice(-MAX_DIGEST_TOOL_LINES),
        newSignals: buffer.newSignals + 1,
      };
    }
    case "subagent.updated": {
      const subagent = event.payload;
      const others = buffer.subagents.filter((entry) => entry.id !== subagent.id);
      if (!ACTIVE_SUBAGENT_STATUSES.includes(subagent.status)) {
        return others.length === buffer.subagents.length
          ? buffer
          : { ...buffer, subagents: others };
      }
      const existing = buffer.subagents.find((entry) => entry.id === subagent.id);
      // A repeated record may omit the prompt it already sent.
      const label =
        oneLine(subagent.title?.trim() || subagent.prompt, MAX_SUBAGENT_LINE_CHARS) ||
        existing?.label ||
        "subagent";
      if (existing !== undefined) {
        return {
          ...buffer,
          subagents: buffer.subagents.map((entry) =>
            entry.id === subagent.id ? { id: subagent.id, label } : entry,
          ),
        };
      }
      return {
        ...buffer,
        subagents: [...buffer.subagents, { id: subagent.id, label }],
        newSignals: buffer.newSignals + 1,
        prioritySignal: true,
      };
    }
    case "message.updated":
      return event.payload.role === "assistant"
        ? { ...buffer, assistantTail: event.payload.text.slice(-MAX_ASSISTANT_TAIL_CHARS) }
        : buffer;
    default:
      return buffer;
  }
}

export function activityDueAtMs(buffer: ActivityBuffer): number | null {
  if (buffer.newSignals === 0) return null;
  const due =
    buffer.lastRequestAtMs === null
      ? buffer.newSignals >= FIRST_MIN_SIGNALS
        ? buffer.runStartedAtMs
        : buffer.runStartedAtMs + FIRST_DELAY_MS
      : buffer.lastRequestAtMs +
        (buffer.prioritySignal ? PRIORITY_INTERVAL_MS : REFRESH_INTERVAL_MS);
  return buffer.failedAtMs === null ? due : Math.max(due, buffer.failedAtMs + FAILURE_BACKOFF_MS);
}

export function markActivityRequested(buffer: ActivityBuffer, nowMs: number): ActivityBuffer {
  return { ...buffer, lastRequestAtMs: nowMs, newSignals: 0, prioritySignal: false };
}

/** The failed request consumed its signals; keep one so the retry still comes due. */
export function markActivityFailed(buffer: ActivityBuffer, nowMs: number): ActivityBuffer {
  return { ...buffer, failedAtMs: nowMs, newSignals: Math.max(buffer.newSignals, 1) };
}

export function buildActivityDigest(buffer: ActivityBuffer, userRequest: string | null): string {
  const sections: Array<string> = [];
  const request = userRequest?.trim();
  if (request) {
    sections.push(`User request:\n${request.slice(0, MAX_USER_REQUEST_CHARS)}`);
  }
  if (buffer.todoStep !== null) {
    sections.push(`Running todo step:\n▶ ${buffer.todoStep}`);
  }
  if (buffer.subagents.length > 0) {
    sections.push(
      `Running subagents:\n${buffer.subagents
        .map((entry) => oneLine(`- ${entry.label}`, MAX_SUBAGENT_LINE_CHARS))
        .join("\n")}`,
    );
  }
  if (buffer.toolLines.length > 0) {
    sections.push(
      `Recent tools (oldest first):\n${buffer.toolLines
        .slice(-MAX_DIGEST_TOOL_LINES)
        .map((entry) => entry.line)
        .join("\n")}`,
    );
  }
  const tail = buffer.assistantTail.trim();
  if (tail.length > 0) {
    sections.push(`Latest assistant text:\n${tail}`);
  }
  return sections.join("\n\n");
}
