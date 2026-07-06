import React, { useEffect, useRef, useState } from "react";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { invoke } from "@tauri-apps/api/core";
import { readSlots } from "../../../types";
import {
  ChevronDownIcon,
  CheckIcon,
  FolderIcon,
} from "../../icons";
import "./SettingsScreen.css";

const SLOT_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10];

// ── Shared sub-components ──────────────────────────────────────────────

interface CustomSelectProps {
  value: number;
  options: number[];
  onChange: (val: number) => void;
}

const CustomSelect: React.FC<CustomSelectProps> = ({ value, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, open, () => setOpen(false));

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
              onMouseDown={() => { onChange(n); setOpen(false); }}
            >
              {n}
              {n === value && <CheckIcon size={10} strokeWidth={2.8} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────

const SettingsScreen: React.FC = () => {
  // ── General settings ───────────────────────────────────────────
  const [pasteSlots, setPasteSlots] = useState(readSlots);
  const [keepHistory, setKeepHistory] = useState(false);
  const [closeToTray, setCloseToTray] = useState(false);
  const [runOnStartup, setRunOnStartup] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  const [notifCopy, setNotifCopy] = useState(true);
  const [notifPaste, setNotifPaste] = useState(true);
  const [autosave, setAutosave] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [notifClosing, setNotifClosing] = useState(false);
  const autostartEnableBlocked = import.meta.env.DEV && !runOnStartup;

  // ── Load settings on mount ──────────────────────────────────────
  useEffect(() => {
    const loadBool = (key: string, setter: (v: boolean) => void, fallback: boolean) =>
      invoke<boolean | null>("get_setting", { key }).then((v) => {
        setter(v === true ? true : v === false ? false : fallback);
      });

    loadBool("keep_history", setKeepHistory, false);
    loadBool("close_to_tray", setCloseToTray, false);
    loadBool("start_minimized", setStartMinimized, false);
    loadBool("notification", setNotificationEnabled, true);
    loadBool("notif_copy", setNotifCopy, true);
    loadBool("notif_paste", setNotifPaste, true);
    loadBool("autosave", setAutosave, false);
    loadBool("show_splash", setShowSplash, true);
    invoke<boolean>("get_autostart").then(setRunOnStartup);
  }, []);

  // ── General settings handlers ───────────────────────────────────
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
    if (key === "keep_history" && next) invoke("save_history");
  };

  const handleKeepToggle = () => toggleBoolSetting(keepHistory, setKeepHistory, "keep_history");
  const handleCloseToTrayToggle = () => toggleBoolSetting(closeToTray, setCloseToTray, "close_to_tray");
  const handleStartMinimizedToggle = () => toggleBoolSetting(startMinimized, setStartMinimized, "start_minimized");

  const handleNotificationToggle = () => {
    if (notificationEnabled) {
      setNotifClosing(true);
      setTimeout(() => {
        toggleBoolSetting(notificationEnabled, setNotificationEnabled, "notification");
        setNotifClosing(false);
      }, 180);
    } else {
      toggleBoolSetting(notificationEnabled, setNotificationEnabled, "notification");
    }
  };

  const handleRunOnStartupToggle = async () => {
    const previous = runOnStartup;
    const next = !previous;
    setRunOnStartup(next);
    try {
      const ok = await invoke<boolean>("set_autostart", { enabled: next });
      if (!ok) setRunOnStartup(previous);
    } catch {
      setRunOnStartup(previous);
    }
  };

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="settings-screen">
      <div className="settings-header">
        <h2 className="settings-title">Settings</h2>
        <p className="settings-subtitle">Manage your Orange Copy Paste preferences.</p>
      </div>

      {/* ── General ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">General</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Close to system tray</span>
            <span className="settings-row-desc">
              Closing the window minimizes the app to the system tray instead of quitting.
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
              Automatically launch when you sign in to Windows.
              {import.meta.env.DEV ? " Disabled in dev builds." : ""}
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
              Start hidden in the system tray instead of showing the main window.
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

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Show splash screen on startup</span>
            <span className="settings-row-desc">
              Display a brief startup screen when the app launches.
            </span>
          </div>
          <button
            type="button"
            className={`settings-toggle${showSplash ? " active" : ""}`}
            onClick={() => toggleBoolSetting(showSplash, setShowSplash, "show_splash")}
            aria-pressed={showSplash}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div className="settings-row-with-children">
          <div className="settings-row-header">
            <div className="settings-row-info">
              <span className="settings-row-label">Notifications</span>
              <span className="settings-row-desc">
                Show a popup at the bottom-right for clipboard operations.
              </span>
            </div>
            <button
              type="button"
              className={`settings-toggle${notificationEnabled ? " active" : ""}`}
              onClick={handleNotificationToggle}
              aria-pressed={notificationEnabled}
            >
              <span className="settings-toggle-knob" />
            </button>
          </div>
          {(notificationEnabled || notifClosing) && (
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
                  <span className="settings-checkbox-desc">Show notification on Ctrl+C</span>
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
                  <span className="settings-checkbox-desc">Show notification on Ctrl+Shift+V</span>
                </div>
              </label>
            </div>
          )}
        </div>
      </div>

      {/* ── Quick Paste ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">Quick Paste</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Paste Slots</span>
            <span className="settings-row-desc">
              Number of entries shown in the quick paste popup (Ctrl+Shift+V).
            </span>
          </div>
          <CustomSelect value={pasteSlots} options={SLOT_OPTIONS} onChange={handleSlotsChange} />
        </div>
      </div>

      {/* ── History ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">History</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Keep history across app restarts</span>
            <span className="settings-row-desc">
              Clipboard history is preserved when the app restarts (cleared after reboot).
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
              Automatically add every new clipboard entry to the Saved group.
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

      {/* ── Data ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">Data</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Open data folder</span>
            <span className="settings-row-desc">
              Open the folder where clipboard history, pinned entries, and settings are stored.
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
