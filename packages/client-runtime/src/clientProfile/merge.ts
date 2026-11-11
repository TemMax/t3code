import { Schema } from "effect";

import {
  CUSTOM_THEME_KEY_PREFIX,
  clientProfileBaseName,
  clientProfileKeyName,
  isClientProfileBaseKey,
  type ClientProfileSurface,
} from "./keys.ts";

export interface ClientProfileEntry {
  readonly value: unknown;
  readonly changedAt: number;
  readonly by: string;
}
export type ClientProfileEntries = Readonly<Record<string, ClientProfileEntry>>;

export interface ClientProfileSidecarEntry {
  readonly changedAt: number;
  readonly by: string;
  readonly hash: string;
}
export interface ClientProfileSidecar {
  readonly deviceId: string;
  readonly enabled: boolean;
  readonly choicePending: boolean;
  readonly highestSeen: number;
  readonly entries: Readonly<Record<string, ClientProfileSidecarEntry>>;
}

export const ClientProfileSidecarSchema = Schema.Struct({
  deviceId: Schema.String,
  enabled: Schema.Boolean,
  choicePending: Schema.Boolean,
  highestSeen: Schema.Number,
  entries: Schema.Record(
    Schema.String,
    Schema.Struct({ changedAt: Schema.Number, by: Schema.String, hash: Schema.String }),
  ),
});

export const UNPUBLISHED_CHANGED_AT = -1;

export function emptyClientProfileSidecar(deviceId: string): ClientProfileSidecar {
  return { deviceId, enabled: false, choicePending: false, highestSeen: 0, entries: {} };
}

export function compareClientProfileEntries(
  a: { changedAt: number; by: string },
  b: { changedAt: number; by: string },
): number {
  if (a.changedAt !== b.changedAt) return a.changedAt - b.changedAt;
  if (a.by > b.by) return 1;
  if (a.by < b.by) return -1;
  return 0;
}

