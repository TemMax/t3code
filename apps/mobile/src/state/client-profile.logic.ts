import { SidebarProjectGroupingMode, ToolCallVisibility } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import {
  createMobileThemeSelectionPatch,
  MOBILE_THEME_IDS,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "../lib/mobileTheme";
import type { Preferences } from "../persistence/mobile-preferences";
import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";

const isToolCallVisibility = Schema.is(ToolCallVisibility);
const isGroupingMode = Schema.is(SidebarProjectGroupingMode);

function syncableThemeId(value: unknown): MobileThemeId | undefined {
  return typeof value === "string" &&
    value !== "material-you" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(value)
    ? (value as MobileThemeId)
    : undefined;
}

export function readMobileProfileValues(preferences: Preferences): Record<string, unknown> {
  const themeIds = resolveMobileThemeIds(preferences);
  return {
    themeMode: normalizeMobileThemeMode(preferences.themeMode),
    ...(themeIds.light === "material-you" ? {} : { themeLight: themeIds.light }),
    ...(themeIds.dark === "material-you" ? {} : { themeDark: themeIds.dark }),
    toolCallVisibility: preferences.toolCallVisibility ?? "showAll",
    followUpBehavior: preferences.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR,
    mathRenderingEnabled: preferences.mathRenderingEnabled === true,
    sidebarProjectGroupingMode:
      resolveMobileProjectGroupingSettings(preferences).sidebarProjectGroupingMode,
    sidebarWorkingShelfEnabled: preferences.workingShelfEnabled !== false,
  };
}

export function mobileProfilePatch(
  preferences: Preferences,
  values: Readonly<Record<string, unknown>>,
  systemAppearance: "light" | "dark",
): Partial<Preferences> {
  const patch: { -readonly [K in keyof Preferences]: Preferences[K] } = {};

  const mode: MobileThemeMode | undefined =
    values.themeMode === "system" || values.themeMode === "light" || values.themeMode === "dark"
      ? values.themeMode
      : undefined;
  if (mode !== undefined) patch.themeMode = mode;

  const light = syncableThemeId(values.themeLight);
  const dark = syncableThemeId(values.themeDark);
  if (light !== undefined || dark !== undefined) {
    const effectiveMode = mode ?? normalizeMobileThemeMode(preferences.themeMode);
    const active: MobileThemeAppearance =
      effectiveMode === "system" ? systemAppearance : effectiveMode;
    let themeIds = resolveMobileThemeIds(preferences);
    let themePatch = { ...themeIds, themeId: themeIds[active] } as Partial<Preferences>;
    for (const [appearance, id] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      if (id === undefined) continue;
      const next = createMobileThemeSelectionPatch(themeIds, active, appearance, id);
      themeIds = { light: next.lightThemeId, dark: next.darkThemeId };
      themePatch = next;
    }
    Object.assign(patch, themePatch);
  }

  if (isToolCallVisibility(values.toolCallVisibility)) {
    patch.toolCallVisibility = values.toolCallVisibility;
  }
  if (values.followUpBehavior === "queue" || values.followUpBehavior === "steer") {
    patch.followUpBehavior = values.followUpBehavior;
  }
  if (typeof values.mathRenderingEnabled === "boolean") {
    patch.mathRenderingEnabled = values.mathRenderingEnabled;
  }
  if (isGroupingMode(values.sidebarProjectGroupingMode)) {
    Object.assign(patch, mobileProjectGroupingModePatch(values.sidebarProjectGroupingMode));
  }
  if (typeof values.sidebarWorkingShelfEnabled === "boolean") {
    patch.workingShelfEnabled = values.sidebarWorkingShelfEnabled;
  }
  return patch;
}
