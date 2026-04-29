// ── Editor Engine — Markdown-mode (textarea) format actions ───────────────
// Pure functions that compute (next value, next selection) given the current
// textarea state and a FormatAction.

import type {
  FormatAction,
  BlockKind,
  EditorCommand,
  ActiveState,
} from "./types";

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

export function applyAction(
  state: TextareaState,
  action: FormatAction,
): ApplyResult {
  switch (action.kind) {
    case "wrap":
      return wrap(state, action.before, action.after, action.placeholder);
    case "linePrefix":
      return linePrefix(state, action.prefix, action.togglePrefixes);
    case "fence":
      return fence(state, action.lang);
    case "insert":
      return insertAt(state, action.text);
    case "link":
      return wrap(state, "[", `](${action.url})`, action.text ?? "link");
    case "hr":
      return insertAt(state, "\n\n---\n\n");
    case "stripColor":
      return stripInlineWrap(state, /<span\s+style="color:[^"]*">|<\/span>/gi);
    case "stripHighlight":
      return stripInlineWrap(
        state,
        /<mark\s+style="background-color:[^"]*">|<\/mark>/gi,
      );
    case "alignLine":
      return alignLine(state, action.value);
  }
}

// ── EditorCommand → FormatAction (markdown-mode dispatch) ─────────────────

const ALL_LINE_PREFIXES = [
  "# ",
  "## ",
  "### ",
  "#### ",
  "##### ",
  "> ",
  "- [ ] ",
  "- [x] ",
  "- ",
  "* ",
  "+ ",
];

export function commandToAction(cmd: EditorCommand): FormatAction | null {
  switch (cmd.kind) {
    case "bold":
      return { kind: "wrap", before: "**", after: "**", placeholder: "bold" };
    case "italic":
      return { kind: "wrap", before: "*", after: "*", placeholder: "italic" };
    case "strike":
      return { kind: "wrap", before: "~~", after: "~~", placeholder: "strike" };
    case "code":
      return { kind: "wrap", before: "`", after: "`", placeholder: "code" };
    case "heading":
      return {
        kind: "linePrefix",
        prefix: "#".repeat(cmd.level) + " ",
        togglePrefixes: ALL_LINE_PREFIXES,
      };
    case "paragraph":
      return {
        kind: "linePrefix",
        prefix: "",
        togglePrefixes: ALL_LINE_PREFIXES,
      };
    case "blockquote":
      return {
        kind: "linePrefix",
        prefix: "> ",
        togglePrefixes: ["> ", "# ", "## ", "### ", "#### ", "##### "],
      };
    case "bulletList":
      return {
        kind: "linePrefix",
        prefix: "- ",
        togglePrefixes: ALL_LINE_PREFIXES,
      };
    case "orderedList":
      return {
        kind: "linePrefix",
        prefix: "1. ",
        togglePrefixes: ALL_LINE_PREFIXES,
      };
    case "taskList":
      return {
        kind: "linePrefix",
        prefix: "- [ ] ",
        togglePrefixes: ALL_LINE_PREFIXES,
      };
    case "codeBlock":
      return { kind: "fence" };
    case "hr":
      return { kind: "hr" };
    case "link":
      return { kind: "link", url: cmd.url, text: cmd.text };
    case "image":
      return {
        kind: "insert",
        text: `\n![${(cmd.alt ?? "").replace(/[\[\]]/g, "")}](${cmd.src})\n`,
      };
    case "insertTable":
      return {
        kind: "insert",
        text: "\n\n| Column 1 | Column 2 |\n| --- | --- |\n| value | value |\n\n",
      };
    case "tableAddRowAfter":
    case "tableAddColumnAfter":
    case "tableDeleteRow":
    case "tableDeleteColumn":
      return null;
    case "insertText":
      return { kind: "insert", text: cmd.text };
    case "clipEmbed":
      return {
        kind: "insert",
        text: `<span data-clip-embed="${escAttr(cmd.id)}"></span>`,
      };
    case "groupEmbed":
      return {
        kind: "insert",
        text: `<span data-group-ref="${escAttr(cmd.name)}"></span>`,
      };
    case "textColor":
      if (cmd.value == null) return { kind: "stripColor" };
      return {
        kind: "wrap",
        before: `<span style="color: ${cmd.value}">`,
        after: "</span>",
        placeholder: "text",
      };
    case "highlight":
      if (cmd.value == null) return { kind: "stripHighlight" };
      return {
        kind: "wrap",
        before: `<mark style="background-color: ${cmd.value}">`,
        after: "</mark>",
        placeholder: "text",
      };
    case "align":
      return { kind: "alignLine", value: cmd.value };
  }
}

