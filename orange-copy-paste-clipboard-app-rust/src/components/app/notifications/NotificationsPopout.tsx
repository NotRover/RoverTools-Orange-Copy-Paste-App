import { sharedNow } from "../../../clock";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  UsersThree,
  BellSimple,
  CheckCircle,
  WarningCircle,
  Megaphone,
  Alarm,
} from "@phosphor-icons/react";
import { deferDestructive } from "../toast/toastBus";
import { usePendingRemovals } from "../../../hooks/pendingRemoval";
import type { AppNotification, NotificationKind } from "../../../types";
import "./NotificationsPopout.css";

interface NotificationsPopoutProps {
  open: boolean;
  /** Left edge of the panel and the bell's bottom edge, in viewport pixels. */
  anchorX: number;
  anchorY: number;
  items: AppNotification[];
  onClose: () => void;
  /** Re-read the feed after an action changed it. */
  onRefresh: () => void;
  /** Take the user to the space this notification is about. With an id, open
   *  that specific space; without one, just show the Spaces screen. */
  onOpenSpaces: (spaceId?: string) => void;
  /** Answering an invite needs an account. Signed out, say so instead of
      offering buttons whose only outcome is an error. */
  signedIn: boolean;
}

/** Chip label per category, in the order they are offered. */
const CHIPS: Array<{ key: string; label: string; kinds: NotificationKind[] }> = [
  { key: "invites", label: "Invites", kinds: ["space_invite"] },
  { key: "spaces", label: "Spaces", kinds: ["space_activity"] },
  { key: "sync", label: "Sync", kinds: ["sync_warning"] },
  { key: "news", label: "News", kinds: ["announcement"] },
  { key: "reminders", label: "Reminders", kinds: ["reminder"] },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows rendered per page. Roughly two screens of the panel, so "Show more" is
    a deliberate step rather than something the user hits while scrolling. */
const PAGE_SIZE = 15;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today" / "Yesterday" / a date, matched against the user's local midnight. */
function dayLabel(ms: number): string {
  const today = startOfDay(sharedNow());
  const day = startOfDay(ms);
  if (day === today) return "Today";
  if (day === today - DAY_MS) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((sharedNow() - ms) / 1000));
  if (secs < 60) return "Just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function glyphFor(kind: NotificationKind) {
  switch (kind) {
    case "space_invite":
      return { icon: <UsersThree size={15} weight="duotone" />, tone: "accent" };
    case "space_activity":
      return { icon: <CheckCircle size={15} weight="duotone" />, tone: "good" };
    case "sync_warning":
      return { icon: <WarningCircle size={15} weight="duotone" />, tone: "warn" };
    case "announcement":
      return { icon: <Megaphone size={15} weight="duotone" />, tone: "accent" };
    default:
      return { icon: <Alarm size={15} weight="duotone" />, tone: "plain" };
  }
}

