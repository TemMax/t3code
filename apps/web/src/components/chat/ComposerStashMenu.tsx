import { msg, T, useGT, useMessages, Var } from "gt-react";
import { BookmarkIcon, FileIcon, FileTextIcon } from "lucide-react";
import { memo, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import type { EnvironmentId, PromptStashAttachment, PromptStashSummary } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { RelativeTime } from "../RelativeTime";
import { useAssetUrls } from "~/assets/assetUrls";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { type PromptStashEntry } from "../../promptStashStore";
import { stashMenuItemId, type StashMenuItem } from "../../promptStash/promptStashSync.logic";
import { ComposerBanner } from "./ComposerBanner";

const SNIPPET_MAX_CHARS = 90;
const THUMBNAIL_LIMIT = 3;

/** A bare local entry still works here, so callers that only know local entries pass those. */
type StashMenuEntry = PromptStashEntry | StashMenuItem;

function asStashMenuItem(entry: StashMenuEntry): StashMenuItem {
  return "kind" in entry ? entry : { kind: "local", entry };
}

function stashMenuEntryId(entry: StashMenuEntry): string {
  return stashMenuItemId(asStashMenuItem(entry));
}

function isServerSummary(
  entry: PromptStashEntry | PromptStashSummary,
): entry is PromptStashSummary {
  return "droppedFileNames" in entry;
}

function missingImageCount(entry: PromptStashEntry | PromptStashSummary): number {
  return entry.droppedImageNames.length + (entry.unreadableImageNames?.length ?? 0);
}

function missingFileCount(entry: PromptStashEntry | PromptStashSummary): number {
  return isServerSummary(entry) ? entry.droppedFileNames.length : 0;
}

function stashedFileCount(entry: PromptStashEntry | PromptStashSummary): number {
  return isServerSummary(entry)
    ? entry.attachments.filter((attachment) => attachment.type === "file").length
    : (entry.files?.length ?? 0);
}

export function stashEntrySnippet(
  entry: PromptStashEntry | PromptStashSummary,
  resolve: MessageResolver = m,
): string {
  const trimmed = assistantCitationsToPlainText(
    replaceComposerContextReferences(entry.prompt, (reference) => reference.label),
  )
    .trim()
    .replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    if (trimmed.length <= SNIPPET_MAX_CHARS) return trimmed;
    // Never end on a lone high surrogate, the first half of an emoji.
    const last = trimmed.charCodeAt(SNIPPET_MAX_CHARS - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? SNIPPET_MAX_CHARS - 1 : SNIPPET_MAX_CHARS;
    return `${trimmed.slice(0, end)}…`;
  }
  const storedImageCount = isServerSummary(entry)
    ? entry.attachments.filter((attachment) => attachment.type === "image").length
    : entry.attachments.length;
  const imageCount = storedImageCount + entry.droppedImageNames.length;
  const fileCount = stashedFileCount(entry);
  const attachmentCount = imageCount + fileCount;
  if (attachmentCount === 0) {
    return resolve(msg("(empty)"));
  }
  if (imageCount > 0 && fileCount > 0) {
    return resolve(
      msg("{count, plural, one {({count} attachment)} other {({count} attachments)}}", {
        count: attachmentCount,
      }),
    );
  }
  return fileCount > 0
    ? resolve(
        msg("{count, plural, one {({count} file)} other {({count} files)}}", {
          count: attachmentCount,
        }),
      )
    : resolve(
        msg("{count, plural, one {({count} image)} other {({count} images)}}", {
          count: attachmentCount,
        }),
      );
}

const thumbnailClassName = "size-4 rounded border border-border/70 object-cover";

function ServerStashThumbnails(props: {
  environmentId: EnvironmentId;
  images: ReadonlyArray<PromptStashAttachment>;
}) {
  const urls = useAssetUrls(
    props.environmentId,
    props.images.map((image) => ({
      _tag: "attachment" as const,
      attachmentId: image.attachmentId,
    })),
  );
  return props.images.map((image, index) => {
    const url = urls[index];
    return url ? (
      <img key={image.id} src={url} alt="" aria-hidden="true" className={thumbnailClassName} />
    ) : (
      <span key={image.id} aria-hidden="true" className={cn(thumbnailClassName, "bg-muted")} />
    );
  });
}

function StashThumbnails(props: { item: StashMenuItem }) {
  const { item } = props;
  if (item.kind === "local") {
    if (item.entry.attachments.length === 0) return null;
    return (
      <span className="flex shrink-0 items-center -space-x-1.5">
        {item.entry.attachments.slice(0, THUMBNAIL_LIMIT).map((attachment) => (
          <img
            key={attachment.id}
            src={attachment.dataUrl}
            alt=""
            aria-hidden="true"
            className={thumbnailClassName}
          />
        ))}
      </span>
    );
  }
  const images = item.summary.attachments
    .filter((attachment) => attachment.type === "image")
    .slice(0, THUMBNAIL_LIMIT);
  if (images.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center -space-x-1.5">
      <ServerStashThumbnails environmentId={item.environmentId} images={images} />
    </span>
  );
}

/** Window capture gives the open menu priority over composer key handlers. */
function ComposerStashMenuList<T extends StashMenuEntry>(props: {
  entries: ReadonlyArray<T>;
  stashShortcutLabel: string | null;
  composerFormRef: RefObject<HTMLFormElement | null>;
  onRestore: (entry: T) => void;
  onDelete: (entry: T) => void;
  onClose: () => void;
}) {
  const { entries, stashShortcutLabel, composerFormRef, onRestore, onDelete, onClose } = props;
  const gt = useGT();
  const m = useMessages();
  const [highlightedId, setHighlightedId] = useState<string | null>(
    entries[0] ? stashMenuEntryId(entries[0]) : null,
  );

  const highlightedEntry =
    entries.find((entry) => stashMenuEntryId(entry) === highlightedId) ?? entries[0];
  const highlightedEntryId = highlightedEntry ? stashMenuEntryId(highlightedEntry) : null;
  const drawerRef = useRef<HTMLDivElement>(null);

  // Both listeners read entries, highlight and callbacks at event time, so they subscribe
  // once for the menu's lifetime instead of on every highlight change.
  const closeOnOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const drawer = drawerRef.current;
    if (
      (drawer && event.composedPath().includes(drawer)) ||
      (event.target instanceof Element && event.target.closest('[data-prompt-stash-badge="true"]'))
    ) {
      return;
    }
    onClose();
  });

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const drawer = drawerRef.current;
    if (!drawer) return;
    const target = event.target;
    if (
      !(target instanceof Node) ||
      (target !== document.body &&
        !(target instanceof Element && target.closest('[data-prompt-stash-badge="true"]')) &&
        !drawer.contains(target) &&
        !composerFormRef.current?.querySelector('textarea, [role="textbox"]')?.contains(target))
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (entries.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const currentIndex = entries.findIndex(
        (entry) => stashMenuEntryId(entry) === highlightedEntryId,
      );
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
      const nextIndex = (normalizedIndex + offset + entries.length) % entries.length;
      const nextEntry = entries[nextIndex];
      setHighlightedId(nextEntry ? stashMenuEntryId(nextEntry) : null);
      const nextButton =
        drawer.querySelectorAll<HTMLButtonElement>("[data-stash-restore]")[nextIndex];
      nextButton?.scrollIntoView({ block: "nearest" });
      if (drawer.contains(document.activeElement)) {
        nextButton?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === "Enter") {
      // Let the delete button handle Enter instead of restoring its row.
      if (event.target instanceof HTMLElement && event.target.closest("button[aria-label]")) {
        return;
      }
      if (!highlightedEntry) return;
      event.preventDefault();
      event.stopPropagation();
      onRestore(highlightedEntry);
      return;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
      if (!highlightedEntry) return;
      event.preventDefault();
      event.stopPropagation();
      onDelete(highlightedEntry);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes capture-phase pointerdown and keydown listeners for outside close and keyboard navigation
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => closeOnOutsidePointer(event);
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return (
    <ComposerBanner.Root
      ref={drawerRef}
      className="flex min-h-0 flex-col after:shrink-0"
      data-composer-stash-drawer="true"
    >
      <ComposerBanner.Row
        render={<button type="button" />}
        aria-label={gt("Close stash")}
        aria-expanded="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onClose}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="text-muted-foreground">
          {gt("Stash", { $context: "noun, saved prompts set aside for later" })}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.Count>{entries.length}</ComposerBanner.Count>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Scroll className="flex flex-col">
        <ComposerBanner.Children render={<ul role="list" />} aria-label={gt("Stashed prompts")}>
          {entries.length === 0 ? (
            <ComposerBanner.Row render={<li />}>
              <ComposerBanner.Icon />
              <ComposerBanner.Content className="text-muted-foreground">
                <T>Nothing stashed yet.</T>
                {stashShortcutLabel ? (
                  <>
                    {" "}
                    <T>
                      Press <Var>{stashShortcutLabel}</Var> with a prompt in the composer to stash
                      it.
                    </T>
                  </>
                ) : null}
              </ComposerBanner.Content>
            </ComposerBanner.Row>
          ) : (
            entries.map((entry) => {
              const item = asStashMenuItem(entry);
              const id = stashMenuEntryId(entry);
              const stashed = item.kind === "local" ? item.entry : item.summary;
              const pendingImageCount = item.kind === "local" ? item.entry.pendingImageCount : 0;
              const missingImages = missingImageCount(stashed);
              const missingFiles = missingFileCount(stashed);
              const fileCount = stashedFileCount(stashed);
              const snippet = stashEntrySnippet(stashed, m);
              return (
                <ComposerBanner.Row
                  render={<li />}
                  key={id}
                  data-stash-entry={id}
                  data-highlighted={highlightedEntryId === id || undefined}
                  className={cn(
                    "relative rounded-sm",
                    highlightedEntryId === id && "bg-accent text-accent-foreground",
                  )}
                  onMouseMove={() => {
                    if (highlightedId !== id) setHighlightedId(id);
                  }}
                  onFocus={() => setHighlightedId(id)}
                >
                  <ComposerBanner.Icon>
                    <FileTextIcon />
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content>
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 outline-none before:absolute before:inset-0 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-inset focus-visible:before:ring-ring"
                      data-stash-restore={id}
                      aria-label={gt("Restore stashed prompt: {snippet}", { snippet })}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => onRestore(entry)}
                    >
                      {snippet}
                    </button>
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {pendingImageCount ? (
                      <span className="shrink-0 text-muted-foreground">
                        {gt(
                          "{count, plural, one {saving {count} image…} other {saving {count} images…}}",
                          { count: pendingImageCount },
                        )}
                      </span>
                    ) : (
                      <>
                        {missingImages > 0 ? (
                          <span className="shrink-0 text-warning-foreground">
                            {gt(
                              "{count, plural, one {{count} image dropped} other {{count} images dropped}}",
                              { count: missingImages },
                            )}
                          </span>
                        ) : null}
                        {missingFiles > 0 ? (
                          <span className="shrink-0 text-warning-foreground">
                            {gt(
                              "{count, plural, one {{count} file dropped} other {{count} files dropped}}",
                              { count: missingFiles },
                            )}
                          </span>
                        ) : null}
                      </>
                    )}
                    <StashThumbnails item={item} />
                    {fileCount > 0 ? (
                      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                        <FileIcon className="size-3" aria-hidden />
                        {fileCount}
                      </span>
                    ) : null}
                    <time
                      dateTime={stashed.createdAt}
                      className="shrink-0 text-muted-foreground tabular-nums max-sm:hidden"
                    >
                      <RelativeTime timestamp={stashed.createdAt} />
                    </time>
                    <ComposerBanner.Dismiss
                      className="z-10"
                      aria-label={gt("Delete stashed prompt")}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => onDelete(entry)}
                    />
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              );
            })
          )}
        </ComposerBanner.Children>
      </ComposerBanner.Scroll>
    </ComposerBanner.Root>
  );
}

// `memo` drops the generic, so the cast restores it.
export const ComposerStashMenu = memo(ComposerStashMenuList) as typeof ComposerStashMenuList;
