import React, { useEffect, useRef, useState } from "react";
import { PinIcon } from "../../../entry-types/EntryTypePill";
import {
  GROUP_COLORS,
  groupColor,
  groupColorIndex,
  setGroupColorIndex,
} from "../../../../types";
import "./GroupManagerCard.css";

// Tag icon (small label/tag)
const TagIcon = (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
);

// Persist icon (small floppy/save)
const PersistIcon = (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

const SYSTEM_GROUPS = ["pinned", "persistent"];
const MIN_GROUP_LENGTH = 4;
const MAX_GROUP_LENGTH = 14;

interface GroupManagerCardProps {
  groups: string[];
  onAddGroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onClose: () => void;
}

const GroupManagerCard: React.FC<GroupManagerCardProps> = ({
  groups,
  onAddGroup,
  onDeleteGroup,
  onRenameGroup,
  onClose,
}) => {
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const groupListRef = useRef<HTMLDivElement>(null);
  const prevGroupCountRef = useRef(groups.length);

  const isRenaming = selectedGroup !== null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const prevCount = prevGroupCountRef.current;
    const nextCount = groups.length;
    prevGroupCountRef.current = nextCount;

    if (nextCount <= prevCount) return;

    const listEl = groupListRef.current;
    if (!listEl) return;

    requestAnimationFrame(() => {
      listEl.scrollTop = listEl.scrollHeight;
    });
  }, [groups]);

  // Deselect if selected group was removed externally
  useEffect(() => {
    if (selectedGroup && !groups.includes(selectedGroup)) {
      setSelectedGroup(null);
      setInputValue("");
      setError("");
    }
  }, [groups, selectedGroup]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const validate = (
    trimmed: string,
    excludeFromDuplicateCheck?: string,
  ): string | null => {
    const trimmedLower = trimmed.toLowerCase();
    if (!trimmed) return isRenaming ? "Name required" : null;
    if (trimmed.includes(" ")) return "One word only";
    if (trimmed.length < MIN_GROUP_LENGTH)
      return `Min ${MIN_GROUP_LENGTH} characters`;
    if (trimmed.length > MAX_GROUP_LENGTH)
      return `Max ${MAX_GROUP_LENGTH} characters`;
    if (SYSTEM_GROUPS.includes(trimmedLower)) return "Reserved name";
    if (
      groups.some(
        (g) =>
          g !== excludeFromDuplicateCheck && g.toLowerCase() === trimmedLower,
      )
    )
      return "Already exists";
    return null;
  };

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed && !isRenaming) return;

    if (isRenaming && selectedGroup) {
      // Same name — no-op
      if (trimmed === selectedGroup) return;
      const err = validate(trimmed, selectedGroup);
      if (err) {
        setError(err);
        return;
      }
      onRenameGroup(selectedGroup, trimmed);
      setSelectedGroup(trimmed);
      setInputValue(trimmed);
      setError("");
    } else {
      const err = validate(trimmed);
      if (err) {
        setError(err);
        return;
      }
      onAddGroup(trimmed);
      setInputValue("");
      setError("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      if (isRenaming) {
        setSelectedGroup(null);
        setInputValue("");
        setError("");
      } else {
        onClose();
      }
    }
  };

  const handleSelectGroup = (name: string) => {
    if (selectedGroup === name) {
      setSelectedGroup(null);
      setInputValue("");
      setError("");
    } else {
      setSelectedGroup(name);
      setInputValue(name);
      setError("");
    }
    setConfirmDelete(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const selectedGc = selectedGroup ? groupColor(selectedGroup) : null;
  const selectedColorIdx = selectedGroup ? groupColorIndex(selectedGroup) : -1;

  return (
    <div className="gm-card" ref={cardRef}>
      <div className="gm-header">
        {TagIcon}
        <span className="gm-title">Manage Groups</span>
        <span className="gm-count">{groups.length}</span>
      </div>

      {/* Group list */}
      <div
        className="gm-group-list"
        ref={groupListRef}
        onClick={(e) => {
          // Deselect when clicking the empty background of the list
          if (
            e.target === e.currentTarget ||
            (e.target as HTMLElement).classList.contains("gm-chip-list")
          ) {
            setSelectedGroup(null);
            setInputValue("");
            setError("");
            setConfirmDelete(null);
          }
        }}
      >
        {/* System group: Pinned */}
        <div className="gm-group-row gm-group-row--system">
          <span className="gm-group-icon gm-group-icon--pinned">{PinIcon}</span>
          <span className="gm-row-name">Pinned</span>
          <span className="gm-group-badge">System</span>
        </div>

        {/* System group: Persistent */}
        <div className="gm-group-row gm-group-row--system">
          <span className="gm-group-icon gm-group-icon--persistent">
            {PersistIcon}
          </span>
          <span className="gm-row-name">Persistent</span>
          <span className="gm-group-badge">System</span>
        </div>

        {/* User groups as chips */}
        {groups.length > 0 && (
          <div className="gm-chip-list">
            {groups.map((group) => {
              const gc = groupColor(group);
              const isSelected = selectedGroup === group;
              return (
                <button
                  key={group}
                  className={`gm-chip${isSelected ? " gm-chip--selected" : ""}`}
                  style={{
                    background: isSelected ? gc.bg : undefined,
                    color: gc.fg,
                  }}
                  onClick={() => handleSelectGroup(group)}
                >
                  <span className="gm-chip-dot" style={{ background: gc.fg }} />
                  <span className="gm-chip-name">{group}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail panel for selected group (color picker + delete only) */}
      {selectedGroup && selectedGc && (
        <>
          <div className="gm-divider" />
          <div className="gm-detail-panel">
            {confirmDelete === selectedGroup ? (
              <div className="gm-confirm-row">
                <span className="gm-confirm-text">
                  Delete "{selectedGroup}"?
                </span>
                <button
                  className="gm-confirm-yes"
                  onClick={() => {
                    onDeleteGroup(selectedGroup);
                    setSelectedGroup(null);
                    setInputValue("");
                    setError("");
                    setConfirmDelete(null);
                  }}
                >
                  Yes
                </button>
                <button
                  className="gm-confirm-no"
                  onClick={() => setConfirmDelete(null)}
                >
                  No
                </button>
              </div>
            ) : (
              <div className="gm-detail-row">
                <span
                  className="gm-detail-dot"
                  style={{ background: selectedGc.fg }}
                />
                <span className="gm-detail-label">{selectedGroup}</span>
                <button
                  className="gm-detail-delete"
                  onClick={() => setConfirmDelete(selectedGroup)}
                  title="Delete group"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}

            {/* Color picker */}
            <div className="gm-detail-colors">
              {GROUP_COLORS.map((c, i) => (
                <button
                  key={i}
                  className={`gm-color-swatch${i === selectedColorIdx ? " gm-color-swatch--active" : ""}`}
                  style={{ background: c.fg }}
                  onClick={() => {
                    setGroupColorIndex(selectedGroup, i);
                    // Force re-render by deselecting/reselecting
                    setSelectedGroup(null);
                    requestAnimationFrame(() =>
                      setSelectedGroup(selectedGroup),
                    );
                  }}
                />
              ))}
            </div>
          </div>
        </>
      )}

      <div className="gm-divider" />

      {/* Unified input: Add or Rename */}
      <div className="gm-add-row">
        <input
          ref={inputRef}
          type="text"
          className={`gm-add-input${error ? " gm-add-input--error" : ""}`}
          placeholder={isRenaming ? "Rename group…" : "New group name…"}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={handleKeyDown}
          maxLength={MAX_GROUP_LENGTH}
        />
        <button
          className="gm-add-btn"
          onClick={handleSubmit}
          disabled={!inputValue.trim()}
        >
          {isRenaming ? "Save" : "Add"}
        </button>
      </div>
      {error && <span className="gm-error">{error}</span>}
    </div>
  );
};

export default GroupManagerCard;
