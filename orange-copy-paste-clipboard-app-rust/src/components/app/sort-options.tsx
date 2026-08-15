import React from "react";
import type { ClipboardEntry } from "../../types";
import { filePaths, htmlPlainText } from "../../types";
import {
  SortNewestIcon,
  SortOldestIcon,
  SortAZIcon,
  SortZAIcon,
  SortTypeIcon,
} from "../icons";

export type SortMode = "newest" | "oldest" | "a-z" | "z-a" | "type";

export const SORT_OPTIONS: { id: SortMode; label: string; icon: React.ReactNode }[] = [
  { id: "newest", label: "Newest", icon: <SortNewestIcon /> },
  { id: "oldest", label: "Oldest", icon: <SortOldestIcon /> },
  { id: "a-z", label: "A to Z", icon: <SortAZIcon /> },
  { id: "z-a", label: "Z to A", icon: <SortZAIcon /> },
  { id: "type", label: "Type", icon: <SortTypeIcon /> },
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
