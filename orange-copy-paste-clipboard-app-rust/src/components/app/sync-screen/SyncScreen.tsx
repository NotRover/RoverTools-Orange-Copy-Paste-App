import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ClipboardEntry,
  Note,
  SyncGroup,
  SharingSession,
} from "../../../types";
import {
  groupColor,
  timeAgo,
  truncateText,
  htmlPlainText,
  filePaths,
  fileNameFromPath,
  isImageFile,
} from "../../../types";
import {
  PlusIcon,
  KeyIcon,
  UsersIcon,
  ShareIcon,
  CloseIcon,
  CheckIcon,
  LogOutIcon,
  CopyIcon,
  OnlineDotIcon,
  ClipboardIcon,
  NotesIcon,
  ImageIcon,
  FileIcon,
  TextLinesIcon,
  HtmlCodeIcon,
  SearchXIcon,
} from "../../icons";
import "./SyncScreen.css";

// ── Types ─────────────────────────────────────────────────────────────

type FeedFilter = "all" | "clipboard" | "notes";

type SelectedGroup =
  | { kind: "local"; name: string }
  | { kind: "sync"; group: SyncGroup }
  | { kind: "share"; session: SharingSession };

interface FeedEntry {
  kind: "clipboard";
  entry: ClipboardEntry;
}

interface FeedNote {
  kind: "note";
  note: Note;
}

type FeedItem = FeedEntry | FeedNote;

// ── Props ─────────────────────────────────────────────────────────────

interface SyncScreenProps {
  entries: ClipboardEntry[];
  notes: Note[];
  availableGroups: string[];
  syncConnected: boolean | null;
  onCopyEntry: (id: string) => void;
}

// ── Feed item card ────────────────────────────────────────────────────

interface FeedCardProps {
  item: FeedItem;
  onCopy: (id: string) => void;
}

const FeedCard: React.FC<FeedCardProps> = ({ item, onCopy }) => {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    if (item.kind === "clipboard") {
      onCopy(item.entry.id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }
  }, [item, onCopy]);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  if (item.kind === "note") {
    const { note } = item;
    const preview = note.title || "(Untitled note)";
    return (
      <div className="sync-feed-card sync-feed-card--note">
        <div className="sync-feed-card-header">
          <span className="sync-feed-author">You</span>
          <span className="sync-feed-type-badge sync-feed-type-badge--note">
            <NotesIcon size={9} />
            Note
          </span>
          <span className="sync-feed-time">{timeAgo(note.updated_at)}</span>
        </div>
        <div className="sync-feed-card-body">
          <span className="sync-feed-card-title">{preview}</span>
        </div>
      </div>
    );
  }

  const { entry } = item;
  let preview = "";
  let typeLabel = "Text";
  let TypeIcon = <TextLinesIcon size={9} />;

  if (entry.type === "text") {
    preview = truncateText(entry.content, 140);
    typeLabel = "Text";
    TypeIcon = <TextLinesIcon size={9} />;
  } else if (entry.type === "html") {
    preview = truncateText(htmlPlainText(entry.content) || entry.content, 140);
    typeLabel = "Rich";
    TypeIcon = <HtmlCodeIcon size={9} />;
  } else if (entry.type === "image") {
    preview = entry.label ?? "Image";
    typeLabel = "Image";
    TypeIcon = <ImageIcon size={9} />;
  } else if (entry.type === "file") {
    const paths = filePaths(entry.content);
    preview = paths.map(fileNameFromPath).join(", ");
    typeLabel = paths.length > 1 ? `${paths.length} Files` : isImageFile(paths[0] ?? "") ? "Image" : "File";
    TypeIcon = isImageFile(paths[0] ?? "") ? <ImageIcon size={9} /> : <FileIcon size={9} />;
  }

  return (
    <div className="sync-feed-card">
      <div className="sync-feed-card-header">
        <span className="sync-feed-author">You</span>
        <span className="sync-feed-type-badge">
          {TypeIcon}
          {typeLabel}
        </span>
        <span className="sync-feed-time">{timeAgo(entry.timestamp)}</span>
        <button
          className={`sync-feed-copy-btn ${copied ? "sync-feed-copy-btn--done" : ""}`}
          onClick={handleCopy}
          title="Copy to clipboard"
        >
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="sync-feed-card-body">
        <span className="sync-feed-card-text">{preview}</span>
      </div>
    </div>
  );
};

// ── Day-grouped feed ──────────────────────────────────────────────────

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Inline form (create / join) ───────────────────────────────────────

interface InlineFormProps {
  mode: "create" | "join";
  onSubmit: (value: string) => void;
  onCancel: () => void;
  loading: boolean;
}

