import {
  PROMPT_STASH_CONSUMED_TTL_MS,
  PROMPT_STASH_MAX_ENTRIES,
  PROMPT_STASH_MAX_ENTRY_JSON_BYTES,
  PromptStashEntry,
  PromptStashError,
  type PromptStashPutInput,
  type PromptStashPutResult,
  type PromptStashRemoveInput,
  type PromptStashSummary,
  type PromptStashTakeInput,
  type ServerConfigPromptStashUpdatedPayload,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  planAttachmentRelabel,
  resolveAttachmentPathById,
  STASH_ATTACHMENT_SEGMENT,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

const CONSUMED_FILE_NAME = "consumed.json";
const RESERVED_ENTRY_ID = "consumed";
const CONSUMED_MAX_RESULTS = 50;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ConsumedRecord = Schema.Struct({
  entryId: Schema.String,
  at: Schema.Number,
  requestId: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(PromptStashEntry),
});
type ConsumedRecord = typeof ConsumedRecord.Type;

const ConsumedFileJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), consumed: Schema.Array(ConsumedRecord) }),
);
/** `receivedAt` is server time, so eviction order does not trust client clocks. */
const EntryFileV2 = Schema.Struct({
  version: Schema.Literal(2),
  receivedAt: Schema.Number,
  entry: PromptStashEntry,
});
// Version 1 files are the bare entry.
const decodeEntryFileExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Union([EntryFileV2, PromptStashEntry])),
);
const encodeEntryFile = Schema.encodeEffect(Schema.fromJsonString(EntryFileV2));
const decodeConsumedFileExit = Schema.decodeUnknownExit(ConsumedFileJson);
const encodeConsumedFile = Schema.encodeEffect(ConsumedFileJson);

interface StoredEntry {
  readonly entry: PromptStashEntry;
  readonly receivedAt: number;
}

interface StoredStash {
  readonly seq: number;
  readonly entries: ReadonlyMap<string, StoredEntry>;
  readonly consumed: ReadonlyMap<string, ConsumedRecord>;
}

interface StashChange {
  readonly seq: number;
  readonly payload: ServerConfigPromptStashUpdatedPayload;
}

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const toSummary = ({ records: _records, ...summary }: PromptStashEntry): PromptStashSummary =>
  summary;

const newestFirst = (a: PromptStashSummary, b: PromptStashSummary) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;

const oldestReceivedFirst = (a: StoredEntry, b: StoredEntry) =>
  a.receivedAt !== b.receivedAt
    ? a.receivedAt - b.receivedAt
    : a.entry.id < b.entry.id
      ? -1
      : a.entry.id > b.entry.id
        ? 1
        : 0;

const storageError = (error: { readonly message: string }) =>
  new PromptStashError({ reason: "storage", detail: error.message });

const pruneConsumed = (consumed: ReadonlyMap<string, ConsumedRecord>, nowMs: number) =>
  new Map([...consumed].filter(([, record]) => nowMs - record.at <= PROMPT_STASH_CONSUMED_TTL_MS));

/** Older records keep their id, which still answers `already-taken`, and drop the stored result. */
const boundConsumedResults = (consumed: ReadonlyMap<string, ConsumedRecord>) => {
  const kept = new Set(
    [...consumed.values()]
      .toReversed()
      .filter((record) => record.result !== undefined)
      .toSorted((a, b) => b.at - a.at)
      .slice(0, CONSUMED_MAX_RESULTS),
  );
  return new Map(
    [...consumed].map(([entryId, record]) => {
      if (record.result === undefined || kept.has(record)) return [entryId, record];
      const { result: _result, ...withoutResult } = record;
      return [entryId, withoutResult];
    }),
  );
};

/** The id an attachment gets under another segment, as `planAttachmentRelabel` names it. */
const relabeledId = (attachmentId: string, from: string, to: string) =>
  `${to}-${attachmentId.slice(from.length + 1)}`.toLowerCase();

export class PromptStash extends Context.Service<
  PromptStash,
  {
    readonly put: (
      entry: PromptStashPutInput,
    ) => Effect.Effect<PromptStashPutResult, PromptStashError>;
    readonly take: (
      input: PromptStashTakeInput,
    ) => Effect.Effect<PromptStashEntry, PromptStashError>;
    readonly remove: (input: PromptStashRemoveInput) => Effect.Effect<void, PromptStashError>;
    /** Subscribes before reading so a change during connection is not lost. */
    readonly streamChanges: Stream.Stream<ServerConfigPromptStashUpdatedPayload>;
  }
>()("t3/promptStash/PromptStash") {}

