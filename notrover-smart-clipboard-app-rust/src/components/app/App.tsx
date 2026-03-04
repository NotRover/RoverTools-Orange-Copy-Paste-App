import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

// ── Types ────────────────────────────────────────────────────────────────────

/** Matches the Rust `ClipboardEntry` struct (serialised by serde). */
interface ClipboardEntry {
  id: string;
  /** Serialised as `"type"` from the Rust `#[serde(rename = "type")]` field. */
  type: "text" | "image" | "file";
  content: string;
  /** Unix epoch in milliseconds. */
  timestamp: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateText(text: string, max = 180): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}

function filePaths(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const IMAGE_FILE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "svg",
  "ico",
  "tiff",
  "tif",
  "avif",
  "heic",
  "heif",
]);

const VIDEO_FILE_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "mkv",
  "avi",
  "wmv",
  "m4v",
  "mpeg",
  "mpg",
]);

function fileExtension(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
}

function isImageFile(path: string): boolean {
  return IMAGE_FILE_EXTENSIONS.has(fileExtension(path));
}

function isVideoFile(path: string): boolean {
  return VIDEO_FILE_EXTENSIONS.has(fileExtension(path));
}

function classifyFileEntry(content: string): "image" | "video" | "file" {
  const paths = filePaths(content);
  if (paths.length === 0) return "file";
  if (paths.every(isImageFile)) return "image";
  if (paths.every(isVideoFile)) return "video";
  return "file";
}

// ── Entry Card ───────────────────────────────────────────────────────────────

const EntryCard: React.FC<{
  entry: ClipboardEntry;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
}> = ({ entry, onCopy, onDelete }) => {
  const [copied, setCopied] = useState(false);
  const [relTime, setRelTime] = useState(timeAgo(entry.timestamp));
  const [imageFilePreview, setImageFilePreview] = useState<string | null>(null);
  const files = entry.type === "file" ? filePaths(entry.content) : [];
  const firstFile = files[0];
  const firstFileUrl = firstFile ? convertFileSrc(firstFile) : "";

  useEffect(() => {
    if (entry.type !== "file" || !firstFile || !isImageFile(firstFile)) {
      setImageFilePreview(null);
      return;
    }

    invoke<string | null>("get_image_file_preview", { path: firstFile })
      .then((preview) => setImageFilePreview(preview))
      .catch(() => setImageFilePreview(null));
  }, [entry.type, firstFile]);

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
    <div className="entry-card">
      <div className="entry-type-badge">
        {entry.type === "text" ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        ) : entry.type === "image" ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="17 8 21 8 21 4" />
            <line x1="16" y1="9" x2="21" y2="4" />
            <path d="M7 13h10" />
            <path d="M7 17h6" />
          </svg>
        )}
      </div>

      <div className="entry-body">
        {entry.type === "text" ? (
          <p className="entry-text">{truncateText(entry.content)}</p>
        ) : entry.type === "image" ? (
          <div className="entry-image-wrap">
            <img
              src={entry.content}
              alt="Copied image"
              className="entry-image"
            />
          </div>
        ) : (
          <>
            {firstFile && isImageFile(firstFile) && (
              <div className="entry-file-preview-wrap">
                <img
                  src={imageFilePreview ?? firstFileUrl}
                  alt="Copied image file"
                  className="entry-file-preview-media"
                />
              </div>
            )}
            {firstFile && isVideoFile(firstFile) && (
              <div className="entry-file-preview-wrap">
                <video
                  className="entry-file-preview-media"
                  controls
                  preload="metadata"
                  src={firstFileUrl}
                />
              </div>
            )}
            <p className="entry-text">
              {(() => {
                if (files.length === 0) return "[Files]";
                if (files.length === 1) return files[0];
                return `${files[0]} (+${files.length - 1} more)`;
              })()}
            </p>
          </>
        )}
        <span className="entry-time">{relTime}</span>
      </div>

      <div className="entry-actions">
        <button
          className={`entry-action-btn copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title="Copy to clipboard"
        >
          {copied ? (
            <svg
              width="14"
              height="14"
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
              width="14"
              height="14"
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
          className="entry-action-btn delete-btn"
          onClick={() => onDelete(entry.id)}
          title="Delete"
        >
          <svg
            width="14"
            height="14"
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

// ── App ──────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Load history on mount and subscribe to new entries pushed from Rust.
  useEffect(() => {
    let cancelled = false;
    let actualUnlisten: (() => void) | undefined;

    // Initial load via Tauri command.
    invoke<ClipboardEntry[]>("get_history").then((history) => {
      if (!cancelled) setEntries(history);
    });

    // Listen for new entries emitted by the Rust backend.
    listen<ClipboardEntry>("clipboard:new-entry", (event) => {
      if (cancelled) return;
      setEntries((prev) => {
        if (prev.some((entry) => entry.id === event.payload.id)) {
          return prev;
        }
        return [event.payload, ...prev];
      });
    }).then((fn) => {
      if (cancelled) {
        fn(); // unsubscribe immediately if already cleaned up
      } else {
        actualUnlisten = fn;
      }
    });

    // Cleanup the event listener on unmount.
    return () => {
      cancelled = true;
      actualUnlisten?.();
    };
  }, []);

  const handleCopy = useCallback(async (id: string) => {
    await invoke("copy_entry", { id });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await invoke("delete_entry", { id });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const handleClearAll = useCallback(async () => {
    await invoke("clear_history");
    setEntries([]);
  }, []);

  // Filter entries by search query (text entries only).
  const filtered = search
    ? entries.filter(
        (e) =>
          e.type === "text" &&
          e.content.toLowerCase().includes(search.toLowerCase()),
      )
    : entries;

  const textCount = entries.filter((e) => e.type === "text").length;
  const imageCount = entries.filter(
    (e) =>
      e.type === "image" ||
      (e.type === "file" && classifyFileEntry(e.content) === "image"),
  ).length;
  const videoCount = entries.filter(
    (e) => e.type === "file" && classifyFileEntry(e.content) === "video",
  ).length;
  const fileCount = entries.filter(
    (e) => e.type === "file" && classifyFileEntry(e.content) === "file",
  ).length;

  return (
    <div className="app">
      {/* ── Header ──────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-left">
          <svg
            className="header-icon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          </svg>
          <h1 className="header-title">Smart Clipboard</h1>
        </div>
        {entries.length > 0 && (
          <button className="clear-all-btn" onClick={handleClearAll}>
            Clear All
          </button>
        )}
      </header>

      {/* ── Search ──────────────────────────────────────── */}
      <div className="search-bar">
        <svg
          className="search-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="search-input"
          placeholder="Search clipboard history…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="search-clear" onClick={() => setSearch("")}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Stats ───────────────────────────────────────── */}
      {entries.length > 0 && (
        <div className="stats-bar">
          <span className="stat">{textCount} text</span>
          <span className="stat-dot" />
          <span className="stat">{imageCount} images</span>
          <span className="stat-dot" />
          <span className="stat">{videoCount} videos</span>
          <span className="stat-dot" />
          <span className="stat">{fileCount} files</span>
          <span className="stat-dot" />
          <span className="stat">{entries.length} total</span>
        </div>
      )}

      {/* ── Entry list ──────────────────────────────────── */}
      <div className="entry-list" ref={listRef}>
        {filtered.length === 0 ? (
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
                  Press <strong>Ctrl+Shift+C</strong> over any text or image to
                  capture it here.
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
        ) : (
          filtered.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              onCopy={handleCopy}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default App;

// ── Mount ────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
