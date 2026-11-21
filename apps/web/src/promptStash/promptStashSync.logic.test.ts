import { EnvironmentId, type PromptStashSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PromptStashEntry } from "../promptStashStore";
import {
  applyPutOutcome,
  mergeStashMenuItems,
  planLocalStashUploads,
  targetEnvironmentForLocalEntry,
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
  it("targets the environment of the entry's files, else the primary", () => {
    const primary = EnvironmentId.make("primary");
    const remote = EnvironmentId.make("remote");
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
    expect(targetEnvironmentForLocalEntry(withFile, primary)).toBe(remote);
    expect(targetEnvironmentForLocalEntry(entry("b"), primary)).toBe(primary);
    expect(targetEnvironmentForLocalEntry(entry("b"), null)).toBeNull();
  });
});

describe("applyPutOutcome", () => {
  it("drops local entries the server reports as already taken", () => {
    expect(applyPutOutcome(["a", "b"], "a", "already-taken")).toEqual(["a"]);
    expect(applyPutOutcome(["a", "b"], "a", "stored")).toEqual(["a"]);
    expect(applyPutOutcome(["a", "b"], "a", "failed")).toEqual([]);
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
