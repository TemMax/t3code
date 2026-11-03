import type { ModelContextRecord, ProviderOptionSelection } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import type { ReactElement } from "react";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { TraitsMenuContent, useTraitsSelection } from "./chat/TraitsPicker";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type ModelChipRecord = Pick<ModelContextRecord, "label" | "optionsLabel" | "model" | "options">;

export interface ModelContextChipEditor {
  entry: ProviderInstanceEntry;
  onChange: (options: ReadonlyArray<ProviderOptionSelection>) => void;
}

function modelContextChipText(record: Pick<ModelContextRecord, "label" | "optionsLabel">): string {
  return record.optionsLabel ? `${record.label} · ${record.optionsLabel}` : record.label;
}

function ReadOnlyModelContextChip(props: {
  record: ModelChipRecord;
  copyMarkdown?: string | undefined;
}) {
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

function EditableModelContextChip(props: {
  record: ModelChipRecord;
  copyMarkdown?: string | undefined;
  editor: ModelContextChipEditor;
}) {
  const { entry, onChange } = props.editor;
  const traitsInput = {
    provider: entry.driverKind,
    instanceId: entry.instanceId,
    models: entry.models,
    model: props.record.model,
    modelOptions: props.record.options,
    planModeEnabled: false,
    allowPromptInjectedEffort: false,
    onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) =>
      onChange(next ?? []),
  };
  const traits = useTraitsSelection(traitsInput);
  if (!traits.hasAnyControls) {
    return <ReadOnlyModelContextChip record={props.record} copyMarkdown={props.copyMarkdown} />;
  }
  const text = modelContextChipText(props.record);
  return (
    <Menu>
      <MenuTrigger
        render={
          <ContextChip
            kind="model"
            render={<button type="button" />}
            aria-label={`Model, ${text}. Change options`}
            data-markdown-copy={props.copyMarkdown}
          >
            <BotIcon />
            <ContextChipLabel>{text}</ContextChipLabel>
          </ContextChip>
        }
      />
      <MenuPopup align="start">
        <TraitsMenuContent {...traitsInput} />
      </MenuPopup>
    </Menu>
  );
}

/** Chip for a mentioned model. With an `editor` it opens the model's options; without, it is read-only. */
export function ModelContextChip(props: {
  record: ModelChipRecord;
  copyMarkdown?: string | undefined;
  editor?: ModelContextChipEditor | undefined;
}): ReactElement {
  return props.editor ? (
    <EditableModelContextChip
      record={props.record}
      editor={props.editor}
      copyMarkdown={props.copyMarkdown}
    />
  ) : (
    <ReadOnlyModelContextChip record={props.record} copyMarkdown={props.copyMarkdown} />
  );
}
