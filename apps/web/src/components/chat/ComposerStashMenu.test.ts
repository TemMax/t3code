import {
  formatComposerContextReference,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { stashEntrySnippet } from "./ComposerStashMenu";

const entry = (prompt: string) => ({
  id: "stash-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  prompt,
  attachments: [],
  droppedImageNames: [],
});

describe("stashEntrySnippet", () => {
  it("cuts a long prompt on a whole character", () => {
    expect(stashEntrySnippet(entry(`${"a".repeat(89)}😀 and more`))).toBe(`${"a".repeat(89)}…`);
    expect(stashEntrySnippet(entry(`${"a".repeat(88)}😀 and more`))).toBe(`${"a".repeat(88)}😀…`);
  });

  it("shows context chips by their label", () => {
    const file = formatComposerContextReference({
      kind: "file",
      contextId: toComposerContextId("readme"),
      label: "README.md",
    });
    expect(stashEntrySnippet(entry(`Summarize ${file} please`))).toBe("Summarize README.md please");
  });

  it("counts a server summary's images and files", () => {
    const attachment = (type: "image" | "file", id: string) => ({
      type,
      id,
      attachmentId: `stash-${id}`,
      name: `${id}.bin`,
      mimeType: type === "image" ? "image/png" : "text/plain",
      sizeBytes: 1,
    });
    const summary = (attachments: ReadonlyArray<ReturnType<typeof attachment>>) => ({
      ...entry(""),
      attachments,
      unreadableImageNames: [],
      droppedFileNames: [],
    });
    expect(stashEntrySnippet(summary([attachment("image", "a"), attachment("image", "b")]))).toBe(
      "(2 images)",
    );
    expect(stashEntrySnippet(summary([attachment("file", "notes")]))).toBe("(1 file)");
    expect(
      stashEntrySnippet(summary([attachment("image", "a"), attachment("file", "notes")])),
    ).toBe("(2 attachments)");
  });
});
