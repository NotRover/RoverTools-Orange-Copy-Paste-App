//  Shared types and utilities 

/** Matches the Rust `ClipboardEntry` struct (serialised by serde). */
export interface ClipboardEntry {
  id: string;
  /** Serialised as `"type"` from the Rust `#[serde(rename = "type")]` field. */
  type: "text" | "image" | "file";
  content: string;
  /** Unix epoch in milliseconds. */
  timestamp: number;
}

export type AppScreen = "clipboard" | "search" | "shortcuts" | "settings";
export type AppTheme = "dark" | "light";

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
  return text.length <= max ? text : text.slice(0, max) + "…";
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
