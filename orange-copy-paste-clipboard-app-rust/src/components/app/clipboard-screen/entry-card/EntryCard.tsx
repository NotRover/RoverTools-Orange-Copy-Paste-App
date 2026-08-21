import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ClipboardEntry, Space } from "../../../../types";
import type { EntrySyncState } from "../../../../hooks/useEntrySyncStates";
import type { EntryOwner } from "../../../../hooks/useEntryOwners";
import {
  fileNameFromPath,
  filePaths,
  isImageFile,
  isVideoFile,
  truncateText,
  deriveDisplayKind,
  htmlFragment,
  imageDisplayName,
  resolveImageSrc,
} from "../../../../types";
import { ImageIcon, FileIcon } from "../../../entry-types/EntryTypePill";
import CardMenu from "../../card-menu/CardMenu";
import { CheckIcon } from "../../../icons";
import ChipBar from "./ChipBar";
import { sanitizeHtml } from "../sanitize-html";
import type { CardClickAction } from "../../../../hooks/useCardClickAction";
import VideoPlayer from "./VideoPlayer";
import { useRelativeTime } from "../../../../hooks/useRelativeTime";
import { useImagePreviews, useMissingFiles } from "../../../../hooks/useFileMeta";
import "./EntryCard.css";

const FEEDBACK_DURATION_MS = 1500;
const TEXT_PREVIEW_LENGTH = 160;
/** How long a click waits to see if a second one is coming.
 *
 *  Only ever applied to opening the viewer, never to copying - see
 *  `handleCardClick`. Matches the Windows default double-click speed; shorter
 *  and a deliberate double click fires the first action on its own. */
const DOUBLE_CLICK_GRACE_MS = 220;

interface EntryCardProps {
  entry: ClipboardEntry;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, shouldPin: boolean) => Promise<boolean>;
  availableGroups?: string[];
  onSetGroups?: (id: string, groups: string[]) => void;
  /** Multi-select mode: whether any selection is active. */
  isSelecting?: boolean;
  /** Whether this specific card is selected. */
  isSelected?: boolean;
  /** Toggle this card's selection (Ctrl+click or click in select mode). */
  onToggleSelect?: (id: string) => void;
  /** Shift+click range selection. */
  onRangeSelect?: (id: string) => void;
  /** Open this entry in the full view. */
  onView?: (id: string) => void;
  /** What a plain click does. The other of the two is the double click. */
  clickAction?: CardClickAction;
  /** Whether this entry is currently in the OS clipboard. */
  isInClipboard?: boolean;
  /** Cloud badge state for this entry, if sync is on. */
  syncState?: EntrySyncState;
  /** Spaces this account belongs to, for the share menu. */
  spaces?: Space[];
  /** Whether a sync account is signed in (share row reason). */
  signedIn?: boolean;
  /** Space ids this entry is shared into. */
  itemSpaceIds?: string[];
  /** Names of those spaces, for the shared indicator's tooltip. */
  sharedSpaceNames?: string[];
  waitingSpaceNames?: string[];
  /** Set only when the entry arrived from another member of a space. */
  owner?: EntryOwner;
  /** Share this entry into a space, or stop sharing it there. */
  onToggleSpace?: (entryId: string, spaceId: string) => void;
  /** Whether a copy of this entry exists on the server. Read separately from
   *  `syncState`, which the badge preference can switch off. */
  inCloud?: boolean;
  /** Upload this entry, or take the server copy back off. */
  onToggleCloud?: (entryId: string, upload: boolean) => void;
}

