import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./popup.css";

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

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Cursor popup — shown near the cursor after Ctrl+Shift+C.
 *
 * Listens for the `"clipboard:text"` event emitted by the Rust backend,
 * displays a preview of the copied text, and offers quick-action buttons.
 * Closing calls the `close_cursor_popup` Tauri command so the Rust backend
 * can hide the window.
 */
const CursorPopup: React.FC = () => {
  const [kind, setKind] = useState<"text" | "image" | "file">("text");
  const [copiedText, setCopiedText] = useState<string>("");
  const [imageFilePreview, setImageFilePreview] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Listen for the structured payload pushed from Rust when Ctrl+Shift+C fires.
    const unlisten = listen<{ kind: "text" | "image" | "file"; content: string }>(
      "clipboard:copied",
      (event) => {
        setVisible(false);
        setKind(event.payload.kind);
        setCopiedText(event.payload.content);
        requestAnimationFrame(() => setVisible(true));
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Dismiss when the popup loses OS focus (user clicked outside).
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenBlur = win.listen("tauri://blur", () => {
      setVisible(false);
      invoke("close_cursor_popup").catch(console.error);
    });
    return () => {
      unlistenBlur.then((fn) => fn());
    };
  }, []);

  /** Hide this window via the Rust command. */
  const handleClose = useCallback(() => {
    setVisible(false);
    invoke("close_cursor_popup").catch(console.error);
  }, []);

  /** Placeholder for future smart-action handlers. */
  const handleAction = useCallback(
    (action: string) => {
      console.log(`[CursorPopup] Action: ${action}`, copiedText);
    },
    [copiedText],
  );

  const previewText =
    copiedText.length > 200 ? copiedText.slice(0, 200) + "…" : copiedText;
  const files = copiedText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const firstFile = files[0];
  const firstFileUrl = firstFile ? convertFileSrc(firstFile) : "";

  useEffect(() => {
    if (kind !== "file" || !firstFile || !isImageFile(firstFile)) {
      setImageFilePreview(null);
      return;
    }

    invoke<string | null>("get_image_file_preview", { path: firstFile })
      .then((preview) => setImageFilePreview(preview))
      .catch(() => setImageFilePreview(null));
  }, [kind, firstFile]);

  return (
    <div
      className={`popup-container${visible ? " visible" : ""}`}
      ref={containerRef}
    >
      {/* ── Header ──────────────────────────────── */}
      <div className="popup-header">
        <span className="popup-title">
          {kind === "image"
            ? "Copied Image"
            : kind === "file"
              ? "Copied Files"
              : "Copied Text"}
        </span>
        <button className="popup-close" onClick={handleClose} title="Close">
          ✕
        </button>
      </div>

      <div className="popup-divider" />

      {/* ── Preview ─────────────────────────────── */}
      {kind === "image"
        ? copiedText && (
            <div className="popup-clipboard-text">
              <img
                src={copiedText}
                alt="Copied image"
                style={{
                  maxWidth: "100%",
                  maxHeight: "120px",
                  borderRadius: "6px",
                  objectFit: "contain",
                }}
              />
            </div>
          )
        : kind === "file"
          ? copiedText && (
              <div className="popup-clipboard-text">
                {firstFile && isImageFile(firstFile) && (
                  <div className="popup-file-preview-wrap">
                    <img
                      src={imageFilePreview ?? firstFileUrl}
                      alt="Copied image file"
                      className="popup-file-preview-media"
                    />
                  </div>
                )}
                {firstFile && isVideoFile(firstFile) && (
                  <div className="popup-file-preview-wrap">
                    <video
                      className="popup-file-preview-media"
                      controls
                      preload="metadata"
                      src={firstFileUrl}
                    />
                  </div>
                )}
                <p className="clipboard-preview">
                  {files.length} file(s) copied
                </p>
              </div>
            )
        : previewText && (
            <div className="popup-clipboard-text">
              <p className="clipboard-preview">{previewText}</p>
            </div>
          )}

      <div className="popup-divider" />

      {/* ── Quick actions ────────────────────────── */}
      <div className="popup-actions">
        <button className="popup-btn" onClick={() => handleAction("summarize")}>
          <span className="btn-icon">✨</span>
          <span className="btn-label">Summarize</span>
        </button>

        <button className="popup-btn" onClick={() => handleAction("search")}>
          <span className="btn-icon">🔍</span>
          <span className="btn-label">Search</span>
        </button>

        <button className="popup-btn" onClick={() => handleAction("translate")}>
          <span className="btn-icon">🌐</span>
          <span className="btn-label">Translate</span>
        </button>

        <button className="popup-btn" onClick={() => handleAction("save")}>
          <span className="btn-icon">💾</span>
          <span className="btn-label">Save</span>
        </button>
      </div>
    </div>
  );
};

export default CursorPopup;

// ── Mount ────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CursorPopup />
  </React.StrictMode>,
);
