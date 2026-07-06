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
// The scroll container reuses .settings-screen; everything else is acct-*/auth-*.
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

  const status = !syncStatus
    ? { kind: "checking", label: "Checking…" }
    : syncStatus.connected
      ? { kind: "connected", label: "Connected" }
      : syncStatus.pending_count > 0
        ? { kind: "pending", label: `${syncStatus.pending_count} pending` }
        : { kind: "offline", label: "Offline" };

  const scopePills = (value: string, onPick: (v: string) => void) => (
    <div className="acct-scope">
      <span className="acct-scope-label">Scope</span>
      <div className="acct-scope-pills">
        {SCOPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`acct-scope-pill${value === opt.value ? " active" : ""}`}
            onClick={() => onPick(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );

  // Advanced footer (server URL + turn sync off) — shown once signed in or ready.
  const advanced = (
    <div className="acct-card acct-advanced">
      <div className="acct-adv-row">
        <div className="acct-adv-info">
          <span className="acct-adv-label">Server</span>
          <span className="acct-adv-value">{serverUrl || "https://api.orangeclipboard.app"}</span>
        </div>
        {editingUrl ? (
          <div className="acct-url-edit">
            <input
              className="auth-input acct-url-input"
              value={serverUrlDraft}
              onChange={(e) => setServerUrlDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveUrl(); if (e.key === "Escape") setEditingUrl(false); }}
              autoFocus
              spellCheck={false}
            />
            <button type="button" className="acct-btn acct-btn--primary acct-btn--sm" onClick={handleSaveUrl}>Save</button>
            <button type="button" className="acct-btn acct-btn--sm" onClick={() => setEditingUrl(false)}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="acct-btn acct-btn--sm" onClick={() => setEditingUrl(true)}>Change</button>
        )}
      </div>
      <div className="acct-adv-divider" />
      <div className="acct-adv-row">
        <div className="acct-adv-info">
          <span className="acct-adv-label">Cloud Sync</span>
          <span className="acct-adv-hint">Turn off syncing on this device.</span>
        </div>
        <button type="button" className="acct-btn acct-btn--danger acct-btn--sm" onClick={handleSyncToggle}>Turn off</button>
      </div>
    </div>
  );

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
              Sign in, manage your devices, and share across the cloud — end-to-end encrypted.
            </p>
          </header>
        )}

        {!syncEnabled ? (
          /* ── Sync disabled: enable hero ── */
          <div className="acct-card acct-hero">
            <div className="acct-hero-badge"><CloudSyncIcon size={26} /></div>
            <h3 className="acct-hero-title">Sync across your devices</h3>
            <p className="acct-hero-desc">
              Keep your clipboard history and notes in sync on every device — end-to-end
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
            {advanced}
          </>
        ) : (
          /* ── Signed in ── */
          <>
            {/* Profile */}
            <div className="acct-card acct-profile">
              <div className="acct-avatar">
                {(syncUser.display_name || syncUser.email || "?").charAt(0).toUpperCase()}
              </div>
              <div className="acct-profile-text">
                <span className="acct-profile-name">{syncUser.display_name || "Your account"}</span>
                <span className="acct-profile-email">{syncUser.email}</span>
              </div>
              <span className={`acct-status acct-status--${status.kind}`}>
                <span className="acct-status-dot" />
                {status.label}
                {status.kind === "connected" && lastSynced ? ` · ${formatLastSynced(lastSynced)}` : ""}
              </span>
              <div className="acct-profile-actions">
                <button
                  type="button"
                  className="acct-btn"
                  onClick={handleSyncNow}
                  disabled={syncNowLoading}
                >
                  {syncNowLoading ? "Syncing…" : "Sync now"}
                </button>
                <button type="button" className="acct-btn acct-btn--danger" onClick={handleLogout}>
                  Sign out
                </button>
              </div>
            </div>

            {/* Devices */}
            <div className="acct-card">
              <div className="acct-card-head">
                <span className="acct-card-icon"><CloudSyncIcon size={15} /></span>
                <h3 className="acct-card-title">Devices</h3>
                {devices.length > 0 && <span className="acct-card-count">{devices.length}</span>}
              </div>
              {devices.length > 0 ? (
                <div className="acct-list">
                  {devices.map((d) => {
                    const online = onlineDevices.has(d.id);
                    return (
                      <div key={d.id} className="acct-row">
                        <span className={`acct-dot${online ? " online" : ""}`} />
                        <div className="acct-row-main">
                          <span className="acct-row-name">{d.device_name || "Unknown device"}</span>
                          <span className="acct-row-meta">{d.platform}{online ? " · online" : " · offline"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="acct-empty">No devices registered yet.</p>
              )}
            </div>

            {/* Shared Groups */}
            <div className="acct-card">
              <div className="acct-card-head">
                <span className="acct-card-icon"><UsersIcon size={15} /></span>
                <h3 className="acct-card-title">Shared Groups</h3>
                {syncGroups.length > 0 && <span className="acct-card-count">{syncGroups.length}</span>}
              </div>
              {syncGroups.length > 0 && (
                <div className="acct-list">
                  {syncGroups.map((g) => (
                    <div key={g.id} className="acct-row">
                      <div className="acct-row-main">
                        <span className="acct-row-name">{g.name}</span>
                        <span className="acct-row-meta">{g.member_count} member{g.member_count !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="acct-row-actions">
                        <button
                          type="button"
                          className="acct-btn acct-btn--sm"
                          onClick={() => handleCopyInvite(g.id)}
                        >
                          {copiedGroupId === g.id ? (
                            <><CheckIcon size={11} /> Copied</>
                          ) : (
                            <><ShareIcon size={11} /> Invite</>
                          )}
                        </button>
                        <button
                          type="button"
                          className="acct-btn acct-btn--sm acct-btn--danger"
                          onClick={() => handleLeaveGroup(g.id)}
                        >
                          Leave
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="acct-field-row">
                <input
                  className="auth-input"
                  placeholder="New group name"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); }}
                  disabled={groupLoading}
                />
                <button
                  type="button"
                  className="acct-btn acct-btn--primary"
                  onClick={handleCreateGroup}
                  disabled={groupLoading || !newGroupName.trim()}
                >
                  Create
                </button>
              </div>
              <div className="acct-field-row">
                <input
                  className="auth-input"
                  placeholder="Invite code to join"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleJoinGroup(); }}
                  disabled={groupLoading}
                />
                <button
                  type="button"
                  className="acct-btn"
                  onClick={handleJoinGroup}
                  disabled={groupLoading || !joinCode.trim()}
                >
                  Join
                </button>
              </div>
            </div>

            {/* Live Share */}
            <div className="acct-card">
              <div className="acct-card-head">
                <span className="acct-card-icon"><ShareIcon size={15} /></span>
                <h3 className="acct-card-title">Live Share</h3>
              </div>
              <p className="acct-card-desc">
                Share your clipboard or notes in real time with another person (up to 5 members).
              </p>

              {incomingInvite && (
                <div className="acct-invite-banner">
                  <div className="acct-invite-head"><ShareIcon size={13} /> Incoming invite</div>
                  <p className="acct-invite-code">{incomingInvite.invite_code}</p>
                  {incomingInvite.from_email && (
                    <p className="acct-row-meta">From {incomingInvite.from_email}</p>
                  )}
                  {scopePills(acceptScope, setAcceptScope)}
                  <div className="acct-row-actions acct-invite-actions">
                    <button
                      type="button"
                      className="acct-btn acct-btn--primary acct-btn--sm"
                      disabled={sharingLoading}
                      onClick={() => handleAcceptInvite(incomingInvite.invite_code, acceptScope)}
                    >
                      {sharingLoading ? "Accepting…" : "Accept"}
                    </button>
                    <button type="button" className="acct-btn acct-btn--sm" onClick={() => setIncomingInvite(null)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              {sharingSessions.length > 0 && (
                <div className="acct-list">
                  {sharingSessions.map((session) => (
                    <div key={session.share_group_id} className="acct-session">
                      <div className="acct-row">
                        <div className="acct-row-main">
                          <span className="acct-row-name">{session.name || "Live Share session"}</span>
                          <span className="acct-row-meta">
                            {session.members.length} member{session.members.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="acct-row-actions">
                          <button type="button" className="acct-btn acct-btn--sm" onClick={() => handleLeaveSession(session.share_group_id)}>Leave</button>
                          <button type="button" className="acct-btn acct-btn--sm acct-btn--danger" onClick={() => handleEndSession(session.share_group_id)}>End</button>
                        </div>
                      </div>
                      {scopePills(session.my_scope, (v) => handleUpdateScope(session.share_group_id, v))}
                      {session.members.length > 0 && (
                        <div className="acct-members">
                          {session.members.map((m) => (
                            <div key={m.user_id} className="acct-member">
                              <span className={`acct-dot${m.online ? " online" : ""}`} />
                              <span className="acct-row-name">{m.display_name}</span>
                              <span className="acct-row-meta">{m.scope}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="acct-subhead">Invite someone</div>
              <div className="acct-field-row">
                <input
                  className="auth-input"
                  type="email"
                  placeholder="Email address"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  disabled={sharingLoading}
                />
              </div>
              {scopePills(inviteScope, setInviteScope)}
              <button
                type="button"
                className="acct-btn acct-btn--primary acct-btn--wide"
                onClick={handleShareInvite}
                disabled={sharingLoading || !inviteEmail.trim()}
              >
                {sharingLoading ? "Sending…" : "Send invite"}
              </button>
              {inviteResult && (
                <div className="acct-invite-result">
                  <span className="acct-row-meta">Invite code</span>
                  <code className="acct-invite-code-inline">{inviteResult.invite_code}</code>
                  <button
                    type="button"
                    className="acct-btn acct-btn--sm"
                    onClick={() => navigator.clipboard.writeText(inviteResult.invite_code).catch(() => {})}
                  >
                    <ShareIcon size={11} /> Copy
                  </button>
                </div>
              )}

              <div className="acct-subhead">Join by code</div>
              <div className="acct-field-row">
                <input
                  className="auth-input"
                  placeholder="Paste invite code"
                  value={acceptCode}
                  onChange={(e) => setAcceptCode(e.target.value)}
                  disabled={sharingLoading}
                />
                <button
                  type="button"
                  className="acct-btn"
                  onClick={() => handleAcceptInvite(acceptCode, acceptScope)}
                  disabled={sharingLoading || !acceptCode.trim()}
                >
                  {sharingLoading ? "Joining…" : "Join"}
                </button>
              </div>
            </div>

            {advanced}
          </>
        )}
      </div>
    </div>
  );
};

export default AccountScreen;
