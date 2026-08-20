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

type NoteSection = { title: string | null; items: string[] };
type ParsedNotes = { lead: string | null; sections: NoteSection[] };

/** Notes arrive as the CHANGELOG's `[Unreleased]` body: an optional lead sentence,
    then `### New` / `### Improved` / `### Fixed` sections of `-` bullets. Parse that
    shape into a lead line plus titled sections.

    Older releases shipped a flat bulleted list with no headings — those parse to a
    single title-less section and render exactly as before, so an old install
    updating past this change still reads cleanly. */
const parseNotes = (raw: string): ParsedNotes => {
  const lead: string[] = [];
  const sections: NoteSection[] = [];
  let current: NoteSection | null = null;

  for (const line of raw.split("\n").map((l) => l.trim())) {
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      current = { title: heading[1].trim(), items: [] };
      sections.push(current);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!current) {
        current = { title: null, items: [] };
        sections.push(current);
      }
      current.items.push(bullet[1].trim());
      continue;
    }
    // Plain text: a lead sentence before any section, otherwise a stray line folded
    // into the section it sits under.
    if (current) current.items.push(line);
    else lead.push(line);
  }

  return {
    lead: lead.length ? lead.join(" ") : null,
    sections: sections.filter((s) => s.items.length > 0),
  };
};

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

  const notes = useMemo<ParsedNotes>(
    () => (info?.notes ? parseNotes(info.notes) : { lead: null, sections: [] }),
    [info?.notes],
  );
  const hasNotes = notes.lead !== null || notes.sections.length > 0;

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

          {hasNotes && (
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

        {notesOpen && hasNotes && (
          <div className="app-update-notes">
            {notes.lead && <p className="app-update-lead">{notes.lead}</p>}
            {notes.sections.map((section, i) => (
              <div className="app-update-group" key={i}>
                {section.title && (
                  <span className="app-update-section">{section.title}</span>
                )}
                <ul className="app-update-list">
                  {section.items.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
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
