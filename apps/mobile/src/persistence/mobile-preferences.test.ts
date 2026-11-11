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
});
