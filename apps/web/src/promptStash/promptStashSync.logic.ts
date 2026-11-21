import type { EnvironmentId, PromptStashSummary } from "@t3tools/contracts";

import type { PromptStashEntry } from "../promptStashStore";

/** Local entries already on a server go; the rest upload oldest first, once their images are encoded. */
export function planLocalStashUploads(
  local: ReadonlyArray<PromptStashEntry>,
  serverIds: ReadonlySet<string>,
): { readonly drop: string[]; readonly upload: PromptStashEntry[] } {
  const drop: string[] = [];
  const pending: Array<{ readonly entry: PromptStashEntry; readonly index: number }> = [];
  local.forEach((entry, index) => {
    if (serverIds.has(entry.id)) drop.push(entry.id);
    else if (!entry.pendingImageCount) pending.push({ entry, index });
  });
  // The store lists newest first, so equal timestamps order by position from the end.
  pending.sort((a, b) =>
    a.entry.createdAt === b.entry.createdAt
      ? b.index - a.index
      : a.entry.createdAt < b.entry.createdAt
        ? -1
        : 1,
  );
  return { drop, upload: pending.map(({ entry }) => entry) };
}

export function targetEnvironmentForLocalEntry(
  entry: PromptStashEntry,
  primary: EnvironmentId | null,
): EnvironmentId | null {
  return entry.files?.[0]?.environmentId ?? primary;
}

/** A taken entry lives on a server already, so it leaves the local queue like a stored one. */
export function applyPutOutcome(
  _localIds: ReadonlyArray<string>,
  id: string,
  outcome: "stored" | "already-taken" | "failed",
): string[] {
  return outcome === "failed" ? [] : [id];
}

export type StashMenuItem =
  | { readonly kind: "local"; readonly entry: PromptStashEntry }
  | {
      readonly kind: "server";
      readonly environmentId: EnvironmentId;
      readonly summary: PromptStashSummary;
    };

export function stashMenuItemId(item: StashMenuItem): string {
  return item.kind === "local" ? item.entry.id : item.summary.id;
}

function stashMenuItemCreatedAt(item: StashMenuItem): string {
  return item.kind === "local" ? item.entry.createdAt : item.summary.createdAt;
}

/** Newest first; a local entry already on a server shows once, as the server's. */
export function mergeStashMenuItems(
  local: ReadonlyArray<PromptStashEntry>,
  server: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly summaries: ReadonlyArray<PromptStashSummary>;
  }>,
): StashMenuItem[] {
  const items: StashMenuItem[] = server.flatMap(({ environmentId, summaries }) =>
    summaries.map((summary) => ({ kind: "server" as const, environmentId, summary })),
  );
  const serverIds = new Set(
    server.flatMap(({ summaries }) => summaries.map((summary) => summary.id)),
  );
  for (const entry of local) {
    if (!serverIds.has(entry.id)) items.push({ kind: "local", entry });
  }
  return items.toSorted((a, b) => {
    const aAt = stashMenuItemCreatedAt(a);
    const bAt = stashMenuItemCreatedAt(b);
    return aAt === bAt ? 0 : aAt < bAt ? 1 : -1;
  });
}
