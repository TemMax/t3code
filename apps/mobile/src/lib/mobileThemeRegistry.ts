import type { EnvironmentId } from "@t3tools/contracts";
import {
  getThemeColorsForAppearance,
  MOBILE_THEME_IDS,
  RESERVED_THEME_IDS,
  type ThemeAppearance,
  type ThemeDefinition,
} from "@t3tools/shared/themePalettes";

export interface MobileRegisteredTheme {
  readonly id: string;
  readonly definition: ThemeDefinition;
  readonly origin: "editor" | "server";
  readonly environmentId: EnvironmentId | null;
}

export interface MobileThemeRegistry {
  readonly themes: ReadonlyArray<MobileRegisteredTheme>;
  readonly byId: ReadonlyMap<string, MobileRegisteredTheme>;
}

export const EMPTY_MOBILE_THEME_REGISTRY: MobileThemeRegistry = {
  themes: [],
  byId: new Map(),
};

export interface MobileServerThemeSource {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  // undefined: no theme list yet; []: the server publishes none (its copies are dropped)
  readonly published: ReadonlyArray<ThemeDefinition> | undefined;
}

export interface MobileRememberedTheme {
  readonly environmentId: EnvironmentId;
  readonly definition: ThemeDefinition;
}

export interface MobileRememberedThemeKey {
  readonly environmentId: EnvironmentId;
  readonly themeId: string;
}

const MATERIAL_YOU_THEME_ID = "material-you";

const isProtectedThemeId = (id: string): boolean =>
  (MOBILE_THEME_IDS as ReadonlyArray<string>).includes(id) ||
  id === MATERIAL_YOU_THEME_ID ||
  RESERVED_THEME_IDS.has(id);

export function buildMobileThemeRegistry(input: {
  readonly editorThemes: ReadonlyArray<ThemeDefinition>;
  readonly servers: ReadonlyArray<MobileServerThemeSource>;
  readonly remembered: ReadonlyArray<MobileRememberedTheme>;
}): MobileThemeRegistry {
  const byId = new Map<string, MobileRegisteredTheme>();

  const editorEntries: MobileRegisteredTheme[] = [];
  for (const definition of input.editorThemes) {
    if (isProtectedThemeId(definition.id) || byId.has(definition.id)) continue;
    const entry: MobileRegisteredTheme = {
      id: definition.id,
      definition,
      origin: "editor",
      environmentId: null,
    };
    byId.set(definition.id, entry);
    editorEntries.push(entry);
  }

  const serverEntries: MobileRegisteredTheme[] = [];
  for (const server of input.servers) {
    const definitions =
      server.published ??
      input.remembered
        .filter((copy) => copy.environmentId === server.environmentId)
        .map((copy) => copy.definition);
    for (const definition of definitions) {
      if (isProtectedThemeId(definition.id) || byId.has(definition.id)) continue;
      const entry: MobileRegisteredTheme = {
        id: definition.id,
        definition,
        origin: "server",
        environmentId: server.environmentId,
      };
      byId.set(definition.id, entry);
      serverEntries.push(entry);
    }
  }

  return { themes: [...serverEntries, ...editorEntries], byId };
}

export function planRememberedThemes(input: {
  readonly servers: ReadonlyArray<MobileServerThemeSource>;
  readonly remembered: ReadonlyArray<MobileRememberedThemeKey>;
  readonly knownEnvironmentIds: ReadonlySet<EnvironmentId>;
}): {
  readonly refresh: ReadonlyArray<MobileRememberedThemeKey>;
  readonly remove: ReadonlyArray<MobileRememberedThemeKey>;
} {
  const publishedIds = new Map<EnvironmentId, ReadonlySet<string>>();
  const refresh: MobileRememberedThemeKey[] = [];
  for (const server of input.servers) {
    if (!server.connected || server.published === undefined) continue;
    publishedIds.set(server.environmentId, new Set(server.published.map(({ id }) => id)));
    for (const { id } of server.published) {
      refresh.push({ environmentId: server.environmentId, themeId: id });
    }
  }

  const remove = input.remembered.filter(
    ({ environmentId, themeId }) =>
      !input.knownEnvironmentIds.has(environmentId) ||
      publishedIds.get(environmentId)?.has(themeId) === false,
  );
  return {
    refresh: refresh.filter(
      (key) =>
        !remove.some(
          ({ environmentId, themeId }) =>
            environmentId === key.environmentId && themeId === key.themeId,
        ),
    ),
    remove,
  };
}

export function isUsableMobileThemeForAppearance(
  definition: ThemeDefinition,
  appearance: ThemeAppearance,
): boolean {
  return getThemeColorsForAppearance(definition, appearance) !== null;
}

let registeredThemes: MobileThemeRegistry = EMPTY_MOBILE_THEME_REGISTRY;
const listeners = new Set<() => void>();

export function setRegisteredMobileThemes(registry: MobileThemeRegistry): void {
  registeredThemes = registry;
  for (const listener of listeners) listener();
}

export function getRegisteredMobileThemes(): MobileThemeRegistry {
  return registeredThemes;
}

export function getRegisteredMobileTheme(id: string): ThemeDefinition | null {
  return registeredThemes.byId.get(id)?.definition ?? null;
}

export function subscribeRegisteredMobileThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
