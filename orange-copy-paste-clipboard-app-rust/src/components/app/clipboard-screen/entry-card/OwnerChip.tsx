import React from "react";
import { UserAvatar } from "../../../UserAvatar";
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
      <UserAvatar
        className="card-owner-avatar"
        url={owner.avatar_url}
        label={owner.display_name?.trim() || ""}
        glyphSize={9}
      />
      <span className="card-owner-name">{name}</span>
    </span>
  );
};

export default OwnerChip;
