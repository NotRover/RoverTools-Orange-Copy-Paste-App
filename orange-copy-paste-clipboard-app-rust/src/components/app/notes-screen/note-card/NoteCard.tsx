import React from "react";
import type { Note } from "../../../../types";
import { groupColor, timeAgo } from "../../../../types";
import { CheckIcon, PinIcon, TrashIcon } from "../../../icons";
import { deriveNoteTitle, sanitizeNotePreviewHtml } from "../notes-utils";
import "./note-card.css";

interface NoteCardProps {
  note: Note;
  entries: any[];
  isSelecting: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: (shiftKey: boolean) => void;
  onOpen: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const NoteCard: React.FC<NoteCardProps> = ({
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
  return (
    <div
      className={[
        "ns-card",
        isSelecting && "ns-card--selectable",
        isSelected && "ns-card--selected",
      ]
        .filter(Boolean)
        .join(" ")}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        if (isSelecting) {
          onToggleSelect(e.shiftKey);
          return;
        }
        onOpen();
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
              "ns-card-preview--rich",
              isExpanded && "ns-card-preview--expanded",
            ]
              .filter(Boolean)
              .join(" ")}
            dangerouslySetInnerHTML={{
              __html: sanitizeNotePreviewHtml(note.content, entries),
            }}
          />
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
            {timeAgo(note.updated_at)}
          </span>
        </div>
      </div>
      <button
        className="ns-card-delete"
        onClick={onDelete}
        data-tooltip="Delete"
        data-tooltip-pos="left"
      >
        <TrashIcon size={10} />
      </button>
    </div>
  );
};

export default NoteCard;
