/**
 * Reading one clipboard entry that was shared into a space.
 *
 * The Spaces feed opens an item the same way the clipboard screen opens an
 * entry, so this wears the clipboard viewer's body styles (the `cv-*` classes
 * in EntryViewer.css) and the shared toolbar's control styles. It is a separate
 * module rather than a call into EntryViewer because that viewer is wired to
 * actions this screen has no business offering - pin, delete, groups, cloud -
 * and a space item is read-only.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ClipboardEntry } from "../../../types";
import {
  fileNameFromPath,
  filePaths,
  htmlFragment,
  imageDisplayName,
  isImageFile,
  isVideoFile,
  resolveImageSrc,
} from "../../../types";
import { sanitizeHtml } from "../clipboard-screen/sanitize-html";
import { FileEntryList } from "../../entry-types/FileEntryList";
import VideoPlayer from "../clipboard-screen/entry-card/VideoPlayer";
import {
  TEXT_ZOOM_STEPS,
  ToolbarZoom,
  stepZoom,
} from "../view-toolbar/ViewToolbar";
import {
  useImagePreviews,
  useMissingFiles,
} from "../../../hooks/useFileMeta";
// The bodies wear the clipboard viewer's classes, so an entry looks the same
// here as it does there. Importing its stylesheet is what keeps that true
// rather than approximately true.
import "../clipboard-screen/entry-viewer/EntryViewer.css";

/** Zoom stops for a picture: a multiple of the file's own pixels, so this range
 *  goes far past anything you would read text at. The text stops are the shared
 *  bar's, since every reading screen holds text to the same sizes. */
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

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
export function absoluteTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// -- Bodies, one per kind ----------------------------------------------

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

// -- How the entry is being looked at ---------------------------------

export interface EntryView {
  /** A picture is the content, not an illustration of it, so it gets the whole
   *  panel rather than the measure the text bodies are held to. */
  isMedia: boolean;
  paths: string[];
  facts: string[];
  /** Whether this kind of entry has a second way of being shown at all. */
  hasAlt: boolean;
  alt: boolean;
  toggleAlt: () => void;
  altLabel: string;
  altTooltip: string;
  /** Which zoom, if any, the toolbar control drives. A list of file rows has
   *  nothing to zoom. */
  zoomKind: "image" | "text" | null;
  zoomLabel: string;
  atDefault: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  imageZoom: number | null;
  textZoom: number;
}

/** The reading state for one entry: which of the two views is showing, and at
 *  what size. */
export function useEntryView(entry: ClipboardEntry): EntryView {
  // Rich text gets a source view, plain text a wrap switch. One slot in the
  // toolbar, whichever applies.
  const [alt, setAlt] = useState(false);
  // Two zooms, because they answer different questions. An image zoom is a
  // multiple of the file's own pixels and starts at "fit the window"; a text
  // zoom is a reading size and starts at 100%.
  const [imageZoom, setImageZoom] = useState<number | null>(null);
  const [textZoom, setTextZoom] = useState(1);

  const paths = entry.type === "file" ? filePaths(entry.content) : [];
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
  const altTooltip =
    entry.type === "html"
      ? "Switch between the rendered page and its markup"
      : "Switch line wrapping";

  const zoomKind: "image" | "text" | null = isMedia
    ? "image"
    : entry.type === "text" || entry.type === "html"
      ? "text"
      : null;

  const zoomLabel =
    zoomKind === "image"
      ? imageZoom === null
        ? "Fit"
        : `${Math.round(imageZoom * 100)}%`
      : `${Math.round(textZoom * 100)}%`;

  const stepImage = (dir: 1 | -1) =>
    setImageZoom((z) =>
      z === null ? (dir === 1 ? 1 : 0.5) : stepZoom(ZOOM_STEPS, z, dir),
    );

  return {
    isMedia,
    paths,
    facts: entryFacts(entry),
    hasAlt,
    alt,
    toggleAlt: () => setAlt((v) => !v),
    altLabel,
    altTooltip,
    zoomKind,
    zoomLabel,
    atDefault: zoomKind === "image" ? imageZoom === null : textZoom === 1,
    zoomIn: () =>
      zoomKind === "image"
        ? stepImage(1)
        : setTextZoom((z) => stepZoom(TEXT_ZOOM_STEPS, z, 1)),
    zoomOut: () =>
      zoomKind === "image"
        ? stepImage(-1)
        : setTextZoom((z) => stepZoom(TEXT_ZOOM_STEPS, z, -1)),
    zoomReset: () =>
      zoomKind === "image" ? setImageZoom(null) : setTextZoom(1),
    imageZoom,
    textZoom,
  };
}

