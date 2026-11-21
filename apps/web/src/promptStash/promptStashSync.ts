import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PromptStashPutInput } from "@t3tools/contracts";
import { PROMPT_STASH_MAX_ENTRIES } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { deletePendingUpload, uploadDetachedAttachment } from "../lib/attachmentUploadQueue";
import { dataUrlToFile } from "../lib/imageCompression";
import {
  readLatestEntries,
  usePromptStashStore,
  type PendingStashTake,
  type PromptStashEntry,
} from "../promptStashStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { promptStashCommands } from "../state/promptStash";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentPresentations } from "../state/presentation";
import { announceEvicted } from "./announceEvicted";
import {
  retryablePendingTakes,
  runStashSyncPass,
  targetEnvironmentForLocalEntry,
  type StashPutOutcome,
} from "./promptStashSync.logic";
import { serverStashSummariesAtom } from "./serverStashSummaries";

type Get = <A>(atom: Atom.Atom<A>) => A;
const get: Get = (atom) => appAtomRegistry.get(atom);

/** Entries a restore or a lost-take retry in this tab is taking; nothing else touches them. */
export const takingEntryIds = new Set<string>();
/** Take request ids this tab started, so its own abandoned takes retry without a grace period. */
export const ownTakeRequestIds = new Set<string>();

function connectedStashEnvironmentIds(read: Get = get): EnvironmentId[] {
  const ids: EnvironmentId[] = [];
  for (const [environmentId, presentation] of read(environmentPresentations.presentationsAtom)) {
    if (
      presentation.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.promptStash === true
    ) {
      ids.push(environmentId);
    }
  }
  return ids;
}

function writableEnvironmentIds(read: Get = get): EnvironmentId[] {
  return connectedStashEnvironmentIds(read).filter((environmentId) =>
    read(promptStashCommands.put.permissionAtom(environmentId)),
  );
}

/** Whether the composer can put to this environment's stash now, or at least take from it. */
export function serverStashAccess(
  environmentId: EnvironmentId,
): "writable" | "connected" | "unavailable" {
  if (!connectedStashEnvironmentIds().includes(environmentId)) return "unavailable";
  return get(promptStashCommands.put.permissionAtom(environmentId)) ? "writable" : "connected";
}

/** The environment the sync uploads a local entry to, or null while none fits. */
export function localEntryTarget(entry: PromptStashEntry): EnvironmentId | null {
  return targetEnvironmentForLocalEntry(
    entry,
    get(primaryEnvironmentIdAtom),
    writableEnvironmentIds(),
  );
}

// A string, so an unrelated presentation change leaves the subscription quiet.
const writableEnvironmentsKeyAtom = Atom.make((read) =>
  writableEnvironmentIds(read).toSorted().join("\n"),
).pipe(Atom.withLabel("web-prompt-stash-writable-environments"));

function errorTag(error: unknown): unknown {
  return typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
}

export function promptStashErrorReason(error: unknown): unknown {
  return errorTag(error) === "PromptStashError" &&
    typeof error === "object" &&
    error !== null &&
    "reason" in error
    ? error.reason
    : undefined;
}

/** A typed reply from the server; anything else may not have reached it. */
export function isServerReply(error: unknown): boolean {
  const tag = errorTag(error);
  return tag === "PromptStashError" || tag === "EnvironmentAuthorizationError";
}

/** Runs a stash command and repeats it once when its reply was lost. */
export async function retryLostReply<A, E>(
  run: () => Promise<AtomCommandResult<A, E>>,
): Promise<AtomCommandResult<A, E>> {
  const result = await run();
  if (result._tag === "Success" || isServerReply(squashAtomCommandFailure(result))) return result;
  return run();
}

async function uploadEntryImages(entry: PromptStashEntry, environmentId: EnvironmentId) {
  const attachmentIds: string[] = [];
  try {
    for (const image of entry.attachments) {
      attachmentIds.push(
        await uploadDetachedAttachment({
          environmentId,
          file: dataUrlToFile(image.dataUrl, image.name, image.mimeType),
          type: "image",
        }),
      );
    }
    return { attachmentIds, complete: true };
  } catch (error) {
    console.warn("Prompt stash upload failed", error);
    return { attachmentIds, complete: false };
  }
}

