import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./pastePopup.css";

type AppTheme = "dark" | "light";
type Tab = "recent" | "pinned";

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

function textPreview(content: string, max = 48): string {
  const line = content.replace(/[\r\n]+/g, " ").trim();
  return line.length > max ? line.slice(0, max) + "…" : line;
}

function filePreview(content: string): string {
  const paths = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (paths.length === 1) return paths[0].split(/[\\/]/).pop() ?? paths[0];
  return `${paths.length} files`;
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

const PastePopup: React.FC = () => {
  const [recentAll, setRecentAll] = useState<PopupEntry[]>([]);
  const [pinnedAll, setPinnedAll] = useState<PopupEntry[]>([]);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [tab, setTab] = useState<Tab>("recent");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [slots, setSlots] = useState(readSlots);

  // Active entries for the current tab, sliced to slot count
  const entries = useMemo(() => {
    const src = tab === "pinned" ? pinnedAll : recentAll;
    return src.slice(0, slots);
  }, [tab, recentAll, pinnedAll, slots]);

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
      // Number keys: 1-9 → index 0-8, 0 → index 9
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

  return (
    <div
      className={`paste-container${visible ? " visible" : ""}`}
      data-theme={theme}
    >
      {/* Header */}
      <div className="paste-header">
        <span className="paste-title">Quick Paste</span>
        <div className="paste-tabs">
          <button
            className={`paste-tab${tab === "recent" ? " paste-tab--active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              switchTab("recent");
            }}
          >
            Recent
          </button>
          <button
            className={`paste-tab${tab === "pinned" ? " paste-tab--active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              switchTab("pinned");
            }}
          >
            Pinned
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

      <div className="paste-divider" />

      {entries.length === 0 ? (
        <div className="paste-empty">
          {tab === "pinned" ? "No pinned items" : "No recent items"}
        </div>
      ) : (
        <div className="paste-list">
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              className={`paste-item${index === selectedIdx ? " paste-item--selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                handlePaste(entry.id);
              }}
              onMouseEnter={() => setSelectedIdx(index)}
            >
              <span className="paste-key-badge">{badgeLabel(index)}</span>

              {/* Preview: thumbnail for images, icon+text for others */}
              {entry.type === "image" ? (
                <img
                  className="paste-thumb"
                  src={entry.content}
                  alt=""
                  draggable={false}
                />
              ) : (
                <span className="paste-item-icon">
                  {entry.type === "file" ? (
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
                      <line x1="17" y1="10" x2="3" y2="10" />
                      <line x1="21" y1="6" x2="3" y2="6" />
                      <line x1="21" y1="14" x2="3" y2="14" />
                      <line x1="17" y1="18" x2="3" y2="18" />
                    </svg>
                  )}
                </span>
              )}

              <span className="paste-item-text">
                {entry.type === "image"
                  ? "Image"
                  : entry.type === "file"
                    ? filePreview(entry.content)
                    : textPreview(entry.content)}
              </span>

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
