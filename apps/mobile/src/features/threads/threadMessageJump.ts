import type { MessageId } from "@t3tools/contracts";

// A palette message result opens its thread at that message. The thread
// screen reads the request while it shows that thread, and finishes it once
// the feed is there or the message cannot be found. A request whose thread
// never showed lapses, so a later plain open does not jump, as on web.
const PENDING_JUMP_MS = 30_000;
let pending: {
  readonly threadKey: string;
  readonly messageId: MessageId;
  /** A citation's source flashes when it lands, and says so when it cannot be found. */
  readonly citation: boolean;
  readonly at: number;
} | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestThreadMessageJump(
  threadKey: string,
  messageId: MessageId,
  options?: { readonly citation?: boolean },
): void {
  pending = { threadKey, messageId, citation: options?.citation ?? false, at: Date.now() };
  notify();
}

/** The message this thread should open at, if a palette pick asked for one. */
export function pendingThreadMessageJump(threadKey: string): MessageId | null {
  return pending?.threadKey === threadKey && Date.now() - pending.at < PENDING_JUMP_MS
    ? pending.messageId
    : null;
}

export function pendingThreadMessageJumpIsCitation(threadKey: string): boolean {
  return pendingThreadMessageJump(threadKey) !== null && pending?.citation === true;
}

export function finishThreadMessageJump(threadKey: string): void {
  if (pending?.threadKey !== threadKey) return;
  pending = null;
  notify();
}

export function subscribeThreadMessageJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