async function putEntry(
  input: PromptStashPutInput,
  environmentId: EnvironmentId,
): Promise<StashPutOutcome> {
  const result = await runAtomCommand(
    appAtomRegistry,
    promptStashCommands.put,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return { _tag: "stored", ...result.value };
  const error = squashAtomCommandFailure(result);
  const reason = promptStashErrorReason(error);
  if (reason === "already-taken") return { _tag: "already-taken" };
  if (reason === "entry-too-large") return { _tag: "too-large" };
  console.warn("Prompt stash upload failed", error);
  return { _tag: "failed" };
}

const uploadsInFlight = new Map<string, Promise<"local" | "stored">>();
const tooLargeEntryIds = new Set<string>();

/** Waits out a background upload of this entry; "stored" means it now lives on a server. */
export function settleLocalEntry(id: string): Promise<"local" | "stored"> {
  return uploadsInFlight.get(id) ?? Promise.resolve("local");
}

/** A take whose reply was lost may have succeeded; ask again and put what comes back. */
async function retryPendingTake(take: PendingStashTake): Promise<boolean> {
  const environmentId = take.environmentId as EnvironmentId;
  takingEntryIds.add(take.entryId);
  try {
    const taken = await runAtomCommand(
      appAtomRegistry,
      promptStashCommands.take,
      { environmentId, input: { entryId: take.entryId, requestId: take.requestId } },
      { reportFailure: false },
    );
    if (taken._tag === "Failure") {
      const reason = promptStashErrorReason(squashAtomCommandFailure(taken));
      if (reason !== "already-taken" && reason !== "not-found") return false;
      usePromptStashStore.getState().removePendingTake(take.requestId);
      return true;
    }
    // The request id makes the put idempotent too, should this reply be lost as well.
    const put = await retryLostReply(() =>
      runAtomCommand(
        appAtomRegistry,
        promptStashCommands.put,
        { environmentId, input: { ...taken.value, id: take.requestId } },
        { reportFailure: false },
      ),
    );
    if (put._tag === "Failure") return false;
    usePromptStashStore.getState().removePendingTake(take.requestId);
    toastManager.add({
      type: "info",
      title: m(msg("A prompt that couldn't be taken was returned to the stash")),
      data: { hideCopyButton: true },
    });
    return true;
  } finally {
    takingEntryIds.delete(take.entryId);
    ownTakeRequestIds.delete(take.requestId);
  }
}

/** True when everything this pass tried went through. */
async function runPass(): Promise<boolean> {
  const connected = new Set<string>(connectedStashEnvironmentIds());
  const writable = new Set<string>(writableEnvironmentIds());
  let settled = true;
  const takes = retryablePendingTakes(usePromptStashStore.getState().pendingTakes, {
    connected: writable,
    taking: takingEntryIds,
    ownRequestIds: ownTakeRequestIds,
    now: Date.now(),
  });
  for (const take of takes) {
    if (!(await retryPendingTake(take))) settled = false;
  }

  const serverIds = new Set(
    get(serverStashSummariesAtom)
      .filter(({ environmentId }) => connected.has(environmentId))
      .flatMap(({ summaries }) => summaries.map((summary) => summary.id)),
  );
  const store = usePromptStashStore.getState();
  const result = await runStashSyncPass({
    readEntries: readLatestEntries,
    serverIds,
    targetFor: (entry) => {
      const environmentId = localEntryTarget(entry);
      return environmentId !== null && writable.has(environmentId) ? environmentId : null;
    },
    isHeld: (entryId) => takingEntryIds.has(entryId) || tooLargeEntryIds.has(entryId),
    uploadImages: uploadEntryImages,
    put: putEntry,
    deleteUploads: (environmentId, attachmentIds) => {
      for (const attachmentId of attachmentIds) deletePendingUpload(environmentId, attachmentId);
    },
    dropEntries: store.dropEntries,
    onUpload: (entryId, outcome) => {
      uploadsInFlight.set(entryId, outcome);
      void outcome.then(() => {
        if (uploadsInFlight.get(entryId) === outcome) uploadsInFlight.delete(entryId);
      });
    },
  });
  if (result.evicted) announceEvicted(PROMPT_STASH_MAX_ENTRIES);
  for (const entryId of result.tooLarge) {
    tooLargeEntryIds.add(entryId);
    toastManager.add({
      type: "warning",
      title: m(msg("This stashed prompt is too large to sync and stays on this device")),
      data: { hideCopyButton: true },
    });
  }
  return settled && !result.retry;
}

const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 10 * 60_000;

// An entry becomes uploadable when its images finish encoding, so that counts as a change too.
const localEntriesKey = (entries: ReadonlyArray<PromptStashEntry>) =>
  entries
    .map((entry) => `${entry.id}:${entry.pendingImageCount ? "encoding" : "ready"}`)
    .toSorted()
    .join("\n");

export const promptStashSync = {
  start: () => {
    let stopped = false;
    let tail: Promise<unknown> = Promise.resolve();
    let passQueued = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const clearRetry = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };
    // One chain, so two passes never upload the same entry at once.
    const requestPass = () => {
      if (passQueued) return;
      passQueued = true;
      tail = tail.then(async () => {
        passQueued = false;
        if (stopped) return;
        let ok = false;
        try {
          ok = await runPass();
        } catch (error) {
          console.warn("Prompt stash sync failed", error);
        }
        if (stopped) return;
        clearRetry();
        if (ok) {
          failures = 0;
          return;
        }
        if (writableEnvironmentIds().length === 0) return;
        const delay = Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS);
        failures += 1;
        retryTimer = setTimeout(requestPass, delay);
      });
    };
    const stopStore = usePromptStashStore.subscribe((state, previous) => {
      if (
        state.entries !== previous.entries &&
        localEntriesKey(state.entries) !== localEntriesKey(previous.entries)
      ) {
        requestPass();
      }
    });
    const stopEnvironments = appAtomRegistry.subscribe(writableEnvironmentsKeyAtom, requestPass, {
      immediate: true,
    });
    return () => {
      stopped = true;
      clearRetry();
      stopStore();
      stopEnvironments();
    };
  },
};
