import { EnvironmentId, type PromptStashSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PromptStashEntry } from "../promptStashStore";
import {
  applyPutOutcome,
  mergeStashMenuItems,
  planLocalStashUploads,
  runStashSyncPass,
  targetEnvironmentForLocalEntry,
  type StashPutOutcome,
  type StashSyncPassDeps,
} from "./promptStashSync.logic";

function entry(id: string, extra: Partial<PromptStashEntry> = {}): PromptStashEntry {
  return {
    id,
    createdAt: "2026-11-21T12:00:00.000Z",
    prompt: id,
    attachments: [],
    droppedImageNames: [],
    ...extra,
  };
}

describe("planLocalStashUploads", () => {
  it("drops local entries already on the server", () => {
    const plan = planLocalStashUploads([entry("a"), entry("b")], new Set(["a"]));
    expect(plan.drop).toEqual(["a"]);
    expect(plan.upload.map((item) => item.id)).toEqual(["b"]);
  });

  it("skips entries whose images are still compressing", () => {
    const plan = planLocalStashUploads(
      [entry("a", { pendingImageCount: 1 }), entry("b")],
      new Set(),
    );
    expect(plan.upload.map((item) => item.id)).toEqual(["b"]);
    expect(plan.drop).toEqual([]);
  });

  it("uploads the rest oldest first", () => {
    const plan = planLocalStashUploads(
      [
        entry("newest", { createdAt: "2026-11-21T12:03:00.000Z" }),
        entry("tie-new"),
        entry("tie-old"),
        entry("oldest", { createdAt: "2026-11-21T11:00:00.000Z" }),
      ],
      new Set(),
    );
    expect(plan.upload.map((item) => item.id)).toEqual(["oldest", "tie-old", "tie-new", "newest"]);
  });
});

describe("targetEnvironmentForLocalEntry", () => {
  it("targets the entry's environment, then its files', then the primary, then the only writable one", () => {
    const primary = EnvironmentId.make("primary");
    const remote = EnvironmentId.make("remote");
    const own = EnvironmentId.make("own");
    const withFile = entry("a", {
      files: [
        {
          id: "f",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          attachmentId: "pending-1",
          environmentId: remote,
        },
      ],
    });
    expect(targetEnvironmentForLocalEntry({ ...withFile, environmentId: own }, primary, [])).toBe(
      own,
    );
    expect(targetEnvironmentForLocalEntry(withFile, primary, [])).toBe(remote);
    expect(targetEnvironmentForLocalEntry(entry("b"), primary, [remote])).toBe(primary);
    expect(targetEnvironmentForLocalEntry(entry("b"), null, [remote])).toBe(remote);
    expect(targetEnvironmentForLocalEntry(entry("b"), null, [remote, own])).toBeNull();
    expect(targetEnvironmentForLocalEntry(entry("b"), null, [])).toBeNull();
  });
});

describe("applyPutOutcome", () => {
  it("drops local entries the server reports as already taken", () => {
    expect(applyPutOutcome("a", "already-taken")).toEqual(["a"]);
    expect(applyPutOutcome("a", "stored")).toEqual(["a"]);
    expect(applyPutOutcome("a", "failed")).toEqual([]);
    expect(applyPutOutcome("a", "too-large")).toEqual([]);
  });
});

const target = EnvironmentId.make("target");
const image = (id: string): PromptStashEntry["attachments"][number] => ({
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 1,
  dataUrl: "data:image/png;base64,AA==",
});

function stored(...attachmentIds: string[]): StashPutOutcome {
  return {
    _tag: "stored",
    evictedIds: [],
    summary: {
      id: "summary",
      createdAt: "2026-11-21T12:00:00.000Z",
      prompt: "",
      attachments: attachmentIds.map((attachmentId) => ({
        type: "image",
        id: attachmentId,
        attachmentId,
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 1,
      })),
      droppedImageNames: [],
      unreadableImageNames: [],
      droppedFileNames: [],
    },
  };
}

