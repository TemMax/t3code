import { describe, expect, it, vi } from "vite-plus/test";

import { setAppearanceMode, setTheme, setThemeHalf } from "../hooks/useTheme";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  installCustomTheme,
  invalidateCustomThemes,
  getCustomThemes,
  getDefaultThemeColors,
  type ThemeDefinition,
} from "../themePalette";
import { createWebThemeSource, themeProfileValuesForDefault } from "./themeSource";

function isolateThemeStorage() {
  const reset = () => {
    localStorage.clear();
    invalidateCustomThemes();
  };
  reset();
  return { [Symbol.dispose]: reset };
}

const darkOnly = (id: string, label = id): ThemeDefinition => ({
  id,
  label,
  appearance: "dark",
  colors: getDefaultThemeColors("dark"),
});

describe("web theme profile source", () => {
  it("maps the standard palette to t3-code and halves to light and dark", () => {
    using _storage = isolateThemeStorage();
    const source = createWebThemeSource();

    setTheme("system");
    expect(source.read().values).toMatchObject({
      themeMode: "system",
      themeLight: "t3-code",
      themeDark: "t3-code",
    });

    setThemeHalf("dark", "grove");
    expect(source.read().values).toMatchObject({ themeLight: "t3-code", themeDark: "grove" });

    setTheme("ocean");
    expect(source.read().values).toMatchObject({ themeLight: "ocean", themeDark: "ocean" });

    setAppearanceMode("dark");
    expect(source.read().values.themeMode).toBe("dark");
  });

  it("keeps a stored theme that has not loaded yet out of the profile", () => {
    using _storage = isolateThemeStorage();
    localStorage.setItem("t3code:theme", "environment-theme-not-loaded");

    const { values } = createWebThemeSource().read();

    expect(values).toHaveProperty("themeMode");
    expect(values).not.toHaveProperty("themeLight");
    expect(values).not.toHaveProperty("themeDark");
  });

  it("publishes only the half a single-appearance theme renders", () => {
    using _storage = isolateThemeStorage();
    installCustomTheme(darkOnly("night-only"));
    setTheme("night-only");

    const { values } = createWebThemeSource().read();

    expect(values.themeDark).toBe("night-only");
    expect(values).not.toHaveProperty("themeLight");
  });

  it("skips an unresolved theme and applies it once its custom theme arrives", async () => {
    using _storage = isolateThemeStorage();
    const source = createWebThemeSource();
    const onChange = vi.fn();
    using _subscription = { [Symbol.dispose]: source.subscribe(onChange) };
    setTheme("system");
    onChange.mockClear();

    await source.apply({ themeDark: "custom-x" });
    expect(source.read().values.themeDark).toBe("t3-code");

    installCustomTheme(darkOnly("custom-x"));
    expect(onChange).toHaveBeenCalled();

    await expect(source.apply({ themeDark: "custom-x" })).resolves.toEqual({
      themeDark: "custom-x",
    });
    expect(source.read().values.themeDark).toBe("custom-x");
  });

  it("installs, updates and removes custom themes and applies them before the halves", async () => {
    using _storage = isolateThemeStorage();
    const source = createWebThemeSource();

    await source.apply({ "customTheme.x": darkOnly("x", "First"), themeDark: "x" });
    expect(source.read().values.themeDark).toBe("x");
    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["First"]);

    await source.apply({ "customTheme.x": darkOnly("x", "Second") });
    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["Second"]);

    await expect(source.apply({ "customTheme.x": null })).resolves.toEqual({});
    expect(source.read().values).not.toHaveProperty("customTheme.x");
    expect(getCustomThemes()).toEqual([]);
  });

  it("reports custom themes as incomplete while the library is unavailable", async () => {
    using _storage = isolateThemeStorage();
    const source = createWebThemeSource();
    installCustomTheme(darkOnly("x"));
    expect(source.read().completePrefixes).toEqual(["customTheme."]);
    const library = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)!;

    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, "{not json");
    invalidateCustomThemes();
    const { values, completePrefixes } = source.read();
    expect(Object.keys(values).filter((key) => key.startsWith("customTheme."))).toEqual([]);
    expect(completePrefixes).toEqual([]);

    await source.apply({ "customTheme.x": null });
    expect(localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)).toBe("{not json");

    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, library);
    invalidateCustomThemes();
    expect(source.read().values).toHaveProperty("customTheme.x");
  });

  it("maps a default theme to its halves and appearance", () => {
    using _storage = isolateThemeStorage();
    installCustomTheme(darkOnly("night-only"));

    expect(themeProfileValuesForDefault("ocean")).toEqual({
      themeLight: "ocean",
      themeDark: "ocean",
    });
    expect(themeProfileValuesForDefault("night-only")).toEqual({
      themeDark: "night-only",
      themeMode: "dark",
    });
    expect(themeProfileValuesForDefault("no-such-theme")).toBeNull();
  });
});
