import { EnvironmentId } from "@t3tools/contracts";
import { T3_CODE_DARK_THEME_COLORS, type ThemeDefinition } from "@t3tools/shared/themePalettes";
import { describe, expect, it, vi } from "vitest";

import {
  buildMobileThemeRegistry,
  EMPTY_MOBILE_THEME_REGISTRY,
  getRegisteredMobileTheme,
  getRegisteredMobileThemes,
  isUsableMobileThemeForAppearance,
  planRememberedThemes,
  setRegisteredMobileThemes,
  subscribeRegisteredMobileThemes,
  type MobileServerThemeSource,
} from "./mobileThemeRegistry";

const envA = EnvironmentId.make("environment-a");
const envB = EnvironmentId.make("environment-b");

const theme = (id: string, canvas = "#101010"): ThemeDefinition => ({
  id,
  label: id,
  appearance: "dark",
  colors: { ...T3_CODE_DARK_THEME_COLORS, canvas },
});

const server = (
  environmentId: EnvironmentId,
  published: ReadonlyArray<ThemeDefinition> | undefined,
  connected = true,
): MobileServerThemeSource => ({ environmentId, connected, published });

const key = (environmentId: EnvironmentId, themeId: string) => ({ environmentId, themeId });

describe("buildMobileThemeRegistry", () => {
  it("prefers an editor theme over a server theme with the same id", () => {
    const registry = buildMobileThemeRegistry({
      editorThemes: [theme("islands-dark", "#111111")],
      servers: [server(envA, [theme("islands-dark", "#222222")])],
      remembered: [],
    });

    expect(registry.byId.get("islands-dark")).toMatchObject({
      origin: "editor",
      environmentId: null,
      definition: { colors: { canvas: "#111111" } },
    });
    expect(registry.themes).toHaveLength(1);
  });

  it("takes a server theme from the first server that publishes it", () => {
    const registry = buildMobileThemeRegistry({
      editorThemes: [],
      servers: [
        server(envA, [theme("islands-dark", "#aaaaaa")]),
        server(envB, [theme("islands-dark", "#bbbbbb")]),
      ],
      remembered: [],
    });

    expect(registry.byId.get("islands-dark")).toMatchObject({
      origin: "server",
      environmentId: envA,
      definition: { colors: { canvas: "#aaaaaa" } },
    });
  });

  it("draws a remembered copy while its server is offline", () => {
    const copy = theme("islands-dark", "#cccccc");
    const registry = buildMobileThemeRegistry({
      editorThemes: [],
      servers: [server(envA, undefined, false)],
      remembered: [{ environmentId: envA, definition: copy }],
    });

    expect(registry.byId.get("islands-dark")?.definition).toBe(copy);
  });

  it("keeps a remembered copy while a connected server has not sent its themes", () => {
    const copy = theme("islands-dark", "#cccccc");
    const registry = buildMobileThemeRegistry({
      editorThemes: [],
      servers: [server(envA, undefined, true)],
      remembered: [{ environmentId: envA, definition: copy }],
    });

    expect(registry.byId.get("islands-dark")?.definition).toBe(copy);
  });

  it("ignores a remembered copy that its connected server no longer publishes", () => {
    const registry = buildMobileThemeRegistry({
      editorThemes: [],
      servers: [server(envA, [])],
      remembered: [{ environmentId: envA, definition: theme("islands-dark") }],
    });

    expect(registry.byId.has("islands-dark")).toBe(false);
  });

  it("ignores remembered copies of environments that are not on the phone", () => {
    const registry = buildMobileThemeRegistry({
      editorThemes: [],
      servers: [server(envA, undefined, false)],
      remembered: [{ environmentId: envB, definition: theme("islands-dark") }],
    });

    expect(registry.themes).toEqual([]);
  });

  it("never lets a theme replace a built-in or reserved id", () => {
    const ids = ["grove", "t3-code", "material-you", "system"];
    const registry = buildMobileThemeRegistry({
      editorThemes: ids.map((id) => theme(id)),
      servers: [
        server(
          envA,
          ids.map((id) => theme(id)),
        ),
      ],
      remembered: [],
    });

    expect(registry.themes).toEqual([]);
    for (const id of ids) expect(registry.byId.has(id)).toBe(false);
  });

  it("orders server themes before editor themes, by server", () => {
    const registry = buildMobileThemeRegistry({
      editorThemes: [theme("e1")],
      servers: [server(envA, [theme("a1")]), server(envB, [theme("b1")])],
      remembered: [],
    });

    expect(registry.themes.map((t) => t.id)).toEqual(["a1", "b1", "e1"]);
  });
});

describe("planRememberedThemes", () => {
  const known = new Set([envA, envB]);

  it("refreshes every theme a connected server publishes", () => {
    const plan = planRememberedThemes({
      servers: [
        server(envA, [theme("a1"), theme("a2")]),
        server(envB, [theme("b1")], false),
        server(EnvironmentId.make("environment-c"), undefined),
      ],
      remembered: [],
      knownEnvironmentIds: known,
    });

    expect(plan.refresh).toEqual([key(envA, "a1"), key(envA, "a2")]);
    expect(plan.remove).toEqual([]);
  });

  it("removes a copy its connected server no longer publishes", () => {
    const plan = planRememberedThemes({
      servers: [server(envA, [theme("a1")])],
      remembered: [key(envA, "a1"), key(envA, "gone")],
      knownEnvironmentIds: known,
    });

    expect(plan.remove).toEqual([key(envA, "gone")]);
    expect(plan.refresh).toEqual([key(envA, "a1")]);
  });

  it("removes copies of servers no longer on the phone", () => {
    const plan = planRememberedThemes({
      servers: [server(envA, [])],
      remembered: [key(envB, "b1")],
      knownEnvironmentIds: new Set([envA]),
    });

    expect(plan.remove).toEqual([key(envB, "b1")]);
  });

  it("keeps copies of offline servers", () => {
    const plan = planRememberedThemes({
      servers: [server(envA, undefined, false), server(envB, [], false)],
      remembered: [key(envA, "a1"), key(envB, "b1")],
      knownEnvironmentIds: known,
    });

    expect(plan).toEqual({ refresh: [], remove: [] });
  });
});

describe("isUsableMobileThemeForAppearance", () => {
  it("needs the theme's own appearance or a variant for the other one", () => {
    const dark = theme("dark-only");
    const both: ThemeDefinition = {
      ...dark,
      variants: { light: { ...T3_CODE_DARK_THEME_COLORS, canvas: "#ffffff" } },
    };

    expect(isUsableMobileThemeForAppearance(dark, "dark")).toBe(true);
    expect(isUsableMobileThemeForAppearance(dark, "light")).toBe(false);
    expect(isUsableMobileThemeForAppearance(both, "light")).toBe(true);
  });
});

describe("registered mobile themes snapshot", () => {
  it("resolves a registered theme by id and notifies subscribers", () => {
    const definition = theme("islands-dark");
    const registry = buildMobileThemeRegistry({
      editorThemes: [definition],
      servers: [],
      remembered: [],
    });
    const listener = vi.fn();
    const unsubscribe = subscribeRegisteredMobileThemes(listener);

    try {
      setRegisteredMobileThemes(registry);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getRegisteredMobileThemes()).toBe(registry);
      expect(getRegisteredMobileTheme("islands-dark")).toBe(definition);
      expect(getRegisteredMobileTheme("missing")).toBeNull();

      unsubscribe();
      setRegisteredMobileThemes(registry);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      setRegisteredMobileThemes(EMPTY_MOBILE_THEME_REGISTRY);
    }
  });
});
