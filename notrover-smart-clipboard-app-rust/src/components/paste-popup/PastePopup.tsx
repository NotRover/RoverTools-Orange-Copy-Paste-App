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

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of a clipboard entry sent to this popup from Rust. */
interface PopupEntry {
  id: string;
  /** Serialised as `"type"` from Rust's `#[serde(rename = "type")]` field. */
  type: "text" | "image" | "file";
  content: string;
  timestamp: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function preview(entry: PopupEntry): string {
  if (entry.type === "image") return "🖼️ [Image]";
  if (entry.type === "file") {
    const count = entry.content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length;
    return `📁 [${count} file${count === 1 ? "" : "s"}]`;
  }
  return entry.content.length > 60
    ? entry.content.slice(0, 60) + "…"
    : entry.content;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Paste-picker popup — shown near the cursor after Ctrl+Shift+V.
 *
 * Receives the top-3 history entries via the `"paste-popup:entries"` event
 * emitted by the Rust backend.  Clicking an item calls the `paste_entry`
 * Tauri command which writes to the clipboard and simulates Ctrl+V.
 */
const PastePopup: React.FC = () => {
  const [entries, setEntries] = useState<PopupEntry[]>([]);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);

  // Sync theme with main app via shared localStorage
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sc-theme") setTheme((e.newValue as AppTheme) ?? "dark");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Re-read theme on each popup show
  useEffect(() => {
    if (visible) setTheme(readTheme());
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    let actualUnlisten: (() => void) | undefined;
    listen<PopupEntry[]>("paste-popup:entries", (event) => {
      if (cancelled) return;
      setEntries(event.payload);
      setVisible(true);
    }).then((fn) => {
      if (cancelled) fn();
      else actualUnlisten = fn;
    });
    return () => {
      cancelled = true;
      actualUnlisten?.();
    };
  }, []);

  // Dismiss when the popup loses OS focus (user clicked/tabbed away)
  useEffect(() => {
    let cancelled = false;
    let actualUnlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .listen("tauri://blur", () => {
        if (cancelled) return;
        setVisible(false);
        invoke("close_paste_popup").catch(console.error);
      })
      .then((fn) => {
        if (cancelled) fn();
        else actualUnlisten = fn;
      });
    return () => {
      cancelled = true;
      actualUnlisten?.();
    };
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    invoke("close_paste_popup").catch(console.error);
  }, []);

  /** Write the entry to the clipboard and simulate Ctrl+V via Rust. */
  const handlePaste = useCallback((id: string) => {
    invoke("paste_entry", { id }).catch(console.error);
    setVisible(false);
  }, []);

  return (
    <div
      className={`paste-container${visible ? " visible" : ""}`}
      data-theme={theme}
    >
      {/* ── Header ──────────────────────────────── */}
      <div className="paste-header">
        <span className="paste-title">Paste Recent</span>
        <button className="paste-close" onClick={handleClose} title="Close">
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

      {/* ── Item list ────────────────────────────── */}
      {entries.length === 0 ? (
        <div className="paste-empty">No recent items</div>
      ) : (
        <div className="paste-list">
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              className="paste-item"
              onMouseDown={(e) => {
                // Prevent focus loss on the foreground app
                e.preventDefault();
                handlePaste(entry.id);
              }}
            >
              <span className="paste-item-icon">
                {entry.type === "image"
                  ? "🖼️"
                  : entry.type === "file"
                    ? "📁"
                    : "📋"}
              </span>
              <span className="paste-item-text">
                <span className="paste-item-index">{index + 1}. </span>
                {preview(entry)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default PastePopup;

// ── Mount ────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <PastePopup />,
);
