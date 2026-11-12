import { EnvironmentId, type EnvironmentTheme } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createMobileThemeRegistryMemo,
  decodeRememberedThemePayload,
  encodeRememberedThemePayload,
  type MobileThemeRegistryInput,
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
