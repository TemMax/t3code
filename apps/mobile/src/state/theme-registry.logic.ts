import { EnvironmentId, EnvironmentTheme } from "@t3tools/contracts";
import { parseStoredTheme, publishedThemeDefinitions } from "@t3tools/shared/themeConversion";
import type { ThemeDefinition } from "@t3tools/shared/themePalettes";
import * as Schema from "effect/Schema";

import {
  buildMobileThemeRegistry,
  planRememberedThemes,
  type MobileRememberedTheme,
  type MobileRememberedThemeKey,
  type MobileServerThemeSource,
  type MobileThemeRegistry,
} from "../lib/mobileThemeRegistry";

export interface RememberedThemeCopy {
  readonly environmentId: EnvironmentId;
  readonly theme: EnvironmentTheme;
}

export interface MobileThemeRegistryServerInput {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly environmentThemes: ReadonlyArray<EnvironmentTheme> | undefined;
}

export interface MobileThemeRegistryInput {
  readonly editorThemes: Readonly<Record<string, unknown>> | undefined;
  readonly servers: ReadonlyArray<MobileThemeRegistryServerInput>;
  readonly remembered: ReadonlyArray<RememberedThemeCopy>;
}

const RememberedThemePayload = Schema.Struct({
  environmentId: EnvironmentId,
  theme: EnvironmentTheme,
});
const decodeRememberedPayload = Schema.decodeUnknownOption(RememberedThemePayload);

export function encodeRememberedThemePayload(
  environmentId: EnvironmentId,
  theme: EnvironmentTheme,
): string {
  return JSON.stringify({ environmentId, theme });
}

export function decodeRememberedThemePayload(payload: string): RememberedThemeCopy | null {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const decoded = decodeRememberedPayload(json);
  return decoded._tag === "Some" ? decoded.value : null;
}

function sameServerInputs(
  a: ReadonlyArray<MobileThemeRegistryServerInput>,
  b: ReadonlyArray<MobileThemeRegistryServerInput>,
): boolean {
  return (
    a.length === b.length &&
    a.every((server, index) => {
      const other = b[index]!;
      return (
        server.environmentId === other.environmentId &&
        server.connected === other.connected &&
        server.environmentThemes === other.environmentThemes
      );
    })
  );
}

export interface RememberedThemeStore {
  readonly list: () => Promise<ReadonlyArray<string>>;
  readonly save: (copy: MobileRememberedThemeKey & { readonly payload: string }) => Promise<void>;
  readonly remove: (key: MobileRememberedThemeKey) => Promise<void>;
}

export interface RememberedThemeReconcileState {
  readonly catalog: {
    readonly isReady: boolean;
    readonly entries: ReadonlyMap<EnvironmentId, unknown>;
  };
  readonly servers: ReadonlyArray<MobileThemeRegistryServerInput>;
}

/**
 * Keeps the phone's copies of server themes in line with what connected servers publish.
 * A pass that fails part way counts as not done, so the next call with the same state retries it.
 */
