// ── Multi-select ────────────────────────────────────────────────────────
// ProseMirror has one selection, and it is contiguous. Cards want the
// file-manager gestures too: Ctrl+click (Cmd on mac) toggles a card in and
// out of a pick that need not be contiguous, Shift+click extends the normal
// selection to the clicked card. The pick lives in plugin state as a set of
// positions, drawn with the same `ee-selected` class as a range, and
// Backspace/Delete, copy and cut act on it. Any plain selection change
// (a click, an arrow key) drops the pick.

import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const CARDS = new Set(["clipCard", "groupCard", "fileCard", "image"]);
const key = new PluginKey<number[]>("multiSelect");

type Action = { type: "set"; picks: number[] } | { type: "clear" };

function picksOf(state: EditorState): number[] {
  return key.getState(state) ?? [];
}

/** Positions that still point at a card after `tr`, sorted. */
function mapPicks(picks: number[], tr: Transaction): number[] {
  const out = new Set<number>();
  for (const pos of picks) {
    const mapped = tr.mapping.mapResult(pos);
    if (mapped.deleted) continue;
    const node = tr.doc.nodeAt(mapped.pos);
    if (node && CARDS.has(node.type.name)) out.add(mapped.pos);
  }
  return [...out].sort((a, b) => a - b);
}

function cardsIn(state: EditorState, picks: number[]): { pos: number; node: PMNode }[] {
  const out: { pos: number; node: PMNode }[] = [];
  for (const pos of picks) {
    const node = state.doc.nodeAt(pos);
    if (node && CARDS.has(node.type.name)) out.push({ pos, node });
  }
  return out;
}

/** Remove every picked card, last first so earlier positions stay valid. */
function deletePicks(view: EditorView): boolean {
  const picks = picksOf(view.state);
  if (picks.length === 0) return false;
  const tr = view.state.tr;
  for (const { pos, node } of cardsIn(view.state, picks).reverse()) {
    tr.delete(pos, pos + node.nodeSize);
  }
  tr.setMeta(key, { type: "clear" } satisfies Action);
  view.dispatch(tr);
  return true;
}

/** Put the picked cards on the clipboard as one inline run. */
function copyPicks(view: EditorView, event: ClipboardEvent): boolean {
  const picks = picksOf(view.state);
  if (picks.length === 0 || !event.clipboardData) return false;
  const nodes = cardsIn(view.state, picks).map((c) => c.node);
  const { dom, text } = view.serializeForClipboard(new Slice(Fragment.from(nodes), 0, 0));
  event.clipboardData.setData("text/html", dom.innerHTML);
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
  return true;
}

export const MultiSelect = Extension.create({
  name: "multiSelect",

  addKeyboardShortcuts() {
    const del = () => deletePicks(this.editor.view);
    return { Backspace: del, Delete: del };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<number[]>({
        key,
        state: {
          init: () => [],
          apply(tr, picks) {
            const action = tr.getMeta(key) as Action | undefined;
            if (action?.type === "set") return action.picks;
            if (action?.type === "clear") return [];
            if (tr.selectionSet) return [];
            return tr.docChanged ? mapPicks(picks, tr) : picks;
          },
        },
        props: {
          decorations(state) {
            const picks = picksOf(state);
            if (picks.length === 0) return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              cardsIn(state, picks).map(({ pos, node }) =>
                Decoration.node(pos, pos + node.nodeSize, { class: "ee-selected" }),
              ),
            );
          },

          handleClickOn(view, _pos, node, nodePos, event, direct) {
            if (!direct || !CARDS.has(node.type.name)) return false;
            const { state } = view;
            const toggle = event.ctrlKey || event.metaKey;

            if (toggle) {
              const picks = new Set(picksOf(state));
              // A card that was plainly clicked before is part of the pick too.
              if (state.selection instanceof NodeSelection && CARDS.has(state.selection.node.type.name)) {
                picks.add(state.selection.from);
              }
              if (picks.has(nodePos)) picks.delete(nodePos);
              else picks.add(nodePos);
              const tr = state.tr
                .setSelection(TextSelection.create(state.doc, nodePos + node.nodeSize))
                .setMeta(key, { type: "set", picks: [...picks].sort((a, b) => a - b) } satisfies Action);
              view.dispatch(tr);
              event.preventDefault();
              return true;
            }

            return false;
          },

          handleDOMEvents: {
            // Shift+click never reaches handleClickOn: ProseMirror hands a
            // shift-click to the browser at mousedown. Catch it there and
            // extend the selection from its anchor to the far edge of the card.
            mousedown: (view, event) => {
              if (!event.shiftKey || event.ctrlKey || event.metaKey) return false;
              const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!hit || hit.inside < 0) return false;
              const node = view.state.doc.nodeAt(hit.inside);
              if (!node || !CARDS.has(node.type.name)) return false;
              const { anchor } = view.state.selection;
              const head = hit.inside < anchor ? hit.inside : hit.inside + node.nodeSize;
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
              event.preventDefault();
              return true;
            },
            copy: (view, event) => copyPicks(view, event),
            cut: (view, event) => copyPicks(view, event) && deletePicks(view),
          },
        },
      }),
    ];
  },
});
