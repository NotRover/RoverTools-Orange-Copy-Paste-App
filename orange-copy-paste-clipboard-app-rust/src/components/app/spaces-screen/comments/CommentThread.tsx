import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PaperPlaneRight, Trash } from "@phosphor-icons/react";

import type { SpaceComment, SpaceMember } from "../../../../types";
import { timeAgo } from "../../../../types";
import { UserAvatar } from "../../../UserAvatar";
import { deferDestructive, toastError } from "../../toast/toastBus";
import { usePendingRemovals } from "../../../../hooks/pendingRemoval";
import "./CommentThread.css";

/** A mention as it is written into the body: `@[Ada Lovelace](uuid)`.
 *  The name travels with the id on purpose - a comment records what was said,
 *  so it keeps the name that was used even after the person renames. */
const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

type Segment =
  | { kind: "text"; text: string }
  | { kind: "mention"; label: string; userId: string };

/** Split a stored body into what the thread draws. */
export function parseBody(body: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(body); m; m = MENTION_RE.exec(body)) {
    if (m.index > last)
      out.push({ kind: "text", text: body.slice(last, m.index) });
    out.push({ kind: "mention", label: m[1], userId: m[2] });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}

/** What a comment reads as in a list: mentions marked, the rest plain. */
const CommentBody: React.FC<{ body: string; selfUserId: string }> = ({
  body,
  selfUserId,
}) => (
  <p className="cmt-body">
    {parseBody(body).map((seg, i) =>
      seg.kind === "text" ? (
        <span key={i}>{seg.text}</span>
      ) : (
        <span
          key={i}
          className={`cmt-mention${seg.userId === selfUserId ? " cmt-mention--me" : ""}`}
        >
          @{seg.label}
        </span>
      ),
    )}
  </p>
);

// ── Composer ──────────────────────────────────────────────────────────

/** The `@` fragment being typed, if the caret is inside one.
 *
 *  Only a run with no whitespace counts, and only one that starts at a word
 *  boundary - so an email address does not open the picker. */
function activeMentionQuery(
  text: string,
  caret: number,
): { at: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { at, query };
}