/** The view switches, for the left of a panel's action bar: how you are
 *  looking at the entry, before the thing you came to do. */
export const EntryViewControls: React.FC<{ view: EntryView }> = ({ view }) => (
  <>
    {view.hasAlt && (
      <button
        className="vt-btn vt-btn--ghost"
        onClick={view.toggleAlt}
        aria-pressed={view.alt}
        data-tooltip={view.altTooltip}
        data-tooltip-pos="below"
      >
        {view.altLabel}
      </button>
    )}

    {view.hasAlt && view.zoomKind && (
      <span className="vt-sep" aria-hidden="true" />
    )}

    {view.zoomKind && (
      <ToolbarZoom
        label={view.zoomLabel}
        atDefault={view.atDefault}
        resetTooltip={
          view.zoomKind === "image" ? "Reset to fit" : "Reset to 100%"
        }
        onIn={view.zoomIn}
        onOut={view.zoomOut}
        onReset={view.zoomReset}
      />
    )}
  </>
);

/** The entry itself, at the chosen view and size. */
export const EntryBody: React.FC<{
  entry: ClipboardEntry;
  view: EntryView;
}> = ({ entry, view }) => (
  <>
    {entry.type === "text" && (
      <TextBody content={entry.content} wrap={!view.alt} scale={view.textZoom} />
    )}
    {entry.type === "html" && (
      <HtmlBody
        content={entry.content}
        source={view.alt}
        scale={view.textZoom}
      />
    )}
    {entry.type === "image" && (
      <ImageBody
        src={resolveImageSrc(entry.content, convertFileSrc)}
        alt={imageDisplayName(entry)}
        caption={imageDisplayName(entry)}
        zoom={view.imageZoom}
      />
    )}
    {entry.type === "file" && (
      <FileBody paths={view.paths} zoom={view.imageZoom} />
    )}
  </>
);

/**
 * Escape closes, Ctrl+C copies the whole entry, Ctrl +/-/0 zoom it.
 *
 * The webview's own zoom would scale the whole window, chrome and all; these
 * scale the entry, which is what somebody pressing Ctrl and plus on a reading
 * screen is asking for. Ctrl+C only takes the entry when nothing is selected,
 * or highlighting a few words to quote would put the whole thing on the
 * clipboard instead.
 *
 * `blocked` is for a menu that has its own Escape: without it one Escape would
 * close the menu and the whole panel, taking the screen away when the user only
 * meant to dismiss the menu.
 */
export function useEntryViewKeys(opts: {
  view: EntryView;
  onClose: () => void;
  onCopy: () => void;
  blocked: boolean;
}) {
  // Read through a ref so neither the menu nor a zoom step tears down and
  // rebuilds the listener.
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { view, onClose, onCopy, blocked } = ref.current;
      if (blocked) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "c") {
        if (window.getSelection()?.toString()) return;
        onCopy();
        return;
      }
      if (!view.zoomKind) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        view.zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        view.zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        view.zoomReset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** A copy button's "Copied" flash, shared so the panels agree on how long it
 *  lasts. */
export function useCopyFlash(onCopy: () => void, ms = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fire = useCallback(() => {
    onCopy();
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), ms);
  }, [onCopy, ms]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { copied, fire };
}
