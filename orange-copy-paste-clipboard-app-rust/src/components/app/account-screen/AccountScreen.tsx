import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  SyncUser,
  SyncGroup,
  SyncStatusInfo,
  SharingSession,
  SyncDevice,
} from "../../../types";
import {
  CheckIcon,
  CloudSyncIcon,
  UsersIcon,
  ShareIcon,
  GoogleIcon,
} from "../../icons";
// Account/sync UI reuses the settings styles (toggles, rows, sync-* cards).
import "../settings-screen/SettingsScreen.css";
import "./AccountScreen.css";

const SCOPE_OPTIONS: { value: string; label: string }[] = [
  { value: "clipboard", label: "Clipboard" },
  { value: "notes", label: "Notes" },
  { value: "both", label: "Clipboard & Notes" },
];

// ── Account & Cloud Sync screen ───────────────────────────────────────
// Owns everything identity/sync related: sign in/up (email + Google),
// account + devices, cloud-sync enablement, groups, and Live Share.

const AccountScreen: React.FC = () => {
  // ── Cloud Sync ─────────────────────────────────────────────────
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [serverUrl, setServerUrl] = useState("https://api.orangeclipboard.app");
  const [serverUrlDraft, setServerUrlDraft] = useState("https://api.orangeclipboard.app");
  const [editingUrl, setEditingUrl] = useState(false);
  const [syncUser, setSyncUser] = useState<SyncUser | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusInfo | null>(null);
  const [syncGroups, setSyncGroups] = useState<SyncGroup[]>([]);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [onlineDevices, setOnlineDevices] = useState<Set<string>>(new Set());

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

  // Forgot / reset password
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

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

  // ── Load state on mount ─────────────────────────────────────────
  useEffect(() => {
    invoke<boolean | null>("get_setting", { key: "sync_enabled" }).then((v) =>
      setSyncEnabled(v === true),
    );
    invoke<string | null>("get_setting", { key: "sync_server_url" }).then((v) => {
      const url = typeof v === "string" && v ? v : "https://api.orangeclipboard.app";
      setServerUrl(url);
      setServerUrlDraft(url);
    });

    invoke<SyncUser | null>("sync_get_user").then((u) => {
      setSyncUser(u);
      if (u) {
        invoke<SyncGroup[]>("sync_get_groups").then(setSyncGroups).catch(() => {});
        invoke<SharingSession[]>("sharing_get_sessions").then(setSharingSessions).catch(() => {});
        invoke<SyncDevice[]>("sync_list_devices").then(setDevices).catch(() => {});
        invoke<SyncStatusInfo>("sync_get_status").then((s) => {
          setSyncStatus(s);
          if (s.last_synced_at) setLastSynced(s.last_synced_at);
        }).catch(() => {});
      }
    });
  }, []);

  // ── Device presence: mark devices online/offline as events arrive ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ device_id?: string; online?: boolean }>(
      "sync:device-presence",
      (event) => {
        const { device_id, online } = event.payload;
        if (!device_id) return;
        setOnlineDevices((prev) => {
          const next = new Set(prev);
          if (online) next.add(device_id);
          else next.delete(device_id);
          return next;
        });
      },
    ).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
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

  // Post-authentication: hydrate account state (shared by password + OAuth).
  const loadPostLogin = (user: SyncUser) => {
    setSyncUser(user);
    invoke<SyncGroup[]>("sync_get_groups").then(setSyncGroups).catch(() => {});
    invoke<SharingSession[]>("sharing_get_sessions").then(setSharingSessions).catch(() => {});
    invoke<SyncDevice[]>("sync_list_devices").then(setDevices).catch(() => {});
    invoke<SyncStatusInfo>("sync_get_status").then((s) => {
      setSyncStatus(s);
      if (s.last_synced_at) setLastSynced(s.last_synced_at);
    }).catch(() => {});
  };

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
        deviceName: `Orange CP — ${navigator.platform || "Desktop"}`,
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
        deviceName: `Orange CP — ${navigator.platform || "Desktop"}`,
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
      setSyncGroups([]);
      setSharingSessions([]);
      setDevices([]);
      setOnlineDevices(new Set());
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
    <div className="settings-screen account-screen">
      <div className="settings-header">
        <h2 className="settings-title">Account &amp; Sync</h2>
        <p className="settings-subtitle">
          Sign in, manage your devices, and share across the cloud — end-to-end encrypted.
        </p>
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
              <div className="auth-card">
                <div className="auth-brand">
                  <div className="auth-brand-badge">
                    <CloudSyncIcon size={20} />
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
                          ? "Sync your clipboard & notes — end-to-end encrypted."
                          : "Sign in to sync across your devices."}
                  </p>
                </div>

                {oauthStage === "password" ? (
                  /* OAuth: account-password step (the E2E secret) */
                  <div className="auth-form">
                    <p className="auth-hint">
                      {oauthIsNew
                        ? "Set a password to encrypt your data — you'll enter it on each device, and it also lets you sign in with email."
                        : "Enter your account password to unlock your encrypted data."}
                    </p>
                    <label className="auth-field">
                      <span className="auth-label">{oauthIsNew ? "New password" : "Password"}</span>
                      <input
                        className="auth-input"
                        type="password"
                        placeholder="••••••••"
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
                          placeholder="••••••••"
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
                        ? "Unlocking…"
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
                        <span className="auth-reset-check"><CheckIcon size={16} strokeWidth={2.6} /></span>
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
                          {resetLoading ? "Sending…" : "Send reset link"}
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
                      ← Back to sign in
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
                          placeholder="••••••••"
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
                        disabled={loginLoading || oauthLoading || !loginEmail || !loginPassword}
                      >
                        {loginLoading
                          ? authMode === "signup"
                            ? "Creating account…"
                            : "Signing in…"
                          : authMode === "signup"
                            ? "Create account"
                            : "Sign in"}
                      </button>

                      <div className="auth-divider"><span>or</span></div>

                      <button
                        type="button"
                        className="auth-google"
                        onClick={handleGoogleSignIn}
                        disabled={loginLoading || oauthLoading}
                      >
                        <GoogleIcon size={16} />
                        {oauthLoading ? "Waiting for browser…" : "Continue with Google"}
                      </button>
                    </div>
                  </>
                )}
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

                {/* Devices */}
                {devices.length > 0 && (
                  <div className="sync-sub-section">
                    <div className="sync-sub-section-header">
                      <CloudSyncIcon size={13} />
                      <span className="sync-sub-section-title">Devices</span>
                    </div>
                    <div className="sync-groups-list">
                      {devices.map((d) => {
                        const online = onlineDevices.has(d.id);
                        return (
                          <div key={d.id} className="sync-group-row">
                            <div className="sync-group-info">
                              <span
                                className="sync-status-dot"
                                title={online ? "Online" : "Offline"}
                                style={{
                                  background: online ? "#22c55e" : "#9ca3af",
                                  flex: "0 0 auto",
                                }}
                              />
                              <span className="sync-group-name">
                                {d.device_name || "Unknown device"}
                              </span>
                              <span className="sync-group-meta">
                                {d.platform}
                                {online ? " · online" : ""}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

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
    </div>
  );
};

export default AccountScreen;
