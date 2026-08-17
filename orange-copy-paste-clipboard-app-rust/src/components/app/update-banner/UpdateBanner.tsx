import React, { useMemo, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  DownloadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { Updater } from "../../../hooks/useUpdater";
import "./UpdateBanner.css";

/** Notes arrive as plain commit subjects, one per line, usually bullet-prefixed.
    Stripping the marker here lets the list render as a real list instead of a
    block of pre-formatted text. */
const parseNotes = (raw: string): string[] =>
  raw
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);

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

  const notes = useMemo(
    () => (info?.notes ? parseNotes(info.notes) : []),
    [info?.notes],
  );

  if (!active || !info) return null;

  const busy = stage === "downloading" || stage === "installing";

  const status =
    stage === "downloading"
      ? percent === null
        ? "Downloading..."
        : `Downloading ${percent}%`
      : stage === "ready"
        ? "Downloaded and verified. The app restarts to finish installing."
        : stage === "installing"
          ? "Installing..."
          : stage === "error" && error
            ? error
            : null;

  return (
    <div className="app-update" role="status" aria-live="polite" data-stage={stage}>
      <span className="app-update-icon" aria-hidden="true">
        {stage === "error" ? (
          <WarningCircle size={15} weight="regular" />
        ) : stage === "ready" ? (
          <ArrowClockwise size={14} weight="regular" />
        ) : (
          <DownloadSimple size={14} weight="regular" />
        )}
      </span>

      <div className="app-update-body">
        <div className="app-update-head">
          <strong className="app-update-title">Version {info.version} is available</strong>
          <span className="app-update-dot" aria-hidden="true" />
          <span className="app-update-from">You have {info.current_version}</span>

          {notes.length > 0 && (
            <>
              <span className="app-update-dot" aria-hidden="true" />
              <button
                type="button"
                className="app-update-toggle"
                onClick={() => setNotesOpen((v) => !v)}
                aria-expanded={notesOpen}
              >
                What's new
                <CaretDown
                  size={10}
                  weight="bold"
                  className={notesOpen ? "is-open" : undefined}
                />
              </button>
            </>
          )}
        </div>

        {status && (
          <p className={`app-update-status${stage === "error" ? " is-error" : ""}`}>
            {status}
          </p>
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

        {notesOpen && notes.length > 0 && (
          <ul className="app-update-notes">
            {notes.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
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