const make = Effect.gen(function* () {
  const { promptStashDir, attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const consumedPath = path.join(promptStashDir, CONSUMED_FILE_NAME);
  const entryPath = (entryId: string) => path.join(promptStashDir, `${entryId}.json`);

  const writeAtomically = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(storageError),
    );

  /** A file already under the target id counts as moved, so a retry after a crash finds it. */
  const planRelabel = (
    attachmentId: string,
    from: "pending" | "stash",
    to: "pending" | "stash",
  ) => {
    const plan = planAttachmentRelabel({ attachmentsDir, attachmentId, from, to });
    if (plan.ok) return plan;
    if (parseThreadSegmentFromAttachmentId(attachmentId) !== from) return undefined;
    const finalId = relabeledId(attachmentId, from, to);
    const moved = planAttachmentRelabel({
      attachmentsDir,
      attachmentId: finalId,
      from: to,
      to: from,
    });
    return moved.ok
      ? { finalId, currentPath: moved.finalPath, finalPath: moved.currentPath }
      : undefined;
  };

  /**
   * Renames the attachment and its `.txt` sidecar; a missing file yields `undefined`.
   * `touchedAtMs` restarts the pending sweep's 24-hour clock, which ages each file by its own mtime.
   * It is set before the rename, which keeps mtime, so the sweep never sees a stale pending file.
   */
  const relabel = Effect.fn("PromptStash.relabel")(function* (
    attachmentId: string,
    from: "pending" | "stash",
    to: "pending" | "stash",
    touchedAtMs?: number,
  ) {
    const plan = planRelabel(attachmentId, from, to);
    if (plan === undefined) return undefined;
    for (const [currentPath, finalPath] of [
      [plan.currentPath, plan.finalPath],
      [`${plan.currentPath}.txt`, `${plan.finalPath}.txt`],
    ] as const) {
      if (!(yield* fs.exists(currentPath))) continue;
      // Node takes seconds.
      if (touchedAtMs !== undefined) {
        yield* fs.utimes(currentPath, touchedAtMs / 1000, touchedAtMs / 1000);
      }
      yield* fs.rename(currentPath, finalPath);
    }
    return plan;
  });

  const removeAttachmentFiles = Effect.fn("PromptStash.removeAttachmentFiles")(function* (
    entry: PromptStashEntry,
  ) {
    for (const attachment of entry.attachments) {
      const filePath = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: attachment.attachmentId,
      });
      if (filePath === null) continue;
      yield* fs.remove(filePath, { force: true });
      yield* fs.remove(`${filePath}.txt`, { force: true });
    }
  });

  const writeConsumed = (consumed: ReadonlyMap<string, ConsumedRecord>) =>
    encodeConsumedFile({ version: 1, consumed: [...consumed.values()] }).pipe(
      Effect.mapError(storageError),
      Effect.flatMap((contents) => writeAtomically(consumedPath, contents)),
    );

  /**
   * `complete` is false when the directory or any entry file could not be read or decoded.
   * An entry already in `consumed` is a take that died before deleting it; the delete finishes here.
   */
  const loadEntries = Effect.fn("PromptStash.loadEntries")(function* (
    consumed: ReadonlyMap<string, ConsumedRecord>,
  ) {
    const entries = new Map<string, StoredEntry>();
    const names = yield* fs.readDirectory(promptStashDir).pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed([])
          : Effect.logWarning("could not read prompt stash directory", {
              path: promptStashDir,
              detail: error.message,
            }).pipe(Effect.as(undefined)),
      ),
    );
    if (names === undefined) return { entries, complete: false };
    let complete = true;
    for (const name of names) {
      if (!name.endsWith(".json") || name === CONSUMED_FILE_NAME) continue;
      const filePath = path.join(promptStashDir, name);
      const warnUnreadable = Effect.catch((error: PlatformError.PlatformError) =>
        Effect.logWarning("ignoring unreadable prompt stash entry", {
          path: filePath,
          detail: error.message,
        }).pipe(Effect.as(undefined)),
      );
      const raw = yield* fs.readFileString(filePath).pipe(warnUnreadable);
      if (raw === undefined) {
        complete = false;
        continue;
      }
      const decoded = decodeEntryFileExit(raw);
      const file = decoded._tag === "Success" ? decoded.value : undefined;
      const entry = file !== undefined && "entry" in file ? file.entry : file;
      if (file === undefined || entry === undefined || `${entry.id}.json` !== name) {
        yield* Effect.logWarning("ignoring invalid prompt stash entry", {
          path: filePath,
          detail: decoded._tag === "Failure" ? Cause.pretty(decoded.cause) : "id mismatch",
        });
        complete = false;
        continue;
      }
      if (consumed.has(entry.id)) {
        yield* fs.remove(filePath, { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not remove a taken prompt stash entry", {
              path: filePath,
              detail: error.message,
            }),
          ),
        );
        continue;
      }
      if ("receivedAt" in file) {
        entries.set(entry.id, { entry, receivedAt: file.receivedAt });
        continue;
      }
      const info = yield* fs.stat(filePath).pipe(warnUnreadable);
      if (info === undefined) {
        complete = false;
        continue;
      }
      entries.set(entry.id, {
        entry,
        receivedAt: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
      });
    }
    return { entries, complete };
  });

  const loadConsumed = Effect.gen(function* () {
    const raw = yield* fs.readFileString(consumedPath).pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.undefined
          : Effect.logWarning("ignoring unreadable prompt stash consumed ids", {
              path: consumedPath,
              detail: error.message,
            }).pipe(Effect.as(undefined)),
      ),
    );
    if (raw === undefined) return new Map<string, ConsumedRecord>();
    const decoded = decodeConsumedFileExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("ignoring invalid prompt stash consumed ids", {
        path: consumedPath,
        detail: Cause.pretty(decoded.cause),
      });
      return new Map<string, ConsumedRecord>();
    }
    return pruneConsumed(
      new Map(decoded.value.consumed.map((record) => [record.entryId, record])),
      yield* Clock.currentTimeMillis,
    );
  });

  /**
   * Finishes renames a put or take left half-done when the process died before its entry file
   * changed: a stored entry gets its `stash-*` files back, and `stash-*` files no entry owns
   * return to `pending-*` so the client's retried put finds them and the pending sweep owns them.
   * Unless every entry loaded, no `stash-*` file is known to be unowned, so all of them stay.
   */
  const repairStashFiles = Effect.fn("PromptStash.repairStashFiles")(function* (
    entries: ReadonlyMap<string, StoredEntry>,
    complete: boolean,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const warnOnFailure = (message: string, attachmentId: string) =>
      Effect.catch((error: PlatformError.PlatformError) =>
        Effect.logWarning(message, { attachmentId, detail: error.message }),
      );

    const referenced = new Set<string>();
    for (const { entry } of entries.values()) {
      for (const { attachmentId } of entry.attachments) {
        referenced.add(attachmentId.toLowerCase());
        if (
          parseThreadSegmentFromAttachmentId(attachmentId) !== STASH_ATTACHMENT_SEGMENT ||
          resolveAttachmentPathById({ attachmentsDir, attachmentId }) !== null
        ) {
          continue;
        }
        const pendingId = `pending-${attachmentId.slice(STASH_ATTACHMENT_SEGMENT.length + 1)}`;
        yield* relabel(pendingId, "pending", STASH_ATTACHMENT_SEGMENT).pipe(
          warnOnFailure("could not restore stash attachment", attachmentId),
        );
      }
    }
    if (!complete) {
      return yield* Effect.logWarning(
        "keeping unreferenced stash attachments because a prompt stash entry did not load",
      );
    }

    const names = yield* fs
      .readDirectory(attachmentsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const unreferenced = new Map<string, Array<string>>();
    for (const name of names) {
      const attachmentId = parseAttachmentIdFromRelativePath(
        name.endsWith(".txt") && name.slice(0, -4).includes(".") ? name.slice(0, -4) : name,
      );
      if (
        attachmentId === null ||
        parseThreadSegmentFromAttachmentId(attachmentId) !== STASH_ATTACHMENT_SEGMENT ||
        referenced.has(attachmentId.toLowerCase())
      ) {
        continue;
      }
      unreferenced.set(attachmentId, [...(unreferenced.get(attachmentId) ?? []), name]);
    }
    for (const [attachmentId, fileNames] of unreferenced) {
      if (resolveAttachmentPathById({ attachmentsDir, attachmentId }) !== null) {
        yield* relabel(attachmentId, STASH_ATTACHMENT_SEGMENT, "pending", nowMs).pipe(
          warnOnFailure("could not return stash attachment to pending", attachmentId),
        );
        continue;
      }
      // Only a sidecar without its attachment is left.
      for (const name of fileNames) {
        yield* fs
          .remove(path.join(attachmentsDir, name), { force: true })
          .pipe(warnOnFailure("could not remove orphaned stash sidecar", attachmentId));
      }
    }
  });

  const initialConsumed = yield* loadConsumed;
  const initial = yield* loadEntries(initialConsumed);
  yield* repairStashFiles(initial.entries, initial.complete);

  const stored = yield* Ref.make<StoredStash>({
    seq: 0,
    entries: initial.entries,
    consumed: initialConsumed,
  });
  const changes = yield* PubSub.unbounded<StashChange>();
  const semaphore = yield* Semaphore.make(1);

  const commit = Effect.fn("PromptStash.commit")(function* (
    next: Omit<StoredStash, "seq">,
    payload: Omit<ServerConfigPromptStashUpdatedPayload, "replace">,
  ) {
    const current = yield* Ref.get(stored);
    // Subscribers drop updates not newer than the snapshot they read.
    const seq = current.seq + 1;
    yield* Ref.set(stored, { seq, ...next });
    yield* PubSub.publish(changes, { seq, payload: { ...payload, replace: false } });
  });

  const put = Effect.fn("PromptStash.put")(function* (entry: PromptStashPutInput) {
    if (byteLength(entry) > PROMPT_STASH_MAX_ENTRY_JSON_BYTES) {
      return yield* new PromptStashError({
        reason: "entry-too-large",
        detail: `The entry is larger than ${PROMPT_STASH_MAX_ENTRY_JSON_BYTES} bytes.`,
      });
    }
    if (!ENTRY_ID_PATTERN.test(entry.id) || entry.id.toLowerCase() === RESERVED_ENTRY_ID) {
      return yield* new PromptStashError({ reason: "storage", detail: "Invalid entry id." });
    }
    const current = yield* Ref.get(stored);
    // Entry files are named by id and macOS file names ignore case.
    const sameId = (id: string) => id.toLowerCase() === entry.id.toLowerCase();
    const existing = [...current.entries.values()].find((candidate) => sameId(candidate.entry.id));
    if (existing !== undefined) return { summary: toSummary(existing.entry), evictedIds: [] };
    if ([...current.consumed.keys()].some(sameId)) {
      return yield* new PromptStashError({
        reason: "already-taken",
        detail: `Entry ${entry.id} was already taken or removed.`,
      });
    }

    const receivedAt = yield* Clock.currentTimeMillis;
    let entryWriteStarted = false;
    return yield* Effect.gen(function* () {
      const attachments: Array<PromptStashEntry["attachments"][number]> = [];
      const droppedImageNames = [...entry.droppedImageNames];
      const droppedFileNames = [...entry.droppedFileNames];
      for (const attachment of entry.attachments) {
        const plan = yield* relabel(attachment.attachmentId, "pending", STASH_ATTACHMENT_SEGMENT);
        if (plan !== undefined) {
          attachments.push({ ...attachment, attachmentId: plan.finalId });
        } else if (attachment.type === "image") {
          droppedImageNames.push(attachment.name);
        } else {
          droppedFileNames.push(attachment.name);
        }
      }
      const storedEntry: PromptStashEntry = {
        ...entry,
        attachments,
        droppedImageNames,
        droppedFileNames,
      };
      const contents = yield* encodeEntryFile({ version: 2, receivedAt, entry: storedEntry }).pipe(
        Effect.mapError(storageError),
      );
      entryWriteStarted = true;
      yield* writeAtomically(entryPath(storedEntry.id), contents);

      const entries = new Map(current.entries).set(storedEntry.id, {
        entry: storedEntry,
        receivedAt,
      });
      const evicted = [...entries.values()]
        .filter((candidate) => candidate.entry.id !== storedEntry.id)
        .toSorted(oldestReceivedFirst)
        .slice(0, Math.max(0, entries.size - PROMPT_STASH_MAX_ENTRIES))
        .map((candidate) => candidate.entry);
      let consumed = current.consumed;
      if (evicted.length > 0) {
        const nowMs = yield* Clock.currentTimeMillis;
        const nextConsumed = pruneConsumed(consumed, nowMs);
        for (const evictedEntry of evicted) {
          yield* removeAttachmentFiles(evictedEntry);
          yield* fs.remove(entryPath(evictedEntry.id), { force: true });
          entries.delete(evictedEntry.id);
          nextConsumed.set(evictedEntry.id, { entryId: evictedEntry.id, at: nowMs });
        }
        yield* writeConsumed(nextConsumed);
        consumed = nextConsumed;
      }

      const summary = toSummary(storedEntry);
      const evictedIds = evicted.map((evictedEntry) => evictedEntry.id);
      yield* commit({ entries, consumed }, { upserted: [summary], removedIds: evictedIds });
      return { summary, evictedIds };
    }).pipe(Effect.onError(() => rollbackPut(entry, entryWriteStarted)));
  });

  /** The client keeps a failed put locally, so its files must be live `pending-*` files again. */
  const rollbackPut = Effect.fn("PromptStash.rollbackPut")(function* (
    entry: PromptStashPutInput,
    entryWriteStarted: boolean,
  ) {
    if (entryWriteStarted) {
      yield* fs.remove(entryPath(entry.id), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not remove a failed prompt stash entry", {
            entryId: entry.id,
            detail: error.message,
          }),
        ),
      );
    }
    for (const { attachmentId } of entry.attachments) {
      if (parseThreadSegmentFromAttachmentId(attachmentId) !== "pending") continue;
      const stashId = relabeledId(attachmentId, "pending", STASH_ATTACHMENT_SEGMENT);
      yield* relabel(stashId, STASH_ATTACHMENT_SEGMENT, "pending").pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not return stash attachment to pending", {
            attachmentId: stashId,
            detail: error.message,
          }),
        ),
      );
    }
  });

  const take = Effect.fn("PromptStash.take")(function* ({
    entryId,
    requestId,
  }: PromptStashTakeInput) {
    const current = yield* Ref.get(stored);
    const record = current.consumed.get(entryId);
    if (record !== undefined) {
      if (record.requestId === requestId && record.result !== undefined) return record.result;
      return yield* new PromptStashError({
        reason: "already-taken",
        detail: `Entry ${entryId} was already taken or removed.`,
      });
    }
    const entry = current.entries.get(entryId)?.entry;
    if (entry === undefined) {
      return yield* new PromptStashError({
        reason: "not-found",
        detail: `Entry ${entryId} is not in the stash.`,
      });
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const attachments: Array<PromptStashEntry["attachments"][number]> = [];
    const droppedImageNames = [...entry.droppedImageNames];
    const droppedFileNames = [...entry.droppedFileNames];
    for (const attachment of entry.attachments) {
      const plan = yield* relabel(
        attachment.attachmentId,
        STASH_ATTACHMENT_SEGMENT,
        "pending",
        nowMs,
      );
      if (plan === undefined) {
        (attachment.type === "image" ? droppedImageNames : droppedFileNames).push(attachment.name);
        continue;
      }
      attachments.push({ ...attachment, attachmentId: plan.finalId });
    }
    const result: PromptStashEntry = { ...entry, attachments, droppedImageNames, droppedFileNames };

    // The result lands before the entry file goes, so a retry after a crash can return it.
    const consumed = boundConsumedResults(
      pruneConsumed(current.consumed, nowMs).set(entryId, {
        entryId,
        at: nowMs,
        requestId,
        result,
      }),
    );
    yield* writeConsumed(consumed);
    yield* fs.remove(entryPath(entryId), { force: true });

    const entries = new Map(current.entries);
    entries.delete(entryId);
    yield* commit({ entries, consumed }, { upserted: [], removedIds: [entryId] });
    return result;
  });

  const remove = Effect.fn("PromptStash.remove")(function* ({ entryId }: PromptStashRemoveInput) {
    const current = yield* Ref.get(stored);
    const entry = current.entries.get(entryId)?.entry;
    if (entry === undefined) return;

    yield* removeAttachmentFiles(entry);
    yield* fs.remove(entryPath(entryId), { force: true });

    const nowMs = yield* Clock.currentTimeMillis;
    const entries = new Map(current.entries);
    entries.delete(entryId);
    const consumed = pruneConsumed(current.consumed, nowMs).set(entryId, { entryId, at: nowMs });
    yield* writeConsumed(consumed);
    yield* commit({ entries, consumed }, { upserted: [], removedIds: [entryId] });
  });

  const serialized = <A>(
    effect: Effect.Effect<A, PromptStashError | PlatformError.PlatformError>,
  ) =>
    semaphore.withPermits(1)(
      // A client disconnect interrupts its RPC handler; a half-run mutation would strand files.
      Effect.uninterruptible(
        effect.pipe(
          Effect.catchTags({ PlatformError: (error) => Effect.fail(storageError(error)) }),
        ),
      ),
    );

  return {
    put: (entry) => serialized(put(entry)),
    take: (input) => serialized(take(input)),
    remove: (input) => serialized(remove(input)),
    streamChanges: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* Ref.get(stored);
        return Stream.concat(
          Stream.make({
            upserted: [...snapshot.entries.values()]
              .map(({ entry }) => toSummary(entry))
              .toSorted(newestFirst),
            removedIds: [],
            replace: true,
          }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.seq > snapshot.seq),
            Stream.map((change) => change.payload),
          ),
        );
      }),
    ),
  } satisfies PromptStash["Service"];
});

export const layer = Layer.effect(PromptStash, make);
