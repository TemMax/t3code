import { PromptStashSummary, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "../state/presentation";

const SERVER_STASH_CACHE_KEY = "t3code:prompt-stash:server:v1";

const decodeCache = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Array(PromptStashSummary)),
);

type SummaryCache = Record<string, ReadonlyArray<PromptStashSummary>>;

let cache: SummaryCache | null = null;
// Presentations recompute often; an unchanged array skips the storage round trip.
const remembered = new Map<string, ReadonlyArray<PromptStashSummary>>();

function readStoredCache(): { raw: string | null; value: SummaryCache } {
  try {
    const raw = localStorage.getItem(SERVER_STASH_CACHE_KEY);
    return { raw, value: raw ? { ...decodeCache(JSON.parse(raw)) } : {} };
  } catch {
    return { raw: null, value: {} };
  }
}

function loadCache(): SummaryCache {
  cache ??= readStoredCache().value;
  return cache;
}

/** Starts from storage, so another tab's environments survive this write. */
function rememberSummaries(
  environmentId: EnvironmentId,
  summaries: ReadonlyArray<PromptStashSummary>,
  knownEnvironmentIds: ReadonlySet<string>,
): void {
  if (remembered.get(environmentId) === summaries) return;
  remembered.set(environmentId, summaries);
  const { raw, value: stored } = readStoredCache();
  stored[environmentId] = summaries;
  for (const id of Object.keys(stored)) {
    if (!knownEnvironmentIds.has(id)) delete stored[id];
  }
  cache = stored;
  const next = JSON.stringify(stored);
  if (next === raw) return;
  try {
    localStorage.setItem(SERVER_STASH_CACHE_KEY, next);
  } catch {}
}

/**
 * Server stashes per environment. A disconnected environment shows what it held when last
 * connected; the cache is written here, where the live summaries are read.
 */
export const serverStashSummariesAtom = Atom.make(
  (
    get,
  ): ReadonlyArray<{
    environmentId: EnvironmentId;
    summaries: ReadonlyArray<PromptStashSummary>;
  }> => {
    const presentations = get(environmentPresentations.presentationsAtom);
    const knownEnvironmentIds = new Set<string>(presentations.keys());
    const result: Array<{
      environmentId: EnvironmentId;
      summaries: ReadonlyArray<PromptStashSummary>;
    }> = [];
    for (const [environmentId, presentation] of presentations) {
      if (presentation.connection.phase === "connected") {
        if (presentation.serverConfig?.environment.capabilities.promptStash !== true) continue;
        // Undefined until the stash snapshot arrives, and for a client without the scope.
        const summaries = presentation.serverConfig.promptStash;
        if (summaries === undefined) continue;
        rememberSummaries(environmentId, summaries, knownEnvironmentIds);
        result.push({ environmentId, summaries });
        continue;
      }
      remembered.delete(environmentId);
      const cached = loadCache()[environmentId];
      if (cached) result.push({ environmentId, summaries: cached });
    }
    return result;
  },
).pipe(Atom.withLabel("web-prompt-stash-server-summaries"));
