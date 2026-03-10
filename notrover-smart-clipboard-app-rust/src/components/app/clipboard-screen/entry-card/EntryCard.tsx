import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ClipboardEntry } from "../../../../types";
import {
  filePaths,
  isImageFile,
  isVideoFile,
  truncateText,
  timeAgo,
  deriveDisplayKind,
  groupColor,
  htmlFragment,
} from "../../../../types";
import {
  ImageIcon,
  FileIcon,
  PinIcon,
  SaveIcon,
  EntryTypePill,
} from "../../../entry-types/EntryTypePill";
import CardMenu from "../../card-menu/CardMenu";
import { ChevronDownIcon, CheckIcon } from "../../../icons";
import VideoPlayer from "./VideoPlayer";
import "./EntryCard.css";

const FEEDBACK_DURATION_MS = 1500;
const REL_TIME_REFRESH_MS = 15_000;
const CHIP_GAP_PX = 4;

// Allow-list based HTML sanitiser for safe rendering of rich-text clipboard
// content.  Strips all tags/attributes except a safe subset.
const ALLOWED_TAGS = new Set([
  "p", "br", "b", "i", "u", "em", "strong", "s", "sub", "sup",
  "span", "div", "a", "img", "ul", "ol", "li", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody",
  "tr", "th", "td", "pre", "code", "hr",
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
  "color", "background-color", "background", "font-weight",
  "font-style", "font-size", "text-decoration", "text-align",
  "margin", "padding", "border", "display",
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
        if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) continue;
        // img src: only allow http(s) and data URIs
        if (name === "src" && !/^(https?:|data:image\/)/i.test(value)) continue;
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

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
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
}

