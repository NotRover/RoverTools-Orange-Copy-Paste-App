// ── Editor Engine — Rich (WYSIWYG) surface ────────────────────────────────
// Tiptap editor that round-trips to markdown via tiptap-markdown. Receives
// commands from the toolbar through an imperative handle so the same toolbar
// works in both modes.

import {
  useCallback,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
// Note: @tiptap/extension-drag-handle-react intentionally not used — it crashes on mode switch.
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { invoke } from "@tauri-apps/api/core";
import {
  imageAttachmentUrl,
  resolveAttachmentUrl,
  subscribeAttachmentResolver,
} from "./attachment-url";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import { ClipEmbed } from "./extensions/ClipEmbed";
import { GroupRef } from "./extensions/GroupRef";
import {
  AlignAwareParagraph,
  AlignAwareHeading,
} from "./extensions/AlignAware";
import type {
  EditorCommand,
  ActiveState,
  BlockKind,
  AlignValue,
} from "./types";

export interface RichEditorHandle {
  applyCommand: (cmd: EditorCommand) => void;
  getMarkdown: () => string;
  getActiveState: () => ActiveState;
  focus: () => void;
}

interface Props {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onSelectionChange?: () => void;
  placeholder?: string;
}

interface TableHandlePos {
  visible: boolean;
  colX: number;
  colY: number;
  rowX: number;
  rowY: number;
}

// Image and Link extensions resolve `note-attachment://` / `note-file://`
// schemes at DOM render time only. The doc and serialized markdown keep the
// clean scheme URL — only the rendered <img>/<a> get the asset URL.
const ResolvedImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes };
    if (typeof attrs.src === "string") attrs.src = resolveAttachmentUrl(attrs.src);
    return ["img", mergeAttributes(attrs)];
  },
});

const ResolvedLink = Link.extend({
  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes };
    if (typeof attrs.href === "string") attrs.href = resolveAttachmentUrl(attrs.href);
    return ["a", mergeAttributes(this.options.HTMLAttributes, attrs), 0];
  },
});

// Tab/Shift-Tab: lists sink/lift; all other blocks insert/remove 4 spaces.
const IndentExtension = Extension.create({
  name: "indent",
  addKeyboardShortcuts() {
    const indent = "\u00A0\u00A0\u00A0\u00A0";
    const plainIndent = "    ";
    return {
      Tab: () => {
        const { editor } = this;
        if (editor.can().sinkListItem("listItem"))
          return editor.commands.sinkListItem("listItem");
        if (editor.can().sinkListItem("taskItem"))
          return editor.commands.sinkListItem("taskItem");
        const { state, dispatch } = editor.view;
        // Use non-breaking spaces so markdown doesn't reinterpret it as a block element.
        dispatch(state.tr.insertText(indent));
        return true;
      },
      "Shift-Tab": () => {
        const { editor } = this;
        if (editor.can().liftListItem("listItem"))
          return editor.commands.liftListItem("listItem");
        if (editor.can().liftListItem("taskItem"))
          return editor.commands.liftListItem("taskItem");
        const { state, dispatch } = editor.view;
        const { from } = state.selection;
        const start = Math.max(0, from - indent.length);
        const textBefore = state.doc.textBetween(start, from);
        if (textBefore.endsWith(indent)) {
          dispatch(state.tr.delete(from - indent.length, from));
          return true;
        }
        if (textBefore.endsWith(plainIndent)) {
          dispatch(state.tr.delete(from - plainIndent.length, from));
          return true;
        }
        return false;
      },
    };
  },
});

