import React, { useEffect, useRef, useState } from "react";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { invoke } from "@tauri-apps/api/core";
import { readSlots } from "../../../types";
import {
  CaretDown,
  Check,
  FolderOpen,
  SlidersHorizontal,
  ClipboardText,
  ClockCounterClockwise,
  ArrowClockwise,
  DownloadSimple,
  Bell,
  SpeakerHigh,
  Play,
} from "@phosphor-icons/react";
import { useUpdater } from "../../../hooks/useUpdater";
import { SYNC_BADGE_SETTING_EVENT } from "../../../hooks/useEntrySyncStates";
import { configureSounds, playCue } from "../../../sounds";
import { parseNotes, hasParsedNotes } from "../update-banner/parseNotes";
import "./SettingsScreen.css";

const SLOT_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10];

// The four cues a user cannot trigger on demand from this screen. Copying and
// pasting are left out: their own checkboxes play them when ticked.
const CUE_TESTS = [
  { cue: "arrived" as const, label: "Arrived" },
  { cue: "knock" as const, label: "Invite" },
  { cue: "unlocked" as const, label: "Unlocked" },
  { cue: "refused" as const, label: "Refused" },
];

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
        <CaretDown className="settings-select-chevron" size={10} weight="bold" />
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
              {n === value && <Check size={10} weight="bold" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Row primitives ─────────────────────────────────────────────────────

const ToggleRow: React.FC<{
  label: string;
  desc: string;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
}> = ({ label, desc, active, onToggle, disabled }) => (
  <div className="set-row">
    <div className="set-row-info">
      <span className="set-row-label">{label}</span>
      <span className="set-row-desc">{desc}</span>
    </div>
    <button
      type="button"
      className={`settings-toggle${active ? " active" : ""}`}
      onClick={onToggle}
      aria-pressed={active}
      disabled={disabled}
    >
      <span className="settings-toggle-knob" />
    </button>
  </div>
);

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
  const [showSyncBadges, setShowSyncBadges] = useState(true);
  const [notifClosing, setNotifClosing] = useState(false);

  // ── Sound and OS notifications ─────────────────────────────────
  const [sound, setSound] = useState(true);
  const [soundCopy, setSoundCopy] = useState(false);
  const [soundPaste, setSoundPaste] = useState(false);
  const [soundClosing, setSoundClosing] = useState(false);
  const [osNotifications, setOsNotifications] = useState(true);
  const autostartEnableBlocked = import.meta.env.DEV && !runOnStartup;

  // ── Updates ────────────────────────────────────────────────────
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [betaChannel, setBetaChannel] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  // Its own instance, independent of App's: this one drives the manual check and
  // its result, while App's drives the banner. Both read the same Rust-side state,
  // so they agree on what is pending.
  const updater = useUpdater();

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
    loadBool("show_sync_badges", setShowSyncBadges, true);
    loadBool("sound", setSound, true);
    loadBool("sound_copy", setSoundCopy, false);
    loadBool("sound_paste", setSoundPaste, false);
    loadBool("os_notifications", setOsNotifications, true);
    loadBool("auto_check_updates", setAutoCheckUpdates, true);
    invoke<string | null>("get_setting", { key: "update_channel" })
      .then((v) => setBetaChannel(v === "beta"))
      .catch(() => {});
    invoke<boolean>("get_autostart").then(setRunOnStartup);
    invoke<string>("updater_current_version").then(setAppVersion).catch(() => {});
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

  // Sounds live in the frontend, so the module that plays them is told directly
  // as well as written to disk: the setting has to take effect on the next cue,
  // not on the next launch.
  const handleSoundToggle = () => {
    const next = !sound;
    if (!next) setSoundClosing(true);
    const commit = () => {
      toggleBoolSetting(sound, setSound, "sound");
      configureSounds({ enabled: next });
      setSoundClosing(false);
      if (next) playCue("arrived", true);
    };
    if (next) commit();
    else setTimeout(commit, 180);
  };

  const handleSoundCue = (key: "sound_copy" | "sound_paste") => {
    const isCopy = key === "sound_copy";
    const next = !(isCopy ? soundCopy : soundPaste);
    (isCopy ? setSoundCopy : setSoundPaste)(next);
    invoke("set_setting", { key, value: next });
    configureSounds(isCopy ? { copy: next } : { paste: next });
    if (next) playCue(isCopy ? "copy" : "paste", true);
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

  // ── Update handlers ─────────────────────────────────────────────
  // "Nothing found" and "not checked yet" are the same stage on the Rust side,
  // and only one of them should say "you're up to date".
  const [checkedOnce, setCheckedOnce] = useState(false);
  const handleCheckUpdates = async () => {
    setCheckedOnce(true);
    await updater.check();
  };

  // Switching channel changes which feed is asked, so the previous answer is
  // stale — re-check immediately rather than leaving a result from the old one on
  // screen.
  const handleBetaToggle = async () => {
    const next = !betaChannel;
    setBetaChannel(next);
    await invoke("set_setting", { key: "update_channel", value: next ? "beta" : "stable" });
    setCheckedOnce(true);
    await updater.check();
  };

  const updateStatus = (() => {
    switch (updater.stage) {
      case "checking":
        return "Checking...";
      case "available":
        return `Version ${updater.info?.version} is available.`;
      case "downloading":
        return updater.percent === null
          ? "Downloading..."
          : `Downloading ${updater.percent}%`;
      case "ready":
        return `Version ${updater.info?.version} is downloaded and ready to install.`;
      case "installing":
        return "Installing...";
      case "error":
        return updater.error;
      default:
        return checkedOnce ? "You're up to date." : null;
    }
  })();

  const updateBusy = updater.stage === "checking" || updater.stage === "downloading" || updater.stage === "installing";

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="settings-screen">
      <div className="settings-inner">
        <header className="scr-head">
          <span className="scr-eyebrow">Preferences</span>
          <h2 className="scr-title">Settings</h2>
          <p className="scr-subtitle">Tune how Orange Copy Paste behaves on this device.</p>
        </header>

        {/* ── General ── */}
        <section className="set-section">
          <div className="set-section-head">
            <span className="set-section-icon"><SlidersHorizontal size={15} /></span>
            <h3 className="set-section-title">General</h3>
          </div>
          <div className="set-group">
            <ToggleRow
              label="Close to system tray"
              desc="Closing the window minimizes the app to the system tray instead of quitting."
              active={closeToTray}
              onToggle={handleCloseToTrayToggle}
            />
            <ToggleRow
              label="Run on startup"
              desc={`Automatically launch when you sign in to Windows.${import.meta.env.DEV ? " Disabled in dev builds." : ""}`}
              active={runOnStartup}
              onToggle={handleRunOnStartupToggle}
              disabled={autostartEnableBlocked}
            />
            <ToggleRow
              label="Start minimized"
              desc="Start hidden in the system tray instead of showing the main window."
              active={startMinimized}
              onToggle={handleStartMinimizedToggle}
            />
            <ToggleRow
              label="Show splash screen on startup"
              desc="Display a brief startup screen when the app launches."
              active={showSplash}
              onToggle={() => toggleBoolSetting(showSplash, setShowSplash, "show_splash")}
            />
            <ToggleRow
              label="Show sync badges on cards"
              desc="The cloud icon that marks whether an entry has reached the server. Turning it off changes nothing about what syncs."
              active={showSyncBadges}
              onToggle={() => {
                const next = !showSyncBadges;
                toggleBoolSetting(showSyncBadges, setShowSyncBadges, "show_sync_badges");
                // Open screens read the setting once on mount, so hand them the
                // new value directly rather than racing the write to disk.
                document.dispatchEvent(
                  new CustomEvent(SYNC_BADGE_SETTING_EVENT, { detail: next }),
                );
              }}
            />
          </div>
        </section>

        {/* ── Notifications ── */}
        <section className="set-section">
          <div className="set-section-head">
            <span className="set-section-icon"><Bell size={15} /></span>
            <h3 className="set-section-title">Notifications</h3>
          </div>
          <div className="set-group">
            <ToggleRow
              label="Desktop notifications"
              desc="Show Windows notifications while the app is in the background."
              active={osNotifications}
              onToggle={() => toggleBoolSetting(osNotifications, setOsNotifications, "os_notifications")}
            />
            <div className="set-row set-row--stack">
              <div className="set-row-header">
                <div className="set-row-info">
                  <span className="set-row-label">In-app popup</span>
                  <span className="set-row-desc">
                    A small popup at the bottom-right.
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
                <div className={`set-child-checks${notifClosing ? " closing" : ""}`}>
                  <label className="settings-checkbox-row">
                    <span
                      className={`settings-checkbox${notifCopy ? " checked" : ""}`}
                      onClick={() => toggleBoolSetting(notifCopy, setNotifCopy, "notif_copy")}
                    >
                      {notifCopy && <Check size={9} weight="bold" />}
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
                      {notifPaste && <Check size={9} weight="bold" />}
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
        </section>

        {/* ── Sounds ── */}
        <section className="set-section">
          <div className="set-section-head">
            <span className="set-section-icon"><SpeakerHigh size={15} /></span>
            <h3 className="set-section-title">Sounds</h3>
          </div>
          <div className="set-group">
            <div className="set-row">
              <div className="set-row-info">
                <span className="set-row-label">Test sounds</span>
                <span className="set-row-desc">Hear what each one means.</span>
              </div>
              <div className="set-cue-tests">
                {CUE_TESTS.map(({ cue, label }) => (
                  <button
                    key={cue}
                    type="button"
                    className="set-cue-test"
                    onClick={() => playCue(cue, true)}
                  >
                    <Play size={8} weight="fill" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* The expanding row goes last: the panel that slides out rounds off
                the bottom of the group, so a row underneath would leave it
                squared and running into the next one. */}
            <div className="set-row set-row--stack">
              <div className="set-row-header">
                <div className="set-row-info">
                  <span className="set-row-label">Sounds</span>
                  <span className="set-row-desc">
                    Shared items, invites, and spaces opening up.
                  </span>
                </div>
                <button
                  type="button"
                  className={`settings-toggle${sound ? " active" : ""}`}
                  onClick={handleSoundToggle}
                  aria-pressed={sound}
                >
                  <span className="settings-toggle-knob" />
                </button>
              </div>
              {(sound || soundClosing) && (
                <div className={`set-child-checks${soundClosing ? " closing" : ""}`}>
                  <label className="settings-checkbox-row">
                    <span
                      className={`settings-checkbox${soundCopy ? " checked" : ""}`}
                      onClick={() => handleSoundCue("sound_copy")}
                    >
                      {soundCopy && <Check size={9} weight="bold" />}
                    </span>
                    <div className="settings-checkbox-info">
                      <span className="settings-checkbox-label">Copying</span>
                      <span className="settings-checkbox-desc">
                        A click when you copy in the app.
                      </span>
                    </div>
                  </label>
                  <label className="settings-checkbox-row">
                    <span
                      className={`settings-checkbox${soundPaste ? " checked" : ""}`}
                      onClick={() => handleSoundCue("sound_paste")}
                    >
                      {soundPaste && <Check size={9} weight="bold" />}
                    </span>
                    <div className="settings-checkbox-info">
                      <span className="settings-checkbox-label">Pasting</span>
                      <span className="settings-checkbox-desc">
                        A click when you paste from the popup.
                      </span>
                    </div>
                  </label>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Quick Paste ── */}
        <section className="set-section">
          <div className="set-section-head">
            <span className="set-section-icon"><ClipboardText size={15} /></span>
            <h3 className="set-section-title">Quick Paste</h3>
          </div>
          <div className="set-group">
            <div className="set-row">
              <div className="set-row-info">
                <span className="set-row-label">Paste slots</span>
                <span className="set-row-desc">
                  Number of entries shown in the quick paste popup.
                </span>
              </div>
              <CustomSelect value={pasteSlots} options={SLOT_OPTIONS} onChange={handleSlotsChange} />
            </div>
          </div>
        </section>

        {/* ── History ── */}
        <section className="set-section">
          <div className="set-section-head">
            <span className="set-section-icon"><ClockCounterClockwise size={15} /></span>
            <h3 className="set-section-title">History</h3>
          </div>
          <div className="set-group">
            <ToggleRow
              label="Keep history across app restarts"
              desc="Clipboard history is preserved when the app restarts (cleared after reboot)."
              active={keepHistory}
              onToggle={handleKeepToggle}
            />
            <ToggleRow
              label="Auto-save copied entries"
              desc="Automatically add every new clipboard entry to the Saved group."
              active={autosave}
              onToggle={() => toggleBoolSetting(autosave, setAutosave, "autosave")}
            />
          </div>
        </section>

        {/* ── Data ── */}
        <section className="set-section">
          <div className="set-section-head">
            <span className="set-section-icon"><FolderOpen size={15} /></span>
            <h3 className="set-section-title">Data</h3>
          </div>
          <div className="set-group">
            <div className="set-row">
              <div className="set-row-info">
                <span className="set-row-label">Open data folder</span>
                <span className="set-row-desc">
                  Open the folder where clipboard history, pinned entries, and settings are stored.
                </span>
              </div>
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => invoke("open_data_folder")}
              >
                <FolderOpen size={14} />
                Open
              </button>
            </div>
          </div>
        </section>

        {/* ── Updates ── */}
        <section className="set-section">
          <div className="set-section-head">
            <span className="set-section-icon"><DownloadSimple size={15} /></span>
            <h3 className="set-section-title">Updates</h3>
          </div>
          <div className="set-group">
            <div className="set-row set-row--stack">
              <div className="set-row-header">
                <div className="set-row-info">
                  <span className="set-row-label">
                    App version{appVersion && ` ${appVersion}`}
                  </span>
                  <span className="set-row-desc">
                    {updateStatus ?? "Check whether a newer version has been released."}
                  </span>
                </div>
                {/* Once downloaded, the only remaining step is the restart — so the
                    button becomes that, rather than offering a second download. */}
                {updater.stage === "ready" ? (
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={updater.install}
                    disabled={updateBusy}
                  >
                    <ArrowClockwise size={14} />
                    Restart &amp; install
                  </button>
                ) : updater.stage === "available" ? (
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={updater.download}
                    disabled={updateBusy}
                  >
                    <DownloadSimple size={14} />
                    Download
                  </button>
                ) : (
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={handleCheckUpdates}
                    disabled={updateBusy}
                  >
                    <ArrowClockwise size={14} />
                    {updater.stage === "checking" ? "Checking..." : "Check now"}
                  </button>
                )}
              </div>
              {updater.info?.notes &&
                updater.stage !== "idle" &&
                (() => {
                  const notes = parseNotes(updater.info.notes);
                  if (!hasParsedNotes(notes)) return null;
                  return (
                    <div className="set-update-notes">
                      {notes.lead && (
                        <p className="set-update-lead">{notes.lead}</p>
                      )}
                      {notes.sections.map((section, i) => (
                        <div className="set-update-group" key={i}>
                          {section.title && (
                            <span className="set-update-section">
                              {section.title}
                            </span>
                          )}
                          <ul className="set-update-list">
                            {section.items.map((item, j) => (
                              <li key={j}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  );
                })()}
            </div>
            <ToggleRow
              label="Check for updates automatically"
              desc="Look for a newer version shortly after the app starts. Updates are never installed without asking."
              active={autoCheckUpdates}
              onToggle={() =>
                toggleBoolSetting(autoCheckUpdates, setAutoCheckUpdates, "auto_check_updates")
              }
            />
            <ToggleRow
              label="Get beta versions"
              desc="Receive new features early, alongside every normal release. Betas are tested less, so expect the occasional rough edge. Turning this off stops future betas. It cannot move you back to an older version."
              active={betaChannel}
              onToggle={handleBetaToggle}
            />
          </div>
        </section>
      </div>
    </div>
  );
};

export default SettingsScreen;