// ── Wrap selection ────────────────────────────────────────────────────────

function wrap(
  s: TextareaState,
  before: string,
  after: string,
  placeholder = "",
): ApplyResult {
  const sel = s.value.slice(s.selStart, s.selEnd);
  if (
    sel.length === 0 &&
    s.value.slice(s.selStart - before.length, s.selStart) === before &&
    s.value.slice(s.selEnd, s.selEnd + after.length) === after
  ) {
    const value =
      s.value.slice(0, s.selStart - before.length) +
      s.value.slice(s.selEnd + after.length);
    const pos = s.selStart - before.length;
    return { value, selStart: pos, selEnd: pos };
  }
  if (sel.length > 0 && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    const value =
      s.value.slice(0, s.selStart) + inner + s.value.slice(s.selEnd);
    return { value, selStart: s.selStart, selEnd: s.selStart + inner.length };
  }
  const inner = sel.length ? sel : placeholder;
  const insert = before + inner + after;
  const value = s.value.slice(0, s.selStart) + insert + s.value.slice(s.selEnd);
  if (sel.length) {
    return {
      value,
      selStart: s.selStart + before.length,
      selEnd: s.selStart + before.length + inner.length,
    };
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
      if (out.startsWith(p)) {
        out = out.slice(p.length);
        break;
      }
    }
    return out.replace(/^\d+\.\s/, "");
  };

  let nextLines: string[];
  if (prefix === "") {
    nextLines = lines.map(stripLine);
  } else {
    const allHave = lines.every(
      (ln) => ln.length === 0 || ln.startsWith(prefix),
    );
    nextLines = allHave
      ? lines.map((ln) =>
          ln.startsWith(prefix) ? ln.slice(prefix.length) : ln,
        )
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
  const after = needsTrailingNewline(s.value, s.selEnd) ? "\n" : "";
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
  let line = value.slice(lineStart, lineEnd);
  // Peel off any HTML alignment wrapper so the underlying block kind shows
  // through (e.g. an aligned heading still reports as h2, not p).
  line = line
    .replace(/^<(p|h[1-6])\s+style="text-align:\s*[a-z]+">\s*/i, "")
    .replace(/<\/(p|h[1-6])>\s*$/i, "");
  if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) return "hr";
  if (/^##### /.test(line)) return "h5";
  if (/^#### /.test(line)) return "h4";
  if (/^### /.test(line)) return "h3";
  if (/^## /.test(line)) return "h2";
  if (/^# /.test(line)) return "h1";
  if (/^>\s?/.test(line)) return "bq";
  if (/^\s*[-*+]\s\[x\]\s/i.test(line)) return "todoChecked";
  if (/^\s*[-*+]\s\[ \]\s/.test(line)) return "todo";
  if (/^\s*[-*+]\s/.test(line)) return "ul";
  if (/^\s*\d+\.\s/.test(line)) return "ol";
  if (insideFence(value, caret)) return "code";
  return "p";
}

/**
 * Detect alignment / inline color / highlight at the caret by walking the
 * surrounding HTML wrappers. The parsed result reflects whatever wrapper the
 * caret sits *inside* — matches what the toolbar shows in rich mode.
 */
function detectInlineHtmlState(
  value: string,
  caret: number,
): {
  align?: ActiveState["align"];
  textColor?: string;
  highlight?: string;
} {
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const findWrap = (
    openRe: RegExp,
    closeRe: RegExp,
  ): string | undefined => {
    const opens = [...before.matchAll(openRe)];
    if (opens.length === 0) return undefined;
    const last = opens[opens.length - 1];
    // Caret is inside the wrap only if no closing tag sits between the
    // opening tag and the caret, AND a closing tag exists somewhere after.
    const between = before.slice(last.index! + last[0].length);
    if (closeRe.test(between)) return undefined;
    if (!closeRe.test(after)) return undefined;
    return last[1];
  };
  return {
    align: findWrap(
      /<(?:p|h[1-6])\s+style="text-align:\s*([a-z]+)">/gi,
      /<\/(?:p|h[1-6])>/i,
    ) as ActiveState["align"],
    textColor: findWrap(
      /<span\s+style="color:\s*([^"]+)">/gi,
      /<\/span>/i,
    ),
    highlight: findWrap(
      /<mark\s+style="background-color:\s*([^"]+)">/gi,
      /<\/mark>/i,
    ),
  };
}

