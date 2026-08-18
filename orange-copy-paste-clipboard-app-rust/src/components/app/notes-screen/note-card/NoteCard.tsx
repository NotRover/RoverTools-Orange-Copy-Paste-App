import React from "react";
import type { ClipboardEntry, Note } from "../../../../types";
import { groupColor } from "../../../../types";
import { CheckIcon, PinIcon, TrashIcon } from "../../../icons";
import type { EntrySyncState } from "../../../../hooks/useEntrySyncStates";
import type { EntryOwner } from "../../../../hooks/useEntryOwners";
import OwnerChip from "../../clipboard-screen/entry-card/OwnerChip";
import { deriveNoteTitle } from "../notes-utils";
import { useRelativeTime } from "../../../../hooks/useRelativeTime";
import NotePreview from "../NotePreview";
import { CloudArrowUp, CloudCheck, ShareNetwork } from "@phosphor-icons/react";
import "./note-card.css";

interface NoteCardProps {
  note: Note;
  entries: ClipboardEntry[];
  isSelecting: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  /** Cloud state for this note. Undefined hides the badge, which is also what
   *  the badge preference does when it is switched off. */
  syncState?: EntrySyncState;
  /** Spaces this note is shared into, for the share chip. */
  sharedSpaceNames?: string[];
  /** Set only when the note arrived from another member of a space. */
  owner?: EntryOwner;
}

const NoteCardImpl: React.FC<NoteCardProps> = ({
  note,
  entries,
  isSelecting,
  isSelected,
  isExpanded,
  onToggleSelect,
  onOpen,
  onDelete,
  onContextMenu,
  syncState,
  sharedSpaceNames = [],
  owner,
}) => {
  const content = note.content ?? "";
  const relTime = useRelativeTime(note.updated_at);

  return (
    <div
      className={[
        "ns-card",
        isSelecting && "ns-card--selectable",
        isSelected && "ns-card--selected",
      ]
        .filter(Boolean)
        .join(" ")}
      onContextMenu={(e) => {
        if (isSelecting) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(note.id, e.clientX, e.clientY);
      }}
      onClick={(e) => {
        if (isSelecting) {
          onToggleSelect(note.id, e.shiftKey);
          return;
        }
        onOpen(note.id);
      }}
    >
      {isSelecting && (
        <span className="ns-card-checkbox">
          <CheckIcon size={10} strokeWidth={3} />
        </span>
      )}
      <div className="ns-card-body">
        <div className="ns-card-title">
          {deriveNoteTitle(note.title, note.content)}
        </div>
        {note.content && (
          <div
            className={[
              "ns-card-preview",
              isExpanded && "ns-card-preview--expanded",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <NotePreview content={content} entries={entries} />
          </div>
        )}
        <div className="ns-card-footer">
          <div className="ns-card-chips">
            {note.pinned && (
              <span className="ns-chip ns-chip--pinned">
                <PinIcon size={9} />
                <span className="ns-chip-label">Pinned</span>
              </span>
            )}
            {owner && <OwnerChip owner={owner} />}
            {note.groups.map((g) => {
              const c = groupColor(g);
              return (
                <span
                  key={g}
                  className="ns-chip"
                  style={{ background: c.bg, color: c.fg }}
                >
                  <span className="ns-chip-dot" />
                  <span className="ns-chip-label">{g}</span>
                </span>
              );
            })}
          </div>
          {/* Where this note went, sat next to the time exactly as on a
              clipboard card: cloud for your own devices, share for other
              people. */}
          {sharedSpaceNames.length > 0 && (
            <span
              className="ns-card-sync ns-card-sync--shared"
              data-tooltip={`Shared to ${sharedSpaceNames.join(", ")}`}
            >
              <ShareNetwork size={15} />
              {sharedSpaceNames.length > 1 && (
                <span className="ns-card-sync-count">
                  {sharedSpaceNames.length}
                </span>
              )}
            </span>
          )}
          {syncState && (
            <span
              className={`ns-card-sync ns-card-sync--${syncState}`}
              data-tooltip={syncState === "synced" ? "Synced" : "Sync pending"}
            >
              {syncState === "synced" ? (
                <CloudCheck size={15} />
              ) : (
                <CloudArrowUp size={15} />
              )}
            </span>
          )}
          <span className="ns-card-time ns-card-time--pinned">
            {note.pinned && <PinIcon size={9} filled />}
            {relTime}
          </span>
        </div>
      </div>
      <button
        className="ns-card-delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(note.id);
        }}
        data-tooltip="Delete"
        data-tooltip-pos="left"
      >
        <TrashIcon size={10} />
      </button>
    </div>
  );
};

// Memoised so a single note edit / select toggle doesn't re-render (and
// re-walk the Tiptap preview tree of) every other card in the list. Parent
// callbacks are id-based and useCallback-stable, so shallow comparison holds.
const NoteCard = React.memo(NoteCardImpl);
NoteCard.displayName = "NoteCard";

export default NoteCard;
