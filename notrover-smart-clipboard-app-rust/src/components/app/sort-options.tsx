import React from "react";
import type { ClipboardEntry } from "../../types";
import { filePaths, htmlPlainText } from "../../types";

export type SortMode = "newest" | "oldest" | "a-z" | "z-a" | "type";

export const SORT_OPTIONS: { id: SortMode; label: string; icon: React.ReactNode }[] = [
  {
    id: "newest",
    label: "Newest",
    icon: (
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
        <polyline points="17 11 12 6 7 11" />
        <line x1="12" y1="18" x2="12" y2="6" />
      </svg>
    ),
  },
  {
    id: "oldest",
    label: "Oldest",
    icon: (
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
        <polyline points="7 13 12 18 17 13" />
        <line x1="12" y1="6" x2="12" y2="18" />
      </svg>
    ),
  },
  {
    id: "a-z",
    label: "A \u2192 Z",
    icon: (
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
        <path d="M3 6h7" />
        <path d="M3 12h5" />
        <path d="M3 18h3" />
        <path d="M16 6l4 12" />
        <path d="M20 6l-4 12" />
        <path d="M14.5 14h7" />
      </svg>
    ),
  },
  {
    id: "z-a",
    label: "Z \u2192 A",
    icon: (
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
        <path d="M3 18h7" />
        <path d="M3 12h5" />
        <path d="M3 6h3" />
        <path d="M16 6l4 12" />
        <path d="M20 6l-4 12" />
        <path d="M14.5 14h7" />
      </svg>
    ),
  },
  {
    id: "type",
    label: "Type",
    icon: (
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
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
];

export function sortableText(e: ClipboardEntry): string {
  if (e.type === "text") return e.content.toLowerCase();
  if (e.type === "html") return htmlPlainText(e.content).toLowerCase();
  if (e.type === "file") {
    const paths = filePaths(e.content);
    return ((paths[0] ?? "").split(/[\\/]/).pop() ?? "").toLowerCase();
  }
  return "";
}
