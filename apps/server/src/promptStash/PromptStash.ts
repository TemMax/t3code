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
const EntryFileJson = Schema.fromJsonString(PromptStashEntry);
const decodeEntryFileExit = Schema.decodeUnknownExit(EntryFileJson);
const encodeEntryFile = Schema.encodeEffect(EntryFileJson);
const decodeConsumedFileExit = Schema.decodeUnknownExit(ConsumedFileJson);
const encodeConsumedFile = Schema.encodeEffect(ConsumedFileJson);

interface StoredStash {
  readonly seq: number;
  readonly entries: ReadonlyMap<string, PromptStashEntry>;
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

const storageError = (error: { readonly message: string }) =>
  new PromptStashError({ reason: "storage", detail: error.message });

const pruneConsumed = (consumed: ReadonlyMap<string, ConsumedRecord>, nowMs: number) =>
  new Map([...consumed].filter(([, record]) => nowMs - record.at <= PROMPT_STASH_CONSUMED_TTL_MS));

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

  /** Renames the attachment and its `.txt` sidecar; a missing file yields `undefined`. */
  const relabel = Effect.fn("PromptStash.relabel")(function* (
    attachmentId: string,
    from: "pending" | "stash",
    to: "pending" | "stash",
  ) {
    const plan = planAttachmentRelabel({ attachmentsDir, attachmentId, from, to });
    if (!plan.ok) return undefined;
    yield* fs.rename(plan.currentPath, plan.finalPath);
    if (yield* fs.exists(`${plan.currentPath}.txt`)) {
      yield* fs.rename(`${plan.currentPath}.txt`, `${plan.finalPath}.txt`);
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

  const loadEntries = Effect.gen(function* () {
    const names = yield* fs.readDirectory(promptStashDir).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
    );
    const entries = new Map<string, PromptStashEntry>();
    for (const name of names) {
      if (!name.endsWith(".json") || name === CONSUMED_FILE_NAME) continue;
      const filePath = path.join(promptStashDir, name);
      const raw = yield* fs.readFileString(filePath).pipe(
        Effect.catch((error) =>
          Effect.logWarning("ignoring unreadable prompt stash entry", {
            path: filePath,
            detail: error.message,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (raw === undefined) continue;
      const decoded = decodeEntryFileExit(raw);
      if (decoded._tag === "Failure" || `${decoded.value.id}.json` !== name) {
        yield* Effect.logWarning("ignoring invalid prompt stash entry", {
          path: filePath,
          detail: decoded._tag === "Failure" ? Cause.pretty(decoded.cause) : "id mismatch",
        });
        continue;
      }
      entries.set(decoded.value.id, decoded.value);
    }
    return entries;
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

  /** A put or take that died before writing its entry file leaves `stash-*` files nobody owns. */
  const sweepUnreferencedStashFiles = Effect.fn("PromptStash.sweepUnreferencedStashFiles")(
    function* (entries: ReadonlyMap<string, PromptStashEntry>) {
      const referenced = new Set(
        [...entries.values()].flatMap((entry) =>
          entry.attachments.map((attachment) => attachment.attachmentId.toLowerCase()),
        ),
      );
      const names = yield* fs
        .readDirectory(attachmentsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
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
        yield* fs.remove(path.join(attachmentsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not remove unreferenced stash attachment", {
              name,
              detail: error.message,
            }),
          ),
        );
      }
    },
  );

  const initialEntries = yield* loadEntries.pipe(
    Effect.catch((error) =>
      Effect.logWarning("could not read prompt stash directory", {
        path: promptStashDir,
        detail: error.message,
      }).pipe(Effect.as(new Map<string, PromptStashEntry>())),
    ),
  );
  const initialConsumed = yield* loadConsumed;
  yield* sweepUnreferencedStashFiles(initialEntries);

  const stored = yield* Ref.make<StoredStash>({
    seq: 0,
    entries: initialEntries,
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
    if (!ENTRY_ID_PATTERN.test(entry.id)) {
      return yield* new PromptStashError({ reason: "storage", detail: "Invalid entry id." });
    }
    const current = yield* Ref.get(stored);
    const existing = current.entries.get(entry.id);
    if (existing !== undefined) return { summary: toSummary(existing), evictedIds: [] };
    if (current.consumed.has(entry.id)) {
      return yield* new PromptStashError({
        reason: "already-taken",
        detail: `Entry ${entry.id} was already taken or removed.`,
      });
    }

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
    yield* writeAtomically(
      entryPath(storedEntry.id),
      yield* encodeEntryFile(storedEntry).pipe(Effect.mapError(storageError)),
    );

    const entries = new Map(current.entries).set(storedEntry.id, storedEntry);
    const evicted = [...entries.values()]
      .map(toSummary)
      .toSorted(newestFirst)
      .slice(PROMPT_STASH_MAX_ENTRIES)
      .map((summary) => entries.get(summary.id)!);
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
    yield* commit(
      { entries, consumed },
      { upserted: entries.has(summary.id) ? [summary] : [], removedIds: evictedIds },
    );
    return { summary, evictedIds };
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
    const entry = current.entries.get(entryId);
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
      const plan = yield* relabel(attachment.attachmentId, STASH_ATTACHMENT_SEGMENT, "pending");
      if (plan === undefined) {
        (attachment.type === "image" ? droppedImageNames : droppedFileNames).push(attachment.name);
        continue;
      }
      // The pending sweep ages files by mtime; count from the take. Node takes seconds.
      yield* fs.utimes(plan.finalPath, nowMs / 1000, nowMs / 1000);
      attachments.push({ ...attachment, attachmentId: plan.finalId });
    }
    const result: PromptStashEntry = { ...entry, attachments, droppedImageNames, droppedFileNames };
    yield* fs.remove(entryPath(entryId), { force: true });

    const entries = new Map(current.entries);
    entries.delete(entryId);
    const consumed = pruneConsumed(current.consumed, nowMs).set(entryId, {
      entryId,
      at: nowMs,
      requestId,
      result,
    });
    yield* writeConsumed(consumed);
    yield* commit({ entries, consumed }, { upserted: [], removedIds: [entryId] });
    return result;
  });

  const remove = Effect.fn("PromptStash.remove")(function* ({ entryId }: PromptStashRemoveInput) {
    const current = yield* Ref.get(stored);
    const entry = current.entries.get(entryId);
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
      effect.pipe(Effect.catchTags({ PlatformError: (error) => Effect.fail(storageError(error)) })),
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
            upserted: [...snapshot.entries.values()].map(toSummary).toSorted(newestFirst),
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
