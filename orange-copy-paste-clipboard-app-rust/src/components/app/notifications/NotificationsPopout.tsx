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
  /** Take the user to the space this notification is about. */
  onOpenSpaces: () => void;
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
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  if (day === today) return "Today";
  if (day === today - DAY_MS) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
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

  // The panel grows upward from the bell, so its top depends on a height only
  // the browser knows. Measure, then place, writing straight to the node so it
  // never paints at (0, 0) first. Re-runs when the content changes size, which
  // filtering and answering an invite both do.
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const el = panelRef.current;
    const { height, width } = el.getBoundingClientRect();
    const top = Math.min(
      Math.max(8, anchorY - height),
      Math.max(8, window.innerHeight - height - 8),
    );
    const left = Math.min(anchorX, Math.max(8, window.innerWidth - width - 8));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }, [open, anchorX, anchorY, items, chip, shown]);

  // Reset the filter each time it opens: a chip left on "Sync" from last time
  // hides the invite the badge is counting.
  useEffect(() => {
    if (open) setChip("all");
  }, [open]);

  const chipsShown = useMemo(
    () => CHIPS.filter((c) => items.some((n) => c.kinds.includes(n.kind))),
    [items],
  );

  const filtered = useMemo(() => {
    if (chip === "all") return items;
    const match = CHIPS.find((c) => c.key === chip);
    return match ? items.filter((n) => match.kinds.includes(n.kind)) : items;
  }, [items, chip]);

  // A page count is a property of the current filter, so switching chips starts
  // over. Without this, filtering after paging deep shows a "Show more" that
  // has nothing left to reveal.
  useEffect(() => {
    setShown(PAGE_SIZE);
  }, [chip, open]);

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
                invoke("notifications_clear_read").then(onRefresh).catch(() => {});
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
            className={`ntf-chip${chip === "all" ? " active" : ""}`}
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
                className={`ntf-chip${chip === c.key ? " active" : ""}`}
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
                  onClick={linked ? onOpenSpaces : undefined}
                  onKeyDown={
                    linked
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenSpaces();
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
                    {actionable && (
                      <div className="ntf-actions">
                        <button
                          className="ntf-btn ntf-btn--primary"
                          disabled={busy.includes(n.id)}
                          onClick={() => answerInvite(n, true)}
                        >
                          Join
                        </button>
                        <button
                          className="ntf-btn"
                          disabled={busy.includes(n.id)}
                          onClick={() => answerInvite(n, false)}
                        >
                          Decline
                        </button>
                      </div>
                    )}
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
