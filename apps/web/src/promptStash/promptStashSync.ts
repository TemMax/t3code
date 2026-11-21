import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PromptStashPutInput } from "@t3tools/contracts";
import { PROMPT_STASH_MAX_ENTRIES } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { uploadDetachedAttachment } from "../lib/attachmentUploadQueue";
import { usePromptStashStore, type PromptStashEntry } from "../promptStashStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { promptStashCommands } from "../state/promptStash";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentPresentations } from "../state/presentation";
import {
  applyPutOutcome,
  planLocalStashUploads,
  targetEnvironmentForLocalEntry,
} from "./promptStashSync.logic";
import { serverStashSummariesAtom } from "./serverStashSummaries";

type Get = <A>(atom: Atom.Atom<A>) => A;

function connectedStashEnvironmentIds(get: Get): EnvironmentId[] {
  const ids: EnvironmentId[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (
      presentation.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.promptStash === true
    ) {
      ids.push(environmentId);
    }
  }
  return ids;
}

function writableEnvironmentIds(get: Get): EnvironmentId[] {
  return connectedStashEnvironmentIds(get).filter((environmentId) =>
    get(promptStashCommands.put.permissionAtom(environmentId)),
  );
}

/** Whether the composer can put to this environment's stash now, or at least take from it. */
export function serverStashAccess(
  environmentId: EnvironmentId,
): "writable" | "connected" | "unavailable" {
  const get: Get = (atom) => appAtomRegistry.get(atom);
  if (!connectedStashEnvironmentIds(get).includes(environmentId)) return "unavailable";
  return get(promptStashCommands.put.permissionAtom(environmentId)) ? "writable" : "connected";
}

// A string, so an unrelated presentation change leaves the subscription quiet.
const writableEnvironmentsKeyAtom = Atom.make((get) =>
  writableEnvironmentIds(get).toSorted().join("\n"),
).pipe(Atom.withLabel("web-prompt-stash-writable-environments"));

function dataUrlToFile(image: PromptStashEntry["attachments"][number]): File {
  const comma = image.dataUrl.indexOf(",");
  const header = image.dataUrl.slice(0, comma);
  const payload = image.dataUrl.slice(comma + 1);
  const bytes = header.endsWith(";base64")
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new File([bytes], image.name, { type: image.mimeType });
}

async function buildPutInput(
  entry: PromptStashEntry,
  environmentId: EnvironmentId,
): Promise<PromptStashPutInput> {
  const attachments: PromptStashPutInput["attachments"][number][] = [];
  for (const image of entry.attachments) {
    const attachmentId = await uploadDetachedAttachment({
      environmentId,
      file: dataUrlToFile(image),
      type: "image",
    });
    attachments.push({
      type: "image",
      id: image.id,
      attachmentId,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      ...(image.source ? { source: image.source } : {}),
    });
  }
  for (const file of entry.files ?? []) {
    attachments.push({
      type: "file",
      id: file.id,
      attachmentId: file.attachmentId,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      ...(file.source ? { source: file.source } : {}),
    });
  }
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    prompt: entry.prompt,
    attachments,
    droppedImageNames: [...entry.droppedImageNames],
    unreadableImageNames: [...(entry.unreadableImageNames ?? [])],
    droppedFileNames: [],
    records: entry.records ?? [],
  };
}

function isAlreadyTaken(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "PromptStashError" &&
    "reason" in error &&
    error.reason === "already-taken"
  );
}

function announceEvicted(): void {
  toastManager.add({
    type: "warning",
    title: m(msg("Oldest stashed prompt discarded")),
    description: m(
      msg("The stash holds {max} prompts; the oldest was removed to make room.", {
        max: PROMPT_STASH_MAX_ENTRIES,
      }),
    ),
    data: { hideCopyButton: true },
  });
}

async function putEntry(
  entry: PromptStashEntry,
  environmentId: EnvironmentId,
): Promise<"stored" | "already-taken" | "failed"> {
  try {
    const input = await buildPutInput(entry, environmentId);
    const result = await runAtomCommand(
      appAtomRegistry,
      promptStashCommands.put,
      { environmentId, input },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      if (result.value.evictedIds.length > 0) announceEvicted();
      return "stored";
    }
    const error = squashAtomCommandFailure(result);
    if (isAlreadyTaken(error)) return "already-taken";
    console.warn("Prompt stash upload failed", error);
    return "failed";
  } catch (error) {
    console.warn("Prompt stash upload failed", error);
    return "failed";
  }
}

async function runPass(): Promise<void> {
  const get: Get = (atom) => appAtomRegistry.get(atom);
  const connected = new Set<string>(connectedStashEnvironmentIds(get));
  const serverIds = new Set(
    get(serverStashSummariesAtom)
      .filter(({ environmentId }) => connected.has(environmentId))
      .flatMap(({ summaries }) => summaries.map((summary) => summary.id)),
  );
  const store = usePromptStashStore.getState();
  const { drop, upload } = planLocalStashUploads(store.entries, serverIds);
  if (drop.length > 0) store.dropEntries(drop);

  for (const entry of upload) {
    const environmentId = targetEnvironmentForLocalEntry(entry, get(primaryEnvironmentIdAtom));
    if (environmentId === null || !writableEnvironmentIds(get).includes(environmentId)) continue;
    const outcome = await putEntry(entry, environmentId);
    const localStore = usePromptStashStore.getState();
    const done = applyPutOutcome(
      localStore.entries.map((local) => local.id),
      entry.id,
      outcome,
    );
    if (done.length > 0) localStore.dropEntries(done);
  }
}

export const promptStashSync = {
  start: () => {
    let stopped = false;
    let tail: Promise<unknown> = Promise.resolve();
    let passQueued = false;
    // One chain, so two passes never upload the same entry at once.
    const requestPass = () => {
      if (passQueued) return;
      passQueued = true;
      tail = tail.then(async () => {
        passQueued = false;
        if (stopped) return;
        try {
          await runPass();
        } catch (error) {
          console.warn("Prompt stash sync failed", error);
        }
      });
    };
    const stopStore = usePromptStashStore.subscribe(requestPass);
    const stopEnvironments = appAtomRegistry.subscribe(writableEnvironmentsKeyAtom, requestPass, {
      immediate: true,
    });
    return () => {
      stopped = true;
      stopStore();
      stopEnvironments();
    };
  },
};
