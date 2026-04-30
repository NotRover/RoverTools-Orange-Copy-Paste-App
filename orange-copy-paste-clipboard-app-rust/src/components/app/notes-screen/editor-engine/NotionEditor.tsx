// ── Editor Engine — Notion-like Tiptap editor ────────────────────────────
// Single editable surface. Storage is ProseMirror JSON serialised to a string.

import {
  Component,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Extension, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { invoke } from "@tauri-apps/api/core";
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
import {
  Details,
  DetailsContent,
  DetailsSummary,
} from "@tiptap/extension-details";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { offset as floatingOffset } from "@floating-ui/dom";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  imageAttachmentUrl,
  resolveAttachmentUrl,
  subscribeAttachmentResolver,
} from "./attachment-url";
import { ClipEmbed } from "./extensions/ClipEmbed";
import { GroupRef } from "./extensions/GroupRef";
import { Callout } from "./extensions/Callout";
import { parseStoredContent, serializeDoc } from "./content-codec";
import type { ClipboardEntry } from "../../../../types";
import { EmbedContextProvider } from "./embed-context";
import type {
  EditorCommand,
  ActiveState,
  BlockKind,
  AlignValue,
} from "./types";

const lowlight = createLowlight(common);

export interface NotionEditorHandle {
  applyCommand: (cmd: EditorCommand) => void;
  insertText: (text: string) => void;
  insertClipEmbed: (id: string) => void;
  insertGroupEmbed: (name: string) => void;
  insertLink: (url: string, text?: string) => void;
  saveRange: () => void;
  getContent: () => string;
  getActiveState: () => ActiveState;
  getBlockKind: () => BlockKind;
  focus: () => void;
}

export interface NotionEditorProps {
  noteId: string;
  /** Stored content string — Tiptap JSON. */
  initialContent: string;
  entries: ClipboardEntry[];
  /** Fires on every edit with the current content as a JSON string. */
  onChange: (content: string) => void;
  onSelectionChange?: () => void;
}

// ── Error boundary ───────────────────────────────────────────────────────

class EditorBoundary extends Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: unknown) {
    console.error("[NotionEditor]", err);
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

// ── DOM-only attachment URL resolution for images / links ────────────────

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
    if (typeof attrs.href === "string")
      attrs.href = resolveAttachmentUrl(attrs.href);
    return ["a", mergeAttributes(this.options.HTMLAttributes, attrs), 0];
  },
});

// Tab/Shift-Tab — sink/lift list items, otherwise insert/remove indent.
const IndentExtension = Extension.create({
  name: "indent",
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const { editor } = this;
        if (editor.can().sinkListItem("listItem"))
          return editor.commands.sinkListItem("listItem");
        if (editor.can().sinkListItem("taskItem"))
          return editor.commands.sinkListItem("taskItem");
        return false;
      },
      "Shift-Tab": () => {
        const { editor } = this;
        if (editor.can().liftListItem("listItem"))
          return editor.commands.liftListItem("listItem");
        if (editor.can().liftListItem("taskItem"))
          return editor.commands.liftListItem("taskItem");
        return false;
      },
    };
  },
});

// ── Component ────────────────────────────────────────────────────────────

