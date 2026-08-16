import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  SyncUser,
  SyncStatusInfo,
  SyncDevice,
  SyncConnection,
  SyncMode,
  SyncQuota,
} from "../../../types";
import {
  CaretDown,
  CaretUp,
  Check,
  CloudArrowUp,
  CloudCheck,
  Desktop,
  DeviceMobile,
  HardDrives,
  Laptop,
  Key,
  WarningCircle,
} from "@phosphor-icons/react";
import { GoogleIcon } from "../../icons";
import { UserAvatar } from "../../UserAvatar";
// The scroll container reuses .settings-screen; everything else is acct-*/auth-*.
import "../settings-screen/SettingsScreen.css";
import "./AccountScreen.css";
import {
  getBulkState,
  setBulkResult,
  subscribeBulk,
  trackBulk,
  type BulkState,
} from "./bulkProgress";

const MODE_OPTIONS: { value: SyncMode; label: string }[] = [
  { value: "realtime", label: "Realtime" },
  { value: "passive", label: "Passive" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Pick a device glyph from the reported platform string. */
function deviceIcon(platform: string) {
  const p = platform.toLowerCase();
  if (p.includes("android") || p.includes("ios")) return DeviceMobile;
  if (p.includes("mac") || p.includes("darwin")) return Laptop;
  return Desktop;
}

// ── Account & Cloud Sync screen ───────────────────────────────────────
// Owns identity and personal backup: sign in/up (email + Google), the
// account itself, devices and storage, and how this device applies its own
// entries from other devices. Sharing lives on the Spaces screen.

const AccountScreen: React.FC = () => {
  // ── Cloud Sync ─────────────────────────────────────────────────
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncUser, setSyncUser] = useState<SyncUser | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusInfo | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>("realtime");
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  // Live presence overrides on top of the server snapshot (device.online):
  // undefined = no event seen yet, use the snapshot.
  const [presenceOverrides, setPresenceOverrides] = useState<Record<string, boolean>>({});

  // Login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  // OAuth (Google) — two-step: browser handshake, then account password.
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthStage, setOauthStage] = useState<"password" | null>(null);
  const [oauthEmail, setOauthEmail] = useState("");
  const [oauthIsNew, setOauthIsNew] = useState(false);
  const [oauthPassword, setOauthPassword] = useState("");
  const [oauthConfirm, setOauthConfirm] = useState("");

  // Connection — endpoints baked in at build time (see src-tauri/build.rs).
  // Only used to detect a build compiled without them, so sign-in can say so
  // instead of failing silently.
  const [conn, setConn] = useState<SyncConnection | null>(null);

  // Forgot / reset password
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // Devices
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // Blob storage usage — null until a successful fetch (the row stays hidden).
  const [quota, setQuota] = useState<SyncQuota | null>(null);

  // Sync actions
  const [syncNowLoading, setSyncNowLoading] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);

  const refreshQuota = useCallback(() => {
    invoke<SyncQuota>("sync_get_quota").then(setQuota).catch(() => {});
  }, []);

  // ── Load state on mount ─────────────────────────────────────────
  useEffect(() => {
    invoke<boolean | null>("get_setting", { key: "sync_enabled" }).then((v) =>
      setSyncEnabled(v === true),
    );

    invoke<SyncUser | null>("sync_get_user").then((u) => {
      setSyncUser(u);
      if (u) {
        refreshQuota();
        invoke<string>("sync_get_mode")
          .then((m) => setSyncMode(m === "passive" ? "passive" : "realtime"))
          .catch(() => {});
        invoke<SyncDevice[]>("sync_list_devices").then(setDevices).catch(() => {});
        invoke<SyncStatusInfo>("sync_get_status").then((s) => {
          setSyncStatus(s);
          if (s.last_synced_at) setLastSynced(s.last_synced_at);
        }).catch(() => {});
      }
    });
  }, [refreshQuota]);

  // ── Silent session restore (fired by App on startup) ────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<SyncUser>("sync:session-restored", (event) => {
      setSyncUser(event.payload);
      refreshQuota();
      invoke<SyncDevice[]>("sync_list_devices").then(setDevices).catch(() => {});
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [refreshQuota]);

  // ── Device presence: mark devices online/offline as events arrive ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ device_id?: string; online?: boolean }>(
      "sync:device-presence",
      (event) => {
        const { device_id, online } = event.payload;
        if (!device_id) return;
        setPresenceOverrides((prev) => ({ ...prev, [device_id]: online === true }));
      },
    ).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

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


  const handleModeChange = async (mode: SyncMode) => {
    const previous = syncMode;
    setSyncMode(mode);
    try {
      await invoke("sync_set_mode", { mode });
    } catch (e) {
      setSyncMode(previous);
      console.error("sync_set_mode failed", e);
    }
  };

  // Post-authentication: hydrate account state (shared by password + OAuth).
  const loadPostLogin = (user: SyncUser) => {
    setSyncUser(user);
    refreshQuota();
    invoke<SyncDevice[]>("sync_list_devices").then(setDevices).catch(() => {});
    invoke<SyncStatusInfo>("sync_get_status").then((s) => {
      setSyncStatus(s);
      if (s.last_synced_at) setLastSynced(s.last_synced_at);
    }).catch(() => {});
  };

  useEffect(() => {
    invoke<SyncConnection>("sync_get_connection").then(setConn).catch(() => {});
  }, []);

  const resetOauth = () => {
    setOauthStage(null);
    setOauthEmail("");
    setOauthIsNew(false);
    setOauthPassword("");
    setOauthConfirm("");
  };

  // Step 1: launch the Google handshake in the browser.
  const handleGoogleSignIn = async () => {
    setOauthLoading(true);
    setLoginError(null);
    setAuthNotice(null);
    try {
      const res = await invoke<{ email: string; is_new: boolean }>("sync_oauth_begin", {
        provider: "google",
        deviceName: `Orange CP - ${navigator.platform || "Desktop"}`,
      });
      setOauthEmail(res.email);
      setOauthIsNew(res.is_new);
      setOauthStage("password");
    } catch (e) {
      setLoginError(typeof e === "string" ? e : "Google sign-in failed.");
    } finally {
      setOauthLoading(false);
    }
  };

  // Step 2: finalize with the account password (the E2E secret).
  const handleOauthComplete = async () => {
    if (!oauthPassword) return;
    if (oauthIsNew) {
      if (oauthPassword.length < 8) {
        setLoginError("Password must be at least 8 characters.");
        return;
      }
      if (oauthPassword !== oauthConfirm) {
        setLoginError("Passwords don't match.");
        return;
      }
    }
    setOauthLoading(true);
    setLoginError(null);
    try {
      const user = await invoke<SyncUser>("sync_oauth_complete", {
        password: oauthPassword,
      });
      resetOauth();
      loadPostLogin(user);
    } catch (e) {
      setLoginError(typeof e === "string" ? e : "Could not complete sign-in.");
    } finally {
      setOauthLoading(false);
    }
  };

  const handleOauthCancel = () => {
    invoke("sync_oauth_cancel").catch(() => {});
    resetOauth();
    setLoginError(null);
  };

  const switchAuthMode = (mode: "login" | "signup") => {
    setAuthMode(mode);
    setLoginError(null);
    setAuthNotice(null);
  };

  const openForgot = () => {
    setForgotOpen(true);
    setResetEmail(loginEmail);
    setResetSent(false);
    setResetError(null);
  };

  const closeForgot = () => {
    setForgotOpen(false);
    setResetSent(false);
    setResetError(null);
  };

  const handleResetPassword = async () => {
    if (!resetEmail.trim()) return;
    setResetLoading(true);
    setResetError(null);
    try {
      await invoke("sync_reset_password", { email: resetEmail.trim() });
      setResetSent(true);
    } catch (e) {
      setResetError(typeof e === "string" ? e : "Could not send the reset email.");
    } finally {
      setResetLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!loginEmail || !loginPassword) return;
    setLoginLoading(true);
    setLoginError(null);
    setAuthNotice(null);
    try {
      // sync_signup returns the same SyncUser on projects without email
      // confirmation; when confirmation is required it errors with guidance
      // (surfaced below as a notice, not a hard failure).
      const command = authMode === "signup" ? "sync_signup" : "sync_login";
      const user = await invoke<SyncUser>(command, {
        email: loginEmail,
        password: loginPassword,
        deviceName: `Orange CP - ${navigator.platform || "Desktop"}`,
      });
      setLoginEmail("");
      setLoginPassword("");
      loadPostLogin(user);
    } catch (e) {
      const msg = typeof e === "string" ? e : null;
      // Email-confirmation flow: not an error — guide the user back to sign-in.
      if (authMode === "signup" && msg && /confirm/i.test(msg)) {
        setAuthNotice(msg);
        setAuthMode("login");
      } else {
        setLoginError(
          msg ??
            (authMode === "signup"
              ? "Sign up failed. Try a different email."
              : "Login failed. Check your credentials."),
        );
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await invoke("sync_logout");
      setSyncUser(null);
      setSyncStatus(null);
      setDeviceError(null);
      setDevices([]);
      setPresenceOverrides({});
      setQuota(null);
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
      refreshQuota();
    } catch (e) {
      console.error("sync_now failed", e);
    } finally {
      setSyncNowLoading(false);
    }
  };

  const errMsg = (e: unknown, fallback: string) =>
    typeof e === "string" ? e : fallback;

  const handleRevokeDevice = async (deviceId: string) => {
    setDeviceError(null);
    try {
      // The Rust command refuses to revoke the current device with a clear
      // message, so Remove is shown on every row and the error surfaces here.
      await invoke("sync_revoke_device", { deviceId });
      const ds = await invoke<SyncDevice[]>("sync_list_devices");
      setDevices(ds);
    } catch (e) {
      setDeviceError(errMsg(e, "Could not remove the device."));
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
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const status = !syncStatus
    ? { kind: "checking", label: "Checking..." }
    : syncStatus.connected
      ? { kind: "connected", label: "Synced" }
      : syncStatus.pending_count > 0
        ? { kind: "pending", label: `${syncStatus.pending_count} pending` }
        : { kind: "offline", label: "Offline" };

  // Presence resolves from the server snapshot unless a WS event overrode it;
  // the current device is always shown online.
  const isDeviceOnline = (d: SyncDevice) =>
    d.is_current || (presenceOverrides[d.id] ?? d.online);
  const onlineDevices = devices.filter(isDeviceOnline).length;

  // Queue detail that the old status pill folded into its label — kept as a
  // second line so nothing is lost when the pill says "Synced".
  const queueNote =
    syncStatus && syncStatus.pending_count > 0 && status.kind !== "pending"
      ? `${syncStatus.pending_count} change${syncStatus.pending_count === 1 ? "" : "s"} waiting to upload`
      : null;
  // Entries sync refused to send. The count alone said nothing about which
  // items or why, so it opens a list carrying the reason for each.
  const skipped = syncStatus?.skipped ?? [];
  const skippedCount = syncStatus?.skipped_count ?? 0;

  const handleDismissSkipped = async () => {
    try {
      await invoke("sync_clear_skipped");
      const s = await invoke<SyncStatusInfo>("sync_get_status");
      setSyncStatus(s);
    } catch {
      /* clearing a local report can't fail in a way the user can act on */
    }
    setShowSkipped(false);
  };

  const [pushingOld, setPushingOld] = useState(false);
  // Lives outside the component: the upload keeps running after the screen
  // unmounts, so its progress has to survive coming back to it.
  const [bulk, setBulk] = useState<BulkState>(getBulkState);
  useEffect(
    () =>
      subscribeBulk((next) => {
        setBulk(next);
        // A finished run changes the skipped list and the pending count.
        if (next.progress === null) {
          invoke<SyncStatusInfo>("sync_get_status").then(setSyncStatus).catch(() => {});
        }
      }),
    [],
  );
  const progress = bulk.progress;
  const pushResult = bulk.result;

  const pct = progress
    ? Math.min(100, Math.round((progress.done / Math.max(1, progress.total)) * 100))
    : 0;

  const handlePushUnsynced = async () => {
    setPushingOld(true);
    setBulkResult(null);
    try {
      const keys = await invoke<string[]>("sync_push_unsynced");
      if (keys.length === 0) {
        setBulkResult("Everything on this device is already synced.");
      } else {
        void trackBulk(keys, "upload");
      }
    } catch (e) {
      setBulkResult(typeof e === "string" ? e : "Could not start the upload.");
    }
    setPushingOld(false);
  };

  // Two clicks: this is a delete on the server, so the other devices lose
  // their copies too. Arming beats a dialog for something this small.
  const [unpushing, setUnpushing] = useState(false);
  const [unpushArmed, setUnpushArmed] = useState(false);
  const handleUnpushAll = async () => {
    if (!unpushArmed) {
      setUnpushArmed(true);
      setTimeout(() => setUnpushArmed(false), 3000);
      return;
    }
    setUnpushArmed(false);
    setUnpushing(true);
    setBulkResult(null);
    try {
      const keys = await invoke<string[]>("sync_unpush_all");
      if (keys.length === 0) {
        setBulkResult("Nothing on this device is synced right now.");
      } else {
        void trackBulk(keys, "remove");
      }
    } catch (e) {
      setBulkResult(typeof e === "string" ? e : "Could not remove them.");
    }
    setUnpushing(false);
  };

  // A skip is never queued, so these items only ever reach the server if the
  // user asks again. Retrying clears the list; anything that fails records a
  // fresh skip, which lands back here a moment later.
  const [retrying, setRetrying] = useState(false);
  const handleRetrySkipped = async () => {
    setRetrying(true);
    try {
      await invoke<number>("sync_retry_skipped");
      // The pushes run in the background, so read the status after a beat.
      await new Promise((r) => setTimeout(r, 1200));
      const s = await invoke<SyncStatusInfo>("sync_get_status");
      setSyncStatus(s);
    } catch {
      /* the retried pushes report their own failures back into this list */
    }
    setRetrying(false);
  };

  // Short states (enable hero / signed-out auth) get centered vertically and
  // rely on the card's own heading, so the page header is hidden there.
  const centered = !syncEnabled || !syncUser;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className={`settings-screen account-screen${centered ? " account-screen--center" : ""}`}>
      <div className="acct-inner">
        {!centered && (
          <header className="scr-head">
            <span className="scr-eyebrow">Cloud</span>
            <h2 className="scr-title">Account &amp; Sync</h2>
            <p className="scr-subtitle">
              Sign in, keep your devices in sync, and see what this account is storing.
              End-to-end encrypted.
            </p>
          </header>
        )}

        {!syncEnabled ? (
          /* ── Sync disabled: enable hero ── */
          <div className="acct-card acct-hero">
            <div className="acct-hero-badge"><CloudCheck size={26} /></div>
            <h3 className="acct-hero-title">Sync across your devices</h3>
            <p className="acct-hero-desc">
              Keep your clipboard history and notes in sync on every device. End-to-end
              encrypted, so only you can read them.
            </p>
            <button type="button" className="auth-submit acct-hero-btn" onClick={handleSyncToggle}>
              Enable Cloud Sync
            </button>
          </div>
        ) : !syncUser ? (
          /* ── Enabled but signed out: auth card + advanced ── */
          <>
            <div className="auth-card">
              <div className="auth-brand">
                <div className="auth-brand-badge">
                  <CloudCheck size={20} />
                </div>
                <h3 className="auth-title">
                  {oauthStage === "password"
                    ? oauthIsNew
                      ? "Set your password"
                      : "Enter your password"
                    : forgotOpen
                      ? "Reset your password"
                      : authMode === "signup"
                        ? "Create your account"
                        : "Welcome back"}
                </h3>
                <p className="auth-subtitle">
                  {oauthStage === "password"
                    ? `Signed in as ${oauthEmail}`
                    : forgotOpen
                      ? "We'll email you a link to set a new password."
                      : authMode === "signup"
                        ? "Sync your clipboard and notes. End-to-end encrypted."
                        : "Sign in to sync across your devices."}
                </p>
              </div>

              {oauthStage === "password" ? (
                /* OAuth: account-password step (the E2E secret) */
                <div className="auth-form">
                  <p className="auth-hint">
                    {oauthIsNew
                      ? "Set a password to encrypt your data. You'll enter it on each device, and it also lets you sign in with email."
                      : "Enter your account password to unlock your encrypted data."}
                  </p>
                  <label className="auth-field">
                    <span className="auth-label">{oauthIsNew ? "New password" : "Password"}</span>
                    <input
                      className="auth-input"
                      type="password"
                      placeholder={oauthIsNew ? "At least 8 characters" : "Your password"}
                      value={oauthPassword}
                      autoFocus
                      onChange={(e) => setOauthPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !oauthIsNew) handleOauthComplete(); }}
                      disabled={oauthLoading}
                    />
                  </label>
                  {oauthIsNew && (
                    <label className="auth-field">
                      <span className="auth-label">Confirm password</span>
                      <input
                        className="auth-input"
                        type="password"
                        placeholder="Repeat the password"
                        value={oauthConfirm}
                        onChange={(e) => setOauthConfirm(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleOauthComplete(); }}
                        disabled={oauthLoading}
                      />
                    </label>
                  )}
                  {loginError && <span className="auth-error">{loginError}</span>}
                  <button
                    type="button"
                    className="auth-submit"
                    onClick={handleOauthComplete}
                    disabled={oauthLoading || !oauthPassword}
                  >
                    {oauthLoading
                      ? "Unlocking..."
                      : oauthIsNew
                        ? "Set password & continue"
                        : "Unlock"}
                  </button>
                  <button
                    type="button"
                    className="auth-textlink auth-textlink--center"
                    onClick={handleOauthCancel}
                    disabled={oauthLoading}
                  >
                    Cancel
                  </button>
                </div>
              ) : forgotOpen ? (
                /* Forgot / reset password */
                <div className="auth-form">
                  {resetSent ? (
                    <div className="auth-reset-done">
                      <span className="auth-reset-check"><Check size={16} weight="bold" /></span>
                      <p>
                        If an account exists for <strong>{resetEmail}</strong>, a password-reset
                        link is on its way. Check your inbox.
                      </p>
                    </div>
                  ) : (
                    <>
                      <label className="auth-field">
                        <span className="auth-label">Email</span>
                        <input
                          className="auth-input"
                          type="email"
                          placeholder="you@example.com"
                          value={resetEmail}
                          autoFocus
                          onChange={(e) => setResetEmail(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleResetPassword(); }}
                          disabled={resetLoading}
                        />
                      </label>
                      {resetError && <span className="auth-error">{resetError}</span>}
                      <button
                        type="button"
                        className="auth-submit"
                        onClick={handleResetPassword}
                        disabled={resetLoading || !resetEmail.trim()}
                      >
                        {resetLoading ? "Sending..." : "Send reset link"}
                      </button>
                    </>
                  )}
                  <p className="auth-note">
                    Because your data is end-to-end encrypted, resetting your password restores
                    sign-in but can't recover previously synced data unless another device is
                    still signed in.
                  </p>
                  <button
                    type="button"
                    className="auth-textlink auth-textlink--center"
                    onClick={closeForgot}
                  >
                    Back to sign in
                  </button>
                </div>
              ) : (
                <>
                  <div className="auth-tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={authMode === "login"}
                      className={`auth-tab${authMode === "login" ? " active" : ""}`}
                      onClick={() => switchAuthMode("login")}
                    >
                      Sign In
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={authMode === "signup"}
                      className={`auth-tab${authMode === "signup" ? " active" : ""}`}
                      onClick={() => switchAuthMode("signup")}
                    >
                      Sign Up
                    </button>
                    <span
                      className="auth-tabs-slider"
                      style={{ transform: `translateX(${authMode === "signup" ? "100%" : "0"})` }}
                    />
                  </div>

                  <div className="auth-form">
                    <label className="auth-field">
                      <span className="auth-label">Email</span>
                      <input
                        className="auth-input"
                        type="email"
                        placeholder="you@example.com"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
                        disabled={loginLoading || oauthLoading}
                      />
                    </label>
                    <label className="auth-field">
                      <div className="auth-label-row">
                        <span className="auth-label">Password</span>
                        {authMode === "login" && (
                          <button type="button" className="auth-textlink" onClick={openForgot}>
                            Forgot?
                          </button>
                        )}
                      </div>
                      <input
                        className="auth-input"
                        type="password"
                        placeholder={authMode === "signup" ? "At least 8 characters" : "Your password"}
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
                        disabled={loginLoading || oauthLoading}
                      />
                    </label>

                    {loginError && <span className="auth-error">{loginError}</span>}
                    {authNotice && <span className="auth-notice">{authNotice}</span>}

                    <button
                      type="button"
                      className="auth-submit"
                      onClick={handleLogin}
                      disabled={
                        loginLoading ||
                        oauthLoading ||
                        !loginEmail ||
                        !loginPassword ||
                        conn?.configured === false
                      }
                    >
                      {loginLoading
                        ? authMode === "signup"
                          ? "Creating account..."
                          : "Signing in..."
                        : authMode === "signup"
                          ? "Create account"
                          : "Sign in"}
                    </button>

                    <div className="auth-divider"><span>or</span></div>

                    <button
                      type="button"
                      className="auth-google"
                      onClick={handleGoogleSignIn}
                      disabled={loginLoading || oauthLoading || conn?.configured === false}
                    >
                      <GoogleIcon size={16} />
                      {oauthLoading ? "Waiting for browser..." : "Continue with Google"}
                    </button>
                  </div>
                </>
              )}

              {/* Only ever visible in a build compiled without endpoints — a
                  developer-facing dead end, not something users should hit. */}
              {conn?.configured === false && (
                <span className="auth-error">
                  This build has no sync endpoints compiled in. Set the{" "}
                  <code>DEFAULT_*</code> constants in <code>sync/config.rs</code>{" "}
                  and rebuild.
                </span>
              )}

              <div className="auth-secure">
                <Key size={12} weight="fill" />
                End-to-end encrypted. Only you can read your data
              </div>
            </div>

          </>
        ) : (
          /* ── Signed in ── */
          <>
            {/* Identity band */}
            <div className="acct-card acct-idband">
              <UserAvatar
                className="acct-avatar"
                url={syncUser.avatar_url}
                label={syncUser.display_name || syncUser.email || "?"}
                glyphSize={18}
              />
              <div className="acct-id-text">
                <span className="acct-id-email">
                  {syncUser.email || syncUser.display_name || "Your account"}
                </span>
                <span className={`acct-id-status acct-id-status--${status.kind}`}>
                  <span className="acct-id-dot" />
                  {status.label}
                  {status.kind === "connected" && lastSynced
                    ? ` - ${formatLastSynced(lastSynced)}`
                    : ""}
                  {/* Presence is only trustworthy while this device is connected. */}
                  {status.kind === "connected" && devices.length > 0
                    ? ` - ${onlineDevices} device${onlineDevices === 1 ? "" : "s"} online`
                    : ""}
                </span>
                {queueNote && <span className="acct-id-note">{queueNote}</span>}
                {skippedCount > 0 && (
                  <button
                    type="button"
                    className="acct-id-note acct-id-note--warn acct-id-note--action"
                    onClick={() => setShowSkipped((v) => !v)}
                  >
                    {skippedCount} not synced
                    {showSkipped ? (
                      <CaretUp size={10} weight="bold" />
                    ) : (
                      <CaretDown size={10} weight="bold" />
                    )}
                  </button>
                )}
              </div>
              <div className="acct-id-actions">
                <button
                  type="button"
                  className="acct-btn"
                  onClick={handleSyncNow}
                  disabled={syncNowLoading}
                >
                  {syncNowLoading ? "Syncing..." : "Sync now"}
                </button>
                <button
                  type="button"
                  className="acct-btn acct-btn--quiet acct-btn--danger"
                  onClick={handleLogout}
                >
                  Sign out
                </button>
              </div>
            </div>

            {/* What sync refused to send, and why */}
            {showSkipped && skippedCount > 0 && (
              <div className="acct-skipped">
                {skipped.length === 0 ? (
                  <span className="acct-skipped-empty">
                    {skippedCount} item{skippedCount === 1 ? "" : "s"} were skipped before
                    this app was restarted. The details are gone.
                  </span>
                ) : (
                  skipped.map((item) => (
                    <div key={`${item.client_id}-${item.at}`} className="acct-skipped-row">
                      <WarningCircle size={13} className="acct-skipped-icon" />
                      <span className="acct-skipped-text">
                        <span className="acct-skipped-label">{item.label}</span>
                        <span className="acct-skipped-reason">{item.reason}</span>
                      </span>
                    </div>
                  ))
                )}
                <div className="acct-skipped-actions">
                  <button
                    type="button"
                    className="acct-btn acct-btn--sm"
                    onClick={handleRetrySkipped}
                    disabled={retrying}
                  >
                    {retrying ? "Retrying..." : "Try again"}
                  </button>
                  <button
                    type="button"
                    className="acct-btn acct-btn--sm"
                    onClick={handleDismissSkipped}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Cloud sync: this device's own backup, not sharing */}
            <section className="acct-zone">
              <div className="acct-zone-head">
                <span className="acct-zone-icon"><CloudArrowUp size={13} /></span>
                <span className="acct-zone-label">Cloud sync</span>
              </div>

              <div className="acct-card acct-mode">
                <div className="acct-mode-head">
                  <span className="acct-row-name">
                    Items from your other devices
                  </span>
                  <div className="acct-seg">
                    {MODE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`acct-seg-pill${syncMode === opt.value ? " active" : ""}`}
                        onClick={() => handleModeChange(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="acct-card-desc">
                  {syncMode === "realtime"
                    ? "Items from your other devices arrive the moment they are copied."
                    : "Items from your other devices arrive every 5 minutes, or when you press Sync now. What you copy here still uploads right away."}
                </p>
                <p className="acct-mode-note">
                  Spaces are not affected. What other people share with you
                  always arrives live.
                </p>
              </div>

              {/* Items are only pushed as they are captured, so anything from
                  before this account signed in never leaves the device. */}
              <div className="acct-card acct-mode">
                <div className="acct-mode-head">
                  <span className="acct-row-name">
                    Items this account has never seen
                  </span>
                  <div className="acct-id-actions">
                    <button
                      type="button"
                      className="acct-btn acct-btn--sm"
                      onClick={handlePushUnsynced}
                      disabled={pushingOld || unpushing || progress !== null}
                    >
                      {progress?.mode === "upload" || pushingOld
                        ? "Uploading..."
                        : "Upload"}
                    </button>
                    <button
                      type="button"
                      className="acct-btn acct-btn--sm acct-btn--quiet acct-btn--danger"
                      onClick={handleUnpushAll}
                      disabled={pushingOld || unpushing || progress !== null}
                    >
                      {progress?.mode === "remove" || unpushing
                        ? "Removing..."
                        : unpushArmed
                          ? "Confirm?"
                          : "Remove from cloud"}
                    </button>
                  </div>
                </div>
                {progress ? (
                  <div
                    className="acct-progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-valuenow={progress.done}
                  >
                    <div className="acct-progress-track">
                      <span
                        className="acct-progress-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="acct-progress-label">
                      {progress.mode === "upload"
                        ? `Uploaded ${progress.done} of ${progress.total}`
                        : `Removed ${progress.done} of ${progress.total}`}
                    </span>
                  </div>
                ) : (
                  <p className="acct-card-desc">
                    {pushResult ??
                      "Sync picks up items as you copy them, so anything from before you signed in stays here. Upload sends those, encrypted."}
                  </p>
                )}
                {!pushResult && !progress && (
                  <p className="acct-mode-note">
                    Remove from cloud does the opposite for everything: your
                    items leave the server and your other devices, and only this
                    device keeps them.
                  </p>
                )}
                {progress?.mode === "upload" && (
                  <p className="acct-mode-note">
                    Large images take a moment. You can leave this screen; the
                    upload keeps going.
                  </p>
                )}
              </div>
            </section>

            {/* This account */}
            <section className="acct-zone">
              <div className="acct-zone-head">
                <span className="acct-zone-icon"><Desktop size={13} /></span>
                <span className="acct-zone-label">Devices &amp; storage</span>
              </div>

              {deviceError && <span className="auth-error">{deviceError}</span>}

              <div className="acct-card acct-card--rows">
                <div className="acct-list">
                  {devices.length > 0 ? (
                    devices.map((d) => {
                      const online = isDeviceOnline(d);
                      const DeviceGlyph = deviceIcon(d.platform);
                      const seen = formatLastSynced(d.last_seen_at);
                      return (
                        <div key={d.id} className="acct-row">
                          <span className="acct-row-icon"><DeviceGlyph size={15} /></span>
                          <div className="acct-row-main">
                            <span className="acct-row-name">
                              {d.device_name || "Unknown device"}
                              {d.is_current && (
                                <span className="acct-badge acct-badge--owner">this device</span>
                              )}
                            </span>
                            <span className="acct-row-meta">
                              {d.platform}
                              {online
                                ? " - online"
                                : seen
                                  ? ` - last seen ${seen}`
                                  : " - offline"}
                            </span>
                          </div>
                          <span className={`acct-dot${online ? " online" : ""}`} />
                          {!d.is_current && (
                            <div className="acct-row-actions">
                              <button
                                type="button"
                                className="acct-btn acct-btn--sm acct-btn--danger"
                                onClick={() => handleRevokeDevice(d.id)}
                              >
                                Remove
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <p className="acct-empty">No devices registered yet.</p>
                  )}
                  {quota && (() => {
                    const pct =
                      quota.quota_bytes > 0
                        ? Math.min(100, (quota.used_bytes / quota.quota_bytes) * 100)
                        : 0;
                    return (
                      <div className="acct-quota">
                        <div className="acct-quota-head">
                          <HardDrives size={13} />
                          <span>Storage</span>
                          <span className="acct-quota-value">
                            {formatBytes(quota.used_bytes)} of {formatBytes(quota.quota_bytes)}
                          </span>
                        </div>
                        <div className="acct-quota-track">
                          <div
                            className={`acct-quota-fill${pct >= 85 ? " acct-quota-fill--warn" : ""}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </section>

            <p className="auth-secure acct-secure-foot">
              <Key size={12} weight="fill" />
              End-to-end encrypted. Only you can read your data
            </p>

          </>
        )}
      </div>
    </div>
  );
};

export default AccountScreen;