const RichEditor = forwardRef<RichEditorHandle, Props>(
  ({ initialMarkdown, onChange, onSelectionChange, placeholder }, ref) => {
    const [tableHandlePos, setTableHandlePos] = useState<TableHandlePos>({
      visible: false,
      colX: 0,
      colY: 0,
      rowX: 0,
      rowY: 0,
    });
    const updateTableHandlePos = useCallback(
      (nextEditor: ReturnType<typeof useEditor> | null) => {
        if (!nextEditor || !nextEditor.isActive("table")) {
          setTableHandlePos((prev) =>
            prev.visible ? { ...prev, visible: false } : prev,
          );
          return;
        }

        const { anchor } = nextEditor.state.selection;
        const domAtPos = nextEditor.view.domAtPos(anchor);
        const baseEl =
          domAtPos.node instanceof Element
            ? domAtPos.node
            : domAtPos.node.parentElement;
        const cellEl = baseEl?.closest("td,th") as HTMLElement | null;
        const tableEl = cellEl?.closest("table") as HTMLElement | null;
        const scrollEl = baseEl?.closest(
          ".ee-rich-shell",
        ) as HTMLElement | null;
        if (!cellEl || !tableEl || !scrollEl) {
          setTableHandlePos((prev) =>
            prev.visible ? { ...prev, visible: false } : prev,
          );
          return;
        }

        const table = tableEl.getBoundingClientRect();
        const box = scrollEl.getBoundingClientRect();
        const clamp = (v: number, min: number, max: number) =>
          Math.min(Math.max(v, min), max);
        const edgeGap = 6;

        const colX = clamp(
          table.right + edgeGap,
          box.left + 10,
          box.right - 10,
        );
        const colY = clamp(
          table.top + table.height / 2,
          box.top + 22,
          box.bottom - 22,
        );
        const rowX = clamp(
          table.left + table.width / 2,
          box.left + 22,
          box.right - 22,
        );
        const rowY = clamp(
          table.bottom + edgeGap,
          box.top + 10,
          box.bottom - 10,
        );

        setTableHandlePos({
          visible: true,
          colX,
          colY,
          rowX,
          rowY,
        });
      },
      [],
    );

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          codeBlock: { HTMLAttributes: { class: "ee-codeblock" } },
          paragraph: false,
          heading: false,
        }),
        AlignAwareParagraph,
        AlignAwareHeading.configure({ levels: [1, 2, 3, 4, 5] }),
        Underline,
        ResolvedLink.configure({ openOnClick: false, autolink: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({ placeholder: placeholder ?? "Start writing…" }),
        TextAlign.configure({
          types: ["heading", "paragraph"],
          alignments: ["left", "center", "right", "justify"],
          defaultAlignment: "left",
        }),
        TextStyle,
        Color,
        Highlight.configure({ multicolor: true }),
        Markdown.configure({
          html: true,
          tightLists: true,
          tightListClass: "tight",
          bulletListMarker: "-",
          linkify: true,
          breaks: false,
          transformPastedText: true,
          transformCopiedText: true,
        }),
        ClipEmbed,
        GroupRef,
        IndentExtension,
        ResolvedImage.configure({ inline: false, allowBase64: true }),
      ],
      content: initialMarkdown,
      editorProps: {
        attributes: { class: "ee-rich ProseMirror" },
        handlePaste: (view, event) => {
          const items = Array.from(event.clipboardData?.items ?? []);
          const imageItem = items.find((it) => it.type.startsWith("image/"));
          if (!imageItem) return false;
          event.preventDefault();
          const file = imageItem.getAsFile();
          if (!file) return true;
          insertImageFromFile(view, file);
          return true;
        },
        handleDrop: (view, event) => {
          const dt = (event as DragEvent).dataTransfer;
          const file = Array.from(dt?.files ?? []).find((f) =>
            f.type.startsWith("image/"),
          );
          if (!file) return false;
          event.preventDefault();
          insertImageFromFile(view, file);
          return true;
        },
      },
      onUpdate: ({ editor }) => {
        const md = (editor.storage as any).markdown?.getMarkdown?.() ?? "";
        onChange(normalizeIndentMarkdown(md));
        updateTableHandlePos(editor);
      },
      onSelectionUpdate: ({ editor }) => {
        updateTableHandlePos(editor);
        onSelectionChange?.();
      },
    });

    const runTableCommand = useCallback(
      (cmd: "addRow" | "addCol" | "delRow" | "delCol") => {
        if (!editor) return;
        const chain = editor.chain().focus();
        if (cmd === "addRow") chain.addRowAfter().run();
        else if (cmd === "addCol") chain.addColumnAfter().run();
        else if (cmd === "delRow") chain.deleteRow().run();
        else chain.deleteColumn().run();
        updateTableHandlePos(editor);
      },
      [editor, updateTableHandlePos],
    );

    // ── Imperative API ──────────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        applyCommand: (cmd) => {
          if (!editor) return;
          const c = editor.chain().focus();
          switch (cmd.kind) {
            case "bold":
              c.toggleBold().run();
              break;
            case "italic":
              c.toggleItalic().run();
              break;
            case "strike":
              c.toggleStrike().run();
              break;
            case "code":
              c.toggleCode().run();
              break;
            case "heading":
              c.toggleHeading({ level: cmd.level }).run();
              break;
            case "paragraph":
              c.setParagraph().run();
              break;
            case "blockquote":
              c.toggleBlockquote().run();
              break;
            case "bulletList":
              c.toggleBulletList().run();
              break;
            case "orderedList":
              c.toggleOrderedList().run();
              break;
            case "taskList":
              c.toggleTaskList().run();
              break;
            case "codeBlock":
              c.toggleCodeBlock().run();
              break;
            case "hr":
              c.setHorizontalRule().run();
              break;
            case "link": {
              const { empty } = editor.state.selection;
              if (empty) {
                const text = (cmd.text && cmd.text.trim()) || cmd.url;
                c.insertContent({
                  type: "text",
                  text,
                  marks: [{ type: "link", attrs: { href: cmd.url } }],
                }).run();
              } else if (cmd.text && cmd.text.trim()) {
                c.insertContent({
                  type: "text",
                  text: cmd.text,
                  marks: [{ type: "link", attrs: { href: cmd.url } }],
                }).run();
              } else {
                c.extendMarkRange("link").setLink({ href: cmd.url }).run();
              }
              break;
            }
            case "align":
              c.setTextAlign(cmd.value).run();
              break;
            case "textColor":
              if (cmd.value == null) c.unsetColor().run();
              else c.setColor(cmd.value).run();
              break;
            case "highlight":
              if (cmd.value == null) c.unsetHighlight().run();
              else c.setHighlight({ color: cmd.value }).run();
              break;
            case "image": {
              const imageNode = editor.schema.nodes.image;
              if (!imageNode) break;
              c.insertContent({
                type: "image",
                attrs: { src: cmd.src, alt: cmd.alt ?? null },
              }).run();
              break;
            }
            case "insertTable":
              c.insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
              break;
            case "tableAddRowAfter":
              c.addRowAfter().run();
              break;
            case "tableAddColumnAfter":
              c.addColumnAfter().run();
              break;
            case "tableDeleteRow":
              c.deleteRow().run();
              break;
            case "tableDeleteColumn":
              c.deleteColumn().run();
              break;
            case "insertText":
              c.insertContent(cmd.text).run();
              break;
            case "clipEmbed":
              c.insertContent({
                type: "clipEmbed",
                attrs: { id: cmd.id },
              }).run();
              break;
            case "groupEmbed":
              c.insertContent({
                type: "groupRef",
                attrs: { name: cmd.name },
              }).run();
              break;
          }
        },
        getMarkdown: () => {
          const md = (editor?.storage as any)?.markdown?.getMarkdown?.() ?? "";
          return normalizeIndentMarkdown(md);
        },
        getActiveState: () => activeStateFor(editor),
        focus: () => editor?.commands.focus(),
      }),
      [editor],
    );

    // Reset when initial content changes (note switch).
    useEffect(() => {
      if (!editor) return;
      const current = (editor.storage as any).markdown?.getMarkdown?.() ?? "";
      if (current !== initialMarkdown) {
        editor.commands.setContent(initialMarkdown, { emitUpdate: false });
      }
    }, [editor, initialMarkdown]);

    // Refresh image/link DOM once the attachment resolver finishes loading,
    // so notes opened before init have their `note-attachment://` URLs rendered.
    useEffect(() => {
      if (!editor) return;
      return subscribeAttachmentResolver(() => {
        const md = (editor.storage as any).markdown?.getMarkdown?.() ?? "";
        editor.commands.setContent(md, { emitUpdate: false });
      });
    }, [editor]);

    useEffect(() => {
      if (!editor) return;
      const onViewportChange = () => updateTableHandlePos(editor);
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("scroll", onViewportChange, true);
      onViewportChange();
      return () => {
        window.removeEventListener("resize", onViewportChange);
        window.removeEventListener("scroll", onViewportChange, true);
      };
    }, [editor, updateTableHandlePos]);

    return (
      <>
        <EditorContent editor={editor} className="ee-rich-shell" />
        {tableHandlePos.visible && (
          <>
            <div
              className="ee-table-controls ee-table-controls--col"
              style={{ left: tableHandlePos.colX, top: tableHandlePos.colY }}
            >
              <button
                type="button"
                className="ee-table-handle-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runTableCommand("addCol")}
                title="Add column to right"
              >
                +
              </button>
              <button
                type="button"
                className="ee-table-handle-btn ee-table-handle-btn--danger"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runTableCommand("delCol")}
                title="Remove current column"
              >
                -
              </button>
            </div>
            <div
              className="ee-table-controls ee-table-controls--row"
              style={{ left: tableHandlePos.rowX, top: tableHandlePos.rowY }}
            >
              <button
                type="button"
                className="ee-table-handle-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runTableCommand("addRow")}
                title="Add row to bottom"
              >
                +
              </button>
              <button
                type="button"
                className="ee-table-handle-btn ee-table-handle-btn--danger"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runTableCommand("delRow")}
                title="Remove current row"
              >
                -
              </button>
            </div>
          </>
        )}
      </>
    );
  },
);

