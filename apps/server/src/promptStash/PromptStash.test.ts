import {
  ComposerContextId,
  PROMPT_STASH_CONSUMED_TTL_MS,
  PROMPT_STASH_MAX_ENTRY_JSON_BYTES,
  type PromptStashAttachment,
  type PromptStashEntry,
  type PromptStashError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { sweepStalePendingAttachments } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as PromptStash from "./PromptStash.ts";

const NOW_MS = Date.parse("2026-11-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const layerConfig = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-prompt-stash-test-" }),
);
const layerPromptStash = PromptStash.layer.pipe(Layer.provideMerge(layerConfig));

const uuidFor = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const image = (n: number, name = `shot-${n}.png`): PromptStashAttachment => ({
  type: "image",
  id: `image-${n}`,
  attachmentId: `pending-${uuidFor(n)}`,
  name,
  mimeType: "image/png",
  sizeBytes: 2,
});

const file = (n: number, name = `notes-${n}.pdf`): PromptStashAttachment => ({
  type: "file",
  id: `file-${n}`,
  attachmentId: `pending-${uuidFor(n)}-pdf`,
  name,
  mimeType: "application/pdf",
  sizeBytes: 3,
});

const entry = (
  id: string,
  attachments: ReadonlyArray<PromptStashAttachment> = [],
  createdAt = "2026-11-20T10:00:00.000Z",
): PromptStashEntry => ({
  id,
  createdAt,
  prompt: `prompt ${id}`,
  attachments,
  droppedImageNames: [],
  unreadableImageNames: [],
  droppedFileNames: [],
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(`mention-${id}`),
      label: "a.ts",
      kind: "mention",
      path: "src/a.ts",
    },
  ],
});

const dirs = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const attachmentPath = (name: string) => path.join(config.attachmentsDir, name);
  return {
    fs,
    attachmentsDir: config.attachmentsDir,
    promptStashDir: config.promptStashDir,
    attachmentPath,
    entryPath: (id: string) => path.join(config.promptStashDir, `${id}.json`),
    exists: (name: string) => fs.exists(attachmentPath(name)),
    write: (name: string) => fs.writeFileString(attachmentPath(name), "px"),
  };
});

/** Writes the uploaded file each pending attachment points at. */
const upload = Effect.fn(function* (attachments: ReadonlyArray<PromptStashAttachment>) {
  const { write } = yield* dirs;
  for (const attachment of attachments) {
    yield* write(
      attachment.type === "image"
        ? `${attachment.attachmentId}.png`
        : `${attachment.attachmentId}.pdf`,
    );
  }
});

const failureOf = <A>(effect: Effect.Effect<A, PromptStashError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

type FsHook = (
  operation: "rename" | "utimes",
  path: string,
) => Effect.Effect<void, PlatformError.PlatformError>;

/** A prompt stash whose renames and utimes run `hook` first. */
const layerStashWithFsHook = (hook: FsHook) =>
  PromptStash.layer.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          rename: (from: string, to: string) =>
            hook("rename", from).pipe(Effect.andThen(fs.rename(from, to))),
          utimes: (path: string, atime: Date | number, mtime: Date | number) =>
            hook("utimes", path).pipe(Effect.andThen(fs.utimes(path, atime, mtime))),
        })),
      ),
    ),
  );

/** Holds the first rename of a matching path until `release`, signalling `reached` once there. */
const blockFirstRename = Effect.fn(function* (matches: (path: string) => boolean) {
  const reached = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let armed = true;
  const hook: FsHook = (operation, path) => {
    if (!armed || operation !== "rename" || !matches(path)) return Effect.void;
    armed = false;
    return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)));
  };
  return { hook, reached, release };
});

/** Interrupts `fiber` while it is held in a blocked rename, then lets the rename go on. */
const interruptWhileBlocked = Effect.fn(function* <A, E>(
  fiber: Fiber.Fiber<A, E>,
  blocked: { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> },
) {
  yield* Deferred.await(blocked.reached);
  const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), {
    startImmediately: true,
  });
  yield* Deferred.succeed(blocked.release, undefined);
  yield* Fiber.join(interrupting);
});

