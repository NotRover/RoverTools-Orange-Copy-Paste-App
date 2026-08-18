//  Shared types and utilities

/** Matches the Rust `ClipboardEntry` struct (serialised by serde). */
export interface ClipboardEntry {
  id: string;
  /** Serialised as `"type"` from the Rust `#[serde(rename = "type")]` field. */
  type: "text" | "image" | "file" | "html";
  content: string;
  /** Unix epoch in milliseconds. */
  timestamp: number;
  /** Whether this entry is pinned and persists across restarts. */
  pinned: boolean;
  /** User-defined group tags assigned to this entry. */
  groups: string[];
  /** Optional display label (e.g. "Image Mar 17, 2:45 PM" for clipboard images). */
  label?: string;
  // Sync state is not part of the entry: Rust keeps it in id_map.json and the
  // pending queue. Read it with useEntrySyncStates().
}

/** Matches the Rust `Note` struct. */
export interface Note {
  id: string;
  title: string;
  /** Rich-text content stored as sanitised HTML. */
  content: string;
  /** Unix epoch in milliseconds. */
  created_at: number;
  /** Unix epoch in milliseconds. */
  updated_at: number;
  pinned: boolean;
  /** User-defined group tags (shared with clipboard groups). */
  groups: string[];
}

export type AppScreen = "clipboard" | "notes" | "spaces" | "shortcuts" | "account" | "settings";
export type AppTheme = "dark" | "light";

/** Sync connection state surfaced by the sidebar status indicator. */
export type SyncIndicator = "signedOut" | "connected" | "syncing" | "offline";

// ── Cloud sync types ────────────────────────────────────────────────

export interface SyncUser {
  user_id: string;
  email: string;
  display_name: string;
  /** Provider avatar URL (Google), or null — the UI falls back to initials. */
  avatar_url: string | null;
}

export interface SpaceMember {
  user_id: string;
  display_name: string;
  /** Provider avatar URL (Google), or null — the UI falls back to initials. */
  avatar_url: string | null;
  role: string;
  /** False until the owner has wrapped the Space Key for this member. */
  has_space_key: boolean;
  /** Presence snapshot; WS events keep it fresh. */
  online: boolean;
}

/** One shared space — the only sharing primitive. */
export interface Space {
  id: string;
  name: string;
  owner_id: string;
  is_owner: boolean;
  /** Whether members who join later can read entries shared before they joined. */
  share_history: boolean;
  member_count: number;
  members: SpaceMember[];
  invite_code?: string;
  invite_expires_at?: number;
}

/** An item that was removed from a space. Mirrors `DeletedMarker` in
 *  `src-tauri/src/sync/id_map.rs`. Kept after the content is gone so the feed
 *  can show that something was taken down instead of a row just vanishing. */
export interface DeletedMarker {
  space_ids: string[];
  owner_id: string | null;
  deleted_at: number;
  /** True when the author removed it, false when a space owner took it down. */
  by_author: boolean;
  /** Whether the local copy went with it. False means the item only left this
   *  space and is still yours. */
  content_gone: boolean;
  /** True when you removed your own copy of someone else's item. Nothing
   *  changed in the space - it is still there for everyone else. */
  local_only: boolean;
}

/** Per-space send filter: which of my entries auto-flow into the space.
 *  Absent or disabled = explicit shares only (the default). */
export interface SendFilter {
  enabled: boolean;
  /** Entry kinds that flow; empty = all kinds. */
  kinds: string[];
  /** Local group names that flow; empty = all groups. */
  groups: string[];
  /** Which content flows automatically. */
  content: "clipboard" | "notes" | "both";
}

/** How personal entries from other devices are applied on this device. */
export type SyncMode = "realtime" | "passive";

export interface SyncInvite {
  id: string;
  space_id: string;
  space_name: string;
  inviter_id: string;
  inviter_name: string;
  invitee_email: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  created_at: number;
  expires_at: number;
}

export interface SyncQuota {
  used_bytes: number;
  quota_bytes: number;
}

export interface SyncInviteList {
  sent: SyncInvite[];
  received: SyncInvite[];
}

/** One entry sync refused to send, with the reason to show the user. */
export interface SkippedEntry {
  client_id: string;
  label: string;
  reason: string;
  at: number;
}

