// ── Editor Engine — Rich (WYSIWYG) surface ────────────────────────────────
// Tiptap editor that round-trips to markdown via tiptap-markdown. Receives
// commands from the toolbar through an imperative handle so the same toolbar
// works in both modes.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
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
import type {
  EditorCommand,
  ActiveState,
  BlockKind,
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

const RichEditor = forwardRef<RichEditorHandle, Props>(
  ({ initialMarkdown, onChange, onSelectionChange, placeholder }, ref) => {
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
      },
      onSelectionUpdate: () => {
        onSelectionChange?.();
      },
    });

    // ── Imperative API ──────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      applyCommand: (cmd) => {
        if (!editor) return;
        const c = editor.chain().focus();
        switch (cmd.kind) {
          case "bold":         c.toggleBold().run(); break;
          case "italic":       c.toggleItalic().run(); break;
          case "strike":       c.toggleStrike().run(); break;
          case "code":         c.toggleCode().run(); break;
          case "heading":      c.toggleHeading({ level: cmd.level }).run(); break;
          case "paragraph":    c.setParagraph().run(); break;
          case "blockquote":   c.toggleBlockquote().run(); break;
          case "bulletList":   c.toggleBulletList().run(); break;
          case "orderedList":  c.toggleOrderedList().run(); break;
          case "taskList":     c.toggleTaskList().run(); break;
          case "codeBlock":    c.toggleCodeBlock().run(); break;
          case "hr":           c.setHorizontalRule().run(); break;
          case "link":         c.extendMarkRange("link").setLink({ href: cmd.url }).run(); break;
          case "insertTable":  c.insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(); break;
          case "insertText":   c.insertContent(cmd.text).run(); break;
          case "clipEmbed":    c.insertContent({ type: "clipEmbed", attrs: { id: cmd.id } }).run(); break;
          case "groupEmbed":   c.insertContent({ type: "groupRef", attrs: { name: cmd.name } }).run(); break;
        }
      },
      getMarkdown: () => (editor?.storage as any)?.markdown?.getMarkdown?.() ?? "",
      getActiveState: () => activeStateFor(editor),
      focus: () => editor?.commands.focus(),
    }), [editor]);

    // Reset when initial content changes (note switch).
    useEffect(() => {
      if (!editor) return;
      const current = (editor.storage as any).markdown?.getMarkdown?.() ?? "";
      if (current !== initialMarkdown) {
        editor.commands.setContent(initialMarkdown, { emitUpdate: false });
      }
    }, [editor, initialMarkdown]);

    return <EditorContent editor={editor} className="ee-rich-shell" />;
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
  else if (editor.isActive("blockquote")) blockKind = "bq";
  else if (editor.isActive("taskItem")) blockKind = "todo";
  else if (editor.isActive("bulletList")) blockKind = "ul";
  else if (editor.isActive("orderedList")) blockKind = "ol";
  else if (editor.isActive("codeBlock")) blockKind = "code";
  return {
    bold:   editor.isActive("bold"),
    italic: editor.isActive("italic"),
    strike: editor.isActive("strike"),
    code:   editor.isActive("code"),
    blockKind,
  };
}
