import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assistantCitationFromSelection } from "./assistantCitationSelection";

const ids = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
};
const source = { ...ids, messageText: "First, **run it**.\n\nSecond, run `it`." };

describe("assistantCitationFromSelection", () => {
  it("anchors a block-relative selection to the rendered reply web cites", () => {
    expect(
      assistantCitationFromSelection({
        ...source,
        blockMarkdown: "Second, run `it`.",
        selection: { text: "run it", start: 8 },
      }),
    ).toEqual({
      _tag: "citation",
      citation: {
        version: 1,
        ...ids,
        text: "run it",
        start: 23,
        end: 29,
        prefix: "First, run it. Second, ",
        suffix: ".",
      },
    });
    expect(
      assistantCitationFromSelection({
        ...source,
        blockMarkdown: source.messageText,
        selection: { text: "x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1), start: 0 },
      }),
    ).toEqual({ _tag: "too-long" });
  });
});