export interface SyncStatusInfo {
  connected: boolean;
  pending_count: number;
  skipped_count: number;
  /** Most recent skips, newest first. */
  skipped: SkippedEntry[];
  last_synced_at?: number;
}

export interface SyncDevice {
  id: string;
  device_name: string;
  platform: string;
  app_version: string;
  /** Presence snapshot from the server; WS events keep it fresh. */
  online: boolean;
  /** True when this row is the device the app is running on. */
  is_current: boolean;
  last_seen_at: number;
}

/// Whether this build has sync endpoints compiled in. False means the
/// `DEFAULT_*` constants in `sync/config.rs` were left blank, so sign-in
/// cannot succeed.
export interface SyncConnection {
  configured: boolean;
}

// ── Group tag colors ────────────────────────────────────────────────

export const GROUP_COLORS: { bg: string; fg: string }[] = [
  { bg: "rgba(245, 158, 11, 0.12)", fg: "#f59e0b" }, // amber
  { bg: "rgba(239, 68, 68, 0.12)", fg: "#ef4444" }, // red
  { bg: "rgba(244, 63, 94, 0.12)", fg: "#f43f5e" }, // rose
  { bg: "rgba(16, 185, 129, 0.12)", fg: "#10b981" }, // emerald
  { bg: "rgba(132, 204, 22, 0.12)", fg: "#84cc16" }, // lime
  { bg: "rgba(20, 184, 166, 0.12)", fg: "#14b8a6" }, // teal
  { bg: "rgba(6, 182, 212, 0.12)", fg: "#06b6d4" }, // cyan
  { bg: "rgba(59, 130, 246, 0.12)", fg: "#3b82f6" }, // blue
  { bg: "rgba(99, 102, 241, 0.12)", fg: "#6366f1" }, // indigo
  { bg: "rgba(168, 85, 247, 0.12)", fg: "#a855f7" }, // purple
  { bg: "rgba(236, 72, 153, 0.12)", fg: "#ec4899" }, // pink
];

const GROUP_COLORS_STORAGE_KEY = "sc-group-colors";

function readGroupColorMap(): Record<string, number> {
  try {
    const raw = JSON.parse(
      localStorage.getItem(GROUP_COLORS_STORAGE_KEY) ?? "{}",
    ) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }

    const parsed: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      parsed[key] = value;
    }
    return parsed;
  } catch {
    return {};
  }
}

function normalizeColorIndex(index: number): number {
  const paletteSize = GROUP_COLORS.length;
  if (paletteSize <= 0) return 0;
  const rounded = Math.trunc(index);
  return ((rounded % paletteSize) + paletteSize) % paletteSize;
}

export function groupColorIndex(name: string): number {
  const map = readGroupColorMap();
  if (Object.prototype.hasOwnProperty.call(map, name)) {
    return normalizeColorIndex(map[name]);
  }

  const paletteSize = GROUP_COLORS.length;
  if (paletteSize <= 0) return 0;

  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % paletteSize;
}

export function groupColor(name: string): { bg: string; fg: string } {
  const fallback = { bg: "rgba(59, 130, 246, 0.12)", fg: "#3b82f6" };
  return GROUP_COLORS[groupColorIndex(name)] ?? fallback;
}

export function setGroupColorIndex(name: string, index: number): void {
  try {
    const map = readGroupColorMap();
    map[name] = normalizeColorIndex(index);
    localStorage.setItem(GROUP_COLORS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures so the UI does not crash.
  }
}

export function removeGroupColor(name: string): void {
  try {
    const map = readGroupColorMap();
    delete map[name];
    localStorage.setItem(GROUP_COLORS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures so the UI does not crash.
  }
}

export function renameGroupColor(oldName: string, newName: string): void {
  try {
    const map = readGroupColorMap();
    // Always preserve the resolved color — even if it was hash-based
    const idx = Object.prototype.hasOwnProperty.call(map, oldName)
      ? map[oldName]
      : groupColorIndex(oldName);
    map[newName] = normalizeColorIndex(idx);
    delete map[oldName];
    localStorage.setItem(GROUP_COLORS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures so the UI does not crash.
  }
}

//  Helpers

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncateText(text: string, max = 180): string {
  return text.length <= max ? text : text.slice(0, max) + "...";
}

const HTML_SEPARATOR = "\n---PLAINTEXT---\n";

/** For html entries, extract the HTML fragment portion. */
export function htmlFragment(content: string): string {
  const idx = content.indexOf(HTML_SEPARATOR);
  return idx >= 0 ? content.slice(0, idx) : content;
}

/** For html entries, extract the plain-text fallback portion. */
export function htmlPlainText(content: string): string {
  const idx = content.indexOf(HTML_SEPARATOR);
  return idx >= 0 ? content.slice(idx + HTML_SEPARATOR.length) : "";
}

export function filePaths(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export const IMAGE_FILE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "svg",
  "ico",
  "tiff",
  "tif",
  "avif",
  "heic",
  "heif",
]);

export const VIDEO_FILE_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "mkv",
  "avi",
  "wmv",
  "m4v",
  "mpeg",
  "mpg",
]);

