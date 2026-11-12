import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  createRuntimeCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { publishedThemeDefinitions } from "@t3tools/shared/themeConversion";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import {
  planRememberedThemes,
  setRegisteredMobileThemes,
  type MobileRememberedThemeKey,
  type MobileThemeRegistry,
} from "../lib/mobileThemeRegistry";
import * as Runtime from "../lib/runtime";
import * as MobileDatabase from "../persistence/mobile-database";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom } from "./preferences";
import { environmentPresentations } from "./presentation";
import {
  createMobileThemeRegistryMemo,
  decodeRememberedThemePayload,
  encodeRememberedThemePayload,
  sameServerInputs,
  type MobileThemeRegistryServerInput,
  type RememberedThemeCopy,
} from "./theme-registry.logic";

const THEME_CACHE_KIND = "environment-theme";
const THEME_CACHE_SCHEMA_VERSION = 1;

const themeCacheRuntime = Atom.runtime(Runtime.layer);

const listThemeCopies = createRuntimeCommand(themeCacheRuntime, {
  label: "mobile:theme-registry:list-copies",
  execute: (_input: void) =>
    MobileDatabase.MobileDatabase.pipe(
      Effect.flatMap((database) => database.listCache(THEME_CACHE_KIND)),
    ),
});

const saveThemeCopy = createRuntimeCommand(themeCacheRuntime, {
  label: "mobile:theme-registry:save-copy",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly themeId: string;
    readonly payload: string;
  }) =>
    MobileDatabase.MobileDatabase.pipe(
      Effect.flatMap((database) =>
        database.saveCache(
          input.environmentId,
          THEME_CACHE_KIND,
          input.themeId,
          THEME_CACHE_SCHEMA_VERSION,
          input.payload,
        ),
      ),
    ),
});

const removeThemeCopy = createRuntimeCommand(themeCacheRuntime, {
  label: "mobile:theme-registry:remove-copy",
  execute: (input: MobileRememberedThemeKey) =>
    MobileDatabase.MobileDatabase.pipe(
      Effect.flatMap((database) =>
        database.removeCache(input.environmentId, THEME_CACHE_KIND, input.themeId),
      ),
    ),
});

async function runDatabaseCommand<W, A, E>(
  command: Parameters<typeof runAtomCommand<W, A, E>>[1],
  input: W,
): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

const rememberedThemesAtom = Atom.make<ReadonlyArray<RememberedThemeCopy>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:theme-registry:remembered"),
);

const serverInputsAtom = Atom.make((get): ReadonlyArray<MobileThemeRegistryServerInput> =>
  [...get(environmentPresentations.presentationsAtom).entries()].map(
    ([environmentId, presentation]) => ({
      environmentId,
      connected: presentation.connection.phase === "connected",
      environmentThemes: presentation.serverConfig?.environmentThemes,
    }),
  ),
).pipe(Atom.withLabel("mobile:theme-registry:servers"));

const registryMemo = createMobileThemeRegistryMemo();

export const mobileThemeRegistryAtom: Atom.Atom<MobileThemeRegistry> = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  return registryMemo({
    editorThemes: AsyncResult.isSuccess(preferences) ? preferences.value.editorThemes : undefined,
    servers: get(serverInputsAtom),
    remembered: get(rememberedThemesAtom),
  });
}).pipe(Atom.withLabel("mobile:theme-registry"));

interface StoredCopy extends RememberedThemeCopy {
  readonly payload: string;
}

const copyKey = ({ environmentId, themeId }: MobileRememberedThemeKey) =>
  `${environmentId}\u0000${themeId}`;

function reportError(cause: unknown) {
  console.warn("[theme-registry] failed", safeErrorLogAttributes(cause));
}

export function installMobileThemeRegistry(): () => void {
  let disposed = false;
  let loaded = false;
  let stored = new Map<string, StoredCopy>();
  let lastServers: ReadonlyArray<MobileThemeRegistryServerInput> | undefined;
  let lastCatalog: unknown;
  let reconcileQueued = false;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>) => {
    chain = chain.then(task).catch(reportError);
  };

  const publishStored = () => {
    appAtomRegistry.set(
      rememberedThemesAtom,
      [...stored.values()].map(({ environmentId, theme }) => ({ environmentId, theme })),
    );
  };

  const reconcile = async () => {
    if (disposed || !loaded) return;
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    if (!catalog.isReady) return;
    const servers = appAtomRegistry.get(serverInputsAtom);
    if (
      lastServers !== undefined &&
      lastCatalog === catalog &&
      sameServerInputs(lastServers, servers)
    ) {
      return;
    }
    lastServers = servers;
    lastCatalog = catalog;

    const sources = servers.map((server) => ({
      environmentId: server.environmentId,
      connected: server.connected,
      published:
        server.environmentThemes === undefined
          ? undefined
          : publishedThemeDefinitions(server.environmentThemes),
    }));
    const plan = planRememberedThemes({
      servers: sources,
      remembered: [...stored.values()].map(({ environmentId, theme }) => ({
        environmentId,
        themeId: theme.id,
      })),
      knownEnvironmentIds: new Set(catalog.entries.keys()),
    });

    let changed = false;
    for (const key of plan.remove) {
      await runDatabaseCommand(removeThemeCopy, key);
      stored.delete(copyKey(key));
      changed = true;
    }
    for (const key of plan.refresh) {
      const theme = servers
        .find((server) => server.environmentId === key.environmentId)
        ?.environmentThemes?.find(({ id }) => id === key.themeId);
      if (theme === undefined) continue;
      const payload = encodeRememberedThemePayload(key.environmentId, theme);
      if (stored.get(copyKey(key))?.payload === payload) continue;
      await runDatabaseCommand(saveThemeCopy, { ...key, payload });
      stored.set(copyKey(key), { environmentId: key.environmentId, theme, payload });
      changed = true;
    }
    if (changed) publishStored();
  };

  const scheduleReconcile = () => {
    if (reconcileQueued || disposed) return;
    reconcileQueued = true;
    enqueue(async () => {
      reconcileQueued = false;
      await reconcile();
    });
  };

  const unsubscribeRegistry = appAtomRegistry.subscribe(
    mobileThemeRegistryAtom,
    setRegisteredMobileThemes,
    { immediate: true },
  );
  const unsubscribePresentations = appAtomRegistry.subscribe(
    environmentPresentations.presentationsAtom,
    scheduleReconcile,
  );
  const unsubscribeCatalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    scheduleReconcile,
  );

  enqueue(async () => {
    const payloads = await runDatabaseCommand(listThemeCopies, undefined);
    for (const payload of payloads) {
      const copy = decodeRememberedThemePayload(payload);
      if (copy === null) continue;
      stored.set(copyKey({ environmentId: copy.environmentId, themeId: copy.theme.id }), {
        ...copy,
        payload,
      });
    }
    loaded = true;
    publishStored();
    await reconcile();
  });

  return () => {
    disposed = true;
    unsubscribeRegistry();
    unsubscribePresentations();
    unsubscribeCatalog();
  };
}
