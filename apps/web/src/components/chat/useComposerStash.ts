import { useAtomValue } from "@effect/atom-react";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import type { ChatComposerProps } from "./ChatComposer";
import {
  type ComposerContextRecord,
  type EnvironmentId,
  PROMPT_STASH_MAX_ENTRIES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type PreviewAnnotationPayload,
  type PromptStashAttachment,
  type PromptStashPutInput,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type PersistedComposerFileAttachment,
  type PersistedComposerImageAttachment,
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  composerTargetKey,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import {
  MAX_STASH_ENTRIES,
  type PromptStashEntry,
  partitionStashAttachments,
  usePromptStashStore,
} from "../../promptStashStore";
import type { PendingUserInputProgress } from "../../pendingUserInput";
import { type PendingUserInput } from "../../session-logic";
import { type ReviewCommentContext } from "../../reviewCommentContext";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { collectComposerPromptInlineTokens } from "../../composer-editor-mentions";
import { compressImageForStash, readFileAsDataUrl } from "../../lib/imageCompression";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { pendingDraftWork } from "./pendingDraftWork";
import { countPreparingComposerImages } from "./preparingComposerImages";
import {
  isResponseContextRecord,
  previewAnnotationContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
} from "~/lib/composerContextRecords";
import { randomUUID } from "~/lib/utils";
import {
  adoptAttachmentUpload,
  forgetAttachmentUpload,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releasePersistedAttachmentUpload,
  verifyStashedAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { serverStashSummariesAtom } from "../../promptStash/serverStashSummaries";
import {
  mergeStashMenuItems,
  stashMenuItemId,
  type StashMenuItem,
} from "../../promptStash/promptStashSync.logic";
import { serverStashAccess } from "../../promptStash/promptStashSync";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { promptStashCommands } from "../../state/promptStash";
import { readPreparedConnection } from "../../state/session";
import { remainingComposerAttachmentSlots } from "./composerThreadImport";
import { composerImageDedupKey } from "./composerAttachmentFiles";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { registerCommands } from "../../shortcuts/dispatcher";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { toastManager } from "../ui/toast";
import type { useComposerTriggerState } from "./useComposerTriggerState";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { isInSideChatPane } from "../../lib/sideChatPane";
import { useStableCallback } from "../../hooks/useStableCallback";

type ServerStashMenuItem = Extract<StashMenuItem, { readonly kind: "server" }>;

function errorTag(error: unknown): unknown {
  return typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
}

function promptStashErrorReason(error: unknown): unknown {
  return errorTag(error) === "PromptStashError" &&
    typeof error === "object" &&
    error !== null &&
    "reason" in error
    ? error.reason
    : undefined;
}

/** A typed reply from the server; anything else may not have reached it. */
function isServerReply(error: unknown): boolean {
  const tag = errorTag(error);
  return tag === "PromptStashError" || tag === "EnvironmentAuthorizationError";
}

/** The image's bytes from the server, for the composer preview its draft keeps. */
async function downloadStashedImage(
  environmentId: EnvironmentId,
  attachment: PromptStashAttachment,
): Promise<PersistedComposerImageAttachment | null> {
  try {
    const minted = await executeAtomQuery(
      appAtomRegistry,
      assetEnvironment.createUrl({
        environmentId,
        input: { resource: { _tag: "attachment", attachmentId: attachment.attachmentId } },
      }),
      { refresh: true, reportFailure: false },
    );
    const connection = readPreparedConnection(environmentId);
    const url =
      minted._tag === "Success" && connection
        ? resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl)
        : null;
    if (!url) return null;
    const response = await fetch(url);
    if (!response.ok) return null;
    const dataUrl = await readFileAsDataUrl(await response.blob());
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl,
      ...(attachment.source && "kind" in attachment.source ? { source: attachment.source } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The prompt stash: saving the draft aside, restoring or deleting an entry, the badge pulse,
 * and the stash shortcut. Its state lives here so the composer body only wires it up.
 */
export function useComposerStash(input: {
  readonly environmentId: EnvironmentId;
  readonly composerDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly promptRef: ChatComposerProps["promptRef"];
  readonly readAttachmentDraft: () => Pick<ComposerThreadDraftState, "images" | "files">;
  readonly readTerminalContexts: () => ComposerThreadDraftState["terminalContexts"];
  readonly routeThreadRef: ChatComposerProps["routeThreadRef"];
  readonly projectSelectionRequired: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly prompt: string;
  readonly composerMenuOpen: boolean;
  readonly isComposerCollapsedMobile: boolean;
  readonly composerPreviewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly composerReviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly composerThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly attachmentTargetKey: string;
  readonly isComposerDraftTargetOpen: (targetKey: string) => boolean;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly isRevertingCheckpoint: () => boolean;
  readonly pendingThreadImportsRef: RefObject<Map<string, number>>;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly setComposerTrigger: ReturnType<typeof useComposerTriggerState>["setTrigger"];
  readonly importContextRecords: (
    records: ReadonlyArray<ComposerContextRecord>,
    sourceEnvironmentId: EnvironmentId | null,
    threadDraftTarget?: ChatComposerProps["composerDraftTarget"],
  ) => ReadonlyMap<string, string>;
  readonly expandMobileComposer: () => void;
}) {
  const {
    environmentId,
    composerDraftTarget,
    promptRef,
    readAttachmentDraft,
    readTerminalContexts,
    routeThreadRef,
    projectSelectionRequired,
    pendingUserInputs,
    activePendingProgress,
    prompt,
    composerMenuOpen,
    isComposerCollapsedMobile,
    composerPreviewAnnotations,
    composerReviewComments,
    composerThreadContexts,
    attachmentTargetKey,
    isComposerDraftTargetOpen,
    composerEditorRef,
    isRevertingCheckpoint,
    pendingThreadImportsRef,
    setComposerCursor,
    setComposerTrigger,
    importContextRecords,
    expandMobileComposer,
  } = input;
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftReplyTo = useComposerDraftStore((store) => store.setReplyTo);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.clearTerminalContexts,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const setComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.setEnvironmentContexts,
  );
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  // Each stash bumps the key; the badge replays its one-shot pulse animation per key.
  const [stashPulseKey, setStashPulseKey] = useState(0);
  const stashInFlightRef = useRef<Set<string>>(new Set());

  const stashQueue = usePromptStashStore((state) => state.entries);
  const serverStashSummaries = useAtomValue(serverStashSummariesAtom);
  const stashItems = mergeStashMenuItems(stashQueue, serverStashSummaries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  const pulseStashBadge = () => {
    setStashPulseKey((key) => key + 1);
  };

  // Stable, so the check after the verify await sees a question that opened during it.
  const refuseMachinesInAnswer = useStableCallback(
    (menuEntry: Pick<PromptStashEntry, "records">) => {
      // An answer to an agent's question carries no machines, so restoring here would drop them.
      if (
        pendingUserInputs.length > 0 &&
        menuEntry.records?.some((record) => record.kind === "environment")
      ) {
        toastManager.add({
          type: "error",
          title: m(msg("Stashed machines can't go in an answer")),
          description: m(msg("Restore this prompt after the agent's question is answered.")),
        });
        return true;
      }
      return false;
    },
  );

  const refuseOtherEnvironment = () => {
    toastManager.add({
      type: "error",
      title: m(msg("Stashed files belong to another environment")),
      description: m(msg("Restore this prompt in the environment that received its files.")),
    });
  };

  const restoreLocalStashEntry = async (menuEntry: PromptStashEntry) => {
    const filesToVerify = menuEntry.files ?? [];
    if (filesToVerify.some((file) => file.environmentId !== environmentId)) {
      refuseOtherEnvironment();
      return;
    }
    if (refuseMachinesInAnswer(menuEntry)) return;
    setIsStashMenuOpen(false);

    // An expired upload restores as a needs-reattach row instead of a reference
    // the next send would fail to verify. Verify BEFORE taking: the take
    // removes the entry from durable storage, and a tab closed during this
    // await must still find it there after reload.
    const verifications = await Promise.all(
      filesToVerify.map((file) =>
        verifyStashedAttachmentUpload({ environmentId, attachmentId: file.attachmentId }),
      ),
    );
    const expiredAttachmentIds = new Set(
      filesToVerify
        .filter((_, index) => verifications[index]?.status === "missing")
        .map((file) => file.attachmentId),
    );

    // A thread switch during the verify await would mix the new thread's
    // prompt with this invocation's captured target. Nothing was taken yet,
    // so abort and leave the entry restorable where the user now is.
    if (
      isRevertingCheckpoint() ||
      !isComposerDraftTargetOpen(composerTargetKey(composerDraftTarget)) ||
      refuseMachinesInAnswer(menuEntry)
    ) {
      return;
    }

    const { entry, durable } = takeStashEntry(menuEntry.id);
    if (!entry) return;
    if (!durable) {
      toastManager.add({
        type: "warning",
        title: m(msg("Restored prompt may reappear in the stash")),
        description: m(
          msg(
            "Browser storage rejected the update, so this entry could still be there after a reload.",
          ),
        ),
        data: { hideCopyButton: true },
      });
    }
    applyRestoredEntry(entry, { durable, expiredAttachmentIds });
  };

  const restoreServerStashEntry = async (item: ServerStashMenuItem) => {
    if (item.environmentId !== environmentId) {
      refuseOtherEnvironment();
      return;
    }
    if (
      isRevertingCheckpoint() ||
      !isComposerDraftTargetOpen(composerTargetKey(composerDraftTarget))
    ) {
      return;
    }
    setIsStashMenuOpen(false);
    const cannotReach = () =>
      toastManager.add({
        type: "error",
        title: m(msg("Can't reach the server to take this stashed prompt")),
      });
    if (serverStashAccess(environmentId) === "unavailable") {
      cannotReach();
      return;
    }

    // The same request id makes a retry after a lost reply return the first take's result.
    const requestId = randomUUID();
    const take = () =>
      runAtomCommand(
        appAtomRegistry,
        promptStashCommands.take,
        { environmentId, input: { entryId: item.summary.id, requestId } },
        { reportFailure: false },
      );
    let result = await take();
    if (result._tag === "Failure" && !isServerReply(squashAtomCommandFailure(result))) {
      result = await take();
    }
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      const reason = promptStashErrorReason(error);
      if (reason === "already-taken" || reason === "not-found") {
        toastManager.add({
          type: "info",
          title: m(msg("This prompt was already taken on another device")),
        });
      } else if (!isServerReply(error)) {
        cannotReach();
      } else {
        toastManager.add({
          type: "error",
          title: m(msg("Could not take this stashed prompt")),
          description: errorDisplayMessage(error, m) ?? undefined,
        });
      }
      return;
    }

    const taken = result.value;
    // A summary carries no records, so only the taken entry shows its machines; stash it again.
    if (refuseMachinesInAnswer(taken)) {
      const restash = await runAtomCommand(
        appAtomRegistry,
        promptStashCommands.put,
        { environmentId, input: { ...taken, id: randomUUID() } },
        { reportFailure: false },
      );
      if (restash._tag === "Success") return;
    }
    const stashedImages = taken.attachments.filter((attachment) => attachment.type === "image");
    const downloads = await Promise.all(
      stashedImages.map((attachment) => downloadStashedImage(environmentId, attachment)),
    );
    const undownloadedImageNames: string[] = [];
    stashedImages.forEach((attachment, index) => {
      if (downloads[index]) return;
      undownloadedImageNames.push(attachment.name);
      releasePersistedAttachmentUpload({
        id: attachment.id,
        environmentId,
        attachmentId: attachment.attachmentId,
      });
    });
    applyRestoredEntry(
      {
        id: taken.id,
        createdAt: taken.createdAt,
        prompt: taken.prompt,
        attachments: downloads.filter((image) => image !== null),
        files: taken.attachments.flatMap((attachment) =>
          attachment.type === "file"
            ? [
                {
                  id: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                  attachmentId: attachment.attachmentId,
                  environmentId,
                  ...(attachment.source && "_tag" in attachment.source
                    ? { source: attachment.source }
                    : {}),
                },
              ]
            : [],
        ),
        droppedImageNames: taken.droppedImageNames,
        unreadableImageNames: taken.unreadableImageNames,
        records: taken.records,
      },
      {
        durable: true,
        expiredAttachmentIds: new Set(),
        uploadedImageIds: new Map(
          stashedImages.flatMap((attachment, index) =>
            downloads[index] ? [[attachment.id, attachment.attachmentId] as const] : [],
          ),
        ),
        droppedFileNames: taken.droppedFileNames,
        undownloadedImageNames,
      },
    );
  };

  const adoptServerImageUploads = (
    restored: ReadonlyArray<ComposerImageAttachment>,
    uploads: ReadonlyMap<string, string>,
  ) => {
    const restoredIds = new Set(restored.map((image) => image.id));
    for (const [imageId, attachmentId] of uploads) {
      if (restoredIds.has(imageId)) {
        adoptAttachmentUpload({ imageId, environmentId, attachmentId });
        continue;
      }
      const held = readAttachmentUpload(imageId);
      if (held?.status === "ready" && held.attachmentId === attachmentId) continue;
      releasePersistedAttachmentUpload({ id: imageId, environmentId, attachmentId });
    }
  };

  const restoreStashEntry = (item: StashMenuItem) =>
    item.kind === "local" ? restoreLocalStashEntry(item.entry) : restoreServerStashEntry(item);

  const applyRestoredEntry = (
    entry: PromptStashEntry,
    options: {
      readonly durable: boolean;
      readonly expiredAttachmentIds: ReadonlySet<string>;
      /** Composer image id to the server upload it already has, so it is not uploaded again. */
      readonly uploadedImageIds?: ReadonlyMap<string, string>;
      readonly droppedFileNames?: ReadonlyArray<string>;
      readonly undownloadedImageNames?: ReadonlyArray<string>;
    },
  ) => {
    const { durable, expiredAttachmentIds } = options;
    // A server take cannot be undone, so after a thread switch during it the prompt still lands
    // in the draft it was taken for, without touching the composer now on screen.
    const live = isComposerDraftTargetOpen(composerTargetKey(composerDraftTarget));
    const readTargetAttachments = (): Pick<ComposerThreadDraftState, "images" | "files"> => {
      if (live) return readAttachmentDraft();
      const draft = getComposerDraft(composerDraftTarget);
      return { images: draft?.images ?? [], files: draft?.files ?? [] };
    };
    const rewrittenContextIds = entry.records
      ? importContextRecords(entry.records, null, composerDraftTarget)
      : new Map<string, string>();
    // A reply only makes sense in the thread that holds the response, and one already pending wins.
    const stashedReply = entry.records?.find(isResponseContextRecord);
    if (
      stashedReply &&
      !getComposerDraft(composerDraftTarget)?.replyTo &&
      typeof composerDraftTarget !== "string" &&
      stashedReply.citation.threadId === composerDraftTarget.threadId &&
      stashedReply.citation.environmentId === composerDraftTarget.environmentId
    ) {
      setComposerDraftReplyTo(composerDraftTarget, stashedReply);
    }
    const restoredPrompt = replaceComposerContextReferences(entry.prompt, (reference) => {
      const contextId = rewrittenContextIds.get(reference.contextId);
      return contextId
        ? formatInlineContextReference({
            ...reference,
            contextId,
            kind: reference.kind === "element" ? "preview-annotation" : reference.kind,
          })
        : reference.source;
    });
    const currentPrompt = live
      ? promptRef.current
      : (getComposerDraft(composerDraftTarget)?.prompt ?? "");
    const nextPrompt =
      restoredPrompt.length === 0
        ? currentPrompt
        : currentPrompt.trim().length
          ? `${currentPrompt.replace(/\s+$/, "")}\n\n${restoredPrompt}`
          : restoredPrompt;
    let promptChanged = nextPrompt !== currentPrompt;
    if (promptChanged) {
      if (live) promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      if (live) {
        setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
        setComposerTrigger(null);
      }
    }

    let unrestoredFileNames: string[] = [];
    const expiredFileNames: string[] = [...(options.droppedFileNames ?? [])];
    let restoredFileCount = 0;
    const stashedFiles = entry.files ?? [];
    if (stashedFiles.length > 0) {
      const composerFilesNow = readTargetAttachments().files;
      const existingFileIds = new Set(composerFilesNow.map((file) => file.id));
      const retainedUploadIds = new Set(
        composerFilesNow.flatMap((file) =>
          file.uploadedAttachmentId ? [file.uploadedAttachmentId] : [],
        ),
      );
      const existingFileKeys = new Set(composerFilesNow.map(composerFileDedupKey));
      const reattachMarkers = composerFilesNow.filter(composerFileNeedsReattach);
      const restoredMarkerIds = new Set<string>();
      const duplicateFiles: PersistedComposerFileAttachment[] = [];
      const markerReplacements: ComposerFileAttachment[] = [];
      const appendedFiles: ComposerFileAttachment[] = [];
      for (const file of stashedFiles) {
        const expired = expiredAttachmentIds.has(file.attachmentId);
        const key = composerFileDedupKey(file);
        const restored: ComposerFileAttachment = {
          type: "file",
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          file: null,
          ...(file.source ? { source: file.source } : {}),
          ...(expired
            ? {}
            : { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: environmentId }),
        };
        if (existingFileIds.has(file.id)) {
          if (!expired && !retainedUploadIds.has(file.attachmentId)) {
            duplicateFiles.push(file);
          }
          continue;
        }
        const reattachMarker = reattachMarkers.find(
          (marker) =>
            !restoredMarkerIds.has(marker.id) && composerFileMatchesReattachMarker(marker, file),
        );
        if (reattachMarker) {
          restoredMarkerIds.add(reattachMarker.id);
          existingFileIds.add(file.id);
          existingFileKeys.add(key);
          if (expired) {
            expiredFileNames.push(file.name);
          } else {
            retainedUploadIds.add(file.attachmentId);
            markerReplacements.push(restored);
          }
          continue;
        }
        if (existingFileKeys.has(key)) {
          if (!expired && !retainedUploadIds.has(file.attachmentId)) {
            duplicateFiles.push(file);
          }
          continue;
        }
        existingFileIds.add(file.id);
        existingFileKeys.add(key);
        if (expired) {
          expiredFileNames.push(file.name);
        } else {
          retainedUploadIds.add(file.attachmentId);
        }
        appendedFiles.push(restored);
      }
      const capacity = remainingComposerAttachmentSlots(
        readTargetAttachments().images.length + composerFilesNow.length,
        pendingThreadImportsRef.current.get(composerTargetKey(composerDraftTarget)) ?? 0,
      );
      const filesToAppend = appendedFiles.slice(0, capacity);
      const skippedFiles = appendedFiles.slice(capacity);
      unrestoredFileNames = skippedFiles.map((file) => file.name);
      // A non-durable take can resurrect the stash entry after a reload;
      // deleting these uploads would leave it pointing at nothing.
      if (durable) {
        for (const file of duplicateFiles) {
          releasePersistedAttachmentUpload({
            id: file.id,
            environmentId,
            attachmentId: file.attachmentId,
          });
        }
        for (const file of skippedFiles) {
          if (file.uploadedAttachmentId) {
            releasePersistedAttachmentUpload({
              id: file.id,
              environmentId,
              attachmentId: file.uploadedAttachmentId,
            });
          }
        }
      }
      const restoredFiles = [...markerReplacements, ...filesToAppend];
      if (restoredFiles.length > 0) {
        addComposerDraftFiles(composerDraftTarget, restoredFiles, { appendReference: true });
        const restoredFilePrompt = getComposerDraft(composerDraftTarget)?.prompt;
        if (live && restoredFilePrompt !== undefined && restoredFilePrompt !== promptRef.current) {
          promptRef.current = restoredFilePrompt;
          setComposerCursor(
            collapseExpandedComposerCursor(restoredFilePrompt, restoredFilePrompt.length),
          );
          setComposerTrigger(null);
          promptChanged = true;
        }
        restoredFileCount = filesToAppend.length;
      }
    }

    let unrestoredImageNames: string[] = [];
    if (entry.attachments.length > 0) {
      const attachmentDraft = readTargetAttachments();
      const existingIds = new Set(attachmentDraft.images.map((image) => image.id));
      // Filter on the draft store's dedupe key here. Counting a duplicate
      // against capacity would burn a slot the store then refuses to fill,
      // pushing a genuinely unique image into the overflow list for nothing.
      const existingDedupKeys = new Set(attachmentDraft.images.map(composerImageDedupKey));
      const capacity = remainingComposerAttachmentSlots(
        attachmentDraft.images.length + attachmentDraft.files.length + restoredFileCount,
        pendingThreadImportsRef.current.get(composerTargetKey(composerDraftTarget)) ?? 0,
      );
      const pending = hydrateImagesFromPersisted(entry.attachments).filter(
        (image) =>
          !existingIds.has(image.id) && !existingDedupKeys.has(composerImageDedupKey(image)),
      );
      unrestoredImageNames = pending.slice(capacity).map((image) => image.name);
      const restoredImages = pending.slice(0, capacity);
      if (options.uploadedImageIds) {
        adoptServerImageUploads(restoredImages, options.uploadedImageIds);
      }
      if (restoredImages.length > 0) {
        addComposerDraftImages(composerDraftTarget, restoredImages);
      }
    }

    const missingImageReasons: string[] = [];
    if (entry.droppedImageNames.length > 0) {
      missingImageReasons.push(
        m(
          msg("{names} exceeded the stash size limit when this prompt was saved.", {
            names: entry.droppedImageNames.join(", "),
          }),
        ),
      );
    }
    if (options.undownloadedImageNames && options.undownloadedImageNames.length > 0) {
      missingImageReasons.push(
        m(
          msg("{names} could not be downloaded from the server.", {
            names: options.undownloadedImageNames.join(", "),
          }),
        ),
      );
    }
    if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
      missingImageReasons.push(
        m(
          msg("{names} could not be read when this prompt was saved.", {
            names: entry.unreadableImageNames.join(", "),
          }),
        ),
      );
    }
    if (unrestoredImageNames.length > 0) {
      missingImageReasons.push(
        m(
          msg("{names} could not be restored: the composer is at its {limit}-attachment limit.", {
            names: unrestoredImageNames.join(", "),
            limit: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
          }),
        ),
      );
    }
    if (unrestoredFileNames.length > 0) {
      missingImageReasons.push(
        m(
          msg("{names} could not be restored: the composer is at its {limit}-attachment limit.", {
            names: unrestoredFileNames.join(", "),
            limit: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
          }),
        ),
      );
    }
    if (expiredFileNames.length > 0) {
      missingImageReasons.push(
        m(
          msg(
            "{names}: stashed files are kept for 24 hours and this upload expired. Attach the file again.",
            { names: expiredFileNames.join(", ") },
          ),
        ),
      );
    }
    if (missingImageReasons.length > 0) {
      toastManager.add({
        type: "warning",
        title: m(msg("Some attachments were not restored")),
        description: missingImageReasons.join(" "),
      });
    }

    if (promptChanged && live) {
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAtEnd();
      });
    }
  };
  const restoreStashEntryStable = useStableCallback(restoreStashEntry);

  const deleteServerStashEntry = async (item: ServerStashMenuItem) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      promptStashCommands.remove,
      { environmentId: item.environmentId, input: { entryId: item.summary.id } },
      { reportFailure: false },
    );
    if (result._tag === "Success") return;
    toastManager.add({
      type: "error",
      title: m(msg("Could not delete this stashed prompt")),
      description: errorDisplayMessage(squashAtomCommandFailure(result), m) ?? undefined,
    });
  };

  const deleteStashEntry = (item: StashMenuItem) => {
    const itemId = stashMenuItemId(item);
    if (!stashItems.some((candidate) => stashMenuItemId(candidate) !== itemId)) {
      setIsStashMenuOpen(false);
    }
    if (item.kind === "server") {
      void deleteServerStashEntry(item);
      return;
    }
    const { entry: removed, durable } = takeStashEntry(item.entry.id);
    if (durable && removed) {
      for (const file of removed.files ?? []) {
        releasePersistedAttachmentUpload({
          id: file.id,
          environmentId: file.environmentId,
          attachmentId: file.attachmentId,
        });
      }
    }
    if (!durable) {
      toastManager.add({
        type: "warning",
        title: m(msg("Stash entry may come back")),
        description: m(
          msg("Browser storage rejected the delete, so this prompt could reappear after a reload."),
        ),
        data: { hideCopyButton: true },
      });
    }
  };
  const deleteStashEntryStable = useStableCallback(deleteStashEntry);

  const stashCurrentPrompt = async () => {
    // Stashing clears the draft. A pasted attachment still downloading would then land in the
    // emptied composer instead of travelling with the entry it belongs to.
    if (pendingDraftWork.has(attachmentTargetKey)) {
      toastManager.add({
        type: "info",
        title: m(msg("Still bringing attached context into this message.")),
        description: m(msg("Stash again once its chip resolves.")),
      });
      return;
    }
    const replyTo = getComposerDraft(composerDraftTarget)?.replyTo;
    const trimmedPrompt = promptRef.current.trim();
    // A trailing chip only parses with whitespace after it, so keep one space to restore it.
    const endsWithChip =
      collectComposerPromptInlineTokens(promptRef.current).at(-1)?.end ===
      promptRef.current.trimEnd().length;
    const prompt = endsWithChip ? `${trimmedPrompt} ` : trimmedPrompt;
    const attachmentDraft = readAttachmentDraft();
    const images = [...attachmentDraft.images];
    const files = [...attachmentDraft.files];
    const stashedRecords: ComposerContextRecord[] = [
      ...(replyTo ? [replyTo] : []),
      ...composerThreadContexts,
      ...(getComposerDraft(composerDraftTarget)?.environmentContexts ?? []),
      ...readTerminalContexts().map(terminalContextRecord),
      ...composerReviewComments.map(reviewCommentContextRecord),
      ...composerPreviewAnnotations.map((annotation) =>
        previewAnnotationContextRecord(annotation, {
          screenshotContextId: images.some((image) => image.id === annotation.id)
            ? annotation.id
            : undefined,
        }),
      ),
    ];
    if (prompt.length === 0 && images.length === 0 && files.length === 0) {
      const items = mergeStashMenuItems(
        usePromptStashStore.getState().entries,
        appAtomRegistry.get(serverStashSummariesAtom),
      );
      const item = items.length === 1 ? items[0] : undefined;
      if (item && !(item.kind === "local" && item.entry.pendingImageCount)) {
        await restoreStashEntry(item);
      } else {
        setIsStashMenuOpen((open) => !open);
      }
      return;
    }
    // The snapshot only holds compressed images; a still-compressing one would land in the
    // emptied composer instead of travelling with this entry.
    if (countPreparingComposerImages(attachmentTargetKey) > 0) {
      toastManager.add({
        type: "info",
        title: m(msg("Still compressing a pasted image.")),
        description: m(msg("Stash again once it finishes compressing.")),
      });
      return;
    }
    const stashedFiles: PersistedComposerFileAttachment[] = [];
    for (const file of files) {
      if (composerFileNeedsReattach(file)) {
        toastManager.add({
          type: "error",
          title: m(msg("Attach dropped files again or remove them before stashing")),
        });
        return;
      }
      const upload = readAttachmentUpload(file.id);
      if (upload?.status !== "ready" || upload.environmentId !== environmentId) {
        toastManager.add({
          type: "error",
          title: m(msg("Wait for file uploads before stashing this prompt")),
        });
        return;
      }
      stashedFiles.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        attachmentId: upload.attachmentId,
        environmentId,
        ...(file.source ? { source: file.source } : {}),
      });
    }
    // Deduplicate the snapshot while encoding, not all stashes: new drafts or
    // thread switches must still be able to create their own entries.
    const attachmentKey = images
      .map((image) => `image:${image.id}`)
      .concat(files.map((file) => `file:${file.id}`))
      .join(",");
    const snapshotKey = [String(composerDraftTarget), prompt, attachmentKey].join("\n");
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const stashTarget = composerDraftTarget;
    // The local fallback reuses the id, so an entry the server stored despite a lost reply
    // syncs onto it instead of showing twice.
    const entryId = randomUUID();
    const createdAt = new Date().toISOString();

    const clearStashedComposer = (releaseImageUpload: (imageId: string) => void) => {
      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      clearComposerDraftTerminalContexts(stashTarget);
      setComposerDraftThreadContexts(stashTarget, []);
      setComposerDraftEnvironmentContexts(stashTarget, []);
      setComposerDraftReplyTo(stashTarget, null);
      for (const comment of composerReviewComments) {
        removeComposerDraftReviewComment(stashTarget, comment.id);
      }
      for (const annotation of composerPreviewAnnotations) {
        releaseAttachmentUpload(annotation.id);
        removeComposerDraftPreviewAnnotation(stashTarget, annotation.id);
      }
      setComposerDraftPrompt(stashTarget, "");
      for (const image of images) {
        releaseImageUpload(image.id);
      }
      setComposerCursor(0);
      setComposerTrigger(null);
      pulseStashBadge();
    };

    const announceEvicted = (max: number) => {
      toastManager.add({
        type: "warning",
        title: m(msg("Oldest stashed prompt discarded")),
        description: m(
          msg("The stash holds {max} prompts; the oldest was removed to make room.", { max }),
        ),
        data: { hideCopyButton: true },
      });
    };

    // The composer already uploaded every image and file, so the server stash keeps those uploads.
    const putToServerStash = async (): Promise<boolean> => {
      if (serverStashAccess(environmentId) !== "writable") return false;
      const attachments: PromptStashPutInput["attachments"][number][] = [];
      for (const attachment of [...images, ...files]) {
        const upload = readAttachmentUpload(attachment.id);
        if (upload?.status !== "ready" || upload.environmentId !== environmentId) return false;
        attachments.push({
          type: attachment.type,
          id: attachment.id,
          attachmentId: upload.attachmentId,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          ...(attachment.source ? { source: attachment.source } : {}),
        });
      }
      const result = await runAtomCommand(
        appAtomRegistry,
        promptStashCommands.put,
        {
          environmentId,
          input: {
            id: entryId,
            createdAt,
            prompt,
            attachments,
            droppedImageNames: [],
            unreadableImageNames: [],
            droppedFileNames: [],
            records: stashedRecords,
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") {
        console.warn("Prompt stash put failed; stashing locally", squashAtomCommandFailure(result));
        return false;
      }
      clearStashedComposer(forgetAttachmentUpload);
      if (result.value.evictedIds.length > 0) announceEvicted(PROMPT_STASH_MAX_ENTRIES);
      return true;
    };

    const stashAndEncode = async () => {
      if (await putToServerStash()) return;
      // Ordering matters in both directions: writing before clearing means a
      // crash or closed tab mid-encode still leaves the prompt recoverable,
      // while clearing before the async image work means edits typed during
      // encoding are not wiped.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt,
        prompt,
        attachments: [],
        ...(stashedFiles.length > 0 ? { files: stashedFiles } : {}),
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
        ...(stashedRecords.length > 0 ? { records: stashedRecords } : {}),
      });

      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: m(msg("Could not stash this prompt")),
          description: m(
            msg(
              "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
            ),
          ),
          data: { hideCopyButton: true },
        });
        return;
      }
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: m(msg("Stashed prompt will not survive a reload")),
          description: m(
            msg(
              "Browser storage is unavailable, so this stash is kept in memory only for this session.",
            ),
          ),
          data: { hideCopyButton: true },
        });
      }

      clearStashedComposer(releaseAttachmentUpload);

      if (evicted) {
        for (const file of evicted.files ?? []) {
          releasePersistedAttachmentUpload({
            id: file.id,
            environmentId: file.environmentId,
            attachmentId: file.attachmentId,
          });
        }
        announceEvicted(MAX_STASH_ENTRIES);
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
          ...(image.source
            ? { source: resizeSnapShotSource(image.source, result.image.imageSize) }
            : {}),
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: m(msg("Stashed images were not saved")),
            description: m(
              msg(
                "The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.",
              ),
            ),
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        toastManager.add({
          type: "warning",
          title: m(msg("Stashed images did not attach")),
          description: m(
            msg(
              "{count, plural, one {That prompt was restored or deleted before {count} image finished saving. Re-attach it if you still need it.} other {That prompt was restored or deleted before {count} images finished saving. Re-attach them if you still need them.}}",
              { count: kept.length },
            ),
          ),
          data: { hideCopyButton: true },
        });
      }
    };
    await stashAndEncode().finally(() => stashInFlightRef.current.delete(snapshotKey));
  };
  const stashCurrentPromptStable = useStableCallback(stashCurrentPrompt);

  const toggleStashMenu = () => {
    if (isComposerCollapsedMobile) {
      expandMobileComposer();
      setIsStashMenuOpen(true);
      return;
    }
    setIsStashMenuOpen((open) => !open);
  };
  const toggleStashMenuStable = useStableCallback(toggleStashMenu);

  const [stashMenuClosesOn, setStashMenuClosesOn] = useState({ prompt, composerMenuOpen });
  if (
    stashMenuClosesOn.prompt !== prompt ||
    stashMenuClosesOn.composerMenuOpen !== composerMenuOpen
  ) {
    setStashMenuClosesOn({ prompt, composerMenuOpen });
    if (stashMenuClosesOn.prompt !== prompt || composerMenuOpen) setIsStashMenuOpen(false);
  }

  // Read at event time, so the scope registers once per mounted composer instead of
  // re-registering (and reshuffling capture-scope priority) whenever a guard flips.
  const handleStashShortcut = useStableCallback((event: KeyboardEvent) => {
    // Always claim the shortcut so the browser save dialog never opens,
    // even when the composer is in a state that can't stash.
    event.preventDefault();
    event.stopPropagation();
    if (isCommandPaletteOpen() || isRevertingCheckpoint()) return;
    if (pendingUserInputs.length > 0) {
      setIsStashMenuOpen((open) => !open);
      return;
    }
    if (projectSelectionRequired || activePendingProgress !== null) return;
    void stashCurrentPromptStable();
  });
  // Capture phase while the composer is mounted, so Mod+S never reaches the browser's save
  // dialog even when a focused widget (the model picker search) stops the key.
  const backgroundThread = use(BackgroundThreadContext);
  const readShortcutContext = useStableCallback(() => ({
    terminalOpen: Boolean(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        routeThreadRef,
      ).terminalOpen,
    ),
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the capture-phase stash shortcut with the command registry while the composer is mounted
  useEffect(() => {
    if (backgroundThread) return;
    return registerCommands(
      { "composer.stash": handleStashShortcut },
      {
        capture: true,
        context: readShortcutContext,
        when: (event) => !isInSideChatPane(event.target),
      },
    );
  }, [backgroundThread, handleStashShortcut, readShortcutContext]);

  return {
    stashItems,
    isStashMenuOpen,
    setIsStashMenuOpen,
    stashPulseKey,
    restoreStashEntryStable,
    deleteStashEntryStable,
    toggleStashMenuStable,
  };
}