export function fileExtension(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
}

export function isImageFile(path: string): boolean {
  return IMAGE_FILE_EXTENSIONS.has(fileExtension(path));
}

export function isVideoFile(path: string): boolean {
  return VIDEO_FILE_EXTENSIONS.has(fileExtension(path));
}

export function classifyFileEntry(content: string): "image" | "video" | "file" {
  const paths = filePaths(content);
  if (paths.length === 0) return "file";
  if (paths.every(isImageFile)) return "image";
  if (paths.every(isVideoFile)) return "video";
  return "file";
}

export const DOCUMENT_FILE_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "csv",
  "md",
  "txt",
  "pages",
  "numbers",
  "key",
  "epub",
]);

export function isDocumentFile(path: string): boolean {
  return DOCUMENT_FILE_EXTENSIONS.has(fileExtension(path));
}

export function isUrl(text: string): boolean {
  const t = text.trim();
  if (t.includes("\n")) return false;
  return /^https?:\/\/.{4,}/.test(t);
}

export type DisplayKind =
  | "text"
  | "url"
  | "html"
  | "image"
  | "video"
  | "document"
  | "folder"
  | "file";

function isDirectory(path: string): boolean {
  // No extension after the last path separator component
  const name = path.split(/[\\/]/).pop() ?? path;
  return !name.includes(".") || name.endsWith("/") || name.endsWith("\\");
}

export function deriveDisplayKind(entry: ClipboardEntry): DisplayKind {
  if (entry.type === "text") return isUrl(entry.content) ? "url" : "text";
  if (entry.type === "image") return "image";
  if (entry.type === "html") return "html";
  // file entry — classify by extension of paths
  const paths = filePaths(entry.content);
  if (paths.length === 0) return "file";
  if (paths.every(isDirectory)) return "folder";
  if (paths.every(isImageFile)) return "image";
  if (paths.every(isVideoFile)) return "video";
  if (paths.length === 1 && isDocumentFile(paths[0])) return "document";
  return "file";
}

/** Display name for a clipboard image entry, prefixed with its unique ID.
 *  Uses the persisted label when available, otherwise derives one from the timestamp. */
export function imageDisplayName(entry: ClipboardEntry): string {
  const name = entry.label
    ? entry.label
    : (() => {
        const d = new Date(entry.timestamp);
        const month = d.toLocaleString(undefined, { month: "short" });
        const day = d.getDate();
        const time = d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
        return `Image ${month} ${day}, ${time}`;
      })();
  // Display only: show a short prefix of the (UUID) id, not the whole thing.
  // The underlying entry.id is unchanged.
  return `#${entry.id.slice(0, 8)} ${name}`;
}

/** Resolve a clipboard image entry's content to a displayable `<img>` src.
 *  Inline data-URLs are returned as-is; file paths are converted to Tauri
 *  asset-protocol URLs so the sandboxed webview can load them. */
export function resolveImageSrc(
  content: string,
  convertFileSrc: (path: string) => string,
): string {
  return content.startsWith("data:") ? content : convertFileSrc(content);
}

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function readTheme(): AppTheme {
  return (localStorage.getItem("sc-theme") as AppTheme) ?? "dark";
}

export function readSlots(): number {
  const v = parseInt(localStorage.getItem("sc-paste-slots") ?? "3", 10);
  return Number.isNaN(v) ? 3 : Math.max(3, Math.min(10, v));
}
