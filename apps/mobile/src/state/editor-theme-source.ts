import { CUSTOM_THEME_KEY_PREFIX } from "@t3tools/client-runtime/client-profile/keys";
import { hashClientProfileValue } from "@t3tools/client-runtime/client-profile/merge";
import type { ClientProfileValueSource } from "@t3tools/client-runtime/client-profile/source";
import { parseStoredTheme } from "@t3tools/shared/themeConversion";

export function createMobileEditorThemeSource(input: {
  readonly load: () => { readonly editorThemes?: Readonly<Record<string, unknown>> } | null;
  readonly write: (editorThemes: Readonly<Record<string, unknown>>) => void;
  readonly subscribe: (onChange: () => void) => () => void;
}): ClientProfileValueSource {
  const stored = () => input.load()?.editorThemes ?? {};

  return {
    owns: (base) =>
      base.startsWith(CUSTOM_THEME_KEY_PREFIX) && base.length > CUSTOM_THEME_KEY_PREFIX.length,
    ready: async () => {},
    read: () => ({
      values: Object.fromEntries(
        Object.entries(stored()).map(([id, value]) => [CUSTOM_THEME_KEY_PREFIX + id, value]),
      ),
      completePrefixes: [],
    }),
    defaults: () => ({}),
    apply: async (values) => {
      const next: Record<string, unknown> = { ...stored() };
      let changed = false;
      for (const [base, value] of Object.entries(values)) {
        const id = base.slice(CUSTOM_THEME_KEY_PREFIX.length);
        if (value === null) {
          if (!Object.hasOwn(next, id)) continue;
          delete next[id];
          changed = true;
        } else if (
          parseStoredTheme(value)?.id === id &&
          (!Object.hasOwn(next, id) ||
            hashClientProfileValue(next[id]) !== hashClientProfileValue(value))
        ) {
          next[id] = value;
          changed = true;
        }
      }
      if (changed) input.write(next);
      return Object.fromEntries(
        Object.keys(values)
          .map((base) => [base, base.slice(CUSTOM_THEME_KEY_PREFIX.length)] as const)
          .filter(([, id]) => Object.hasOwn(next, id))
          .map(([base, id]) => [base, next[id]]),
      );
    },
    subscribe: input.subscribe,
  };
}
