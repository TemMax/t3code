import { createPromptStashEnvironmentAtoms } from "@t3tools/client-runtime/state/prompt-stash";

import { connectionAtomRuntime } from "../connection/runtime";

export const promptStashCommands = createPromptStashEnvironmentAtoms(connectionAtomRuntime);