const InlineForm: React.FC<InlineFormProps> = ({ mode, onSubmit, onCancel, loading }) => {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="sync-inline-form">
      <input
        ref={inputRef}
        className="sync-inline-input"
        placeholder={mode === "create" ? "Group name…" : "Invite code…"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="sync-inline-form-actions">
        <button
          className="sync-inline-btn sync-inline-btn--primary"
          disabled={!value.trim() || loading}
          onClick={() => value.trim() && onSubmit(value.trim())}
        >
          {loading ? "…" : mode === "create" ? "Create" : "Join"}
        </button>
        <button className="sync-inline-btn" onClick={onCancel}>
          <CloseIcon size={10} />
        </button>
      </div>
    </div>
  );
};

// ── Main screen ───────────────────────────────────────────────────────

const SyncScreen: React.FC<SyncScreenProps> = ({
  entries,
  notes,
  availableGroups,
  syncConnected,
  onCopyEntry,
}) => {
  const [syncGroups, setSyncGroups] = useState<SyncGroup[]>([]);
  const [sessions, setSessions] = useState<SharingSession[]>([]);
  const [selected, setSelected] = useState<SelectedGroup | null>(null);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [inviteCopied, setInviteCopied] = useState<string | null>(null);
  const inviteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load sync data when connected
  useEffect(() => {
    invoke<SyncGroup[]>("sync_get_groups").then(setSyncGroups).catch(() => setSyncGroups([]));
    invoke<SharingSession[]>("sharing_get_sessions").then(setSessions).catch(() => setSessions([]));
  }, [syncConnected]);

  // Build the feed items for the selected group
  const feedItems = React.useMemo((): FeedItem[] => {
    if (!selected) return [];

    const groupName =
      selected.kind === "local"
        ? selected.name
        : selected.kind === "sync"
          ? selected.group.id
          : selected.session.share_group_id;

    const items: FeedItem[] = [];

    if (filter !== "notes") {
      for (const entry of entries) {
        const inGroup =
          selected.kind === "local"
            ? entry.groups.includes(selected.name)
            : entry.groups.includes(groupName);
        if (inGroup) items.push({ kind: "clipboard", entry });
      }
    }

    if (filter !== "clipboard") {
      for (const note of notes) {
        const inGroup =
          selected.kind === "local"
            ? note.groups.includes(selected.name)
            : note.groups.includes(groupName);
        if (inGroup) items.push({ kind: "note", note });
      }
    }

    // Sort newest first
    items.sort((a, b) => {
      const ta = a.kind === "clipboard" ? a.entry.timestamp : a.note.updated_at;
      const tb = b.kind === "clipboard" ? b.entry.timestamp : b.note.updated_at;
      return tb - ta;
    });

    return items;
  }, [selected, filter, entries, notes]);

  // Group feed items by day
  const feedByDay = React.useMemo(() => {
    const days: { label: string; items: FeedItem[] }[] = [];
    let current: { label: string; items: FeedItem[] } | null = null;

    for (const item of feedItems) {
      const ts = item.kind === "clipboard" ? item.entry.timestamp : item.note.updated_at;
      const label = dayLabel(ts);
      if (!current || current.label !== label) {
        current = { label, items: [] };
        days.push(current);
      }
      current.items.push(item);
    }

    return days;
  }, [feedItems]);

  const handleCreate = useCallback(async (name: string) => {
    setFormLoading(true);
    try {
      const group = await invoke<SyncGroup>("sync_create_group", { name });
      setSyncGroups((prev) => [...prev, group]);
      setSelected({ kind: "sync", group });
      setShowCreate(false);
    } catch {
      // no-op if backend not available
    } finally {
      setFormLoading(false);
    }
  }, []);

  const handleJoin = useCallback(async (inviteCode: string) => {
    setFormLoading(true);
    try {
      await invoke("sync_join_group", { inviteCode });
      const groups = await invoke<SyncGroup[]>("sync_get_groups");
      setSyncGroups(groups);
      setShowJoin(false);
    } catch {
      // no-op if backend not available
    } finally {
      setFormLoading(false);
    }
  }, []);

  const handleLeaveGroup = useCallback(async (groupId: string) => {
    try {
      await invoke("sync_leave_group", { groupId });
      setSyncGroups((prev) => prev.filter((g) => g.id !== groupId));
      if (selected?.kind === "sync" && selected.group.id === groupId) {
        setSelected(null);
      }
    } catch {
      // no-op
    }
  }, [selected]);

  const handleLeaveSession = useCallback(async (shareGroupId: string) => {
    try {
      await invoke("sharing_leave_session", { shareGroupId });
      setSessions((prev) => prev.filter((s) => s.share_group_id !== shareGroupId));
      if (selected?.kind === "share" && selected.session.share_group_id === shareGroupId) {
        setSelected(null);
      }
    } catch {
      // no-op
    }
  }, [selected]);

  const handleCopyInvite = useCallback((code: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
    if (inviteTimer.current) clearTimeout(inviteTimer.current);
    setInviteCopied(code);
    inviteTimer.current = setTimeout(() => setInviteCopied(null), 2000);
  }, []);

  useEffect(() => () => { if (inviteTimer.current) clearTimeout(inviteTimer.current); }, []);

  // ── Selected group header info ─────────────────────────────────────

  const selectedLabel =
    selected?.kind === "local"
      ? selected.name
      : selected?.kind === "sync"
        ? selected.group.name
        : selected?.session.name ?? "";

  const selectedMemberInfo =
    selected?.kind === "sync"
      ? `${selected.group.member_count} member${selected.group.member_count === 1 ? "" : "s"}`
      : selected?.kind === "share"
        ? `${selected.session.members.length} member${selected.session.members.length === 1 ? "" : "s"}`
        : null;

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="sync-screen">
      {/* ── Left panel ── */}
      <aside className="sync-panel-left">
        <div className="sync-panel-left-inner">

          {/* Local groups */}
          {availableGroups.length > 0 && (
            <section className="sync-group-section">
              <div className="sync-section-label">Local Groups</div>
              {availableGroups.map((name) => {
                const c = groupColor(name);
                const isActive = selected?.kind === "local" && selected.name === name;
                const count = entries.filter((e) => e.groups.includes(name)).length +
                              notes.filter((n) => n.groups.includes(name)).length;
                return (
                  <button
                    key={name}
                    className={`sync-group-item ${isActive ? "active" : ""}`}
                    onClick={() => setSelected({ kind: "local", name })}
                  >
                    <span
                      className="sync-group-color-dot"
                      style={{ background: c.fg }}
                    />
                    <span className="sync-group-item-name">{name}</span>
                    {count > 0 && (
                      <span className="sync-group-count">{count}</span>
                    )}
                  </button>
                );
              })}
            </section>
          )}

          {/* Sync groups */}
          <section className="sync-group-section">
            <div className="sync-section-label">
              <span>Sync Groups</span>
              {syncConnected === true && (
                <span className="sync-section-connected-dot" />
              )}
            </div>
            {syncGroups.length === 0 ? (
              <div className="sync-group-empty-hint">
                {syncConnected === null
                  ? "Sign in to see shared groups"
                  : syncConnected === false
                    ? "Offline — reconnecting…"
                    : "No groups yet. Create one to start syncing."}
              </div>
            ) : (
              syncGroups.map((group) => {
                const isActive = selected?.kind === "sync" && selected.group.id === group.id;
                return (
                  <button
                    key={group.id}
                    className={`sync-group-item ${isActive ? "active" : ""}`}
                    onClick={() => setSelected({ kind: "sync", group })}
                  >
                    <UsersIcon size={11} className="sync-group-icon" />
                    <span className="sync-group-item-name">{group.name}</span>
                    <span className="sync-group-count">{group.member_count}</span>
                  </button>
                );
              })
            )}
          </section>

          {/* Live Share sessions */}
          {sessions.length > 0 && (
            <section className="sync-group-section">
              <div className="sync-section-label">Live Share</div>
              {sessions.map((session) => {
                const isActive =
                  selected?.kind === "share" &&
                  selected.session.share_group_id === session.share_group_id;
                const anyOnline = session.members.some((m) => m.online);
                return (
                  <button
                    key={session.share_group_id}
                    className={`sync-group-item ${isActive ? "active" : ""}`}
                    onClick={() => setSelected({ kind: "share", session })}
                  >
                    <OnlineDotIcon online={anyOnline} size={7} />
                    <span className="sync-group-item-name">{session.name}</span>
                    <span className="sync-group-count">{session.members.length}</span>
                  </button>
                );
              })}
            </section>
          )}
        </div>

        {/* Bottom actions */}
        <div className="sync-panel-actions">
          {showCreate && (
            <InlineForm
              mode="create"
              onSubmit={handleCreate}
              onCancel={() => setShowCreate(false)}
              loading={formLoading}
            />
          )}
          {showJoin && (
            <InlineForm
              mode="join"
              onSubmit={handleJoin}
              onCancel={() => setShowJoin(false)}
              loading={formLoading}
            />
          )}
          {!showCreate && !showJoin && (
            <div className="sync-panel-btns">
              <button
                className="sync-action-btn"
                onClick={() => { setShowCreate(true); setShowJoin(false); }}
                data-tooltip="Create a new sync group"
                data-tooltip-pos="top"
              >
                <PlusIcon size={11} />
                Create
              </button>
              <button
                className="sync-action-btn"
                onClick={() => { setShowJoin(true); setShowCreate(false); }}
                data-tooltip="Join via invite code"
                data-tooltip-pos="top"
              >
                <KeyIcon size={11} />
                Join
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ── Right feed panel ── */}
      <div className="sync-feed-panel">
        {selected ? (
          <>
            {/* Feed header */}
            <div className="sync-feed-header">
              <div className="sync-feed-header-left">
                <span className="sync-feed-group-name">{selectedLabel}</span>
                {selectedMemberInfo && (
                  <span className="sync-feed-member-count">
                    <UsersIcon size={10} />
                    {selectedMemberInfo}
                  </span>
                )}
              </div>
              <div className="sync-feed-header-right">
                {/* Invite link for sync groups */}
                {selected.kind === "sync" && selected.group.invite_code && (
                  <button
                    className={`sync-feed-action-btn ${inviteCopied === selected.group.invite_code ? "sync-feed-action-btn--done" : ""}`}
                    onClick={() => handleCopyInvite(selected.group.invite_code!)}
                  >
                    {inviteCopied === selected.group.invite_code
                      ? <><CheckIcon size={11} /> Copied!</>
                      : <><ShareIcon size={11} /> Copy Invite</>
                    }
                  </button>
                )}
                {/* Leave / end for sync groups */}
                {selected.kind === "sync" && (
                  <button
                    className="sync-feed-action-btn sync-feed-action-btn--danger"
                    onClick={() => handleLeaveGroup(selected.group.id)}
                    data-tooltip="Leave this group"
                    data-tooltip-pos="top"
                  >
                    <LogOutIcon size={11} />
                    Leave
                  </button>
                )}
                {/* Leave / end for live share sessions */}
                {selected.kind === "share" && (
                  <button
                    className="sync-feed-action-btn sync-feed-action-btn--danger"
                    onClick={() => handleLeaveSession(selected.session.share_group_id)}
                    data-tooltip={selected.session.is_owner ? "End session" : "Leave session"}
                    data-tooltip-pos="top"
                  >
                    <LogOutIcon size={11} />
                    {selected.session.is_owner ? "End" : "Leave"}
                  </button>
                )}
              </div>
            </div>

            {/* Members row for Live Share */}
            {selected.kind === "share" && selected.session.members.length > 0 && (
              <div className="sync-members-bar">
                {selected.session.members.map((member) => (
                  <div key={member.user_id} className="sync-member-chip">
                    <OnlineDotIcon online={member.online} size={6} />
                    <span>{member.display_name}</span>
                    <span className="sync-member-scope">{member.scope}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Filter tabs */}
            <div className="sync-feed-tabs">
              <button
                className={`sync-tab ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                All
              </button>
              <button
                className={`sync-tab ${filter === "clipboard" ? "active" : ""}`}
                onClick={() => setFilter("clipboard")}
              >
                <ClipboardIcon size={11} />
                Clipboard
              </button>
              <button
                className={`sync-tab ${filter === "notes" ? "active" : ""}`}
                onClick={() => setFilter("notes")}
              >
                <NotesIcon size={11} />
                Notes
              </button>
              <span className="sync-feed-count">
                {feedItems.length} item{feedItems.length === 1 ? "" : "s"}
              </span>
            </div>

            {/* Feed */}
            <div className="sync-feed-scroll">
              {feedItems.length === 0 ? (
                <div className="sync-feed-empty">
                  <SearchXIcon size={36} />
                  <span className="sync-feed-empty-title">Nothing here yet</span>
                  <span className="sync-feed-empty-sub">
                    {filter !== "all"
                      ? `No ${filter} items in this group`
                      : selected.kind === "local"
                        ? `Tag items as "${selectedLabel}" to see them here`
                        : "Items shared to this group will appear here"}
                  </span>
                </div>
              ) : (
                feedByDay.map(({ label, items }) => (
                  <div key={label} className="sync-feed-day-group">
                    <div className="sync-feed-day-label">{label}</div>
                    {items.map((item) => (
                      <FeedCard
                        key={item.kind === "clipboard" ? item.entry.id : item.note.id}
                        item={item}
                        onCopy={onCopyEntry}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          /* No group selected */
          <div className="sync-no-selection">
            <div className="sync-no-selection-inner">
              {availableGroups.length === 0 && syncGroups.length === 0 ? (
                <>
                  <UsersIcon size={38} strokeWidth={1.4} />
                  <span className="sync-no-selection-title">No groups yet</span>
                  <span className="sync-no-selection-sub">
                    Create a group to organize and sync your clipboard entries and notes across devices.
                  </span>
                </>
              ) : (
                <>
                  <ClipboardIcon size={32} strokeWidth={1.4} />
                  <span className="sync-no-selection-title">Select a group</span>
                  <span className="sync-no-selection-sub">
                    Pick a group from the left panel to view its shared content.
                  </span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SyncScreen;