it.layer(NodeServices.layer)("PromptStash", (it) => {
  it.effect("put moves pending attachments to stash ids and stores the entry", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { exists, entryPath, fs, write } = yield* dirs;
      const attachments = [image(1), file(2)];
      yield* upload(attachments);
      yield* write(`pending-${uuidFor(2)}-pdf.pdf.txt`);

      const { summary, evictedIds } = yield* stash.put(entry("a", attachments));

      assert.deepEqual(evictedIds, []);
      assert.notProperty(summary, "records");
      assert.deepEqual(
        summary.attachments.map((attachment) => attachment.attachmentId),
        [`stash-${uuidFor(1)}`, `stash-${uuidFor(2)}-pdf`],
      );
      assert.isFalse(yield* exists(`pending-${uuidFor(1)}.png`));
      assert.isFalse(yield* exists(`pending-${uuidFor(2)}-pdf.pdf`));
      assert.isTrue(yield* exists(`stash-${uuidFor(1)}.png`));
      assert.isTrue(yield* exists(`stash-${uuidFor(2)}-pdf.pdf`));
      assert.isTrue(yield* exists(`stash-${uuidFor(2)}-pdf.pdf.txt`));
      const stored = JSON.parse(yield* fs.readFileString(entryPath("a")));
      assert.equal(stored.version, 2);
      assert.isNumber(stored.receivedAt);
      assert.deepEqual(stored.entry.records, entry("a").records);
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("put is idempotent by id", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { fs, attachmentsDir } = yield* dirs;
      const attachments = [image(3)];
      yield* upload(attachments);
      const changes = yield* Effect.forkChild(
        stash.streamChanges.pipe(Stream.take(3), Stream.runCollect),
        { startImmediately: true },
      );

      const first = yield* stash.put(entry("a", attachments));
      const filesAfterFirst = yield* fs.readDirectory(attachmentsDir);
      const second = yield* stash.put(entry("a", attachments));

      assert.deepEqual(second, first);
      assert.deepEqual(yield* fs.readDirectory(attachmentsDir), filesAfterFirst);
      yield* stash.remove({ entryId: "a" });
      assert.deepEqual(
        Array.from(yield* Fiber.join(changes)).map((change) => [
          change.upserted.length,
          change.removedIds,
        ]),
        [
          [0, []],
          [1, []],
          [0, ["a"]],
        ],
      );
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("put keeps the entry when a pending file is gone", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const present = image(4);
      yield* upload([present]);

      const { summary } = yield* stash.put(
        entry("a", [present, image(5, "gone.png"), file(6, "notes.pdf")]),
      );

      assert.deepEqual(
        summary.attachments.map((attachment) => attachment.id),
        [present.id],
      );
      assert.deepEqual(summary.droppedImageNames, ["gone.png"]);
      assert.deepEqual(summary.droppedFileNames, ["notes.pdf"]);
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("put of a consumed id fails with already-taken", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      yield* stash.put(entry("taken"));
      yield* stash.take({ entryId: "taken", requestId: "r1" });
      assert.equal(yield* failureOf(stash.put(entry("taken"))), "already-taken");

      yield* stash.put(entry("removed"));
      yield* stash.remove({ entryId: "removed" });
      assert.equal(yield* failureOf(stash.put(entry("removed"))), "already-taken");
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("put rejects an entry over the JSON limit", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { fs, entryPath } = yield* dirs;
      const large = { ...entry("big"), prompt: "x".repeat(PROMPT_STASH_MAX_ENTRY_JSON_BYTES) };
      assert.equal(yield* failureOf(stash.put(large)), "entry-too-large");
      assert.isFalse(yield* fs.exists(entryPath("big")));
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("take returns pending ids and removes the entry", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { fs, entryPath, exists } = yield* dirs;
      const attachments = [image(7), file(8)];
      yield* upload(attachments);
      yield* stash.put(entry("a", attachments));

      const taken = yield* stash.take({ entryId: "a", requestId: "r1" });

      assert.deepEqual(taken, entry("a", attachments));
      assert.isFalse(yield* fs.exists(entryPath("a")));
      assert.isTrue(yield* exists(`pending-${uuidFor(7)}.png`));
      assert.isTrue(yield* exists(`pending-${uuidFor(8)}-pdf.pdf`));
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("take repeated with the same requestId returns the same result", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const attachments = [image(9)];
      yield* upload(attachments);
      yield* stash.put(entry("a", attachments));
      const first = yield* stash.take({ entryId: "a", requestId: "r1" });
      assert.deepEqual(yield* stash.take({ entryId: "a", requestId: "r1" }), first);
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("take is exclusive across request ids", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      yield* stash.put(entry("a"));
      yield* stash.take({ entryId: "a", requestId: "r1" });
      assert.equal(
        yield* failureOf(stash.take({ entryId: "a", requestId: "r2" })),
        "already-taken",
      );
      assert.equal(
        yield* failureOf(stash.take({ entryId: "unknown", requestId: "r1" })),
        "not-found",
      );
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("take refreshes mtime so the pending sweep keeps the files", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const stash = yield* PromptStash.PromptStash;
      const { fs, attachmentPath, attachmentsDir, exists, write } = yield* dirs;
      const attachments = [image(10), file(14)];
      yield* upload(attachments);
      yield* write(`pending-${uuidFor(14)}-pdf.pdf.txt`);
      yield* stash.put(entry("a", attachments));
      const twoDaysAgoSeconds = (NOW_MS - 2 * DAY_MS) / 1000;
      for (const name of [
        `stash-${uuidFor(10)}.png`,
        `stash-${uuidFor(14)}-pdf.pdf`,
        `stash-${uuidFor(14)}-pdf.pdf.txt`,
      ]) {
        yield* fs.utimes(attachmentPath(name), twoDaysAgoSeconds, twoDaysAgoSeconds);
      }

      yield* stash.take({ entryId: "a", requestId: "r1" });
      sweepStalePendingAttachments({ attachmentsDir, nowMs: NOW_MS });

      assert.isTrue(yield* exists(`pending-${uuidFor(10)}.png`));
      assert.isTrue(yield* exists(`pending-${uuidFor(14)}-pdf.pdf`));
      assert.isTrue(yield* exists(`pending-${uuidFor(14)}-pdf.pdf.txt`));
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("remove deletes the entry and its files", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { fs, entryPath, exists, write } = yield* dirs;
      const attachments = [file(11)];
      yield* upload(attachments);
      yield* write(`pending-${uuidFor(11)}-pdf.pdf.txt`);
      yield* stash.put(entry("a", attachments));

      yield* stash.remove({ entryId: "a" });

      assert.isFalse(yield* fs.exists(entryPath("a")));
      assert.isFalse(yield* exists(`stash-${uuidFor(11)}-pdf.pdf`));
      assert.isFalse(yield* exists(`stash-${uuidFor(11)}-pdf.pdf.txt`));
      assert.equal(
        yield* failureOf(stash.take({ entryId: "a", requestId: "r1" })),
        "already-taken",
      );
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("remove of an unknown id succeeds", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      yield* stash.remove({ entryId: "unknown" });
      assert.deepEqual((yield* stash.put(entry("unknown"))).evictedIds, []);
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("evicts only beyond the cap and deletes evicted files", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { exists } = yield* dirs;
      const createdAt = (n: number) => `2026-11-20T10:00:${n.toString().padStart(2, "0")}.000Z`;
      const oldest = [image(100)];
      yield* upload(oldest);
      assert.deepEqual((yield* stash.put(entry("e00", oldest, createdAt(0)))).evictedIds, []);
      for (let n = 1; n < 40; n++) {
        const id = `e${n.toString().padStart(2, "0")}`;
        assert.deepEqual((yield* stash.put(entry(id, [], createdAt(n)))).evictedIds, []);
      }
      for (let n = 40; n < 50; n++) {
        yield* stash.put(entry(`e${n}`, [], createdAt(n)));
      }
      assert.isTrue(yield* exists(`stash-${uuidFor(100)}.png`));

      const result = yield* stash.put(entry("e50", [], createdAt(50)));

      assert.deepEqual(result.evictedIds, ["e00"]);
      assert.isFalse(yield* exists(`stash-${uuidFor(100)}.png`));
      assert.equal(yield* failureOf(stash.put(entry("e00", [], createdAt(0)))), "already-taken");
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("consumed ids expire after the TTL", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      yield* stash.put(entry("old"));
      yield* stash.take({ entryId: "old", requestId: "r1" });
      yield* TestClock.adjust(PROMPT_STASH_CONSUMED_TTL_MS + 1);
      yield* stash.put(entry("next"));
      yield* stash.remove({ entryId: "next" });

      assert.equal(yield* failureOf(stash.take({ entryId: "old", requestId: "r1" })), "not-found");
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("startup returns unreferenced stash files to pending and reloads entries", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const attachments = [image(12)];
      yield* upload(attachments);
      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        yield* stash.put(entry("kept", attachments));
        yield* stash.put(entry("taken"));
        yield* stash.take({ entryId: "taken", requestId: "r1" });
      }).pipe(Effect.provide(PromptStash.layer));
      const { attachmentPath, attachmentsDir, exists, fs, write } = yield* dirs;
      // A put that died after its renames, before its entry file was written.
      const twoDaysAgoSeconds = (NOW_MS - 2 * DAY_MS) / 1000;
      for (const name of [`stash-${uuidFor(13)}.png`, `stash-${uuidFor(13)}.png.txt`]) {
        yield* write(name);
        yield* fs.utimes(attachmentPath(name), twoDaysAgoSeconds, twoDaysAgoSeconds);
      }

      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        const [snapshot] = yield* stash.streamChanges.pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(
          snapshot?.upserted.map((summary) => summary.id),
          ["kept"],
        );
        assert.equal(
          yield* failureOf(stash.take({ entryId: "taken", requestId: "r2" })),
          "already-taken",
        );
        assert.deepEqual(
          (yield* stash.take({ entryId: "kept", requestId: "r1" })).records,
          entry("kept").records,
        );
      }).pipe(Effect.provide(PromptStash.layer));

      sweepStalePendingAttachments({ attachmentsDir, nowMs: NOW_MS });
      assert.isFalse(yield* exists(`stash-${uuidFor(13)}.png`));
      assert.isFalse(yield* exists(`stash-${uuidFor(13)}.png.txt`));
      assert.isTrue(yield* exists(`pending-${uuidFor(13)}.png`));
      assert.isTrue(yield* exists(`pending-${uuidFor(13)}.png.txt`));
      assert.isTrue(yield* exists(`pending-${uuidFor(12)}.png`));
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("startup gives a stored entry back the files a dead take returned to pending", () =>
    Effect.gen(function* () {
      const attachments = [image(15), file(16)];
      yield* upload(attachments);
      const { exists, fs, attachmentPath, write } = yield* dirs;
      yield* write(`pending-${uuidFor(16)}-pdf.pdf.txt`);
      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        yield* stash.put(entry("a", attachments));
      }).pipe(Effect.provide(PromptStash.layer));
      // A take that died after its renames, before the entry file was removed.
      for (const [from, to] of [
        [`stash-${uuidFor(15)}.png`, `pending-${uuidFor(15)}.png`],
        [`stash-${uuidFor(16)}-pdf.pdf`, `pending-${uuidFor(16)}-pdf.pdf`],
        [`stash-${uuidFor(16)}-pdf.pdf.txt`, `pending-${uuidFor(16)}-pdf.pdf.txt`],
      ] as const) {
        yield* fs.rename(attachmentPath(from), attachmentPath(to));
      }

      const taken = yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        assert.isTrue(yield* exists(`stash-${uuidFor(15)}.png`));
        assert.isTrue(yield* exists(`stash-${uuidFor(16)}-pdf.pdf`));
        assert.isTrue(yield* exists(`stash-${uuidFor(16)}-pdf.pdf.txt`));
        assert.isFalse(yield* exists(`pending-${uuidFor(15)}.png`));
        return yield* stash.take({ entryId: "a", requestId: "r1" });
      }).pipe(Effect.provide(PromptStash.layer));

      assert.deepEqual(taken, entry("a", attachments));
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("streamChanges sends a snapshot then deltas without gaps", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      yield* stash.put(entry("before", [], "2026-11-20T09:00:00.000Z"));
      const changes = yield* Effect.forkChild(
        stash.streamChanges.pipe(Stream.take(3), Stream.runCollect),
        { startImmediately: true },
      );
      const { summary } = yield* stash.put(entry("a"));
      yield* stash.take({ entryId: "a", requestId: "r1" });

      const { records: _records, ...before } = entry("before", [], "2026-11-20T09:00:00.000Z");
      assert.deepEqual(Array.from(yield* Fiber.join(changes)), [
        { upserted: [before], removedIds: [], replace: true },
        { upserted: [summary], removedIds: [], replace: false },
        { upserted: [], removedIds: ["a"], replace: false },
      ]);
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("a put interrupted after moving a file completes on retry", () =>
    Effect.gen(function* () {
      const attachments = [image(20), file(21)];
      yield* upload(attachments);
      const { entryPath, exists, fs } = yield* dirs;
      const blocked = yield* blockFirstRename((path) =>
        path.endsWith(`pending-${uuidFor(21)}-pdf.pdf`),
      );

      const retried = yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        const put = yield* Effect.forkChild(stash.put(entry("a", attachments)), {
          startImmediately: true,
        });
        yield* interruptWhileBlocked(put, blocked);
        assert.isTrue(yield* fs.exists(entryPath("a")));
        return yield* stash.put(entry("a", attachments));
      }).pipe(Effect.provide(layerStashWithFsHook(blocked.hook)));

      assert.deepEqual(
        retried.summary.attachments.map((attachment) => attachment.attachmentId),
        [`stash-${uuidFor(20)}`, `stash-${uuidFor(21)}-pdf`],
      );
      assert.deepEqual(retried.summary.droppedImageNames, []);
      assert.deepEqual(retried.summary.droppedFileNames, []);
      assert.isTrue(yield* exists(`stash-${uuidFor(20)}.png`));
      assert.isTrue(yield* exists(`stash-${uuidFor(21)}-pdf.pdf`));
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("a failing put moves its files back to pending", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { exists, fs, promptStashDir, write } = yield* dirs;
      const attachments = [image(22), file(23)];
      yield* upload(attachments);
      yield* write(`pending-${uuidFor(23)}-pdf.pdf.txt`);

      yield* fs.chmod(promptStashDir, 0o555);
      const reason = yield* failureOf(stash.put(entry("a", attachments))).pipe(
        Effect.ensuring(fs.chmod(promptStashDir, 0o755).pipe(Effect.orDie)),
      );

      assert.equal(reason, "storage");
      for (const name of [
        `pending-${uuidFor(22)}.png`,
        `pending-${uuidFor(23)}-pdf.pdf`,
        `pending-${uuidFor(23)}-pdf.pdf.txt`,
      ]) {
        assert.isTrue(yield* exists(name), name);
      }
      assert.isFalse(yield* exists(`stash-${uuidFor(22)}.png`));
      assert.isFalse(yield* exists(`stash-${uuidFor(23)}-pdf.pdf`));
      assert.isFalse(yield* exists(`stash-${uuidFor(23)}-pdf.pdf.txt`));

      const { summary } = yield* stash.put(entry("a", attachments));
      assert.deepEqual(
        summary.attachments.map((attachment) => attachment.attachmentId),
        [`stash-${uuidFor(22)}`, `stash-${uuidFor(23)}-pdf`],
      );
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect(
    "a take interrupted after moving a file completes on retry with the same request id",
    () =>
      Effect.gen(function* () {
        const attachments = [image(24), file(25)];
        const failing = [image(27), file(28)];
        yield* upload([...attachments, ...failing]);
        const { entryPath, exists, fs, promptStashDir } = yield* dirs;
        const blocked = yield* blockFirstRename((path) =>
          path.endsWith(`stash-${uuidFor(25)}-pdf.pdf`),
        );

        const [retried, retriedAfterFailure] = yield* Effect.gen(function* () {
          const stash = yield* PromptStash.PromptStash;
          yield* stash.put(entry("a", attachments));
          const take = yield* Effect.forkChild(stash.take({ entryId: "a", requestId: "r1" }), {
            startImmediately: true,
          });
          yield* interruptWhileBlocked(take, blocked);
          assert.isFalse(yield* fs.exists(entryPath("a")));
          const retried = yield* stash.take({ entryId: "a", requestId: "r1" });

          // A take that failed after its renames, at consumed.json, retried without a restart.
          yield* stash.put(entry("b", failing));
          yield* fs.chmod(promptStashDir, 0o555);
          const reason = yield* failureOf(stash.take({ entryId: "b", requestId: "r1" })).pipe(
            Effect.ensuring(fs.chmod(promptStashDir, 0o755).pipe(Effect.orDie)),
          );
          assert.equal(reason, "storage");
          return [retried, yield* stash.take({ entryId: "b", requestId: "r1" })] as const;
        }).pipe(Effect.provide(layerStashWithFsHook(blocked.hook)));

        assert.deepEqual(retried, entry("a", attachments));
        assert.deepEqual(retriedAfterFailure, entry("b", failing));
        assert.isTrue(yield* exists(`pending-${uuidFor(24)}.png`));
        assert.isTrue(yield* exists(`pending-${uuidFor(25)}-pdf.pdf`));
        assert.isTrue(yield* exists(`pending-${uuidFor(27)}.png`));
        assert.isTrue(yield* exists(`pending-${uuidFor(28)}-pdf.pdf`));
      }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("a take that died before deleting its entry is finished at startup", () =>
    Effect.gen(function* () {
      const attachments = [image(26)];
      yield* upload(attachments);
      const { entryPath, exists, fs } = yield* dirs;
      const taken = yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        yield* stash.put(entry("a", attachments));
        const entryFile = yield* fs.readFileString(entryPath("a"));
        const result = yield* stash.take({ entryId: "a", requestId: "r1" });
        // consumed.json is written; the entry file is not yet deleted.
        yield* fs.writeFileString(entryPath("a"), entryFile);
        return result;
      }).pipe(Effect.provide(PromptStash.layer));

      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        const [snapshot] = yield* stash.streamChanges.pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(snapshot?.upserted, []);
        assert.isFalse(yield* fs.exists(entryPath("a")));
        assert.isTrue(yield* exists(`pending-${uuidFor(26)}.png`));
        assert.deepEqual(yield* stash.take({ entryId: "a", requestId: "r1" }), taken);
        assert.equal(
          yield* failureOf(stash.take({ entryId: "a", requestId: "r2" })),
          "already-taken",
        );
      }).pipe(Effect.provide(PromptStash.layer));
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("a put never evicts its own entry", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { entryPath, fs } = yield* dirs;
      const createdAt = (n: number) => `2026-11-20T10:00:${n.toString().padStart(2, "0")}.000Z`;
      for (let n = 0; n < 50; n++) {
        yield* stash.put(entry(`e${n.toString().padStart(2, "0")}`, [], createdAt(n + 10)));
      }

      const result = yield* stash.put(entry("late", [], createdAt(0)));

      assert.deepEqual(result.evictedIds, ["e00"]);
      assert.isTrue(yield* fs.exists(entryPath("late")));
      assert.deepEqual((yield* stash.put(entry("late", [], createdAt(0)))).summary, result.summary);
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("eviction follows server receipt time, not createdAt", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const { entryPath, fs } = yield* dirs;
      const createdAt = (n: number) => `2026-11-20T10:00:${n.toString().padStart(2, "0")}.000Z`;
      // A version-1 file is the bare entry; its receipt time is the file's mtime.
      yield* fs.writeFileString(
        entryPath("legacy"),
        JSON.stringify(entry("legacy", [], createdAt(59))),
      );
      const dayAgoSeconds = (NOW_MS - DAY_MS) / 1000;
      yield* fs.utimes(entryPath("legacy"), dayAgoSeconds, dayAgoSeconds);

      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        for (let n = 1; n < 50; n++) {
          yield* TestClock.adjust(1);
          yield* stash.put(entry(`e${n.toString().padStart(2, "0")}`, [], createdAt(50 - n)));
        }
        yield* TestClock.adjust(1);
        assert.deepEqual((yield* stash.put(entry("e50", [], createdAt(0)))).evictedIds, ["legacy"]);
        yield* TestClock.adjust(1);
        assert.deepEqual((yield* stash.put(entry("e51", [], createdAt(0)))).evictedIds, ["e01"]);
      }).pipe(Effect.provide(PromptStash.layer));
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("startup keeps stash files when an entry file cannot be decoded", () =>
    Effect.gen(function* () {
      const { attachmentPath, entryPath, exists, fs } = yield* dirs;
      yield* upload([image(30), image(31)]);
      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        yield* stash.put(entry("a", [image(30)]));
        yield* stash.put(entry("b", [image(31)]));
      }).pipe(Effect.provide(PromptStash.layer));
      yield* fs.writeFileString(entryPath("b"), "{");
      // A take of "a" that died after its rename, before the entry file was removed.
      yield* fs.rename(
        attachmentPath(`stash-${uuidFor(30)}.png`),
        attachmentPath(`pending-${uuidFor(30)}.png`),
      );

      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        const [snapshot] = yield* stash.streamChanges.pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(
          snapshot?.upserted.map((summary) => summary.id),
          ["a"],
        );
      }).pipe(Effect.provide(PromptStash.layer));

      assert.isTrue(yield* exists(`stash-${uuidFor(31)}.png`));
      assert.isFalse(yield* exists(`pending-${uuidFor(31)}.png`));
      assert.isTrue(yield* exists(`stash-${uuidFor(30)}.png`));
      assert.isFalse(yield* exists(`pending-${uuidFor(30)}.png`));
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("the id consumed is rejected and ids differ only by case collide", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      assert.equal(yield* failureOf(stash.put(entry("consumed"))), "storage");
      assert.equal(yield* failureOf(stash.put(entry("Consumed"))), "storage");

      const first = yield* stash.put(entry("Mixed"));
      assert.deepEqual(yield* stash.put(entry("mixed")), first);
      yield* stash.take({ entryId: "Mixed", requestId: "r1" });
      assert.equal(yield* failureOf(stash.put(entry("MIXED"))), "already-taken");
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("consumed keeps at most 50 results", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.PromptStash;
      const { fs, promptStashDir } = yield* dirs;
      const id = (n: number) => `c${n.toString().padStart(2, "0")}`;
      for (let n = 0; n <= 50; n++) {
        yield* stash.put(entry(id(n)));
        yield* stash.take({ entryId: id(n), requestId: `r${n}` });
      }

      const stored = JSON.parse(yield* fs.readFileString(`${promptStashDir}/consumed.json`)) as {
        consumed: ReadonlyArray<{ entryId: string; result?: unknown }>;
      };
      assert.equal(stored.consumed.length, 51);
      assert.equal(stored.consumed.filter((record) => record.result !== undefined).length, 50);
      assert.equal(
        yield* failureOf(stash.take({ entryId: id(0), requestId: "r0" })),
        "already-taken",
      );
      assert.deepEqual(yield* stash.take({ entryId: id(1), requestId: "r1" }), entry(id(1)));
      assert.deepEqual(yield* stash.take({ entryId: id(50), requestId: "r50" }), entry(id(50)));
    }).pipe(Effect.provide(layerPromptStash)),
  );

  it.effect("take touches files before renaming them", () =>
    Effect.gen(function* () {
      const { attachmentsDir, write } = yield* dirs;
      const attachments = [file(32)];
      yield* upload(attachments);
      yield* write(`pending-${uuidFor(32)}-pdf.pdf.txt`);
      const operations: Array<string> = [];
      const hook: FsHook = (operation, path) =>
        Effect.sync(() => {
          if (path.startsWith(attachmentsDir)) {
            operations.push(`${operation} ${path.slice(attachmentsDir.length + 1)}`);
          }
        });

      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        yield* stash.put(entry("a", attachments));
        operations.length = 0;
        yield* stash.take({ entryId: "a", requestId: "r1" });
      }).pipe(Effect.provide(layerStashWithFsHook(hook)));

      assert.deepEqual(operations, [
        `utimes stash-${uuidFor(32)}-pdf.pdf`,
        `rename stash-${uuidFor(32)}-pdf.pdf`,
        `utimes stash-${uuidFor(32)}-pdf.pdf.txt`,
        `rename stash-${uuidFor(32)}-pdf.pdf.txt`,
      ]);
    }).pipe(Effect.provide(layerConfig)),
  );
});
