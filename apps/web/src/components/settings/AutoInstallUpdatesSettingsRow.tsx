import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AutoInstallUpdatesSettingsRow() {
  const enabled = useClientSettings((settings) => settings.autoInstallDesktopUpdates);
  return (
    <SettingsRow
      {...searchableSetting("auto-install-updates")}
      description="Downloads updates in the background and installs them once no agent is working and this computer has been idle for 5 minutes."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ autoInstallDesktopUpdates: Boolean(checked) })
          }
          aria-label="Automatically install updates"
        />
      }
    />
  );
}
