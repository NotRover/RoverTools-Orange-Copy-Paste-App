import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./SettingsScreen.css";

const SLOT_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10];

function readSlots(): number {
  const v = parseInt(localStorage.getItem("sc-paste-slots") ?? "3", 10);
  return Number.isNaN(v) ? 3 : Math.max(3, Math.min(10, v));
}

interface CustomSelectProps {
  value: number;
  options: number[];
  onChange: (val: number) => void;
}

const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className={`settings-select-wrap${open ? " open" : ""}`} ref={ref}>
      <button
        className="settings-select-trigger"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span>{value}</span>
        <svg
          className="settings-select-chevron"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="settings-select-list">
          {options.map((n) => (
            <button
              key={n}
              type="button"
              className={`settings-select-option${n === value ? " active" : ""}`}
              onMouseDown={() => {
                onChange(n);
                setOpen(false);
              }}
            >
              {n}
              {n === value && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const SettingsScreen: React.FC = () => {
  const [pasteSlots, setPasteSlots] = useState(readSlots);
  const [persistHistory, setPersistHistory] = useState(false);
  const [closeToTray, setCloseToTray] = useState(false);
  const [runOnStartup, setRunOnStartup] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const autostartEnableBlocked = import.meta.env.DEV && !runOnStartup;

  // Load settings from backend on mount
  useEffect(() => {
    invoke<boolean | null>("get_setting", { key: "persist_history" }).then(
      (val) => {
        if (val === true) setPersistHistory(true);
      },
    );
    invoke<boolean | null>("get_setting", { key: "close_to_tray" }).then(
      (val) => {
        if (val === true) setCloseToTray(true);
      },
    );
    invoke<boolean>("get_autostart").then((val) => {
      setRunOnStartup(val);
    });
    invoke<boolean | null>("get_setting", { key: "start_minimized" }).then(
      (val) => {
        if (val === true) setStartMinimized(true);
      },
    );
  }, []);

  const handleSlotsChange = (val: number) => {
    setPasteSlots(val);
    localStorage.setItem("sc-paste-slots", String(val));
  };

  const handlePersistToggle = () => {
    const next = !persistHistory;
    setPersistHistory(next);
    invoke("set_setting", { key: "persist_history", value: next });
    // When enabling, do an initial full-history save so data is persisted
    // immediately without waiting for the next clipboard change.
    if (next) {
      invoke("save_history");
    }
  };

  const handleCloseToTrayToggle = () => {
    const next = !closeToTray;
    setCloseToTray(next);
    invoke("set_setting", { key: "close_to_tray", value: next });
  };

  const handleRunOnStartupToggle = async () => {
    const previous = runOnStartup;
    const next = !previous;
    setRunOnStartup(next);

    try {
      const ok = await invoke<boolean>("set_autostart", { enabled: next });
      if (!ok) {
        // Backend can refuse enabling autostart in debug/dev builds.
        setRunOnStartup(previous);
      }
    } catch (error) {
      setRunOnStartup(previous);
      console.error("Failed to toggle autostart:", error);
    }
  };
  123456789111;
  const handleStartMinimizedToggle = () => {
    const next = !startMinimized;
    setStartMinimized(next);
    invoke("set_setting", { key: "start_minimized", value: next });
  };

  return (
    <div className="settings-screen">
      <div className="settings-header">
        <h2 className="settings-title">Settings</h2>
        <p className="settings-subtitle">
          Manage your Orange Copy Paste preferences.
        </p>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">General</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Close to system tray</span>
            <span className="settings-row-desc">
              When enabled, closing the window minimizes the app to the system
              tray instead of quitting. The clipboard watcher keeps running in
              the background.
            </span>
          </div>
          <button
            type="button"
            className={`settings-toggle${closeToTray ? " active" : ""}`}
            onClick={handleCloseToTrayToggle}
            aria-pressed={closeToTray}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Run on startup</span>
            <span className="settings-row-desc">
              Automatically launch Orange Copy Paste when you sign in to
              Windows.
              {import.meta.env.DEV
                ? " Disabled in dev builds to prevent broken startup entries."
                : ""}
            </span>
          </div>
          <button
            type="button"
            className={`settings-toggle${runOnStartup ? " active" : ""}`}
            onClick={handleRunOnStartupToggle}
            aria-pressed={runOnStartup}
            disabled={autostartEnableBlocked}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Start minimized</span>
            <span className="settings-row-desc">
              When enabled, the app starts hidden in the system tray instead of
              showing the main window.
            </span>
          </div>
          <button
            type="button"
            className={`settings-toggle${startMinimized ? " active" : ""}`}
            onClick={handleStartMinimizedToggle}
            aria-pressed={startMinimized}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Quick Paste</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Paste Slots</span>
            <span className="settings-row-desc">
              Number of entries shown in the quick paste popup (Ctrl+Shift+V).
            </span>
          </div>
          <CustomSelect
            value={pasteSlots}
            options={SLOT_OPTIONS}
            onChange={handleSlotsChange}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">History</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">
              Keep history across app restarts
            </span>
            <span className="settings-row-desc">
              When enabled, your clipboard history is preserved when the app
              restarts. History is always cleared after a system reboot.
            </span>
          </div>
          <button
            type="button"
            className={`settings-toggle${persistHistory ? " active" : ""}`}
            onClick={handlePersistToggle}
            aria-pressed={persistHistory}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Data</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Open data folder</span>
            <span className="settings-row-desc">
              Open the folder where your clipboard history, pinned entries, and
              settings are stored.
            </span>
          </div>
          <button
            type="button"
            className="settings-action-btn"
            onClick={() => invoke("open_data_folder")}
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
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Open
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsScreen;
