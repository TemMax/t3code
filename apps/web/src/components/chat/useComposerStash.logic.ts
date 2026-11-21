import type { EnvironmentId } from "@t3tools/contracts";

import { stashMenuItemId, type StashMenuItem } from "../../promptStash/promptStashSync.logic";

/**
 * After a stash, the composer uploads to let go of and the ones to delete. A server entry owns
 * its images, annotation screenshots included, so those are only forgotten.
 */
export function stashUploadCleanup(input: {
  readonly imageIds: ReadonlyArray<string>;
  readonly annotationIds: ReadonlyArray<string>;
  readonly storedOnServer: boolean;
}): { readonly forget: string[]; readonly release: string[] } {
  if (!input.storedOnServer) {
    return { forget: [], release: [...new Set([...input.annotationIds, ...input.imageIds])] };
  }
  const imageIds = new Set(input.imageIds);
  return {
    forget: [...imageIds],
    release: input.annotationIds.filter((id) => !imageIds.has(id)),
  };
}

/**
 * Names behind each "not restored" reason. A server entry's dropped names were not kept by the
 * server; a local entry's images exceeded its size budget.
 */
export function missingAttachmentGroups(input: {
  readonly origin: "local" | "server";
  readonly droppedImageNames: ReadonlyArray<string>;
  readonly droppedFileNames: ReadonlyArray<string>;
  readonly expiredFileNames: ReadonlyArray<string>;
}): {
  readonly overSizeLimit: ReadonlyArray<string>;
  readonly notKept: ReadonlyArray<string>;
  readonly expired: ReadonlyArray<string>;
} {
  return input.origin === "server"
    ? {
        overSizeLimit: [],
        notKept: [...input.droppedImageNames, ...input.droppedFileNames],
        expired: input.expiredFileNames,
      }
    : {
        overSizeLimit: input.droppedImageNames,
        notKept: [],
        expired: [...input.droppedFileNames, ...input.expiredFileNames],
      };
}

/** Attachments live on one server, so only a text-only entry restores in another environment. */
export function canRestoreServerEntryIn(
  environmentId: EnvironmentId,
  source: { readonly environmentId: EnvironmentId; readonly hasAttachments: boolean },
): boolean {
  return source.environmentId === environmentId || !source.hasAttachments;
}

/** The one entry the empty-composer shortcut restores, ignoring entries already being taken. */
export function soleRestorableStashItem(
  items: ReadonlyArray<StashMenuItem>,
  taking: ReadonlySet<string>,
): StashMenuItem | undefined {
  const available = items.filter((item) => !taking.has(stashMenuItemId(item)));
  const item = available.length === 1 ? available[0] : undefined;
  return item && !(item.kind === "local" && item.entry.pendingImageCount) ? item : undefined;
}
