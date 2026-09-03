import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  fileTypeInfo,
  formatFileSize,
  isImageFile,
  fileNameFromPath,
  type FileType,
} from "../../types";
import {
  useFileStats,
  useImagePreviews,
  type FileStat,
} from "../../hooks/useFileMeta";
import {
  ImageIcon,
  VideoIcon,
  TextLinesIcon,
  SheetIcon,
  DocumentIcon,
  FolderIcon,
  ArchiveIcon,
  AudioIcon,
  FileIcon,
  GridIcon,
  RowsIcon,
} from "../icons";
import "./fileEntryList.css";

// The multi-file body of a file entry, in two interchangeable shapes: a preview
// grid (thumbnails for media, a type glyph for everything else) and an enriched
// list (the same badge, plus each file's path, type and size). The chosen shape
// is one per-device setting, so it holds across every multi-file entry.
//
// Single image/video entries never reach here — those get the full-panel preview
// in the viewers that call this.

type ViewMode = "grid" | "list";
const VIEW_SETTING = "file_view_mode";

type Glyph = React.FC<{ size?: number; strokeWidth?: number }>;

const TYPE_GLYPH: Record<FileType, Glyph> = {
  image: ImageIcon,
  video: VideoIcon,
  text: TextLinesIcon,
  sheet: SheetIcon,
  // Doc and PDF share the page glyph; their hue is what tells them apart.
  doc: DocumentIcon,
  pdf: DocumentIcon,
  folder: FolderIcon,
  archive: ArchiveIcon,
  audio: AudioIcon,
  file: FileIcon,
};

/** Right-hand meta for a row: a file's size, a folder's item count, or nothing
 *  while the stat is still loading. Missing is handled separately. */
function sizeText(stat: FileStat | undefined): string {
  if (!stat || stat.missing) return "";
  if (stat.is_dir) {
    if (stat.item_count == null) return "";
    return `${stat.item_count} ${stat.item_count === 1 ? "item" : "items"}`;
  }
  return stat.size != null ? formatFileSize(stat.size) : "";
}

export const FileEntryList: React.FC<{ paths: string[] }> = ({ paths }) => {
  const stats = useFileStats(paths);
  // Only images have real thumbnails; videos and everything else use the glyph.
  const previews = useImagePreviews(paths.filter(isImageFile).slice(0, 40));
  const [mode, setMode] = useState<ViewMode>("grid");

  useEffect(() => {
    let active = true;
    invoke<unknown>("get_setting", { key: VIEW_SETTING })
      .then((v) => {
        if (active && (v === "grid" || v === "list")) setMode(v);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const choose = useCallback((next: ViewMode) => {
    setMode(next);
    invoke("set_setting", { key: VIEW_SETTING, value: next }).catch(() => {});
  }, []);

  // A single file has nothing to lay out as a grid, so it stays a list and the
  // switch does not appear — the one extra control shows only where it helps.
  const showToggle = paths.length >= 2;
  const effective: ViewMode = showToggle ? mode : "list";

  const renderCell = (p: string) => {
    const stat = stats[p];
    const gone = stat?.missing ?? false;
    const { type, label } = fileTypeInfo(p, stat?.is_dir);
    const preview = gone ? undefined : previews[p];
    const G = TYPE_GLYPH[type];
    return { stat, gone, type, label, preview, G };
  };

  return (
    <div className="fe">
      {showToggle && (
        <div className="fe-bar">
          <span className="fe-count">{paths.length} files</span>
          <div className="fe-toggle" role="group" aria-label="File view">
            <button
              type="button"
              className={`fe-tg${effective === "grid" ? " is-on" : ""}`}
              aria-pressed={effective === "grid"}
              aria-label="Grid"
              data-tooltip="Grid"
              onClick={() => choose("grid")}
            >
              <GridIcon size={13} />
            </button>
            <button
              type="button"
              className={`fe-tg${effective === "list" ? " is-on" : ""}`}
              aria-pressed={effective === "list"}
              aria-label="List"
              data-tooltip="List"
              onClick={() => choose("list")}
            >
              <RowsIcon size={13} />
            </button>
          </div>
        </div>
      )}

      {effective === "grid" ? (
        <div className="fe-grid">
          {paths.map((p) => {
            const { gone, type, label, preview, G } = renderCell(p);
            return (
              <div
                key={p}
                className={`fe-tile${gone ? " is-missing" : ""}${preview ? " has-preview" : ""}`}
                data-ft={type}
                data-tooltip={p}
              >
                <div className="fe-thumb">
                  {preview ? (
                    <img src={preview} alt="" className="fe-thumb-img" />
                  ) : (
                    <span className="fe-glyph">
                      <G size={30} strokeWidth={1.8} />
                    </span>
                  )}
                </div>
                <div className="fe-cap">
                  <span className="fe-name">{fileNameFromPath(p)}</span>
                  <span className="fe-type">{gone ? "missing" : label}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="fe-rows">
          {paths.map((p) => {
            const { stat, gone, type, label, preview, G } = renderCell(p);
            const size = sizeText(stat);
            return (
              <div
                key={p}
                className={`fe-row${gone ? " is-missing" : ""}`}
                data-ft={type}
                data-tooltip={p}
              >
                {preview ? (
                  <img src={preview} alt="" className="fe-row-thumb" />
                ) : (
                  <span className="fe-badge">
                    <G size={18} strokeWidth={1.9} />
                  </span>
                )}
                <div className="fe-mid">
                  <span className="fe-name">{fileNameFromPath(p)}</span>
                  <span className="fe-path">{p}</span>
                </div>
                <div className="fe-meta">
                  <span className="fe-type">{label}</span>
                  {gone ? (
                    <span className="fe-gone">missing</span>
                  ) : (
                    size && <span className="fe-size">{size}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
