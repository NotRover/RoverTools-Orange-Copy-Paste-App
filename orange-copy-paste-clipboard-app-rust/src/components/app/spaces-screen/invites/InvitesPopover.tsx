import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SpaceJoinRequest, SyncInvite } from "../../../../types";
import "./InvitesPopover.css";

interface InvitesPopoverProps {
  open: boolean;
  /** Centre and top edge of the button that opened it, in viewport px. */
  anchorX: number;
  anchorY: number;
  received: SyncInvite[];
  sent: SyncInvite[];
  /** People who used a code or a join link and are waiting to be let in. Only
      ever non-empty for someone who may approve them. */
  requests: SpaceJoinRequest[];
  /** Answering needs an account: signed out, the rows are read-only. */
  signedIn: boolean;
  onClose: () => void;
  onAccept: (inviteId: string) => void;
  onDecline: (inviteId: string) => void;
  onRevoke: (inviteId: string) => void;
  onApprove: (req: SpaceJoinRequest) => void;
  onTurnDown: (req: SpaceJoinRequest) => void;
}

function ago(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** How long is left to answer. An invite the server will refuse is worth
    saying out loud before the user presses Accept on it. */
function expiry(ms: number): string {
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return "Expired";
  if (mins < 60) return `Expires in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Expires in ${hours} hr`;
  return `Expires in ${Math.round(hours / 24)} days`;
}

const InvitesPopover: React.FC<InvitesPopoverProps> = ({
  open,
  anchorX,
  anchorY,
  received,
  sent,
  requests,
  signedIn,
  onClose,
  onAccept,
  onDecline,
  onRevoke,
  onApprove,
  onTurnDown,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"requests" | "received" | "sent">("requests");

  // One list at a time, and it opens on the one that is asking something of
  // the user. Landing on an empty Received tab while an invite waits under
  // Sent would read as "nothing here". Requests come first: somebody is
  // waiting on a door only this user can open.
  useEffect(() => {
    if (!open) return;
    if (requests.length > 0) setTab("requests");
    else setTab(received.length > 0 ? "received" : "sent");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rows = tab === "received" ? received : tab === "sent" ? sent : [];

  // Centred on the button and grown upward, pinned by its *bottom* edge rather
  // than a measured top: answering an invite changes the height, and a JS
  // reposition only lands after the round trip to Rust and back - long enough
  // to watch the panel slide back into place.
  //
  // offsetWidth, not getBoundingClientRect: the open animation is already
  // running by the time this reads the box, and the rect reflects its
  // scale(0.96), which centred the panel half that error off.
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const el = panelRef.current;
    const width = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(anchorX - width / 2, window.innerWidth - width - 8))}px`;
    el.style.bottom = `${Math.max(8, window.innerHeight - anchorY + 6)}px`;
    el.style.maxHeight = `${Math.max(160, Math.min(460, anchorY - 22))}px`;
  }, [open, anchorX, anchorY]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = panelRef.current;
      if (!el || el.contains(e.target as Node)) return;
      // The trigger is a toggle and closes this itself. Without the guard it
      // would close here first and be reopened by its own click.
      if ((e.target as Element).closest?.("[data-invites-trigger]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="inv-pop" ref={panelRef} role="dialog" aria-label="Invites">
      <div className="inv-head">
        <span className="inv-title">Invites</span>
      </div>

      <div className="inv-tabs">
        {(["requests", "received", "sent"] as const).map((key) => (
          <button
            key={key}
            className={`inv-tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {key === "requests"
              ? "Requests"
              : key === "received"
                ? "Received"
                : "Sent"}
            <span className="inv-tab-count">
              {key === "requests"
                ? requests.length
                : key === "received"
                  ? received.length
                  : sent.length}
            </span>
          </button>
        ))}
      </div>

      {!signedIn && (
        <p className="inv-signin">
          Sign in on the Account screen to answer invites.
        </p>
      )}

      <div className="inv-list">
        {tab === "requests" && requests.length === 0 && (
          <p className="inv-empty">Nobody is waiting to be let in.</p>
        )}

        {tab === "requests" &&
          requests.map((req) => (
            <div key={req.id} className="inv-row">
              <p className="inv-row-space">{req.space_name}</p>
              <p className="inv-row-sub">
                {req.display_name || "Someone"} used a code or a join link
                <span className="inv-row-meta"> {ago(req.created_at)}</span>
              </p>
              <div className="inv-row-actions">
                <button
                  className="inv-btn inv-btn--primary"
                  disabled={!signedIn}
                  onClick={() => onApprove(req)}
                >
                  Approve
                </button>
                <button
                  className="inv-btn"
                  disabled={!signedIn}
                  onClick={() => onTurnDown(req)}
                >
                  Decline
                </button>
              </div>
            </div>
          ))}

        {tab !== "requests" && rows.length === 0 && (
          <p className="inv-empty">
            {tab === "received"
              ? "No invites waiting for an answer."
              : "You have not invited anyone yet."}
          </p>
        )}

        {rows.map((inv) => (
          <div key={inv.id} className="inv-row">
            <p className="inv-row-space">{inv.space_name}</p>
            <p className="inv-row-sub">
              {tab === "received"
                ? `From ${inv.inviter_name || "someone"}`
                : `To ${inv.invitee_email}`}
              <span className="inv-row-meta">
                {" "}
                {ago(inv.created_at)}, {expiry(inv.expires_at).toLowerCase()}
              </span>
            </p>
            <div className="inv-row-actions">
              {tab === "received" ? (
                <>
                  <button
                    className="inv-btn inv-btn--primary"
                    disabled={!signedIn}
                    onClick={() => onAccept(inv.id)}
                  >
                    Accept
                  </button>
                  <button
                    className="inv-btn"
                    disabled={!signedIn}
                    onClick={() => onDecline(inv.id)}
                  >
                    Decline
                  </button>
                </>
              ) : (
                <button
                  className="inv-btn inv-btn--danger"
                  disabled={!signedIn}
                  onClick={() => onRevoke(inv.id)}
                >
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
};

export default InvitesPopover;