const EntryCardImpl: React.FC<EntryCardProps> = ({
  entry,
  onCopy,
  onDelete,
  onPin,
  availableGroups = [],
  onSetGroups,
  isSelecting = false,
  isSelected = false,
  onToggleSelect,
  onRangeSelect,
  onView,
  clickAction = "copy",
  isInClipboard = false,
  syncState,
  spaces,
  signedIn,
  itemSpaceIds,
  sharedSpaceNames,
  waitingSpaceNames,
  owner,
  onToggleSpace,
  inCloud,
  onToggleCloud,
}) => {
  const [copied, setCopied] = useState(false);
  const [justPinned, setJustPinned] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const handlePin = async (shouldPin: boolean) => {
    const success = await onPin(entry.id, shouldPin);
    if (shouldPin && success) {
      setJustPinned(true);
      if (pinTimeoutRef.current) clearTimeout(pinTimeoutRef.current);
      pinTimeoutRef.current = setTimeout(
        () => setJustPinned(false),
        FEEDBACK_DURATION_MS,
      );
    }
  };
  const relTime = useRelativeTime(entry.timestamp);
  const htmlPreviewRef = useRef<HTMLDivElement>(null);

  // Sanitising rich-text runs a full DOMParser pass — memoise so it only
  // reruns when the HTML content actually changes, not on every re-render.
  const sanitizedHtml = useMemo(
    () => (entry.type === "html" ? sanitizeHtml(htmlFragment(entry.content)) : ""),
    [entry.type, entry.content],
  );

  const files = entry.type === "file" ? filePaths(entry.content) : [];
  const firstFile = files[0] ?? null;
  const firstFileUrl = firstFile ? convertFileSrc(firstFile) : "";
  const imageFiles = files.filter(isImageFile);
  const isMulti = files.length > 1;
  const entryGroups = entry.groups ?? [];
  const displayGroups = entryGroups.filter((g) => g !== "Saved");

  // Image previews + missing-file checks go through shared, batched, cached
  // loaders so many cards mounting at once don't each fire their own IPC.
  const previewPaths = isMulti
    ? imageFiles.slice(0, 4)
    : firstFile && isImageFile(firstFile)
      ? [firstFile]
      : [];
  const imagePreviews = useImagePreviews(previewPaths);
  const missingFiles = useMissingFiles(files);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (pinTimeoutRef.current) clearTimeout(pinTimeoutRef.current);
    };
  }, []);

  // Replace broken images in HTML preview with a styled placeholder
  useEffect(() => {
    const container = htmlPreviewRef.current;
    if (!container || entry.type !== "html") return;
    const imgs = container.querySelectorAll("img");
    const handlers: Array<[HTMLImageElement, () => void]> = [];
    for (const img of imgs) {
      const onError = () => {
        const placeholder = document.createElement("span");
        placeholder.className = "card-html-img-placeholder";
        placeholder.textContent = "Preview not available";
        img.replaceWith(placeholder);
      };
      // If the image already failed (cached failure), replace immediately
      if (img.complete && img.naturalWidth === 0 && img.src) {
        onError();
      } else {
        img.addEventListener("error", onError, { once: true });
        handlers.push([img, onError]);
      }
    }
    return () => {
      for (const [img, handler] of handlers) {
        img.removeEventListener("error", handler);
      }
    };
  }, [entry.type, entry.content]);

  const handleCopy = () => {
    onCopy(entry.id);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(
      () => setCopied(false),
      FEEDBACK_DURATION_MS,
    );
  };

  // Guarded rather than hidden: the type chip stays visible in select mode so
  // the card does not reflow, but clicking it there must pick the card, not
  // walk away from the selection.
  const handleView = () => {
    if (isSelecting) return;
    onView?.(entry.id);
  };

  // Nothing waits to find out whether a second click is coming, because the two
  // actions are not equally expensive to get wrong.
  //
  //  - Copying is the one with a side effect: it overwrites the OS clipboard.
  //    It is also the frequent one, so it fires on the first click, instantly.
  //    A double click then *adds* the viewer rather than replacing the copy -
  //    the entry you opened ends up on the clipboard, which is the price of a
  //    copy that never lags, and is usually what you wanted anyway.
  //  - Opening the viewer changes nothing and closes with Escape, so when it is
  //    the single-click action it can afford to wait for the double click that
  //    copies. A panel that appears 200ms later reads as an animation; a copy
  //    that lands 200ms later reads as a slow app.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  const handleCardClick = (e: React.MouseEvent) => {
    // In select mode, Shift+click for range selection
    if (isSelecting && e.shiftKey && onRangeSelect) {
      e.preventDefault();
      onRangeSelect(entry.id);
      return;
    }
    // In select mode, click toggles selection
    if (isSelecting && onToggleSelect) {
      onToggleSelect(entry.id);
      return;
    }

    if (clickAction === "copy") {
      // `detail` counts the clicks in this burst. Guarding on it keeps the
      // second half of a double click from copying the same entry twice.
      if (e.detail === 1) handleCopy();
      return;
    }

    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      handleView();
    }, DOUBLE_CLICK_GRACE_MS);
  };

  const handleCardDoubleClick = () => {
    if (isSelecting) return;
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    // In copy mode the copy already fired on the first click, so the double
    // click only has the viewer left to do.
    if (clickAction === "copy") handleView();
    else handleCopy();
  };

  const visibleImageThumbs = imageFiles.slice(0, 3);

  const displayKind = deriveDisplayKind(entry);
  const cardClasses = [
    "entry-card",
    copied && "entry-card--copied",
    isSelecting && "entry-card--selectable",
    isSelected && "entry-card--selected",
    isInClipboard && "entry-card--in-clipboard",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={cardRef}
      className={cardClasses}
      data-kind={displayKind}
      onClick={handleCardClick}
      onDoubleClick={handleCardDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // In multi-select mode, right-click shouldn't open menu
        if (isSelecting) return;
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Selection checkbox overlay */}
      {isSelecting && (
        <div className="entry-card-checkbox">
          <CheckIcon size={10} strokeWidth={3} />
        </div>
      )}
      {/*  Media preview (image/video)  */}
      {entry.type === "image" && (
        <div className="card-media">
          <img
            src={resolveImageSrc(entry.content, convertFileSrc)}
            alt="Copied image"
            className="card-media-img"
          />
        </div>
      )}
      {/* Multi-image file strip */}
      {entry.type === "file" &&
        isMulti &&
        imageFiles.filter((f) => !missingFiles.has(f)).length > 0 && (
          <div className="card-media card-media--multi">
            {visibleImageThumbs
              .filter((f) => !missingFiles.has(f))
              .map((f, i, arr) => {
                const nonMissingRemaining =
                  imageFiles.filter((ff) => !missingFiles.has(ff)).length -
                  arr.length;
                const isLast = i === arr.length - 1 && nonMissingRemaining > 0;
                return (
                  <div key={f} className="card-media-thumb">
                    {imagePreviews[f] ? (
                      <img
                        src={imagePreviews[f]!}
                        alt=""
                        className="card-thumb-img"
                      />
                    ) : (
                      <div className="card-thumb-placeholder" />
                    )}
                    {isLast && (
                      <div className="card-thumb-more">
                        +{nonMissingRemaining}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      {/* Single image file */}
      {entry.type === "file" &&
        !isMulti &&
        firstFile &&
        isImageFile(firstFile) &&
        !missingFiles.has(firstFile) && (
          <div className="card-media">
            <img
              src={imagePreviews[firstFile] ?? firstFileUrl}
              alt="Copied image file"
              className="card-media-img"
            />
          </div>
        )}
      {/* Single video file */}
      {entry.type === "file" &&
        !isMulti &&
        firstFile &&
        isVideoFile(firstFile) &&
        !missingFiles.has(firstFile) && (
          <div className="card-media">
            <VideoPlayer src={firstFileUrl} className="card-media-img" />
          </div>
        )}

      {/*  Card body  */}
      <div className="card-body">
        {entry.type === "image" && (
          <p className="card-text card-text--image-name">
            {imageDisplayName(entry)}
          </p>
        )}
        {entry.type === "text" && (
          <p className="card-text">
            {truncateText(entry.content, TEXT_PREVIEW_LENGTH)}
          </p>
        )}
        {entry.type === "html" && (
          <div
            ref={htmlPreviewRef}
            className="card-html-preview card-html-preview--faded"
            dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
          />
        )}
        {entry.type === "file" && !isMulti && (
          <p
            className={`card-text card-text--file${firstFile && missingFiles.has(firstFile) ? " card-text--missing" : ""}`}
          >
            <span
              {...(firstFile && missingFiles.has(firstFile)
                ? {
                    "data-tooltip": "File no longer exists on disk",
                    "data-tooltip-pos": "above",
                  }
                : {})}
            >
              {firstFile ? fileNameFromPath(firstFile) : "[File]"}
            </span>
            {firstFile && missingFiles.has(firstFile) && (
              <span
                className="card-missing-hint"
                data-tooltip="File no longer exists on disk"
              >
                missing
              </span>
            )}
          </p>
        )}
        {entry.type === "file" && isMulti && (
          <div className="card-file-preview">
            {files.slice(0, 3).map((f) => {
              const name = fileNameFromPath(f);
              const isImg = isImageFile(f);
              return (
                <span
                  key={f}
                  className={`card-file-preview-item${missingFiles.has(f) ? " card-file-preview-item--missing" : ""}`}
                >
                  {isImg ? ImageIcon : FileIcon}
                  <span
                    className="card-file-preview-name"
                    {...(missingFiles.has(f)
                      ? {
                          "data-tooltip": "File no longer exists on disk",
                          "data-tooltip-pos": "above",
                        }
                      : {})}
                  >
                    {name}
                  </span>
                  {missingFiles.has(f) && (
                    <span
                      className="card-missing-hint"
                      data-tooltip="File missing"
                    >
                      missing
                    </span>
                  )}
                </span>
              );
            })}
            {files.length > 3 && (
              <span className="card-file-preview-more">
                +{files.length - 3} more
              </span>
            )}
          </div>
        )}
        {/* Footer: type chip + pinned chip + timestamp */}
        <ChipBar
          entry={entry}
          syncState={syncState}
          entryGroups={entryGroups}
          displayGroups={displayGroups}
          isInClipboard={isInClipboard}
          isMulti={isMulti}
          files={files}
          imageFiles={imageFiles}
          onView={handleView}
          cardRef={cardRef}
          justPinned={justPinned}
          copied={copied}
          relTime={relTime}
          sharedSpaceNames={sharedSpaceNames}
          waitingSpaceNames={waitingSpaceNames}
          owner={owner}
        />
      </div>

      {/* Right-click context menu */}
      <CardMenu
        open={menuPos !== null}
        anchorX={menuPos?.x ?? 0}
        anchorY={menuPos?.y ?? 0}
        onClose={() => setMenuPos(null)}
        isPinned={entry.pinned}
        isSaved={entryGroups.includes("Saved")}
        copied={copied}
        onCopy={handleCopy}
        onDelete={() => onDelete(entry.id)}
        onPin={handlePin}
        onToggleSave={() => {
          if (!onSetGroups) return;
          const has = entryGroups.includes("Saved");
          const newGroups = has
            ? entryGroups.filter((g) => g !== "Saved")
            : [...entryGroups, "Saved"];
          onSetGroups(entry.id, newGroups);
        }}
        availableGroups={availableGroups}
        entryGroups={entryGroups}
        onToggleGroup={(group) => {
          if (!onSetGroups) return;
          const current = entryGroups;
          const newGroups = current.includes(group)
            ? current.filter((g) => g !== group)
            : [...current, group];
          onSetGroups(entry.id, newGroups);
        }}
        spaces={spaces}
        signedIn={signedIn}
        inCloud={inCloud}
        onToggleCloud={
          onToggleCloud ? (upload) => onToggleCloud(entry.id, upload) : undefined
        }
        itemSpaceIds={itemSpaceIds}
        onToggleSpace={
          onToggleSpace ? (spaceId) => onToggleSpace(entry.id, spaceId) : undefined
        }
        onView={onView ? handleView : undefined}
      />
    </div>
  );
};

// Memoised: with 1k+ entries mounted, an unmemoised card re-renders on every
// parent state change (search keystroke, select-mode toggle, active-id change).
// All callback props from the parent are useCallback-stable, so shallow prop
// comparison is safe and effective here.
export const EntryCard = React.memo(EntryCardImpl);
EntryCard.displayName = "EntryCard";

export default EntryCard;
