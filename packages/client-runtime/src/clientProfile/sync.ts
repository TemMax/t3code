// @effect-diagnostics globalTimers:off globalConsole:off - A promise controller driven by client callbacks, outside an Effect runtime.
import { CLIENT_PROFILE_MAX_KEY_LENGTH, CLIENT_PROFILE_MAX_VALUE_BYTES } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { clientProfileKeyName, isClientProfileBaseKey, type ClientProfileSurface } from "./keys.ts";
import {
  adoptSyncedClientProfileSidecar,
  claimThisDeviceClientProfileSidecar,
  compareClientProfileEntries,
  needsClientProfileChoice,
  planClientProfileSync,
  recordAppliedClientProfileEntries,
  seedClientProfileSidecar,
  type ClientProfileEntries,
  type ClientProfileEntry,
  type ClientProfileServerDocument,
  type ClientProfileSidecar,
} from "./merge.ts";
import type { ClientProfileSidecarStore, ClientProfileValueSource } from "./source.ts";

export interface ClientProfileEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
  readonly supportsProfile: boolean;
  readonly canWrite: boolean;
  readonly document: ClientProfileEntries | undefined;
}

export type ClientProfileSyncStatus =
  | { readonly type: "off" }
  | { readonly type: "waiting" }
  | { readonly type: "unsupported" }
  | { readonly type: "choice" }
  | {
      readonly type: "syncing";
      readonly environments: ReadonlyArray<{
        readonly environmentId: string;
        readonly label: string;
      }>;
    };

export type ClientProfileExternalChangeResult = "off" | "waiting" | "older" | "applied";

export interface ClientProfileSyncController {
  readonly statusAtom: Atom.Atom<ClientProfileSyncStatus>;
  readonly start: () => () => void;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly choose: (choice: "synced" | "thisDevice") => Promise<void>;
  readonly adoptExternalChange: (change: {
    readonly environmentId: string;
    readonly values: Readonly<Record<string, unknown>>;
    readonly changedAt: number;
  }) => Promise<ClientProfileExternalChangeResult>;
}

type ParticipatingEnvironment = ClientProfileEnvironment & {
  readonly document: ClientProfileEntries;
};

function participates(
  environment: ClientProfileEnvironment,
): environment is ParticipatingEnvironment {
  return (
    environment.connected &&
    environment.supportsProfile &&
    environment.canWrite &&
    environment.document !== undefined
  );
}

function serverDocuments(
  participants: ReadonlyArray<ParticipatingEnvironment>,
): ClientProfileServerDocument[] {
  return participants.map(({ environmentId, document }) => ({ environmentId, document }));
}

function computeStatus(
  surface: ClientProfileSurface,
  sidecar: ClientProfileSidecar,
  environments: ReadonlyArray<ClientProfileEnvironment>,
): ClientProfileSyncStatus {
  if (!sidecar.enabled) return { type: "off" };
  const participants = environments.filter(participates);
  if (participants.length > 0) {
    if (!sidecar.choicePending) {
      return {
        type: "syncing",
        environments: participants.map(({ environmentId, label }) => ({ environmentId, label })),
      };
    }
    if (needsClientProfileChoice(surface, serverDocuments(participants))) {
      return { type: "choice" };
    }
    return { type: "waiting" };
  }
  const connected = environments.filter((environment) => environment.connected);
  if (
    connected.length > 0 &&
    connected.every((environment) => !environment.supportsProfile || !environment.canWrite)
  ) {
    return { type: "unsupported" };
  }
  return { type: "waiting" };
}

function environmentsChanged(
  previous: ReadonlyArray<ClientProfileEnvironment>,
  next: ReadonlyArray<ClientProfileEnvironment>,
): boolean {
  if (previous === next) return false;
  if (previous.length !== next.length) return true;
  const byId = new Map(previous.map((environment) => [environment.environmentId, environment]));
  return next.some((environment) => {
    const before = byId.get(environment.environmentId);
    return (
      before === undefined ||
      before.connected !== environment.connected ||
      before.supportsProfile !== environment.supportsProfile ||
      before.canWrite !== environment.canWrite ||
      before.label !== environment.label ||
      before.document !== environment.document
    );
  });
}

const utf8 = new TextEncoder();

function fitsServerLimits(key: string, value: unknown): boolean {
  if (key.length > CLIENT_PROFILE_MAX_KEY_LENGTH) return false;
  const json = JSON.stringify(value) ?? "null";
  return utf8.encode(json).length <= CLIENT_PROFILE_MAX_VALUE_BYTES;
}

