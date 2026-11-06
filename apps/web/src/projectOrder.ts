import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  getProjectOrderKey,
  moveProjectOrderKeys,
  pendingProjectOrder,
  readSharedProjectOrder,
  visibleProjectOrder,
  type PendingProjectOrder,
} from "@t3tools/client-runtime/state/project-grouping";
import { Atom } from "effect/reactivity";

import { orderItemsByPreferredIds } from "./components/Sidebar.logic";
import { useUpdatePrimarySettings } from "./hooks/useSettings";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { readProjects } from "./state/entities";
import { environmentPresentations } from "./state/presentation";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "./uiStateStore";

const sharedProjectOrderAtom = Atom.make((get) =>
  readSharedProjectOrder(
    [...get(environmentPresentations.serverConfigsAtom).values()].map((config) => config.settings),
  ),
).pipe(Atom.withLabel("shared-project-order"));

const pendingProjectOrderAtom = Atom.make<PendingProjectOrder | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pending-project-order"),
);

const visibleSharedProjectOrderAtom = Atom.make((get) =>
  visibleProjectOrder(get(sharedProjectOrderAtom), get(pendingProjectOrderAtom)),
).pipe(Atom.withLabel("visible-shared-project-order"));

/** The manual project order: shared through the servers, or this browser's own before that. */
export function useProjectOrder(): readonly string[] {
  const shared = useAtomValue(visibleSharedProjectOrderAtom);
  const local = useUiStateStore((store) => store.projectOrder);
  return shared.length > 0 ? shared : local;
}

export function readProjectOrder(): readonly string[] {
  const shared = appAtomRegistry.get(visibleSharedProjectOrderAtom);
  return shared.length > 0 ? shared : useUiStateStore.getState().projectOrder;
}

export function orderProjectsManually<TProject extends EnvironmentProject>(
  projects: readonly TProject[],
  projectOrder: readonly string[],
) {
  return orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
}

/** Moves projects to the target projects' place and shares the new order through the servers. */
export function useMoveProjects() {
  const updateSettings = useUpdatePrimarySettings();
  return (draggedKeys: readonly string[], targetKeys: readonly string[]) => {
    const order = orderProjectsManually(readProjects(), readProjectOrder()).map(getProjectOrderKey);
    const next = moveProjectOrderKeys(order, draggedKeys, targetKeys);
    if (next === null) return;
    useUiStateStore.setState({ projectOrder: next });
    const pending = pendingProjectOrder(appAtomRegistry.get(sharedProjectOrderAtom), next);
    appAtomRegistry.set(pendingProjectOrderAtom, pending);
    updateSettings(
      { sidebarProjectOrder: next },
      {
        onFailed: () => {
          if (appAtomRegistry.get(pendingProjectOrderAtom) === pending) {
            appAtomRegistry.set(pendingProjectOrderAtom, null);
          }
        },
      },
    );
  };
}
