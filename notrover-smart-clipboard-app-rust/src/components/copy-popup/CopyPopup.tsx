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
  groups?: string[];
}

// Layout constants (must match Rust COPY_POPUP_W)
const BODY_PAD = 12; // body padding (6px * 2)
const HEADER_H = 30; // header row
const ACTIONS_H = 38; // action menu items (horizontal row)
const CHROME_H = HEADER_H + ACTIONS_H + BODY_PAD + 24; // +gaps+padding
const MIN_PREVIEW_H = 36;
const MAX_PREVIEW_H = 140;

function estimatePreviewHeight(
  kind: string,
  content: string,
  hasMedia: boolean,
): number {
  if (hasMedia) return MAX_PREVIEW_H;
  if (kind === "file") {
    const count = content.split("\n").filter((l) => l.trim()).length;
    return Math.min(Math.max(count * 18, MIN_PREVIEW_H), MAX_PREVIEW_H);
  }
  // text: estimate based on length
  const lines = Math.ceil(content.length / 45); // rough chars per line
  return Math.min(Math.max(lines * 18, MIN_PREVIEW_H), MAX_PREVIEW_H);
}

const CopyPopup: React.FC = () => {
  const [kind, setKind] = useState<"text" | "image" | "file">("text");
  const [content, setContent] = useState("");
  const [entryId, setEntryId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setSaved(false);
        setVisible(false);
        requestAnimationFrame(() => setVisible(true));

        // Fetch pinned/saved state for the entry
        try {
          const history = await invoke<HistoryEntry[]>("get_history");
          const match = history.find((h) => h.id === event.payload.id);
          if (match && !cancelled) {
            setPinned(match.pinned);
            setSaved(match.groups?.includes("Saved") ?? false);
          }
        } catch {
          /* state unavailable, defaults are fine */
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
        // Delay so button clicks inside the popup can process first;
        // transparent frameless windows on Windows can fire blur on click.
        blurTimer.current = setTimeout(() => {
          setVisible(false);
          invoke("close_copy_popup").catch(console.error);
        }, 200);
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

  // Dynamic resize based on content
  useEffect(() => {
    if (!visible) return;
    const hasMedia =
      kind === "image" ||
      (kind === "file" &&
        !!firstFile &&
        (IMAGE_EXTS.has(fileExt(firstFile)) ||
          VIDEO_EXTS.has(fileExt(firstFile))));
    const previewH = estimatePreviewHeight(kind, content, hasMedia);
    const totalH = CHROME_H + previewH;
    invoke("resize_copy_popup", { height: totalH }).catch(console.error);
  }, [visible, kind, content, firstFile]);

  const cancelBlur = useCallback(() => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    cancelBlur();
    setVisible(false);
    invoke("close_copy_popup").catch(console.error);
  }, [cancelBlur]);

  const handlePin = useCallback(async () => {
    if (!entryId) return;
    cancelBlur();
    const cmd = pinned ? "unpin_entry" : "pin_entry";
    const ok = await invoke<boolean>(cmd, { id: entryId });
    if (ok) setPinned(!pinned);
  }, [entryId, pinned, cancelBlur]);

  const handleSave = useCallback(async () => {
    if (!entryId) return;
    cancelBlur();
    try {
      const history = await invoke<HistoryEntry[]>("get_history");
      const match = history.find((h) => h.id === entryId);
      const groups = match?.groups ?? [];
      const has = groups.includes("Saved");
      const newGroups = has
        ? groups.filter((g) => g !== "Saved")
        : [...groups, "Saved"];
      await invoke("set_entry_groups", { id: entryId, groups: newGroups });
      setSaved(!has);
    } catch {
      /* best-effort */
    }
  }, [entryId, cancelBlur]);

  const handleDelete = useCallback(async () => {
    if (!entryId) return;
    cancelBlur();
    await invoke("delete_entry", { id: entryId });
    setDeleted(true);
    setTimeout(() => {
      invoke("close_copy_popup").catch(console.error);
    }, 800);
  }, [entryId, cancelBlur]);

  // Preview
  const previewText =
    content.length > 200 ? content.slice(0, 200) + "\u2026" : content;

  const displayKind = deriveDisplayKind({
    id: entryId ?? "",
    type: kind,
    content,
    timestamp: 0,
    pinned,
    groups: [],
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
              {kind === "file" && files.length > 1 && (
                <span className="popup-file-count">{files.length} files</span>
              )}
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

          {/* Actions — styled like CardMenu items */}
          <div className="popup-actions">
            <button
              className={`popup-menu-item popup-menu-item--pin${pinned ? " popup-menu-item--active" : ""}`}
              onMouseDown={cancelBlur}
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
              <span>{pinned ? "Unpin" : "Pin"}</span>
            </button>

            <button
              className={`popup-menu-item popup-menu-item--save${saved ? " popup-menu-item--active" : ""}`}
              onMouseDown={cancelBlur}
              onClick={handleSave}
              disabled={!entryId}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill={saved ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              >
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span>{saved ? "Unsave" : "Save"}</span>
            </button>

            <div className="popup-menu-separator" />

            <button
              className="popup-menu-item popup-menu-item--danger"
              onMouseDown={cancelBlur}
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
