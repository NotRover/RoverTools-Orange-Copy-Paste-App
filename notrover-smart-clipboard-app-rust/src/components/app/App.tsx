import React, { useCallback, useEffect, useState } from "react";
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
      .then((p) => setImageFilePreview(p))
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
      {/* ── Media preview (image/video) ──────── */}
      {entry.type === "image" && (
        <div className="card-media">
          <img
            src={entry.content}
            alt="Copied image"
            className="card-media-img"
          />
        </div>
      )}
      {entry.type === "file" && firstFile && isImageFile(firstFile) && (
        <div className="card-media">
          <img
            src={imageFilePreview ?? firstFileUrl}
            alt="Copied image file"
            className="card-media-img"
          />
        </div>
      )}
      {entry.type === "file" && firstFile && isVideoFile(firstFile) && (
        <div className="card-media">
          <video
            className="card-media-img"
            controls
            preload="metadata"
            src={firstFileUrl}
          />
        </div>
      )}

      {/* ── Card body ────────── */}
      <div className="card-body">
        <div className="card-meta-row">
          <span className="card-badge">
            {entry.type === "text" ? (
              <svg
                width="11"
                height="11"
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
                width="11"
                height="11"
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
                width="11"
                height="11"
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
          </span>
          <span className="card-time">{relTime}</span>
        </div>
        {entry.type === "text" && (
          <p className="card-text">{truncateText(entry.content, 160)}</p>
        )}
        {entry.type === "file" && (
          <p className="card-text card-text--file">
            {(() => {
              if (files.length === 0) return "[Files]";
              const name = files[0].split(/[\\/]/).pop() ?? files[0];
              return files.length === 1
                ? name
                : `${name} +${files.length - 1} more`;
            })()}
          </p>
        )}
      </div>

      {/* ── Hover action overlay ────── */}
      <div className="card-actions">
        <button
          className={`card-action-btn copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopy}
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
          onClick={() => onDelete(entry.id)}
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

// ── Settings Screen ───────────────────────────────────────────────────────────

const SettingsScreen: React.FC = () => (
  <div className="settings-screen">
    <div className="settings-header">
      <h2 className="settings-title">Settings</h2>
      <p className="settings-subtitle">
        Manage your Smart Clipboard preferences.
      </p>
    </div>
    <div className="settings-placeholder">
      <svg
        width="52"
        height="52"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      <p className="settings-placeholder-text">Settings coming soon</p>
    </div>
  </div>
);

// ── App ──────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [search, setSearch] = useState("");
  const [screen, setScreen] = useState<"clipboard" | "settings">("clipboard");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("sc-theme") as "dark" | "light") ?? "dark";
  });

  const toggleTheme = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("sc-theme", next);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    let actualUnlisten: (() => void) | undefined;

    invoke<ClipboardEntry[]>("get_history").then((history) => {
      if (!cancelled) setEntries(history);
    });

    listen<ClipboardEntry>("clipboard:new-entry", (event) => {
      if (cancelled) return;
      setEntries((prev) => {
        if (prev.some((entry) => entry.id === event.payload.id)) return prev;
        return [event.payload, ...prev];
      });
    }).then((fn) => {
      if (cancelled) fn();
      else actualUnlisten = fn;
    });

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
  const fileCount = entries.filter(
    (e) => e.type === "file" && classifyFileEntry(e.content) === "file",
  ).length;

  return (
    <div className="app" data-theme={theme}>
      {/* ── Sidebar ─────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <svg
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
        </div>

        <nav className="sidebar-nav">
          <button
            className={`nav-btn ${screen === "clipboard" ? "active" : ""}`}
            onClick={() => setScreen("clipboard")}
            title="Clipboard"
          >
            <svg
              width="18"
              height="18"
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
          </button>
        </nav>

        <div className="sidebar-bottom">
          <button
            className="nav-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? (
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button
            className={`nav-btn ${screen === "settings" ? "active" : ""}`}
            onClick={() => setScreen("settings")}
            title="Settings"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </aside>

      {/* ── Main frame ──────────────────────────────────── */}
      <div className="main-frame">
        {/* ── Top bar ── */}
        <div className="topbar">
          <div className="search-bar">
            <svg
              className="search-icon"
              width="14"
              height="14"
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
                  width="11"
                  height="11"
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
          {screen === "clipboard" && entries.length > 0 && (
            <button className="clear-all-btn" onClick={handleClearAll}>
              Clear All
            </button>
          )}
        </div>

        {/* ── Content ── */}
        {screen === "settings" ? (
          <SettingsScreen />
        ) : filtered.length === 0 ? (
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
        ) : (
          <div className="entry-grid">
            {filtered.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                onCopy={handleCopy}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
        {/* ── Status pill ── */}
        {screen === "clipboard" && entries.length > 0 && (
          <div className="status-pill">
            <span className="status-item">
              <span className="status-value">{textCount}</span> text
            </span>
            <span className="status-dot" />
            <span className="status-item">
              <span className="status-value">{imageCount}</span> img
            </span>
            <span className="status-dot" />
            <span className="status-item">
              <span className="status-value">{fileCount}</span> files
            </span>
            <span className="status-dot" />
            <span className="status-item">
              <span className="status-value">{entries.length}</span> total
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;

// ── Mount ────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
