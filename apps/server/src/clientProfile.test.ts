import {
  CLIENT_PROFILE_MAX_VALUE_BYTES,
  ClientProfileError,
  type ClientProfileEntry,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ClientProfile from "./clientProfile.ts";
import * as ServerConfig from "./config.ts";

const layerConfig = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-client-profile-test-" }),
);
const layerClientProfile = ClientProfile.layer.pipe(Layer.provideMerge(layerConfig));

const entry = (value: unknown, changedAt = 1, by = "device"): ClientProfileEntry => ({
  value,
  changedAt,
  by,
});

const readFile = Effect.gen(function* () {
  const { clientProfilePath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(clientProfilePath);
});

const failureOf = <A>(effect: Effect.Effect<A, ClientProfileError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

it.layer(NodeServices.layer)("clientProfile", (it) => {
  it.effect("keeps the newer entry per key and orders equal stamps by device", () =>
    Effect.gen(function* () {
      const profile = yield* ClientProfile.ClientProfile;
      const first = entry(1, 10, "x");
      assert.deepEqual(yield* profile.merge({ a: first }), { a: first });
      assert.deepEqual(yield* profile.merge({ a: entry(0, 9, "z") }), {});
      const second = entry(2, 10, "y");
      assert.deepEqual(yield* profile.merge({ a: second }), { a: second });
      assert.deepEqual(yield* profile.document, { a: second });
      assert.deepEqual(yield* profile.merge({ a: second }), {});
    }).pipe(Effect.provide(layerClientProfile)),
  );

  it.effect("persists the document and reloads it", () =>
    Effect.gen(function* () {
      const entries = { a: entry({ nested: [1, 2] }, 3, "x"), b: entry("text", 4, "y") };
      yield* Effect.gen(function* () {
        const profile = yield* ClientProfile.ClientProfile;
        yield* profile.merge(entries);
      }).pipe(Effect.provide(ClientProfile.layer));
      assert.deepEqual(JSON.parse(yield* readFile), { version: 1, entries });
      const reloaded = yield* Effect.gen(function* () {
        const profile = yield* ClientProfile.ClientProfile;
        return yield* profile.document;
      }).pipe(Effect.provide(ClientProfile.layer));
      assert.deepEqual(reloaded, entries);
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("streams the whole document first and then only changes", () =>
    Effect.gen(function* () {
      const profile = yield* ClientProfile.ClientProfile;
      const a = entry(1, 1, "x");
      const b = entry(2, 1, "x");
      const c = entry(3, 1, "x");
      yield* profile.merge({ a });
      const stream = profile.streamChanges.pipe(Stream.take(3), Stream.runCollect);
      const collected = yield* Effect.forkChild(stream, { startImmediately: true });
      yield* profile.merge({ b });
      yield* profile.merge({ b });
      yield* profile.merge({ c });
      assert.deepEqual(Array.from(yield* Fiber.join(collected)), [
        { entries: { a }, replace: true },
        { entries: { b }, replace: false },
        { entries: { c }, replace: false },
      ]);
    }).pipe(Effect.provide(layerClientProfile)),
  );

  it.effect("rejects over-limit updates without writing", () =>
    Effect.gen(function* () {
      const profile = yield* ClientProfile.ClientProfile;
      const kept = entry(1, 1, "x");
      yield* profile.merge({ kept });
      const fileBefore = yield* readFile;

      const midSize = "x".repeat(200_000);
      const tooLarge = Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`k${index}`, entry(midSize)]),
      );
      const rejected = [
        [{ ["k".repeat(129)]: entry(1) }, "key-too-long"],
        [{ big: entry("x".repeat(CLIENT_PROFILE_MAX_VALUE_BYTES)) }, "value-too-large"],
        [tooLarge, "document-too-large"],
      ] as const;
      for (const [entries, reason] of rejected) {
        assert.equal(yield* failureOf(profile.merge(entries)), reason);
        assert.deepEqual(yield* profile.document, { kept });
        assert.equal(yield* readFile, fileBefore);
      }
    }).pipe(Effect.provide(layerClientProfile)),
  );

  it.effect("starts empty from a malformed file and replaces it on the next merge", () =>
    Effect.gen(function* () {
      const { clientProfilePath } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(clientProfilePath, "{ not json");
      const profile = yield* Effect.service(ClientProfile.ClientProfile).pipe(
        Effect.provide(ClientProfile.layer),
      );
      assert.deepEqual(yield* profile.document, {});
      assert.equal(yield* readFile, "{ not json");
      const a = entry(1);
      yield* profile.merge({ a });
      assert.deepEqual(JSON.parse(yield* readFile), { version: 1, entries: { a } });
    }).pipe(Effect.provide(layerConfig)),
  );
});
