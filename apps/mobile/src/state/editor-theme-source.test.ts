import { describe, expect, it } from "@effect/vitest";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { vi } from "vite-plus/test";

import { createMobileEditorThemeSource } from "./editor-theme-source";

const myNord = {
  id: "my-nord",
  label: "My Nord",
  appearance: "dark",
  colors: T3_CODE_DARK_THEME_COLORS,
};

function setup(editorThemes: Readonly<Record<string, unknown>> = {}) {
  let current = editorThemes;
  const write = vi.fn((next: Readonly<Record<string, unknown>>) => {
    current = next;
  });
  const source = createMobileEditorThemeSource({
    load: () => ({ editorThemes: current }),
    write,
    subscribe: () => () => {},
  });
  return { source, write };
}

describe("createMobileEditorThemeSource", () => {
  it("stores a synced editor theme verbatim and reads it back unchanged", async () => {
    const { source, write } = setup();
    await expect(source.apply({ "customTheme.my-nord": myNord })).resolves.toEqual({
      "customTheme.my-nord": myNord,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]["my-nord"]).toBe(myNord);
    expect(write).toHaveBeenCalledWith({ "my-nord": myNord });
    const read = source.read();
    expect(read.values["customTheme.my-nord"]).toBe(myNord);
    expect(read).toEqual({ values: { "customTheme.my-nord": myNord }, completePrefixes: [] });
  });

  it("removes an editor theme a computer deleted", async () => {
    const { source, write } = setup({ "my-nord": myNord, other: { id: "other" } });
    await expect(source.apply({ "customTheme.my-nord": null })).resolves.toEqual({});
    expect(write).toHaveBeenCalledWith({ other: { id: "other" } });
  });

  it("stores nothing and does not write for an invalid theme", async () => {
    const { source, write } = setup();
    await expect(source.apply({ "customTheme.bad": { id: "bad" } })).resolves.toEqual({});
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write when the same theme is applied again", async () => {
    const { source, write } = setup({ "my-nord": myNord });
    const result = await source.apply({
      "customTheme.my-nord": { ...myNord, colors: { ...myNord.colors } },
    });
    expect(write).not.toHaveBeenCalled();
    expect(result).toEqual({ "customTheme.my-nord": myNord });
    expect(result["customTheme.my-nord"]).toBe(myNord);
  });

  it("owns only editor theme keys", () => {
    const { source } = setup();
    expect(source.owns("customTheme.x")).toBe(true);
    expect(source.owns("themeDark")).toBe(false);
    expect(source.owns("customTheme.")).toBe(false);
  });
});
