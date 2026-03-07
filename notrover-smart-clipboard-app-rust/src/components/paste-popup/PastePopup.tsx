import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./pastePopup.css";

type AppTheme = "dark" | "light";
type Tab = "recent" | "pinned";

// Layout constants (must match Rust PASTE_POPUP_W)
const HEADER_H = 48; // header + divider + padding
const ITEM_H = 44; // item height + gap
const BOTTOM_PAD = 10;
const BODY_PAD = 12; // body padding (6px * 2)
const MIN_EMPTY_H = 100;

function readTheme(): AppTheme {
  return (localStorage.getItem("sc-theme") as AppTheme) ?? "dark";
}

function readSlots(): number {
  const v = parseInt(localStorage.getItem("sc-paste-slots") ?? "3", 10);
  return Number.isNaN(v) ? 3 : Math.max(3, Math.min(10, v));
}

interface PopupEntry {
  id: string;
  type: "text" | "image" | "file";
  content: string;
  timestamp: number;
  pinned: boolean;
}

interface PastePayload {
  recent: PopupEntry[];
  pinned: PopupEntry[];
}

function textPreview(content: string, max = 60): string {
  const line = content.replace(/[\r\n]+/g, " ").trim();
  return line.length > max ? line.slice(0, max) + "…" : line;
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

function fileExt(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(fileExt(path));
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function getFilePaths(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** Badge label: 1-9, 0 for slot 10 */
function badgeLabel(index: number): string {
  return index === 9 ? "0" : String(index + 1);
}

/** Request Rust to resize the popup window to fit content */
function resizePopup(entryCount: number, extraH = 0) {
  const listH = entryCount > 0 ? entryCount * ITEM_H + extraH : MIN_EMPTY_H;
  const total = HEADER_H + listH + BOTTOM_PAD + BODY_PAD;
  invoke("resize_paste_popup", { height: total }).catch(console.error);
}

const PastePopup: React.FC = () => {
  const [recentAll, setRecentAll] = useState<PopupEntry[]>([]);
  const [pinnedAll, setPinnedAll] = useState<PopupEntry[]>([]);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [tab, setTab] = useState<Tab>("recent");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [slots, setSlots] = useState(readSlots);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filePreviews, setFilePreviews] = useState<
    Record<string, string | null>
  >({});

  const entries = useMemo(() => {
    const src = tab === "pinned" ? pinnedAll : recentAll;
    return src.slice(0, slots);
  }, [tab, recentAll, pinnedAll, slots]);

  // Resize popup whenever entry count or expanded state changes
  useEffect(() => {
    if (!visible) return;
    let extraH = 0;
    for (const entry of entries) {
      if (entry.type === "file" && expandedIds.has(entry.id)) {
        const paths = getFilePaths(entry.content);
        if (paths.length > 1) {
          // Each file row ≈ 18px (icon+padding) + 2px gap; capped at CSS max-height 120px
          // plus 6px vertical padding on the container
          const listH = paths.length * 20 - 2; // subtract last gap
          extraH += Math.min(listH, 120) + 6;
        }
      }
    }
    resizePopup(entries.length, extraH);
  }, [entries, visible, expandedIds]);

  // Load image previews for file entries that are images
  useEffect(() => {
    let active = true;
    const toLoad = entries.filter((e) => {
      if (e.type !== "file") return false;
      const paths = getFilePaths(e.content);
      return paths.length === 1 && isImagePath(paths[0]);
    });
    if (toLoad.length === 0) return;
    Promise.all(
      toLoad.map((e) => {
        const path = getFilePaths(e.content)[0];
        return invoke<string | null>("get_image_file_preview", { path })
          .then((p) => [e.id, p ?? convertFileSrc(path)] as const)
          .catch(() => [e.id, convertFileSrc(path)] as const);
      }),
    ).then((results) => {
      if (active)
        setFilePreviews((prev) => ({
          ...prev,
          ...Object.fromEntries(results),
        }));
    });
    return () => {
      active = false;
    };
  }, [entries]);

  // Sync theme
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sc-theme") setTheme((e.newValue as AppTheme) ?? "dark");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (visible) {
      setTheme(readTheme());
      setSlots(readSlots());
    }
  }, [visible]);

  // Listen for entries
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<PastePayload>("paste-popup:entries", (event) => {
      if (cancelled) return;
      setRecentAll(event.payload.recent);
      setPinnedAll(event.payload.pinned);
      setSelectedIdx(0);
      setTab("recent");
      setVisible(true);
    }).then((fn) => {
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
        invoke("close_paste_popup").catch(console.error);
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

  const handleClose = useCallback(() => {
    setVisible(false);
    invoke("close_paste_popup").catch(console.error);
  }, []);

  const handlePaste = useCallback((id: string) => {
    invoke("paste_entry", { id }).catch(console.error);
    setVisible(false);
  }, []);

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    setSelectedIdx(0);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      const num = e.key === "0" ? 10 : parseInt(e.key);
      if (num >= 1 && num <= entries.length) {
        e.preventDefault();
        handlePaste(entries[num - 1].id);
        return;
      }

      switch (e.key) {
        case "Tab":
          e.preventDefault();
          switchTab(tab === "recent" ? "pinned" : "recent");
          break;
        case "ArrowDown":
          e.preventDefault();
          if (entries.length > 0)
            setSelectedIdx((i) => (i + 1) % entries.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (entries.length > 0)
            setSelectedIdx((i) => (i - 1 + entries.length) % entries.length);
          break;
        case "Enter":
          e.preventDefault();
          if (entries.length > 0) handlePaste(entries[selectedIdx].id);
          break;
        case "Escape":
          e.preventDefault();
          handleClose();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, entries, selectedIdx, tab, handlePaste, handleClose, switchTab]);

  const recentCount = recentAll.length;
  const pinnedCount = pinnedAll.length;

  return (
    <div
      className={`paste-container${visible ? " visible" : ""}`}
      data-theme={theme}
    >
      {/* Header */}
      <div className="paste-header">
        <div className="paste-header-left">
          <span className="paste-title">Quick Paste</span>
          <span className="paste-count">{entries.length}</span>
        </div>
        <div className="paste-tabs">
          <button
            className={`paste-tab${tab === "recent" ? " paste-tab--active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              switchTab("recent");
            }}
          >
            Recent
            {recentCount > 0 && (
              <span className="paste-tab-count">{recentCount}</span>
            )}
          </button>
          <button
            className={`paste-tab${tab === "pinned" ? " paste-tab--active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              switchTab("pinned");
            }}
          >
            Pinned
            {pinnedCount > 0 && (
              <span className="paste-tab-count">{pinnedCount}</span>
            )}
          </button>
        </div>
        <button
          className="paste-close"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleClose}
        >
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

      {/* <div className="paste-divider" /> */}

      {entries.length === 0 ? (
        <div className="paste-empty">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {tab === "pinned" ? (
              <>
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </>
            ) : (
              <>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </>
            )}
          </svg>
          <span>
            {tab === "pinned" ? "No pinned items" : "No recent items"}
          </span>
        </div>
      ) : (
        <div className="paste-list">
          {entries.map((entry, index) => (
            <React.Fragment key={entry.id}>
              <button
                className={`paste-item${index === selectedIdx ? " paste-item--selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handlePaste(entry.id);
                }}
                onMouseEnter={() => setSelectedIdx(index)}
              >
                <span className="paste-key-badge">{badgeLabel(index)}</span>

                {/* Type-specific preview */}
                {entry.type === "image" ? (
                  <div className="paste-preview-wrap">
                    <img
                      className="paste-thumb"
                      src={entry.content}
                      alt=""
                      draggable={false}
                    />
                    <span className="paste-filename">Image</span>
                  </div>
                ) : entry.type === "file" ? (
                  (() => {
                    const paths = getFilePaths(entry.content);
                    const isMulti = paths.length > 1;
                    const isExpanded = expandedIds.has(entry.id);
                    const singleIsImage =
                      !isMulti && paths[0] && isImagePath(paths[0]);
                    const thumbSrc = singleIsImage
                      ? (filePreviews[entry.id] ?? null)
                      : null;
                    return (
                      <>
                        <div className="paste-preview-wrap">
                          {singleIsImage && thumbSrc ? (
                            <img
                              className="paste-thumb"
                              src={thumbSrc}
                              alt=""
                              draggable={false}
                            />
                          ) : (
                            <span className="paste-item-icon">
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
                                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                                <polyline points="14 2 14 8 20 8" />
                              </svg>
                            </span>
                          )}
                          <span className="paste-filename">
                            {isMulti
                              ? `${paths.length} files`
                              : fileNameFromPath(paths[0])}
                          </span>
                          {isMulti && (
                            <span
                              className="paste-item-icon"
                              style={{ cursor: "pointer", marginLeft: "auto" }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setExpandedIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(entry.id)) next.delete(entry.id);
                                  else next.add(entry.id);
                                  return next;
                                });
                              }}
                            >
                              <svg
                                className={`paste-expand-chevron${isExpanded ? " open" : ""}`}
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            </span>
                          )}
                        </div>
                      </>
                    );
                  })()
                ) : (
                  <div className="paste-preview-wrap">
                    <span className="paste-text-snippet">
                      {textPreview(entry.content)}
                    </span>
                  </div>
                )}

                <span className="paste-item-meta">
                  {entry.pinned && (
                    <svg
                      className="paste-pin-icon"
                      width="9"
                      height="9"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 17v5" />
                      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                    </svg>
                  )}
                  <span className="paste-item-time">
                    {relativeTime(entry.timestamp)}
                  </span>
                </span>
              </button>
              {/* Expanded file list for multi-file entries */}
              {entry.type === "file" &&
                (() => {
                  const paths = getFilePaths(entry.content);
                  return paths.length > 1 && expandedIds.has(entry.id) ? (
                    <div className="paste-file-list">
                      {paths.map((f) => (
                        <div key={f} className="paste-file-list-item">
                          <span className="paste-file-icon">
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                          </span>
                          <span className="paste-file-name">
                            {fileNameFromPath(f)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null;
                })()}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};

export default PastePopup;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <PastePopup />,
);
