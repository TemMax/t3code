import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../../state/threads";
import { workingSubagentCountsByThread } from "./subagentActivity.logic";

const workingSubagentCountsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    workingSubagentCountsByThread(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)),
    ),
  ).pipe(Atom.withLabel(`sidebar-working-subagent-counts:${environmentId}`)),
);

// A number per thread, so a row rerenders only when its own count changes.
const workingSubagentCountAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make(
    (get) => get(workingSubagentCountsAtom(ref.environmentId)).get(ref.threadId) ?? 0,
  ).pipe(Atom.withLabel(`sidebar-working-subagent-count:${key}`));
});

export function useWorkingSubagentCount(ref: ScopedThreadRef): number {
  return useAtomValue(workingSubagentCountAtom(threadKey(ref)));
}
