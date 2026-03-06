import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { deriveDisplayKind } from "../../types";
import { EntryTypePill } from "../entry-types/EntryTypePill";
import "./copyPopup.css";

type AppTheme = "dark" | "light";

function readTheme(): AppTheme {
  return (localStorage.getItem("sc-theme") as AppTheme) ?? "dark";
}

const IMAGE_EXTS = new Set([
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
const VIDEO_EXTS = new Set([
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

function fileExt(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

interface HistoryEntry {
  id: string;
  type: "text" | "image" | "file";
  content: string;
  timestamp: number;
  pinned: boolean;
}

const CopyPopup: React.FC = () => {
  const [kind, setKind] = useState<"text" | "image" | "file">("text");
  const [content, setContent] = useState("");
  const [entryId, setEntryId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync theme
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sc-theme") setTheme((e.newValue as AppTheme) ?? "dark");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (visible) setTheme(readTheme());
  }, [visible]);

  // Listen for clipboard:copied
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listen<{ id: string; kind: "text" | "image" | "file"; content: string }>(
      "clipboard:copied",
      async (event) => {
        if (cancelled) return;
        setDeleted(false);
        setKind(event.payload.kind);
        setContent(event.payload.content);
        setEntryId(event.payload.id);
        setPinned(false);
        setVisible(false);
        requestAnimationFrame(() => setVisible(true));

        // Fetch pinned state for the entry
        try {
          const history = await invoke<HistoryEntry[]>("get_history");
          const match = history.find((h) => h.id === event.payload.id);
          if (match && !cancelled) setPinned(match.pinned);
        } catch {
          /* pinned state unavailable, default false is fine */
        }
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Dismiss on blur
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .listen("tauri://blur", () => {
        if (cancelled) return;
        setVisible(false);
        invoke("close_copy_popup").catch(console.error);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Image file preview
  const files =
    kind === "file"
      ? content
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  const firstFile = files[0] ?? "";

  useEffect(() => {
    if (kind !== "file" || !firstFile || !IMAGE_EXTS.has(fileExt(firstFile))) {
      setImagePreview(null);
      return;
    }
    invoke<string | null>("get_image_file_preview", { path: firstFile })
      .then(setImagePreview)
      .catch(() => setImagePreview(null));
  }, [kind, firstFile]);

  const handleClose = useCallback(() => {
    setVisible(false);
    invoke("close_copy_popup").catch(console.error);
  }, []);

  const handlePin = useCallback(async () => {
    if (!entryId) return;
    const cmd = pinned ? "unpin_entry" : "pin_entry";
    const ok = await invoke<boolean>(cmd, { id: entryId });
    if (ok) setPinned(!pinned);
  }, [entryId, pinned]);

  const handleDelete = useCallback(async () => {
    if (!entryId) return;
    await invoke("delete_entry", { id: entryId });
    setDeleted(true);
    setTimeout(() => {
      invoke("close_copy_popup").catch(console.error);
    }, 800);
  }, [entryId]);

  // Preview
  const previewText =
    content.length > 200 ? content.slice(0, 200) + "\u2026" : content;

  const displayKind = deriveDisplayKind({
    id: entryId ?? "",
    type: kind,
    content,
    timestamp: 0,
    pinned,
  });

  return (
    <div
      className={`popup-container${visible ? " visible" : ""}`}
      data-theme={theme}
      ref={containerRef}
    >
      {deleted ? (
        <div className="popup-deleted-state">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          <span>Removed from history</span>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="popup-header">
            <div className="popup-header-left">
              <span className="popup-title">Copied</span>
              <EntryTypePill kind={displayKind} />
            </div>
            <button className="popup-close" onClick={handleClose}>
              <svg
                width="10"
                height="10"
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
          </div>

          {/* <div className="popup-divider" /> */}

          {/* Preview */}
          <div className="popup-preview">
            {kind === "image" && content ? (
              <img
                src={content}
                alt="Copied image"
                className="popup-preview-media"
              />
            ) : kind === "file" ? (
              <>
                {firstFile && IMAGE_EXTS.has(fileExt(firstFile)) && (
                  <img
                    src={imagePreview ?? convertFileSrc(firstFile)}
                    alt="File preview"
                    className="popup-preview-media"
                  />
                )}
                {firstFile && VIDEO_EXTS.has(fileExt(firstFile)) && (
                  <video
                    className="popup-preview-media"
                    controls
                    preload="metadata"
                    src={convertFileSrc(firstFile)}
                  />
                )}
                <p className="popup-preview-text">
                  {files.map((f) => f.split(/[\\/]/).pop()).join(", ")}
                </p>
              </>
            ) : (
              <p className="popup-preview-text">{previewText}</p>
            )}
          </div>

          {/* <div className="popup-divider" /> */}

          {/* Actions */}
          <div className="popup-actions">
            <button
              className={`popup-action-btn${pinned ? " popup-action-btn--active" : ""}`}
              onClick={handlePin}
              disabled={!entryId}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill={pinned ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
              <span>{pinned ? "Pinned" : "Pin"}</span>
            </button>

            <button
              className="popup-action-btn popup-action-btn--danger"
              onClick={handleDelete}
              disabled={!entryId}
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
              <span>Delete</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default CopyPopup;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <CopyPopup />,
);
