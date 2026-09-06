import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./splash.css";
import { installWebviewGuards } from "../../webview-guards";

// ── Timing ──────────────────────────────────────────────────────────────────
// The splash checks the update feed on launch. The app's own automatic check
// only runs ~8s in (updater.rs), after the splash is gone, so this triggers an
// earlier one. It waits briefly for an answer, shows "Ready" or the available
// version, holds long enough to read, then closes itself via `close_splash`.
// Rust keeps a hard-cap fallback close (lib.rs) if this never completes.
//
// When auto-update is on and a newer version is found, the splash instead
// downloads and installs it here, then the install restarts the app - so this
// is the last screen before the new version comes up.
const CHECK_CAP_MS   = 3000;  // stop waiting on the check and settle on "Ready"
const HOLD_READY_MS  = 5000;  // how long the resting state shows before leaving
const HOLD_UPDATE_MS = 5500;  // a little longer when there is an update to read
const OUT_MS         = 450;   // slide-out duration before the window closes
// ─────────────────────────────────────────────────────────────────────────────

type Phase  = "idle" | "in" | "out";
type Status = "checking" | "ready" | "update" | "updating" | "installing";
type Theme  = "dark" | "light";

/** Mirrors `UpdateInfo` in `src-tauri/src/updater.rs`. */
interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
  downloaded: boolean;
  skipped: boolean;
}

/** Mirrors the `updater:progress` payload. */
interface Progress {
  downloaded: number;
  total: number | null;
}

function getTheme(): Theme {
  return (localStorage.getItem("sc-theme") as Theme) ?? "dark";
}

const LOGO_LIGHT_MODE = encodeURI("/Smart Clipboard Logo.svg");
const LOGO_DARK_MODE  = encodeURI("/Smart Clipboard Logo Dark.svg");

// Rotating startup tips. Keep these to things a user can act on right away; the
// highlighted token is the key or control, the line is what it does. Shortcuts
// mirror the reference on the Shortcuts screen.
const TIPS: { token: string; text: string }[] = [
  { token: "Ctrl+Shift+V", text: "opens quick paste" },
  { token: "Ctrl+Shift+C", text: "saves a copy to history" },
  { token: "Pin",          text: "keeps a clip in the popup" },
  { token: "Save",         text: "keeps a clip past restarts" },
  { token: "1-9",          text: "paste a slot in the popup" },
  { token: "Type",         text: "in the popup to search" },
  { token: "Right-click",  text: "a card for more actions" },
  { token: "Groups",       text: "tag clips to find them fast" },
];

function pickTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

