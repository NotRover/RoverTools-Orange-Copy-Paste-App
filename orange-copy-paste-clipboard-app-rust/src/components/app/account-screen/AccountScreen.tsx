import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  SyncUser,
  SyncGroup,
  SyncStatusInfo,
  SharingSession,
  SyncDevice,
  SyncConnection,
  SyncInvite,
  SyncInviteList,
  SyncQuota,
} from "../../../types";
import {
  CaretDown,
  CaretRight,
  CaretUp,
  Check,
  CloudCheck,
  Copy,
  Desktop,
  DeviceMobile,
  Envelope,
  HardDrives,
  Laptop,
  Plus,
  ShareNetwork,
  Key,
  WarningCircle,
} from "@phosphor-icons/react";
import { GoogleIcon } from "../../icons";
import { UserAvatar } from "../../UserAvatar";
// The scroll container reuses .settings-screen; everything else is acct-*/auth-*.
import "../settings-screen/SettingsScreen.css";
import "./AccountScreen.css";

const SCOPE_OPTIONS: { value: string; label: string }[] = [
  { value: "clipboard", label: "Clipboard" },
  { value: "notes", label: "Notes" },
  { value: "both", label: "Clipboard & Notes" },
];

// Space avatars must match the Sharing screen's group list exactly — same
// palette, same seed, same initials — so a space is recognisable across screens.
// Mirrors AVATAR_PALETTE / groupAvatarColor in sync-screen/SyncScreen.tsx.
const AVATAR_PALETTE = [
  "#ff3e1c", "#f59e0b", "#22c55e", "#3b82f6",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

function groupAvatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/** Display an invite code as XXXX-XXXX when it is a plain 8-char code. */
function formatInviteCode(code: string): string {
  const c = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : code;
}

/** Lowercase scope wording for the meta line ("clipboard and notes"). */
function scopeLabel(scope: string): string {
  if (scope === "both") return "clipboard and notes";
  return scope;
}

/** Member avatar. A user id is not a name — with no display name or email there
    are no initials to show, so it falls back to a glyph instead of UUID digits. */
function MemberAvatar({
  displayName,
  email,
  avatarUrl,
  self,
}: {
  displayName: string | null | undefined;
  email: string | null | undefined;
  avatarUrl: string | null | undefined;
  self: SyncUser | null;
}) {
  const label = self
    ? self.display_name || self.email || ""
    : displayName || email || "";
  return (
    <UserAvatar
      className="acct-member-avatar"
      // Own row: bootstrap's copy is the freshest one this client has.
      url={self ? self.avatar_url : avatarUrl}
      label={label}
      glyphSize={11}
    />
  );
}

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

/** One row in the unified Shared spaces list: a pool group or a live session. */
type SharedSpace =
  | { kind: "pool"; id: string; group: SyncGroup }
  | { kind: "session"; id: string; session: SharingSession };

// ── Account & Cloud Sync screen ───────────────────────────────────────
// Owns everything identity/sync related: sign in/up (email + Google),
// account + devices, cloud-sync enablement, and shared spaces (pool
// groups + Live Share sessions).

const AccountScreen: React.FC = () => {
  // ── Cloud Sync ─────────────────────────────────────────────────
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncUser, setSyncUser] = useState<SyncUser | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusInfo | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [syncGroups, setSyncGroups] = useState<SyncGroup[]>([]);
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

  // ── Shared spaces (pool groups + Live Share sessions) ──────────
  const [sharingSessions, setSharingSessions] = useState<SharingSession[]>([]);
  const [invites, setInvites] = useState<SyncInviteList>({ sent: [], received: [] });
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinLoading, setJoinLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Invite by email" inputs, keyed by group id (several rows can be open).
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});

  // Create flow — inline "New space" panel with two presets.
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"lasting" | "quick">("lasting");
  const [newGroupName, setNewGroupName] = useState("");
  // Owner's history policy for a group being created (server default is true).
  const [newGroupShareHistory, setNewGroupShareHistory] = useState(true);
  const [quickEmail, setQuickEmail] = useState("");
  const [quickScope, setQuickScope] = useState("clipboard");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] = useState<string | null>(null);

  // Armed "Delete space" confirmation (group id), auto-reset after a beat.
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const refreshSpaces = useCallback(() => {
    invoke<SyncGroup[]>("sync_get_groups").then(setSyncGroups).catch(() => {});
    invoke<SharingSession[]>("sharing_refresh_sessions")
      .then(setSharingSessions)
      .catch(() => {});
  }, []);

  const refreshInvites = useCallback(() => {
    invoke<SyncInviteList>("sync_list_invites").then(setInvites).catch(() => {});
  }, []);

  // ── Load state on mount ─────────────────────────────────────────
  useEffect(() => {
    invoke<boolean | null>("get_setting", { key: "sync_enabled" }).then((v) =>
      setSyncEnabled(v === true),
    );

    invoke<SyncUser | null>("sync_get_user").then((u) => {
      setSyncUser(u);
      if (u) {
        refreshSpaces();
        refreshInvites();
        refreshQuota();
        invoke<SyncDevice[]>("sync_list_devices").then(setDevices).catch(() => {});
        invoke<SyncStatusInfo>("sync_get_status").then((s) => {
          setSyncStatus(s);
          if (s.last_synced_at) setLastSynced(s.last_synced_at);
        }).catch(() => {});
      }
    });
  }, [refreshSpaces, refreshInvites, refreshQuota]);

  // ── Silent session restore (fired by App on startup) ────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<SyncUser>("sync:session-restored", (event) => {
      setSyncUser(event.payload);
      refreshSpaces();
      refreshInvites();
      refreshQuota();
      invoke<SyncDevice[]>("sync_list_devices").then(setDevices).catch(() => {});
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [refreshSpaces, refreshInvites, refreshQuota]);

  // ── Member presence: another user in a shared space came or went ──
  // Rust already updated its cached sessions, so re-reading the cache is enough.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("sharing:presence-changed", () => {
      invoke<SharingSession[]>("sharing_get_sessions")
        .then(setSharingSessions)
        .catch(() => {});
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

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

  // ── Invite + membership events ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const track = (p: Promise<() => void>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    };
    track(listen("sync:group-membership", () => refreshSpaces()));
    track(
      listen<SyncInvite>("sync:invite-received", (event) => {
        setInvites((prev) => ({
          ...prev,
          received: [
            event.payload,
            ...prev.received.filter((i) => i.id !== event.payload.id),
          ],
        }));
      }),
    );
    track(
      listen<{ invite_id: string; status: string; group_id: string }>(
        "sync:invite-updated",
        () => {
          refreshInvites();
          refreshSpaces();
        },
      ),
    );
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [refreshSpaces, refreshInvites]);

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


  // Post-authentication: hydrate account state (shared by password + OAuth).
  const loadPostLogin = (user: SyncUser) => {
    setSyncUser(user);
    refreshSpaces();
    refreshInvites();
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
      setSyncGroups([]);
      setSharingSessions([]);
      setInvites({ sent: [], received: [] });
      setExpandedSpaces(new Set());
      setSpacesError(null);
      setDeviceError(null);
      setDevices([]);
      setPresenceOverrides({});
      setQuota(null);
      setJoinOpen(false);
      setCreateOpen(false);
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

  // ── Shared spaces handlers ──────────────────────────────────────
  const errMsg = (e: unknown, fallback: string) =>
    typeof e === "string" ? e : fallback;

  // Accordion: only one space stays open, so the list never grows past a screen.
  const toggleSpace = (id: string) => {
    setExpandedSpaces((prev) => (prev.has(id) ? new Set() : new Set([id])));
  };

  const handleCopy = useCallback((key: string, text: string) => {
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(key);
    copiedTimerRef.current = setTimeout(() => {
      setCopiedKey(null);
      copiedTimerRef.current = null;
    }, 1500);
  }, []);

  const handleCreateLasting = async () => {
    if (!newGroupName.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const g = await invoke<SyncGroup>("sync_create_group", {
        name: newGroupName.trim(),
        shareHistory: newGroupShareHistory,
      });
      setSyncGroups((prev) => [...prev, g]);
      setNewGroupName("");
      setCreatedInvite(g.invite_code ?? null);
      refreshSpaces();
    } catch (e) {
      setCreateError(errMsg(e, "Could not create the space."));
    } finally {
      setCreateLoading(false);
    }
  };

  const handleCreateQuick = async () => {
    if (!quickEmail.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const result = await invoke<{ invite_code: string; share_group_id: string; expires_at: number }>(
        "sharing_invite",
        { email: quickEmail.trim(), scope: quickScope },
      );
      setQuickEmail("");
      setCreatedInvite(result.invite_code);
      refreshSpaces();
      refreshInvites();
    } catch (e) {
      setCreateError(errMsg(e, "Could not send the invite."));
    } finally {
      setCreateLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    setJoinLoading(true);
    setSpacesError(null);
    try {
      // The Rust side extracts the code from a pasted link and normalizes it.
      await invoke("sync_join_group", { inviteCode: joinCode.trim() });
      setJoinCode("");
      refreshSpaces();
    } catch (e) {
      setSpacesError(errMsg(e, "Could not join with that code."));
    } finally {
      setJoinLoading(false);
    }
  };

  const handleLeaveGroup = async (groupId: string) => {
    setSpacesError(null);
    try {
      await invoke("sync_leave_group", { groupId });
      setSyncGroups((prev) => prev.filter((g) => g.id !== groupId));
    } catch (e) {
      setSpacesError(errMsg(e, "Could not leave the space."));
    }
  };

  const handleRemoveMember = async (groupId: string, memberUserId: string) => {
    setSpacesError(null);
    try {
      await invoke("sync_remove_member", { groupId, memberUserId });
      refreshSpaces();
    } catch (e) {
      setSpacesError(errMsg(e, "Could not remove the member."));
    }
  };

  // One-step confirm for space deletion: first click arms, second deletes.
  const handleDeleteGroup = async (groupId: string) => {
    if (deleteConfirmId !== groupId) {
      if (deleteConfirmTimerRef.current !== null)
        clearTimeout(deleteConfirmTimerRef.current);
      setDeleteConfirmId(groupId);
      deleteConfirmTimerRef.current = setTimeout(() => {
        setDeleteConfirmId(null);
        deleteConfirmTimerRef.current = null;
      }, 3000);
      return;
    }
    if (deleteConfirmTimerRef.current !== null) {
      clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = null;
    }
    setDeleteConfirmId(null);
    setSpacesError(null);
    try {
      await invoke("sync_delete_group", { groupId });
      refreshSpaces();
    } catch (e) {
      setSpacesError(errMsg(e, "Could not delete the space."));
    }
  };

  const handleSendInvite = async (groupId: string) => {
    const email = (inviteEmails[groupId] ?? "").trim();
    if (!email) return;
    setSpacesError(null);
    try {
      await invoke<SyncInvite>("sync_send_invite", { groupId, email });
      setInviteEmails((prev) => ({ ...prev, [groupId]: "" }));
      refreshInvites();
    } catch (e) {
      setSpacesError(errMsg(e, "Could not send the invite."));
    }
  };

  const handleAcceptInvite = async (inviteId: string) => {
    setSpacesError(null);
    try {
      await invoke("sync_accept_invite", { inviteId });
      refreshInvites();
      refreshSpaces();
    } catch (e) {
      setSpacesError(errMsg(e, "Could not accept the invite."));
    }
  };

  const handleDeclineInvite = async (inviteId: string) => {
    setSpacesError(null);
    try {
      await invoke("sync_decline_invite", { inviteId });
      refreshInvites();
    } catch (e) {
      setSpacesError(errMsg(e, "Could not decline the invite."));
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    setSpacesError(null);
    try {
      await invoke("sync_revoke_invite", { inviteId });
      refreshInvites();
    } catch (e) {
      setSpacesError(errMsg(e, "Could not revoke the invite."));
    }
  };

  const handleUpdateScope = async (shareGroupId: string, scope: string) => {
    setSpacesError(null);
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
      setSpacesError(errMsg(e, "Could not change the scope."));
    }
  };

  const handleLeaveSession = async (shareGroupId: string) => {
    setSpacesError(null);
    try {
      await invoke("sharing_leave_session", { shareGroupId });
      setSharingSessions((prev) => prev.filter((s) => s.share_group_id !== shareGroupId));
    } catch (e) {
      setSpacesError(errMsg(e, "Could not leave the session."));
    }
  };

  const handleEndSession = async (shareGroupId: string) => {
    setSpacesError(null);
    try {
      await invoke("sharing_end_session", { shareGroupId });
      setSharingSessions((prev) => prev.filter((s) => s.share_group_id !== shareGroupId));
    } catch (e) {
      setSpacesError(errMsg(e, "Could not end the session."));
    }
  };

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

  // Copy-code / copy-link button pair used for invite codes.
  const copyButtons = (key: string, code: string) => (
    <>
      <button
        type="button"
        className="acct-btn acct-btn--sm"
        onClick={() => handleCopy(`${key}:code`, code)}
      >
        {copiedKey === `${key}:code` ? (
          <><Check size={11} /> Copied</>
        ) : (
          <><Copy size={11} /> Copy code</>
        )}
      </button>
      <button
        type="button"
        className="acct-btn acct-btn--sm"
        onClick={() => handleCopy(`${key}:link`, `orange://join?code=${code}`)}
      >
        {copiedKey === `${key}:link` ? (
          <><Check size={11} /> Copied</>
        ) : (
          <><ShareNetwork size={11} /> Copy link</>
        )}
      </button>
    </>
  );

  // Unified Shared spaces list: pool groups first, then live sessions.
  const spaces: SharedSpace[] = [
    ...syncGroups.map((g) => ({ kind: "pool" as const, id: g.id, group: g })),
    ...sharingSessions.map((s) => ({
      kind: "session" as const,
      id: s.share_group_id,
      session: s,
    })),
  ];
  const receivedPending = invites.received.filter((i) => i.status === "pending");
  const sentInvites = invites.sent;

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
              Sign in, manage your devices, and share across the cloud. End-to-end encrypted.
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
                <button type="button" className="acct-btn acct-btn--quiet" onClick={handleLogout}>
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
                <button
                  type="button"
                  className="acct-btn acct-btn--sm acct-skipped-dismiss"
                  onClick={handleDismissSkipped}
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Attention strip — invites waiting on you */}
            {receivedPending.length > 0 && (
              <div className="acct-attn-strip">
                {receivedPending.map((inv) => (
                  <div key={inv.id} className="acct-attn">
                    <Envelope size={15} className="acct-attn-icon" />
                    <span className="acct-attn-text">
                      <strong>{inv.inviter_name || "Someone"}</strong> invited you to{" "}
                      {inv.group_type === "live_share"
                        ? "share their clipboard live"
                        : inv.group_name}
                    </span>
                    <div className="acct-row-actions acct-attn-actions">
                      <button
                        type="button"
                        className="acct-btn acct-btn--primary acct-btn--sm"
                        onClick={() => handleAcceptInvite(inv.id)}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="acct-btn acct-btn--sm"
                        onClick={() => handleDeclineInvite(inv.id)}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Sharing */}
            <section className="acct-zone">
              <div className="acct-zone-head">
                <span className="acct-zone-icon"><ShareNetwork size={13} /></span>
                <span className="acct-zone-label">Sharing</span>
                <div className="acct-zone-actions">
                  <button
                    type="button"
                    className={`acct-btn acct-btn--sm${createOpen ? " acct-btn--on" : ""}`}
                    aria-expanded={createOpen}
                    onClick={() => {
                      setCreateOpen((v) => !v);
                      setJoinOpen(false);
                      setCreateError(null);
                      setCreatedInvite(null);
                    }}
                  >
                    <Plus size={11} /> New space
                  </button>
                  <button
                    type="button"
                    className={`acct-btn acct-btn--sm${joinOpen ? " acct-btn--on" : ""}`}
                    aria-expanded={joinOpen}
                    onClick={() => {
                      setJoinOpen((v) => !v);
                      setCreateOpen(false);
                      setSpacesError(null);
                    }}
                  >
                    Join
                  </button>
                </div>
              </div>

              {spacesError && <span className="auth-error">{spacesError}</span>}

              <div className="acct-spaces">
              {createOpen && (
                <div className="acct-card acct-create-panel">
                  <div className="acct-scope-pills acct-create-modes">
                    <button
                      type="button"
                      className={`acct-scope-pill${createMode === "lasting" ? " active" : ""}`}
                      onClick={() => setCreateMode("lasting")}
                    >
                      Lasting space
                    </button>
                    <button
                      type="button"
                      className={`acct-scope-pill${createMode === "quick" ? " active" : ""}`}
                      onClick={() => setCreateMode("quick")}
                    >
                      Quick share
                    </button>
                  </div>
                  {createMode === "lasting" ? (
                    <>
                      <div className="acct-field-row">
                        <input
                          className="auth-input"
                          placeholder="Space name"
                          value={newGroupName}
                          onChange={(e) => setNewGroupName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleCreateLasting(); }}
                          disabled={createLoading}
                        />
                        <button
                          type="button"
                          className="acct-btn acct-btn--primary"
                          onClick={handleCreateLasting}
                          disabled={createLoading || !newGroupName.trim()}
                        >
                          {createLoading ? "Creating..." : "Create"}
                        </button>
                      </div>
                      {/* Decided at creation and fixed per member at join, so changing it
                          later never retroactively widens what an existing member sees. */}
                      <label className="acct-check-row">
                        <input
                          type="checkbox"
                          checked={newGroupShareHistory}
                          onChange={(e) => setNewGroupShareHistory(e.target.checked)}
                          disabled={createLoading}
                        />
                        <span>
                          New members can read earlier entries
                          <span className="acct-card-desc">
                            {newGroupShareHistory
                              ? "Anyone who joins can see everything shared before they joined."
                              : "New members only see entries shared after they join."}
                          </span>
                        </span>
                      </label>
                    </>
                  ) : (
                    <>
                      <div className="acct-field-row">
                        <input
                          className="auth-input"
                          type="email"
                          placeholder="Email address"
                          value={quickEmail}
                          onChange={(e) => setQuickEmail(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleCreateQuick(); }}
                          disabled={createLoading}
                        />
                        <button
                          type="button"
                          className="acct-btn acct-btn--primary"
                          onClick={handleCreateQuick}
                          disabled={createLoading || !quickEmail.trim()}
                        >
                          {createLoading ? "Sending..." : "Invite"}
                        </button>
                      </div>
                      {scopePills(quickScope, setQuickScope)}
                    </>
                  )}
                  {createError && <span className="auth-error">{createError}</span>}
                  {createdInvite && (
                    <div className="acct-invite-result">
                      <span className="acct-row-meta">Invite code</span>
                      <code className="acct-invite-code-inline">
                        {formatInviteCode(createdInvite)}
                      </code>
                      {copyButtons("created", createdInvite)}
                    </div>
                  )}
                </div>
              )}

              {joinOpen && (
                <div className="acct-card acct-create-panel acct-join-panel">
                  <div className="acct-field-row">
                    <input
                      className="auth-input"
                      placeholder="Paste an invite code or link"
                      value={joinCode}
                      autoFocus
                      onChange={(e) => setJoinCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleJoin(); }}
                      disabled={joinLoading}
                    />
                    <button
                      type="button"
                      className="acct-btn acct-btn--primary"
                      onClick={handleJoin}
                      disabled={joinLoading || !joinCode.trim()}
                    >
                      {joinLoading ? "Joining..." : "Join"}
                    </button>
                  </div>
                </div>
              )}

              {spaces.map((space) => {
                const open = expandedSpaces.has(space.id);
                const isPool = space.kind === "pool";
                const name = isPool
                  ? space.group.name
                  : (space.session.name || "Quick share");
                const memberCount = isPool
                  ? space.group.member_count
                  : space.session.members.length;
                const isOwner = isPool && space.group.is_owner;
                return (
                  <div
                    key={space.id}
                    className={`acct-card acct-space${open ? " acct-space--open" : ""}`}
                  >
                    <button
                      type="button"
                      className="acct-space-head"
                      aria-expanded={open}
                      onClick={() => toggleSpace(space.id)}
                    >
                      {isPool ? (
                        <span
                          className="acct-space-avatar"
                          style={{ background: groupAvatarColor(space.group.id) }}
                        >
                          {space.group.name.slice(0, 2).toUpperCase()}
                        </span>
                      ) : (
                        <span className="acct-space-avatar acct-space-avatar--live">
                          <span className="acct-space-live-dot" />
                        </span>
                      )}
                      <span className="acct-row-main">
                        <span className="acct-row-name">{name}</span>
                        {/* Settings that read as description, not state, live in the
                            meta line — only the one status stays a pill. */}
                        <span className="acct-row-meta">
                          {memberCount} member{memberCount === 1 ? "" : "s"}
                          {isPool
                            ? ` - history ${space.group.share_history ? "on" : "off"}`
                            : ` - ${scopeLabel(space.session.my_scope)}`}
                        </span>
                      </span>
                      <span className="acct-space-pills">
                        {isOwner && (
                          <span className="acct-badge acct-badge--owner">owner</span>
                        )}
                        {!isPool && (
                          <span className="acct-badge acct-badge--live">live</span>
                        )}
                      </span>
                      <CaretRight
                        size={11}
                        weight="bold"
                        className={`acct-space-caret${open ? " acct-space-caret--open" : ""}`}
                      />
                    </button>
                    {open && (
                      <div className="acct-space-body">
                        <div className="acct-members">
                          {isPool
                            ? space.group.members.map((m) => (
                                <div key={m.user_id} className="acct-member">
                                  <MemberAvatar
                                    displayName={m.display_name}
                                    email={null}
                                    avatarUrl={m.avatar_url}
                                    self={m.user_id === syncUser?.user_id ? syncUser : null}
                                  />
                                  <span className="acct-row-name">
                                    {m.user_id === syncUser?.user_id
                                      ? "You"
                                      : m.display_name || "Member"}
                                  </span>
                                  {/* "member" is the default — only the owner is worth marking. */}
                                  {m.role === "owner" && (
                                    <span className="acct-badge acct-badge--owner">owner</span>
                                  )}
                                  {!m.has_group_key && (
                                    <span className="acct-badge acct-badge--warn">
                                      waiting for key
                                    </span>
                                  )}
                                  {isOwner && m.user_id !== syncUser?.user_id && (
                                    <button
                                      type="button"
                                      className="acct-btn acct-btn--sm acct-btn--danger"
                                      onClick={() => handleRemoveMember(space.id, m.user_id)}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              ))
                            : space.session.members.map((m) => (
                                <div key={m.user_id} className="acct-member">
                                  <MemberAvatar
                                    displayName={m.display_name}
                                    email={m.email}
                                    avatarUrl={m.avatar_url}
                                    self={m.user_id === syncUser?.user_id ? syncUser : null}
                                  />
                                  <span className="acct-row-name">
                                    {m.user_id === syncUser?.user_id
                                      ? "You"
                                      : m.display_name || m.email || "Member"}
                                  </span>
                                  <span className="acct-row-meta">{scopeLabel(m.scope)}</span>
                                  <span className={`acct-dot${m.online ? " online" : ""}`} />
                                </div>
                              ))}
                        </div>

                      </div>
                    )}

                    {/* Footer strip: everything that acts on the space, on its
                        own tinted band so the member list stays a list. */}
                    {open && (
                      <div className="acct-space-foot">
                        {isPool && isOwner && space.group.invite_code && (
                          <>
                            <div className="acct-space-foot-row">
                              <code className="acct-invite-code-inline">
                                {formatInviteCode(space.group.invite_code)}
                              </code>
                              {copyButtons(space.id, space.group.invite_code)}
                              <button
                                type="button"
                                className="acct-btn acct-btn--sm acct-btn--danger acct-space-foot-end"
                                onClick={() => handleDeleteGroup(space.id)}
                                onBlur={() => {
                                  if (deleteConfirmId === space.id) setDeleteConfirmId(null);
                                }}
                              >
                                {deleteConfirmId === space.id
                                  ? "Confirm delete?"
                                  : "Delete space"}
                              </button>
                            </div>
                            <div className="acct-space-foot-row">
                              <input
                                className="auth-input"
                                type="email"
                                placeholder="Invite by email"
                                value={inviteEmails[space.id] ?? ""}
                                onChange={(e) =>
                                  setInviteEmails((prev) => ({
                                    ...prev,
                                    [space.id]: e.target.value,
                                  }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSendInvite(space.id);
                                }}
                              />
                              <button
                                type="button"
                                className="acct-btn acct-btn--sm"
                                onClick={() => handleSendInvite(space.id)}
                                disabled={!(inviteEmails[space.id] ?? "").trim()}
                              >
                                Invite
                              </button>
                            </div>
                          </>
                        )}

                        {isPool && !isOwner && (
                          <div className="acct-space-foot-row">
                            <button
                              type="button"
                              className="acct-btn acct-btn--sm acct-btn--danger acct-space-foot-end"
                              onClick={() => handleLeaveGroup(space.id)}
                            >
                              Leave space
                            </button>
                          </div>
                        )}

                        {!isPool && (
                          <div className="acct-space-foot-row">
                            {scopePills(space.session.my_scope, (v) =>
                              handleUpdateScope(space.id, v),
                            )}
                            <button
                              type="button"
                              className="acct-btn acct-btn--sm acct-space-foot-end"
                              onClick={() => handleLeaveSession(space.id)}
                            >
                              Leave
                            </button>
                            <button
                              type="button"
                              className="acct-btn acct-btn--sm acct-btn--danger"
                              onClick={() => handleEndSession(space.id)}
                            >
                              End share
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Outbound invites — dashed, because a space you've offered isn't a
                  space you have yet. */}
              {sentInvites.length > 0 && (
                <div className="acct-card acct-sent">
                  {sentInvites.map((inv) => (
                    <div key={inv.id} className="acct-sent-row">
                      <Envelope size={15} className="acct-sent-icon" />
                      <span className="acct-sent-text">
                        {inv.invitee_email} invited to {inv.group_name}
                      </span>
                      <span className="acct-sent-status">{inv.status}</span>
                      {inv.status === "pending" && (
                        <button
                          type="button"
                          className="acct-linkbtn"
                          onClick={() => handleRevokeInvite(inv.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {spaces.length === 0 && sentInvites.length === 0 && (
                <div className="acct-card">
                  <p className="acct-empty">
                    Nothing shared yet. Create a space to sync with your other
                    devices, or join one with an invite code.
                  </p>
                </div>
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
