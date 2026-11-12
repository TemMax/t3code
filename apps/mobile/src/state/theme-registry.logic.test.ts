import { EnvironmentId, type EnvironmentTheme } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createMobileThemeRegistryMemo,
  createRememberedThemeReconciler,
  decodeRememberedThemePayload,
  encodeRememberedThemePayload,
  type MobileThemeRegistryInput,
  type RememberedThemeCopy,
} from "./theme-registry.logic";

const envA = EnvironmentId.make("environment-a");
const envB = EnvironmentId.make("environment-b");

const serverTheme = (id: string, canvas = "#101010"): EnvironmentTheme => ({
  id,
  name: id,
  appearance: "dark",
  canvas,
  accent: "#3366ff",
});

describe("remembered theme payloads", () => {
  it("decodes a remembered copy and drops a malformed one", () => {
    const theme = serverTheme("night-owl");

    expect(decodeRememberedThemePayload(encodeRememberedThemePayload(envA, theme))).toEqual({
      environmentId: envA,
      theme,
    });
    expect(decodeRememberedThemePayload("{")).toBeNull();
    const { name: _name, ...withoutName } = theme;
    expect(
      decodeRememberedThemePayload(JSON.stringify({ environmentId: envA, theme: withoutName })),
    ).toBeNull();
  });
});

describe("createMobileThemeRegistryMemo", () => {
  it("returns the same registry for unchanged inputs", () => {
    const memo = createMobileThemeRegistryMemo();
    const editorThemes = {};
    const remembered: MobileThemeRegistryInput["remembered"] = [];
    const themesA = [serverTheme("night-owl")];
    const input = (themes: ReadonlyArray<EnvironmentTheme>): MobileThemeRegistryInput => ({
      editorThemes,
      remembered,
      servers: [{ environmentId: envA, connected: true, environmentThemes: themes }],
    });

    const first = memo(input(themesA));

    expect(memo(input(themesA))).toBe(first);
    const changed = memo(input([...themesA, serverTheme("dawn")]));
    expect(changed).not.toBe(first);
    expect(changed.byId.has("dawn")).toBe(true);
  });

  it("uses a remembered copy for a server that has not sent its themes", () => {
    const memo = createMobileThemeRegistryMemo();

    const registry = memo({
      editorThemes: undefined,
      servers: [
        { environmentId: envA, connected: false, environmentThemes: undefined },
        { environmentId: envB, connected: false, environmentThemes: undefined },
      ],
      remembered: [{ environmentId: envA, theme: serverTheme("night-owl") }],
    });

    expect(registry.byId.get("night-owl")).toMatchObject({ origin: "server", environmentId: envA });
  });
});

describe("createRememberedThemeReconciler", () => {
  const copies = ["kept", "gone-1", "gone-2"].map((id) => ({
    environmentId: envA,
    theme: serverTheme(id),
  }));
  const state = {
    catalog: { isReady: true, entries: new Map([[envA, null]]) },
    servers: [{ environmentId: envA, connected: true, environmentThemes: [serverTheme("kept")] }],
  };

  function setup(failOnce: { list?: boolean; remove?: string }) {
    const fail = { ...failOnce };
    const removed: string[] = [];
    const published: string[][] = [];
    const reconcile = createRememberedThemeReconciler({
      store: {
        list: async () => {
          if (fail.list) {
            fail.list = false;
            throw new Error("list failed");
          }
          return copies.map((copy) => encodeRememberedThemePayload(copy.environmentId, copy.theme));
        },
        save: async () => {},
        remove: async ({ themeId }) => {
          if (fail.remove === themeId) {
            fail.remove = undefined;
            throw new Error("remove failed");
          }
          removed.push(themeId);
        },
      },
      publish: (remembered: ReadonlyArray<RememberedThemeCopy>) =>
        published.push(remembered.map(({ theme }) => theme.id)),
    });
    return { removed, published, reconcile };
  }

  it("retries a failed removal for the same server state and publishes what finished", async () => {
    const { removed, published, reconcile } = setup({ remove: "gone-2" });

    await expect(reconcile(state)).rejects.toThrow("remove failed");
    expect(removed).toEqual(["gone-1"]);
    expect(published.at(-1)).toEqual(["kept", "gone-2"]);

    await reconcile(state);
    expect(removed).toEqual(["gone-1", "gone-2"]);
    expect(published.at(-1)).toEqual(["kept"]);
  });

  it("reads the copies again after a failed first read", async () => {
    const { published, reconcile } = setup({ list: true });

    await expect(reconcile(state)).rejects.toThrow("list failed");
    expect(published).toEqual([]);

    await reconcile(state);
    expect(published).toEqual([["kept", "gone-1", "gone-2"], ["kept"]]);
  });
});
