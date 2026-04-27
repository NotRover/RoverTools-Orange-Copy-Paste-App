// ── Editor Engine — Editor host (dual mode) ───────────────────────────────
// Hosts a normal (Tiptap) and a markdown (textarea) surface side-by-side.
// Markdown is the source of truth — both surfaces serialize to it; switching
// modes preserves the current content without needing a parent re-render.

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { ClipboardEntry } from "../../../../types";
import {
  applyAction,
  commandToAction,
  detectActiveState,
  detectBlockKind,
} from "./format-actions";
import type {
  EditorMode,
  EditorCommand,
  ActiveState,
  BlockKind,
} from "./types";
import RichEditor, { type RichEditorHandle } from "./RichEditor";
import { EmbedContextProvider } from "./embed-context";
import "./markdown.css";

export interface MarkdownEditorHandle {
  applyCommand: (cmd: EditorCommand) => void;
  insertText: (text: string) => void;
  insertClipEmbed: (id: string) => void;
  insertGroupEmbed: (name: string) => void;
  insertLink: (url: string, text?: string) => void;
  /** Snapshot the current selection so a picker can restore it later. */
  saveRange: () => void;
  getMarkdown: () => string;
  getActiveState: () => ActiveState;
  getBlockKind: () => BlockKind;
  setMode: (mode: EditorMode) => void;
  getMode: () => EditorMode;
  focus: () => void;
}