/** A pass over `entries` whose images upload as `pending-<image id>`; calls are recorded. */
function fakePass(
  entries: ReadonlyArray<PromptStashEntry>,
  overrides: Partial<StashSyncPassDeps> = {},
) {
  const calls = {
    puts: [] as string[],
    deleted: [] as string[],
    dropped: [] as string[],
  };
  const deps: StashSyncPassDeps = {
    readEntries: () => entries,
    serverIds: new Set(),
    targetFor: () => target,
    isHeld: () => false,
    uploadImages: async (local) => ({
      attachmentIds: local.attachments.map((attachment) => `pending-${attachment.id}`),
      complete: true,
    }),
    put: async (input) => {
      calls.puts.push(input.id);
      return stored(...input.attachments.map((a) => a.attachmentId.replace("pending-", "stash-")));
    },
    deleteUploads: (_environmentId, attachmentIds) => calls.deleted.push(...attachmentIds),
    dropEntries: (ids) => calls.dropped.push(...ids),
    ...overrides,
  };
  return { calls, run: () => runStashSyncPass(deps) };
}

describe("runStashSyncPass", () => {
  it("plans from storage, not memory", async () => {
    const pass = fakePass([entry("from-storage", { attachments: [image("shot")] })]);
    expect(await pass.run()).toEqual({ retry: false, evicted: false, tooLarge: [] });
    expect(pass.calls).toEqual({ puts: ["from-storage"], deleted: [], dropped: ["from-storage"] });
  });

  it("skips an entry removed during its upload and deletes its uploads", async () => {
    const queue = [entry("removed", { attachments: [image("shot")] })];
    let reads = 0;
    const pass = fakePass(queue, {
      readEntries: () => (reads++ === 0 ? queue : []),
    });
    await pass.run();
    expect(pass.calls).toEqual({ puts: [], deleted: ["pending-shot"], dropped: [] });
  });

  it("keeps an entry when the put fails and deletes its uploads", async () => {
    const pass = fakePass([entry("failing", { attachments: [image("shot")] })], {
      put: async () => ({ _tag: "failed" }),
    });
    expect(await pass.run()).toMatchObject({ retry: true });
    expect(pass.calls).toMatchObject({ deleted: ["pending-shot"], dropped: [] });
  });

  it("drops an already-taken entry and deletes its uploads", async () => {
    const pass = fakePass([entry("taken", { attachments: [image("shot")] })], {
      put: async () => ({ _tag: "already-taken" }),
    });
    expect(await pass.run()).toMatchObject({ retry: false });
    expect(pass.calls).toMatchObject({ deleted: ["pending-shot"], dropped: ["taken"] });
  });

  it("deletes uploads when the put returned an existing entry", async () => {
    const pass = fakePass(
      [
        entry("existing", { attachments: [image("shot")] }),
        entry("fresh", { createdAt: "2026-11-21T12:01:00.000Z", attachments: [image("new")] }),
      ],
      {
        put: async (input) =>
          input.id === "existing" ? stored("stash-from-an-earlier-put") : stored("stash-new"),
      },
    );
    await pass.run();
    expect(pass.calls).toMatchObject({ deleted: ["pending-shot"], dropped: ["existing", "fresh"] });
  });

  it("does not retry an entry that is too large", async () => {
    const pass = fakePass([entry("huge", { attachments: [image("shot")] })], {
      put: async () => ({ _tag: "too-large" }),
    });
    expect(await pass.run()).toEqual({ retry: false, evicted: false, tooLarge: ["huge"] });
    expect(pass.calls).toMatchObject({ deleted: ["pending-shot"], dropped: [] });
  });
});

describe("mergeStashMenuItems", () => {
  it("merges local and server entries newest first and hides local duplicates", () => {
    const server = EnvironmentId.make("server");
    const summary = (id: string, createdAt: string): PromptStashSummary => ({
      id,
      createdAt,
      prompt: id,
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
      droppedFileNames: [],
    });
    const items = mergeStashMenuItems(
      [
        entry("local-new", { createdAt: "2026-11-21T12:05:00.000Z" }),
        entry("synced", { createdAt: "2026-11-21T12:04:00.000Z" }),
        entry("local-old", { createdAt: "2026-11-21T11:00:00.000Z" }),
      ],
      [
        {
          environmentId: server,
          summaries: [
            summary("synced", "2026-11-21T12:04:00.000Z"),
            summary("server-mid", "2026-11-21T12:01:00.000Z"),
          ],
        },
      ],
    );
    expect(
      items.map((item) => [item.kind, item.kind === "local" ? item.entry.id : item.summary.id]),
    ).toEqual([
      ["local", "local-new"],
      ["server", "synced"],
      ["server", "server-mid"],
      ["local", "local-old"],
    ]);
    expect(items[1]).toMatchObject({ kind: "server", environmentId: server });
  });
});
