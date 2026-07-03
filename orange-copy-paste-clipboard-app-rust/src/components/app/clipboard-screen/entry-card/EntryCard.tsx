import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ClipboardEntry } from "../../../../types";
import {
  fileNameFromPath,
  filePaths,
  isImageFile,
  isVideoFile,
  truncateText,
  timeAgo,
  deriveDisplayKind,
  htmlFragment,
  imageDisplayName,
  resolveImageSrc,
} from "../../../../types";
import { ImageIcon, FileIcon } from "../../../entry-types/EntryTypePill";
import CardMenu from "../../card-menu/CardMenu";
import { CheckIcon } from "../../../icons";
import ChipBar from "./ChipBar";
import VideoPlayer from "./VideoPlayer";
import "./EntryCard.css";

const FEEDBACK_DURATION_MS = 1500;
const REL_TIME_REFRESH_MS = 15_000;
const TEXT_PREVIEW_LENGTH = 160;

// Allow-list based HTML sanitiser for safe rendering of rich-text clipboard
// content.  Strips all tags/attributes except a safe subset.
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "b",
  "i",
  "u",
  "em",
  "strong",
  "s",
  "sub",
  "sup",
  "span",
  "div",
  "a",
  "img",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "pre",
  "code",
  "hr",
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  span: new Set(["style"]),
  div: new Set(["style"]),
  p: new Set(["style"]),
};
// Only allow safe CSS properties in inline styles
const SAFE_STYLE_PROPS = new Set([
  "color",
  "background-color",
  "background",
  "font-weight",
  "font-style",
  "font-size",
  "text-decoration",
  "text-align",
  "margin",
  "padding",
  "border",
  "display",
]);

function sanitizeStyle(style: string): string {
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter((decl) => {
      const prop = decl.split(":")[0]?.trim().toLowerCase() ?? "";
      return SAFE_STYLE_PROPS.has(prop);
    })
    .join("; ");
}

function normalizeImageSrc(src: string): string | null {
  const value = src.trim();
  if (!value) return null;

  // Safe URI schemes that the webview can render directly.
  if (/^(https?:|data:|blob:|asset:)/i.test(value)) {
    return value;
  }

  // Convert file:// URLs (common in clipboard HTML fragments) to Tauri asset URLs.
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol.toLowerCase() !== "file:") return null;
      const pathname = decodeURIComponent(url.pathname || "");
      if (!pathname) return null;
      const windowsPath = /^[A-Za-z]:/.test(pathname.slice(1))
        ? pathname.slice(1)
        : pathname;
      const normalizedPath = windowsPath.replace(/\//g, "\\");
      return convertFileSrc(normalizedPath);
    } catch {
      return null;
    }
  }

  // Absolute Windows paths pasted directly into src.
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return convertFileSrc(value.replace(/\//g, "\\"));
  }

  return null;
}

