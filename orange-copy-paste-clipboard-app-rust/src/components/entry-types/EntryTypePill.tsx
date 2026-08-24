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

/* ── Pill component ── */

interface EntryTypePillProps {
  kind: DisplayKind;
  className?: string;
}

export const EntryTypePill: React.FC<EntryTypePillProps> = ({
  kind,
  className,
}) => (
  <span
    className={`type-pill type-pill--${kind}${className ? ` ${className}` : ""}`}
  >
    {TYPE_ICONS[kind]}
    <span className="type-pill-label">{TYPE_LABELS[kind]}</span>
  </span>
);
