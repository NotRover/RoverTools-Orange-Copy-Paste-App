import React from "react";
import type { ClipboardEntry, Note } from "../../../../types";
import { groupColor } from "../../../../types";
import { CheckIcon, PinIcon, TrashIcon } from "../../../icons";
import { deriveNoteTitle } from "../notes-utils";
import { useRelativeTime } from "../../../../hooks/useRelativeTime";
import NotePreview from "../NotePreview";
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
          <span
            className={`ns-card-time${note.pinned ? " ns-card-time--pinned" : ""}`}
          >
            {note.pinned && <PinIcon size={8} />}
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