function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      // Escape text content
      const text = node.textContent ?? "";
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    // Recurse into children
    let inner = "";
    for (const child of Array.from(el.childNodes)) {
      inner += walk(child);
    }

    if (!ALLOWED_TAGS.has(tag)) return inner; // strip tag but keep children

    // Build allowed attributes
    const allowedSet = ALLOWED_ATTRS[tag];
    let attrs = "";
    if (allowedSet) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (!allowedSet.has(name)) continue;
        let value = attr.value;
        // Prevent javascript: URIs
        if (
          (name === "href" || name === "src") &&
          /^\s*javascript:/i.test(value)
        )
          continue;
        // img src: normalize local file paths and keep only renderable schemes
        if (tag === "img" && name === "src") {
          const normalized = normalizeImageSrc(value);
          if (!normalized) continue;
          value = normalized;
        } else if (
          name === "src" &&
          !/^(https?:|data:|blob:|asset:)/i.test(value)
        ) {
          continue;
        }
        if (name === "style") value = sanitizeStyle(value);
        attrs += ` ${name}="${value.replace(/"/g, "&quot;")}"`;
      }
    }

    // Self-closing tags
    if (tag === "br" || tag === "hr" || tag === "img") {
      return `<${tag}${attrs} />`;
    }

    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  let result = "";
  for (const child of Array.from(doc.body.childNodes)) {
    result += walk(child);
  }
  return result;
}

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
  /** Whether this entry is currently in the OS clipboard. */
  isInClipboard?: boolean;
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
  isInClipboard = false,
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
  const [relTime, setRelTime] = useState(timeAgo(entry.timestamp));
  const [imagePreviews, setImagePreviews] = useState<
    Record<string, string | null>
  >({});
  const [showFileList, setShowFileList] = useState(false);
  const [missingFiles, setMissingFiles] = useState<Set<string>>(new Set());
  const [contentExpanded, setContentExpanded] = useState(false);
  const [htmlOverflows, setHtmlOverflows] = useState(false);
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

  // Load image previews for file entries (single or multi)
  useEffect(() => {
    if (entry.type !== "file") {
      setImagePreviews({});
      return;
    }
    const toLoad = isMulti
      ? imageFiles.slice(0, 4)
      : firstFile && isImageFile(firstFile)
        ? [firstFile]
        : [];
    if (toLoad.length === 0) {
      setImagePreviews({});
      return;
    }
    let active = true;
    Promise.all(
      toLoad.map((path) =>
        invoke<string | null>("get_image_file_preview", { path })
          .then((p) => [path, p] as const)
          .catch(() => [path, null] as const),
      ),
    ).then((results) => {
      if (active) setImagePreviews(Object.fromEntries(results));
    });
    return () => {
      active = false;
    };
  }, [entry.type, entry.content]);

  // Check whether referenced files still exist on disk
  useEffect(() => {
    if (entry.type !== "file" || files.length === 0) {
      setMissingFiles(new Set());
      return;
    }
    let active = true;
    invoke<string[]>("check_missing_files", { paths: files })
      .then((missing) => {
        if (active) setMissingFiles(new Set(missing));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [entry.type, entry.content]);

  useEffect(() => {
    const timer = setInterval(
      () => setRelTime(timeAgo(entry.timestamp)),
      REL_TIME_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [entry.timestamp]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (pinTimeoutRef.current) clearTimeout(pinTimeoutRef.current);
    };
  }, []);

  // Detect if HTML preview overflows its collapsed max-height
  useEffect(() => {
    const el = htmlPreviewRef.current;
    if (!el || entry.type !== "html") {
      setHtmlOverflows(false);
      return;
    }
    // Only measure overflow in collapsed state — when expanded,
    // scrollHeight === clientHeight so we'd lose the overflow flag.
    if (contentExpanded) return;
    const check = () => setHtmlOverflows(el.scrollHeight > el.clientHeight);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entry.type, entry.content, contentExpanded]);

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
  }, [entry.type, entry.content, contentExpanded]);

  // Reset expand state when entry changes
  useEffect(() => {
    setContentExpanded(false);
  }, [entry.id]);

  const handleCopy = () => {
    onCopy(entry.id);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(
      () => setCopied(false),
      FEEDBACK_DURATION_MS,
    );
  };

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
    // Normal click: copy
    handleCopy();
  };

  const visibleImageThumbs = imageFiles.slice(0, 3);

  const isTextExpandable =
    (entry.type === "text" || entry.type === "html") &&
    (entry.type === "text"
      ? entry.content.length > TEXT_PREVIEW_LENGTH
      : htmlOverflows);
  const isMediaExpandable =
    entry.type === "image" ||
    (entry.type === "file" &&
      !isMulti &&
      firstFile != null &&
      (isImageFile(firstFile) || isVideoFile(firstFile)) &&
      !missingFiles.has(firstFile));
  const isMultiFileExpandable = entry.type === "file" && isMulti;
  const isExpandable =
    isTextExpandable || isMediaExpandable || isMultiFileExpandable;

  const displayKind = deriveDisplayKind(entry);
  const cardClasses = [
    "entry-card",
    copied && "entry-card--copied",
    (showFileList || contentExpanded) && "entry-card--expanded",
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
            {contentExpanded
              ? entry.content
              : truncateText(entry.content, TEXT_PREVIEW_LENGTH)}
          </p>
        )}
        {entry.type === "html" && (
          <div
            ref={htmlPreviewRef}
            className={`card-html-preview${contentExpanded ? " card-html-preview--expanded" : ""}${!contentExpanded && htmlOverflows ? " card-html-preview--faded" : ""}`}
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
        {entry.type === "file" && isMulti && !showFileList && (
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
        {/* Expanded file list — sits above footer so button stays anchored at bottom */}
        {entry.type === "file" && isMulti && showFileList && (
          <div
            className={`card-file-list${imageFiles.some((f) => !missingFiles.has(f)) ? " card-file-list--bordered" : ""}`}
          >
            {files.map((f) => {
              const name = fileNameFromPath(f);
              const isImg = isImageFile(f);
              const isMissing = missingFiles.has(f);
              const preview = imagePreviews[f];
              return (
                <div
                  key={f}
                  className={`card-file-list-item${isMissing ? " card-file-list-item--missing" : ""}`}
                >
                  {isImg && !isMissing && (
                    <div className="card-file-thumb">
                      {preview ? (
                        <img
                          src={preview}
                          alt=""
                          className="card-file-thumb-img"
                        />
                      ) : (
                        <div className="card-file-thumb-placeholder" />
                      )}
                    </div>
                  )}
                  <span
                    className="card-file-name"
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
                </div>
              );
            })}
          </div>
        )}
        {/* Footer: type chip + pinned chip + timestamp */}
        <ChipBar
          entry={entry}
          entryGroups={entryGroups}
          displayGroups={displayGroups}
          isInClipboard={isInClipboard}
          isMulti={isMulti}
          files={files}
          imageFiles={imageFiles}
          showFileList={showFileList}
          setShowFileList={setShowFileList}
          contentExpanded={contentExpanded}
          setContentExpanded={setContentExpanded}
          isExpandable={isExpandable}
          cardRef={cardRef}
          justPinned={justPinned}
          copied={copied}
          relTime={relTime}
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
        isExpandable={isExpandable}
        isExpanded={isMultiFileExpandable ? showFileList : contentExpanded}
        onToggleExpand={() =>
          isMultiFileExpandable
            ? setShowFileList((v) => !v)
            : setContentExpanded((v) => !v)
        }
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
