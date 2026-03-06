import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./pastePopup.css";

type AppTheme = "dark" | "light";

function readTheme(): AppTheme {
  return (localStorage.getItem("sc-theme") as AppTheme) ?? "dark";
}

interface PopupEntry {
  id: string;
  type: "text" | "image" | "file";
  content: string;
  timestamp: number;
  pinned: boolean;
}

function preview(entry: PopupEntry): string {
  if (entry.type === "image") return "[Image]";
  if (entry.type === "file") {
    const paths = entry.content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (paths.length === 1) {
      return paths[0].split(/[\\/]/).pop() ?? paths[0];
    }
    return `${paths.length} files`;
  }
  return entry.content.length > 55
    ? entry.content.slice(0, 55) + "\u2026"
    : entry.content;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

const PastePopup: React.FC = () => {
  const [entries, setEntries] = useState<PopupEntry[]>([]);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [selectedIdx, setSelectedIdx] = useState(0);

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

  // Listen for entries
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<PopupEntry[]>("paste-popup:entries", (event) => {
      if (cancelled) return;
      setEntries(event.payload);
      setSelectedIdx(0);
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

  // Keyboard shortcuts
  useEffect(() => {
    if (!visible || entries.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      const num = parseInt(e.key);
      if (num >= 1 && num <= entries.length) {
        e.preventDefault();
        handlePaste(entries[num - 1].id);
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIdx((i) => (i + 1) % entries.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIdx((i) => (i - 1 + entries.length) % entries.length);
          break;
        case "Enter":
          e.preventDefault();
          handlePaste(entries[selectedIdx].id);
          break;
        case "Escape":
          e.preventDefault();
          handleClose();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, entries, selectedIdx, handlePaste, handleClose]);

  return (
    <div
      className={`paste-container${visible ? " visible" : ""}`}
      data-theme={theme}
    >
      {/* Header */}
      <div className="paste-header">
        <span className="paste-title">Quick Paste</span>
        <span className="paste-hint">1–{entries.length} to paste</span>
        <button className="paste-close" onClick={handleClose}>
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
        <div className="paste-empty">No recent items</div>
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
              <span className="paste-key-badge">{index + 1}</span>
              <span className="paste-item-icon">
                {entry.type === "image" ? (
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
                ) : entry.type === "file" ? (
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
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
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
                    <line x1="17" y1="10" x2="3" y2="10" />
                    <line x1="21" y1="6" x2="3" y2="6" />
                    <line x1="21" y1="14" x2="3" y2="14" />
                    <line x1="17" y1="18" x2="3" y2="18" />
                  </svg>
                )}
              </span>
              <span className="paste-item-text">{preview(entry)}</span>
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