RichEditor.displayName = "RichEditor";

export default RichEditor;

// ── Helpers ───────────────────────────────────────────────────────────────

function activeStateFor(editor: ReturnType<typeof useEditor>): ActiveState {
  if (!editor) return { blockKind: "p" };
  let blockKind: BlockKind = "p";
  if (editor.isActive("heading", { level: 1 })) blockKind = "h1";
  else if (editor.isActive("heading", { level: 2 })) blockKind = "h2";
  else if (editor.isActive("heading", { level: 3 })) blockKind = "h3";
  else if (editor.isActive("heading", { level: 4 })) blockKind = "h4";
  else if (editor.isActive("heading", { level: 5 })) blockKind = "h5";
  else if (editor.isActive("blockquote")) blockKind = "bq";
  else if (editor.isActive("taskItem")) blockKind = "todo";
  else if (editor.isActive("bulletList")) blockKind = "ul";
  else if (editor.isActive("orderedList")) blockKind = "ol";
  else if (editor.isActive("codeBlock")) blockKind = "code";
  let align: AlignValue | undefined;
  for (const a of ["left", "center", "right", "justify"] as AlignValue[]) {
    if (editor.isActive({ textAlign: a })) {
      align = a;
      break;
    }
  }
  const colorAttr = editor.getAttributes("textStyle")?.color;
  const highlightAttr = editor.getAttributes("highlight")?.color;
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    inTable: editor.isActive("table"),
    blockKind,
    align,
    textColor: typeof colorAttr === "string" ? colorAttr : undefined,
    highlight: typeof highlightAttr === "string" ? highlightAttr : undefined,
  };
}

