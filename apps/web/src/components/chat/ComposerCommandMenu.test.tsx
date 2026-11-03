import { ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu, composerSuggestionOptionId } from "./ComposerCommandMenu";

describe("composerSuggestionOptionId", () => {
  it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
    const paths = [
      "docs/my file.md",
      "docs/my_file.md",
      "docs/my%20file.md",
      "docs/my\tfile.md",
      "docs/\ud800.md",
      "docs/\ud801.md",
      "docs/\udc00.md",
      "docs/\ufffd.md",
      "docs/\\ud800.md",
      "docs/\ud83d\ude80.md",
    ];
    const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:file:${path}`));

    expect(new Set(ids).size).toBe(paths.length);
    for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
    expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
      composerSuggestionOptionId("suggestions", paths[0]!),
    );
  });
});

describe("ComposerCommandMenu", () => {
  it("renders a model item with its label and description", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="suggestions"
        items={[
          {
            id: "model:codex:gpt-5",
            type: "model",
            providerInstanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
            driverKind: "codex",
            label: "GPT-5",
            description: "Codex",
          },
        ]}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="path"
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(markup).toContain("GPT-5");
    expect(markup).toContain("Codex");
  });
});
