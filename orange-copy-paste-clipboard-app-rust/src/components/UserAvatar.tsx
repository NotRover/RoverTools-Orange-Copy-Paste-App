import { useEffect, useState } from "react";
import { User } from "@phosphor-icons/react";
import "./UserAvatar.css";

/** Initials for a person's label: "Ada Lovelace" → "AL", "ada" → "AD". */
function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Profile picture with a text fallback. Provider URLs expire, 404, or get
    blocked, so a failed load degrades to exactly the initials the account would
    show with no picture at all — never a broken-image icon.

    The caller owns the frame (`className`) and so its size, colour, and radius;
    the picture fills whatever frame it lands in. */
export function UserAvatar({
  url,
  label,
  className,
  glyphSize,
}: {
  url: string | null | undefined;
  label: string;
  className: string;
  glyphSize: number;
}) {
  const [broken, setBroken] = useState(false);
  // A new URL deserves a fresh attempt: the old failure says nothing about it.
  useEffect(() => setBroken(false), [url]);

  if (url && !broken) {
    return (
      <span className={className}>
        <img
          className="user-avatar-img"
          src={url}
          alt=""
          // Google's CDN 403s some referrers; the picture is public anyway.
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      </span>
    );
  }
  return (
    <span className={className}>
      {label ? avatarInitials(label) : <User size={glyphSize} />}
    </span>
  );
}
