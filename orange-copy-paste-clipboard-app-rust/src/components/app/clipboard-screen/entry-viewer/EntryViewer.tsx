/**
 * The full view of one clipboard entry.
 *
 * Replaces the grid rather than floating over it, the same way the Spaces
 * screen shows an item, so the whole window is available for reading. Cards
 * carry a fixed short preview and nothing else - this is the only place an
 * entry is shown whole, which is why it can afford real typography, a source
 * view for rich text, and file rows with thumbnails.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ClipboardEntry, Space } from "../../../../types";
import {
  deriveDisplayKind,
  fileNameFromPath,
  filePaths,
  htmlFragment,
  imageDisplayName,
  isImageFile,
  isVideoFile,
  resolveImageSrc,
} from "../../../../types";
import { groupColor } from "../../../../types";
import { sanitizeHtml } from "../sanitize-html";
import type { EntrySyncState } from "../../../../hooks/useEntrySyncStates";
import type { EntryOwner } from "../../../../hooks/useEntryOwners";
import OwnerChip from "../entry-card/OwnerChip";
import CardMenu from "../../card-menu/CardMenu";
import {
  EntryTypePill,
  PinIcon,
  SaveIcon,
} from "../../../entry-types/EntryTypePill";
import { FileEntryList } from "../../../entry-types/FileEntryList";
import {
  CheckIcon,
  CopyIcon,
  ChevronRightIcon,
  ClipboardIcon,
} from "../../../icons";
import {
  ShareNetwork,
  CloudCheck,
  CloudArrowUp,
  DotsThree,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
} from "@phosphor-icons/react";
import VideoPlayer from "../entry-card/VideoPlayer";
import {
  useImagePreviews,
  useMissingFiles,
} from "../../../../hooks/useFileMeta";
import { useRelativeTime } from "../../../../hooks/useRelativeTime";
// The chips below deliberately wear the card's classes, so this screen and the
// cards cannot drift apart. Importing the card stylesheet is what makes that
// true rather than approximately true.
import "../entry-card/EntryCard.css";
import "./EntryViewer.css";

const COPIED_FEEDBACK_MS = 1600;

/** Zoom stops. Coarse on purpose: a zoom control that needs eight presses to
 *  get anywhere is a slider wearing the wrong clothes. */
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
/** Text is read, not inspected, so it stops well short of the image range. */
const TEXT_ZOOM_STEPS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

/** The next stop above or below `from`, or `from` itself at either end. */
function stepZoom(steps: number[], from: number, dir: 1 | -1): number {
  const i = steps.indexOf(from);
  if (i === -1) return dir === 1 ? steps[steps.length - 1] : steps[0];
  return steps[Math.min(steps.length - 1, Math.max(0, i + dir))];
}

/** What the toolbar says about the entry, to the right of the type pill. */
function entryFacts(entry: ClipboardEntry): string[] {
  if (entry.type === "text" || entry.type === "html") {
    const lines = entry.content.split("\n").length;
    const chars = entry.content.length;
    return [
      `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}`,
      `${chars.toLocaleString()} ${chars === 1 ? "character" : "characters"}`,
    ];
  }
  if (entry.type === "file") {
    const n = filePaths(entry.content).length;
    return [`${n} ${n === 1 ? "file" : "files"}`];
  }
  return [];
}

/** The exact moment, spelled out. The toolbar already carries the relative
 *  time; this is the one that answers "which of these two did I copy first". */
function absoluteTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Bodies, one per kind ──────────────────────────────────────────────

const TextBody: React.FC<{
  content: string;
  wrap: boolean;
  scale: number;
}> = ({ content, wrap, scale }) => (
  <pre
    className={`cv-text${wrap ? "" : " cv-text--nowrap"}`}
    style={scale === 1 ? undefined : { fontSize: `${12.5 * scale}px` }}
  >
    {content}
  </pre>
);

