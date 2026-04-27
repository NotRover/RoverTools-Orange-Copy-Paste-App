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
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { ClipEmbed } from "./extensions/ClipEmbed";
import { GroupRef } from "./extensions/GroupRef";
import type { EditorCommand, ActiveState, BlockKind } from "./types";

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
        }),
        Underline,
        Link.configure({ openOnClick: false, autolink: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({ placeholder: placeholder ?? "Start writing…" }),
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
      ],
      content: initialMarkdown,
      editorProps: {
        attributes: { class: "ee-rich ProseMirror" },
      },
      onUpdate: ({ editor }) => {
        const md = (editor.storage as any).markdown?.getMarkdown?.() ?? "";
        onChange(md);
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
            case "link":
              c.extendMarkRange("link").setLink({ href: cmd.url }).run();
              break;
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
        getMarkdown: () =>
          (editor?.storage as any)?.markdown?.getMarkdown?.() ?? "",
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
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    inTable: editor.isActive("table"),
    blockKind,
  };
}
