// ── Align-aware Paragraph & Heading ──────────────────────────────────────
// Replace StarterKit's built-in paragraph/heading so the textAlign attribute
// (provided by @tiptap/extension-text-align) round-trips through markdown.
// When alignment is non-default, we emit raw inline HTML — `html: true` on
// the Markdown extension lets it round-trip back into the schema cleanly.

import { Paragraph } from "@tiptap/extension-paragraph";
import { Heading } from "@tiptap/extension-heading";

type SerializeState = {
  write: (text: string) => void;
  renderInline: (node: unknown) => void;
  closeBlock: (node: unknown) => void;
};

type ProseMirrorNode = {
  attrs: { textAlign?: string; level?: number };
};

function isAligned(value: unknown): value is string {
  return (
    typeof value === "string" && value !== "" && value !== "left"
  );
}

export const AlignAwareParagraph = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializeState, node: ProseMirrorNode) {
          const align = node.attrs.textAlign;
          if (isAligned(align)) {
            state.write(`<p style="text-align: ${align}">`);
            state.renderInline(node);
            state.write(`</p>`);
            state.closeBlock(node);
            return;
          }
          state.renderInline(node);
          state.closeBlock(node);
        },
        parse: { setup() {} },
      },
    };
  },
});

export const AlignAwareHeading = Heading.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializeState, node: ProseMirrorNode) {
          const align = node.attrs.textAlign;
          const level = node.attrs.level ?? 1;
          if (isAligned(align)) {
            state.write(`<h${level} style="text-align: ${align}">`);
            state.renderInline(node);
            state.write(`</h${level}>`);
            state.closeBlock(node);
            return;
          }
          state.write("#".repeat(level) + " ");
          state.renderInline(node);
          state.closeBlock(node);
        },
        parse: { setup() {} },
      },
    };
  },
});
