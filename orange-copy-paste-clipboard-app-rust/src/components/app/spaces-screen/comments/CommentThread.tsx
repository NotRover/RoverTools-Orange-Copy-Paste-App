import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PaperPlaneRight, X } from "@phosphor-icons/react";

import { TrashIcon } from "../../../icons";

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

/** How long one comment may be, counted in what the writer typed rather than
 *  in what gets stored - a mention costs a uuid on the wire that the writer
 *  never sees, and charging them for it would be arbitrary. */
const MAX_LEN = 500;

/** Comments are read a page at a time, newest last, the way a chat reads. */
const PAGE = 20;

/** Threads already read, kept for as long as the app runs.
 *
 *  Reopening a thread showed a spinner and then the same comments it showed a
 *  second ago. The cache is what the panel draws immediately; the request
 *  still goes out behind it, so a thread another device changed while this one
 *  had it closed corrects itself without anyone waiting. Live events keep
 *  entries current while a thread is shut, which is why this can be trusted
 *  enough to show first.
 *
 *  Plaintext, so it is memory only - nothing here reaches disk. */
const cache = new Map<string, SpaceComment[]>();

const cacheKey = (spaceId: string, entryType: string, clientId: string) =>
  `${spaceId}:${entryType}:${clientId}`;

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

/** A stretch of what was typed: either loose text, or one whole mention. */
type TypedSeg =
  | { kind: "text"; text: string; start: number; end: number }
  | {
      kind: "mention";
      label: string;
      userId: string;
      start: number;
      end: number;
    };

/** Find the mentions inside what was typed.
 *
 *  The box holds `@Ada Lovelace`; the wire holds `@[Ada Lovelace](uuid)`. Only
 *  names that were actually picked from the list count, so typing a name by
 *  hand stays plain text rather than silently tagging someone.
 *
 *  Longest label first, so tagging both "Sam" and "Sam Smith" does not turn the
 *  second into the first followed by a stray surname. */
function scanTyped(text: string, tagged: Map<string, string>): TypedSeg[] {
  const labels = [...tagged.keys()].sort((a, b) => b.length - a.length);
  const out: TypedSeg[] = [];
  let buf = "";
  let bufStart = 0;
  let i = 0;
  const flush = (at: number) => {
    if (buf) out.push({ kind: "text", text: buf, start: bufStart, end: at });
    buf = "";
  };
  while (i < text.length) {
    const boundary = i === 0 || /\s/.test(text[i - 1]);
    const hit =
      text[i] === "@" && boundary
        ? labels.find((l) => {
            if (!text.startsWith(l, i + 1)) return false;
            // "@Sam" must not match inside "@Sammy".
            const next = text[i + 1 + l.length];
            return !next || !/[\p{L}\p{N}]/u.test(next);
          })
        : undefined;
    if (hit) {
      flush(i);
      out.push({
        kind: "mention",
        label: hit,
        userId: tagged.get(hit) as string,
        start: i,
        end: i + 1 + hit.length,
      });
      i += 1 + hit.length;
      bufStart = i;
      continue;
    }
    if (!buf) bufStart = i;
    buf += text[i];
    i += 1;
  }
  flush(text.length);
  return out;
}

/** Turn what was typed into what gets stored. */
function encodeMentions(text: string, tagged: Map<string, string>): string {
  return scanTyped(text, tagged)
    .map((s) =>
      s.kind === "mention" ? `@[${s.label}](${s.userId})` : s.text,
    )
    .join("");
}

