import { EditorId } from "@t3tools/contracts";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  clientProfileBaseKeys,
  CUSTOM_THEME_KEY_PREFIX,
  isClientProfileBaseKey,
  type ClientProfileSurface,
} from "@t3tools/client-runtime/client-profile/keys";
import type { ClientProfileValueSource } from "@t3tools/client-runtime/client-profile/source";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";
import { LAST_EDITOR_KEY } from "../editorPreferences";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsUpdate,
  subscribeClientSettings,
} from "../hooks/useSettings";
import {
  getLocalStorageItem,
  subscribeLocalStorageKey,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";

const THEME_BASES = new Set(["themeMode", "themeLight", "themeDark"]);
const settingsFields: Readonly<Record<string, Schema.Codec<unknown, unknown>>> =
  ClientSettingsSchema.fields;
const encodeSettingsField = Object.fromEntries(
  Object.entries(settingsFields).map(([key, field]) => [key, Schema.encodeSync(field)]),
);
const decodeSettingsField = Object.fromEntries(
  Object.entries(settingsFields).map(([key, field]) => [key, Schema.decodeUnknownOption(field)]),
);
const isEditorId = Schema.is(EditorId);

function readLocalStorage<T, E>(key: string, schema: Schema.Codec<T, E>): T | null | undefined {
  try {
    return getLocalStorageItem(key, schema);
  } catch {
    return undefined;
  }
}

export function createWebSettingsSource(surface: ClientProfileSurface): ClientProfileValueSource {
  const owns = (base: string) =>
    isClientProfileBaseKey(base, surface) &&
    !THEME_BASES.has(base) &&
    !base.startsWith(CUSTOM_THEME_KEY_PREFIX);
  const ownedKeys = clientProfileBaseKeys(surface).filter(owns);
  const settingsKeys = ownedKeys.filter((key) => key in settingsFields);

  const read = () => {
    const values: Record<string, unknown> = {};
    const settings: Readonly<Record<string, unknown>> = getClientSettings();
    for (const key of settingsKeys) {
      values[key] = encodeSettingsField[key]!(settings[key]);
    }
    if (owns("typographyAdvanced")) {
      const stored = readLocalStorage(TYPOGRAPHY_ADVANCED_STORAGE_KEY, Schema.Boolean);
      if (stored !== undefined) values.typographyAdvanced = stored ?? false;
    }
    if (owns("lastEditor")) {
      const stored = readLocalStorage(LAST_EDITOR_KEY, EditorId);
      if (stored !== undefined) values.lastEditor = stored ?? null;
    }
    return { values, completePrefixes: [] };
  };

  return {
    owns,
    ready: ensureClientSettingsHydrated,
    read,
    defaults: () => {
      const defaults: Record<string, unknown> = {};
      const settings: Readonly<Record<string, unknown>> = DEFAULT_CLIENT_SETTINGS;
      for (const key of settingsKeys) {
        defaults[key] = encodeSettingsField[key]!(settings[key]);
      }
      if (owns("typographyAdvanced")) defaults.typographyAdvanced = false;
      if (owns("lastEditor")) defaults.lastEditor = null;
      return defaults;
    },
    apply: async (values) => {
      const applied = new Set<string>();
      const decoded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (!owns(key)) continue;
        if (key === "typographyAdvanced") {
          if (typeof value !== "boolean") continue;
          writeLocalStorageValue(TYPOGRAPHY_ADVANCED_STORAGE_KEY, value, false, Schema.Boolean);
        } else if (key === "lastEditor") {
          if (value !== null && !isEditorId(value)) continue;
          writeLocalStorageValue(LAST_EDITOR_KEY, value, null, EditorId);
        } else {
          const result = decodeSettingsField[key]!(value);
          if (Option.isNone(result)) continue;
          decoded[key] = result.value;
        }
        applied.add(key);
      }
      if (Object.keys(decoded).length > 0) {
        await persistClientSettingsUpdate((current) => ({ ...current, ...decoded }));
      }
      return Object.fromEntries(Object.entries(read().values).filter(([key]) => applied.has(key)));
    },
    subscribe: (onChange) => {
      const unsubscribes = [subscribeClientSettings(onChange)];
      if (owns("typographyAdvanced")) {
        unsubscribes.push(subscribeLocalStorageKey(TYPOGRAPHY_ADVANCED_STORAGE_KEY, onChange));
      }
      if (owns("lastEditor")) {
        unsubscribes.push(subscribeLocalStorageKey(LAST_EDITOR_KEY, onChange));
      }
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}
