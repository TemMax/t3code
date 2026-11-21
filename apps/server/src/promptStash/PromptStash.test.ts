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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
      assert.deepEqual(stored.records, entry("a").records);
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
      const { fs, attachmentPath, attachmentsDir, exists } = yield* dirs;
      const attachments = [image(10)];
      yield* upload(attachments);
      yield* stash.put(entry("a", attachments));
      const twoDaysAgoSeconds = (NOW_MS - 2 * DAY_MS) / 1000;
      yield* fs.utimes(
        attachmentPath(`stash-${uuidFor(10)}.png`),
        twoDaysAgoSeconds,
        twoDaysAgoSeconds,
      );

      yield* stash.take({ entryId: "a", requestId: "r1" });
      sweepStalePendingAttachments({ attachmentsDir, nowMs: NOW_MS });

      assert.isTrue(yield* exists(`pending-${uuidFor(10)}.png`));
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

  it.effect("startup removes unreferenced stash files and reloads entries", () =>
    Effect.gen(function* () {
      const attachments = [image(12)];
      yield* upload(attachments);
      yield* Effect.gen(function* () {
        const stash = yield* PromptStash.PromptStash;
        yield* stash.put(entry("kept", attachments));
        yield* stash.put(entry("taken"));
        yield* stash.take({ entryId: "taken", requestId: "r1" });
      }).pipe(Effect.provide(PromptStash.layer));
      const { exists, write } = yield* dirs;
      yield* write(`stash-${uuidFor(13)}.png`);
      yield* write(`stash-${uuidFor(13)}.png.txt`);

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

      assert.isFalse(yield* exists(`stash-${uuidFor(13)}.png`));
      assert.isFalse(yield* exists(`stash-${uuidFor(13)}.png.txt`));
      assert.isTrue(yield* exists(`pending-${uuidFor(12)}.png`));
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
});
