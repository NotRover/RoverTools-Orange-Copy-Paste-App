// ── Editor Engine — Editor host (dual mode) ───────────────────────────────
// Hosts a normal (Tiptap) and a markdown (textarea) surface side-by-side.
// Markdown is the source of truth — both surfaces serialize to it; switching
// modes preserves the current content without needing a parent re-render.

import React, {
  Component,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

// ── Error boundary — prevents a Tiptap crash from blanking the entire screen
class RichEditorBoundary extends Component<
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
    console.error("[RichEditor]", err);
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
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

    const handleRichChange = useCallback(
      (md: string) => {
        valueRef.current = md;
        onChange(md);
      },
      [onChange],
    );

    const handleTextareaChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        valueRef.current = e.target.value;
        onChange(e.target.value);
      },
      [onChange],
    );

    const switchMode = useCallback(
      (next: EditorMode) => {
        if (next === mode) return;
        // Pull latest from the active surface so the new surface boots from it.
        if (mode === "normal") {
          const md = richRef.current?.getMarkdown();
          if (md != null) valueRef.current = md;
        } else {
          const ta = textareaRef.current;
          if (ta) valueRef.current = normalizeIndentMarkdown(ta.value);
        }
        setModeState(next);
        onModeChange?.(next);
      },
      [mode, onModeChange],
    );

    // ── Markdown-mode helpers ───────────────────────────────────────────

    const taSelection = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta) {
        return {
          value: valueRef.current,
          selStart: valueRef.current.length,
          selEnd: valueRef.current.length,
        };
      }
      if (document.activeElement !== ta && savedRangeRef.current) {
        return {
          value: ta.value,
          selStart: savedRangeRef.current.start,
          selEnd: savedRangeRef.current.end,
        };
      }
      return {
        value: ta.value,
        selStart: ta.selectionStart ?? 0,
        selEnd: ta.selectionEnd ?? 0,
      };
    }, []);

    // Apply a computed (value, selection) to the textarea while preserving
    // native browser undo. `execCommand("insertText")` is the only path that
    // pushes the change onto the textarea's undo stack — direct `.value =`
    // assignment wipes it. We compute the minimal diff between old and new
    // values so each format becomes one undo step covering only the change.
    const applyTaResult = useCallback(
      (r: { value: string; selStart: number; selEnd: number }) => {
        const ta = textareaRef.current;
        if (!ta) return;
        const old = ta.value;
        ta.focus();
        if (old !== r.value) {
          let prefix = 0;
          const minLen = Math.min(old.length, r.value.length);
          while (prefix < minLen && old[prefix] === r.value[prefix]) prefix++;
          let suffix = 0;
          while (
            suffix < old.length - prefix &&
            suffix < r.value.length - prefix &&
            old[old.length - 1 - suffix] === r.value[r.value.length - 1 - suffix]
          ) {
            suffix++;
          }
          const replaceStart = prefix;
          const replaceEnd = old.length - suffix;
          const insertText = r.value.slice(prefix, r.value.length - suffix);
          ta.setSelectionRange(replaceStart, replaceEnd);
          let ok = false;
          try {
            ok = document.execCommand("insertText", false, insertText);
          } catch {
            ok = false;
          }
          // Some browsers/contexts return false; fall back to direct write.
          if (!ok || ta.value !== r.value) {
            ta.value = r.value;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        ta.setSelectionRange(r.selStart, r.selEnd);
        valueRef.current = r.value;
        onChange(r.value);
      },
      [onChange],
    );

    // Smart Enter / Tab in textarea.
    const handleTextareaKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const sel = taSelection();
          const indent = "\u00A0\u00A0\u00A0\u00A0";
          const plainIndent = "    ";
          const lineStart =
            sel.value.lastIndexOf("\n", Math.max(0, sel.selStart - 1)) + 1;
          const nl = sel.value.indexOf("\n", sel.selEnd);
          const lineEnd = nl === -1 ? sel.value.length : nl;
          const block = sel.value.slice(lineStart, lineEnd);
          const lines = block.split("\n");
          const isList = (ln: string) => /^(\s*)([-*+]\s|\d+\.\s)/.test(ln);
          const stripIndent = (ln: string) => {
            if (ln.startsWith(indent)) return ln.slice(indent.length);
            if (ln.startsWith(plainIndent)) return ln.slice(plainIndent.length);
            return ln;
          };
          if (e.shiftKey) {
            const next = lines.map(stripIndent).join("\n");
            const delta = block.length - next.length;
            applyTaResult({
              value:
                sel.value.slice(0, lineStart) + next + sel.value.slice(lineEnd),
              selStart: Math.max(lineStart, sel.selStart - indent.length),
              selEnd: Math.max(lineStart, sel.selEnd - delta),
            });
            return;
          }
          if (lines.some(isList) || lines.length > 1) {
            const next = lines
              .map((ln) => (ln.length ? indent + ln : ln))
              .join("\n");
            applyTaResult({
              value:
                sel.value.slice(0, lineStart) + next + sel.value.slice(lineEnd),
              selStart: sel.selStart + indent.length,
              selEnd: sel.selEnd + (next.length - block.length),
            });
            return;
          }
          applyTaResult({
            value:
              sel.value.slice(0, sel.selStart) +
              indent +
              sel.value.slice(sel.selEnd),
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
              k === "b"
                ? { kind: "bold" }
                : k === "i"
                  ? { kind: "italic" }
                  : { kind: "code" };
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
            selStart: lineStart,
            selEnd: lineStart,
          });
          return;
        }
        const todo = /^(\s*)([-*+])\s\[([ xX])\]\s/.exec(line);
        if (todo) {
          e.preventDefault();
          const cont = `\n${todo[1]}${todo[2]} [ ] `;
          applyTaResult({
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
          applyTaResult({
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
          applyTaResult({
            value: value.slice(0, caret) + cont + value.slice(caret),
            selStart: caret + cont.length,
            selEnd: caret + cont.length,
          });
        }
      },
      [applyTaResult, taSelection],
    );

    // ── Imperative API ──────────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        applyCommand: (cmd) => {
          if (mode === "normal") {
            richRef.current?.applyCommand(cmd);
          } else {
            const action = commandToAction(cmd);
            if (action) applyTaResult(applyAction(taSelection(), action));
          }
        },
        insertText: (text) => {
          if (mode === "normal")
            richRef.current?.applyCommand({ kind: "insertText", text });
          else
            applyTaResult(applyAction(taSelection(), { kind: "insert", text }));
        },
        insertClipEmbed: (id) => {
          if (mode === "normal")
            richRef.current?.applyCommand({ kind: "clipEmbed", id });
          else
            applyTaResult(
              applyAction(
                taSelection(),
                commandToAction({ kind: "clipEmbed", id })!,
              ),
            );
        },
        insertGroupEmbed: (name) => {
          if (mode === "normal")
            richRef.current?.applyCommand({ kind: "groupEmbed", name });
          else
            applyTaResult(
              applyAction(
                taSelection(),
                commandToAction({ kind: "groupEmbed", name })!,
              ),
            );
        },
        insertLink: (url, text) => {
          if (mode === "normal")
            richRef.current?.applyCommand({ kind: "link", url, text });
          else
            applyTaResult(
              applyAction(taSelection(), { kind: "link", url, text }),
            );
        },
        saveRange: () => {
          const ta = textareaRef.current;
          if (ta)
            savedRangeRef.current = {
              start: ta.selectionStart ?? 0,
              end: ta.selectionEnd ?? 0,
            };
        },
        getMarkdown: () => {
          if (mode === "normal")
            return richRef.current?.getMarkdown() ?? valueRef.current;
          return textareaRef.current?.value ?? valueRef.current;
        },
        getActiveState: () => {
          if (mode === "normal")
            return richRef.current?.getActiveState() ?? { blockKind: "p" };
          const sel = taSelection();
          return detectActiveState(sel.value, sel.selStart, sel.selEnd);
        },
        getBlockKind: () => {
          if (mode === "normal")
            return richRef.current?.getActiveState().blockKind ?? "p";
          const sel = taSelection();
          return detectBlockKind(sel.value, sel.selStart);
        },
        setMode: (m) => switchMode(m),
        getMode: () => mode,
        focus: () => {
          if (mode === "normal") richRef.current?.focus();
          else textareaRef.current?.focus();
        },
      }),
      [mode, applyTaResult, taSelection, switchMode],
    );

    // ── Render ──────────────────────────────────────────────────────────

    return (
      <div className="ee-shell" data-mode={mode}>
        <EmbedContextProvider entries={entries}>
          {mode === "normal" ? (
            <RichEditorBoundary
              fallback={
                <div
                  style={{
                    padding: "14px 18px",
                    color: "var(--text-muted)",
                    fontSize: 13,
                  }}
                >
                  Editor failed to load. Switch to Markdown mode to continue
                  editing.
                </div>
              }
            >
              <RichEditor
                key={noteId}
                ref={richRef}
                initialMarkdown={valueRef.current}
                onChange={handleRichChange}
                onSelectionChange={onSelectionChange}
                placeholder="Start writing…"
              />
            </RichEditorBoundary>
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

function normalizeIndentMarkdown(markdown: string): string {
  let out = markdown;
  if (out.includes("    ")) {
    const lines = out.split("\n");
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
    out = lines.join("\n");
  }
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

MarkdownEditor.displayName = "MarkdownEditor";

export default MarkdownEditor;