export const EntryCard: React.FC<EntryCardProps> = ({
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
  const [showHiddenGroups, setShowHiddenGroups] = useState(false);
  const [visibleGroupCount, setVisibleGroupCount] = useState(0);

  const files = entry.type === "file" ? filePaths(entry.content) : [];
  const firstFile = files[0] ?? null;
  const firstFileUrl = firstFile ? convertFileSrc(firstFile) : "";
  const imageFiles = files.filter(isImageFile);
  const isMulti = files.length > 1;
  const entryGroups = entry.groups ?? [];
  const displayGroups = entryGroups.filter((g) => g !== "Saved");
  const footerChipsRef = useRef<HTMLDivElement>(null);
  const groupMeasureRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const typeMeasureRef = useRef<HTMLElement | null>(null);
  const pinMeasureRef = useRef<HTMLSpanElement | null>(null);
  const savedMeasureRef = useRef<HTMLSpanElement | null>(null);
  const overflowMeasureRef = useRef<HTMLButtonElement | null>(null);

  const visibleGroups = displayGroups.slice(0, visibleGroupCount);
  const hiddenGroups = displayGroups.slice(visibleGroupCount);
  const hiddenGroupCount = hiddenGroups.length;

  const measureVisibleGroupCount = useCallback(() => {
    const chipContainer = footerChipsRef.current;
    if (!chipContainer) {
      return;
    }

    const containerWidth = chipContainer.clientWidth;
    if (containerWidth <= 0) {
      setVisibleGroupCount(0);
      return;
    }

    const widthOf = (node: Element | null): number =>
      node ? Math.ceil(node.getBoundingClientRect().width) : 0;

    const baseChipWidths: number[] = [];
    const typeWidth = widthOf(typeMeasureRef.current);
    if (typeWidth > 0) baseChipWidths.push(typeWidth);
    if (entry.pinned) {
      const pinWidth = widthOf(pinMeasureRef.current);
      if (pinWidth > 0) baseChipWidths.push(pinWidth);
    }
    if (entryGroups.includes("Saved")) {
      const savedWidth = widthOf(savedMeasureRef.current);
      if (savedWidth > 0) baseChipWidths.push(savedWidth);
    }

    let usedWidth = 0;
    let chipCount = 0;
    for (const width of baseChipWidths) {
      if (chipCount > 0) usedWidth += CHIP_GAP_PX;
      usedWidth += width;
      chipCount += 1;
    }

    const groupWidths = displayGroups.map((_, i) => widthOf(groupMeasureRefs.current[i]));
    let fitCount = 0;

    for (const width of groupWidths) {
      if (width <= 0) continue;
      const nextWidth = usedWidth + (chipCount > 0 ? CHIP_GAP_PX : 0) + width;
      if (nextWidth > containerWidth) break;
      usedWidth = nextWidth;
      chipCount += 1;
      fitCount += 1;
    }

    const remaining = displayGroups.length - fitCount;
    if (remaining > 0) {
      const overflowWidth = widthOf(overflowMeasureRef.current);
      const overflowWithGap = (chipCount > 0 ? CHIP_GAP_PX : 0) + overflowWidth;

      while (fitCount > 0 && usedWidth + overflowWithGap > containerWidth) {
        const removedWidth = groupWidths[fitCount - 1] ?? 0;
        usedWidth -= removedWidth;
        chipCount -= 1;
        if (chipCount > 0) usedWidth -= CHIP_GAP_PX;
        fitCount -= 1;
      }
    }

    setVisibleGroupCount(Math.max(0, Math.min(fitCount, displayGroups.length)));
  }, [displayGroups, entry.pinned, entryGroups]);

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
    invoke<string[]>("check_missing_files", { paths: files }).then((missing) => {
      if (active) setMissingFiles(new Set(missing));
    }).catch(() => {});
    return () => { active = false; };
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

  useEffect(() => {
    setShowHiddenGroups(false);
  }, [entry.id, hiddenGroupCount]);

  useLayoutEffect(() => {
    measureVisibleGroupCount();
  }, [measureVisibleGroupCount, relTime, entry.id]);

  useEffect(() => {
    const target = footerChipsRef.current;
    if (!target || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => {
      measureVisibleGroupCount();
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [measureVisibleGroupCount]);

  useEffect(() => {
    if (!showHiddenGroups) return;
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setShowHiddenGroups(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [showHiddenGroups]);

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
  const remainingImageThumbs = imageFiles.length - visibleImageThumbs.length;

  const renderTypeChip = (withMeasureRef = false) => {
    if (entry.type === "file" && isMulti) {
      return (
        <button
          ref={withMeasureRef ? (typeMeasureRef as React.Ref<HTMLButtonElement>) : undefined}
          className={`card-type-chip card-type-chip--file card-type-chip--clickable${showFileList ? " open" : ""}`}
          onClick={
            withMeasureRef
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  setShowFileList((v) => !v);
                }
          }
          data-tooltip={
            withMeasureRef
              ? undefined
              : showFileList
                ? "Collapse"
                : `Show ${files.length} ${imageFiles.length === files.length ? "images" : "files"}`
          }
        >
          {imageFiles.length === files.length ? ImageIcon : FileIcon}
          <span className="card-type-label">
            {imageFiles.length === files.length ? "Images" : "Files"}
          </span>
          {!withMeasureRef && (
            <ChevronDownIcon className="card-type-chevron" />
          )}
        </button>
      );
    }

    if (withMeasureRef) {
      return (
        <span ref={typeMeasureRef as React.Ref<HTMLSpanElement>}>
          <EntryTypePill kind={deriveDisplayKind(entry)} />
        </span>
      );
    }
    return <EntryTypePill kind={deriveDisplayKind(entry)} />;
  };

  const renderPinnedChip = (withMeasureRef = false) =>
    entry.pinned ? (
      <span
        ref={withMeasureRef ? pinMeasureRef : undefined}
        className="card-type-chip card-type-chip--pinned"
      >
        {PinIcon}
        <span className="card-type-label">Pinned</span>
      </span>
    ) : null;

  const renderSavedChip = (withMeasureRef = false) =>
    entryGroups.includes("Saved") ? (
      <span
        ref={withMeasureRef ? savedMeasureRef : undefined}
        className="card-type-chip card-type-chip--saved"
      >
        {SaveIcon}
        <span className="card-type-label">Saved</span>
      </span>
    ) : null;

  const renderGroupChip = (
    group: string,
    key: string,
    measureIndex?: number,
  ) => {
    const gc = groupColor(group);
    return (
      <span
        key={key}
        ref={
          measureIndex !== undefined
            ? (node) => {
                groupMeasureRefs.current[measureIndex] = node;
              }
            : undefined
        }
        className="card-type-chip card-type-chip--group"
        style={{ background: gc.bg, color: gc.fg }}
      >
        <span className="card-group-dot" />
        <span className="card-type-label">{group}</span>
      </span>
    );
  };

  const cardClasses = [
    "entry-card",
    copied && "entry-card--copied",
    showFileList && "entry-card--expanded",
    isSelecting && "entry-card--selectable",
    isSelected && "entry-card--selected",
  ].filter(Boolean).join(" ");

  return (
    <div
      ref={cardRef}
      className={cardClasses}
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
            src={entry.content}
            alt="Copied image"
            className="card-media-img"
          />
        </div>
      )}
      {/* Multi-image file strip */}
      {entry.type === "file" && isMulti && imageFiles.length > 0 && (
        <div className="card-media card-media--multi">
          {visibleImageThumbs.map((f, i) => {
            const isLast =
              i === visibleImageThumbs.length - 1 && remainingImageThumbs > 0;
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
                  <div className="card-thumb-more">+{remainingImageThumbs}</div>
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
        isImageFile(firstFile) && (
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
        isVideoFile(firstFile) && (
          <div className="card-media">
            <VideoPlayer src={firstFileUrl} className="card-media-img" />
          </div>
        )}

      {/*  Card body  */}
      <div className="card-body">
        {entry.type === "text" && (
          <p className="card-text">{truncateText(entry.content, 160)}</p>
        )}
        {entry.type === "html" && (
          <div
            className="card-html-preview"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(htmlFragment(entry.content)) }}
          />
        )}
        {entry.type === "file" && !isMulti && (
          <p className={`card-text card-text--file${firstFile && missingFiles.has(firstFile) ? " card-text--missing" : ""}`}>
            <span {...(firstFile && missingFiles.has(firstFile) ? { "data-tooltip": "File no longer exists on disk", "data-tooltip-pos": "above" } : {})}>
              {firstFile ? fileNameFromPath(firstFile) : "[File]"}
            </span>
            {firstFile && missingFiles.has(firstFile) && (
              <span className="card-missing-hint" data-tooltip="File no longer exists on disk">missing</span>
            )}
          </p>
        )}
        {entry.type === "file" && isMulti && !showFileList && (
          <div className="card-file-preview">
            {files.slice(0, 3).map((f) => {
              const name = fileNameFromPath(f);
              const isImg = isImageFile(f);
              return (
                <span key={f} className={`card-file-preview-item${missingFiles.has(f) ? " card-file-preview-item--missing" : ""}`}>
                  {isImg ? ImageIcon : FileIcon}
                  <span
                    className="card-file-preview-name"
                    {...(missingFiles.has(f) ? { "data-tooltip": "File no longer exists on disk", "data-tooltip-pos": "above" } : {})}>
                    {name}
                  </span>
                  {missingFiles.has(f) && (
                    <span className="card-missing-hint" data-tooltip="File missing">missing</span>
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
            className={`card-file-list${imageFiles.length > 0 ? " card-file-list--bordered" : ""}`}
          >
            {files.map((f) => {
              const name = fileNameFromPath(f);
              const isImg = isImageFile(f);
              const preview = imagePreviews[f];
              return (
                <div key={f} className={`card-file-list-item${missingFiles.has(f) ? " card-file-list-item--missing" : ""}`}>
                  {isImg && (
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
                    {...(missingFiles.has(f) ? { "data-tooltip": "File no longer exists on disk", "data-tooltip-pos": "above" } : {})}>
                    {name}
                  </span>
                  {missingFiles.has(f) && (
                    <span className="card-missing-hint" data-tooltip="File missing">missing</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* Footer: type chip + pinned chip + timestamp */}
        <div className="card-footer">
          <div className="card-chips" ref={footerChipsRef}>
            {renderTypeChip()}
            {renderPinnedChip()}
            {renderSavedChip()}
            {visibleGroups.length > 0 &&
              visibleGroups.map((g) => renderGroupChip(g, g))}
            {hiddenGroupCount > 0 && (
              <button
                type="button"
                className={`card-type-chip card-type-chip--group-overflow card-type-chip--group-overflow-btn${showHiddenGroups ? " active" : ""}`}
                data-tooltip={
                  showHiddenGroups
                    ? "Hide extra groups"
                    : `show ${hiddenGroupCount} more group${hiddenGroupCount > 1 ? "s" : ""}`
                }
                onClick={(e) => {
                  e.stopPropagation();
                  setShowHiddenGroups((v) => !v);
                }}
                aria-expanded={showHiddenGroups}
              >
                +{hiddenGroupCount}
              </button>
            )}

            {/* Hidden measurer for dynamic chip fitting */}
            <div className="card-chip-measure" aria-hidden>
              {renderTypeChip(true)}
              {renderPinnedChip(true)}
              {renderSavedChip(true)}
              {displayGroups.map((g, idx) =>
                renderGroupChip(g, `measure-${g}-${idx}`, idx),
              )}
              <button
                ref={overflowMeasureRef}
                type="button"
                className="card-type-chip card-type-chip--group-overflow card-type-chip--group-overflow-btn"
              >
                +99
              </button>
            </div>
          </div>
          {justPinned ? (
            <span className="card-time card-time--pinned">
              {PinIcon}
              Pinned
            </span>
          ) : copied ? (
            <span className="card-time card-time--copied">
              <CheckIcon size={9} strokeWidth={2.8} />
              Copied
            </span>
          ) : (
            <span className="card-time">{relTime}</span>
          )}
        </div>
        {showHiddenGroups && hiddenGroups.length > 0 && (
          <div
            className="card-hidden-groups"
            onClick={(e) => e.stopPropagation()}
          >
            {hiddenGroups.map((g) => {
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
          </div>
        )}
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
      />
    </div>
  );
};

export default EntryCard;
