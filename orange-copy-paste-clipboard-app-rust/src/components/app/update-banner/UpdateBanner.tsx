import React, { useState } from "react";
import { ArrowClockwise, DownloadSimple, X } from "@phosphor-icons/react";
import type { Updater } from "../../../hooks/useUpdater";
import "./UpdateBanner.css";

/**
 * The one place an update interrupts the user, and it interrupts gently: a strip
 * under the titlebar, never a modal. Nothing here starts a download or a restart
 * on its own — every state change below is a button the user pressed.
 *
 * Renders nothing unless there is something to act on, so the caller can mount it
 * unconditionally.
 */
const UpdateBanner: React.FC<{ updater: Updater }> = ({ updater }) => {
  const { stage, info, percent, error, visible, download, install, dismiss, skip } = updater;
  const [notesOpen, setNotesOpen] = useState(false);

  const active =
    visible && info !== null && stage !== "idle" && stage !== "checking";
  if (!active || !info) return null;

  const busy = stage === "downloading" || stage === "installing";

  return (
    <div className="app-update" role="status" aria-live="polite">
      <div className="app-update-text">
        <strong>Version {info.version} is available.</strong>{" "}
        <span className="app-update-from">You have {info.current_version}.</span>
        {stage === "downloading" && (
          <span className="app-update-note">
            {percent === null ? "Downloading…" : `Downloading — ${percent}%`}
          </span>
        )}
        {stage === "ready" && (
          <span className="app-update-note">
            Downloaded and verified. The app restarts to finish installing.
          </span>
        )}
        {stage === "installing" && <span className="app-update-note">Installing…</span>}
        {stage === "error" && error && (
          <span className="app-update-note app-update-error">{error}</span>
        )}

        {info.notes && (
          <>
            <button
              type="button"
              className="app-update-notes-toggle"
              onClick={() => setNotesOpen((v) => !v)}
              aria-expanded={notesOpen}
            >
              {notesOpen ? "Hide what's new" : "What's new"}
            </button>
            {notesOpen && <pre className="app-update-notes">{info.notes}</pre>}
          </>
        )}

        {stage === "downloading" && (
          <div className="app-update-bar">
            {/* No content-length means no honest percentage, so the bar sweeps
                instead of claiming a position it does not know. */}
            <div
              className={`app-update-bar-fill${percent === null ? " indeterminate" : ""}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        )}
      </div>

      <div className="app-update-actions">
        {stage === "ready" ? (
          <button type="button" className="app-update-primary" onClick={install} disabled={busy}>
            <ArrowClockwise size={13} weight="bold" />
            Restart &amp; install
          </button>
        ) : (
          <button
            type="button"
            className="app-update-primary"
            onClick={download}
            disabled={busy}
          >
            <DownloadSimple size={13} weight="bold" />
            {stage === "error" ? "Try again" : "Download"}
          </button>
        )}

        {/* Skipping is only offered before committing to the download — once the
            bytes are on disk the useful choice is "now or next launch", not
            "never". */}
        {!busy && stage !== "ready" && (
          <button type="button" className="app-update-secondary" onClick={skip}>
            Skip this version
          </button>
        )}

        {!busy && (
          <button
            type="button"
            className="app-update-close"
            onClick={dismiss}
            aria-label="Remind me later"
            data-tooltip="Remind me later"
            data-tooltip-pos="bottom"
          >
            <X size={12} weight="bold" />
          </button>
        )}
      </div>
    </div>
  );
};

export default UpdateBanner;
