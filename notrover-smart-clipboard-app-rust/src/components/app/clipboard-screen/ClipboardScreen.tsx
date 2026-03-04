import React, { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ClipboardEntry } from "../../../types";
import {
  filePaths,
  isImageFile,
  isVideoFile,
  truncateText,
  timeAgo,
} from "../../../types";
import "./ClipboardScreen.css";

// ── Entry Card ────────────────────────────────────────────────────────────

interface EntryCardProps {
  entry: ClipboardEntry;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
}

const EntryCard: React.FC<EntryCardProps> = ({ entry, onCopy, onDelete }) => {
  const [copied, setCopied] = useState(false);
  const [relTime, setRelTime] = useState(timeAgo(entry.timestamp));
  const [imagePreviews, setImagePreviews] = useState<
    Record<string, string | null>
  >({});
  const [showFileList, setShowFileList] = useState(false);

  const files = entry.type === "file" ? filePaths(entry.content) : [];
  const firstFile = files[0] ?? null;
  const firstFileUrl = firstFile ? convertFileSrc(firstFile) : "";
  const imageFiles = files.filter(isImageFile);
  const isMulti = files.length > 1;

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
      15_000,
    );
    return () => clearInterval(timer);
  }, [entry.timestamp]);

  const handleCopy = () => {
    onCopy(entry.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`entry-card${copied ? " entry-card--copied" : ""}`}
      onClick={handleCopy}
      title="Click to copy"
    >
      {/* ── Media preview (image/video) ── */}
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
      {entry.type === "file" &&
        isMulti &&
        imageFiles.length > 0 &&
        (() => {
          const MAX_THUMBS = 3;
          const visible = imageFiles.slice(0, MAX_THUMBS);
          const remaining = imageFiles.length - MAX_THUMBS;
          return (
            <div className="card-media card-media--multi">
              {visible.map((f, i) => {
                const isLast = i === visible.length - 1 && remaining > 0;
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
                      <div className="card-thumb-more">+{remaining}</div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
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
            <video
              className="card-media-img"
              controls
              preload="metadata"
              src={firstFileUrl}
            />
          </div>
        )}

      {/* ── Card body ── */}
      <div className="card-body">
        {entry.type === "text" && (
          <p className="card-text">{truncateText(entry.content, 160)}</p>
        )}
        {entry.type === "file" && !isMulti && (
          <p className="card-text card-text--file">
            {firstFile
              ? (firstFile.split(/[\\/]/).pop() ?? firstFile)
              : "[File]"}
          </p>
        )}
        {entry.type === "file" && isMulti && !showFileList && (
          <div className="card-file-preview">
            {files.slice(0, 3).map((f) => {
              const name = f.split(/[\\/]/).pop() ?? f;
              const isImg = isImageFile(f);
              return (
                <span key={f} className="card-file-preview-item">
                  {isImg ? (
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  ) : (
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                      <polyline points="13 2 13 9 20 9" />
                    </svg>
                  )}
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
          <div className="card-file-list">
            {files.map((f) => {
              const name = f.split(/[\\/]/).pop() ?? f;
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
        {/* ── Footer: type chip + timestamp ── */}
        <div className="card-footer">
          {entry.type === "file" && isMulti ? (
            <button
              className={`card-type-chip card-type-chip--file card-type-chip--clickable${showFileList ? " open" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setShowFileList((v) => !v);
              }}
              title={
                showFileList
                  ? "Collapse"
                  : `Show ${files.length} ${imageFiles.length === files.length ? "images" : "files"}`
              }
            >
              {imageFiles.length === files.length ? (
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              ) : (
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
              )}
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
            <span className={`card-type-chip card-type-chip--${entry.type}`}>
              {entry.type === "text" ? (
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              ) : entry.type === "image" ? (
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              ) : (
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
              )}
              <span className="card-type-label">
                {entry.type === "text"
                  ? "Text"
                  : entry.type === "image"
                    ? "Image"
                    : "File"}
              </span>
            </span>
          )}
          {copied ? (
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
      </div>

      {/* ── Hover action overlay ── */}
      <div className="card-actions">
        <button
          className={`card-action-btn copy-btn ${copied ? "copied" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            handleCopy();
          }}
          title="Copy"
        >
          {copied ? (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <button
          className="card-action-btn delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(entry.id);
          }}
          title="Delete"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
};

// ── Layout types ─────────────────────────────────────────────────────────

type ClipboardLayout = "masonry" | "list";

// ── Day grouping helpers ─────────────────────────────────────────────────────

function toLocalDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(key: string): string {
  const todayKey = toLocalDateKey(Date.now());
  const yesterdayKey = toLocalDateKey(Date.now() - 86_400_000);
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  const [year, month, day] = key.split("-").map(Number);
  const d = new Date(year, month, day);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function daySubtitle(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const d = new Date(year, month, day);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

interface DayGroup {
  key: string;
  label: string;
  subtitle: string;
  entries: ClipboardEntry[];
}

function groupByDay(entries: ClipboardEntry[]): DayGroup[] {
  const map = new Map<string, ClipboardEntry[]>();
  for (const e of entries) {
    const k = toLocalDateKey(e.timestamp);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(e);
  }
  return Array.from(map.entries()).map(([key, entries]) => ({
    key,
    label: dayLabel(key),
    subtitle: daySubtitle(key),
    entries,
  }));
}

// ── Clipboard Screen ──────────────────────────────────────────────────────

interface ClipboardScreenProps {
  entries: ClipboardEntry[];
  filtered: ClipboardEntry[];
  search: string;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
}

const ClipboardScreen: React.FC<ClipboardScreenProps> = ({
  entries,
  filtered,
  search,
  onCopy,
  onDelete,
}) => {
  const [layout, setLayout] = useState<ClipboardLayout>(() => {
    return (localStorage.getItem("sc-layout") as ClipboardLayout) ?? "masonry";
  });
  const [fading, setFading] = useState(false);

  const selectLayout = (l: ClipboardLayout) => {
    if (l === layout) return;
    setFading(true);
    setTimeout(() => {
      setLayout(l);
      localStorage.setItem("sc-layout", l);
      setFading(false);
    }, 160);
  };

  if (filtered.length === 0) {
    return (
      <div className="empty-state">
        {entries.length === 0 ? (
          <>
            <svg
              className="empty-icon"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
            <p className="empty-title">No clipboard history yet</p>
            <p className="empty-subtitle">
              Press <strong>Ctrl+Shift+C</strong> to capture anything here.
            </p>
          </>
        ) : (
          <>
            <p className="empty-title">No results</p>
            <p className="empty-subtitle">
              Nothing matches &ldquo;{search}&rdquo;
            </p>
          </>
        )}
      </div>
    );
  }

  const layouts: { id: ClipboardLayout; label: string; icon: React.ReactNode }[] = [
    {
      id: "masonry",
      label: "Masonry",
      icon: (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </svg>
      ),
    },
    {
      id: "list",
      label: "List",
      icon: (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      ),
    },
  ];

  const dayGroups = groupByDay(filtered);

  return (
    <div className="clipboard-screen-root">
      {/* ── Layout segmented switch ── */}
      <div className="layout-toggle-wrap">
        <div className="layout-switch" role="group" aria-label="Layout">
          {layouts.map((l) => (
            <button
              key={l.id}
              id={`layout-option-${l.id}`}
              className={`layout-switch-btn${layout === l.id ? " layout-switch-btn--active" : ""}`}
              onClick={() => selectLayout(l.id)}
              title={l.label}
            >
              {l.icon}
              <span className="layout-pill-label">{l.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Entry grid / list with timeline ── */}
      <div className={`layout-viewport${fading ? " layout-viewport--fading" : ""}`}>
        <div className="timeline-wrap">
          {/* Orange vertical rail */}
          <div className="timeline-rail" />

          {/* Day groups */}
          <div className="timeline-groups">
            {dayGroups.map((group) => (
              <div key={group.key} className="timeline-group">
                {/* Day marker */}
                <div className="timeline-day-row">
                  <div className="timeline-day-dot" />
                  <span className="timeline-day-label">{group.label}</span>
                  {group.label !== group.subtitle && (
                    <span className="timeline-day-subtitle">{group.subtitle}</span>
                  )}
                </div>

                {/* Cards for this day */}
                <div className={layout === "masonry" ? "entry-grid" : "entry-list"}>
                  {group.entries.map((entry) => (
                    <EntryCard
                      key={entry.id}
                      entry={entry}
                      onCopy={onCopy}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClipboardScreen;
