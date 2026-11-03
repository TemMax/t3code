import type { ModelContextRecord } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import type { ReactElement } from "react";

import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function modelContextChipText(record: Pick<ModelContextRecord, "label" | "optionsLabel">): string {
  return record.optionsLabel ? `${record.label} · ${record.optionsLabel}` : record.label;
}

/** Read-only chip for a mentioned model, in sent messages. */
export function ModelContextChip(props: {
  record: Pick<ModelContextRecord, "label" | "optionsLabel">;
  copyMarkdown?: string;
}): ReactElement {
  const text = modelContextChipText(props.record);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="model"
            tabIndex={0}
            aria-label={`Model, ${text}`}
            data-markdown-copy={props.copyMarkdown}
          >
            <BotIcon />
            <ContextChipLabel>{text}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">Model for delegated work</TooltipPopup>
    </Tooltip>
  );
}