export interface MarkdownEditorProps {
  noteId: string;
  initialMarkdown: string;
  initialMode?: EditorMode;
  entries: ClipboardEntry[];
  onChange: (markdown: string) => void;
  onModeChange?: (mode: EditorMode) => void;
  onSelectionChange?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  (
    {
      noteId,
      initialMarkdown,
      initialMode = "normal",
      entries,
      onChange,
      onModeChange,
      onSelectionChange,
    },
    ref,
  ) => {
    const [mode, setModeState] = useState<EditorMode>(initialMode);

    const valueRef = useRef(initialMarkdown);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const richRef = useRef<RichEditorHandle>(null);
    const savedRangeRef = useRef<{ start: number; end: number } | null>(null);

    // Reset when noteId changes.
    useEffect(() => {
      valueRef.current = initialMarkdown;
      if (textareaRef.current) textareaRef.current.value = initialMarkdown;
    }, [noteId, initialMarkdown]);

    // ── Source-of-truth sync ────────────────────────────────────────────

    const handleRichChange = useCallback((md: string) => {
      valueRef.current = md;
      onChange(md);
    }, [onChange]);

    const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      valueRef.current = e.target.value;
      onChange(e.target.value);
    }, [onChange]);

    const switchMode = useCallback((next: EditorMode) => {
      if (next === mode) return;
      // Pull latest from the active surface so the new surface boots from it.
      if (mode === "normal") {
        const md = richRef.current?.getMarkdown();
        if (md != null) valueRef.current = md;
      } else {
        const ta = textareaRef.current;
        if (ta) valueRef.current = ta.value;
      }
      setModeState(next);
      onModeChange?.(next);
    }, [mode, onModeChange]);

    // ── Markdown-mode helpers ───────────────────────────────────────────

    const taSelection = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta) {
        return { value: valueRef.current, selStart: valueRef.current.length, selEnd: valueRef.current.length };
      }
      if (document.activeElement !== ta && savedRangeRef.current) {
        return { value: ta.value, selStart: savedRangeRef.current.start, selEnd: savedRangeRef.current.end };
      }
      return { value: ta.value, selStart: ta.selectionStart ?? 0, selEnd: ta.selectionEnd ?? 0 };
    }, []);

    const applyTaResult = useCallback((r: { value: string; selStart: number; selEnd: number }) => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.value = r.value;
      ta.setSelectionRange(r.selStart, r.selEnd);
      valueRef.current = r.value;
      onChange(r.value);
      ta.focus();
    }, [onChange]);

    // Smart Enter / Tab in textarea.
    const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const sel = taSelection();
        const indent = "  ";
        const lineStart =
          sel.value.lastIndexOf("\n", Math.max(0, sel.selStart - 1)) + 1;
        const nl = sel.value.indexOf("\n", sel.selEnd);
        const lineEnd = nl === -1 ? sel.value.length : nl;
        const block = sel.value.slice(lineStart, lineEnd);
        const lines = block.split("\n");
        const isList = (ln: string) =>
          /^(\s*)([-*+]\s|\d+\.\s)/.test(ln);
        if (e.shiftKey) {
          const next = lines
            .map((ln) => (ln.startsWith(indent) ? ln.slice(indent.length) : ln))
            .join("\n");
          const delta = block.length - next.length;
          applyTaResult({
            value: sel.value.slice(0, lineStart) + next + sel.value.slice(lineEnd),
            selStart: Math.max(lineStart, sel.selStart - indent.length),
            selEnd: Math.max(lineStart, sel.selEnd - delta),
          });
          return;
        }
        if (lines.some(isList) || lines.length > 1) {
          const next = lines.map((ln) => (ln.length ? indent + ln : ln)).join("\n");
          applyTaResult({
            value: sel.value.slice(0, lineStart) + next + sel.value.slice(lineEnd),
            selStart: sel.selStart + indent.length,
            selEnd: sel.selEnd + (next.length - block.length),
          });
          return;
        }
        applyTaResult({
          value: sel.value.slice(0, sel.selStart) + indent + sel.value.slice(sel.selEnd),
          selStart: sel.selStart + indent.length,
          selEnd: sel.selStart + indent.length,
        });
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "b" || k === "i" || k === "e") {
          e.preventDefault();
          const cmd: EditorCommand =
            k === "b" ? { kind: "bold" } : k === "i" ? { kind: "italic" } : { kind: "code" };
          const action = commandToAction(cmd);
          if (action) applyTaResult(applyAction(taSelection(), action));
          return;
        }
      }
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const ta = e.currentTarget;
      const value = ta.value;
      const caret = ta.selectionStart;
      const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
      const line = value.slice(lineStart, caret);
      const emptyTodo = /^(\s*)[-*+]\s\[[ xX]\]\s$/.exec(line);
      const emptyBullet = /^(\s*)[-*+]\s$/.exec(line);
      const emptyOrdered = /^(\s*)\d+\.\s$/.exec(line);
      if (emptyTodo || emptyBullet || emptyOrdered) {
        e.preventDefault();
        applyTaResult({
          value: value.slice(0, lineStart) + value.slice(caret),
          selStart: lineStart, selEnd: lineStart,
        });
        return;
      }
      const todo = /^(\s*)([-*+])\s\[([ xX])\]\s/.exec(line);
      if (todo) {
        e.preventDefault();
        const cont = `\n${todo[1]}${todo[2]} [ ] `;
        applyTaResult({ value: value.slice(0, caret) + cont + value.slice(caret), selStart: caret + cont.length, selEnd: caret + cont.length });
        return;
      }
      const bullet = /^(\s*)([-*+])\s/.exec(line);
      if (bullet) {
        e.preventDefault();
        const cont = `\n${bullet[1]}${bullet[2]} `;
        applyTaResult({ value: value.slice(0, caret) + cont + value.slice(caret), selStart: caret + cont.length, selEnd: caret + cont.length });
        return;
      }
      const ordered = /^(\s*)(\d+)\.\s/.exec(line);
      if (ordered) {
        e.preventDefault();
        const next = parseInt(ordered[2], 10) + 1;
        const cont = `\n${ordered[1]}${next}. `;
        applyTaResult({ value: value.slice(0, caret) + cont + value.slice(caret), selStart: caret + cont.length, selEnd: caret + cont.length });
      }
    }, [applyTaResult, taSelection]);

    // ── Imperative API ──────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      applyCommand: (cmd) => {
        if (mode === "normal") {
          richRef.current?.applyCommand(cmd);
        } else {
          const action = commandToAction(cmd);
          if (action) applyTaResult(applyAction(taSelection(), action));
        }
      },
      insertText: (text) => {
        if (mode === "normal") richRef.current?.applyCommand({ kind: "insertText", text });
        else applyTaResult(applyAction(taSelection(), { kind: "insert", text }));
      },
      insertClipEmbed: (id) => {
        if (mode === "normal") richRef.current?.applyCommand({ kind: "clipEmbed", id });
        else applyTaResult(applyAction(taSelection(), commandToAction({ kind: "clipEmbed", id })!));
      },
      insertGroupEmbed: (name) => {
        if (mode === "normal") richRef.current?.applyCommand({ kind: "groupEmbed", name });
        else applyTaResult(applyAction(taSelection(), commandToAction({ kind: "groupEmbed", name })!));
      },
      insertLink: (url, text) => {
        if (mode === "normal") richRef.current?.applyCommand({ kind: "link", url, text });
        else applyTaResult(applyAction(taSelection(), { kind: "link", url, text }));
      },
      saveRange: () => {
        const ta = textareaRef.current;
        if (ta) savedRangeRef.current = { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 };
      },
      getMarkdown: () => {
        if (mode === "normal") return richRef.current?.getMarkdown() ?? valueRef.current;
        return textareaRef.current?.value ?? valueRef.current;
      },
      getActiveState: () => {
        if (mode === "normal") return richRef.current?.getActiveState() ?? { blockKind: "p" };
        const sel = taSelection();
        return detectActiveState(sel.value, sel.selStart, sel.selEnd);
      },
      getBlockKind: () => {
        if (mode === "normal") return richRef.current?.getActiveState().blockKind ?? "p";
        const sel = taSelection();
        return detectBlockKind(sel.value, sel.selStart);
      },
      setMode: (m) => switchMode(m),
      getMode: () => mode,
      focus: () => {
        if (mode === "normal") richRef.current?.focus();
        else textareaRef.current?.focus();
      },
    }), [mode, applyTaResult, taSelection, switchMode]);

    // ── Render ──────────────────────────────────────────────────────────

    return (
      <div className="ee-shell" data-mode={mode}>
        <EmbedContextProvider entries={entries}>
          {mode === "normal" ? (
            <RichEditor
              key={noteId}
              ref={richRef}
              initialMarkdown={valueRef.current}
              onChange={handleRichChange}
              onSelectionChange={onSelectionChange}
              placeholder="Start writing…"
            />
          ) : (
            <textarea
              ref={textareaRef}
              className="ee-textarea"
              defaultValue={valueRef.current}
              spellCheck
              onChange={handleTextareaChange}
              onKeyDown={handleTextareaKeyDown}
              onSelect={onSelectionChange}
              placeholder="Write in markdown — # heading, **bold**, - list, > quote, ```code```"
            />
          )}
        </EmbedContextProvider>
      </div>
    );
  },
);

MarkdownEditor.displayName = "MarkdownEditor";

export default MarkdownEditor;