export function createClientProfileSync(options: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentsAtom: Atom.Atom<ReadonlyArray<ClientProfileEnvironment>>;
  readonly push: (environmentId: string, entries: ClientProfileEntries) => Promise<void>;
  readonly surface: ClientProfileSurface;
  readonly source: ClientProfileValueSource;
  readonly sidecarStore: ClientProfileSidecarStore;
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly onError?: (cause: unknown) => void;
}): ClientProfileSyncController {
  const { registry, environmentsAtom, surface, source, sidecarStore } = options;
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? 300;
  const onError = options.onError ?? ((cause: unknown) => console.error(cause));

  const statusAtom = Atom.make<ClientProfileSyncStatus>({ type: "off" }).pipe(Atom.keepAlive);
  let publishedStatus = JSON.stringify({ type: "off" });
  const publishStatus = (sidecar: ClientProfileSidecar) => {
    const status = computeStatus(surface, sidecar, registry.get(environmentsAtom));
    const serialized = JSON.stringify(status);
    if (serialized === publishedStatus) return;
    publishedStatus = serialized;
    registry.set(statusAtom, status);
  };

  const participants = () => registry.get(environmentsAtom).filter(participates);

  let tail: Promise<unknown> = Promise.resolve();
  const serial = <A>(task: () => Promise<A>): Promise<A> => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };

  const pushGroup = async (environmentId: string, entries: ClientProfileEntries) => {
    const fitting = Object.fromEntries(
      Object.entries(entries).filter(([key, entry]) => fitsServerLimits(key, entry.value)),
    );
    if (Object.keys(fitting).length === 0) return;
    try {
      await options.push(environmentId, fitting);
    } catch (cause) {
      onError(cause);
    }
  };

  const runPass = async () => {
    try {
      let sidecar = await sidecarStore.load();
      if (!sidecar.enabled) {
        publishStatus(sidecar);
        return;
      }
      await source.ready();
      publishStatus(sidecar);
      const servers = serverDocuments(participants());
      if (servers.length === 0) return;
      if (sidecar.choicePending) {
        if (needsClientProfileChoice(surface, servers)) return;
        sidecar = seedClientProfileSidecar({
          surface,
          sidecar,
          local: source.read(),
          defaults: source.defaults(),
        });
        await sidecarStore.save(sidecar);
        publishStatus(sidecar);
      }
      const plan = planClientProfileSync({
        surface,
        now: now(),
        sidecar,
        local: source.read(),
        servers,
      });
      let next = plan.sidecar;
      if (Object.keys(plan.apply).length > 0) {
        const values = Object.fromEntries(
          Object.entries(plan.apply).map(([base, entry]) => [base, entry.value]),
        );
        const stored = await source.apply(values);
        next = recordAppliedClientProfileEntries({
          surface,
          sidecar: plan.sidecar,
          applied: plan.apply,
          stored,
        });
      }
      if (JSON.stringify(next) !== JSON.stringify(sidecar)) await sidecarStore.save(next);
      await Promise.all(plan.push.map((group) => pushGroup(group.environmentId, group.entries)));
    } catch (cause) {
      onError(cause);
    }
  };

  let passQueued = false;
  const requestPass = () => {
    if (passQueued) return;
    passQueued = true;
    void serial(async () => {
      passQueued = false;
      await runPass();
    });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedulePass = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      requestPass();
    }, debounceMs);
  };

  let dispose: (() => void) | undefined;
  const start = () => {
    if (dispose !== undefined) return dispose;
    let previous = registry.get(environmentsAtom);
    const unsubscribeEnvironments = registry.subscribe(environmentsAtom, (next) => {
      const changed = environmentsChanged(previous, next);
      previous = next;
      if (changed) schedulePass();
    });
    const unsubscribeSource = source.subscribe(schedulePass);
    requestPass();
    dispose = () => {
      unsubscribeEnvironments();
      unsubscribeSource();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    return dispose;
  };

  const setEnabled = (enabled: boolean) =>
    serial(async () => {
      const sidecar = await sidecarStore.load();
      if (!enabled) {
        const disabled = { ...sidecar, enabled: false, choicePending: false, entries: {} };
        await sidecarStore.save(disabled);
        publishStatus(disabled);
        return;
      }
      if (sidecar.enabled) return;
      await sidecarStore.save({ ...sidecar, enabled: true, choicePending: true, entries: {} });
      await runPass();
    });

  const choose = (choice: "synced" | "thisDevice") =>
    serial(async () => {
      const sidecar = await sidecarStore.load();
      if (!sidecar.enabled || !sidecar.choicePending) return;
      await source.ready();
      const servers = serverDocuments(participants());
      const local = source.read();
      await sidecarStore.save(
        choice === "synced"
          ? adoptSyncedClientProfileSidecar({
              surface,
              sidecar,
              local,
              defaults: source.defaults(),
              servers,
            })
          : claimThisDeviceClientProfileSidecar({ surface, now: now(), sidecar, local, servers }),
      );
      await runPass();
    });

  const adoptExternalChange: ClientProfileSyncController["adoptExternalChange"] = (change) =>
    serial(async () => {
      const sidecar = await sidecarStore.load();
      if (!sidecar.enabled) return "off";
      if (sidecar.choicePending) return "waiting";
      const environment = registry
        .get(environmentsAtom)
        .find((candidate) => candidate.environmentId === change.environmentId);
      if (
        environment === undefined ||
        !environment.connected ||
        (environment.supportsProfile && environment.canWrite && environment.document === undefined)
      ) {
        return "waiting";
      }
      await source.ready();
      const values = Object.fromEntries(
        Object.entries(change.values).filter(
          ([base]) => source.owns(base) && isClientProfileBaseKey(base, surface),
        ),
      );
      if (Object.keys(values).length === 0) return "older";
      const stamp = { changedAt: change.changedAt, by: sidecar.deviceId };
      const documents = participants().map((participant) => participant.document);
      for (const base of Object.keys(values)) {
        const key = clientProfileKeyName(base, surface);
        const known = [sidecar.entries[key], ...documents.map((document) => document[key])];
        if (
          known.some(
            (entry) => entry !== undefined && compareClientProfileEntries(stamp, entry) <= 0,
          )
        ) {
          return "older";
        }
      }
      const stored = await source.apply(values);
      const applied: Record<string, ClientProfileEntry> = Object.fromEntries(
        Object.entries(values).map(([base, value]) => [base, { value, ...stamp }]),
      );
      const recorded = recordAppliedClientProfileEntries({ surface, sidecar, applied, stored });
      await sidecarStore.save({
        ...recorded,
        highestSeen: Math.max(recorded.highestSeen, change.changedAt),
      });
      await runPass();
      return "applied";
    });

  return { statusAtom, start, setEnabled, choose, adoptExternalChange };
}
