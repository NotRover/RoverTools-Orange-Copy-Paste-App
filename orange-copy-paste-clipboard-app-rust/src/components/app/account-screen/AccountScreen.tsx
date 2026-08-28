import { sharedNow } from "../../../clock";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppScreen,
  ClipboardEntry,
  DisplayKind,
  Note,
  SyncUser,
  SyncStatusInfo,
  SyncDevice,
  SyncConnection,
  SyncMode,
  SyncQuota,
  SyncServerBreakdown,
} from "../../../types";
import { deriveDisplayKind } from "../../../types";
import { TYPE_LABELS } from "../../entry-types/EntryTypePill";
import { showOnlyKinds } from "../clipboard-screen/search-filter/SearchFilter";
import {
  CaretDown,
  CaretRight,
  CaretUp,
  ChartBar,
  Check,
  Cloud,
  CloudArrowUp,
  CloudCheck,
  Desktop,
  DeviceMobile,
  HardDrives,
  Laptop,
  Key,
  Stack,
  WarningCircle,
} from "@phosphor-icons/react";
import { ClipboardIcon, GoogleIcon, NotesIcon } from "../../icons";
import { deferDestructive } from "../toast/toastBus";
import { usePendingRemovals } from "../../../hooks/pendingRemoval";
import { useEntrySyncStates } from "../../../hooks/useEntrySyncStates";
import {
  NETWORK_REFOCUS_MS,
  useWindowRefocus,
} from "../../../hooks/useWindowRefocus";
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

/** How long the sign-in screen waits on the browser before offering a retry. */
const OAUTH_WAIT_MS = 120_000;

/** What a bulk upload would cost, measured before it starts. */
type UnsyncedPreview = {
  total: number;
  images: number;
  image_bytes: number;
  free_bytes: number;
  images_that_fit: number;
};

const MODE_OPTIONS: { value: SyncMode; label: string }[] = [
  { value: "realtime", label: "Realtime" },
  { value: "passive", label: "Passive" },
  { value: "manual", label: "Manual" },
];

/** How many items the account holds on the server, kept for the session.
 *
 *  Module-level rather than component state: the screen mounts and unmounts
 *  every time it is navigated to, and `sync_server_entry_count` pages the
 *  server 500 rows at a time - up to 200 requests on a large account. Paying
 *  that on every visit is not worth a number that moves rarely. Cleared by
 *  `forgetCloudCount` whenever something changes what the server holds.
 *  Deliberately not persisted: one app run is the right lifetime. */
let cloudCountCache: SyncServerBreakdown | null = null;

