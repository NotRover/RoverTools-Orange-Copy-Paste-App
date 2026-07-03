import React, { useCallback, useEffect, useRef, useState } from "react";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SyncUser, SyncGroup, SyncStatusInfo, SharingSession } from "../../../types";
import { readSlots } from "../../../types";
import {
  ChevronDownIcon,
  CheckIcon,
  FolderIcon,
  CloudSyncIcon,
  UsersIcon,
  ShareIcon,
} from "../../icons";
import "./SettingsScreen.css";

const SLOT_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10];
const SCOPE_OPTIONS: { value: string; label: string }[] = [
  { value: "clipboard", label: "Clipboard" },
  { value: "notes", label: "Notes" },
  { value: "both", label: "Clipboard & Notes" },
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

  // ── Cloud Sync ─────────────────────────────────────────────────
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [serverUrl, setServerUrl] = useState("https://api.orangeclipboard.app");
  const [serverUrlDraft, setServerUrlDraft] = useState("https://api.orangeclipboard.app");
  const [editingUrl, setEditingUrl] = useState(false);
  const [syncUser, setSyncUser] = useState<SyncUser | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusInfo | null>(null);
  const [syncGroups, setSyncGroups] = useState<SyncGroup[]>([]);

  // Login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Group management
  const [newGroupName, setNewGroupName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [groupLoading, setGroupLoading] = useState(false);
  const [copiedGroupId, setCopiedGroupId] = useState<string | null>(null);
  const copiedGroupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync actions
  const [syncNowLoading, setSyncNowLoading] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);

  // ── Live Share ─────────────────────────────────────────────────
  const [sharingSessions, setSharingSessions] = useState<SharingSession[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteScope, setInviteScope] = useState("clipboard");
  const [inviteResult, setInviteResult] = useState<{
    invite_code: string;
    share_group_id: string;
    expires_at: number;
  } | null>(null);
  const [acceptCode, setAcceptCode] = useState("");
  const [acceptScope, setAcceptScope] = useState("clipboard");
  const [sharingLoading, setSharingLoading] = useState(false);
  const [incomingInvite, setIncomingInvite] = useState<{
    invite_code: string;
    from_email?: string;
  } | null>(null);

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

    // Cloud sync settings
    invoke<boolean | null>("get_setting", { key: "sync_enabled" }).then((v) =>
      setSyncEnabled(v === true),
    );
    invoke<string | null>("get_setting", { key: "sync_server_url" }).then((v) => {
      const url = typeof v === "string" && v ? v : "https://api.orangeclipboard.app";
      setServerUrl(url);
      setServerUrlDraft(url);
    });

    // Sync user + status
    invoke<SyncUser | null>("sync_get_user").then((u) => {
      setSyncUser(u);
      if (u) {
        invoke<SyncGroup[]>("sync_get_groups").then(setSyncGroups).catch(() => {});
        invoke<SharingSession[]>("sharing_get_sessions").then(setSharingSessions).catch(() => {});
        invoke<SyncStatusInfo>("sync_get_status").then((s) => {
          setSyncStatus(s);
          if (s.last_synced_at) setLastSynced(s.last_synced_at);
        }).catch(() => {});
      }
    });
  }, []);

  // ── Listen for incoming sharing invites ─────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ invite_code: string; from_email?: string }>(
      "sharing:invite-received",
      (event) => setIncomingInvite(event.payload),
    ).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
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

  // ── Cloud Sync handlers ─────────────────────────────────────────
  const handleSyncToggle = async () => {
    const next = !syncEnabled;
    setSyncEnabled(next);
    try {
      await invoke("sync_set_enabled", { enabled: next });
    } catch (e) {
      setSyncEnabled(!next);
      console.error("sync_set_enabled failed", e);
    }
  };

  const handleSaveUrl = async () => {
    setServerUrl(serverUrlDraft);
    setEditingUrl(false);
    try {
      await invoke("sync_set_server_url", { url: serverUrlDraft });
    } catch (e) {
      console.error("sync_set_server_url failed", e);
    }
  };

  const handleLogin = async () => {
    if (!loginEmail || !loginPassword) return;
    setLoginLoading(true);
    setLoginError(null);
    try {
      const user = await invoke<SyncUser>("sync_login", {
        email: loginEmail,
        password: loginPassword,
        deviceName: `Orange CP — ${navigator.platform || "Desktop"}`,
      });
      setSyncUser(user);
      setLoginEmail("");
      setLoginPassword("");
      // Load groups and sessions after login
      invoke<SyncGroup[]>("sync_get_groups").then(setSyncGroups).catch(() => {});
      invoke<SharingSession[]>("sharing_get_sessions").then(setSharingSessions).catch(() => {});
      invoke<SyncStatusInfo>("sync_get_status").then((s) => {
        setSyncStatus(s);
        if (s.last_synced_at) setLastSynced(s.last_synced_at);
      }).catch(() => {});
    } catch (e) {
      setLoginError(typeof e === "string" ? e : "Login failed. Check your credentials.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await invoke("sync_logout");
      setSyncUser(null);
      setSyncStatus(null);
      setSyncGroups([]);
      setSharingSessions([]);
    } catch (e) {
      console.error("sync_logout failed", e);
    }
  };

  const handleSyncNow = async () => {
    setSyncNowLoading(true);
    try {
      await invoke("sync_now");
      const s = await invoke<SyncStatusInfo>("sync_get_status");
      setSyncStatus(s);
      setLastSynced(Date.now());
    } catch (e) {
      console.error("sync_now failed", e);
    } finally {
      setSyncNowLoading(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    setGroupLoading(true);
    try {
      const g = await invoke<SyncGroup>("sync_create_group", { name: newGroupName.trim() });
      setSyncGroups((prev) => [...prev, g]);
      setNewGroupName("");
    } catch (e) {
      console.error("sync_create_group failed", e);
    } finally {
      setGroupLoading(false);
    }
  };

  const handleJoinGroup = async () => {
    if (!joinCode.trim()) return;
    setGroupLoading(true);
    try {
      await invoke("sync_join_group", { inviteCode: joinCode.trim() });
      setJoinCode("");
      const groups = await invoke<SyncGroup[]>("sync_get_groups");
      setSyncGroups(groups);
    } catch (e) {
      console.error("sync_join_group failed", e);
    } finally {
      setGroupLoading(false);
    }
  };

  const handleLeaveGroup = async (groupId: string) => {
    try {
      await invoke("sync_leave_group", { groupId });
      setSyncGroups((prev) => prev.filter((g) => g.id !== groupId));
    } catch (e) {
      console.error("sync_leave_group failed", e);
    }
  };

  const handleCopyInvite = useCallback((groupId: string) => {
    if (copiedGroupTimerRef.current !== null) clearTimeout(copiedGroupTimerRef.current);
    const url = `https://orangeclipboard.app/join/${groupId}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setCopiedGroupId(groupId);
    copiedGroupTimerRef.current = setTimeout(() => {
      setCopiedGroupId(null);
      copiedGroupTimerRef.current = null;
    }, 1500);
  }, []);

  // ── Live Share handlers ─────────────────────────────────────────
  const handleShareInvite = async () => {
    if (!inviteEmail.trim()) return;
    setSharingLoading(true);
    try {
      const result = await invoke<{ invite_code: string; share_group_id: string; expires_at: number }>(
        "sharing_invite",
        { email: inviteEmail.trim(), scope: inviteScope },
      );
      setInviteResult(result);
      setInviteEmail("");
      const sessions = await invoke<SharingSession[]>("sharing_get_sessions");
      setSharingSessions(sessions);
    } catch (e) {
      console.error("sharing_invite failed", e);
    } finally {
      setSharingLoading(false);
    }
  };

  const handleAcceptInvite = async (code: string, scope: string) => {
    setSharingLoading(true);
    try {
      await invoke("sharing_accept", { inviteCode: code, scope });
      setAcceptCode("");
      setIncomingInvite(null);
      const sessions = await invoke<SharingSession[]>("sharing_get_sessions");
      setSharingSessions(sessions);
    } catch (e) {
      console.error("sharing_accept failed", e);
    } finally {
      setSharingLoading(false);
    }
  };

  const handleUpdateScope = async (shareGroupId: string, scope: string) => {
    try {
      await invoke("sharing_update_scope", { shareGroupId, scope });
      setSharingSessions((prev) =>
        prev.map((s) =>
          s.share_group_id === shareGroupId
            ? { ...s, my_scope: scope as SharingSession["my_scope"] }
            : s,
        ),
      );
    } catch (e) {
      console.error("sharing_update_scope failed", e);
    }
  };

  const handleLeaveSession = async (shareGroupId: string) => {
    try {
      await invoke("sharing_leave_session", { shareGroupId });
      setSharingSessions((prev) => prev.filter((s) => s.share_group_id !== shareGroupId));
    } catch (e) {
      console.error("sharing_leave_session failed", e);
    }
  };

  const handleEndSession = async (shareGroupId: string) => {
    try {
      await invoke("sharing_end_session", { shareGroupId });
      setSharingSessions((prev) => prev.filter((s) => s.share_group_id !== shareGroupId));
    } catch (e) {
      console.error("sharing_end_session failed", e);
    }
  };

  // ── Helpers ─────────────────────────────────────────────────────
  const formatLastSynced = (ts: number | null) => {
    if (!ts) return null;
    const diff = Date.now() - ts;
    if (diff < 60_000) return "Just now";
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
  };

  const syncStatusLabel = () => {
    if (!syncUser) return null;
    if (!syncStatus) return "Checking…";
    if (syncStatus.connected) return "Connected";
    if (syncStatus.pending_count > 0) return `${syncStatus.pending_count} pending`;
    return "Offline";
  };

  const syncStatusClass = () => {
    if (!syncUser || !syncStatus) return "sync-status-dot--inactive";
    if (syncStatus.connected) return "sync-status-dot--connected";
    return "sync-status-dot--offline";
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

      {/* ── Cloud Sync ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">Cloud Sync</h3>

        {/* Enable toggle */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Enable Cloud Sync</span>
            <span className="settings-row-desc">
              Sync clipboard history and notes across devices end-to-end encrypted.
            </span>
          </div>
          <button
            type="button"
            className={`settings-toggle${syncEnabled ? " active" : ""}`}
            onClick={handleSyncToggle}
            aria-pressed={syncEnabled}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        {syncEnabled && (
          <>
            {/* Server URL */}
            <div className="settings-row sync-url-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Server URL</span>
                <span className="settings-row-desc">Leave default for the official server, or enter your own.</span>
              </div>
              {editingUrl ? (
                <div className="sync-url-edit">
                  <input
                    className="sync-url-input"
                    value={serverUrlDraft}
                    onChange={(e) => setServerUrlDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveUrl(); if (e.key === "Escape") setEditingUrl(false); }}
                    autoFocus
                    spellCheck={false}
                  />
                  <button type="button" className="settings-action-btn" onClick={handleSaveUrl}>Save</button>
                  <button type="button" className="settings-action-btn" onClick={() => setEditingUrl(false)}>Cancel</button>
                </div>
              ) : (
                <button
                  type="button"
                  className="settings-action-btn sync-url-display"
                  onClick={() => setEditingUrl(true)}
                  title="Click to edit"
                >
                  <span className="sync-url-text">{serverUrl || "https://api.orangeclipboard.app"}</span>
                  <span className="sync-url-edit-hint">Edit</span>
                </button>
              )}
            </div>

            {/* Auth panel */}
            {!syncUser ? (
              /* Login form */
              <div className="sync-auth-card">
                <div className="sync-auth-card-header">
                  <CloudSyncIcon size={16} />
                  <span>Sign in to sync</span>
                </div>
                <div className="sync-login-form">
                  <input
                    className="sync-input"
                    type="email"
                    placeholder="Email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
                    disabled={loginLoading}
                  />
                  <input
                    className="sync-input"
                    type="password"
                    placeholder="Password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
                    disabled={loginLoading}
                  />
                  {loginError && <span className="sync-error">{loginError}</span>}
                  <button
                    type="button"
                    className="sync-primary-btn"
                    onClick={handleLogin}
                    disabled={loginLoading || !loginEmail || !loginPassword}
                  >
                    {loginLoading ? "Signing in…" : "Sign In"}
                  </button>
                </div>
              </div>
            ) : (
              /* Logged-in panel */
              <>
                {/* User info + status */}
                <div className="sync-user-card">
                  <div className="sync-user-info">
                    <div className="sync-user-avatar">
                      {syncUser.display_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="sync-user-text">
                      <span className="sync-user-name">{syncUser.display_name}</span>
                      <span className="sync-user-email">{syncUser.email}</span>
                    </div>
                    <div className="sync-user-actions">
                      <div className="sync-status-row">
                        <span className={`sync-status-dot ${syncStatusClass()}`} />
                        <span className="sync-status-label">{syncStatusLabel()}</span>
                        {lastSynced && (
                          <span className="sync-last-synced">· {formatLastSynced(lastSynced)}</span>
                        )}
                      </div>
                      <div className="sync-user-btns">
                        <button
                          type="button"
                          className="settings-action-btn"
                          onClick={handleSyncNow}
                          disabled={syncNowLoading}
                        >
                          {syncNowLoading ? "Syncing…" : "Sync Now"}
                        </button>
                        <button
                          type="button"
                          className="settings-action-btn sync-logout-btn"
                          onClick={handleLogout}
                        >
                          Sign Out
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Shared Groups */}
                <div className="sync-sub-section">
                  <div className="sync-sub-section-header">
                    <UsersIcon size={13} />
                    <span className="sync-sub-section-title">Shared Groups</span>
                  </div>

                  {syncGroups.length > 0 && (
                    <div className="sync-groups-list">
                      {syncGroups.map((g) => (
                        <div key={g.id} className="sync-group-row">
                          <div className="sync-group-info">
                            <span className="sync-group-name">{g.name}</span>
                            <span className="sync-group-members">{g.member_count} member{g.member_count !== 1 ? "s" : ""}</span>
                          </div>
                          <div className="sync-group-actions">
                            <button
                              type="button"
                              className="settings-action-btn sync-invite-btn"
                              onClick={() => handleCopyInvite(g.id)}
                              data-tooltip="Copy invite link"
                            >
                              {copiedGroupId === g.id ? (
                                <><CheckIcon size={11} /> Copied</>
                              ) : (
                                <><ShareIcon size={11} /> Invite</>
                              )}
                            </button>
                            <button
                              type="button"
                              className="settings-action-btn sync-leave-btn"
                              onClick={() => handleLeaveGroup(g.id)}
                            >
                              Leave
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Create group */}
                  <div className="sync-input-row">
                    <input
                      className="sync-input sync-input--flex"
                      placeholder="New group name"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); }}
                      disabled={groupLoading}
                    />
                    <button
                      type="button"
                      className="settings-action-btn"
                      onClick={handleCreateGroup}
                      disabled={groupLoading || !newGroupName.trim()}
                    >
                      Create
                    </button>
                  </div>

                  {/* Join group */}
                  <div className="sync-input-row">
                    <input
                      className="sync-input sync-input--flex"
                      placeholder="Invite code to join"
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleJoinGroup(); }}
                      disabled={groupLoading}
                    />
                    <button
                      type="button"
                      className="settings-action-btn"
                      onClick={handleJoinGroup}
                      disabled={groupLoading || !joinCode.trim()}
                    >
                      Join
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Live Share ── */}
      {syncEnabled && syncUser && (
        <div className="settings-section">
          <h3 className="settings-section-title">Live Share</h3>
          <p className="settings-section-desc">
            Share your clipboard or notes in real time with another person (up to 5 members per session).
          </p>

          {/* Incoming invite */}
          {incomingInvite && (
            <div className="sync-auth-card sync-invite-incoming">
              <div className="sync-auth-card-header">
                <ShareIcon size={14} />
                <span>Incoming Live Share invite</span>
              </div>
              <p className="sync-invite-code-display">{incomingInvite.invite_code}</p>
              {incomingInvite.from_email && (
                <p className="sync-invite-from">From: {incomingInvite.from_email}</p>
              )}
              <div className="sync-scope-row">
                <span className="sync-scope-label">Share scope:</span>
                <div className="sync-scope-pills">
                  {SCOPE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`sync-scope-pill${acceptScope === opt.value ? " active" : ""}`}
                      onClick={() => setAcceptScope(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sync-invite-btns">
                <button
                  type="button"
                  className="sync-primary-btn"
                  disabled={sharingLoading}
                  onClick={() => handleAcceptInvite(incomingInvite.invite_code, acceptScope)}
                >
                  {sharingLoading ? "Accepting…" : "Accept"}
                </button>
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={() => setIncomingInvite(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Active sessions */}
          {sharingSessions.length > 0 && (
            <div className="sync-sessions-list">
              {sharingSessions.map((session) => (
                <div key={session.share_group_id} className="sync-session-card">
                  <div className="sync-session-header">
                    <span className="sync-session-name">{session.name || "Live Share Session"}</span>
                    <div className="sync-session-actions">
                      <button
                        type="button"
                        className="settings-action-btn sync-leave-btn"
                        onClick={() => handleLeaveSession(session.share_group_id)}
                      >
                        Leave
                      </button>
                      <button
                        type="button"
                        className="settings-action-btn sync-end-btn"
                        onClick={() => handleEndSession(session.share_group_id)}
                      >
                        End
                      </button>
                    </div>
                  </div>
                  {/* Scope selector */}
                  <div className="sync-scope-row">
                    <span className="sync-scope-label">My scope:</span>
                    <div className="sync-scope-pills">
                      {SCOPE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          className={`sync-scope-pill${session.my_scope === opt.value ? " active" : ""}`}
                          onClick={() => handleUpdateScope(session.share_group_id, opt.value)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Members */}
                  {session.members.length > 0 && (
                    <div className="sync-session-members">
                      {session.members.map((m) => (
                        <div key={m.user_id} className="sync-member-row">
                          <span className={`sync-member-dot${m.online ? " online" : ""}`} />
                          <span className="sync-member-name">{m.display_name}</span>
                          <span className="sync-member-scope">{m.scope}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Invite form */}
          <div className="sync-sub-section">
            <div className="sync-sub-section-header">
              <ShareIcon size={13} />
              <span className="sync-sub-section-title">Invite to Live Share</span>
            </div>
            <div className="sync-input-row">
              <input
                className="sync-input sync-input--flex"
                type="email"
                placeholder="Email address"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={sharingLoading}
              />
            </div>
            <div className="sync-scope-row">
              <span className="sync-scope-label">Share scope:</span>
              <div className="sync-scope-pills">
                {SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`sync-scope-pill${inviteScope === opt.value ? " active" : ""}`}
                    onClick={() => setInviteScope(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="sync-primary-btn sync-invite-send-btn"
              onClick={handleShareInvite}
              disabled={sharingLoading || !inviteEmail.trim()}
            >
              {sharingLoading ? "Sending…" : "Send Invite"}
            </button>
            {inviteResult && (
              <div className="sync-invite-result">
                <span className="sync-invite-result-label">Invite code:</span>
                <span className="sync-invite-result-code">{inviteResult.invite_code}</span>
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={() => {
                    navigator.clipboard.writeText(inviteResult.invite_code).catch(() => {});
                  }}
                >
                  <ShareIcon size={11} /> Copy
                </button>
              </div>
            )}
          </div>

          {/* Accept by code */}
          <div className="sync-sub-section">
            <div className="sync-sub-section-header">
              <UsersIcon size={13} />
              <span className="sync-sub-section-title">Join by invite code</span>
            </div>
            <div className="sync-input-row">
              <input
                className="sync-input sync-input--flex"
                placeholder="Paste invite code"
                value={acceptCode}
                onChange={(e) => setAcceptCode(e.target.value)}
                disabled={sharingLoading}
              />
            </div>
            <div className="sync-scope-row">
              <span className="sync-scope-label">Share scope:</span>
              <div className="sync-scope-pills">
                {SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`sync-scope-pill${acceptScope === opt.value ? " active" : ""}`}
                    onClick={() => setAcceptScope(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="settings-action-btn"
              onClick={() => handleAcceptInvite(acceptCode, acceptScope)}
              disabled={sharingLoading || !acceptCode.trim()}
            >
              {sharingLoading ? "Joining…" : "Join Session"}
            </button>
          </div>
        </div>
      )}

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
