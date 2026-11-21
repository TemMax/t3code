import * as Schema from "effect/Schema";
import { ForwardCompatibleArray, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PastedTextAttachmentSource, SnapShotSource } from "./chatAttachment.ts";
import { ComposerContextRecord } from "./composerContext.ts";

export const PROMPT_STASH_MAX_ENTRIES = 50;
export const PROMPT_STASH_MAX_ENTRY_JSON_BYTES = 2_097_152;
export const PROMPT_STASH_CONSUMED_TTL_MS = 24 * 60 * 60 * 1000;

export const PromptStashAttachment = Schema.Struct({
  type: Schema.Literals(["image", "file"]),
  /** Composer-local id; a preview annotation's `screenshotContextId` points at it. */
  id: Schema.String,
  /** Server attachment id. */
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: NonNegativeInt,
  source: Schema.optionalKey(Schema.Union([SnapShotSource, PastedTextAttachmentSource])),
});
export type PromptStashAttachment = typeof PromptStashAttachment.Type;

export const PromptStashSummary = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PromptStashAttachment),
  droppedImageNames: Schema.Array(Schema.String),
  unreadableImageNames: Schema.Array(Schema.String),
  droppedFileNames: Schema.Array(Schema.String),
});
export type PromptStashSummary = typeof PromptStashSummary.Type;

export const PromptStashEntry = Schema.Struct({
  ...PromptStashSummary.fields,
  records: ForwardCompatibleArray(ComposerContextRecord),
});
export type PromptStashEntry = typeof PromptStashEntry.Type;

export const PromptStashPutInput = PromptStashEntry;
export type PromptStashPutInput = typeof PromptStashPutInput.Type;

export const PromptStashPutResult = Schema.Struct({
  summary: PromptStashSummary,
  evictedIds: Schema.Array(Schema.String),
});
export type PromptStashPutResult = typeof PromptStashPutResult.Type;

export const PromptStashTakeInput = Schema.Struct({
  entryId: Schema.String,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type PromptStashTakeInput = typeof PromptStashTakeInput.Type;

export const PromptStashRemoveInput = Schema.Struct({ entryId: Schema.String });
export type PromptStashRemoveInput = typeof PromptStashRemoveInput.Type;

export class PromptStashError extends Schema.TaggedError<PromptStashError>()("PromptStashError", {
  reason: Schema.Literals(["already-taken", "not-found", "entry-too-large", "storage"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Prompt stash failed (${this.reason}): ${this.detail}`;
  }
}
