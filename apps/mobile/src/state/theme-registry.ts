import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  createRuntimeCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import {
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
  createRememberedThemeReconciler,
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

function reportError(cause: unknown) {
  console.warn("[theme-registry] failed", safeErrorLogAttributes(cause));
}

export function installMobileThemeRegistry(): () => void {
  let disposed = false;
  let reconcileQueued = false;
  let chain: Promise<void> = Promise.resolve();
  const reconcile = createRememberedThemeReconciler({
    store: {
      list: () => runDatabaseCommand(listThemeCopies, undefined),
      save: (copy) => runDatabaseCommand(saveThemeCopy, copy),
      remove: (key) => runDatabaseCommand(removeThemeCopy, key),
    },
    publish: (copies) => appAtomRegistry.set(rememberedThemesAtom, copies),
  });

  const scheduleReconcile = () => {
    if (reconcileQueued || disposed) return;
    reconcileQueued = true;
    chain = chain
      .then(async () => {
        reconcileQueued = false;
        if (disposed) return;
        await reconcile({
          catalog: appAtomRegistry.get(environmentCatalog.catalogValueAtom),
          servers: appAtomRegistry.get(serverInputsAtom),
        });
      })
      .catch(reportError);
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
  scheduleReconcile();

  return () => {
    disposed = true;
    unsubscribeRegistry();
    unsubscribePresentations();
    unsubscribeCatalog();
  };
}