const Composer: React.FC<{
  members: SpaceMember[];
  selfUserId: string;
  onSend: (body: string) => Promise<void>;
}> = ({ members, selfUserId, onSend }) => {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ at: number; query: string } | null>(
    null,
  );
  const [highlight, setHighlight] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Everyone but yourself: tagging yourself is a note to nobody.
  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members
      .filter((m) => m.user_id !== selfUserId)
      .filter((m) => (m.display_name || "Member").toLowerCase().includes(q))
      .slice(0, 6);
  }, [members, selfUserId, mention]);

  useEffect(() => setHighlight(0), [mention?.query]);

  // The picker is only open while it has something to offer, so Enter falls
  // through to sending the moment the query stops matching anyone.
  const picking = !!mention && candidates.length > 0;

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };

  const sync = (el: HTMLTextAreaElement) => {
    setText(el.value);
    setMention(activeMentionQuery(el.value, el.selectionStart));
    grow(el);
  };

  const insert = useCallback(
    (m: SpaceMember) => {
      const el = areaRef.current;
      if (!el || !mention) return;
      const label = m.display_name || "Member";
      const before = text.slice(0, mention.at);
      const after = text.slice(el.selectionStart);
      const token = `@[${label}](${m.user_id}) `;
      const next = before + token + after;
      setText(next);
      setMention(null);
      requestAnimationFrame(() => {
        const caret = before.length + token.length;
        el.focus();
        el.setSelectionRange(caret, caret);
        grow(el);
      });
    },
    [mention, text],
  );

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setText("");
      setMention(null);
      if (areaRef.current) areaRef.current.style.height = "auto";
    } finally {
      setSending(false);
    }
  }, [text, sending, onSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (picking) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight(
          (h) =>
            (h + (e.key === "ArrowDown" ? 1 : candidates.length - 1)) %
            candidates.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insert(candidates[highlight]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // Enter sends, Shift+Enter breaks the line - the shape every chat box has.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="cmt-composer">
      {picking && (
        <div className="cmt-picker" role="listbox">
          {candidates.map((m, i) => (
            <button
              key={m.user_id}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className={`cmt-picker-row${i === highlight ? " cmt-picker-row--on" : ""}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(m);
              }}
            >
              <UserAvatar
                className="cmt-avatar cmt-avatar--sm"
                url={m.avatar_url}
                label={m.display_name || ""}
                glyphSize={9}
              />
              <span className="cmt-picker-name">
                {m.display_name || "Member"}
              </span>
              {m.online && <span className="cmt-online" aria-label="Online" />}
            </button>
          ))}
        </div>
      )}
      <div className="cmt-input-row">
        <textarea
          ref={areaRef}
          className="cmt-input"
          rows={1}
          value={text}
          placeholder="Write a comment, @ to tag someone"
          onChange={(e) => sync(e.currentTarget)}
          onKeyDown={onKeyDown}
          onClick={(e) => sync(e.currentTarget)}
        />
        <button
          className="cmt-send"
          onClick={() => void send()}
          disabled={!text.trim() || sending}
          aria-label="Post comment"
          data-tooltip="Post"
          data-tooltip-pos="top"
        >
          <PaperPlaneRight size={12} weight="fill" />
        </button>
      </div>
    </div>
  );
};

// ── Thread ────────────────────────────────────────────────────────────

const CommentThread: React.FC<{
  spaceId: string;
  clientId: string;
  entryType: "clipboard" | "note";
  members: SpaceMember[];
  selfUserId: string;
  /** Space owners moderate, so they may delete anyone's comment. */
  isOwner: boolean;
  /** Fires whenever the thread's length changes, so the feed's chip and the
   *  unread mark stay honest without a second request. */
  onCountChange?: (count: number) => void;
}> = ({
  spaceId,
  clientId,
  entryType,
  members,
  selfUserId,
  isOwner,
  onCountChange,
}) => {
  const [comments, setComments] = useState<SpaceComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = usePendingRemovals();

  const byId = useMemo(
    () => new Map(members.map((m) => [m.user_id, m])),
    [members],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    invoke<SpaceComment[]>("space_comments_list", {
      spaceId,
      clientId,
      entryType,
    })
      .then((rows) => {
        if (live) setComments(rows);
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [spaceId, clientId, entryType]);

  // Live updates. Both events reach every member of the space, so each one is
  // narrowed to this thread before it touches the list.
  useEffect(() => {
    const mine = (p: {
      space_id?: string;
      client_id?: string;
      entry_type?: string;
    }) =>
      p.space_id === spaceId &&
      p.client_id === clientId &&
      p.entry_type === entryType;

    const added = listen<SpaceComment>("space:comment-added", (e) => {
      if (!mine(e.payload)) return;
      setComments((prev) =>
        prev.some((c) => c.id === e.payload.id) ? prev : [...prev, e.payload],
      );
    });
    const removed = listen<{
      id: string;
      space_id?: string;
      client_id?: string;
      entry_type?: string;
    }>("space:comment-removed", (e) => {
      if (!mine(e.payload)) return;
      setComments((prev) => prev.filter((c) => c.id !== e.payload.id));
    });
    return () => {
      void added.then((un) => un());
      void removed.then((un) => un());
    };
  }, [spaceId, clientId, entryType]);

  // What is on screen, which is what the chip should say: a comment inside its
  // undo window is already gone as far as the reader is concerned.
  const shown = useMemo(
    () => comments.filter((c) => !pending.has(`comment:${c.id}`)),
    [comments, pending],
  );

  useEffect(() => {
    if (!loading) onCountChange?.(shown.length);
  }, [shown.length, loading, onCountChange]);

  const handleSend = useCallback(
    async (body: string) => {
      try {
        const posted = await invoke<SpaceComment>("space_comment_add", {
          spaceId,
          clientId,
          entryType,
          body,
        });
        // The server does not echo the event back to the device that wrote it.
        setComments((prev) =>
          prev.some((c) => c.id === posted.id) ? prev : [...prev, posted],
        );
      } catch (e) {
        toastError("Could not post the comment", e);
      }
    },
    [spaceId, clientId, entryType],
  );

  const handleDelete = useCallback(
    (comment: SpaceComment) => {
      deferDestructive(
        "Comment deleted",
        async () => {
          await invoke("space_comment_delete", {
            spaceId,
            commentId: comment.id,
          });
          setComments((prev) => prev.filter((c) => c.id !== comment.id));
        },
        {
          key: "space-comment-delete",
          hides: [`comment:${comment.id}`],
          errorPrefix: "Could not delete the comment",
        },
      );
    },
    [spaceId],
  );

  return (
    <section className="cmt-thread">
      <div className="cmt-head">
        <span className="cmt-head-title">Comments</span>
        {shown.length > 0 && <span className="cmt-head-n">{shown.length}</span>}
      </div>

      {error ? (
        <p className="cmt-note cmt-note--bad">{error}</p>
      ) : loading ? (
        <p className="cmt-note">Loading comments</p>
      ) : shown.length === 0 ? (
        <p className="cmt-note">No comments yet. Say something about this one.</p>
      ) : (
        <ul className="cmt-list">
          {shown.map((c) => {
            const author = byId.get(c.author_id);
            const name =
              c.author_id === selfUserId
                ? "You"
                : author?.display_name || "Member";
            return (
              <li
                key={c.id}
                className={`cmt-row${c.mentions.includes(selfUserId) ? " cmt-row--tagged" : ""}`}
              >
                <UserAvatar
                  className="cmt-avatar"
                  url={author?.avatar_url}
                  label={author?.display_name || ""}
                  glyphSize={10}
                />
                <div className="cmt-main">
                  <div className="cmt-meta">
                    <span className="cmt-author">{name}</span>
                    <span className="cmt-time">{timeAgo(c.created_at)}</span>
                    {(c.is_mine || isOwner) && (
                      <button
                        className="cmt-del"
                        onClick={() => handleDelete(c)}
                        aria-label="Delete comment"
                        data-tooltip={
                          c.is_mine ? "Delete" : "Delete as space owner"
                        }
                        data-tooltip-pos="left"
                      >
                        <Trash size={11} />
                      </button>
                    )}
                  </div>
                  <CommentBody body={c.body} selfUserId={selfUserId} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Composer members={members} selfUserId={selfUserId} onSend={handleSend} />
    </section>
  );
};

export default CommentThread;
