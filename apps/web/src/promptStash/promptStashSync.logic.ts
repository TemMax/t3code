import type { EnvironmentId, PromptStashPutInput, PromptStashSummary } from "@t3tools/contracts";

import type { PendingStashTake, PromptStashEntry } from "../promptStashStore";

/** Local entries already on a server go; the rest upload oldest first, once their images are encoded. */
export function planLocalStashUploads(
  local: ReadonlyArray<PromptStashEntry>,
  serverIds: ReadonlySet<string>,
): { readonly drop: string[]; readonly upload: PromptStashEntry[] } {
  const drop: string[] = [];
  const pending: Array<{ readonly entry: PromptStashEntry; readonly index: number }> = [];
  local.forEach((entry, index) => {
    if (serverIds.has(entry.id)) drop.push(entry.id);
    else if (!entry.pendingImageCount) pending.push({ entry, index });
  });
  // The store lists newest first, so equal timestamps order by position from the end.
  pending.sort((a, b) =>
    a.entry.createdAt === b.entry.createdAt
      ? b.index - a.index
      : a.entry.createdAt < b.entry.createdAt
        ? -1
        : 1,
  );
  return { drop, upload: pending.map(({ entry }) => entry) };
}

/** Null when several environments could take the entry and nothing picks one. */
export function targetEnvironmentForLocalEntry(
  entry: PromptStashEntry,
  primary: EnvironmentId | null,
  writable: ReadonlyArray<EnvironmentId>,
): EnvironmentId | null {
  return (
    entry.environmentId ??
    entry.files?.[0]?.environmentId ??
    primary ??
    (writable.length === 1 ? (writable[0] ?? null) : null)
  );
}

export type StashPutOutcome =
  | {
      readonly _tag: "stored";
      readonly summary: PromptStashSummary;
      readonly evictedIds: ReadonlyArray<string>;
    }
  | { readonly _tag: "already-taken" }
  | { readonly _tag: "too-large" }
  | { readonly _tag: "failed" };

/** A taken entry lives on a server already, so it leaves the local queue like a stored one. */
export function applyPutOutcome(id: string, outcome: StashPutOutcome["_tag"]): string[] {
  return outcome === "stored" || outcome === "already-taken" ? [id] : [];
}

/** The entry's own id never counts: a server that dropped it says so through another path. */
export function evictedOtherEntries(evictedIds: ReadonlyArray<string>, entryId: string): boolean {
  return evictedIds.some((id) => id !== entryId);
}

// The server keeps an upload's suffix when it moves `pending-<suffix>` to `stash-<suffix>`.
const attachmentSuffix = (attachmentId: string) =>
  attachmentId.slice(attachmentId.indexOf("-") + 1);

function uploadsNotKept(
  uploaded: ReadonlyArray<string>,
  summary: Pick<PromptStashSummary, "attachments">,
): string[] {
  const kept = new Set(
    summary.attachments.map((attachment) => attachmentSuffix(attachment.attachmentId)),
  );
  return uploaded.filter((attachmentId) => !kept.has(attachmentSuffix(attachmentId)));
}

function stashPutInput(
  entry: PromptStashEntry,
  imageAttachmentIds: ReadonlyArray<string>,
): PromptStashPutInput {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    prompt: entry.prompt,
    attachments: [
      ...entry.attachments.flatMap((image, index) => {
        const attachmentId = imageAttachmentIds[index];
        return attachmentId
          ? [
              {
                type: "image" as const,
                id: image.id,
                attachmentId,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                ...(image.source ? { source: image.source } : {}),
              },
            ]
          : [];
      }),
      ...(entry.files ?? []).map((file) => ({
        type: "file" as const,
        id: file.id,
        attachmentId: file.attachmentId,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        ...(file.source ? { source: file.source } : {}),
      })),
    ],
    droppedImageNames: [...entry.droppedImageNames],
    unreadableImageNames: [...(entry.unreadableImageNames ?? [])],
    droppedFileNames: [],
    records: entry.records ?? [],
  };
}

export interface StashSyncPassDeps {
  /** The local queue as storage holds it, read again right before each put. */
  readonly readEntries: () => ReadonlyArray<PromptStashEntry>;
  readonly serverIds: ReadonlySet<string>;
  /** Where an entry uploads; null while nowhere writable can take it. */
  readonly targetFor: (entry: PromptStashEntry) => EnvironmentId | null;
  /** Entries this pass leaves alone: being restored, or known to be too large. */
  readonly isHeld: (entryId: string) => boolean;
  /** Uploads the entry's images in order; `complete` is false when one failed midway. */
  readonly uploadImages: (
    entry: PromptStashEntry,
    environmentId: EnvironmentId,
  ) => Promise<{ readonly attachmentIds: ReadonlyArray<string>; readonly complete: boolean }>;
  readonly put: (
    input: PromptStashPutInput,
    environmentId: EnvironmentId,
  ) => Promise<StashPutOutcome>;
  readonly deleteUploads: (
    environmentId: EnvironmentId,
    attachmentIds: ReadonlyArray<string>,
  ) => void;
  readonly dropEntries: (ids: ReadonlyArray<string>) => void;
  /** Told as an entry starts uploading; settles with whether the server kept it. */
  readonly onUpload?: (entryId: string, settled: Promise<"local" | "stored">) => void;
}

