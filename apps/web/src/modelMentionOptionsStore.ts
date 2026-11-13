import { modelMentionOptionsKey } from "@t3tools/client-runtime/composer-model-mentions";
import { ProviderOptionSelection, type ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const MODEL_MENTION_OPTIONS_STORAGE_KEY = "t3code:model-mention-options:v1";

const PersistedOptionsByModel = Schema.Record(Schema.String, Schema.Array(ProviderOptionSelection));
const isPersistedOptionsByModel = Schema.is(PersistedOptionsByModel);

interface ModelMentionOptionsState {
  optionsByModel: Record<string, ProviderOptionSelection[]>;
}

export const useModelMentionOptionsStore = create<ModelMentionOptionsState>()(
  persist<ModelMentionOptionsState>(() => ({ optionsByModel: {} }), {
    name: MODEL_MENTION_OPTIONS_STORAGE_KEY,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    version: 1,
    merge: (persisted, current) => {
      const optionsByModel = (persisted as { optionsByModel?: unknown } | null)?.optionsByModel;
      if (!isPersistedOptionsByModel(optionsByModel)) return current;
      return {
        ...current,
        optionsByModel: Object.fromEntries(
          Object.entries(optionsByModel).map(([key, options]) => [key, [...options]]),
        ),
      };
    },
  }),
);

export function readModelMentionOptions(
  providerInstanceId: ProviderInstanceId,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return useModelMentionOptionsStore.getState().optionsByModel[
    modelMentionOptionsKey(providerInstanceId, model)
  ];
}

export function rememberModelMentionOptions(
  providerInstanceId: ProviderInstanceId,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): void {
  useModelMentionOptionsStore.setState((state) => ({
    optionsByModel: {
      ...state.optionsByModel,
      [modelMentionOptionsKey(providerInstanceId, model)]: [...options],
    },
  }));
}