const NotificationsPopout: React.FC<NotificationsPopoutProps> = ({
  open,
  anchorX,
  anchorY,
  items,
  onClose,
  onRefresh,
  onOpenSpaces,
  signedIn,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [chip, setChip] = useState<string>("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  // Invite ids with a request in flight, so a double-click cannot send two.
  const [busy, setBusy] = useState<string[]>([]);

  // Rows that were unread when the popout opened. They keep their unread
  // styling for as long as it is open - marking them read under the cursor
  // makes the list flicker and loses the user's place - and are flushed when it
  // closes, which is the point the user has actually seen them.
  //
  // Keyed on `open` alone, and on the close edge rather than in the click
  // handler, so every route out counts once: the bell, a click outside, Escape,
  // and a parent that closes the popout on its own. Recomputing as items arrive
  // would mark a notification read that landed while the user was looking away.
  const seenRef = useRef<string[]>([]);
  useEffect(() => {
    if (open) {
      seenRef.current = items.filter((n) => !n.read).map((n) => n.id);
      return;
    }
    const ids = seenRef.current;
    seenRef.current = [];
    if (ids.length > 0) {
      invoke("notifications_mark_read", { ids }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = panelRef.current;
      if (!el || el.contains(e.target as Node)) return;
      // The bell is a toggle and closes the popout itself. Without this it
      // would close here first and then be re-opened by its own click.
      if ((e.target as Element).closest?.("[data-notif-bell]")) return;
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

  // The panel grows upward from the bell, so it is pinned by its *bottom* edge
  // rather than positioned by a measured top. Its height can then change on its
  // own - dismissing a row, switching a chip - with nothing having to reposition
  // it: a JS reposition only lands after the round trip to Rust and back, which
  // is long enough to watch the panel slide back into place.
  //
  // The height cap keeps it clear of the top of the window, which is the one
  // thing a pinned bottom edge cannot do by itself.
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const el = panelRef.current;
    const left = Math.min(
      anchorX,
      Math.max(8, window.innerWidth - el.offsetWidth - 8),
    );
    el.style.left = `${left}px`;
    el.style.bottom = `${Math.max(8, window.innerHeight - anchorY)}px`;
    el.style.maxHeight = `${Math.max(160, Math.min(460, anchorY - 16))}px`;
  }, [open, anchorX, anchorY]);

  // Reset the filter each time it opens: a chip left on "Sync" from last time
  // hides the invite the badge is counting.
  useEffect(() => {
    if (open) setChip("all");
  }, [open]);

  const chipsShown = useMemo(
    () => CHIPS.filter((c) => items.some((n) => c.kinds.includes(n.kind))),
    [items],
  );

  // Clearing the last row of the category being viewed takes that chip away
  // with it. The selection has to follow, or the panel filters on a category
  // that is no longer offered and reads as an empty feed - which is what the
  // rest of the notifications look like they have gone.
  const activeChip = chipsShown.some((c) => c.key === chip) ? chip : "all";

  // Rows whose clearing is waiting out its Undo toast are already gone from the
  // panel: the list is read from Rust, which still has them until the toast
  // runs out.
  const pendingGone = usePendingRemovals();
  const filtered = useMemo(() => {
    const here = items.filter((n) => !pendingGone.has(`notification:${n.id}`));
    if (activeChip === "all") return here;
    const match = CHIPS.find((c) => c.key === activeChip);
    return match ? here.filter((n) => match.kinds.includes(n.kind)) : here;
  }, [items, activeChip, pendingGone]);

  // A page count is a property of the current filter, so switching chips starts
  // over. Without this, filtering after paging deep shows a "Show more" that
  // has nothing left to reveal.
  useEffect(() => {
    setShown(PAGE_SIZE);
  }, [activeChip, open]);

  const visible = useMemo(() => filtered.slice(0, shown), [filtered, shown]);
  const remaining = filtered.length - visible.length;

  // Day headers, computed from the already-sorted feed so a group break is just
  // a change of label between neighbours.
  const groups = useMemo(() => {
    const out: Array<{ label: string; rows: AppNotification[] }> = [];
    for (const n of visible) {
      const label = dayLabel(n.created_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(n);
      else out.push({ label, rows: [n] });
    }
    return out;
  }, [visible]);

  const unreadCount = items.filter((n) => !n.read).length;

  const answerInvite = async (n: AppNotification, accept: boolean) => {
    const inviteId = n.data.invite_id;
    if (!inviteId || busy.includes(n.id)) return;
    setBusy((b) => [...b, n.id]);
    try {
      await invoke(accept ? "sync_accept_invite" : "sync_decline_invite", {
        inviteId,
      });
      await invoke("notifications_refresh").catch(() => {});
      onRefresh();
      if (accept) onOpenSpaces();
    } catch {
      // The server said no - a refresh shows why (revoked, expired, already
      // answered elsewhere) rather than this guessing at the reason.
      await invoke("notifications_refresh").catch(() => {});
      onRefresh();
    } finally {
      setBusy((b) => b.filter((id) => id !== n.id));
    }
  };

  // A "somebody asked to join" knock, unlike an invite, is the owner/approver
  // deciding for someone else. It carries a request_id (not an invite_id) and
  // is answered with the approve/decline commands. Approving without the
  // requester's key still lets them in - the space key reaches them on the
  // reconcile the command kicks off. The command also resolves this knock, so
  // the row loses its buttons here once it is answered.
  const answerJoinRequest = async (n: AppNotification, accept: boolean) => {
    const spaceId = n.data.space_id;
    const requestId = n.data.request_id;
    if (!spaceId || !requestId || busy.includes(n.id)) return;
    setBusy((b) => [...b, n.id]);
    try {
      if (accept) {
        await invoke("space_approve_join", {
          spaceId,
          requestId,
        });
      } else {
        await invoke("space_decline_join", { spaceId, requestId });
      }
    } catch {
      // A refusal (already answered, request withdrawn) still leaves the feed
      // to re-read below, which shows the row's real state.
    } finally {
      onRefresh();
      setBusy((b) => b.filter((id) => id !== n.id));
    }
  };

  const dismiss = (id: string) => {
    seenRef.current = seenRef.current.filter((x) => x !== id);
    invoke("notifications_dismiss", { id })
      .then(onRefresh)
      .catch(() => {});
  };

  if (!open) return null;

  return createPortal(
    <div className="ntf-panel" ref={panelRef} role="dialog" aria-label="Notifications">
      <div className="ntf-head">
        <span className="ntf-title">Notifications</span>
        <div className="ntf-head-actions">
          {unreadCount > 0 && (
            <button
              className="ntf-link"
              onClick={() => {
                seenRef.current = [];
                invoke("notifications_mark_all_read").then(onRefresh).catch(() => {});
              }}
            >
              Mark all read
            </button>
          )}
          {items.some((n) => n.read) && (
            <button
              className="ntf-link"
              onClick={() => {
                deferDestructive(
                  "Read notifications cleared",
                  () =>
                    invoke("notifications_clear_read")
                      .then(onRefresh)
                      .catch(() => {}),
                  {
                    key: "notifications-clear-read",
                    hides: items
                      .filter((n) => n.read)
                      .map((n) => `notification:${n.id}`),
                  },
                );
              }}
            >
              Clear read
            </button>
          )}
        </div>
      </div>

      {/* One chip is no filter at all, so the row only appears once there is
          something to choose between. */}
      {chipsShown.length > 1 && (
        <div className="ntf-chips">
          <button
            className={`ntf-chip${activeChip === "all" ? " active" : ""}`}
            onClick={() => setChip("all")}
          >
            All
          </button>
          {chipsShown.map((c) => {
            const count = items.filter(
              (n) => c.kinds.includes(n.kind) && !n.read,
            ).length;
            return (
              <button
                key={c.key}
                className={`ntf-chip${activeChip === c.key ? " active" : ""}`}
                onClick={() => setChip(c.key)}
              >
                {c.label}
                {count > 0 && <span className="ntf-chip-count">{count}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="ntf-list">
        {groups.length === 0 && (
          <div className="ntf-empty">
            <BellSimple size={26} weight="duotone" />
            <p className="ntf-empty-title">You are all caught up</p>
            <p className="ntf-empty-body">
              Space invites and sync warnings show up here.
            </p>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.label}>
            <div className="ntf-day">{g.label}</div>
            {g.rows.map((n) => {
              const glyph = glyphFor(n.kind);
              const actionable = n.kind === "space_invite" && !n.resolved;
              // Two shapes share the space_invite kind: an invite sent to this
              // user (invite_id, "Join") and a request from someone else this
              // user may approve (request_id, "Accept").
              const isJoinRequest = actionable && !!n.data.request_id;
              // A row about a space opens it, unless it is still asking a
              // question - answering an invite must not be a side effect of
              // trying to read it.
              const linked = !actionable && !!n.data.space_id;
              return (
                <div
                  key={n.id}
                  className={`ntf-row${n.read ? "" : " unread"}${linked ? " ntf-row--link" : ""}`}
                  role={linked ? "button" : undefined}
                  tabIndex={linked ? 0 : undefined}
                  onClick={linked ? () => onOpenSpaces(n.data.space_id) : undefined}
                  onKeyDown={
                    linked
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenSpaces(n.data.space_id);
                          }
                        }
                      : undefined
                  }
                >
                  <span className={`ntf-glyph ntf-glyph--${glyph.tone}`}>
                    {glyph.icon}
                  </span>
                  <div className="ntf-body">
                    <p className="ntf-row-title">{n.title}</p>
                    {n.body && <p className="ntf-row-sub">{n.body}</p>}
                    <p className="ntf-row-meta">
                      {relativeTime(n.created_at)}
                      {n.resolved && (
                        <span className="ntf-resolved">{n.resolved}</span>
                      )}
                    </p>
                    {actionable &&
                      (signedIn ? (
                        <div className="ntf-actions">
                          <button
                            className="ntf-btn ntf-btn--primary"
                            disabled={busy.includes(n.id)}
                            onClick={() =>
                              isJoinRequest
                                ? answerJoinRequest(n, true)
                                : answerInvite(n, true)
                            }
                          >
                            {isJoinRequest ? "Accept" : "Join"}
                          </button>
                          <button
                            className="ntf-btn"
                            disabled={busy.includes(n.id)}
                            onClick={() =>
                              isJoinRequest
                                ? answerJoinRequest(n, false)
                                : answerInvite(n, false)
                            }
                          >
                            Decline
                          </button>
                        </div>
                      ) : (
                        <p className="ntf-row-signin">
                          Sign in on the Account screen to answer this.
                        </p>
                      ))}
                  </div>
                  <button
                    className="ntf-dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismiss(n.id);
                    }}
                    aria-label="Dismiss"
                    data-tooltip="Dismiss"
                    data-tooltip-pos="left"
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        fill="none"
                      />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        ))}

        {remaining > 0 && (
          <button className="ntf-more" onClick={() => setShown((n) => n + PAGE_SIZE)}>
            Show {Math.min(remaining, PAGE_SIZE)} more
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default NotificationsPopout;