export function stampClientProfileChange(now: number, highestSeen: number): number {
  return Math.max(now, highestSeen + 1);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashClientProfileValue(value: unknown): string {
  return cyrb53(JSON.stringify(canonicalize(value)) ?? "undefined").toString(16);
}

export interface ClientProfileLocalRead {
  readonly values: Readonly<Record<string, unknown>>;
  readonly completePrefixes: ReadonlyArray<string>;
}
export interface ClientProfileServerDocument {
  readonly environmentId: string;
  readonly document: ClientProfileEntries;
}
export interface ClientProfileSyncPlan {
  readonly sidecar: ClientProfileSidecar;
  readonly apply: Readonly<Record<string, ClientProfileEntry>>;
  readonly push: ReadonlyArray<{
    readonly environmentId: string;
    readonly entries: ClientProfileEntries;
  }>;
}

const NULL_HASH = hashClientProfileValue(null);

function isCustomThemeKey(base: string): boolean {
  return base.startsWith(CUSTOM_THEME_KEY_PREFIX);
}

function ownLocalBases(surface: ClientProfileSurface, local: ClientProfileLocalRead): string[] {
  return Object.keys(local.values).filter((base) => isClientProfileBaseKey(base, surface));
}

function highestServerStamp(servers: ReadonlyArray<ClientProfileServerDocument>, floor: number) {
  let highest = floor;
  for (const server of servers) {
    for (const entry of Object.values(server.document)) {
      highest = Math.max(highest, entry.changedAt);
    }
  }
  return highest;
}

export function planClientProfileSync(input: {
  surface: ClientProfileSurface;
  now: number;
  sidecar: ClientProfileSidecar;
  local: ClientProfileLocalRead;
  servers: ReadonlyArray<ClientProfileServerDocument>;
}): ClientProfileSyncPlan {
  const { surface, sidecar, local, servers } = input;
  const { deviceId } = sidecar;
  const highestSeen = highestServerStamp(servers, sidecar.highestSeen);
  const stamp = stampClientProfileChange(input.now, highestSeen);
  let stamped = false;

  const entries: Record<string, ClientProfileSidecarEntry> = { ...sidecar.entries };
  const own: Record<string, ClientProfileEntry> = {};
  const ownBase: Record<string, string> = {};

  const recordChange = (key: string, value: unknown, hash: string) => {
    stamped = true;
    entries[key] = { changedAt: stamp, by: deviceId, hash };
    own[key] = { value, changedAt: stamp, by: deviceId };
  };

  for (const base of ownLocalBases(surface, local)) {
    const key = clientProfileKeyName(base, surface);
    const value = local.values[base];
    const hash = hashClientProfileValue(value);
    const tracked = sidecar.entries[key];
    ownBase[key] = base;
    if (tracked !== undefined && tracked.hash === hash) {
      own[key] = { value, changedAt: tracked.changedAt, by: tracked.by };
    } else if (tracked !== undefined || isCustomThemeKey(base)) {
      recordChange(key, value, hash);
    } else {
      entries[key] = { changedAt: UNPUBLISHED_CHANGED_AT, by: deviceId, hash };
      own[key] = { value, changedAt: UNPUBLISHED_CHANGED_AT, by: deviceId };
    }
  }

  for (const [key, tracked] of Object.entries(sidecar.entries)) {
    const base = clientProfileBaseName(key, surface);
    if (base === null || base in local.values) continue;
    if (!local.completePrefixes.some((prefix) => base.startsWith(prefix))) continue;
    ownBase[key] = base;
    if (tracked.hash === NULL_HASH) {
      own[key] = { value: null, changedAt: tracked.changedAt, by: tracked.by };
    } else {
      recordChange(key, null, NULL_HASH);
    }
  }

  const bestRemote: Record<string, ClientProfileEntry> = {};
  for (const server of servers) {
    for (const [key, entry] of Object.entries(server.document)) {
      const best = bestRemote[key];
      if (best === undefined || compareClientProfileEntries(entry, best) > 0) {
        bestRemote[key] = entry;
      }
    }
  }

  const apply: Record<string, ClientProfileEntry> = {};
  for (const [key, remote] of Object.entries(bestRemote)) {
    let base = ownBase[key];
    let localEntry = own[key];
    if (base === undefined) {
      const candidate = clientProfileBaseName(key, surface);
      if (candidate === null || !isCustomThemeKey(candidate)) continue;
      base = candidate;
      localEntry = { value: null, changedAt: UNPUBLISHED_CHANGED_AT, by: deviceId };
    }
    if (localEntry === undefined || compareClientProfileEntries(remote, localEntry) <= 0) continue;
    const remoteHash = hashClientProfileValue(remote.value);
    if (remoteHash === hashClientProfileValue(localEntry.value)) {
      entries[key] = { changedAt: remote.changedAt, by: remote.by, hash: remoteHash };
    } else {
      apply[base] = remote;
    }
  }

  const keys = new Set([...Object.keys(bestRemote), ...Object.keys(own)]);
  const groups = servers.map((server) => ({
    environmentId: server.environmentId,
    entries: {} as Record<string, ClientProfileEntry>,
  }));
  for (const key of keys) {
    const remote = bestRemote[key];
    const mine = own[key];
    const candidate =
      remote === undefined
        ? mine
        : mine === undefined || compareClientProfileEntries(remote, mine) >= 0
          ? remote
          : mine;
    if (candidate === undefined || candidate.changedAt < 0) continue;
    servers.forEach((server, index) => {
      const copy = server.document[key];
      if (copy === undefined || compareClientProfileEntries(candidate, copy) > 0) {
        groups[index]!.entries[key] = candidate;
      }
    });
  }

  return {
    sidecar: {
      ...sidecar,
      highestSeen: stamped ? Math.max(highestSeen, stamp) : highestSeen,
      entries,
    },
    apply,
    push: groups.filter((group) => Object.keys(group.entries).length > 0),
  };
}

export function recordAppliedClientProfileEntries(input: {
  surface: ClientProfileSurface;
  sidecar: ClientProfileSidecar;
  applied: Record<string, ClientProfileEntry>;
  stored: Record<string, unknown>;
}): ClientProfileSidecar {
  const entries: Record<string, ClientProfileSidecarEntry> = { ...input.sidecar.entries };
  for (const [base, applied] of Object.entries(input.applied)) {
    const hash = hashClientProfileValue(base in input.stored ? input.stored[base] : null);
    if (hash === hashClientProfileValue(applied.value)) {
      entries[clientProfileKeyName(base, input.surface)] = {
        changedAt: applied.changedAt,
        by: applied.by,
        hash,
      };
    }
  }
  return { ...input.sidecar, entries };
}

export function needsClientProfileChoice(
  surface: ClientProfileSurface,
  servers: ReadonlyArray<ClientProfileServerDocument>,
): boolean {
  return servers.some((server) =>
    Object.keys(server.document).some((key) => clientProfileBaseName(key, surface) !== null),
  );
}

export function seedClientProfileSidecar(input: {
  surface: ClientProfileSurface;
  sidecar: ClientProfileSidecar;
  local: ClientProfileLocalRead;
  defaults: Record<string, unknown>;
}): ClientProfileSidecar {
  return seedEntries(input, new Set());
}

export function adoptSyncedClientProfileSidecar(input: {
  surface: ClientProfileSurface;
  sidecar: ClientProfileSidecar;
  local: ClientProfileLocalRead;
  defaults: Record<string, unknown>;
  servers: ReadonlyArray<ClientProfileServerDocument>;
}): ClientProfileSidecar {
  const synced = new Set(input.servers.flatMap((server) => Object.keys(server.document)));
  return seedEntries(input, synced);
}

function seedEntries(
  input: {
    surface: ClientProfileSurface;
    sidecar: ClientProfileSidecar;
    local: ClientProfileLocalRead;
    defaults: Record<string, unknown>;
  },
  synced: ReadonlySet<string>,
): ClientProfileSidecar {
  const { surface, sidecar } = input;
  const entries: Record<string, ClientProfileSidecarEntry> = { ...sidecar.entries };
  for (const base of ownLocalBases(surface, input.local)) {
    const key = clientProfileKeyName(base, surface);
    const hash = hashClientProfileValue(input.local.values[base]);
    const atDefault =
      !isCustomThemeKey(base) && hash === hashClientProfileValue(input.defaults[base]);
    entries[key] =
      synced.has(key) || atDefault
        ? { changedAt: UNPUBLISHED_CHANGED_AT, by: sidecar.deviceId, hash }
        : { changedAt: 0, by: sidecar.deviceId, hash };
  }
  return { ...sidecar, choicePending: false, entries };
}

export function claimThisDeviceClientProfileSidecar(input: {
  surface: ClientProfileSurface;
  now: number;
  sidecar: ClientProfileSidecar;
  local: ClientProfileLocalRead;
  servers: ReadonlyArray<ClientProfileServerDocument>;
}): ClientProfileSidecar {
  const { surface, sidecar } = input;
  const stamp = stampClientProfileChange(
    input.now,
    highestServerStamp(input.servers, sidecar.highestSeen),
  );
  const entries: Record<string, ClientProfileSidecarEntry> = { ...sidecar.entries };
  for (const base of ownLocalBases(surface, input.local)) {
    entries[clientProfileKeyName(base, surface)] = {
      changedAt: stamp,
      by: sidecar.deviceId,
      hash: hashClientProfileValue(input.local.values[base]),
    };
  }
  return { ...sidecar, choicePending: false, highestSeen: stamp, entries };
}
