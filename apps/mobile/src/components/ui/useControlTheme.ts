import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { drawnMobileThemeId } from "../../lib/mobileTheme";

export function useControlTheme() {
  const {
    themeId,
    themeAppearance,
    themeVariables,
    registeredThemes,
    systemColorsActive,
    appearance,
  } = useAppearancePreferences();
  return {
    themeId: drawnMobileThemeId(themeId, themeAppearance, registeredThemes),
    colorScheme: themeAppearance,
    colors: themeVariables,
    systemColorsActive,
    fontSize: appearance.baseFontSize,
  };
}
