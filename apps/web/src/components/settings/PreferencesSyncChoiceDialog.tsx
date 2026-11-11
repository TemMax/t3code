import { useAtomValue } from "@effect/atom-react";

import { preferencesSync } from "../../clientProfile/preferencesSync";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export function PreferencesSyncChoiceDialog() {
  const status = useAtomValue(preferencesSync.statusAtom);
  return (
    <AlertDialog
      open={status.type === "choice"}
      onOpenChange={(open) => {
        if (!open) void preferencesSync.cancelChoice();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Sync preferences</AlertDialogTitle>
          <AlertDialogDescription>
            Other devices already sync preferences through your servers. Choose which settings to
            keep.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 px-6 pb-4 text-muted-foreground text-sm">
          <p>
            Use synced settings: this device switches to the preferences your other devices share.
          </p>
          <p>Use this device's settings: all your devices switch to this device's preferences.</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="outline" onClick={() => void preferencesSync.choose("thisDevice")}>
            Use this device's settings
          </Button>
          <Button onClick={() => void preferencesSync.choose("synced")}>Use synced settings</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
