import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import { assistantTextSelectorNear } from "@t3tools/shared/assistantCitations";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";

/** The text web reads from a rendered assistant reply, which citation selectors index. */
function renderedAssistantText(markdown: string): string {
  return (
    searchableMessageSegments({ role: "assistant", text: markdown, streaming: false }) ?? []
  ).join("\n");
}

export type AssistantCitationSelection =
  | { readonly _tag: "citation"; readonly citation: AssistantCitation }
  | { readonly _tag: "too-long" }
  | { readonly _tag: "empty" };

/**
 * A reply renders as several native text views (folds and artifact cards split it), and each
 * reports its selection relative to itself, so the block's place in the reply anchors the offset.
 */
export function assistantCitationFromSelection(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly messageText: string;
  readonly blockMarkdown: string;
  readonly selection: { readonly text: string; readonly start: number };
}): AssistantCitationSelection {
  if (input.selection.text.trim().length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) {
    return { _tag: "too-long" };
  }
  const messageText = renderedAssistantText(input.messageText);
  const blockText = renderedAssistantText(input.blockMarkdown);
  const blockStart = blockText ? Math.max(0, messageText.indexOf(blockText)) : 0;
  const selector = assistantTextSelectorNear(
    messageText,
    input.selection.text,
    blockStart + input.selection.start,
  );
  if (!selector) return { _tag: "empty" };
  return {
    _tag: "citation",
    citation: {
      version: 1,
      environmentId: input.environmentId,
      threadId: input.threadId,
      messageId: input.messageId,
      ...selector,
    },
  };
}
