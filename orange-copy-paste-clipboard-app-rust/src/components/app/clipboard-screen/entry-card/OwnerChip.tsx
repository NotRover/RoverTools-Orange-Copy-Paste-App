import React from "react";
import type { EntryOwner } from "../../../../hooks/useEntryOwners";
import "./OwnerChip.css";

/**
 * Who sent an entry that came from someone else.
 *
 * Shown only on entries that arrived through a space. Your own items carry no
 * chip at all: everything on these screens is yours by default, so a badge on
 * every row would say nothing and a badge on some rows says exactly the thing
 * that was missing - this one is not yours.
 */
const OwnerChip: React.FC<{ owner: EntryOwner }> = ({ owner }) => {
  const name = owner.display_name?.trim() || "A member";
  return (
    <span className="card-owner-chip" data-tooltip={`Shared by ${name}`}>
      {owner.avatar_url ? (
        <img className="card-owner-avatar" src={owner.avatar_url} alt="" />
      ) : (
        <span className="card-owner-avatar card-owner-avatar--initials">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="card-owner-name">{name}</span>
    </span>
  );
};

export default OwnerChip;
