import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";
import {
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import {
  readProjects,
  useDelegatedUnderParent,
  useProjects,
  useQuietThreadShells,
} from "../state/entities";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

function orderProjectsManually<TProject extends EnvironmentProject>(
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

/** Moves the dragged folder's projects to the target folder's place in the manual order. */
export function reorderSidebarProjectGroups(
  dragged: SidebarProjectSnapshot,
  target: SidebarProjectSnapshot,
) {
  const { projectOrder, reorderProjects } = useUiStateStore.getState();
  reorderProjects(
    orderProjectsManually(readProjects(), projectOrder).map(getProjectOrderKey),
    dragged.memberProjects.map((member) => member.physicalProjectKey),
    target.memberProjects.map((member) => member.physicalProjectKey),
  );
}

export function useSidebarProjectGroups() {
  const projects = useProjects();
  // Activity order lags a running thread's streaming ticks until its next
  // real change; reading every tick re-rendered the whole sidebar with it.
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedProjects = orderProjectsManually(projects, projectOrder);
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const unsortedGroups = buildSidebarProjectSnapshots({
    projects: sortOrder === "manual" ? orderedProjects : projects,
    groupScratchProjects: true,
    settings: groupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
  });
  return sortSidebarV2ProjectGroups(unsortedGroups, threads, sortOrder, delegatedUnderParent);
}
