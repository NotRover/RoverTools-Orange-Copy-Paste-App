// ── WYSIWYG Engine — BlockEditor ─────────────────────────────────────────
// Per-block contenteditable editor. Each block is an independent editable
// element. The engine owns structural operations (split, merge, type-change)
// via pure transforms; inline formatting is delegated to document.execCommand.

import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ClipboardEntry } from "../../../../types";
import {
  classifyFileEntry, filePaths, groupColor,
  resolveImageSrc, truncateText,
} from "../../../../types";
import type { NoteDoc, BlockNode, InlineNode, BlockType, ParaBlockType } from "./types";
import { isParaBlock, isListBlock } from "./types";
import {
  parseNote, parseInlines, parseBlockEl,
  getBlockHtml, emptyDoc,
} from "./serialize";
import { fileName } from "../notes-utils";
import "./block-editor.css";

// ── Embed SVGs ────────────────────────────────────────────────────────────

const SVG_IMAGE   = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/></svg>`;
const SVG_FILE    = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const SVG_TEXT    = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>`;
const SVG_MISSING = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none"/></svg>`;
const SVG_EXPAND  = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const SVG_COLLAPSE= `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
const SVG_RESIZE  = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 9L9 3"/><path d="M6 9L9 6"/><path d="M9 9L9 9"/></svg>`;

const EMBED_MIN_W = 72, EMBED_MIN_H = 22;

// ── Public handle exposed to NoteEditor shell ─────────────────────────────

export interface BlockEditorHandle {
  execFmt: (cmd: string, value?: string) => void;
  setBlockType: (type: BlockType) => void;
  getBlockType: () => BlockType;
  insertClipEmbed: (id: string) => void;
  insertGroupEmbed: (name: string) => void;
  insertLink: (url: string) => void;
  saveRange: () => void;          // call before opening a picker
  focus: () => void;
  flush: () => NoteDoc;           // serialize current DOM → NoteDoc and return it
}

export interface BlockEditorProps {
  noteId:     string;
  initialDoc: NoteDoc;
  entries:    ClipboardEntry[];
  onChange:   (doc: NoteDoc) => void;
}

// ── Cursor helpers ────────────────────────────────────────────────────────

function caretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  const s = document.createRange();
  s.selectNodeContents(el);
  s.collapse(true);
  return r.compareBoundaryPoints(Range.START_TO_START, s) <= 0;
}

function caretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  const e = document.createRange();
  e.selectNodeContents(el);
  e.collapse(false);
  return r.compareBoundaryPoints(Range.END_TO_END, e) >= 0;
}

function placeCursorAt(el: HTMLElement, end: boolean) {
  el.focus({ preventScroll: true });
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(!end);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function splitDOMAtCursor(el: HTMLElement): [DocumentFragment, DocumentFragment] {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    const all = document.createDocumentFragment();
    Array.from(el.childNodes).forEach(n => all.appendChild(n.cloneNode(true)));
    return [all, document.createDocumentFragment()];
  }
  const cur = sel.getRangeAt(0);
  cur.deleteContents();

  const before = document.createRange();
  before.setStart(el, 0);
  before.setEnd(cur.startContainer, cur.startOffset);

  const after = document.createRange();
  after.setStart(cur.startContainer, cur.startOffset);
  after.setEnd(el, el.childNodes.length);

  return [before.cloneContents(), after.cloneContents()];
}

// ── Block state ───────────────────────────────────────────────────────────

let _keyCounter = 0;
const genKey = () => `b${++_keyCounter}`;

interface BlockState {
  key:  string;
  node: BlockNode;
}

function docToStates(doc: NoteDoc): BlockState[] {
  return doc.nodes.map(node => ({ key: genKey(), node }));
}

// ── BlockEditor component ─────────────────────────────────────────────────

