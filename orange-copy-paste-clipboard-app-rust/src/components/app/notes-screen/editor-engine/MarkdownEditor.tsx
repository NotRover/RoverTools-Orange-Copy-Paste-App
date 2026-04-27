// ── Editor Engine — Markdown editor (dual mode) ───────────────────────────
// Source mode: a plain <textarea> with markdown. Format actions operate on
// the current selection. Preview mode: rendered via MarkdownPreview.
// Mode is owned externally so the toolbar can mirror it.

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type { ClipboardEntry } from "../../../../types";
import { applyAction, detectBlockKind } from "./format-actions";
import type { FormatAction, BlockKind, EditorMode } from "./types";
import MarkdownPreview from "./MarkdownPreview";
import "./markdown.css";

export interface MarkdownEditorHandle {
  /** Apply a format action (or any of the pre-baked toolbar actions). */
  applyFormat: (action: FormatAction) => void;
  /** Insert literal text at caret. */
  insertText: (text: string) => void;
  /** Insert a clip embed chip at caret. */
  insertClipEmbed: (id: string) => void;
  /** Insert a group reference chip at caret. */
  insertGroupEmbed: (name: string) => void;
  /** Wrap selection in a markdown link. */
  insertLink: (url: string, text?: string) => void;
  /** Persist the current textarea selection so pickers can restore it. */
  saveRange: () => void;
  /** Get the current markdown — used for flush-on-close. */
  getMarkdown: () => string;
  /** Block kind under the caret (for toolbar active state). */
  getBlockKind: () => BlockKind;
  /** Focus the textarea. */
  focus: () => void;
}

export interface MarkdownEditorProps {
  noteId: string;
  initialMarkdown: string;
  entries: ClipboardEntry[];
  mode: EditorMode;
  onChange: (markdown: string) => void;
  onSelectionChange?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  ({ noteId, initialMarkdown, entries, mode, onChange, onSelectionChange }, ref) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const valueRef = useRef(initialMarkdown);
    const savedRangeRef = useRef<{ start: number; end: number } | null>(null);

    // Reset when switching notes.
    useEffect(() => {
      valueRef.current = initialMarkdown;
      if (textareaRef.current) textareaRef.current.value = initialMarkdown;
    }, [noteId, initialMarkdown]);

    // ── Mutations on textarea ───────────────────────────────────────────

