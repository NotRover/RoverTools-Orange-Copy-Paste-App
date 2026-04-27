// ── Editor Engine — Markdown-mode (textarea) format actions ───────────────
// Pure functions that compute (next value, next selection) given the current
// textarea state and a FormatAction.

import type { FormatAction, BlockKind, EditorCommand, ActiveState } from "./types";

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
    case "hr":         return insertAt(state, "\n\n---\n\n");
  }
}

// ── EditorCommand → FormatAction (markdown-mode dispatch) ─────────────────

const ALL_LINE_PREFIXES = ["# ", "## ", "### ", "> ", "- [ ] ", "- [x] ", "- ", "* ", "+ "];

export function commandToAction(cmd: EditorCommand): FormatAction | null {
  switch (cmd.kind) {
    case "bold":         return { kind: "wrap", before: "**", after: "**", placeholder: "bold" };
    case "italic":       return { kind: "wrap", before: "*",  after: "*",  placeholder: "italic" };
    case "strike":       return { kind: "wrap", before: "~~", after: "~~", placeholder: "strike" };
    case "code":         return { kind: "wrap", before: "`",  after: "`",  placeholder: "code" };
    case "heading":      return { kind: "linePrefix", prefix: "#".repeat(cmd.level) + " ", togglePrefixes: ALL_LINE_PREFIXES };
    case "paragraph":    return { kind: "linePrefix", prefix: "", togglePrefixes: ALL_LINE_PREFIXES };
    case "blockquote":   return { kind: "linePrefix", prefix: "> ", togglePrefixes: ["> ", "# ", "## ", "### "] };
    case "bulletList":   return { kind: "linePrefix", prefix: "- ", togglePrefixes: ALL_LINE_PREFIXES };
    case "orderedList":  return { kind: "linePrefix", prefix: "1. ", togglePrefixes: ALL_LINE_PREFIXES };
    case "taskList":     return { kind: "linePrefix", prefix: "- [ ] ", togglePrefixes: ALL_LINE_PREFIXES };
    case "codeBlock":    return { kind: "fence" };
    case "hr":           return { kind: "hr" };
    case "link":         return { kind: "link", url: cmd.url, text: cmd.text };
    case "insertTable":  return { kind: "insert", text: "\n\n| Column 1 | Column 2 |\n| --- | --- |\n| value | value |\n\n" };
    case "insertText":   return { kind: "insert", text: cmd.text };
    case "clipEmbed":    return { kind: "insert", text: `<span data-clip-embed="${escAttr(cmd.id)}"></span>` };
    case "groupEmbed":   return { kind: "insert", text: `<span data-group-ref="${escAttr(cmd.name)}"></span>` };
  }
}

// ── Wrap selection ────────────────────────────────────────────────────────

function wrap(s: TextareaState, before: string, after: string, placeholder = ""): ApplyResult {
  const sel = s.value.slice(s.selStart, s.selEnd);
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
    return { value, selStart: s.selStart + before.length, selEnd: s.selStart + before.length + inner.length };
  }
  const caret = s.selStart + before.length;
  return { value, selStart: caret, selEnd: caret + inner.length };
}

// ── Per-line prefix ───────────────────────────────────────────────────────

function linePrefix(
  s: TextareaState,
  prefix: string,
  togglePrefixes: string[] = [prefix],
): ApplyResult {
  const { lineStart, lineEnd } = expandToLines(s.value, s.selStart, s.selEnd);
  const block = s.value.slice(lineStart, lineEnd);
  const lines = block.split("\n");

  const stripLine = (ln: string): string => {
    let out = ln;
    for (const p of togglePrefixes) {
      if (out.startsWith(p)) { out = out.slice(p.length); break; }
    }
    return out.replace(/^\d+\.\s/, "");
  };

  let nextLines: string[];
  if (prefix === "") {
    nextLines = lines.map(stripLine);
  } else {
    const allHave = lines.every((ln) => ln.length === 0 || ln.startsWith(prefix));
    nextLines = allHave
      ? lines.map((ln) => (ln.startsWith(prefix) ? ln.slice(prefix.length) : ln))
      : lines.map((ln) => prefix + stripLine(ln));
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
  const before = needsLeadingNewline(s.value, s.selStart) ? "\n" : "";
  const after  = needsTrailingNewline(s.value, s.selEnd) ? "\n" : "";
  const insert = before + open + sel + close + after;
  const value = s.value.slice(0, s.selStart) + insert + s.value.slice(s.selEnd);
  const inner = s.selStart + before.length + open.length;
  return { value, selStart: inner, selEnd: inner + sel.length };
}

// ── Plain insert ──────────────────────────────────────────────────────────

function insertAt(s: TextareaState, text: string): ApplyResult {
  const value = s.value.slice(0, s.selStart) + text + s.value.slice(s.selEnd);
  const pos = s.selStart + text.length;
  return { value, selStart: pos, selEnd: pos };
}

// ── Active state detection ────────────────────────────────────────────────

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
  if (insideFence(value, caret)) return "code";
  return "p";
}

export function detectActiveState(value: string, selStart: number, selEnd: number): ActiveState {
  const caret = selStart;
  const blockKind = detectBlockKind(value, caret);
  // Best-effort inline detection: peek around the caret for paired markers on
  // the same line. Cheap and good enough for toolbar feedback.
  const { lineStart } = expandToLines(value, caret, caret);
  const lineBefore = value.slice(lineStart, caret);
  const lineAfter  = value.slice(caret, value.indexOf("\n", caret) === -1 ? value.length : value.indexOf("\n", caret));
  const surrounded = (m: string) =>
    countOccurrences(lineBefore, m) % 2 === 1 && countOccurrences(lineAfter, m) >= 1;
  return {
    bold:   surrounded("**"),
    italic: surrounded("*") && !surrounded("**"),
    strike: surrounded("~~"),
    code:   surrounded("`") && !insideFence(value, caret),
    blockKind,
  };
  // The selStart/selEnd pair is reserved for future range-aware checks.
  void selEnd;
}

function countOccurrences(s: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = s.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
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
  return pos > 0 && value[pos - 1] !== "\n";
}

function needsTrailingNewline(value: string, pos: number): boolean {
  return pos < value.length && value[pos] !== "\n";
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