const Composer: React.FC<{
  members: SpaceMember[];
  selfUserId: string;
  onSend: (body: string) => Promise<void>;
}> = ({ members, selfUserId, onSend }) => {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Which typed names stand for which member. A ref rather than state: it
  // changes nothing on screen, and keeping it out of the deps stops every
  // keystroke from rebinding the send handler.
  const tagged = useRef(new Map<string, string>());
  const [mention, setMention] = useState<{ at: number; query: string } | null>(
    null,
  );
  const [highlight, setHighlight] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Draws the mention backgrounds behind the real text, which the textarea
  // itself cannot do. Kept in step with the box character for character.
  const mirrorRef = useRef<HTMLDivElement>(null);

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

  // What the highlight layer draws, and what the caret rules read.
  const segs = useMemo(() => scanTyped(text, tagged.current), [text]);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };

  const sync = (el: HTMLTextAreaElement) => {
    setText(el.value);
    setMention(activeMentionQuery(el.value, el.selectionStart));
    grow(el);
  };

  /** Put the caret somewhere after React has redrawn the value. */
  const caretTo = (pos: number) => {
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      grow(el);
    });
  };

  /** Cut a whole mention out, leaving the caret where it stood. */
  const dropSpan = (from: number, to: number, label: string) => {
    const next = text.slice(0, from) + text.slice(to);
    setText(next);
    setMention(null);
    // Once the last copy of a name is gone, so is the tag it stood for.
    if (!next.includes(`@${label}`)) tagged.current.delete(label);
    caretTo(from);
  };

  const insert = useCallback(
    (m: SpaceMember) => {
      const el = areaRef.current;
      if (!el || !mention) return;
      // The brackets are the storage format's delimiters, so a name carrying
      // one would produce a token that cannot be parsed back.
      const label = (m.display_name || "Member").replace(/[[\]()]/g, "").trim();
      if (!label) return;
      tagged.current.set(label, m.user_id);
      const before = text.slice(0, mention.at);
      const after = text.slice(el.selectionStart);
      const token = `@${label} `;
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
      await onSend(encodeMentions(body, tagged.current));
      setText("");
      setMention(null);
      tagged.current.clear();
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
      return;
    }

    // A mention is one thing, not the words it is spelled with: the caret
    // steps over it and a backspace takes all of it. Editing it halfway would
    // leave a name that no longer tags anyone but still looks like it does.
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd || e.shiftKey) return;
    const caret = el.selectionStart;
    const ends = segs.find((s) => s.kind === "mention" && s.end === caret);
    const begins = segs.find((s) => s.kind === "mention" && s.start === caret);

    if (e.key === "Backspace" && ends) {
      e.preventDefault();
      dropSpan(ends.start, ends.end, (ends as { label: string }).label);
    } else if (e.key === "Delete" && begins) {
      e.preventDefault();
      dropSpan(begins.start, begins.end, (begins as { label: string }).label);
    } else if (e.key === "ArrowLeft" && ends) {
      e.preventDefault();
      caretTo(ends.start);
    } else if (e.key === "ArrowRight" && begins) {
      e.preventDefault();
      caretTo(begins.end);
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
        <div className="cmt-input-wrap">
          <div className="cmt-mirror" ref={mirrorRef} aria-hidden="true">
            {segs.map((s, i) =>
              s.kind === "mention" ? (
                <span key={i} className="cmt-chip">
                  @{s.label}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
            {"\n"}
          </div>
          <textarea
            ref={areaRef}
            className="cmt-input"
            rows={1}
            value={text}
            maxLength={MAX_LEN}
            placeholder="Write a comment, @ to tag someone"
            onChange={(e) => sync(e.currentTarget)}
            onKeyDown={onKeyDown}
            onClick={(e) => sync(e.currentTarget)}
            onScroll={(e) => {
              if (mirrorRef.current)
                mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
          />
        </div>
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
      {/* Silent until the limit is close enough to matter - a counter sitting
          under an empty box only says the box is small. */}
      {text.length >= MAX_LEN - 80 && (
        <div
          className={`cmt-count${text.length >= MAX_LEN ? " cmt-count--full" : ""}`}
        >
          {MAX_LEN - text.length} left
        </div>
      )}
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
  /** Fires whenever the thread changes, so the feed's chip and the unread mark
   *  stay honest without a second request. `latestAt` is the newest comment
   *  drawn, which is exactly what the reader has now seen. */
  onCountChange?: (count: number, latestAt: number) => void;
  /** Present when the thread is floating rather than inline, which is the only
   *  case that owns a way to dismiss itself. */
  onClose?: () => void;
}> = ({
  spaceId,
  clientId,
  entryType,
  members,
  selfUserId,
  isOwner,
  onCountChange,
  onClose,
}) => {
  const key = cacheKey(spaceId, entryType, clientId);
  const [comments, setComments] = useState<SpaceComment[]>(
    () => cache.get(key) ?? [],
  );
  // Only the first read of a thread is a wait. After that the panel opens on
  // what it already has and refreshes underneath.
  const [loading, setLoading] = useState(!cache.has(key));
  const [error, setError] = useState<string | null>(null);
  // How many of the newest comments are on screen. Older ones are fetched
  // already - the thread arrives whole - so a page here is about how much a
  // reader is asked to take in at once, not about what the network carries.
  const [limit, setLimit] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pending = usePendingRemovals();

  const byId = useMemo(
    () => new Map(members.map((m) => [m.user_id, m])),
    [members],
  );

  // Whatever is on screen is what the next open should start from, including
  // comments that arrived over the socket while this thread was open.
  useEffect(() => {
    cache.set(key, comments);
  }, [key, comments]);

  useEffect(() => {
    let live = true;
    setLoading(!cache.has(key));
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
        // A failed refresh of a thread already on screen is not worth
        // replacing that thread with an error.
        if (live && !cache.has(key)) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [spaceId, clientId, entryType, key]);

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

  const latestAt = useMemo(
    () => shown.reduce((max, c) => Math.max(max, c.created_at), 0),
    [shown],
  );

  useEffect(() => {
    if (!loading) onCountChange?.(shown.length, latestAt);
  }, [shown.length, latestAt, loading, onCountChange]);

  // The newest comments, the way a chat shows them.
  const page = useMemo(
    () => shown.slice(Math.max(0, shown.length - limit)),
    [shown, limit],
  );
  const older = shown.length - page.length;

  // Sit at the bottom when the thread opens and whenever something new lands.
  // Keyed on the last id rather than on the count, so revealing older comments
  // leaves the reader where they were instead of yanking them back down.
  const lastId = page.length ? page[page.length - 1].id : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, loading]);

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
        {onClose && (
          <button className="cmt-close" onClick={onClose} aria-label="Close">
            <X size={11} weight="bold" />
          </button>
        )}
      </div>

      {error ? (
        <p className="cmt-note cmt-note--bad">{error}</p>
      ) : loading ? (
        <p className="cmt-note">Loading comments</p>
      ) : shown.length === 0 ? (
        <p className="cmt-note">No comments yet. Say something about this one.</p>
      ) : (
        <div className="cmt-scroll" ref={scrollRef}>
          {older > 0 && (
            <button
              className="cmt-more"
              onClick={() => setLimit((n) => n + PAGE)}
            >
              Show {Math.min(older, PAGE)} older
            </button>
          )}
          <ul className="cmt-list">
            {page.map((c) => {
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
                        <TrashIcon size={13} />
                      </button>
                    )}
                  </div>
                  <CommentBody body={c.body} selfUserId={selfUserId} />
                </div>
              </li>
            );
            })}
          </ul>
        </div>
      )}

      <Composer members={members} selfUserId={selfUserId} onSend={handleSend} />
    </section>
  );
};

export default CommentThread;