export interface StashSyncPassResult {
  /** An entry failed in a way a later pass may fix. */
  readonly retry: boolean;
  /** A put pushed out some other entry. */
  readonly evicted: boolean;
  readonly tooLarge: ReadonlyArray<string>;
}

/**
 * Uploads every local entry that has somewhere to go. Uploads that end up owned by no stored
 * entry are deleted here, since nothing else knows about them.
 */
export async function runStashSyncPass(deps: StashSyncPassDeps): Promise<StashSyncPassResult> {
  const { drop, upload } = planLocalStashUploads(deps.readEntries(), deps.serverIds);
  if (drop.length > 0) deps.dropEntries(drop);
  let retry = false;
  let evicted = false;
  const tooLarge: string[] = [];
  for (const entry of upload) {
    if (deps.isHeld(entry.id)) continue;
    const environmentId = deps.targetFor(entry);
    if (environmentId === null) continue;
    let settle: (outcome: "local" | "stored") => void = () => {};
    deps.onUpload?.(
      entry.id,
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    let outcome: StashPutOutcome["_tag"] | "skipped" = "failed";
    try {
      const { attachmentIds, complete } = await deps.uploadImages(entry, environmentId);
      let orphaned: ReadonlyArray<string> = attachmentIds;
      if (!complete) {
        retry = true;
      } else if (
        deps.isHeld(entry.id) ||
        !deps.readEntries().some((candidate) => candidate.id === entry.id)
      ) {
        outcome = "skipped";
      } else {
        const result = await deps.put(stashPutInput(entry, attachmentIds), environmentId);
        outcome = result._tag;
        if (result._tag === "stored") {
          orphaned = uploadsNotKept(attachmentIds, result.summary);
          if (evictedOtherEntries(result.evictedIds, entry.id)) evicted = true;
        } else if (result._tag === "too-large") {
          tooLarge.push(entry.id);
        } else if (result._tag === "failed") {
          retry = true;
        }
      }
      if (orphaned.length > 0) deps.deleteUploads(environmentId, orphaned);
      const done = outcome === "skipped" ? [] : applyPutOutcome(entry.id, outcome);
      if (done.length > 0) deps.dropEntries(done);
    } finally {
      settle(outcome === "stored" ? "stored" : "local");
    }
  }
  return { retry, evicted, tooLarge };
}

const OTHER_TAB_TAKE_GRACE_MS = 2 * 60 * 1000;

/**
 * Lost takes worth asking about again. Another tab's record may still have its take in flight,
 * so those wait a grace period; this tab's own are abandoned once nothing here is taking them.
 */
export function retryablePendingTakes(
  takes: ReadonlyArray<PendingStashTake>,
  context: {
    readonly connected: ReadonlySet<string>;
    readonly taking: ReadonlySet<string>;
    readonly ownRequestIds: ReadonlySet<string>;
    readonly now: number;
  },
): PendingStashTake[] {
  return takes.filter(
    (take) =>
      context.connected.has(take.environmentId) &&
      !context.taking.has(take.entryId) &&
      (context.ownRequestIds.has(take.requestId) ||
        context.now - Date.parse(take.at) >= OTHER_TAB_TAKE_GRACE_MS),
  );
}

export type StashMenuItem =
  | { readonly kind: "local"; readonly entry: PromptStashEntry }
  | {
      readonly kind: "server";
      readonly environmentId: EnvironmentId;
      readonly summary: PromptStashSummary;
    };

export function stashMenuItemId(item: StashMenuItem): string {
  return item.kind === "local" ? item.entry.id : item.summary.id;
}

function stashMenuItemCreatedAt(item: StashMenuItem): string {
  return item.kind === "local" ? item.entry.createdAt : item.summary.createdAt;
}

/** Newest first; a local entry already on a server shows once, as the server's. */
export function mergeStashMenuItems(
  local: ReadonlyArray<PromptStashEntry>,
  server: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly summaries: ReadonlyArray<PromptStashSummary>;
  }>,
): StashMenuItem[] {
  const items: StashMenuItem[] = server.flatMap(({ environmentId, summaries }) =>
    summaries.map((summary) => ({ kind: "server" as const, environmentId, summary })),
  );
  const serverIds = new Set(
    server.flatMap(({ summaries }) => summaries.map((summary) => summary.id)),
  );
  for (const entry of local) {
    if (!serverIds.has(entry.id)) items.push({ kind: "local", entry });
  }
  return items.toSorted((a, b) => {
    const aAt = stashMenuItemCreatedAt(a);
    const bAt = stashMenuItemCreatedAt(b);
    return aAt === bAt ? 0 : aAt < bAt ? 1 : -1;
  });
}