function forgetCloudCount() {
  cloudCountCache = null;
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

// ── Account & Cloud Sync screen ───────────────────────────────────────
// Owns identity and personal backup: sign in/up (email + Google), the
// account itself, devices and storage, and how this device applies its own
// entries from other devices. Sharing lives on the Spaces screen.

interface AccountScreenProps {
  /** Everything held on this device, so the composition panel can describe it
   *  without a second source of truth. Already in App's hands and already kept
   *  live there. */
  entries: ClipboardEntry[];
  notes: Note[];
  /** Used by the composition rows to open what they are counting. */
  onNavigate: (screen: AppScreen) => void;
  /** Rust is retrying a session restore that failed for a transient reason.
   *  The credentials are good, so this screen must not ask for a password. */
  restoringSession: boolean;
  /** One-time code from an `orange://reset?code=...` link, held by App because
   *  this screen is usually not mounted when the mail is opened. */
  resetCode?: string | null;
  onResetCodeConsumed?: () => void;
}

/** The order kinds are shown in, and the order they stack in the bar. Fixed
 *  rather than sorted by count, so a row does not move under the pointer when
 *  something is copied while the panel is open. */
const COMPOSITION_ORDER: DisplayKind[] = [
  "text",
  "url",
  "html",
  "image",
  "document",
  "file",
  "folder",
  "video",
];

const AccountScreen: React.FC<AccountScreenProps> = ({
  entries,
  notes,
  onNavigate,
  restoringSession,
  resetCode,
  onResetCodeConsumed,
}) => {
  // ── Cloud Sync ─────────────────────────────────────────────────
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncUser, setSyncUser] = useState<SyncUser | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusInfo | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>("realtime");
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  // Live presence overrides on top of the server snapshot (device.online):
  // undefined = no event seen yet, use the snapshot.
  const [presenceOverrides, setPresenceOverrides] = useState<
    Record<string, boolean>
  >({});

  // A device removed a moment ago is off the list while the Undo toast is up,
  // even though the server has not been told yet and still returns it.
  const pendingGone = usePendingRemovals();
  const shownDevices = devices.filter(
    (d) => !pendingGone.has(`device:${d.id}`),
  );

  // Every device list lands through here so the overrides never outlive the
  // rows they describe. A revoked device keeps its id when it registers again,
  // and a stale "online" from before the revoke would then sit on top of an
  // accurate snapshot saying otherwise.
  const applyDevices = useCallback((ds: SyncDevice[]) => {
    setDevices(ds);
    setPresenceOverrides((prev) => {
      const live = Object.fromEntries(
        Object.entries(prev).filter(([id]) => ds.some((d) => d.id === id)),
      );
      return Object.keys(live).length === Object.keys(prev).length ? prev : live;
    });
  }, []);

  // Login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  // Set when the user asks for the sign-in form while a restore is still
  // running - switching accounts, or simply out of patience.
  const [signInAnyway, setSignInAnyway] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  // OAuth (Google) — two-step: browser handshake, then account password.
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthStage, setOauthStage] = useState<"password" | null>(null);
  const [oauthEmail, setOauthEmail] = useState("");
  const [oauthIsNew, setOauthIsNew] = useState(false);
  const [oauthPassword, setOauthPassword] = useState("");
  const [oauthConfirm, setOauthConfirm] = useState("");
  const oauthTimer = useRef<number | null>(null);

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

  // Finishing a reset from the emailed link: the code arrives as a prop, the
  // new password is typed here, and startOver is only offered once the plain
  // attempt has failed for want of the encryption key.
  const [newPassword, setNewPassword] = useState("");
  const [newConfirm, setNewConfirm] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetStageError, setResetStageError] = useState<string | null>(null);
  const [offerStartOver, setOfferStartOver] = useState(false);

  // Typed on the reset panel when this machine cannot produce the key by itself.
  const [recoveryEntry, setRecoveryEntry] = useState("");

  // Changing the password while signed in - the path that cannot lose anything.
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeDone, setChangeDone] = useState(false);

  // Saving a recovery code. `recoveryNeeded` is null until asked, and only a
  // definite false answer is allowed to suppress the panel - guessing would put
  // a blocking screen in front of an account that already has a code.
  const [recoveryNeeded, setRecoveryNeeded] = useState<boolean | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoveryAck, setRecoveryAck] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoverySavedTo, setRecoverySavedTo] = useState<string | null>(null);
  const [recoveryCopied, setRecoveryCopied] = useState(false);

  // Devices
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // Per-entry sync state for this device, already kept fresh by its own
  // listeners - the stats tiles read it rather than polling for themselves.
  const entryStates = useEntrySyncStates();

  // Blob storage usage — null until a successful fetch (the row stays hidden).
  const [quota, setQuota] = useState<SyncQuota | null>(null);

  // Sync actions
  const [syncNowLoading, setSyncNowLoading] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);

  const refreshQuota = useCallback(() => {
    invoke<SyncQuota>("sync_get_quota")
      .then(setQuota)
      .catch(() => {});
  }, []);

  // Items on the server, account-wide. Three states, not two: never read,
  // reading, and read - so a failed count can never render as a confident 0.
  const [cloudCount, setCloudCount] =
    useState<SyncServerBreakdown | null>(cloudCountCache);
  const [cloudCounting, setCloudCounting] = useState(false);

  const refreshCloudCount = useCallback((force = false) => {
    if (force) forgetCloudCount();
    if (cloudCountCache !== null) {
      setCloudCount(cloudCountCache);
      return;
    }
    setCloudCounting(true);
    invoke<SyncServerBreakdown>("sync_server_breakdown")
      .then((n) => {
        cloudCountCache = n;
        setCloudCount(n);
      })
      .catch(() => setCloudCount(null))
      .finally(() => setCloudCounting(false));
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
        refreshCloudCount();
        invoke<string>("sync_get_mode")
          .then((m) =>
            setSyncMode(
              m === "passive" || m === "manual" ? m : "realtime",
            ),
          )
          .catch(() => {});
        invoke<SyncDevice[]>("sync_list_devices")
          .then(applyDevices)
          .catch(() => {});
        invoke<SyncStatusInfo>("sync_get_status")
          .then((s) => {
            setSyncStatus(s);
            if (s.last_synced_at) setLastSynced(s.last_synced_at);
          })
          .catch(() => {});
      }
    });
  }, [refreshQuota, refreshCloudCount, applyDevices]);

  // Devices, presence and quota all move while the app sits in the background,
  // and none of them arrive over the socket. Deliberately not the server
  // breakdown: it pages the account 500 rows at a time and has its own cache
  // plus a refresh control.
  useWindowRefocus(() => {
    if (!syncUser) return;
    invoke<SyncDevice[]>("sync_list_devices").then(applyDevices).catch(() => {});
    invoke<SyncStatusInfo>("sync_get_status")
      .then((s) => {
        setSyncStatus(s);
        if (s.last_synced_at) setLastSynced(s.last_synced_at);
      })
      .catch(() => {});
    refreshQuota();
  }, NETWORK_REFOCUS_MS);

  // ── Silent session restore (fired by App on startup) ────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<SyncUser>("sync:session-restored", (event) => {
      setSyncUser(event.payload);
      refreshQuota();
      refreshCloudCount();
      invoke<SyncDevice[]>("sync_list_devices")
        .then(applyDevices)
        .catch(() => {});
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [refreshQuota, refreshCloudCount, applyDevices]);

  // ── Device presence: mark devices online/offline as events arrive ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ device_id?: string; online?: boolean }>(
      "sync:device-presence",
      (event) => {
        const { device_id, online } = event.payload;
        if (!device_id) return;
        setPresenceOverrides((prev) => ({
          ...prev,
          [device_id]: online === true,
        }));
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // ── Cloud Sync handlers ─────────────────────────────────────────
  // Only reachable while signed out — the way back from the enable hero.
  // Signed in, "Manual" is how you stop sync; nothing here signs anyone out.
  const disableSync = async () => {
    setSyncEnabled(false);
    try {
      await invoke("sync_set_enabled", { enabled: false });
      setSyncUser(null);
      setSyncStatus(null);
      setDevices([]);
      setPresenceOverrides({});
      setQuota(null);
      forgetCloudCount();
      setCloudCount(null);
      setDeviceError(null);
    } catch (e) {
      setSyncEnabled(true);
      console.error("sync_set_enabled failed", e);
    }
  };

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
    refreshCloudCount(true);
    invoke<SyncDevice[]>("sync_list_devices")
      .then(applyDevices)
      .catch(() => {});
    invoke<SyncStatusInfo>("sync_get_status")
      .then((s) => {
        setSyncStatus(s);
        if (s.last_synced_at) setLastSynced(s.last_synced_at);
      })
      .catch(() => {});
  };

  useEffect(() => {
    invoke<SyncConnection>("sync_get_connection")
      .then(setConn)
      .catch(() => {});
  }, []);

  /// Mint a code and show it. Used both for the forced first save and for a
  /// deliberate regenerate, which are the same operation server-side.
  const mintRecoveryCode = useCallback(async () => {
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoveryAck(false);
    setRecoverySavedTo(null);
    setRecoveryCopied(false);
    try {
      const code = await invoke<string>("sync_create_recovery_code");
      setRecoveryCode(code);
    } catch (e) {
      setRecoveryError(
        typeof e === "string" ? e : "Could not create a recovery code.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  }, []);

  // Ask once per session whether this account has a recovery code, and mint one
  // if it has not. Every account predating this has none, and they are exactly
  // the accounts a forgotten password would strand.
  useEffect(() => {
    if (!syncUser || recoveryNeeded !== null) return;
    let cancelled = false;
    invoke<boolean | null>("sync_has_recovery_code")
      .then((has) => {
        if (cancelled || has === null) return;
        setRecoveryNeeded(!has);
        if (!has) void mintRecoveryCode();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [syncUser, recoveryNeeded, mintRecoveryCode]);

  const clearOauthTimer = () => {
    if (oauthTimer.current !== null) {
      window.clearTimeout(oauthTimer.current);
      oauthTimer.current = null;
    }
  };

  // Move to the password step. Called from the command's reply and from the
  // sync:oauth-ready event, whichever lands first.
  const openOauthPasswordStep = useCallback(
    (res: { email: string; is_new: boolean }) => {
      clearOauthTimer();
      setOauthEmail(res.email);
      setOauthIsNew(res.is_new);
      setOauthStage("password");
      setOauthLoading(false);
      setLoginError(null);
    },
    [],
  );

  // The handshake can finish while this screen is unmounted or the window is
  // hidden, in which case neither the reply nor the event reaches us. Ask on
  // mount so the password step is not lost.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ email: string; is_new: boolean }>("sync:oauth-ready", (event) => {
      openOauthPasswordStep(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    invoke<{ email: string; is_new: boolean } | null>("sync_oauth_pending")
      .then((res) => {
        if (res) openOauthPasswordStep(res);
      })
      .catch(() => {});
    return () => {
      unlisten?.();
      clearOauthTimer();
    };
  }, [openOauthPasswordStep]);

  const resetOauth = () => {
    clearOauthTimer();
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
    // Stop waiting after two minutes so the button comes back. The handshake
    // keeps running in the background, and sync:oauth-ready still moves the
    // screen on if the user finishes in the browser after this fires.
    clearOauthTimer();
    oauthTimer.current = window.setTimeout(() => {
      oauthTimer.current = null;
      setOauthLoading(false);
      setLoginError(
        "Still waiting on Google. Finish sign-in in your browser, or try again.",
      );
    }, OAUTH_WAIT_MS);
    try {
      const res = await invoke<{ email: string; is_new: boolean }>(
        "sync_oauth_begin",
        {
          provider: "google",
          deviceName: `Orange CP - ${navigator.platform || "Desktop"}`,
        },
      );
      openOauthPasswordStep(res);
    } catch (e) {
      clearOauthTimer();
      setOauthLoading(false);
      setLoginError(typeof e === "string" ? e : "Google sign-in failed.");
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
      setResetError(
        typeof e === "string" ? e : "Could not send the reset email.",
      );
    } finally {
      setResetLoading(false);
    }
  };

  const saveRecoveryToFile = async () => {
    if (!recoveryCode) return;
    try {
      const path = await invoke<string>("export_note_text", {
        text: `Orange Copy Paste recovery code

${recoveryCode}

Keep this. It is the only way back into your synced items if you forget your password.
`,
        filename: "orange-copy-paste-recovery-code.txt",
      });
      setRecoverySavedTo(path);
    } catch (e) {
      setRecoveryError(typeof e === "string" ? e : "Could not save the file.");
    }
  };

  const closeResetStage = () => {
    setNewPassword("");
    setNewConfirm("");
    setResetStageError(null);
    setOfferStartOver(false);
    setRecoveryEntry("");
    setChangeOpen(false);
    // Rust holds the session the emailed link was exchanged for, because
    // finishing a reset can take more than one attempt. Closing the panel is
    // the end of the flow, so it does not keep a live credential around.
    invoke("sync_cancel_password_reset").catch(() => {});
    onResetCodeConsumed?.();
  };

  /// Finish the reset, or change the password of the signed-in account - the
  /// same two fields either way, so the same handler.
  const submitNewPassword = async (startOver: boolean) => {
    if (newPassword.length < 8) {
      setResetStageError("Use at least 8 characters.");
      return;
    }
    if (newPassword !== newConfirm) {
      setResetStageError("The two passwords do not match.");
      return;
    }
    setResetBusy(true);
    setResetStageError(null);
    try {
      if (changeOpen) {
        await invoke("sync_change_password", { newPassword });
        setChangeDone(true);
        setNewPassword("");
        setNewConfirm("");
        setChangeOpen(false);
        return;
      }
      const user = await invoke<SyncUser>("sync_complete_password_reset", {
        code: resetCode,
        newPassword,
        recoveryCode: recoveryEntry.trim() || null,
        deviceName: `Orange CP - ${navigator.platform || "Desktop"}`,
        startOver,
      });
      // A reset can be finished with sync switched off - the link opens the app
      // whatever its settings say. Leaving it off would show the "enable sync"
      // hero over a session that just came back, which reads as the reset having
      // done nothing.
      if (!syncEnabled) {
        setSyncEnabled(true);
        invoke("sync_set_enabled", { enabled: true }).catch(() => {});
      }
      closeResetStage();
      loadPostLogin(user);
    } catch (e) {
      const msg =
        typeof e === "string" ? e : "Could not set the new password.";
      setResetStageError(msg);
      // Rust says so in the one case where a fresh key is the only way through.
      if (/never held your encryption key/i.test(msg)) setOfferStartOver(true);
    } finally {
      setResetBusy(false);
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
      forgetCloudCount();
      setCloudCount(null);
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
      refreshCloudCount(true);
    } catch (e) {
      console.error("sync_now failed", e);
    } finally {
      setSyncNowLoading(false);
    }
  };

  // `handleSyncNow` is rebuilt every render, and the cloud rows need a stable
  // callback or the composition memo they live in recomputes on each one. A ref
  // keeps the latest without making it a dependency.
  const handleSyncNowRef = useRef(handleSyncNow);
  useEffect(() => {
    handleSyncNowRef.current = handleSyncNow;
  });

  const errMsg = (e: unknown, fallback: string) =>
    typeof e === "string" ? e : fallback;

  // A removed device has to sign in and register again before it syncs, so the
  // call waits out the Undo toast instead of going the moment Remove is hit.
  const handleRevokeDevice = (deviceId: string) => {
    setDeviceError(null);
    deferDestructive(
      "Device removed",
      async () => {
        try {
          // The Rust command refuses to revoke the current device with a clear
          // message, so Remove is shown on every row and the error surfaces here.
          await invoke("sync_revoke_device", { deviceId });
        } catch (e) {
          setDeviceError(errMsg(e, "Could not remove the device."));
          throw e;
        } finally {
          applyDevices(await invoke<SyncDevice[]>("sync_list_devices"));
        }
      },
      {
        key: "device-revoke",
        hides: [`device:${deviceId}`],
        errorPrefix: "Could not remove the device",
      },
    );
  };

  // ── Helpers ─────────────────────────────────────────────────────
  const formatLastSynced = (ts: number | null) => {
    if (!ts) return null;
    const diff = sharedNow() - ts;
    // Lowercase because every caller embeds it mid-sentence ("last seen ...").
    if (diff < 60_000) return "just now";
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const status = !syncStatus
    ? { kind: "checking", label: "Checking..." }
    : // Connected and holding is still holding. Manual mode would otherwise
      // read "Synced" over a queue it is deliberately not sending.
      syncMode === "manual" && syncStatus.pending_count > 0
      ? {
          kind: "pending",
          label: `${syncStatus.pending_count} waiting`,
        }
      : syncStatus.connected
      ? { kind: "connected", label: "Synced" }
      : syncStatus.pending_count > 0
        ? { kind: "pending", label: `${syncStatus.pending_count} pending` }
        : { kind: "offline", label: "Offline" };

  // What this device has pushed, and what it still owes. Straight off the hook
  // the card badges use, so the tiles move on the same events the badges do.
  // Device-scoped by nature: `id_map.json` records what this install pushed or
  // pulled and nothing else, which is why the panel labels it that way.
  // What this device actually holds, broken down the same way the clipboard
  // screen's own type filter breaks it down - same `deriveDisplayKind`, so a
  // row's count and the list it opens can never disagree.
  const composition = useMemo(() => {
    const counts = {} as Record<DisplayKind, number>;
    for (const entry of entries) {
      const kind = deriveDisplayKind(entry);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    const rows = COMPOSITION_ORDER.filter((k) => (counts[k] ?? 0) > 0).map(
      (kind) => ({
        key: kind as string,
        tint: kind as string,
        label: TYPE_LABELS[kind],
        count: counts[kind],
        open: () => {
          showOnlyKinds([kind]);
          onNavigate("clipboard");
        },
      }),
    );
    // Notes are not a clipboard kind, but they are half of what the app holds,
    // so leaving them out would make the bar describe a smaller app than the
    // one on screen.
    if (notes.length > 0) {
      rows.push({
        key: "notes",
        tint: "notes",
        label: "Notes",
        count: notes.length,
        open: () => onNavigate("notes"),
      });
    }
    const total = rows.reduce((n, r) => n + r.count, 0);
    return { rows, total };
  }, [entries, notes, onNavigate]);

  // The server count is cached for the session because counting pages the
  // account 500 rows at a time. That cache went stale the moment anything
  // synced in the background, and the row then contradicted its own subtitle -
  // "0" beside "18 of them synced from this device". This device knows when its
  // own tally moved, which is exactly when the cached number cannot be trusted,
  // so recount then and only then.
  const syncedHere = Object.keys(entryStates).length;
  const countedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!syncUser) return;
    if (countedAt.current === null) {
      countedAt.current = syncedHere;
      return;
    }
    if (countedAt.current === syncedHere) return;
    countedAt.current = syncedHere;
    refreshCloudCount(true);
  }, [syncedHere, syncUser, refreshCloudCount]);

  // The server labels a row "text" / "image" / "html" / "file"; the local
  // screen filters on display kinds, which are finer - a URL is a text entry,
  // a folder is a file entry, and the server never sees enough to tell. So a
  // cloud row opens the display kinds its server kind can turn into. The two
  // counts can differ by a few as a result: an image dragged in as a file is
  // "file" on the server and "image" here.
  const CLOUD_KIND_FILTER: Record<string, DisplayKind[]> = {
    text: ["text", "url"],
    image: ["image"],
    html: ["html"],
    file: ["file", "folder", "document", "video"],
  };

  // Opening a cloud row syncs first. The screen it lands on filters the local
  // list, and the local list is only the account's once a pull has run - going
  // straight there would show the cloud's count beside the device's contents.
  const [cloudOpening, setCloudOpening] = useState<string | null>(null);
  const openCloudRow = useCallback(
    async (key: string) => {
      setCloudOpening(key);
      try {
        await handleSyncNowRef.current();
      } finally {
        setCloudOpening(null);
      }
      // Navigate even when the sync failed: a filtered screen showing what did
      // arrive beats being held on this one with nothing to look at.
      if (key === "notes") {
        onNavigate("notes");
        return;
      }
      showOnlyKinds(CLOUD_KIND_FILTER[key] ?? [], { cloud: "in" });
      onNavigate("clipboard");
    },
    // CLOUD_KIND_FILTER is a literal rebuilt each render; it is read inside the
    // callback rather than closed over as state, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onNavigate],
  );

  // The same bar as "On this device", for what the account holds on the
  // server. Kinds come from the server's plaintext `kind` label, so this is
  // coarser than the local one on purpose - URL, document and folder are read
  // out of content the server never sees.
  const cloudComposition = useMemo(() => {
    if (!cloudCount || cloudCount.total === 0) return null;
    const rows: {
      key: string;
      tint: string;
      label: string;
      count: number;
      open: () => void;
    }[] = [
      {
        key: "text",
        tint: "text",
        label: TYPE_LABELS.text,
        count: cloudCount.text,
        open: () => openCloudRow("text"),
      },
      {
        key: "image",
        tint: "image",
        label: TYPE_LABELS.image,
        count: cloudCount.image,
        open: () => openCloudRow("image"),
      },
      {
        key: "html",
        tint: "html",
        label: TYPE_LABELS.html,
        count: cloudCount.html,
        open: () => openCloudRow("html"),
      },
      {
        key: "file",
        tint: "file",
        label: TYPE_LABELS.file,
        count: cloudCount.file,
        open: () => openCloudRow("file"),
      },
      {
        key: "notes",
        tint: "notes",
        label: "Notes",
        count: cloudCount.notes,
        open: () => openCloudRow("notes"),
      },
    ].filter((r) => r.count > 0);
    return { rows, total: cloudCount.total };
  }, [cloudCount, openCloudRow]);

  // Only the queue is shown now that the per-row subtitles are gone; the split
  // by kind went with them.
  const [statsView, setStatsView] = useState<"device" | "cloud">("device");
  const shownComp =
    statsView === "cloud"
      ? cloudComposition
      : composition.total > 0
        ? composition
        : null;

  // Split by kind and by whether it is still queued: the meta line on each
  // cloud row says how much of that figure came from this device, and this
  // device is the only place that can answer it (`entry_states` is its own
  // record, never the account's).
  const deviceTally = Object.entries(entryStates).reduce(
    (acc, [key, state]) => {
      const isNote = key.startsWith("note:");
      if (state === "pending") {
        acc.waiting += 1;
        if (isNote) acc.waitingNotes += 1;
        else acc.waitingClipboard += 1;
      } else {
        if (isNote) acc.notes += 1;
        else acc.clipboard += 1;
      }
      return acc;
    },
    { clipboard: 0, notes: 0, waiting: 0, waitingClipboard: 0, waitingNotes: 0 },
  );

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
  // One row per item turns a single cause - an account out of storage, say -
  // into hundreds of identical lines. Group by reason and name the items
  // inside each group instead.
  const skippedGroups = React.useMemo(() => {
    const byReason = new Map<string, typeof skipped>();
    for (const item of skipped) {
      const bucket = byReason.get(item.reason);
      if (bucket) bucket.push(item);
      else byReason.set(item.reason, [item]);
    }
    return [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [skipped]);

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
        // A finished run changes the skipped list, the pending count, and how
        // much storage the account is using - the bar read stale until the
        // next sign-in or refresh, which looked like the removal had not
        // freed anything.
        if (next.progress === null) {
          invoke<SyncStatusInfo>("sync_get_status")
            .then(setSyncStatus)
            .catch(() => {});
          refreshQuota();
          refreshCloudCount(true);
        }
      }),
    [refreshQuota, refreshCloudCount],
  );
  const progress = bulk.progress;
  const pushResult = bulk.result;

  const pct = progress
    ? Math.min(
        100,
        Math.round((progress.done / Math.max(1, progress.total)) * 100),
      )
    : 0;

  // Measured before anything is sent, so an upload that cannot fit says so up
  // front instead of failing one image at a time.
  const [plan, setPlan] = useState<UnsyncedPreview | null>(null);

  const startUpload = async () => {
    setPlan(null);
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

  const handlePushUnsynced = async () => {
    setPushingOld(true);
    setBulkResult(null);
    let preview: UnsyncedPreview;
    try {
      preview = await invoke<UnsyncedPreview>("sync_preview_unsynced");
    } catch {
      // The check is a courtesy; if it fails, the upload itself still works.
      setPushingOld(false);
      void startUpload();
      return;
    }
    setPushingOld(false);
    if (preview.total === 0) {
      setBulkResult("Everything on this device is already synced.");
      return;
    }
    // Only worth interrupting for when some of it genuinely will not fit.
    if (preview.images_that_fit < preview.images) {
      setPlan(preview);
      return;
    }
    void startUpload();
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
  // A reset from the emailed link, or a deliberate password change, takes over
  // the screen: both are one thing the user came here to finish.
  const resetStage = Boolean(resetCode) || changeOpen;
  // The recovery-code panel blocks this screen only. Clipboard, notes and capture
  // keep working - a modal that stops the product from working is a worse failure
  // than an unsaved code.
  const recoveryStage = Boolean(syncUser) && !resetStage && recoveryNeeded === true;
  const centered = !syncEnabled || !syncUser || resetStage || recoveryStage;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div
      className={`settings-screen account-screen${centered ? " account-screen--center" : ""}`}
    >
      <div className="acct-inner">
        {!centered && (
          <header className="scr-head">
            <span className="scr-eyebrow">Cloud</span>
            <h2 className="scr-title">Account &amp; Sync</h2>
            <p className="scr-subtitle">
              Sign in, keep your devices in sync, and see what this account is
              storing. End-to-end encrypted.
            </p>
          </header>
        )}

        {recoveryStage ? (
          /* ── Save your recovery code ── */
          <div className="auth-card">
            <div className="auth-brand">
              <div className="auth-brand-badge">
                <Key size={20} />
              </div>
              <h3 className="auth-title">Save your recovery code</h3>
              <p className="auth-subtitle">
                If you forget your password, this code is the only thing that can
                unlock your synced items on a new device. We cannot recover them
                for you.
              </p>
            </div>
            <div className="auth-form">
              {recoveryCode ? (
                <>
                  <p className="acct-recovery-code">{recoveryCode}</p>
                  <div className="acct-recovery-actions">
                    <button
                      type="button"
                      className="acct-btn"
                      onClick={() => {
                        navigator.clipboard
                          .writeText(recoveryCode)
                          .catch(() => {});
                        setRecoveryCopied(true);
                      }}
                    >
                      {recoveryCopied ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      className="acct-btn"
                      onClick={() => void saveRecoveryToFile()}
                    >
                      Save as file
                    </button>
                  </div>
                  {recoverySavedTo && (
                    <span className="acct-id-note">
                      Saved to {recoverySavedTo}
                    </span>
                  )}
                  <label className="acct-recovery-ack">
                    <input
                      type="checkbox"
                      checked={recoveryAck}
                      onChange={(e) => setRecoveryAck(e.target.checked)}
                    />
                    <span>I saved my recovery code</span>
                  </label>
                </>
              ) : (
                <p className="auth-hint">
                  {recoveryBusy ? "Creating your code..." : "No code yet."}
                </p>
              )}
              {recoveryError && (
                <span className="auth-error">{recoveryError}</span>
              )}
              <button
                type="button"
                className="auth-submit"
                onClick={() => {
                  setRecoveryNeeded(false);
                  setRecoveryCode(null);
                }}
                disabled={!recoveryCode || !recoveryAck}
              >
                Continue
              </button>
              {!recoveryCode && !recoveryBusy && (
                <button
                  type="button"
                  className="auth-textlink auth-textlink--center"
                  onClick={() => void mintRecoveryCode()}
                >
                  Try again
                </button>
              )}
            </div>
          </div>
        ) : resetStage ? (
          /* ── Set a new password: from the reset link, or by choice ── */
          <div className="auth-card">
            <div className="auth-brand">
              <div className="auth-brand-badge">
                <CloudCheck size={20} />
              </div>
              <h3 className="auth-title">
                {changeOpen ? "Change your password" : "Set a new password"}
              </h3>
              <p className="auth-subtitle">
                {changeOpen
                  ? "Your synced items stay readable - the key does not change, only what wraps it."
                  : "This also unlocks what you have already synced, so nothing is lost."}
              </p>
            </div>
            <div className="auth-form">
              <label className="auth-field">
                <span className="auth-label">New password</span>
                <input
                  className="auth-input"
                  type="password"
                  placeholder="At least 8 characters"
                  value={newPassword}
                  autoFocus
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={resetBusy}
                />
              </label>
              <label className="auth-field">
                <span className="auth-label">Confirm password</span>
                <input
                  className="auth-input"
                  type="password"
                  placeholder="Repeat the password"
                  value={newConfirm}
                  onChange={(e) => setNewConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitNewPassword(false);
                  }}
                  disabled={resetBusy}
                />
              </label>
              {resetStageError && (
                <span className="auth-error">{resetStageError}</span>
              )}
              <button
                type="button"
                className="auth-submit"
                onClick={() => void submitNewPassword(false)}
                disabled={resetBusy || !newPassword || !newConfirm}
              >
                {resetBusy ? "Saving..." : "Save password"}
              </button>
              {offerStartOver && (
                <label className="auth-field">
                  <span className="auth-label">Recovery code</span>
                  <input
                    className="auth-input"
                    type="text"
                    placeholder="ABCDE-FGHJK-..."
                    value={recoveryEntry}
                    onChange={(e) => setRecoveryEntry(e.target.value)}
                    disabled={resetBusy}
                  />
                </label>
              )}
              {offerStartOver && recoveryEntry.trim() && (
                <button
                  type="button"
                  className="auth-submit"
                  onClick={() => void submitNewPassword(false)}
                  disabled={resetBusy}
                >
                  {resetBusy ? "Unlocking..." : "Unlock with the code"}
                </button>
              )}
              {offerStartOver && (
                <div className="auth-startover">
                  <p className="auth-note">
                    Starting over gives this account a new encryption key. You
                    get back in, but anything synced under the old key can no
                    longer be read on any device.
                  </p>
                  <button
                    type="button"
                    className="acct-btn acct-btn--quiet acct-btn--danger"
                    onClick={() => void submitNewPassword(true)}
                    disabled={resetBusy}
                  >
                    Start over with a new key
                  </button>
                </div>
              )}
              <button
                type="button"
                className="auth-textlink auth-textlink--center"
                onClick={closeResetStage}
                disabled={resetBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : !syncEnabled ? (
          /* ── Sync disabled: enable hero ── */
          <div className="acct-card acct-hero">
            <div className="acct-hero-badge">
              <CloudCheck size={26} />
            </div>
            <h3 className="acct-hero-title">Sync across your devices</h3>
            <p className="acct-hero-desc">
              Keep your clipboard history and notes in sync on every device.
              End-to-end encrypted, so only you can read them.
            </p>
            <button
              type="button"
              className="auth-submit acct-hero-btn"
              onClick={handleSyncToggle}
            >
              Enable Cloud Sync
            </button>
          </div>
        ) : !syncUser && restoringSession && !signInAnyway ? (
          /* ── Credentials are fine, the server is not reachable yet ──
             Drawing a password field here is what made users sign in again
             for a session that was about to come back on its own. */
          <div className="auth-card auth-card--waiting">
            <div className="auth-brand">
              <div className="auth-brand-badge">
                <CloudArrowUp size={20} />
              </div>
              <h3 className="auth-title">Reconnecting to your account</h3>
              <p className="auth-subtitle">
                You are still signed in. This device is waiting for the server
                and will pick up where it left off.
              </p>
            </div>
            <button
              type="button"
              className="auth-textlink auth-textlink--center"
              onClick={() => setSignInAnyway(true)}
            >
              Sign in with a password instead
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
                    <span className="auth-label">
                      {oauthIsNew ? "New password" : "Password"}
                    </span>
                    <input
                      className="auth-input"
                      type="password"
                      placeholder={
                        oauthIsNew ? "At least 8 characters" : "Your password"
                      }
                      value={oauthPassword}
                      autoFocus
                      onChange={(e) => setOauthPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !oauthIsNew)
                          handleOauthComplete();
                      }}
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
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleOauthComplete();
                        }}
                        disabled={oauthLoading}
                      />
                    </label>
                  )}
                  {loginError && (
                    <span className="auth-error">{loginError}</span>
                  )}
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
                      <span className="auth-reset-check">
                        <Check size={16} weight="bold" />
                      </span>
                      <p>
                        If an account exists for <strong>{resetEmail}</strong>,
                        a password-reset link is on its way. Check your inbox.
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
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleResetPassword();
                          }}
                          disabled={resetLoading}
                        />
                      </label>
                      {resetError && (
                        <span className="auth-error">{resetError}</span>
                      )}
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
                    Open the link on a device you have signed in on before and
                    your synced items stay readable - the new password re-wraps
                    the same encryption key. On a device that has never signed
                    in, the key is not there to re-wrap, and the only way in is
                    a new one.
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
                      style={{
                        transform: `translateX(${authMode === "signup" ? "100%" : "0"})`,
                      }}
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
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleLogin();
                        }}
                        disabled={loginLoading || oauthLoading}
                      />
                    </label>
                    <label className="auth-field">
                      <div className="auth-label-row">
                        <span className="auth-label">Password</span>
                        {authMode === "login" && (
                          <button
                            type="button"
                            className="auth-textlink"
                            onClick={openForgot}
                          >
                            Forgot?
                          </button>
                        )}
                      </div>
                      <input
                        className="auth-input"
                        type="password"
                        placeholder={
                          authMode === "signup"
                            ? "At least 8 characters"
                            : "Your password"
                        }
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleLogin();
                        }}
                        disabled={loginLoading || oauthLoading}
                      />
                    </label>

                    {loginError && (
                      <span className="auth-error">{loginError}</span>
                    )}
                    {authNotice && (
                      <span className="auth-notice">{authNotice}</span>
                    )}

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

                    <div className="auth-divider">
                      <span>or</span>
                    </div>

                    <button
                      type="button"
                      className="auth-google"
                      onClick={handleGoogleSignIn}
                      disabled={
                        loginLoading ||
                        oauthLoading ||
                        conn?.configured === false
                      }
                    >
                      <GoogleIcon size={16} />
                      {oauthLoading
                        ? "Waiting for browser..."
                        : "Continue with Google"}
                    </button>
                  </div>
                </>
              )}

              {/* Only ever visible in a build compiled without endpoints — a
                  developer-facing dead end, not something users should hit. */}
              {conn?.configured === false && (
                <span className="auth-error">
                  This build has no sync endpoints compiled in. Set the{" "}
                  <code>DEFAULT_*</code> constants in{" "}
                  <code>sync/config.rs</code> and rebuild.
                </span>
              )}

              <div className="auth-secure">
                <Key size={12} weight="fill" />
                End-to-end encrypted. Only you can read your data
              </div>
            </div>

            {/* Enabling sync is one click from the hero, so backing out of it
                has to be one click too - otherwise the only way out of this
                screen is creating an account. */}
            <button
              type="button"
              className="acct-off-link"
              onClick={() => void disableSync()}
            >
              Turn off cloud sync
            </button>
          </>
        ) : (
          /* ── Signed in ── */
          <>
            {/* Identity band */}
            <div className="acct-card acct-idband">
              {/* Two rows on purpose. The four actions used to sit in one row
                  beside the address, which is more than the card is wide: they
                  wrapped into a detached block under the avatar. Now the top row
                  carries identity and the two buttons people press, and the
                  facts that change on their own move to a quieter second row
                  next to the actions you use once. */}
              <div className="acct-id-main">
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
                  <span
                    className={`acct-id-status acct-id-status--${status.kind}`}
                  >
                    <span className="acct-id-dot" />
                    {status.label}
                  </span>
                  {queueNote && <span className="acct-id-note">{queueNote}</span>}
                  {changeDone && (
                    <span className="acct-id-note">
                      Password changed. Use it on your other devices from now on.
                    </span>
                  )}
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
                    {syncNowLoading ? "Refreshing..." : "Refresh"}
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

              <div className="acct-id-meta">
                {/* Presence and last-sync are only trustworthy while this device
                    is connected, so they are absent rather than stale. */}
                {status.kind === "connected" && lastSynced && (
                  <span className="acct-id-fact">
                    Last sync {formatLastSynced(lastSynced)}
                  </span>
                )}
                {status.kind === "connected" && devices.length > 0 && (
                  <span className="acct-id-fact">
                    {onlineDevices} device{onlineDevices === 1 ? "" : "s"} online
                  </span>
                )}
                <div className="acct-id-meta-actions">
                  <button
                    type="button"
                    className="acct-link"
                    onClick={() => {
                      setChangeDone(false);
                      setChangeOpen(true);
                    }}
                  >
                    Change password
                  </button>
                </div>
              </div>

              {/* The recovery code gets its own line rather than a third link.
                  Replacing one invalidates the copy the user already saved, which
                  is not the same kind of action as opening a dialog, and the line
                  is the only place that says what the code is for. */}
              <div className="acct-id-recovery">
                <Key size={15} className="acct-id-recovery-icon" />
                <span className="acct-id-recovery-text">
                  {recoveryNeeded === false
                    ? "Recovery code saved. It is the only way back in without your password."
                    : "A recovery code is the only way back in without your password."}
                </span>
                <button
                  type="button"
                  className="acct-btn acct-btn--sm acct-btn--quiet"
                  onClick={() => {
                    setRecoveryNeeded(true);
                    void mintRecoveryCode();
                  }}
                >
                  {recoveryNeeded === false ? "Replace" : "New code"}
                </button>
              </div>
            </div>

            {/* What sync refused to send, and why */}
            {showSkipped && skippedCount > 0 && (
              <div className="acct-skipped">
                {skipped.length === 0 ? (
                  <span className="acct-skipped-empty">
                    {skippedCount} item{skippedCount === 1 ? "" : "s"} were
                    skipped before this app was restarted. The details are gone.
                  </span>
                ) : (
                  skippedGroups.map(([reason, items]) => (
                    <div key={reason} className="acct-skipped-row">
                      <WarningCircle size={13} className="acct-skipped-icon" />
                      <span className="acct-skipped-text">
                        <span className="acct-skipped-label">
                          {items.length === 1
                            ? items[0].label
                            : `${items.length} items`}
                        </span>
                        <span className="acct-skipped-reason">{reason}</span>
                        {items.length > 1 && (
                          <span className="acct-skipped-names">
                            {items
                              .slice(0, 6)
                              .map((i) => i.label)
                              .join(", ")}
                            {items.length > 6
                              ? ` and ${items.length - 6} more`
                              : ""}
                          </span>
                        )}
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
                <span className="acct-zone-icon">
                  <Cloud size={13} />
                </span>
                <span className="acct-zone-label">Cloud sync</span>
              </div>

              <div className="acct-card acct-mode">
                <div className="acct-mode-head">
                  <span className="acct-row-name">Automatic syncing</span>
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
                    ? "Items from your other devices arrive the moment they are copied, and what you copy here uploads right away."
                    : syncMode === "passive"
                      ? "Items from your other devices arrive every 5 minutes, or when you press Refresh. What you copy here still uploads right away."
                      : "Nothing new uploads on its own. Pick what to send with Upload to cloud, on an item or on a selection. Items already in the cloud stay up to date, removing one still removes it, and Refresh brings down what your other devices sent."}
                </p>
                <p className="acct-mode-note">
                  Spaces are not affected. What you share to a space still goes
                  out right away, and what other people share with you always
                  arrives live.
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
                {plan ? (
                  <div className="acct-plan">
                    <p className="acct-card-desc">
                      {plan.images - plan.images_that_fit} of {plan.images}{" "}
                      image
                      {plan.images === 1 ? "" : "s"} will not fit.{" "}
                      {formatBytes(plan.image_bytes)} of images, but only{" "}
                      {formatBytes(plan.free_bytes)} is free.
                    </p>
                    <p className="acct-mode-note">
                      Text and notes still upload. Uploading anyway sends what
                      fits and skips the rest.
                    </p>
                    <div className="acct-skipped-actions">
                      <button
                        type="button"
                        className="acct-btn acct-btn--sm"
                        onClick={startUpload}
                      >
                        Upload anyway
                      </button>
                      <button
                        type="button"
                        className="acct-btn acct-btn--sm acct-btn--quiet"
                        onClick={() => setPlan(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : progress ? (
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
                {!pushResult && !progress && !plan && (
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
                <span className="acct-zone-icon">
                  <Desktop size={13} />
                </span>
                <span className="acct-zone-label">Devices</span>
              </div>

              {deviceError && <span className="auth-error">{deviceError}</span>}

              <div className="acct-card acct-card--rows">
                <div className="acct-list">
                  {shownDevices.length > 0 ? (
                    shownDevices.map((d) => {
                      const online = isDeviceOnline(d);
                      const DeviceGlyph = deviceIcon(d.platform);
                      const seen = formatLastSynced(d.last_seen_at);
                      return (
                        <div key={d.id} className="acct-row">
                          <span className="acct-row-icon">
                            <DeviceGlyph size={15} />
                          </span>
                          <div className="acct-row-main">
                            <span className="acct-row-name">
                              {d.device_name || "Unknown device"}
                              {d.is_current && (
                                <span className="acct-badge acct-badge--owner">
                                  this device
                                </span>
                              )}
                              {d.same_machine && (
                                <span className="acct-badge">
                                  this computer, older sign-in
                                </span>
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
                          <span
                            className={`acct-dot${online ? " online" : ""}`}
                          />
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
                </div>
              </div>
            </section>

            {/* Storage and activity */}
            <section className="acct-zone">
              <div className="acct-zone-head">
                <span className="acct-zone-icon">
                  <ChartBar size={13} />
                </span>
                <span className="acct-zone-label">Storage and activity</span>
              </div>

              {/* One card for everything storage-related: what you hold, what
                  it costs, and the account totals. They were three cards saying
                  three parts of one answer, and the gaps between them read as
                  bigger breaks than the subjects deserved. */}
              <div className="acct-card acct-card--rows">
                <div className="acct-list">
                {/* One bar, two sources. Drawing both at once said the same
                    thing twice for an account where everything is synced, and the
                    interesting question is the difference between them - which is
                    easier to see by switching one bar than by reading two. */}
                <div className="acct-comp">
                  <div className="acct-comp-head">
                    <div className="acct-seg" role="tablist">
                      {(["device", "cloud"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          role="tab"
                          aria-selected={statsView === v}
                          className={`acct-seg-pill${statsView === v ? " active" : ""}`}
                          onClick={() => setStatsView(v)}
                        >
                          {v === "device" ? "This device" : "Cloud"}
                        </button>
                      ))}
                    </div>
                    {shownComp && (
                      <span className="acct-comp-total">
                        {shownComp.total} item{shownComp.total === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>

                  {!shownComp ? (
                    <p className="acct-comp-note">
                      {statsView === "cloud"
                        ? cloudCounting
                          ? "Counting what is on the server."
                          : cloudCount === null
                            ? "Not counted yet."
                            : "Nothing of yours is in the cloud yet."
                        : "Nothing on this device yet."}
                    </p>
                  ) : (
                    <>
                      {/* Widths are the shares themselves, so the bar and the
                          percentages below it cannot drift apart. */}
                      <div className="acct-comp-bar">
                        {shownComp.rows.map((r) => (
                          <span
                            key={r.key}
                            className={`acct-comp-seg type-tint--${r.tint}`}
                            style={{
                              width: `${(r.count / shownComp.total) * 100}%`,
                            }}
                            title={`${r.label}: ${r.count}`}
                          />
                        ))}
                      </div>

                      <div className="acct-comp-legend">
                        {/* Every row leads somewhere now: a device row opens
                            the local list filtered to that kind, a cloud row
                            syncs and then opens the same list narrowed to what
                            has a copy on the server. */}
                        {shownComp.rows.map((r) => (
                          <button
                            key={r.key}
                            type="button"
                            className="acct-comp-row"
                            onClick={r.open}
                            disabled={cloudOpening !== null}
                          >
                            <span
                              className={`acct-comp-dot type-tint--${r.tint}`}
                            />
                            <span className="acct-comp-label">{r.label}</span>
                            <span className="acct-comp-count">{r.count}</span>
                            <span className="acct-comp-pct">
                              {Math.round((r.count / shownComp.total) * 100)}%
                            </span>
                            <CaretRight
                              size={11}
                              weight="bold"
                              className="acct-comp-go"
                            />
                          </button>
                        ))}
                      </div>

                      <p className="acct-comp-note">
                        {cloudOpening
                          ? "Syncing first, then opening the filtered list."
                          : statsView === "device"
                            ? "Pick a row to open it with that filter already on."
                            : "Only what you uploaded. Picking a row syncs first, then opens it."}
                      </p>
                    </>
                  )}
                </div>

                  {/* Storage is a cloud number, so it only stands with the
                      cloud view. On the device view it was answering a question
                      the panel was not asking. */}
                  {statsView === "cloud" &&
                    quota &&
                    (() => {
                      const pct =
                        quota.quota_bytes > 0
                          ? Math.min(
                              100,
                              (quota.used_bytes / quota.quota_bytes) * 100,
                            )
                          : 0;
                      const free = Math.max(
                        0,
                        quota.quota_bytes - quota.used_bytes,
                      );
                      return (
                        <div className="acct-quota">
                          <div className="acct-quota-head">
                            <HardDrives size={13} />
                            <span>Cloud image storage</span>
                            {/* The share is the part that says whether this
                                matters; the bytes say by how much. */}
                            <span className="acct-quota-value">
                              {pct < 1 && quota.used_bytes > 0
                                ? "under 1%"
                                : `${Math.round(pct)}%`}{" "}
                              of {formatBytes(quota.quota_bytes)}
                            </span>
                          </div>
                          <div className="acct-quota-track">
                            <div
                              className={`acct-quota-fill${pct >= 85 ? " acct-quota-fill--warn" : ""}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          {/* The number only ever moves for images, which is
                              why clearing a few hundred text entries leaves it
                              where it was. */}
                          <p className="acct-quota-note">
                            {formatBytes(quota.used_bytes)} used,{" "}
                            {formatBytes(free)} free. Only images you uploaded
                            count here. Text and notes take no storage, and
                            images other people shared with you stay on their
                            account.
                          </p>
                        </div>
                      );
                    })()}

                  {/* The other ceiling. Storage fills up in megabytes, this one
                      in rows, and an account of small text entries hits this
                      long before it hits the bar above - so it gets a bar of
                      its own rather than a footnote on that one. A server too
                      old to report a limit sends zero, which draws nothing. */}
                  {statsView === "cloud" &&
                    quota &&
                    quota.entry_limit > 0 &&
                    (() => {
                      const pct = Math.min(
                        100,
                        (quota.entry_count / quota.entry_limit) * 100,
                      );
                      return (
                        <div className="acct-quota">
                          <div className="acct-quota-head">
                            <Stack size={13} />
                            <span>Synced items</span>
                            <span className="acct-quota-value">
                              {pct < 1 && quota.entry_count > 0
                                ? "under 1%"
                                : `${Math.round(pct)}%`}{" "}
                              of {quota.entry_limit.toLocaleString()}
                            </span>
                          </div>
                          <div className="acct-quota-track">
                            <div
                              className={`acct-quota-fill${pct >= 85 ? " acct-quota-fill--warn" : ""}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="acct-quota-note">
                            {quota.entry_count.toLocaleString()} of{" "}
                            {quota.entry_limit.toLocaleString()} rows used.
                            Deleted items stop counting once the delete reaches
                            the server.
                            {quota.max_entry_bytes > 0
                              ? ` A single entry can be up to ${formatBytes(quota.max_entry_bytes)}; anything larger is left on this device.`
                              : ""}
                          </p>
                        </div>
                      );
                    })()}

                  {/* All four are cloud figures, so they stand with the cloud
                      view and are rows rather than a single line of numbers:
                      each one carries its own scope in the meta line, which
                      needs the width a row has. This device only ever knows
                      what it pushed or pulled itself, so its share sits below
                      the account's whenever another device has synced
                      something - saying so per row beats one footnote the
                      reader has to map back onto four numbers. A count that has
                      not run yet is not zero, so the number is withheld and the
                      action offered in its place. */}
                  {statsView === "cloud" && (
                    <>
                      <div className="acct-row">
                        <span className="acct-row-icon">
                          <ClipboardIcon size={13} />
                        </span>
                        <div className="acct-row-main">
                          <span className="acct-row-name">Clipboard</span>
                          <span className="acct-row-meta">
                            {cloudCounting
                              ? "Counting what is on the server"
                              : `${deviceTally.clipboard} of them synced from this device`}
                          </span>
                        </div>
                        <span className="acct-stat-value">
                          {cloudCounting ? (
                            "..."
                          ) : cloudCount === null ? (
                            <button
                              type="button"
                              className="acct-btn acct-btn--sm"
                              onClick={() => refreshCloudCount(true)}
                            >
                              Count
                            </button>
                          ) : (
                            cloudCount.clipboard
                          )}
                        </span>
                      </div>

                      <div className="acct-row">
                        <span className="acct-row-icon">
                          <NotesIcon size={13} />
                        </span>
                        <div className="acct-row-main">
                          <span className="acct-row-name">Notes</span>
                          <span className="acct-row-meta">
                            {cloudCounting
                              ? "Counting what is on the server"
                              : `${deviceTally.notes} of them synced from this device`}
                          </span>
                        </div>
                        <span className="acct-stat-value">
                          {cloudCounting || cloudCount === null
                            ? "-"
                            : cloudCount.notes}
                        </span>
                      </div>

                      <div className="acct-row">
                        <span className="acct-row-icon">
                          <CloudArrowUp size={13} />
                        </span>
                        <div className="acct-row-main">
                          <span className="acct-row-name">
                            Waiting to upload
                          </span>
                          <span className="acct-row-meta">
                            {deviceTally.waiting === 0
                              ? "Nothing queued on this device"
                              : `${deviceTally.waitingClipboard} clipboard, ${deviceTally.waitingNotes} notes, queued on this device`}
                          </span>
                        </div>
                        <span className="acct-stat-value">
                          {deviceTally.waiting}
                        </span>
                      </div>

                      <div className="acct-row">
                        <span className="acct-row-icon">
                          <Desktop size={13} />
                        </span>
                        <div className="acct-row-main">
                          <span className="acct-row-name">Devices</span>
                          <span className="acct-row-meta">
                            {onlineDevices} online
                            {lastSynced
                              ? ` - last synced ${formatLastSynced(lastSynced)}`
                              : ""}
                          </span>
                        </div>
                        <span className="acct-stat-value">{devices.length}</span>
                      </div>
                    </>
                  )}
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
