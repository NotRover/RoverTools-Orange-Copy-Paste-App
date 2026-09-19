// ── Tiptap node — Image with selection controls ────────────────────────
// Extends the stock inline Image node with a `width` attribute (share of
// the column, in percent) and a React node view that shows a toolbar only
// while the image is selected: size presets, Open, Remove. The picture is
// the content, so there is no card chrome around it.

import React from "react";
import { mergeAttributes } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { CloseIcon, ExpandIcon } from "../../../../icons";
import { attachmentFilename, resolveAttachmentUrl } from "../attachment-url";
import { openAttachment } from "./FileCard";

const IMAGE_SIZES: { label: string; width: number | null }[] = [
  { label: "S", width: 25 },
  { label: "M", width: 50 },
  { label: "L", width: 75 },
  { label: "Full", width: 100 },
];

/** Inline style for an image wrapper, shared with the preview renderer. */
export function imageWrapperStyle(width: number | null): React.CSSProperties | undefined {
  return width ? { width: `${width}%` } : undefined;
}

const ImageView: React.FC<NodeViewProps> = ({ node, selected, updateAttributes, deleteNode }) => {
  const src = (node.attrs.src as string) ?? "";
  const alt = (node.attrs.alt as string) ?? "";
  const width = node.attrs.width as number | null;
  const canOpen = !!attachmentFilename(src);

  return (
    <NodeViewWrapper
      as="span"
      className={`ee-image${width ? " ee-image--sized" : ""}`}
      style={imageWrapperStyle(width)}
      contentEditable={false}
    >
      <img src={resolveAttachmentUrl(src)} alt={alt} draggable={false} />
      {selected && (
        <>
          <span className="ee-image-tools" onMouseDown={(e) => e.preventDefault()}>
            {canOpen && (
              <button
                type="button"
                className="ee-card-act"
                onClick={() => openAttachment(src, false)}
                data-tooltip="Open"
                data-tooltip-pos="below"
                aria-label="Open"
              >
                <ExpandIcon size={12} />
              </button>
            )}
            <button
              type="button"
              className="ee-card-act"
              onClick={deleteNode}
              data-tooltip="Remove"
              data-tooltip-pos="below"
              aria-label="Remove"
            >
              <CloseIcon size={12} />
            </button>
          </span>
          <span className="ee-image-sizes" onMouseDown={(e) => e.preventDefault()}>
            {IMAGE_SIZES.map((s) => (
              <button
                key={s.label}
                type="button"
                className={`ee-image-size${width === s.width ? " ee-image-size--on" : ""}`}
                onClick={() => updateAttributes({ width: width === s.width ? null : s.width })}
                aria-label={`Width ${s.width}%`}
              >
                {s.label}
              </button>
            ))}
          </span>
        </>
      )}
    </NodeViewWrapper>
  );
};

export const ResolvedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute("data-width") ?? el.style.width.replace("%", "");
          const v = Number(raw);
          return Number.isFinite(v) && v > 0 && v <= 100 ? v : null;
        },
        renderHTML: (attrs) => (attrs.width ? { "data-width": String(attrs.width) } : {}),
      },
    };
  },

  // Persisted JSON keeps the `note-attachment://` src; only the DOM gets the
  // resolved asset URL.
  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes };
    if (typeof attrs.src === "string") attrs.src = resolveAttachmentUrl(attrs.src);
    return ["img", mergeAttributes(attrs)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
