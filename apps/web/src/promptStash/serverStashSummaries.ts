import { PromptStashSummary, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "../state/presentation";

const SERVER_STASH_CACHE_KEY = "t3code:prompt-stash:server:v1";

const decodeCache = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Array(PromptStashSummary)),
);

let cache: Record<string, ReadonlyArray<PromptStashSummary>> | null = null;

function loadCache(): Record<string, ReadonlyArray<PromptStashSummary>> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(SERVER_STASH_CACHE_KEY);
    cache = raw ? { ...decodeCache(JSON.parse(raw)) } : {};
  } catch {
    cache = {};
  }
  return cache;
}

function rememberSummaries(
  environmentId: EnvironmentId,
  summaries: ReadonlyArray<PromptStashSummary>,
  knownEnvironmentIds: ReadonlySet<string>,
): void {
  const stored = loadCache();
  if (stored[environmentId] === summaries) return;
  stored[environmentId] = summaries;
  for (const id of Object.keys(stored)) {
    if (!knownEnvironmentIds.has(id)) delete stored[id];
  }
  try {
    localStorage.setItem(SERVER_STASH_CACHE_KEY, JSON.stringify(stored));
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
        const summaries = presentation.serverConfig.promptStash ?? [];
        rememberSummaries(environmentId, summaries, knownEnvironmentIds);
        result.push({ environmentId, summaries });
        continue;
      }
      const remembered = loadCache()[environmentId];
      if (remembered) result.push({ environmentId, summaries: remembered });
    }
    return result;
  },
).pipe(Atom.withLabel("web-prompt-stash-server-summaries"));
