import { msg } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";

export function announceEvicted(max: number): void {
  toastManager.add({
    type: "warning",
    title: m(msg("Oldest stashed prompt discarded")),
    description: m(
      msg("The stash holds {max} prompts; the oldest was removed to make room.", { max }),
    ),
    data: { hideCopyButton: true },
  });
}
