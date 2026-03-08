import React, { useEffect, useRef, useState } from "react";
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
} from "../../../../types";
import {
  ImageIcon,
  FileIcon,
  PinIcon,
  EntryTypePill,
} from "../../../entry-types/EntryTypePill";
import CardMenu from "../../card-menu/CardMenu";
import VideoPlayer from "./VideoPlayer";
import "./EntryCard.css";

const FEEDBACK_DURATION_MS = 1500;
const REL_TIME_REFRESH_MS = 15_000;
const MAX_VISIBLE_GROUP_CHIPS = 3;

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

interface EntryCardProps {
  entry: ClipboardEntry;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, shouldPin: boolean) => void;
  availableGroups?: string[];
  onSetGroups?: (id: string, groups: string[]) => void;
}

export const EntryCard: React.FC<EntryCardProps> = ({
  entry,
  onCopy,
  onDelete,
  onPin,
  availableGroups = [],
  onSetGroups,
}) => {
  const [copied, setCopied] = useState(false);
  const [justPinned, setJustPinned] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePin = (shouldPin: boolean) => {
    onPin(entry.id, shouldPin);
    if (shouldPin) {
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
  const [showHiddenGroups, setShowHiddenGroups] = useState(false);

  const files = entry.type === "file" ? filePaths(entry.content) : [];
  const firstFile = files[0] ?? null;
  const firstFileUrl = firstFile ? convertFileSrc(firstFile) : "";
  const imageFiles = files.filter(isImageFile);
  const isMulti = files.length > 1;
  const entryGroups = entry.groups ?? [];
  const visibleGroups = entryGroups.slice(0, MAX_VISIBLE_GROUP_CHIPS);
  const hiddenGroups = entryGroups.slice(MAX_VISIBLE_GROUP_CHIPS);
  const hiddenGroupCount = hiddenGroups.length;

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

  const handleCopy = () => {
    onCopy(entry.id);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(
      () => setCopied(false),
      FEEDBACK_DURATION_MS,
    );
  };

  const visibleImageThumbs = imageFiles.slice(0, 3);
  const remainingImageThumbs = imageFiles.length - visibleImageThumbs.length;

  return (
    <div
      className={`entry-card${copied ? " entry-card--copied" : ""}${showFileList ? " entry-card--expanded" : ""}`}
      onClick={handleCopy}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
      // data-tooltip="Click to copy · Right-click for options"
    >
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
        {entry.type === "file" && !isMulti && (
          <p className="card-text card-text--file">
            {firstFile ? fileNameFromPath(firstFile) : "[File]"}
          </p>
        )}
        {entry.type === "file" && isMulti && !showFileList && (
          <div className="card-file-preview">
            {files.slice(0, 3).map((f) => {
              const name = fileNameFromPath(f);
              const isImg = isImageFile(f);
              return (
                <span key={f} className="card-file-preview-item">
                  {isImg ? ImageIcon : FileIcon}
                  <span className="card-file-preview-name">{name}</span>
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
                <div key={f} className="card-file-list-item">
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
                  <span className="card-file-name">{name}</span>
                </div>
              );
            })}
          </div>
        )}
        {/* Footer: type chip + pinned chip + timestamp */}
        <div className="card-footer">
          <div className="card-chips">
            {entry.type === "file" && isMulti ? (
              <button
                className={`card-type-chip card-type-chip--file card-type-chip--clickable${showFileList ? " open" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFileList((v) => !v);
                }}
                data-tooltip={
                  showFileList
                    ? "Collapse"
                    : `Show ${files.length} ${imageFiles.length === files.length ? "images" : "files"}`
                }
              >
                {imageFiles.length === files.length ? ImageIcon : FileIcon}
                <span className="card-type-label">
                  {imageFiles.length === files.length ? "Images" : "Files"}
                </span>
                <svg
                  className="card-type-chevron"
                  width="8"
                  height="8"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            ) : (
              <EntryTypePill kind={deriveDisplayKind(entry)} />
            )}
            {entry.pinned && (
              <span className="card-type-chip card-type-chip--pinned">
                {PinIcon}
                <span className="card-type-label">Pinned</span>
              </span>
            )}
            {visibleGroups.length > 0 &&
              visibleGroups.map((g) => {
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
            {hiddenGroupCount > 0 && (
              <button
                type="button"
                className={`card-type-chip card-type-chip--group-overflow card-type-chip--group-overflow-btn${showHiddenGroups ? " active" : ""}`}
                data-tooltip={
                  showHiddenGroups
                    ? "Hide extra groups"
                    : `${hiddenGroupCount} more group${hiddenGroupCount > 1 ? "s" : ""}`
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
          </div>
          {justPinned ? (
            <span className="card-time card-time--pinned">
              {PinIcon}
              Pinned
            </span>
          ) : copied ? (
            <span className="card-time card-time--copied">
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
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
        copied={copied}
        onCopy={handleCopy}
        onDelete={() => onDelete(entry.id)}
        onPin={handlePin}
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
