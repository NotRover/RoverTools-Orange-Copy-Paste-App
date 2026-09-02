import React, { useEffect, useState } from "react";
import { WarningIcon } from "../icons";
import { describeDelete, deleteMessage, type DeleteOrigin } from "../../confirmDelete";
import "./ConfirmDeleteDialog.css";

interface Props {
  /** Render the dialog when true. */
  open: boolean;
  /** How many items are being deleted (drives singular/plural copy). */
  count?: number;
  /** Keys (`clipboard:{id}` / `note:{id}`) being deleted, so the body copy can
   *  say what the delete does - own vs received, and which spaces. Omitted, the
   *  copy falls back to the plain "synced across your devices" wording. */
  entryKeys?: string[];
  onCancel: () => void;
  /** Confirm the delete; `dontAskAgain` is the checkbox state. */
  onConfirm: (dontAskAgain: boolean) => void;
}

/** Origin used until the real lookup resolves, and when no keys are passed. */
const OWN_ONLY: DeleteOrigin = {
  receivedCount: 0,
  sharedCount: 0,
  fromMember: null,
  fromSpaceNames: [],
  sharedSpaceNames: [],
};

/**
 * Confirmation shown before deleting a synced item. Deleting a synced entry is
 * not a local-only action, so this warns once and offers a "Don't ask again"
 * opt-out. The body copy adapts to where the item came from: your personal
 * cloud, a space you shared it into, or another member who shared it with you.
 * Self-contained (no app context), so the history list, the notes list and both
 * quick popups can each render their own.
 */
export const ConfirmDeleteDialog: React.FC<Props> = ({
  open,
  count = 1,
  entryKeys,
  onCancel,
  onConfirm,
}) => {
  const [dontAsk, setDontAsk] = useState(false);
  const [origin, setOrigin] = useState<DeleteOrigin>(OWN_ONLY);

  // Fresh checkbox on every open.
  useEffect(() => {
    if (open) setDontAsk(false);
  }, [open]);

  // Resolve where the items came from once the dialog opens. Starts from the
  // own-only default so the copy is right for the common case before the async
  // lookup lands, then refines if any target turns out to be shared or received.
  useEffect(() => {
    if (!open) return;
    setOrigin(OWN_ONLY);
    if (!entryKeys?.length) return;
    let live = true;
    void describeDelete(entryKeys).then((o) => {
      if (live) setOrigin(o);
    });
    return () => {
      live = false;
    };
  }, [open, entryKeys]);

  // Escape cancels. Captured and stopped so a popup's own Escape-to-close does
  // not fire underneath and yank the window away mid-decision.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  if (!open) return null;
  const plural = count > 1;

  return (
    <div
      className="cdd-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="cdd-card">
        <div className="cdd-head">
          <span className="cdd-icon" aria-hidden="true">
            <WarningIcon size={17} />
          </span>
          <div className="cdd-title">
            {plural ? `Delete ${count} items?` : "Delete this item?"}
          </div>
        </div>
        <div className="cdd-body">
          {deleteMessage(origin, count).map((part, i) =>
            part.hi ? (
              <span key={i} className="cdd-hi">
                {part.t}
              </span>
            ) : (
              <React.Fragment key={i}>{part.t}</React.Fragment>
            ),
          )}
        </div>
        <div className="cdd-footer">
          <label className="cdd-check">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(e) => setDontAsk(e.target.checked)}
            />
            <span>Don't ask again</span>
          </label>
          <div className="cdd-actions">
            <button className="cdd-btn cdd-btn--cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              className="cdd-btn cdd-btn--delete"
              onClick={() => onConfirm(dontAsk)}
              autoFocus
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDeleteDialog;
