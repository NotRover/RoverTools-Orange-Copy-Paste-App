// ── Editor Engine — Textarea format actions ───────────────────────────────
// Pure functions that compute (next value, next selection) given the current
// textarea state and a FormatAction. Kept side-effect free so they can be
// tested in isolation; the editor component applies the result.

import type { FormatAction, BlockKind } from "./types";

export interface TextareaState {
  value: string;
  selStart: number;
  selEnd: number;
}

export interface ApplyResult {
  value: string;
  selStart: number;
  selEnd: number;
}

export function applyAction(state: TextareaState, action: FormatAction): ApplyResult {
  switch (action.kind) {
    case "wrap":       return wrap(state, action.before, action.after, action.placeholder);
    case "linePrefix": return linePrefix(state, action.prefix, action.togglePrefixes);
    case "fence":      return fence(state, action.lang);
    case "insert":     return insertAt(state, action.text);
    case "link":       return wrap(state, "[", `](${action.url})`, action.text ?? "link");
    case "hr":         return insertBlock(state, "\n---\n");
  }
}

// ── Wrap selection (bold, italic, code, etc.) ─────────────────────────────

function wrap(s: TextareaState, before: string, after: string, placeholder = ""): ApplyResult {
  const sel = s.value.slice(s.selStart, s.selEnd);
  // Toggle: if the selection is already wrapped, unwrap it.
  if (
    sel.length === 0 &&
    s.value.slice(s.selStart - before.length, s.selStart) === before &&
    s.value.slice(s.selEnd, s.selEnd + after.length) === after
  ) {
    const value = s.value.slice(0, s.selStart - before.length) + s.value.slice(s.selEnd + after.length);
    const pos = s.selStart - before.length;
    return { value, selStart: pos, selEnd: pos };
  }
  if (sel.length > 0 && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    const value = s.value.slice(0, s.selStart) + inner + s.value.slice(s.selEnd);
    return { value, selStart: s.selStart, selEnd: s.selStart + inner.length };
  }
  const inner = sel.length ? sel : placeholder;
  const insert = before + inner + after;
  const value = s.value.slice(0, s.selStart) + insert + s.value.slice(s.selEnd);
  if (sel.length) {
    return {
      value,
      selStart: s.selStart + before.length,
      selEnd:   s.selStart + before.length + inner.length,
    };
  }
  // No selection: place caret inside markers, or select placeholder if any.
  const caret = s.selStart + before.length;
  return { value, selStart: caret, selEnd: caret + inner.length };
}

// ── Per-line prefix (heading, quote, list, todo) ──────────────────────────

function linePrefix(
  s: TextareaState,
  prefix: string,
  togglePrefixes: string[] = [prefix],
): ApplyResult {
  const { lineStart, lineEnd } = expandToLines(s.value, s.selStart, s.selEnd);
  const block = s.value.slice(lineStart, lineEnd);
  const lines = block.split("\n");

  // If every non-empty line already starts with `prefix`, strip it.
  const allHavePrefix = lines.every((ln) => ln.length === 0 || ln.startsWith(prefix));
  let nextLines: string[];
  if (allHavePrefix) {
    nextLines = lines.map((ln) => (ln.startsWith(prefix) ? ln.slice(prefix.length) : ln));
  } else {
    // Strip any of the toggle-equivalents first, then add the new prefix.
    nextLines = lines.map((ln) => {
      let stripped = ln;
      for (const p of togglePrefixes) {
        if (stripped.startsWith(p)) { stripped = stripped.slice(p.length); break; }
      }
      // Numbered-list cleanup (any leading "N. ").
      stripped = stripped.replace(/^\d+\.\s/, "");
      return prefix + stripped;
    });
  }

  const next = nextLines.join("\n");
  const value = s.value.slice(0, lineStart) + next + s.value.slice(lineEnd);
  return { value, selStart: lineStart, selEnd: lineStart + next.length };
}

// ── Fenced code block ─────────────────────────────────────────────────────

function fence(s: TextareaState, lang = ""): ApplyResult {
  const sel = s.value.slice(s.selStart, s.selEnd);
  const open = "```" + lang + "\n";
  const close = "\n```";
  const block = open + (sel || "") + close;
  const before = needsLeadingNewline(s.value, s.selStart) ? "\n" : "";
  const after  = needsTrailingNewline(s.value, s.selEnd) ? "\n" : "";
  const insert = before + block + after;
  const value = s.value.slice(0, s.selStart) + insert + s.value.slice(s.selEnd);
  const inner = s.selStart + before.length + open.length;
  return { value, selStart: inner, selEnd: inner + sel.length };
}

// ── Plain insert / block insert ───────────────────────────────────────────

function insertAt(s: TextareaState, text: string): ApplyResult {
  const value = s.value.slice(0, s.selStart) + text + s.value.slice(s.selEnd);
  const pos = s.selStart + text.length;
  return { value, selStart: pos, selEnd: pos };
}

function insertBlock(s: TextareaState, text: string): ApplyResult {
  const before = needsLeadingNewline(s.value, s.selStart) ? "" : "";
  const after  = needsTrailingNewline(s.value, s.selEnd) ? "\n" : "";
  return insertAt(s, before + text + after);
}

// ── Block-kind detection (for toolbar active states) ──────────────────────

export function detectBlockKind(value: string, caret: number): BlockKind {
  const { lineStart, lineEnd } = expandToLines(value, caret, caret);
  const line = value.slice(lineStart, lineEnd);
  if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) return "hr";
  if (/^### /.test(line)) return "h3";
  if (/^## /.test(line))  return "h2";
  if (/^# /.test(line))   return "h1";
  if (/^>\s?/.test(line)) return "bq";
  if (/^\s*[-*+]\s\[x\]\s/i.test(line)) return "todoChecked";
  if (/^\s*[-*+]\s\[ \]\s/.test(line))  return "todo";
  if (/^\s*[-*+]\s/.test(line))         return "ul";
  if (/^\s*\d+\.\s/.test(line))         return "ol";
  // Inside fenced block?
  if (insideFence(value, caret)) return "code";
  return "p";
}

function insideFence(value: string, caret: number): boolean {
  const before = value.slice(0, caret);
  const fences = before.match(/^```/gm);
  return !!fences && fences.length % 2 === 1;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function expandToLines(value: string, start: number, end: number) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nl = value.indexOf("\n", end);
  const lineEnd = nl === -1 ? value.length : nl;
  return { lineStart, lineEnd };
}

function needsLeadingNewline(value: string, pos: number): boolean {
  if (pos === 0) return false;
  return value[pos - 1] !== "\n";
}

function needsTrailingNewline(value: string, pos: number): boolean {
  if (pos === value.length) return false;
  return value[pos] !== "\n";
}