export function createRememberedThemeReconciler(input: {
  readonly store: RememberedThemeStore;
  readonly publish: (copies: ReadonlyArray<RememberedThemeCopy>) => void;
}): (state: RememberedThemeReconcileState) => Promise<void> {
  const stored = new Map<string, RememberedThemeCopy & { readonly payload: string }>();
  let loaded = false;
  let reconciled: RememberedThemeReconcileState | undefined;
  const keyOf = ({ environmentId, themeId }: MobileRememberedThemeKey) =>
    `${environmentId}\u0000${themeId}`;
  const publish = () =>
    input.publish(
      [...stored.values()].map(({ environmentId, theme }) => ({ environmentId, theme })),
    );

  return async (state) => {
    if (!loaded) {
      for (const payload of await input.store.list()) {
        const copy = decodeRememberedThemePayload(payload);
        if (copy !== null) {
          stored.set(keyOf({ environmentId: copy.environmentId, themeId: copy.theme.id }), {
            ...copy,
            payload,
          });
        }
      }
      loaded = true;
      publish();
    }
    if (!state.catalog.isReady) return;
    if (
      reconciled !== undefined &&
      reconciled.catalog === state.catalog &&
      sameServerInputs(reconciled.servers, state.servers)
    ) {
      return;
    }

    const plan = planRememberedThemes({
      servers: state.servers.map((server) => ({
        environmentId: server.environmentId,
        connected: server.connected,
        published:
          server.environmentThemes === undefined
            ? undefined
            : publishedThemeDefinitions(server.environmentThemes),
      })),
      remembered: [...stored.values()].map(({ environmentId, theme }) => ({
        environmentId,
        themeId: theme.id,
      })),
      knownEnvironmentIds: new Set(state.catalog.entries.keys()),
    });

    let changed = false;
    try {
      for (const key of plan.remove) {
        await input.store.remove(key);
        stored.delete(keyOf(key));
        changed = true;
      }
      for (const key of plan.refresh) {
        const theme = state.servers
          .find((server) => server.environmentId === key.environmentId)
          ?.environmentThemes?.find(({ id }) => id === key.themeId);
        if (theme === undefined) continue;
        const payload = encodeRememberedThemePayload(key.environmentId, theme);
        if (stored.get(keyOf(key))?.payload === payload) continue;
        await input.store.save({ ...key, payload });
        stored.set(keyOf(key), { environmentId: key.environmentId, theme, payload });
        changed = true;
      }
      reconciled = state;
    } finally {
      if (changed) publish();
    }
  };
}

export function createMobileThemeRegistryMemo(): (
  input: MobileThemeRegistryInput,
) => MobileThemeRegistry {
  const editorDefinitions = new WeakMap<object, ThemeDefinition | null>();
  const publishedDefinitions = new WeakMap<object, ReadonlyArray<ThemeDefinition>>();
  let previousInput: MobileThemeRegistryInput | undefined;
  let previousRegistry: MobileThemeRegistry | undefined;

  const editorDefinition = (value: unknown): ThemeDefinition | null => {
    if (typeof value !== "object" || value === null) return parseStoredTheme(value);
    const cached = editorDefinitions.get(value);
    if (cached !== undefined) return cached;
    const parsed = parseStoredTheme(value);
    editorDefinitions.set(value, parsed);
    return parsed;
  };

  const published = (source: ReadonlyArray<EnvironmentTheme>): ReadonlyArray<ThemeDefinition> => {
    const cached = publishedDefinitions.get(source);
    if (cached !== undefined) return cached;
    const definitions = publishedThemeDefinitions(source);
    publishedDefinitions.set(source, definitions);
    return definitions;
  };

  const rememberedDefinitions = (copy: RememberedThemeCopy): ReadonlyArray<ThemeDefinition> => {
    const cached = publishedDefinitions.get(copy.theme);
    if (cached !== undefined) return cached;
    const definitions = publishedThemeDefinitions([copy.theme]);
    publishedDefinitions.set(copy.theme, definitions);
    return definitions;
  };

  return (input) => {
    if (
      previousRegistry !== undefined &&
      previousInput !== undefined &&
      previousInput.editorThemes === input.editorThemes &&
      previousInput.remembered === input.remembered &&
      sameServerInputs(previousInput.servers, input.servers)
    ) {
      return previousRegistry;
    }

    const editorThemes = Object.values(input.editorThemes ?? {}).flatMap((value) => {
      const definition = editorDefinition(value);
      return definition === null ? [] : [definition];
    });
    const servers = input.servers.map((server): MobileServerThemeSource => ({
      environmentId: server.environmentId,
      connected: server.connected,
      published:
        server.environmentThemes === undefined ? undefined : published(server.environmentThemes),
    }));
    const remembered = input.remembered.flatMap((copy): ReadonlyArray<MobileRememberedTheme> =>
      rememberedDefinitions(copy).map((definition) => ({
        environmentId: copy.environmentId,
        definition,
      })),
    );

    previousInput = input;
    previousRegistry = buildMobileThemeRegistry({ editorThemes, servers, remembered });
    return previousRegistry;
  };
}
