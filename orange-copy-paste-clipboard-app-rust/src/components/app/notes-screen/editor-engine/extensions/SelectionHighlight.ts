// ── Selection highlight ─────────────────────────────────────────────────
// Atoms (chips, cards, images) get no visible selection on their own: a single
// click is a NodeSelection with no text to highlight, and a drag across several
// is a text range the browser paints faintly, if at all. This plugin marks
// every atom that falls inside the current selection with `ee-selected`, so one
// CSS rule gives clear feedback for both a single pick and a multi-select drag.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const ATOMS = new Set([
  "clipEmbed",
  "groupRef",
  "clipCard",
  "groupCard",
  "fileCard",
  "image",
]);

export const SelectionHighlight = Extension.create({
  name: "selectionHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("selectionHighlight"),
        props: {
          decorations(state) {
            const { from, to, empty } = state.selection;
            if (empty) return DecorationSet.empty;
            const decos: Decoration[] = [];
            state.doc.nodesBetween(from, to, (node, pos) => {
              if (
                ATOMS.has(node.type.name) &&
                pos >= from &&
                pos + node.nodeSize <= to
              ) {
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: "ee-selected",
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