export function detectActiveState(
  value: string,
  selStart: number,
  selEnd: number,
): ActiveState {
  const caret = selStart;
  const blockKind = detectBlockKind(value, caret);
  // Best-effort inline detection: peek around the caret for paired markers on
  // the same line. Cheap and good enough for toolbar feedback.
  const { lineStart } = expandToLines(value, caret, caret);
  const lineBefore = value.slice(lineStart, caret);
  const lineAfter = value.slice(
    caret,
    value.indexOf("\n", caret) === -1
      ? value.length
      : value.indexOf("\n", caret),
  );
  const surrounded = (m: string) =>
    countOccurrences(lineBefore, m) % 2 === 1 &&
    countOccurrences(lineAfter, m) >= 1;
  const inline = detectInlineHtmlState(value, caret);
  // Best-effort table detection: caret sits on a pipe-delimited row.
  const lineTextNow = value.slice(lineStart, lineStart + lineBefore.length + lineAfter.length);
  const inTable =
    /^\s*\|.*\|\s*$/.test(lineTextNow) && !insideFence(value, caret);
  return {
    bold: surrounded("**"),
    italic: surrounded("*") && !surrounded("**"),
    strike: surrounded("~~"),
    code: surrounded("`") && !insideFence(value, caret),
    inTable,
    blockKind,
    align: inline.align,
    textColor: inline.textColor,
    highlight: inline.highlight,
  };
  // The selStart/selEnd pair is reserved for future range-aware checks.
  void selEnd;
}

function countOccurrences(s: string, needle: string): number {
  if (!needle) return 0;
  let n = 0,
    i = 0;
  while ((i = s.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
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

function stripInlineWrap(s: TextareaState, pattern: RegExp): ApplyResult {
  const start = s.selStart;
  const end = s.selEnd === s.selStart ? s.value.length : s.selEnd;
  const head = s.value.slice(0, start);
  const middle = s.value.slice(start, end);
  const tail = s.value.slice(end);
  const stripped = middle.replace(pattern, "");
  const value = head + stripped + tail;
  return {
    value,
    selStart: start,
    selEnd: start + stripped.length,
  };
}

function alignLine(
  s: TextareaState,
  value: "left" | "center" | "right" | "justify",
): ApplyResult {
  const { lineStart, lineEnd } = expandToLines(s.value, s.selStart, s.selEnd);
  const block = s.value.slice(lineStart, lineEnd);
  // Drop any pre-existing alignment wrapper before reapplying.
  const inner = block
    .replace(/^<p\s+style="text-align:\s*[a-z]+">/i, "")
    .replace(/<\/p>$/i, "");
  const wrapped =
    value === "left" ? inner : `<p style="text-align: ${value}">${inner}</p>`;
  const next = s.value.slice(0, lineStart) + wrapped + s.value.slice(lineEnd);
  return {
    value: next,
    selStart: lineStart,
    selEnd: lineStart + wrapped.length,
  };
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
