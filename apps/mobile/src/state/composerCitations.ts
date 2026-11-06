import type { AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import { captureComposerDraftInsertion, insertComposerDraftText } from "./use-composer-drafts";

/** A citation chip whose comment editor is open, by its place in the draft text. */
export interface ComposerCitationTarget {
  readonly draftKey: string;
  readonly source: string;
  readonly start: number;
  /** Spaces the cite added around a new chip; cancelling its first edit removes them with it. */
  readonly insertedSpaces: { readonly before: boolean; readonly after: boolean } | null;
}

let pending: ComposerCitationTarget | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function pendingComposerCitation(draftKey: string | null): ComposerCitationTarget | null {
  return draftKey !== null && pending?.draftKey === draftKey ? pending : null;
}

export function finishComposerCitation(draftKey: string): void {
  if (pending?.draftKey !== draftKey) return;
  pending = null;
  notify();
}

export function subscribeComposerCitation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Inserts the citation at the draft's caret and opens its comment editor, as web does. */
export function citeInComposerDraft(draftKey: string, citation: AssistantCitation): void {
  const insertion = captureComposerDraftInsertion(draftKey);
  const before = insertion.start > 0 && !/\s/.test(insertion.text[insertion.start - 1]!);
  const after = !/^\s/.test(insertion.text.slice(insertion.end));
  const source = serializeAssistantCitation(citation);
  insertComposerDraftText(draftKey, `${before ? " " : ""}${source}${after ? " " : ""}`, insertion);
  pending = {
    draftKey,
    source,
    start: insertion.start + (before ? 1 : 0),
    insertedSpaces: { before, after },
  };
  notify();
}
