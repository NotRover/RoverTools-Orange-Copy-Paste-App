import React, { useEffect, useRef, useState } from "react";
import { PinIcon } from "../../../entry-types/EntryTypePill";
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

const MAX_GROUP_LENGTH = 12;

interface GroupManagerCardProps {
  groups: string[];
  onAddGroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  onClose: () => void;
}

const GroupManagerCard: React.FC<GroupManagerCardProps> = ({
  groups,
  onAddGroup,
  onDeleteGroup,
  onClose,
}) => {
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
    const trimmed = inputValue.trim().toLowerCase();
    if (!trimmed) return;

    // Validate: single word, max 12 chars, no duplicates
    if (trimmed.includes(" ")) {
      setError("One word only");
      return;
    }
    if (trimmed.length > MAX_GROUP_LENGTH) {
      setError(`Max ${MAX_GROUP_LENGTH} characters`);
      return;
    }
    if (trimmed === "pinned") {
      setError("Reserved name");
      return;
    }
    if (groups.some((g) => g.toLowerCase() === trimmed)) {
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

  return (
    <div className="gm-card" ref={cardRef}>
      <div className="gm-header">
        {TagIcon}
        <span className="gm-title">Manage Groups</span>
        <span className="gm-count">{groups.length}</span>
      </div>

      {/* System group: Pinned */}
      <div className="gm-group-list">
        <div className="gm-group-item gm-group-item--system">
          <span className="gm-group-icon gm-group-icon--pinned">{PinIcon}</span>
          <span className="gm-group-name">Pinned</span>
          <span className="gm-group-badge">System</span>
        </div>

        {/* User groups */}
        {groups.map((group) => (
          <div key={group} className="gm-group-item">
            <span className="gm-group-dot" />
            <span className="gm-group-name">{group}</span>
            <button
              className="gm-group-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteGroup(group);
              }}
              data-tooltip="Delete group"
            >
              <svg
                width="9"
                height="9"
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
        ))}
      </div>

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