// Persist a pasted/dropped image file to disk via Tauri, then insert it as a
// regular `<img>` node referencing a `tauri-asset:` URL. This avoids stuffing
// huge base64 data URLs into the markdown source (which made round-tripping
// between rich and markdown modes flaky).
function insertImageFromFile(
  view: import("@tiptap/pm/view").EditorView,
  file: File,
): void {
  const mime = (file.type || "image/png").toLowerCase();
  const extFromMime = mime.split("/")[1] ?? "png";
  const extFromName = file.name.includes(".")
    ? file.name.split(".").pop() ?? extFromMime
    : extFromMime;
  const ext = (extFromName || extFromMime).toLowerCase();
  file
    .arrayBuffer()
    .then(async (buf) => {
      const bytes = Array.from(new Uint8Array(buf));
      const filename = await invoke<string>("save_note_image", { bytes, ext });
      // Store the clean scheme; the editor's content layer resolves it for
      // display via the boundary transforms in setContent / getMarkdown.
      const src = imageAttachmentUrl(filename);
      const imageNode = view.state.schema.nodes.image;
      if (!imageNode) return;
      view.dispatch(
        view.state.tr.replaceSelectionWith(imageNode.create({ src })),
      );
    })
    .catch((err) => {
      console.error("[notes] failed to save pasted image", err);
    });
}

function normalizeIndentMarkdown(markdown: string): string {
  if (!markdown.includes("    ")) return markdown;
  const lines = markdown.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```|^~~~/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^( {4})+/.exec(line);
    if (!match) continue;
    if (/^( {4})+([>*+-]\s|\d+\.\s|#)/.test(line)) continue;
    const count = match[0].length;
    const nbsp = "\u00A0".repeat(count);
    lines[i] = nbsp + line.slice(count);
  }
  return lines.join("\n");
}