    const applyResult = useCallback(
      (result: { value: string; selStart: number; selEnd: number }) => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.value = result.value;
        ta.setSelectionRange(result.selStart, result.selEnd);
        valueRef.current = result.value;
        onChange(result.value);
        ta.focus();
      },
      [onChange],
    );

    const currentSelection = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta) return { value: valueRef.current, selStart: valueRef.current.length, selEnd: valueRef.current.length };
      // Restore saved range if textarea isn't focused (picker re-focus flow).
      if (document.activeElement !== ta && savedRangeRef.current) {
        return { value: ta.value, selStart: savedRangeRef.current.start, selEnd: savedRangeRef.current.end };
      }
      return { value: ta.value, selStart: ta.selectionStart ?? 0, selEnd: ta.selectionEnd ?? 0 };
    }, []);

    // ── Smart Enter (continue lists / todos) ────────────────────────────

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Tab indents in lists, otherwise inserts two spaces.
      if (e.key === "Tab") {
        e.preventDefault();
        const sel = currentSelection();
        const insert = "  ";
        applyResult({
          value: sel.value.slice(0, sel.selStart) + insert + sel.value.slice(sel.selEnd),
          selStart: sel.selStart + insert.length,
          selEnd: sel.selStart + insert.length,
        });
        return;
      }
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const ta = e.currentTarget;
      const value = ta.value;
      const caret = ta.selectionStart;
      const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
      const line = value.slice(lineStart, caret);

      // Empty list item → exit the list.
      const emptyTodo = /^(\s*)[-*+]\s\[[ xX]\]\s$/.exec(line);
      const emptyBullet = /^(\s*)[-*+]\s$/.exec(line);
      const emptyOrdered = /^(\s*)\d+\.\s$/.exec(line);
      if (emptyTodo || emptyBullet || emptyOrdered) {
        e.preventDefault();
        applyResult({
          value: value.slice(0, lineStart) + value.slice(caret),
          selStart: lineStart,
          selEnd: lineStart,
        });
        return;
      }

      // Continue list / todo on next line.
      const todo = /^(\s*)([-*+])\s\[([ xX])\]\s/.exec(line);
      if (todo) {
        e.preventDefault();
        const cont = `\n${todo[1]}${todo[2]} [ ] `;
        applyResult({
          value: value.slice(0, caret) + cont + value.slice(caret),
          selStart: caret + cont.length,
          selEnd: caret + cont.length,
        });
        return;
      }
      const bullet = /^(\s*)([-*+])\s/.exec(line);
      if (bullet) {
        e.preventDefault();
        const cont = `\n${bullet[1]}${bullet[2]} `;
        applyResult({
          value: value.slice(0, caret) + cont + value.slice(caret),
          selStart: caret + cont.length,
          selEnd: caret + cont.length,
        });
        return;
      }
      const ordered = /^(\s*)(\d+)\.\s/.exec(line);
      if (ordered) {
        e.preventDefault();
        const next = parseInt(ordered[2], 10) + 1;
        const cont = `\n${ordered[1]}${next}. `;
        applyResult({
          value: value.slice(0, caret) + cont + value.slice(caret),
          selStart: caret + cont.length,
          selEnd: caret + cont.length,
        });
      }
    }, [applyResult, currentSelection]);

    // Keyboard shortcuts: Ctrl+B / I / K.
    const handleShortcut = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "b") { e.preventDefault(); applyResult(applyAction(currentSelection(), { kind: "wrap", before: "**", after: "**", placeholder: "bold" })); }
      else if (key === "i") { e.preventDefault(); applyResult(applyAction(currentSelection(), { kind: "wrap", before: "*", after: "*", placeholder: "italic" })); }
      else if (key === "e") { e.preventDefault(); applyResult(applyAction(currentSelection(), { kind: "wrap", before: "`", after: "`", placeholder: "code" })); }
    }, [applyResult, currentSelection]);

    const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      handleShortcut(e);
      if (e.defaultPrevented) return;
      handleKeyDown(e);
    }, [handleKeyDown, handleShortcut]);

    // ── Imperative API ──────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      applyFormat: (action) => {
        applyResult(applyAction(currentSelection(), action));
      },
      insertText: (text) => {
        applyResult(applyAction(currentSelection(), { kind: "insert", text }));
      },
      insertClipEmbed: (id) => {
        const html = `<span data-clip-embed="${escAttr(id)}"></span>`;
        applyResult(applyAction(currentSelection(), { kind: "insert", text: html }));
      },
      insertGroupEmbed: (name) => {
        const html = `<span data-group-ref="${escAttr(name)}"></span>`;
        applyResult(applyAction(currentSelection(), { kind: "insert", text: html }));
      },
      insertLink: (url, text) => {
        applyResult(applyAction(currentSelection(), { kind: "link", url, text }));
      },
      saveRange: () => {
        const ta = textareaRef.current;
        if (!ta) return;
        savedRangeRef.current = { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 };
      },
      getMarkdown: () => valueRef.current,
      getBlockKind: () => {
        const sel = currentSelection();
        return detectBlockKind(sel.value, sel.selStart);
      },
      focus: () => {
        textareaRef.current?.focus();
      },
    }), [applyResult, currentSelection]);

    // ── Change handler ──────────────────────────────────────────────────

    const onTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      valueRef.current = e.target.value;
      onChange(e.target.value);
    }, [onChange]);

    const onSelect = useCallback(() => {
      onSelectionChange?.();
    }, [onSelectionChange]);

    // ── Render ──────────────────────────────────────────────────────────

    const markdownForPreview = mode === "preview" ? valueRef.current : "";

    return (
      <div className="ee-shell">
        {mode === "source" ? (
          <textarea
            ref={textareaRef}
            className="ee-textarea"
            defaultValue={valueRef.current}
            spellCheck
            onChange={onTextareaChange}
            onKeyDown={onKeyDown}
            onSelect={onSelect}
            placeholder="Write in markdown — # heading, **bold**, - list, > quote, ```code```"
          />
        ) : (
          <MarkdownPreview markdown={markdownForPreview} entries={entries} className="ee-preview--full" />
        )}
      </div>
    );
  },
);

MarkdownEditor.displayName = "MarkdownEditor";

export default MarkdownEditor;

// ── Helpers ───────────────────────────────────────────────────────────────

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Re-exports ────────────────────────────────────────────────────────────

export { applyAction, detectBlockKind } from "./format-actions";
export type { FormatAction, BlockKind, EditorMode } from "./types";