const NotionEditorInner = forwardRef<NotionEditorHandle, NotionEditorProps>(
  ({ noteId, initialContent, onChange, onSelectionChange }, ref) => {
    const [tableHandlePos, setTableHandlePos] = useState<{
      visible: boolean;
      colX: number;
      colY: number;
      rowX: number;
      rowY: number;
    }>({ visible: false, colX: 0, colY: 0, rowX: 0, rowY: 0 });
    const [hoverNode, setHoverNode] = useState<{ node: PMNode; pos: number } | null>(null);

    const updateTableHandlePos = useCallback(
      (nextEditor: Editor | null) => {
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
        setTableHandlePos({
          visible: true,
          colX: clamp(table.right + edgeGap, box.left + 10, box.right - 10),
          colY: clamp(table.top + table.height / 2, box.top + 22, box.bottom - 22),
          rowX: clamp(table.left + table.width / 2, box.left + 22, box.right - 22),
          rowY: clamp(table.bottom + edgeGap, box.top + 10, box.bottom - 10),
        });
      },
      [],
    );

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          codeBlock: false, // replaced by CodeBlockLowlight
        }),
        Underline,
        ResolvedLink.configure({ openOnClick: false, autolink: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({
          placeholder: ({ node }) => {
            if (node.type.name === "heading") return "Heading";
            if (node.type.name === "detailsSummary") return "Toggle title";
            if (node.type.name === "codeBlock") return "";
            return "Type something — or press Enter to start a new block";
          },
          showOnlyCurrent: false,
          includeChildren: true,
        }),
        TextAlign.configure({
          types: ["heading", "paragraph"],
          alignments: ["left", "center", "right", "justify"],
          defaultAlignment: "left",
        }),
        TextStyle,
        Color,
        Highlight.configure({ multicolor: true }),
        Details.configure({
          persist: true,
          openClassName: "is-open",
          HTMLAttributes: { class: "ee-details" },
        }),
        DetailsSummary,
        DetailsContent,
        CodeBlockLowlight.configure({
          lowlight,
          HTMLAttributes: { class: "ee-codeblock" },
        }),
        Callout,
        ClipEmbed,
        GroupRef,
        IndentExtension,
        ResolvedImage.configure({ inline: false, allowBase64: true }),
      ],
      content: parseStoredContent(initialContent),
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
        onChange(serializeDoc(editor.getJSON()));
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
            case "underline":
              c.toggleUnderline().run();
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
            case "callout":
              c.toggleCallout(cmd.tone ?? "info").run();
              break;
            case "toggle":
              if (editor.isActive("details"))
                c.unsetDetails().run();
              else c.setDetails().run();
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
              c.toggleCodeBlock(cmd.language ? { language: cmd.language } : undefined).run();
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
            case "image":
              c.insertContent({
                type: "image",
                attrs: { src: cmd.src, alt: cmd.alt ?? null },
              }).run();
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
              c.insertContent({ type: "clipEmbed", attrs: { id: cmd.id } }).run();
              break;
            case "groupEmbed":
              c.insertContent({ type: "groupRef", attrs: { name: cmd.name } }).run();
              break;
          }
        },
        insertText: (text) =>
          editor?.chain().focus().insertContent(text).run(),
        insertClipEmbed: (id) =>
          editor
            ?.chain()
            .focus()
            .insertContent({ type: "clipEmbed", attrs: { id } })
            .run(),
        insertGroupEmbed: (name) =>
          editor
            ?.chain()
            .focus()
            .insertContent({ type: "groupRef", attrs: { name } })
            .run(),
        insertLink: (url, text) => {
          if (!editor) return;
          const { empty } = editor.state.selection;
          const c = editor.chain().focus();
          if (empty) {
            const t = (text && text.trim()) || url;
            c.insertContent({
              type: "text",
              text: t,
              marks: [{ type: "link", attrs: { href: url } }],
            }).run();
          } else if (text && text.trim()) {
            c.insertContent({
              type: "text",
              text,
              marks: [{ type: "link", attrs: { href: url } }],
            }).run();
          } else {
            c.extendMarkRange("link").setLink({ href: url }).run();
          }
        },
        saveRange: () => {
          // No-op: Tiptap restores its own selection on focus.
        },
        getContent: () => {
          if (!editor) return initialContent ?? "";
          return serializeDoc(editor.getJSON());
        },
        getActiveState: () => activeStateFor(editor),
        getBlockKind: () => activeStateFor(editor).blockKind,
        focus: () => editor?.commands.focus(),
      }),
      [editor, initialContent],
    );

    // Reset content when noteId changes.
    useEffect(() => {
      if (!editor) return;
      editor.commands.setContent(parseStoredContent(initialContent), {
        emitUpdate: false,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId]);

    // Refresh image/link DOM once the attachment resolver finishes loading.
    useEffect(() => {
      if (!editor) return;
      return subscribeAttachmentResolver(() => {
        const json = editor.getJSON();
        editor.commands.setContent(json, { emitUpdate: false });
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

    const insertBlockBelow = useCallback(() => {
      if (!editor || !hoverNode) return;
      const after = hoverNode.pos + hoverNode.node.nodeSize;
      editor
        .chain()
        .focus()
        .insertContentAt(after, { type: "paragraph" })
        .setTextSelection(after + 1)
        .run();
    }, [editor, hoverNode]);

    return (
      <>
        <EditorContent editor={editor} className="ee-rich-shell" />
        {editor && (
          <DragHandle
            editor={editor}
            className="ee-drag-handle"
            nested
            computePositionConfig={{
              placement: "left-start",
              strategy: "absolute",
              middleware: [floatingOffset({ mainAxis: 6, crossAxis: 2 })],
            }}
            onNodeChange={({ node, pos }) => {
              if (node) setHoverNode({ node, pos });
              else setHoverNode(null);
            }}
          >
            <div className="ee-block-handles">
              <span
                className="ee-block-handle ee-block-handle--drag"
                title="Drag to move block"
                aria-label="Drag block"
              >
                <DotsSixVerticalIcon size={14} weight="bold" />
              </span>
              <button
                type="button"
                className="ee-block-handle ee-block-handle--add"
                draggable={false}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  insertBlockBelow();
                }}
                title="Insert block below"
                aria-label="Insert block"
              >
                +
              </button>
            </div>
          </DragHandle>
        )}
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
NotionEditorInner.displayName = "NotionEditorInner";

const NotionEditor = forwardRef<NotionEditorHandle, NotionEditorProps>(
  (props, ref) => {
    return (
      <div className="ee-shell">
        <EmbedContextProvider entries={props.entries}>
          <EditorBoundary
            fallback={
              <div
                style={{
                  padding: "14px 18px",
                  color: "var(--text-muted)",
                  fontSize: 13,
                }}
              >
                Editor failed to load. Reopen the note to retry.
              </div>
            }
          >
            <NotionEditorInner {...props} ref={ref} key={props.noteId} />
          </EditorBoundary>
        </EmbedContextProvider>
      </div>
    );
  },
);
NotionEditor.displayName = "NotionEditor";

export default NotionEditor;

// ── Helpers ───────────────────────────────────────────────────────────────

function activeStateFor(editor: Editor | null): ActiveState {
  if (!editor) return { blockKind: "p" };
  let blockKind: BlockKind = "p";
  if (editor.isActive("heading", { level: 1 })) blockKind = "h1";
  else if (editor.isActive("heading", { level: 2 })) blockKind = "h2";
  else if (editor.isActive("heading", { level: 3 })) blockKind = "h3";
  else if (editor.isActive("heading", { level: 4 })) blockKind = "h4";
  else if (editor.isActive("heading", { level: 5 })) blockKind = "h5";
  else if (editor.isActive("callout")) blockKind = "callout";
  else if (editor.isActive("details")) blockKind = "toggle";
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
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    inTable: editor.isActive("table"),
    blockKind,
    align,
    textColor: typeof colorAttr === "string" ? colorAttr : undefined,
    highlight: typeof highlightAttr === "string" ? highlightAttr : undefined,
  };
}

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
