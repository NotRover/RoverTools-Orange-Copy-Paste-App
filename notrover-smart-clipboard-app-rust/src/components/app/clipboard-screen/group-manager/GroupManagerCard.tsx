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
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const groupListRef = useRef<HTMLDivElement>(null);
  const prevGroupCountRef = useRef(groups.length);

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

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    const trimmedLower = trimmed.toLowerCase();
    if (!trimmed) return;

    // Validate: single word, 4–14 chars, no duplicates
    if (trimmed.includes(" ")) {
      setError("One word only");
      return;
    }
    if (trimmed.length < MIN_GROUP_LENGTH) {
      setError(`Min ${MIN_GROUP_LENGTH} characters`);
      return;
    }
    if (trimmed.length > MAX_GROUP_LENGTH) {
      setError(`Max ${MAX_GROUP_LENGTH} characters`);
      return;
    }
    if (trimmedLower === "pinned") {
      setError("Reserved name");
      return;
    }
    if (groups.some((g) => g.toLowerCase() === trimmedLower)) {
      setError("Already exists");
      return;
    }

    onAddGroup(trimmed);
    setInputValue("");
    setError("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  const handleSelectGroup = (name: string) => {
    if (selectedGroup === name) {
      setSelectedGroup(null);
    } else {
      setSelectedGroup(name);
      setRenameValue(name);
      setRenameError("");
    }
  };

  const handleRenameSubmit = () => {
    if (!selectedGroup) return;
    const trimmed = renameValue.trim();
    const trimmedLower = trimmed.toLowerCase();

    if (!trimmed) {
      setRenameError("Name required");
      return;
    }
    if (trimmed.includes(" ")) {
      setRenameError("One word only");
      return;
    }
    if (trimmed.length < MIN_GROUP_LENGTH) {
      setRenameError(`Min ${MIN_GROUP_LENGTH} chars`);
      return;
    }
    if (trimmed.length > MAX_GROUP_LENGTH) {
      setRenameError(`Max ${MAX_GROUP_LENGTH} chars`);
      return;
    }
    if (trimmedLower === "pinned") {
      setRenameError("Reserved name");
      return;
    }
    // Same name — no-op
    if (trimmed === selectedGroup) return;
    // Duplicate check (case-insensitive, excluding current)
    if (
      groups.some(
        (g) => g !== selectedGroup && g.toLowerCase() === trimmedLower,
      )
    ) {
      setRenameError("Already exists");
      return;
    }

    onRenameGroup(selectedGroup, trimmed);
    setSelectedGroup(trimmed);
    setRenameValue(trimmed);
    setRenameError("");
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRenameSubmit();
    }
    if (e.key === "Escape") {
      setSelectedGroup(null);
    }
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
      <div className="gm-group-list" ref={groupListRef}>
        {/* System group: Pinned */}
        <div className="gm-group-row gm-group-row--system">
          <span className="gm-group-icon gm-group-icon--pinned">{PinIcon}</span>
          <span className="gm-row-name">Pinned</span>
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

      {/* Detail panel for selected group */}
      {selectedGroup && selectedGc && (
        <>
          <div className="gm-divider" />
          <div className="gm-detail-panel">
            <div className="gm-detail-row">
              <span
                className="gm-detail-dot"
                style={{ background: selectedGc.fg }}
              />
              <input
                type="text"
                className={`gm-detail-input${renameError ? " gm-detail-input--error" : ""}`}
                value={renameValue}
                onChange={(e) => {
                  setRenameValue(e.target.value);
                  if (renameError) setRenameError("");
                }}
                onKeyDown={handleRenameKeyDown}
                onBlur={handleRenameSubmit}
                maxLength={MAX_GROUP_LENGTH}
                placeholder="Group name…"
              />
              <button
                className="gm-detail-delete"
                onClick={() => {
                  onDeleteGroup(selectedGroup);
                  setSelectedGroup(null);
                }}
                title="Delete group"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              </button>
            </div>
            {renameError && <span className="gm-error">{renameError}</span>}

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

      {/* Add group input */}
      <div className="gm-add-row">
        <input
          ref={inputRef}
          type="text"
          className={`gm-add-input${error ? " gm-add-input--error" : ""}`}
          placeholder="New group name…"
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
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      {error && <span className="gm-error">{error}</span>}
    </div>
  );
};

export default GroupManagerCard;
