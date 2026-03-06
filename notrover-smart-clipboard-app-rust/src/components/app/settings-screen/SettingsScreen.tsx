import React, { useState } from "react";
import "./SettingsScreen.css";

const SLOT_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10];

function readSlots(): number {
  const v = parseInt(localStorage.getItem("sc-paste-slots") ?? "3", 10);
  return Number.isNaN(v) ? 3 : Math.max(3, Math.min(10, v));
}

const SettingsScreen: React.FC = () => {
  const [pasteSlots, setPasteSlots] = useState(readSlots);

  const handleSlotsChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = parseInt(e.target.value, 10);
    setPasteSlots(val);
    localStorage.setItem("sc-paste-slots", String(val));
  };

  return (
    <div className="settings-screen">
      <div className="settings-header">
        <h2 className="settings-title">Settings</h2>
        <p className="settings-subtitle">
          Manage your Smart Clipboard preferences.
        </p>
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
          <select
            className="settings-select"
            value={pasteSlots}
            onChange={handleSlotsChange}
          >
            {SLOT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
};

export default SettingsScreen;
