import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { combineClientProfileSources } from "@t3tools/client-runtime/client-profile/source";
import {
  createClientProfileSync,
  type ClientProfileEnvironment,
} from "@t3tools/client-runtime/client-profile/sync";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { isElectron } from "../env";
import { isMacPlatform, isWindowsPlatform } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { createWebSettingsSource } from "./settingsSource";
import { createWebSidecarStore } from "./sidecarStore";
import { createWebThemeSource } from "./themeSource";

const platform = typeof navigator === "undefined" ? "" : navigator.platform;
const surface = {
  kind: isElectron ? "desktop" : "browser",
  os: isMacPlatform(platform) ? "mac" : isWindowsPlatform(platform) ? "windows" : "linux",
} as const;

const environmentsAtom = Atom.make((get): ReadonlyArray<ClientProfileEnvironment> =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, p]) => ({
    environmentId,
    label: p.entry.target.label,
    connected: p.connection.phase === "connected",
    supportsProfile: p.serverConfig?.environment.capabilities.clientProfile === true,
    canWrite: get(serverEnvironment.updateClientProfile.permissionAtom(environmentId)),
    document: p.serverConfig?.clientProfile,
  })),
);

export const preferencesSync = createClientProfileSync({
  registry: appAtomRegistry,
  environmentsAtom,
  surface,
  source: combineClientProfileSources([createWebSettingsSource(surface), createWebThemeSource()]),
  sidecarStore: createWebSidecarStore(),
  push: async (environmentId, entries) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.updateClientProfile,
      { environmentId: EnvironmentId.make(environmentId), input: { entries } },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  },
  onError: (cause) => console.warn("Preference sync failed", safeErrorLogAttributes(cause)),
});
