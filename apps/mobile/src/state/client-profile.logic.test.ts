import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import { mobileProfilePatch, readMobileProfileValues } from "./client-profile.logic";

describe("client profile mapping", () => {
  it("maps theme halves and never publishes material-you", () => {
    const values = readMobileProfileValues({ lightThemeId: "grove", darkThemeId: "material-you" });
    expect(values.themeLight).toBe("grove");
    expect(values).not.toHaveProperty("themeDark");
  });

  it("skips custom and environment theme ids and keeps legacy themeId on the active appearance", () => {
    expect(mobileProfilePatch({}, { themeDark: "custom-x" }, "light")).toEqual({});
    expect(mobileProfilePatch({}, { themeDark: "material-you" }, "light")).toEqual({});
    expect(
      mobileProfilePatch({ themeMode: "dark" }, { themeDark: "ocean" }, "light"),
    ).toMatchObject({ darkThemeId: "ocean", themeId: "ocean" });
    expect(
      mobileProfilePatch(
        { themeMode: "system" },
        { themeLight: "grove", themeDark: "ocean" },
        "light",
      ),
    ).toMatchObject({ lightThemeId: "grove", darkThemeId: "ocean", themeId: "grove" });
  });

  it("dual-writes the legacy grouping flag", () => {
    expect(mobileProfilePatch({}, { sidebarProjectGroupingMode: "separate" }, "light")).toEqual({
      projectGroupingMode: "separate",
      projectGroupingEnabled: false,
    });
  });

  it("reads effective defaults for unset preferences", () => {
    expect(readMobileProfileValues({})).toEqual({
      themeMode: "system",
      themeLight: "t3-code",
      themeDark: "t3-code",
      toolCallVisibility: "showAll",
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
      mathRenderingEnabled: false,
      sidebarProjectGroupingMode: "repository",
      sidebarWorkingShelfEnabled: true,
    });
  });

  it("skips invalid values", () => {
    expect(
      mobileProfilePatch(
        {},
        { toolCallVisibility: "loud", followUpBehavior: 3, mathRenderingEnabled: "yes" },
        "dark",
      ),
    ).toEqual({});
  });
});
