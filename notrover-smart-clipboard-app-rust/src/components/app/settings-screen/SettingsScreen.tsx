import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readSlots } from "../../../types";
import { ChevronDownIcon, CheckIcon, FolderIcon } from "../../icons";
import "./SettingsScreen.css";

const SLOT_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10];

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
        <ChevronDownIcon className="settings-select-chevron" size={10} strokeWidth={2.5} />
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
                <CheckIcon size={10} strokeWidth={2.8} />
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
  const [keepHistory, setKeepHistory] = useState(false);
  const [closeToTray, setCloseToTray] = useState(false);
  const [runOnStartup, setRunOnStartup] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [copyNotification, setCopyNotification] = useState(true);
  const [notifCopy, setNotifCopy] = useState(true);
  const [notifPaste, setNotifPaste] = useState(true);
  const [autosave, setAutosave] = useState(false);
  const [notifClosing, setNotifClosing] = useState(false);
  const autostartEnableBlocked = import.meta.env.DEV && !runOnStartup;

  // Load settings from backend on mount
  useEffect(() => {
    const loadBoolWithDefault = (key: string, setter: (v: boolean) => void, fallback: boolean) =>
      invoke<boolean | null>("get_setting", { key }).then((v) => { setter(v === true ? true : v === false ? false : fallback); });
    loadBoolWithDefault("keep_history", setKeepHistory, false);
    loadBoolWithDefault("close_to_tray", setCloseToTray, false);
    loadBoolWithDefault("start_minimized", setStartMinimized, false);
    loadBoolWithDefault("copy_notification", setCopyNotification, true);
    loadBoolWithDefault("notif_copy", setNotifCopy, true);
    loadBoolWithDefault("notif_paste", setNotifPaste, true);
    loadBoolWithDefault("autosave", setAutosave, false);
    invoke<boolean>("get_autostart").then(setRunOnStartup);
  }, []);

  const handleSlotsChange = (val: number) => {
    setPasteSlots(val);
    localStorage.setItem("sc-paste-slots", String(val));
  };

  const toggleBoolSetting = (
    current: boolean,
    setter: (v: boolean) => void,
    key: string,
  ) => {
    const next = !current;
    setter(next);
    invoke("set_setting", { key, value: next });
    // When enabling keep_history, do an initial full-history save so data is saved
    // immediately without waiting for the next clipboard change.
    if (key === "keep_history" && next) invoke("save_history");
  };

  const handleKeepToggle = () => toggleBoolSetting(keepHistory, setKeepHistory, "keep_history");
  const handleCloseToTrayToggle = () => toggleBoolSetting(closeToTray, setCloseToTray, "close_to_tray");
  const handleStartMinimizedToggle = () => toggleBoolSetting(startMinimized, setStartMinimized, "start_minimized");
  
  const handleCopyNotificationToggle = () => {
    if (copyNotification) {
      // Turning off - trigger closing animation first
      setNotifClosing(true);
      setTimeout(() => {
        toggleBoolSetting(copyNotification, setCopyNotification, "copy_notification");
        setNotifClosing(false);
      }, 180); // Match slideUp animation duration
    } else {
      // Turning on - no delay needed
      toggleBoolSetting(copyNotification, setCopyNotification, "copy_notification");
    }
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

        <div className="settings-row-with-children">
          <div className="settings-row-header">
            <div className="settings-row-info">
              <span className="settings-row-label">Notifications</span>
              <span className="settings-row-desc">
                Show a small popup at the bottom-right of the screen for
                clipboard operations. Use the checkboxes below to control which
                operations trigger notifications.
              </span>
            </div>
            <button
              type="button"
              className={`settings-toggle${copyNotification ? " active" : ""}`}
              onClick={handleCopyNotificationToggle}
              aria-pressed={copyNotification}
            >
              <span className="settings-toggle-knob" />
            </button>
          </div>

          {(copyNotification || notifClosing) && (
            <div className={`settings-child-checks${notifClosing ? " closing" : ""}`}>
              <label className="settings-checkbox-row">
                <span
                  className={`settings-checkbox${notifCopy ? " checked" : ""}`}
                  onClick={() => toggleBoolSetting(notifCopy, setNotifCopy, "notif_copy")}
                >
                  {notifCopy && <CheckIcon size={9} strokeWidth={3} />}
                </span>
                <div className="settings-checkbox-info">
                  <span className="settings-checkbox-label">Copy operations</span>
                  <span className="settings-checkbox-desc">
                    Show notification when content is copied via Ctrl+C or other methods
                  </span>
                </div>
              </label>
              <label className="settings-checkbox-row">
                <span
                  className={`settings-checkbox${notifPaste ? " checked" : ""}`}
                  onClick={() => toggleBoolSetting(notifPaste, setNotifPaste, "notif_paste")}
                >
                  {notifPaste && <CheckIcon size={9} strokeWidth={3} />}
                </span>
                <div className="settings-checkbox-info">
                  <span className="settings-checkbox-label">Paste operations</span>
                  <span className="settings-checkbox-desc">
                    Show notification when an entry is pasted via Ctrl+Shift+V
                  </span>
                </div>
              </label>
            </div>
          )}
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
            className={`settings-toggle${keepHistory ? " active" : ""}`}
            onClick={handleKeepToggle}
            aria-pressed={keepHistory}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Auto-save copied entries</span>
            <span className="settings-row-desc">
              Automatically add every new clipboard entry to the Saved group so
              it persists across restarts and is never cleaned up. The Save
              button in the copy popup will be hidden when this is enabled.
            </span>
          </div>
          <button
            type="button"
            className={`settings-toggle${autosave ? " active" : ""}`}
            onClick={() => toggleBoolSetting(autosave, setAutosave, "autosave")}
            aria-pressed={autosave}
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
            <FolderIcon />
            Open
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsScreen;
