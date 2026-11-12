import { EnvironmentId, EnvironmentTheme } from "@t3tools/contracts";
import { parseStoredTheme, publishedThemeDefinitions } from "@t3tools/shared/themeConversion";
import type { ThemeDefinition } from "@t3tools/shared/themePalettes";
import * as Schema from "effect/Schema";

import {
  buildMobileThemeRegistry,
  type MobileRememberedTheme,
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

export function sameServerInputs(
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
