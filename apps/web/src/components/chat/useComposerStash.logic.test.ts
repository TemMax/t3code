import { EnvironmentId, type PromptStashSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { StashMenuItem } from "../../promptStash/promptStashSync.logic";
import {
  canRestoreServerEntryIn,
  missingAttachmentGroups,
  soleRestorableStashItem,
  stashUploadCleanup,
} from "./useComposerStash.logic";

describe("stashUploadCleanup", () => {
  it("forgets uploads a server entry now owns and deletes the rest", () => {
    const input = { imageIds: ["shot", "annotated"], annotationIds: ["annotated", "bare"] };
    expect(stashUploadCleanup({ ...input, storedOnServer: true })).toEqual({
      forget: ["shot", "annotated"],
      release: ["bare"],
    });
    expect(stashUploadCleanup({ ...input, storedOnServer: false })).toEqual({
      forget: [],
      release: ["annotated", "bare", "shot"],
    });
  });
});

describe("missingAttachmentGroups", () => {
  it("says a server entry's dropped attachments were not kept, not oversized or expired", () => {
    const names = {
      droppedImageNames: ["big.png"],
      droppedFileNames: ["notes.txt"],
      expiredFileNames: ["old.pdf"],
    };
    expect(missingAttachmentGroups({ ...names, origin: "server" })).toEqual({
      overSizeLimit: [],
      notKept: ["big.png", "notes.txt"],
      expired: ["old.pdf"],
    });
    expect(missingAttachmentGroups({ ...names, origin: "local" })).toEqual({
      overSizeLimit: ["big.png"],
      notKept: [],
      expired: ["notes.txt", "old.pdf"],
    });
  });
});

describe("canRestoreServerEntryIn", () => {
  it("restores text-only entries anywhere and attachments only where they live", () => {
    const here = EnvironmentId.make("here");
    const there = EnvironmentId.make("there");
    expect(canRestoreServerEntryIn(here, { environmentId: there, hasAttachments: false })).toBe(
      true,
    );
    expect(canRestoreServerEntryIn(here, { environmentId: there, hasAttachments: true })).toBe(
      false,
    );
    expect(canRestoreServerEntryIn(here, { environmentId: here, hasAttachments: true })).toBe(true);
  });
});

describe("soleRestorableStashItem", () => {
  it("ignores entries already being taken", () => {
    const summary = (id: string): PromptStashSummary => ({
      id,
      createdAt: "2026-11-21T12:00:00.000Z",
      prompt: id,
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
      droppedFileNames: [],
    });
    const environmentId = EnvironmentId.make("here");
    const items: StashMenuItem[] = [
      { kind: "server", environmentId, summary: summary("taking") },
      { kind: "server", environmentId, summary: summary("free") },
    ];
    expect(soleRestorableStashItem(items, new Set())).toBeUndefined();
    expect(soleRestorableStashItem(items, new Set(["taking"]))).toBe(items[1]);
    expect(soleRestorableStashItem(items, new Set(["taking", "free"]))).toBeUndefined();
  });
});