const BlockEditor = forwardRef<BlockEditorHandle, BlockEditorProps>(
  ({ noteId, initialDoc, entries, onChange }, ref) => {
    const [blocks, setBlocks] = useState<BlockState[]>(() => docToStates(initialDoc));
    const blockRefs  = useRef<Map<string, HTMLElement>>(new Map());
    const focusedKey = useRef<string | null>(null);
    const saveTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savedRange = useRef<Range | null>(null);
    const selectedEmbeds = useRef<Set<HTMLElement>>(new Set());
    const activeResize   = useRef<(() => void) | null>(null);
    const entriesRef     = useRef(entries);
    entriesRef.current   = entries;

    // Reset when note changes
    useEffect(() => {
      setBlocks(docToStates(parseNote(initialDoc === undefined ? "" : JSON.stringify(initialDoc))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId]);

    // ── Serialise ──────────────────────────────────────────────────────────

    const buildDoc = useCallback((bs: BlockState[]): NoteDoc => {
      const nodes = bs.map(({ key, node }) => {
        const el = blockRefs.current.get(key);
        return el ? parseBlockEl(el, node.type) : node;
      });
      return { v: 2, nodes };
    }, []);

    const scheduleSave = useCallback((bs?: BlockState[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        setBlocks(current => {
          const doc = buildDoc(bs ?? current);
          onChange(doc);
          return current;
        });
      }, 400);
    }, [buildDoc, onChange]);

    // Public flush — used by NoteEditor on unmount/close
    const flush = useCallback((): NoteDoc => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      let result!: NoteDoc;
      setBlocks(current => { result = buildDoc(current); onChange(result); return current; });
      return result ?? emptyDoc();
    }, [buildDoc, onChange]);

    // ── Embed rendering ────────────────────────────────────────────────────

    const clearSelectedEmbeds = useCallback(() => {
      selectedEmbeds.current.forEach(el => el.classList.remove("ns-embed--selected"));
      selectedEmbeds.current.clear();
    }, []);

    const renderClipEmbed = useCallback((host: HTMLElement) => {
      const id    = host.getAttribute("data-clip-embed") ?? "";
      const mode  = host.getAttribute("data-embed-mode") ?? "inline";
      const entry = entriesRef.current.find(e => e.id === id);

      const isBlock    = mode === "block" && !!entry;
      const typeClass  = !entry ? "clip-embed--missing"
        : entry.type === "image" ? "clip-embed--image"
        : entry.type === "file"  ? "clip-embed--file" : "";
      const isSelected = selectedEmbeds.current.has(host);

      host.className = ["clip-embed", typeClass, isBlock && "clip-embed--block"]
        .filter(Boolean).join(" ");
      if (isSelected) host.classList.add("ns-embed--selected");
      host.setAttribute("contenteditable", "false");
      host.replaceChildren();
      host.classList.remove("clip-embed--scrollable");

      const applyDims = () => {
        const w = parseFloat(host.getAttribute("data-embed-width") ?? "");
        const h = parseFloat(host.getAttribute("data-embed-height") ?? "");
        if (w > 0) host.style.width  = `${Math.round(w)}px`; else host.style.removeProperty("width");
        if (h > 0) host.style.height = `${Math.round(h)}px`; else host.style.removeProperty("height");
      };
      applyDims();

      const mkIcon = (svg: string) => {
        const s = document.createElement("span");
        s.className = "clip-embed-icon"; s.innerHTML = svg; return s;
      };
      const mkResizeHandle = () => {
        const h = document.createElement("span");
        h.className = "embed-resize-handle";
        h.setAttribute("data-embed-resize-handle", "true");
        h.setAttribute("data-tooltip", "Drag to resize");
        h.setAttribute("data-tooltip-pos", "left");
        h.innerHTML = SVG_RESIZE;
        return h;
      };

      const iconSvg = !entry ? SVG_MISSING
        : entry.type === "image" ? SVG_IMAGE
        : entry.type === "file"  ? SVG_FILE : SVG_TEXT;

      const getLabel = (maxLen: number) => {
        if (!entry) return "Missing clip";
        const paths    = entry.type === "file" ? filePaths(entry.content) : [];
        const fileKind = entry.type === "file" ? classifyFileEntry(entry.content) : "file";
        return entry.type === "image" ? (entry.label ?? "Image")
          : entry.type === "file"
            ? fileKind === "image" ? "Image file" : paths[0] ? fileName(paths[0]) : "File"
            : truncateText((entry.type === "html"
                ? entry.content.replace(/<[^>]*>/g, "")
                : entry.content).replace(/\s+/g, " ").trim(), maxLen) || "Clip";
      };

      if (isBlock) {
        const header = document.createElement("span");
        header.className = "clip-embed-block-header";
        const hTitle  = document.createElement("span");
        hTitle.className = "clip-embed-block-title";
        hTitle.textContent = getLabel(60);
        const hToggle = document.createElement("span");
        hToggle.className = "clip-embed-toggle clip-embed-toggle--collapse";
        hToggle.title = "Collapse embed"; hToggle.innerHTML = SVG_COLLAPSE;
        header.append(mkIcon(iconSvg), hTitle, hToggle);

        const body = document.createElement("span");
        body.className = "clip-embed-block-body";
        if (entry.type === "image") {
          body.classList.add("clip-embed-block-body--image");
          const wrap = document.createElement("span");
          wrap.className = "clip-embed-image-resizable";
          const img  = document.createElement("img");
          img.src = resolveImageSrc(entry.content, convertFileSrc);
          img.alt = entry.label ?? "Image"; img.className = "clip-embed-block-image";
          wrap.append(img); body.append(wrap);
        } else if (entry.type === "html") {
          body.textContent = entry.content.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        } else if (entry.type === "text") {
          body.textContent = entry.content;
        } else if (entry.type === "file") {
          const ps = filePaths(entry.content);
          body.textContent = ps[0] ? fileName(ps[0]) : "File attachment";
        }
        host.append(header, body, mkResizeHandle());
        requestAnimationFrame(() => {
          host.classList.toggle("clip-embed--scrollable", body.scrollHeight > body.clientHeight + 1);
        });
      } else {
        const text = document.createElement("span");
        text.className = "clip-embed-text";
        if (!entry) { text.textContent = "Missing clip"; text.classList.add("clip-embed-fallback"); host.append(mkIcon(SVG_MISSING), text); return; }
        text.textContent = getLabel(34);
        const toggle = document.createElement("span");
        toggle.className = "clip-embed-toggle"; toggle.title = "Expand"; toggle.innerHTML = SVG_EXPAND;
        host.append(mkIcon(iconSvg), text, toggle, mkResizeHandle());
      }
    }, []);

    const renderGroupEmbed = useCallback((host: HTMLElement) => {
      const name = host.getAttribute("data-group-ref") ?? "Group";
      const c    = groupColor(name);
      host.className = ["group-embed", selectedEmbeds.current.has(host) && "ns-embed--selected"].filter(Boolean).join(" ");
      host.setAttribute("contenteditable", "false");
      host.style.setProperty("background", c.bg);
      host.style.setProperty("color", c.fg);
      host.replaceChildren();
      const dot = document.createElement("span"); dot.className = "group-embed-dot";
      const lbl = document.createElement("span"); lbl.className = "group-embed-label"; lbl.textContent = name;
      const hdl = document.createElement("span"); hdl.className = "embed-resize-handle";
      hdl.setAttribute("data-embed-resize-handle", "true");
      hdl.setAttribute("data-tooltip", "Drag to resize"); hdl.setAttribute("data-tooltip-pos", "left");
      hdl.innerHTML = SVG_RESIZE;
      host.append(dot, lbl, hdl);
    }, []);

    const renderEmbedsIn = useCallback((el: HTMLElement) => {
      el.querySelectorAll("[data-clip-embed]").forEach(h => renderClipEmbed(h as HTMLElement));
      el.querySelectorAll("[data-group-ref]").forEach(h  => renderGroupEmbed(h as HTMLElement));
    }, [renderClipEmbed, renderGroupEmbed]);

    // Re-render embeds when entries change
    useEffect(() => {
      blockRefs.current.forEach(el => renderEmbedsIn(el));
    }, [entries, renderEmbedsIn]);

    // ── Resize logic ───────────────────────────────────────────────────────

    const beginResize = useCallback((host: HTMLElement, startEv: React.MouseEvent) => {
      activeResize.current?.();
      clearSelectedEmbeds();
      const rect = host.getBoundingClientRect();
      const sx = startEv.clientX, sy = startEv.clientY;
      const sw = Math.max(EMBED_MIN_W, rect.width);
      const sh = Math.max(EMBED_MIN_H, rect.height);
      const minW = host.classList.contains("clip-embed--block") ? 180 : EMBED_MIN_W;
      const minH = host.classList.contains("clip-embed--block") ? 44  : EMBED_MIN_H;
      host.classList.add("ns-embed--resizing");

      const onMove = (e: MouseEvent) => {
        const w = Math.round(Math.max(minW, sw + e.clientX - sx));
        const h = Math.round(Math.max(minH, sh + e.clientY - sy));
        host.style.width  = `${w}px`; host.style.height = `${h}px`;
        host.setAttribute("data-embed-width",  String(w));
        host.setAttribute("data-embed-height", String(h));
        if (host.classList.contains("clip-embed--block")) {
          const body = host.querySelector(".clip-embed-block-body") as HTMLElement | null;
          host.classList.toggle("clip-embed--scrollable", !!body && body.scrollHeight > body.clientHeight + 1);
        }
      };
      const cleanup = () => {
        host.classList.remove("ns-embed--resizing");
        document.body.style.cursor = document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (activeResize.current === cleanup) activeResize.current = null;
        scheduleSave();
      };
      const onUp = () => cleanup();
      activeResize.current = cleanup;
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }, [clearSelectedEmbeds, scheduleSave]);

    // ── Structural operations ─────────────────────────────────────────────

    const splitBlock = useCallback((key: string) => {
      setBlocks(current => {
        const idx = current.findIndex(b => b.key === key);
        if (idx < 0) return current;
        const { node } = current[idx];
        if (!isParaBlock(node)) return current;

        const el = blockRefs.current.get(key);
        if (!el) return current;

        const [beforeFrag, afterFrag] = splitDOMAtCursor(el);
        const tmpBefore = document.createElement("div"); tmpBefore.append(beforeFrag);
        const tmpAfter  = document.createElement("div"); tmpAfter.append(afterFrag);

        const beforeInlines = parseInlines(tmpBefore);
        const afterInlines  = parseInlines(tmpAfter);

        const k1 = genKey(), k2 = genKey();
        const next: BlockState[] = [
          ...current.slice(0, idx),
          { key: k1, node: { type: "p", children: beforeInlines } },
          { key: k2, node: { type: "p", children: afterInlines  } },
          ...current.slice(idx + 1),
        ];

        requestAnimationFrame(() => {
          const newEl = blockRefs.current.get(k2);
          if (newEl) placeCursorAt(newEl, false);
        });

        const doc: NoteDoc = { v: 2, nodes: next.map(b => b.node) };
        onChange(doc);
        return next;
      });
    }, [onChange]);

    const mergeWithPrev = useCallback((key: string) => {
      setBlocks(current => {
        const idx = current.findIndex(b => b.key === key);
        if (idx <= 0) return current;

        const prev = current[idx - 1];
        const cur  = current[idx];
        if (!isParaBlock(prev.node)) return current;

        const prevEl = blockRefs.current.get(prev.key);
        const curEl  = blockRefs.current.get(cur.key);
        const prevInlines = prevEl ? parseInlines(prevEl) : (isParaBlock(prev.node) ? prev.node.children : []);
        const curInlines  = curEl  ? parseInlines(curEl)  : (isParaBlock(cur.node)  ? cur.node.children  : []);

        const mergedKey = genKey();
        const mergedNode: BlockNode = { type: prev.node.type as ParaBlockType, children: [...prevInlines, ...curInlines] };

        const next: BlockState[] = [
          ...current.slice(0, idx - 1),
          { key: mergedKey, node: mergedNode },
          ...current.slice(idx + 1),
        ];

        // Focus merged block at the join point
        const joinOffset = prevInlines.reduce((sum, n) => sum + (n.type === "text" ? n.text.length : 1), 0);
        requestAnimationFrame(() => {
          const el = blockRefs.current.get(mergedKey);
          if (!el) return;
          el.focus({ preventScroll: true });
          // Walk to the join offset and place cursor there
          let remaining = joinOffset;
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let textNode: Text | null = null;
          while ((textNode = walker.nextNode() as Text | null)) {
            if (remaining <= textNode.length) break;
            remaining -= textNode.length;
          }
          if (textNode) {
            const r = document.createRange();
            r.setStart(textNode, remaining);
            r.collapse(true);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(r);
          }
        });

        const doc: NoteDoc = { v: 2, nodes: next.map(b => b.node) };
        onChange(doc);
        return next;
      });
    }, [onChange]);

    const updateBlockType = useCallback((key: string, newType: BlockType) => {
      setBlocks(current => {
        const idx = current.findIndex(b => b.key === key);
        if (idx < 0) return current;
        const el = blockRefs.current.get(key);
        const curNode = current[idx].node;
        const inlines: InlineNode[] = el
          ? parseInlines(el)
          : isParaBlock(curNode) ? curNode.children
          : isListBlock(curNode) ? curNode.items[0] ?? []
          : [];

        let newNode: BlockNode;
        if (newType === "ul" || newType === "ol") {
          newNode = { type: newType, items: [inlines] };
        } else if (newType === "hr") {
          newNode = { type: "hr" };
        } else {
          newNode = { type: newType, children: inlines } as BlockNode;
        }

        const newKey  = genKey();
        const next = current.map((b, i) => i === idx ? { key: newKey, node: newNode } : b);
        requestAnimationFrame(() => {
          const newEl = blockRefs.current.get(newKey);
          if (newEl) placeCursorAt(newEl, true);
        });

        const doc: NoteDoc = { v: 2, nodes: next.map(b => b.node) };
        onChange(doc);
        return next;
      });
    }, [onChange]);

    // ── Imperative handle ─────────────────────────────────────────────────

    const insertInlineSpan = useCallback((span: HTMLElement) => {
      const key = focusedKey.current;
      const el  = key ? blockRefs.current.get(key) : null;
      if (!el) return;

      const restore = () => {
        el.focus({ preventScroll: true });
        if (savedRange.current) {
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(savedRange.current);
          savedRange.current = null;
        }
      };
      restore();

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(span);
        const space = document.createTextNode(" ");
        span.after(space);
        r.setStart(space, 1); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
      } else {
        el.appendChild(span);
        el.appendChild(document.createTextNode(" "));
      }
      renderClipEmbed(span);
      scheduleSave();
    }, [renderClipEmbed, scheduleSave]);

    useImperativeHandle(ref, () => ({
      execFmt: (cmd, value) => {
        const key = focusedKey.current;
        const el  = key ? blockRefs.current.get(key) : null;
        if (el) { el.focus({ preventScroll: true }); document.execCommand(cmd, false, value); scheduleSave(); }
      },
      setBlockType: (type) => {
        const key = focusedKey.current;
        if (key) updateBlockType(key, type);
      },
      getBlockType: () => {
        const key = focusedKey.current;
        if (!key) return "p";
        let result: BlockType = "p";
        setBlocks(current => {
          const b = current.find(b => b.key === key);
          if (b) result = b.node.type as BlockType;
          return current;
        });
        return result;
      },
      insertClipEmbed: (id) => {
        const span = document.createElement("span");
        span.setAttribute("data-clip-embed", id);
        span.setAttribute("data-embed-mode", "inline");
        span.setAttribute("contenteditable", "false");
        insertInlineSpan(span);
      },
      insertGroupEmbed: (name) => {
        const span = document.createElement("span");
        span.setAttribute("data-group-ref", name);
        span.setAttribute("contenteditable", "false");
        renderGroupEmbed(span);
        insertInlineSpan(span);
      },
      insertLink: (url) => {
        const key = focusedKey.current;
        const el  = key ? blockRefs.current.get(key) : null;
        if (!el) return;
        el.focus({ preventScroll: true });
        if (savedRange.current) {
          const sel = window.getSelection();
          sel?.removeAllRanges(); sel?.addRange(savedRange.current);
          savedRange.current = null;
        }
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          document.execCommand("createLink", false, url);
        } else {
          document.execCommand("insertHTML", false,
            `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
        }
        scheduleSave();
      },
      saveRange: () => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) savedRange.current = sel.getRangeAt(0).cloneRange();
      },
      focus: () => {
        const first = blocks[0]?.key;
        if (first) { const el = blockRefs.current.get(first); el?.focus(); }
      },
      flush,
    }), [blocks, flush, insertInlineSpan, renderGroupEmbed, scheduleSave, updateBlockType]);

    // ── Block keydown handler ─────────────────────────────────────────────

    const handleBlockKeyDown = useCallback((
      e: React.KeyboardEvent<HTMLElement>,
      key: string,
      type: BlockNode["type"],
    ) => {
      const el = blockRefs.current.get(key);
      if (!el) return;

      // Embed selection — arrow and delete
      if (selectedEmbeds.current.size > 0) {
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          const sel = Array.from(selectedEmbeds.current);
          clearSelectedEmbeds();
          sel.forEach(h => h.remove());
          scheduleSave();
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const host = Array.from(selectedEmbeds.current)[0];
          if (host) {
            clearSelectedEmbeds();
            placeCursorAt(el, false);
            // Place caret near embed
            const r = document.createRange();
            if (e.key === "ArrowLeft") r.setStartBefore(host); else r.setStartAfter(host);
            r.collapse(true);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(r);
          }
          return;
        }
      }

      // Enter — split para/heading/blockquote blocks; let browser handle lists
      if (e.key === "Enter" && !e.shiftKey && (type === "p" || type === "h1" || type === "h2" || type === "bq")) {
        e.preventDefault();
        splitBlock(key);
        return;
      }

      // Enter in list — exit list on empty trailing item
      if (e.key === "Enter" && !e.shiftKey && (type === "ul" || type === "ol")) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const li = (sel.getRangeAt(0).startContainer as Node).parentElement?.closest("li");
          if (li && !li.textContent?.trim() && !li.nextElementSibling) {
            e.preventDefault();
            li.remove();
            // Add a new paragraph block after this list block
            setBlocks(current => {
              const idx = current.findIndex(b => b.key === key);
              if (idx < 0) return current;
              const newKey = genKey();
              const next: BlockState[] = [
                ...current.slice(0, idx + 1),
                { key: newKey, node: { type: "p", children: [] } },
                ...current.slice(idx + 1),
              ];
              requestAnimationFrame(() => {
                const newEl = blockRefs.current.get(newKey);
                if (newEl) { newEl.focus({ preventScroll: true }); }
              });
              const doc: NoteDoc = { v: 2, nodes: next.map(b => b.node) };
              onChange(doc);
              return next;
            });
          }
        }
        return;
      }

      // Backspace at start of block — merge with previous
      if (e.key === "Backspace" && caretAtStart(el) && isParaBlock({ type, children: [] } as BlockNode)) {
        setBlocks(current => {
          const idx = current.findIndex(b => b.key === key);
          if (idx <= 0) return current;
          const prev = current[idx - 1];
          // Only merge if prev is a para-like block
          if (!isParaBlock(prev.node)) return current;
          e.preventDefault();
          return current; // mergeWithPrev handles the actual state update
        });
        mergeWithPrev(key);
        return;
      }

      // ArrowUp at start — move focus to previous block
      if (e.key === "ArrowUp" && caretAtStart(el)) {
        setBlocks(current => {
          const idx = current.findIndex(b => b.key === key);
          if (idx <= 0) return current;
          const prevEl = blockRefs.current.get(current[idx - 1].key);
          if (prevEl) { e.preventDefault(); placeCursorAt(prevEl, true); }
          return current;
        });
        return;
      }

      // ArrowDown at end — move focus to next block
      if (e.key === "ArrowDown" && caretAtEnd(el)) {
        setBlocks(current => {
          const idx = current.findIndex(b => b.key === key);
          if (idx >= current.length - 1) return current;
          const nextEl = blockRefs.current.get(current[idx + 1].key);
          if (nextEl) { e.preventDefault(); placeCursorAt(nextEl, false); }
          return current;
        });
        return;
      }
    }, [clearSelectedEmbeds, mergeWithPrev, onChange, scheduleSave, splitBlock]);

    // ── Embed click / resize within blocks ────────────────────────────────

    const handleEditorMouseDown = useCallback((
      e: React.MouseEvent<HTMLElement>,
      key: string,
    ) => {
      const target = e.target as HTMLElement;
      const resizeHandle = target.closest("[data-embed-resize-handle]");
      if (resizeHandle) {
        const host = resizeHandle.closest("[data-clip-embed],[data-group-ref]") as HTMLElement | null;
        if (host) { e.preventDefault(); beginResize(host, e); return; }
      }
      if (target.closest(".clip-embed-toggle")) return;

      const host = target.closest("[data-clip-embed],[data-group-ref]") as HTMLElement | null;
      if (host) {
        e.preventDefault();
        const rect = host.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        if (frac < 0.22 || frac > 0.78) {
          // Edge zones → cursor placement
          clearSelectedEmbeds();
          const el = blockRefs.current.get(key);
          if (el) {
            el.focus({ preventScroll: true });
            const r = document.createRange();
            if (frac < 0.22) r.setStartBefore(host); else r.setStartAfter(host);
            r.collapse(true);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(r);
          }
        } else {
          // Centre → select embed
          const additive = e.ctrlKey || e.metaKey || e.shiftKey;
          if (!additive) clearSelectedEmbeds();
          host.classList.add("ns-embed--selected");
          selectedEmbeds.current.add(host);
          const r = document.createRange(); r.selectNode(host);
          window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(r);
        }
      } else {
        clearSelectedEmbeds();
      }
    }, [beginResize, clearSelectedEmbeds]);

    const handleToggleEmbedMode = useCallback((e: React.MouseEvent, _key: string) => {
      const toggle = (e.target as HTMLElement).closest(".clip-embed-toggle");
      if (!toggle) return;
      e.preventDefault();
      const host = toggle.closest("[data-clip-embed]") as HTMLElement | null;
      if (!host) return;
      const cur = host.getAttribute("data-embed-mode") ?? "inline";
      host.setAttribute("data-embed-mode", cur === "block" ? "inline" : "block");
      renderClipEmbed(host);
      scheduleSave();
    }, [renderClipEmbed, scheduleSave]);

    // ── Cleanup ────────────────────────────────────────────────────────────

    useEffect(() => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      activeResize.current?.();
      clearSelectedEmbeds();
    }, [clearSelectedEmbeds]);

    // ── Block component ────────────────────────────────────────────────────

    return (
      <div className="ns-be">
        {blocks.map(({ key, node }) => (
          <BlockEl
            key={key}
            bKey={key}
            node={node}
            blockRefs={blockRefs}
            renderEmbedsIn={renderEmbedsIn}
            onKeyDown={(e) => handleBlockKeyDown(e, key, node.type)}
            onMouseDown={(e) => handleEditorMouseDown(e, key)}
            onClick={(e) => handleToggleEmbedMode(e, key)}
            onFocus={() => { focusedKey.current = key; }}
            onInput={() => scheduleSave()}
          />
        ))}
        {/* Empty-state placeholder shown when only one empty paragraph */}
        {blocks.length === 1 &&
          blocks[0].node.type === "p" &&
          (isParaBlock(blocks[0].node) && blocks[0].node.children.length === 0) && (
          <div className="ns-be-placeholder" aria-hidden>Start writing…</div>
        )}
      </div>
    );
  }
);

BlockEditor.displayName = "BlockEditor";
export default BlockEditor;

// ── BlockEl — individual editable block ───────────────────────────────────

interface BlockElProps {
  bKey: string;
  node: BlockNode;
  blockRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  renderEmbedsIn: (el: HTMLElement) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
  onClick: (e: React.MouseEvent) => void;
  onFocus: () => void;
  onInput: () => void;
}

const BlockEl: React.FC<BlockElProps> = ({
  bKey, node, blockRefs, renderEmbedsIn,
  onKeyDown, onMouseDown, onClick, onFocus, onInput,
}) => {
  const elRef = useRef<HTMLDivElement>(null);

  // Mount: set innerHTML and render embeds. Only re-runs when the block is
  // structurally replaced (new React key), not during typing.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    blockRefs.current.set(bKey, el);
    el.innerHTML = getBlockHtml(node);
    renderEmbedsIn(el);
    return () => { blockRefs.current.delete(bKey); };
  // bKey changes only on structural ops — intentionally excludes node object
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bKey]);

  const tag = node.type === "ul" ? "ul"
    : node.type === "ol" ? "ol"
    : node.type === "h1" ? "h1"
    : node.type === "h2" ? "h2"
    : node.type === "bq" ? "blockquote"
    : "div";

  if (node.type === "hr") {
    return <div className="ns-be-block ns-be-hr"><hr /></div>;
  }

  return React.createElement(tag, {
    ref: elRef,
    className: `ns-be-block ns-be-${node.type}`,
    contentEditable: true,
    suppressContentEditableWarning: true,
    "data-be-block": "true",
    onKeyDown,
    onMouseDown,
    onClick,
    onFocus,
    onInput,
  });
};
