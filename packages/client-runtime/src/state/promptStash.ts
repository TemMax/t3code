import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createPromptStashEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    put: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:prompt-stash:put",
      tag: WS_METHODS.promptStashPut,
    }),
    take: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:prompt-stash:take",
      tag: WS_METHODS.promptStashTake,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:prompt-stash:remove",
      tag: WS_METHODS.promptStashRemove,
    }),
  };
}
