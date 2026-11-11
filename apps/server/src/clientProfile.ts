import {
  CLIENT_PROFILE_MAX_DOCUMENT_BYTES,
  CLIENT_PROFILE_MAX_KEY_LENGTH,
  CLIENT_PROFILE_MAX_VALUE_BYTES,
  ClientProfileEntries,
  ClientProfileEntry,
  ClientProfileError,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";

const ClientProfileFile = Schema.Struct({
  version: Schema.Literal(1),
  entries: ClientProfileEntries,
});
const decodeClientProfileFileExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(ClientProfileFile),
);

const serializeFile = (entries: ClientProfileEntries) => JSON.stringify({ version: 1, entries });

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const isNewer = (incoming: ClientProfileEntry, stored: ClientProfileEntry | undefined) =>
  stored === undefined ||
  incoming.changedAt > stored.changedAt ||
  (incoming.changedAt === stored.changedAt && incoming.by > stored.by);

interface StoredProfile {
  readonly seq: number;
  readonly entries: ClientProfileEntries;
}

export class ClientProfile extends Context.Service<
  ClientProfile,
  {
    readonly document: Effect.Effect<ClientProfileEntries>;

    /** Returns the entries that were newer than the stored ones and are now stored. */
    readonly merge: (
      entries: ClientProfileEntries,
    ) => Effect.Effect<ClientProfileEntries, ClientProfileError>;

    /** Subscribes before reading so a change during connection is not lost. */
    readonly streamChanges: Stream.Stream<{
      readonly entries: ClientProfileEntries;
      readonly replace: boolean;
    }>;
  }
>()("t3/clientProfile") {}

const make = Effect.gen(function* () {
  const { clientProfilePath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const loadStored = Effect.gen(function* () {
    const raw = yield* fs.readFileString(clientProfilePath).pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.undefined
          : Effect.logWarning("ignoring unreadable client profile", {
              path: clientProfilePath,
              detail: error.message,
            }).pipe(Effect.as(undefined)),
      ),
    );
    if (raw === undefined) return {};
    const decoded = decodeClientProfileFileExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("ignoring invalid client profile", {
        path: clientProfilePath,
        detail: Cause.pretty(decoded.cause),
      });
      return {};
    }
    return decoded.value.entries;
  });

  const stored = yield* Ref.make<StoredProfile>({ seq: 0, entries: yield* loadStored });
  const changes = yield* PubSub.unbounded<StoredProfile>();
  const mergeSemaphore = yield* Semaphore.make(1);

  const merge = (incoming: ClientProfileEntries) =>
    mergeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        for (const [key, entry] of Object.entries(incoming)) {
          if (key.length > CLIENT_PROFILE_MAX_KEY_LENGTH) {
            return yield* new ClientProfileError({
              reason: "key-too-long",
              detail: `Key "${key.slice(0, 32)}…" is longer than ${CLIENT_PROFILE_MAX_KEY_LENGTH} characters.`,
            });
          }
          if (byteLength(entry.value) > CLIENT_PROFILE_MAX_VALUE_BYTES) {
            return yield* new ClientProfileError({
              reason: "value-too-large",
              detail: `Value for key "${key}" is larger than ${CLIENT_PROFILE_MAX_VALUE_BYTES} bytes.`,
            });
          }
        }

        const current = yield* Ref.get(stored);
        const changed: ClientProfileEntries = Object.fromEntries(
          Object.entries(incoming).filter(([key, entry]) => isNewer(entry, current.entries[key])),
        );
        if (Object.keys(changed).length === 0) return {};

        const entries = { ...current.entries, ...changed };
        const contents = serializeFile(entries);
        if (Buffer.byteLength(contents) > CLIENT_PROFILE_MAX_DOCUMENT_BYTES) {
          return yield* new ClientProfileError({
            reason: "document-too-large",
            detail: `The profile would be larger than ${CLIENT_PROFILE_MAX_DOCUMENT_BYTES} bytes.`,
          });
        }

        yield* writeFileStringAtomically({ filePath: clientProfilePath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (error) => new ClientProfileError({ reason: "storage", detail: error.message }),
          ),
        );

        // Subscribers drop updates not newer than the snapshot they read.
        const next: StoredProfile = { seq: current.seq + 1, entries };
        yield* Ref.set(stored, next);
        yield* PubSub.publish(changes, { seq: next.seq, entries: changed });
        return changed;
      }),
    );

  return {
    document: Effect.map(Ref.get(stored), (profile) => profile.entries),
    merge,
    streamChanges: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* Ref.get(stored);
        return Stream.concat(
          Stream.make({ entries: snapshot.entries, replace: true }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((update) => update.seq > snapshot.seq),
            Stream.map((update) => ({ entries: update.entries, replace: false })),
          ),
        );
      }),
    ),
  } satisfies ClientProfile["Service"];
});

export const layer = Layer.effect(ClientProfile, make);
