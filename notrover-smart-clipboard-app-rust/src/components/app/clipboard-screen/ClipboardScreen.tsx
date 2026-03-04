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

      {/* ── Card body ── */}
      <div className="card-body">
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
        {/* ── Footer: type chip + timestamp ── */}
        <div className="card-footer">
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

  return (
    <div className="entry-grid">
      {filtered.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          onCopy={onCopy}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
};

export default ClipboardScreen;