const HtmlBody: React.FC<{
  content: string;
  source: boolean;
  scale: number;
}> = ({ content, source, scale }) => {
  const html = useMemo(() => sanitizeHtml(htmlFragment(content)), [content]);
  if (source) {
    return (
      <pre
        className="cv-text"
        style={scale === 1 ? undefined : { fontSize: `${12.5 * scale}px` }}
      >
        {htmlFragment(content)}
      </pre>
    );
  }
  return (
    <div
      className="cv-html"
      style={scale === 1 ? undefined : { fontSize: `${13.5 * scale}px` }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

/**
 * A picture at a chosen size.
 *
 * `zoom` is a multiple of the file's own pixels, so 100% really is one image
 * pixel per screen pixel. `null` means fit the window, which is a different
 * kind of answer and so is not a number on the same scale.
 */
const ImageBody: React.FC<{
  src: string;
  alt: string;
  caption: string;
  zoom: number | null;
}> = ({ src, alt, caption, zoom }) => {
  const [natural, setNatural] = useState<number | null>(null);
  return (
    <div className="cv-media">
      <img
        src={src}
        alt={alt}
        className={`cv-media-img${zoom === null ? "" : " cv-media-img--zoomed"}`}
        onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
        style={
          zoom !== null && natural
            ? { width: `${Math.round(natural * zoom)}px` }
            : undefined
        }
      />
      <p className="cv-media-caption">{caption}</p>
    </div>
  );
};

const FileBody: React.FC<{ paths: string[]; zoom: number | null }> = ({
  paths,
  zoom,
}) => {
  // Cap the thumbnail fetch: a paste of several hundred images should not fire
  // several hundred previews for rows most of which are below the fold.
  const previews = useImagePreviews(paths.filter(isImageFile).slice(0, 40));
  const missing = useMissingFiles(paths);
  const single = paths.length === 1 ? paths[0] : null;

  // One file that is an image or a video is worth showing, not listing.
  if (
    single &&
    !missing.has(single) &&
    (isImageFile(single) || isVideoFile(single))
  ) {
    if (isImageFile(single)) {
      return (
        <ImageBody
          src={previews[single] ?? convertFileSrc(single)}
          alt={fileNameFromPath(single)}
          caption={fileNameFromPath(single)}
          zoom={zoom}
        />
      );
    }
    return (
      <div className="cv-media">
        <VideoPlayer src={convertFileSrc(single)} className="cv-media-img" />
        <p className="cv-media-caption">{fileNameFromPath(single)}</p>
      </div>
    );
  }

  return <FileEntryList paths={paths} />;
};

// ── The panel ─────────────────────────────────────────────────────────

const EntryViewer: React.FC<{
  entry: ClipboardEntry;
  onClose: () => void;
  onCopy: (id: string) => void;
  /** Whether this entry is what the OS clipboard currently holds. */
  isInClipboard?: boolean;
  /** Cloud badge state, when the badges are switched on. */
  syncState?: EntrySyncState;
  /** Set only when the entry arrived from another member of a space. */
  owner?: EntryOwner;
  /** Spaces this entry is shared into, by name. */
  sharedSpaceNames?: string[];
  /** Of those, the ones still waiting on a key. */
  waitingSpaceNames?: string[];
  onDelete: (id: string) => void;
  onPin: (id: string, shouldPin: boolean) => Promise<boolean>;
  onSetGroups?: (id: string, groups: string[]) => void;
  availableGroups?: string[];
  /** Spaces this account belongs to, for the share submenu. */
  spaces?: Space[];
  signedIn?: boolean;
  itemSpaceIds?: string[];
  onToggleSpace?: (spaceId: string) => void;
  /** Whether a copy of this entry exists on the server. */
  inCloud?: boolean;
  onToggleCloud?: (upload: boolean) => void;
}> = ({
  entry,
  onClose,
  onCopy,
  isInClipboard = false,
  syncState,
  owner,
  sharedSpaceNames = [],
  waitingSpaceNames = [],
  onDelete,
  onPin,
  onSetGroups,
  availableGroups = [],
  spaces,
  signedIn,
  itemSpaceIds,
  onToggleSpace,
  inCloud,
  onToggleCloud,
}) => {
  const [copied, setCopied] = useState(false);
  // Rich text gets a source view, plain text a wrap switch, images an
  // actual-size switch. One slot in the toolbar, whichever applies.
  const [alt, setAlt] = useState(false);
  // Two zooms, because they answer different questions. An image zoom is a
  // multiple of the file's own pixels and starts at "fit the window"; a text
  // zoom is a reading size and starts at 100%.
  const [imageZoom, setImageZoom] = useState<number | null>(null);
  // Whether the current image zoom was reached with the +/- magnifier rather
  // than the Fit/Original mode button. It decides only what the level reads:
  // the magnifier shows a percentage, the mode button reads "Fit" or
  // "Original". Both can land on 1x, which is then "Original" or "100%".
  const [imageStepped, setImageStepped] = useState(false);
  const [textZoom, setTextZoom] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relTime = useRelativeTime(entry.timestamp, `clipboard:${entry.id}`);
  const facts = entryFacts(entry);
  const paths = entry.type === "file" ? filePaths(entry.content) : [];
  // "Saved" is a group in the data and a star in the UI, so it is shown as the
  // star and kept out of the chips - the same split the card makes.
  const isSaved = entry.groups.includes("Saved");
  const displayGroups = entry.groups.filter((g) => g !== "Saved");
  // The overflow menu is the card's own CardMenu, anchored under the button
  // rather than at a cursor position - it is opened by a click on a control,
  // not by a right click on a card.
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // CardMenu dismisses itself on any mousedown outside it, which includes the
  // mousedown half of a click on this very button. Without this the button
  // could open the menu but never close it: the menu would shut on mousedown
  // and the click would immediately reopen it.
  const closedAt = useRef(0);
  const closeMenu = useCallback(() => {
    closedAt.current = Date.now();
    setMenuPos(null);
  }, []);
  const openMenu = () => {
    if (Date.now() - closedAt.current < 250) return;
    const r = moreRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ x: r.left, y: r.bottom + 4 });
  };

  const handleCopy = useCallback(() => {
    onCopy(entry.id);
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }, [entry.id, onCopy]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Read through refs so neither the menu nor the zoom tears down and rebuilds
  // the key listener below on every change.
  const menuPosRef = useRef(menuPos);
  menuPosRef.current = menuPos;
  const zoomRef = useRef<{
    in: () => void;
    out: () => void;
    reset: () => void;
  } | null>(null);

  // Escape closes, and Ctrl+C with nothing selected copies the whole entry.
  // With a selection it stays the webview's own copy, or highlighting a few
  // words to quote would put the entire entry on the clipboard instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The menu has its own Escape. Closing both at once would take the whole
      // screen away when the user only meant to dismiss the menu.
      if (menuPosRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "c") {
          if (window.getSelection()?.toString()) return;
          handleCopy();
          return;
        }
        // The webview's own zoom would scale the whole window, chrome and all.
        // These scale the entry, which is what somebody pressing Ctrl and plus
        // on this screen is asking for.
        if (!zoomRef.current) return;
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          zoomRef.current.in();
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          zoomRef.current.out();
        } else if (e.key === "0") {
          e.preventDefault();
          zoomRef.current.reset();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, handleCopy]);

  // A picture is the content, not an illustration of it, so it gets the panel
  // rather than the measure the text bodies are held to.
  const isMedia =
    entry.type === "image" ||
    (entry.type === "file" &&
      paths.length === 1 &&
      (isImageFile(paths[0]) || isVideoFile(paths[0])));

  const hasAlt = entry.type === "html" || entry.type === "text";
  const altLabel =
    entry.type === "html"
      ? alt
        ? "Rendered"
        : "Source"
      : alt
        ? "Wrap"
        : "No wrap";

  // Which zoom, if any, the control on the toolbar drives. Rendered rich text
  // and plain text scale their type; pictures scale themselves. A list of file
  // rows has nothing to zoom.
  const zoomKind: "image" | "text" | null = isMedia
    ? "image"
    : entry.type === "text" || entry.type === "html"
      ? "text"
      : null;

  const zoomLabel =
    zoomKind === "image"
      ? imageZoom === null
        ? "Fit"
        : !imageStepped && imageZoom === 1
          ? "Original"
          : `${Math.round(imageZoom * 100)}%`
      : `${Math.round(textZoom * 100)}%`;

  // The magnifier owns the percentage readout, so every step marks the zoom as
  // stepped - even one that lands on 1x, which then reads "100%", not
  // "Original". Leaving Fit lands on a concrete stop: in at 100%, out at 50%.
  const stepImage = (dir: 1 | -1) => {
    setImageStepped(true);
    setImageZoom((z) =>
      z === null
        ? dir === 1
          ? 1
          : 0.5
        : stepZoom(ZOOM_STEPS, z, dir),
    );
  };
  const zoomIn = () =>
    zoomKind === "image"
      ? stepImage(1)
      : setTextZoom((z) => stepZoom(TEXT_ZOOM_STEPS, z, 1));
  const zoomOut = () =>
    zoomKind === "image"
      ? stepImage(-1)
      : setTextZoom((z) => stepZoom(TEXT_ZOOM_STEPS, z, -1));
  // Ctrl+0 goes to Fit for an image, 100% for text.
  const zoomReset = () => {
    if (zoomKind === "image") {
      setImageStepped(false);
      setImageZoom(null);
    } else {
      setTextZoom(1);
    }
  };
  // The center button is the mode switch: Fit (the window) and Original (the
  // file's own pixels) are the two named stops beside the magnifier's
  // percentages. From any stepped zoom it returns to Fit. Clearing
  // `imageStepped` is what makes the level read the mode word, not a percentage.
  const zoomToggle = () => {
    if (zoomKind === "image") {
      setImageStepped(false);
      setImageZoom((z) => (z === null ? 1 : null));
    } else {
      setTextZoom(1);
    }
  };
  const atDefault =
    zoomKind === "image" ? imageZoom === null : textZoom === 1;
  const zoomLevelTip =
    zoomKind === "image"
      ? imageZoom === null
        ? "Show at original size"
        : "Fit to window"
      : "Reset to 100%";

  zoomRef.current = zoomKind
    ? { in: zoomIn, out: zoomOut, reset: zoomReset }
    : null;

  return (
    <div className="cv-panel">
      <div className="cv-toolbar">
        <button className="cv-back" onClick={onClose}>
          <ChevronRightIcon className="cv-back-chevron" />
          Back
        </button>

        <div className="cv-toolbar-meta">
          {facts.map((f) => (
            <span key={f} className="cv-fact">
              {f}
            </span>
          ))}
          <span className="cv-fact">
            {absoluteTime(entry.timestamp)} ({relTime})
          </span>
        </div>

        {/* Two things and a door: how you are looking at the entry, the thing
            you came to do, and the menu holding everything else. Pin, Save and
            Delete all live in that menu - putting them out here as well would
            be a second place to learn for no reach they do not already have. */}
        <div className="cv-toolbar-actions">
          {hasAlt && (
            <button
              className="cv-btn cv-btn--ghost"
              onClick={() => setAlt((v) => !v)}
              aria-pressed={alt}
              data-tooltip={
                entry.type === "html"
                  ? "Switch between the rendered page and its markup"
                  : entry.type === "image"
                    ? "Switch between fitting the window and full size"
                    : "Switch line wrapping"
              }
              data-tooltip-pos="below"
            >
              {altLabel}
            </button>
          )}

          {hasAlt && zoomKind && (
            <span className="cv-btn-sep" aria-hidden="true" />
          )}

          {zoomKind && (
            <div className="cv-zoom" role="group" aria-label="Zoom">
              <button
                className="cv-btn cv-btn--icon cv-zoom-step"
                onClick={zoomOut}
                aria-label="Zoom out"
                data-tooltip="Zoom out"
                data-tooltip-pos="below"
              >
                <MagnifyingGlassMinus size={13} />
              </button>
              <button
                className={`cv-btn cv-zoom-level${atDefault ? "" : " cv-btn--on"}`}
                onClick={zoomToggle}
                aria-label={`Zoom ${zoomLabel}. ${zoomLevelTip}.`}
                data-tooltip={zoomLevelTip}
                data-tooltip-pos="below"
              >
                {zoomLabel}
              </button>
              <button
                className="cv-btn cv-btn--icon cv-zoom-step"
                onClick={zoomIn}
                aria-label="Zoom in"
                data-tooltip="Zoom in"
                data-tooltip-pos="below"
              >
                <MagnifyingGlassPlus size={13} />
              </button>
            </div>
          )}

          <span className="cv-btn-sep" aria-hidden="true" />

          <button
            className={`cv-btn cv-btn--primary${copied ? " cv-btn--done" : ""}`}
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <CheckIcon size={11} strokeWidth={3} /> Copied
              </>
            ) : (
              <>
                <CopyIcon size={12} /> Copy
              </>
            )}
          </button>

          {/* The rest of the right-click menu, unchanged and in one piece.
              Rebuilding those rows here is how the two would drift apart. */}
          <button
            ref={moreRef}
            className={`cv-btn cv-btn--icon${menuPos ? " cv-btn--on" : ""}`}
            onClick={openMenu}
            aria-haspopup="menu"
            aria-expanded={menuPos !== null}
            aria-label="More actions"
            data-tooltip="More actions"
            data-tooltip-pos="below"
          >
            <DotsThree size={16} weight="bold" />
          </button>
        </div>
      </div>

      {/* Everything the card's chip bar has to drop for want of room. Same
          chips, same colours - the card hides what does not fit, and here
          nothing is hidden. */}
      <div className="cv-meta">
        <EntryTypePill kind={deriveDisplayKind(entry)} count={paths.length} />
        {entry.pinned && (
          <span className="card-type-chip card-type-chip--pinned">
            {PinIcon}
            <span className="card-type-label">Pinned</span>
          </span>
        )}
        {isSaved && (
          <span className="card-type-chip card-type-chip--saved">
            {SaveIcon}
            <span className="card-type-label">Saved</span>
          </span>
        )}
        {isInClipboard && (
          <span className="card-type-chip card-type-chip--in-clipboard">
            <ClipboardIcon size={9} strokeWidth={2.5} />
            <span className="card-type-label">In clipboard</span>
          </span>
        )}
        {owner && <OwnerChip owner={owner} />}
        {displayGroups.map((g) => {
          const gc = groupColor(g);
          return (
            <span
              key={g}
              className="card-type-chip card-type-chip--group"
              style={{ background: gc.bg, color: gc.fg }}
            >
              <span className="card-group-dot" />
              <span className="card-type-label">{g}</span>
            </span>
          );
        })}
        {sharedSpaceNames.map((name) => (
          <span
            key={name}
            className={`card-type-chip cv-chip--shared${waitingSpaceNames.includes(name) ? " cv-chip--waiting" : ""}`}
          >
            <ShareNetwork size={9} weight="bold" />
            <span className="card-type-label">
              {waitingSpaceNames.includes(name) ? `${name} (no key yet)` : name}
            </span>
          </span>
        ))}
        {syncState === "synced" && (
          <span className="card-type-chip cv-chip--synced">
            <CloudCheck size={10} weight="bold" />
            <span className="card-type-label">Synced</span>
          </span>
        )}
        {syncState === "pending" && (
          <span className="card-type-chip cv-chip--pending">
            <CloudArrowUp size={10} weight="bold" />
            <span className="card-type-label">Waiting to upload</span>
          </span>
        )}
      </div>

      <div className={`cv-scroll${isMedia ? " cv-scroll--media" : ""}`}>
        {entry.type === "text" && (
          <TextBody content={entry.content} wrap={!alt} scale={textZoom} />
        )}
        {entry.type === "html" && (
          <HtmlBody content={entry.content} source={alt} scale={textZoom} />
        )}
        {entry.type === "image" && (
          <ImageBody
            src={resolveImageSrc(entry.content, convertFileSrc)}
            alt={imageDisplayName(entry)}
            caption={imageDisplayName(entry)}
            zoom={imageZoom}
          />
        )}
        {entry.type === "file" && (
          <FileBody paths={paths} zoom={imageZoom} />
        )}
      </div>

      <CardMenu
        open={menuPos !== null}
        anchorX={menuPos?.x ?? 0}
        anchorY={menuPos?.y ?? 0}
        onClose={closeMenu}
        isPinned={entry.pinned}
        isSaved={isSaved}
        copied={copied}
        onCopy={handleCopy}
        onDelete={() => onDelete(entry.id)}
        onPin={(shouldPin) => void onPin(entry.id, shouldPin)}
        onToggleSave={() => {
          if (!onSetGroups) return;
          onSetGroups(
            entry.id,
            isSaved
              ? entry.groups.filter((g) => g !== "Saved")
              : [...entry.groups, "Saved"],
          );
        }}
        availableGroups={availableGroups}
        entryGroups={entry.groups}
        onToggleGroup={(group) => {
          if (!onSetGroups) return;
          onSetGroups(
            entry.id,
            entry.groups.includes(group)
              ? entry.groups.filter((g) => g !== group)
              : [...entry.groups, group],
          );
        }}
        spaces={spaces}
        signedIn={signedIn}
        itemSpaceIds={itemSpaceIds}
        onToggleSpace={onToggleSpace}
        inCloud={inCloud}
        onToggleCloud={onToggleCloud}
      />
    </div>
  );
};

export default EntryViewer;
