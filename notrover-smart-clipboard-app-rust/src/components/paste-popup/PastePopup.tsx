import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ClipboardEntry, AppTheme } from "../../types";
import {
  deriveDisplayKind,
  fileNameFromPath,
  htmlPlainText,
  isImageFile as isImagePath,
  isUrl,
  filePaths as getFilePaths,
  readSlots,
  readTheme,
  resolveImageSrc,
} from "../../types";
import { EntryTypePill } from "../entry-types/EntryTypePill";
import {
  CloseIcon,
  PinIcon,
  CopyIcon,
  ChevronDownIcon,
  FilePageIcon,
} from "../icons";
import "./pastePopup.css";

type Tab = "recent" | "pinned";

// Layout constants (must match Rust PASTE_POPUP_W)
const HEADER_H = 48; // header + divider + padding
const ITEM_H = 45; // item min-height (40) + border (2) + gap (3)
const BOTTOM_PAD = 0;
const BODY_PAD = 10; // body padding (6px top + 4px container bottom)
const MIN_EMPTY_H = 100;

function textPreview(content: string, max = 60): string {
  const line = content.replace(/[\r\n]+/g, " ").trim();
  return line.length > max ? line.slice(0, max) + "…" : line;
}

interface PastePayload {
  recent: ClipboardEntry[];
  pinned: ClipboardEntry[];
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
  const [recentAll, setRecentAll] = useState<ClipboardEntry[]>([]);
  const [pinnedAll, setPinnedAll] = useState<ClipboardEntry[]>([]);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [tab, setTab] = useState<Tab>("recent");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [slots, setSlots] = useState(readSlots);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filePreviews, setFilePreviews] = useState<
    Record<string, string | null>
  >({});
  const [missingFiles, setMissingFiles] = useState<Set<string>>(new Set());

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

  // Check for missing files in file entries
  useEffect(() => {
    const fileEntries = entries.filter((e) => e.type === "file");
    if (fileEntries.length === 0) {
      setMissingFiles(new Set());
      return;
    }
    let active = true;
    const allPaths = fileEntries.flatMap((e) => getFilePaths(e.content));
    invoke<string[]>("check_missing_files", { paths: allPaths })
      .then((missing) => {
        if (active) setMissingFiles(new Set(missing));
      })
      .catch(() => {});
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
        case "ArrowLeft":
          e.preventDefault();
          switchTab("recent");
          break;
        case "ArrowRight":
          e.preventDefault();
          switchTab("pinned");
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

  const recentCount = Math.min(recentAll.length, slots);
  const pinnedCount = Math.min(pinnedAll.length, slots);

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
          <CloseIcon size={10} />
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="paste-empty">
          {tab === "pinned" ? (
            <PinIcon size={28} filled strokeWidth={1.3} />
          ) : (
            <CopyIcon size={28} strokeWidth={1.3} />
          )}
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
                      src={resolveImageSrc(entry.content, convertFileSrc)}
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
                    const missingCount = isMulti
                      ? paths.filter((p) => missingFiles.has(p)).length
                      : 0;
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
                            <EntryTypePill
                              kind={deriveDisplayKind(entry as any)}
                            />
                          )}
                          <span className={`paste-filename${!isMulti && paths[0] && missingFiles.has(paths[0]) ? " paste-filename--missing" : ""}`}>
                            {isMulti
                              ? `${paths.length} files`
                              : fileNameFromPath(paths[0])}
                          </span>
                          {!isMulti && paths[0] && missingFiles.has(paths[0]) && (
                            <span className="paste-missing-hint">missing</span>
                          )}
                          {isMulti && missingCount > 0 && !isExpanded && (
                            <span className="paste-missing-hint">
                              {missingCount} missing
                            </span>
                          )}
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
                              <ChevronDownIcon
                                className={`paste-expand-chevron${isExpanded ? " open" : ""}`}
                                size={10}
                                strokeWidth={2.8}
                              />
                            </span>
                          )}
                        </div>
                      </>
                    );
                  })()
                ) : (
                  <div className="paste-preview-wrap">
                    <EntryTypePill kind={deriveDisplayKind(entry as any)} />
                    <span className="paste-filename">
                      {entry.type === "html"
                        ? textPreview(htmlPlainText(entry.content))
                        : isUrl(entry.content)
                          ? entry.content.trim().slice(0, 50)
                          : textPreview(entry.content)}
                    </span>
                  </div>
                )}

                <span className="paste-item-meta">
                  {entry.pinned && (
                    <PinIcon className="paste-pin-icon" size={9} filled />
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
                  if (paths.length <= 1 || !expandedIds.has(entry.id)) return null;
                  return (
                    <div className="paste-file-list">
                      {paths.map((f) => (
                        <div key={f} className={`paste-file-list-item${missingFiles.has(f) ? " paste-file-list-item--missing" : ""}`}>
                          <span className="paste-file-icon">
                            <FilePageIcon />
                          </span>
                          <span className="paste-file-name">
                            {fileNameFromPath(f)}
                          </span>
                          {missingFiles.has(f) && (
                            <span className="paste-missing-hint">missing</span>
                          )}
                        </div>
                      ))}
                    </div>
                  );
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
