import { ProviderInstanceId } from "@t3tools/contracts";
import { createJSONStorage } from "zustand/middleware";
import { describe, expect, it } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";
import {
  MODEL_MENTION_OPTIONS_STORAGE_KEY,
  readModelMentionOptions,
  rememberModelMentionOptions,
  useModelMentionOptionsStore,
} from "./modelMentionOptionsStore";

const CODEX = ProviderInstanceId.make("codex");
const CODEX_SECONDARY = ProviderInstanceId.make("codex_secondary");

describe("modelMentionOptionsStore", () => {
  it("remembers options per provider instance and model", () => {
    rememberModelMentionOptions(CODEX, "gpt-5", [{ id: "fastMode", value: true }]);
    rememberModelMentionOptions(CODEX_SECONDARY, "gpt-5", []);

    expect(readModelMentionOptions(CODEX, "gpt-5")).toEqual([{ id: "fastMode", value: true }]);
    expect(readModelMentionOptions(CODEX_SECONDARY, "gpt-5")).toEqual([]);
    expect(readModelMentionOptions(CODEX, "gpt-5-mini")).toBeUndefined();
  });

  it("drops an undecodable persisted state", async () => {
    useModelMentionOptionsStore.setState({ optionsByModel: {} });
    const storage = createMemoryStorage();
    const seed = (optionsByModel: unknown) =>
      storage.setItem(
        MODEL_MENTION_OPTIONS_STORAGE_KEY,
        JSON.stringify({ state: { optionsByModel }, version: 1 }),
      );
    useModelMentionOptionsStore.persist.setOptions({ storage: createJSONStorage(() => storage) });

    seed({ "codex:gpt-5": [{ id: "fastMode", value: { nested: true } }] });
    await useModelMentionOptionsStore.persist.rehydrate();
    expect(useModelMentionOptionsStore.getState().optionsByModel).toEqual({});

    seed({ "codex:gpt-5": [{ id: "fastMode", value: true }] });
    await useModelMentionOptionsStore.persist.rehydrate();
    expect(readModelMentionOptions(CODEX, "gpt-5")).toEqual([{ id: "fastMode", value: true }]);
  });
});