const SplashScreen: React.FC = () => {
  const [phase, setPhase]     = useState<Phase>("idle");
  const [status, setStatus]   = useState<Status>("checking");
  const [update, setUpdate]   = useState<UpdateInfo | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [theme]               = useState<Theme>(getTheme);
  const [tip]                 = useState(pickTip);

  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let cancelled = false;
    let decided   = false;
    let closed    = false;
    const unlisten: Array<() => void> = [];
    const keep = (fn: () => void) => {
      if (cancelled) fn();
      else unlisten.push(fn);
    };

    const raf = requestAnimationFrame(() => setPhase("in"));

    const closeSelf = () => {
      if (closed) return;
      closed = true;
      invoke("close_splash").catch(() => {});
    };

    // After the resting state has been up long enough to read, slide out and
    // ask Rust to close the window.
    const scheduleOut = (isUpdate: boolean) => {
      timers.push(
        setTimeout(() => {
          setPhase("out");
          getCurrentWindow().setIgnoreCursorEvents(true).catch(() => {});
          timers.push(setTimeout(closeSelf, OUT_MS));
        }, isUpdate ? HOLD_UPDATE_MS : HOLD_READY_MS),
      );
    };

    // Download and install the update in place, then let the install restart the
    // app. Holds the window open the whole time (Rust's fallback close waits on
    // the same flag). If anything fails, fall back to just announcing it.
    const autoUpdate = async () => {
      setStatus("updating");
      setPercent(null);
      invoke("splash_set_updating", { updating: true }).catch(() => {});
      try {
        await invoke("updater_download");
        if (cancelled) return;
        setStatus("installing");
        // Succeeds by never returning - the process is replaced. Reaching past
        // it means the install did not take over, so treat it as a failure.
        await invoke("updater_install");
        throw new Error("install did not take over");
      } catch {
        invoke("splash_set_updating", { updating: false }).catch(() => {});
        if (cancelled) return;
        setStatus("update");
        scheduleOut(true);
      }
    };

    // Settle on a final state exactly once - whichever of the check or the cap
    // gets there first.
    const decide = (info: UpdateInfo | null) => {
      if (decided) return;
      decided = true;
      if (!info) {
        setStatus("ready");
        scheduleOut(false);
        return;
      }
      setUpdate(info);
      // A skipped version is one the user declined - never auto-install it, just
      // show it. Otherwise auto-update only when the user has turned it on.
      if (info.skipped) {
        setStatus("update");
        scheduleOut(true);
        return;
      }
      invoke<boolean | null>("get_setting", { key: "auto_install_updates" })
        .then((v) => {
          if (cancelled) return;
          if (v === true) {
            autoUpdate();
          } else {
            setStatus("update");
            scheduleOut(true);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setStatus("update");
          scheduleOut(true);
        });
    };

    listen<Progress>("updater:progress", (event) => {
      if (cancelled) return;
      const { downloaded, total } = event.payload;
      setPercent(total && total > 0 ? Math.floor((downloaded / total) * 100) : null);
    }).then(keep);

    const runCheck = () => {
      invoke<UpdateInfo | null>("updater_check")
        .then((info) => decide(info ?? null))
        // Offline is the normal failure here, and updates are refused in dev
        // builds - either way, just show "Ready".
        .catch(() => decide(null));
    };

    // Backstop so the splash never sits on "Checking" if a call hangs.
    timers.push(setTimeout(() => decide(null), CHECK_CAP_MS));

    // Respect the user's "check automatically" preference - the same setting the
    // background checker reads. Off means the splash does not touch the feed.
    invoke<boolean | null>("get_setting", { key: "auto_check_updates" })
      .then((auto) => {
        if (cancelled) return;
        if (auto === false) decide(null);
        else runCheck();
      })
      .catch(() => {
        if (cancelled) return;
        runCheck();
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      unlisten.forEach((fn) => fn());
    };
  }, []);

  const logoSrc    = theme === "dark" ? LOGO_DARK_MODE : LOGO_LIGHT_MODE;
  const updateLike = status === "update" || status === "updating" || status === "installing";

  const statusText = () => {
    switch (status) {
      case "ready":
        return "Ready";
      case "update":
        return "Update available";
      case "updating":
        return percent === null ? "Downloading update" : `Downloading update  ${percent}%`;
      case "installing":
        return "Installing update";
      default:
        return null;
    }
  };

  const tipColumn = () => {
    if (status === "update" && update) {
      return (
        <>
          <span className="splash-tip-eyebrow">New version</span>
          <span className="splash-tip-text"><b>v{update.version}</b> ready to install</span>
        </>
      );
    }
    if ((status === "updating" || status === "installing") && update) {
      return (
        <>
          <span className="splash-tip-eyebrow">Updating</span>
          <span className="splash-tip-text">to <b>v{update.version}</b></span>
        </>
      );
    }
    return (
      <>
        <span className="splash-tip-eyebrow">Tip</span>
        <span className="splash-tip-text"><b>{tip.token}</b> {tip.text}</span>
      </>
    );
  };

  return (
    <div className="splash" data-theme={theme} data-phase={phase}>
      <div className="splash-toast" data-mode={updateLike ? "update" : "normal"}>
        <img className="splash-logo-img" src={logoSrc} alt="" draggable={false} />

        <div className="splash-body">
          <span className="splash-name">Orange Copy Paste</span>
          <span className="splash-status" data-state={status}>
            <span className="splash-dot" data-state={status} />
            {status === "checking" ? (
              <>Checking for updates<span className="splash-dots"><span>.</span><span>.</span><span>.</span></span></>
            ) : (
              statusText()
            )}
          </span>
        </div>

        <div className="splash-divider" />

        <div className="splash-tip">{tipColumn()}</div>
      </div>
    </div>
  );
};

installWebviewGuards();

ReactDOM.createRoot(document.getElementById("root")!).render(<SplashScreen />);
