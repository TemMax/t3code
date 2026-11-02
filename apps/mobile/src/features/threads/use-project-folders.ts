import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Folders are on when any connected environment's server settings turn them on. */
export function useProjectFoldersEnabled(): boolean {
  const { environments } = useEnvironments();
  return environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.settings.sidebarProjectFoldersEnabled === true,
  );
}

function toggled(keys: readonly string[], key: string): readonly string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

/** Collapsed folders, saved on this device in the existing collapsedProjectGroups preference. */
export function useProjectFolderCollapse(): {
  readonly loaded: boolean;
  readonly collapsedKeys: ReadonlySet<string>;
  readonly toggleFolder: (folderKey: string) => void;
} {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const signature = loaded
    ? [...(preferencesResult.value.collapsedProjectGroups ?? [])].sort().join("\n")
    : "";
  // Stable identity while contents are unchanged: list items compare by content.
  const collapsedKeys = useMemo<ReadonlySet<string>>(
    () => new Set(signature === "" ? [] : signature.split("\n")),
    [signature],
  );

  const toggleFolder = (folderKey: string) => {
    if (!loaded) return;
    // Transforms read optimistic state so same-frame presses toggle twice.
    savePreferences({
      transform: (current) => ({
        collapsedProjectGroups: toggled(current.collapsedProjectGroups ?? [], folderKey),
      }),
    });
  };

  return { loaded, collapsedKeys, toggleFolder };
}
