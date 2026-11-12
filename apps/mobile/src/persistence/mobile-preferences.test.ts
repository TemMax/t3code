import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { sanitizePreferences } from "./mobile-preferences";

describe("sanitizePreferences", () => {
  it("keeps a valid sync sidecar and drops a malformed one", () => {
    const clientProfileSync = {
      deviceId: "phone",
      enabled: true,
      choicePending: false,
      highestSeen: 4,
      entries: { themeMode: { changedAt: 1, by: "phone", hash: "abc" } },
    };
    expect(sanitizePreferences({ clientProfileSync }).clientProfileSync).toEqual(clientProfileSync);
    expect(sanitizePreferences({ clientProfileSync: { deviceId: 5 } as never })).not.toHaveProperty(
      "clientProfileSync",
    );
  });

  it("keeps a stored theme id that is not built in", () => {
    expect(sanitizePreferences({ darkThemeId: "islands-dark" as never }).darkThemeId).toBe(
      "islands-dark",
    );
    expect(sanitizePreferences({ darkThemeId: "" as never })).not.toHaveProperty("darkThemeId");
    expect(sanitizePreferences({ darkThemeId: 5 as never })).not.toHaveProperty("darkThemeId");
  });

  it("keeps valid editor themes verbatim and drops invalid ones", () => {
    const valid = { id: "my-nord", label: "My Nord", appearance: "dark", colors: {} };
    const editorThemes = {
      "my-nord": valid,
      bad: { id: "bad" },
      other: { ...valid, id: "other-id" },
    };
    const result = sanitizePreferences({ editorThemes });
    expect(result.editorThemes).toEqual({ "my-nord": valid });
    expect(result.editorThemes?.["my-nord"]).toBe(valid);
    expect(sanitizePreferences({ editorThemes: { bad: { id: "bad" } } })).not.toHaveProperty(
      "editorThemes",
    );
  });
});
