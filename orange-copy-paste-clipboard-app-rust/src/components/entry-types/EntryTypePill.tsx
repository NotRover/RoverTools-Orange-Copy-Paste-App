import React from "react";
import type { DisplayKind } from "../../types";
import {
  ImageIcon as ImageIconComp,
  FileIcon as FileIconComp,
  TextLinesIcon,
  VideoIcon as VideoIconComp,
  LinkIcon as LinkIconComp,
  DocumentIcon as DocumentIconComp,
  FolderIcon as FolderIconComp,
  HtmlCodeIcon,
  PinIcon as PinIconComp,
  SaveStarIcon,
  FilesStackIcon,
} from "../icons";
import "./entryTypes.css";

/* ── SVG icons (9×9 for pills, but scalable via viewBox) ── */

export const ImageIcon = <ImageIconComp />;
export const FileIcon = <FileIconComp />;
const TextIcon = <TextLinesIcon />;
export const VideoIcon = <VideoIconComp />;
export const LinkIcon = <LinkIconComp />;
export const DocumentIcon = <DocumentIconComp />;
export const FolderIcon = <FolderIconComp size={9} strokeWidth={2.2} />;
const HtmlIcon = <HtmlCodeIcon />;
const FilesStack = <FilesStackIcon />;
export const PinIcon = <PinIconComp size={9} filled />;
export const SaveIcon = <SaveStarIcon size={9} filled />;

/* ── Icon + label maps ── */

export const TYPE_ICONS: Record<DisplayKind, React.ReactNode> = {
  text: TextIcon,
  url: LinkIcon,
  html: HtmlIcon,
  image: ImageIcon,
  video: VideoIcon,
  document: DocumentIcon,
  file: FileIcon,
  folder: FolderIcon,
};

export const TYPE_LABELS: Record<DisplayKind, string> = {
  text: "Text",
  url: "URL",
  html: "Rich Text",
  image: "Image",
  video: "Video",
  document: "Doc",
  file: "File",
  folder: "Folder",
};

/* Plural nouns for a multi-file bundle. deriveDisplayKind already collapses an
   all-images/all-videos/all-folders bundle to that kind, so those read
   naturally; a mixed bundle stays "file" and reads as "N files". */
const BUNDLE_LABELS: Record<DisplayKind, string> = {
  text: "items",
  url: "links",
  html: "items",
  image: "images",
  video: "videos",
  document: "docs",
  file: "files",
  folder: "folders",
};

/* ── Pill component ── */

interface EntryTypePillProps {
  kind: DisplayKind;
  /** Files in the entry. When >1 the pill becomes a bundle chip: a stacked
   *  glyph and "N <plural>" instead of the single-kind icon and label. */
  count?: number;
  className?: string;
}

export const EntryTypePill: React.FC<EntryTypePillProps> = ({
  kind,
  count,
  className,
}) => {
  const bundle = count != null && count > 1;
  return (
    <span
      className={`type-pill type-pill--${kind}${bundle ? " type-pill--bundle" : ""}${className ? ` ${className}` : ""}`}
    >
      {bundle ? FilesStack : TYPE_ICONS[kind]}
      <span className="type-pill-label">
        {bundle ? `${count} ${BUNDLE_LABELS[kind]}` : TYPE_LABELS[kind]}
      </span>
    </span>
  );
};
