import { EDITORS, EditorId } from "@t3tools/contracts";
import { ClientProfileSidecarSchema } from "@t3tools/client-runtime/client-profile/merge";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => ({ chatWidth: "wide" }),
      setClientSettings: async () => undefined,
    },
  }),
}));

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "~/appearanceFonts";
import { LAST_EDITOR_KEY } from "~/editorPreferences";
import { getClientSettings, isClientSettingsHydrated } from "~/hooks/useSettings";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  subscribeLocalStorageKey,
} from "~/hooks/useLocalStorage";
import { createWebSettingsSource } from "./settingsSource";
import { CLIENT_PROFILE_SIDECAR_STORAGE_KEY, createWebSidecarStore } from "./sidecarStore";

const browserOnMac = { kind: "browser", os: "mac" } as const;
const desktopOnMac = { kind: "desktop", os: "mac" } as const;

function cleanStorage(...keys: ReadonlyArray<string>) {
  const clear = () => keys.forEach(removeLocalStorageItem);
  clear();
  return { [Symbol.dispose]: clear };
}

describe("web settings source", () => {
  it("reads persisted settings only after they hydrate", async () => {
    const source = createWebSettingsSource(browserOnMac);

    await source.ready();

    expect(isClientSettingsHydrated()).toBe(true);
    expect(source.read().values.chatWidth).toBe("wide");
  });

  it("publishes per-OS and desktop-only keys only on their surfaces", async () => {
    const browser = createWebSettingsSource(browserOnMac);
    const desktop = createWebSettingsSource(desktopOnMac);
    await Promise.all([browser.ready(), desktop.ready()]);

    const browserKeys = Object.keys(browser.read().values);
    const desktopKeys = Object.keys(desktop.read().values);

    expect(browserKeys).toContain("fontFamilyCode");
    expect(browserKeys).not.toContain("browserLinkTarget");
    expect(browserKeys).not.toContain("snapShotShortcut");
    expect(desktopKeys).toEqual(
      expect.arrayContaining(["fontFamilyCode", "browserLinkTarget", "snapShotShortcut"]),
    );
    expect(desktop.owns("themeLight")).toBe(false);
    expect(desktop.owns("customTheme.x")).toBe(false);
  });

  it("applies valid settings values and skips invalid ones", async () => {
    const source = createWebSettingsSource(browserOnMac);
    await source.ready();
    const diffLayout = getClientSettings().diffLayout;

    const stored = await source.apply({ chatWidth: "full", diffLayout: 42 });

    expect(getClientSettings().chatWidth).toBe("full");
    expect(getClientSettings().diffLayout).toBe(diffLayout);
    expect(stored).toEqual({ chatWidth: "full" });
  });

  it("writes and reads typographyAdvanced and lastEditor through localStorage", async () => {
    using _storage = cleanStorage(TYPOGRAPHY_ADVANCED_STORAGE_KEY, LAST_EDITOR_KEY);
    const source = createWebSettingsSource(browserOnMac);
    const onChange = vi.fn();
    using _subscription = {
      [Symbol.dispose]: subscribeLocalStorageKey(TYPOGRAPHY_ADVANCED_STORAGE_KEY, onChange),
    };
    const editor = EDITORS[0].id;

    await source.apply({ typographyAdvanced: true, lastEditor: editor });

    expect(getLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY, Schema.Boolean)).toBe(true);
    expect(getLocalStorageItem(LAST_EDITOR_KEY, EditorId)).toBe(editor);
    expect(onChange).toHaveBeenCalledTimes(1);

    await source.apply({ lastEditor: null });

    expect(getLocalStorageItem(LAST_EDITOR_KEY, EditorId)).toBeNull();
    expect(source.read().values.lastEditor).toBeNull();
  });
});

describe("web sidecar store", () => {
  it("keeps one device id across loads and replaces a malformed sidecar", async () => {
    using _storage = cleanStorage(CLIENT_PROFILE_SIDECAR_STORAGE_KEY);
    const store = createWebSidecarStore();

    const first = await store.load();
    const second = await store.load();

    expect(first.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.deviceId).toBe(first.deviceId);

    window.localStorage.setItem(CLIENT_PROFILE_SIDECAR_STORAGE_KEY, "{garbage");
    const replaced = await store.load();

    expect(replaced.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(replaced.deviceId).not.toBe(first.deviceId);
    expect(replaced.entries).toEqual({});
    expect(
      getLocalStorageItem(CLIENT_PROFILE_SIDECAR_STORAGE_KEY, ClientProfileSidecarSchema),
    ).toEqual(replaced);
  });
});
