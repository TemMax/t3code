import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerEnvironmentItems,
  matchComposerModelItems,
  type ComposerModelCandidate,
  matchComposerThreadItems,
  type ComposerThreadCandidate,
} from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

it("also offers threads on linked machines, naming the machine, but no other machine's", () => {
  const vps = EnvironmentId.make("env-vps");
  const items = matchComposerThreadItems({
    shells: [
      shell("here", "Deploy script"),
      shell("there", "Deploy script", { environmentId: vps }),
      shell("unlinked", "Deploy notes", { environmentId: EnvironmentId.make("env-unlinked") }),
    ],
    environmentId,
    linkedEnvironments: new Map([[vps, "Hetzner VPS"]]),
    excludeThreadId: null,
    query: "deploy",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, label, description }) => ({ thread, label, description }))).toEqual([
    { thread: { environmentId, threadId: "here" }, label: "Deploy script", description: "Thread" },
    {
      thread: { environmentId: vps, threadId: "there" },
      label: "Deploy script",
      description: "Thread on Hetzner VPS",
    },
  ]);
});

describe("matchComposerEnvironmentItems", () => {
  const environments = [
    { environmentId: EnvironmentId.make("env-here"), label: "Laptop", machine: "laptop" },
    { environmentId: EnvironmentId.make("env-vps"), label: "Hetzner VPS", machine: "cloud" },
    { environmentId: EnvironmentId.make("env-mini"), label: "Mac mini", machine: "mac-mini" },
  ] as const;

  it("offers the other machines matching the query, never the composer's own", () => {
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "  vps ",
      }),
    ).toEqual([
      {
        id: "environment:env-vps",
        type: "environment",
        environmentId: "env-vps",
        machine: "cloud",
        label: "Hetzner VPS",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "lap",
      }),
    ).toEqual([]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "",
      }),
    ).toEqual([]);
  });
});

describe("matchComposerModelItems", () => {
  const candidate = (
    driverKind: string,
    model: string,
    name: string,
    providerDisplayName: string,
  ): ComposerModelCandidate => ({
    providerInstanceId: ProviderInstanceId.make(driverKind),
    model,
    name,
    driverKind,
    providerDisplayName,
    isFavorite: false,
  });
  const models = [
    candidate("codex", "gpt-6.1-sol", "GPT-6.1 Sol", "Codex"),
    candidate("codex", "gpt-6-luna", "GPT-6 Luna", "Codex"),
    candidate("claudeAgent", "claude-opus-5-5", "Claude Opus 5.5", "Claude"),
  ];

  it("needs a query, like threads and machines", () => {
    expect(matchComposerModelItems({ models, query: "" })).toEqual([]);
    expect(matchComposerModelItems({ models, query: "  " })).toEqual([]);
  });

  it("ranks like the model picker and names the provider", () => {
    const sol = matchComposerModelItems({ models, query: "sol" });
    expect(sol[0]).toEqual({
      id: "model:codex:gpt-6.1-sol",
      type: "model",
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-sol",
      driverKind: "codex",
      label: "GPT-6.1 Sol",
      description: "Codex",
    });
    expect(matchComposerModelItems({ models, query: "opus" }).map((item) => item.model)).toEqual([
      "claude-opus-5-5",
    ]);
  });

  it("offers at most six", () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      candidate("codex", `gpt-${index}`, `GPT ${index}`, "Codex"),
    );
    expect(matchComposerModelItems({ models: many, query: "gpt" })).toHaveLength(6);
  });
});
