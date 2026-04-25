// ── Prose Engine — BlockEditor ────────────────────────────────────────────
// Unified-surface contenteditable. The outer .ns-be container is the single
// editable element; blocks inside inherit editability. The engine owns
// structural operations (split, merge, type-change, alignment, indent) and
// cross-block deletion. Inline marks use execCommand.

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ClipboardEntry } from "../../../../types";
import {
  classifyFileEntry,
  filePaths,
  groupColor,
  resolveImageSrc,
  truncateText,
} from "../../../../types";
import type {
  NoteDoc,
  BlockNode,
  InlineNode,
  BlockType,
  ParaBlockType,
  Alignment,
} from "./types";
import {
  isParaBlock,
  isListBlock,
  isAlignableBlock,
  isIndentableBlock,
  MAX_INDENT,
} from "./types";
import {
  parseInlines,
  parseBlockEl,
  getBlockHtml,
  emptyDoc,
} from "./serialize";
import { fileName } from "../notes-utils";
import "./block-editor.css";

// ── Embed SVGs ────────────────────────────────────────────────────────────

const SVG_IMAGE = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/></svg>`;
const SVG_FILE = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const SVG_TEXT = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>`;
const SVG_MISSING = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none"/></svg>`;
const SVG_EXPAND = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const SVG_COLLAPSE = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
const SVG_RESIZE = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 9L9 3"/><path d="M6 9L9 6"/><path d="M9 9L9 9"/></svg>`;

const EMBED_MIN_W = 72,
  EMBED_MIN_H = 22;

// ── Public handle ─────────────────────────────────────────────────────────

export interface BlockEditorHandle {
  execFmt: (cmd: string, value?: string) => void;
  getFormatState: () => EditorFormatState;
  setBlockType: (type: BlockType) => void;
  getBlockType: () => BlockType;
  setAlignment: (align: Alignment | null) => void;
  getAlignment: () => Alignment | null;
  indent: () => void;
  outdent: () => void;
  insertClipEmbed: (id: string) => void;
  insertGroupEmbed: (name: string) => void;
  insertLink: (url: string) => void;
  saveRange: () => void;
  focus: () => void;
  flush: () => NoteDoc;
}

export interface EditorFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

function emptyFormatState(): EditorFormatState {
  return { bold: false, italic: false, underline: false, strikethrough: false };
}

export interface BlockEditorProps {
  noteId: string;
  initialDoc: NoteDoc;
  entries: ClipboardEntry[];
  onChange: (doc: NoteDoc) => void;
}

// ── Cursor / DOM helpers ──────────────────────────────────────────────────

function blockElFromNode(n: Node | null, container: HTMLElement): HTMLElement | null {
  let cur: Node | null = n;
  while (cur && cur !== container) {
    if (
      cur.nodeType === Node.ELEMENT_NODE &&
      (cur as HTMLElement).hasAttribute("data-be-block")
    )
      return cur as HTMLElement;
    cur = cur.parentNode;
  }
  return null;
}

function caretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0),
    s = document.createRange();
  s.selectNodeContents(el);
  s.collapse(true);
  return r.compareBoundaryPoints(Range.START_TO_START, s) <= 0;
}

function caretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0),
    e = document.createRange();
  e.selectNodeContents(el);
  e.collapse(false);
  return r.compareBoundaryPoints(Range.END_TO_END, e) >= 0;
}

function placeCursorAt(el: HTMLElement, end: boolean) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(!end);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function inlinesFromRange(
  startContainerEl: HTMLElement,
  startNode: Node,
  startOff: number,
  endNode: Node,
  endOff: number,
): InlineNode[] {
  // Build a fragment from a range, then parse inlines.
  const r = document.createRange();
  r.setStart(startNode, startOff);
  r.setEnd(endNode, endOff);
  const frag = r.cloneContents();
  const wrap = document.createElement("div");
  wrap.appendChild(frag);
  // Strip todo-checks if any pasted in
  wrap.querySelectorAll("[data-todo-check]").forEach((n) => n.remove());
  // Inherit container tag context — not strictly needed since parseInlines walks generically
  void startContainerEl;
  return parseInlines(wrap);
}

function inlineLength(inlines: InlineNode[]): number {
  let n = 0;
  for (const x of inlines) {
    if (x.type === "text") n += x.text.length;
    else if (x.type === "link") n += x.text.length;
    else n += 1;
  }
  return n;
}

function placeCursorAtTextOffset(el: HTMLElement, target: number) {
  let remaining = target;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let tn: Text | null = null;
  while ((tn = walker.nextNode() as Text | null)) {
    if (remaining <= tn.length) break;
    remaining -= tn.length;
  }
  const r = document.createRange();
  if (tn) {
    r.setStart(tn, Math.max(0, Math.min(tn.length, remaining)));
  } else {
    r.selectNodeContents(el);
    r.collapse(false);
  }
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function hasNonEmptyContent(el: HTMLElement): boolean {
  const txt = (el.textContent ?? "").replace(/[​﻿]/g, "").trim();
  return txt.length > 0;
}

// ── Block state ───────────────────────────────────────────────────────────

let _keyCounter = 0;
const genKey = () => `b${++_keyCounter}`;

interface BlockState {
  key: string;
  node: BlockNode;
}

function docToStates(doc: NoteDoc): BlockState[] {
  const nodes = doc.nodes.length ? doc.nodes : [{ type: "p", children: [] } as BlockNode];
  return nodes.map((node) => ({ key: genKey(), node }));
}

function setIndentClass(el: HTMLElement, n: number) {
  el.className = el.className.replace(/\s*ns-be-indent-\d+/g, "").trim();
  if (n > 0) el.classList.add(`ns-be-indent-${n}`);
  if (n > 0) el.setAttribute("data-indent", String(n));
  else el.removeAttribute("data-indent");
}

function setLiLevelClass(li: HTMLElement, n: number) {
  li.className = li.className.replace(/\s*ns-be-li-l\d+/g, "").trim();
  if (!li.classList.contains("ns-be-li")) li.classList.add("ns-be-li");
  li.classList.add(`ns-be-li-l${n}`);
  li.setAttribute("data-level", String(n));
}

// ── BlockEditor ───────────────────────────────────────────────────────────

const BlockEditor = forwardRef<BlockEditorHandle, BlockEditorProps>(
  ({ noteId, initialDoc, entries, onChange }, ref) => {
    const [blocks, setBlocks] = useState<BlockState[]>(() =>
      docToStates(initialDoc ?? emptyDoc()),
    );
    const blocksRef = useRef<BlockState[]>(blocks);
    blocksRef.current = blocks;

    const containerRef = useRef<HTMLDivElement>(null);
    const blockRefs = useRef<Map<string, HTMLElement>>(new Map());
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savedRange = useRef<Range | null>(null);
    const selectedEmbeds = useRef<Set<HTMLElement>>(new Set());
    const activeResize = useRef<(() => void) | null>(null);
    const entriesRef = useRef(entries);
    entriesRef.current = entries;

    // Track focused block for toolbar state
    const [focusedType, setFocusedType] = useState<BlockType>("p");
    const [focusedAlign, setFocusedAlign] = useState<Alignment | null>(null);
    const focusedKeyRef = useRef<string | null>(null);
    const focusedTypeRef = useRef<BlockType>("p");
    const focusedAlignRef = useRef<Alignment | null>(null);
    focusedTypeRef.current = focusedType;
    focusedAlignRef.current = focusedAlign;
    void focusedType;
    void focusedAlign;

    useEffect(() => {
      setBlocks(docToStates(initialDoc ?? emptyDoc()));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId]);

    // ── Current block lookup ───────────────────────────────────────────────

    const currentBlock = useCallback((): {
      el: HTMLElement;
      key: string;
      state: BlockState;
    } | null => {
      const container = containerRef.current;
      if (!container) return null;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      const el = blockElFromNode(r.startContainer, container);
      if (!el) return null;
      const key = el.getAttribute("data-block-key") ?? "";
      const state = blocksRef.current.find((b) => b.key === key);
      if (!state) return null;
      return { el, key, state };
    }, []);

    const updateFocusFromSelection = useCallback(() => {
      const cb = currentBlock();
      if (!cb) return;
      focusedKeyRef.current = cb.key;
      const t = cb.state.node.type as BlockType;
      setFocusedType(t);
      const align = ("align" in cb.state.node ? (cb.state.node as any).align : null) ?? null;
      setFocusedAlign(align);
    }, [currentBlock]);

    // ── Serialise ──────────────────────────────────────────────────────────

    const buildDoc = useCallback(
      (bs: BlockState[]): NoteDoc => ({
        v: 2,
        nodes: bs.map(({ key, node }) => {
          const el = blockRefs.current.get(key);
          return el ? parseBlockEl(el, node.type) : node;
        }),
      }),
      [],
    );

    const scheduleSave = useCallback(() => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        onChange(buildDoc(blocksRef.current));
      }, 400);
    }, [buildDoc, onChange]);

    const flush = useCallback((): NoteDoc => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const doc = buildDoc(blocksRef.current);
      onChange(doc);
      return doc;
    }, [buildDoc, onChange]);

    // ── Embed rendering ────────────────────────────────────────────────────

    const clearSelectedEmbeds = useCallback(() => {
      selectedEmbeds.current.forEach((el) =>
        el.classList.remove("ns-embed--selected"),
      );
      selectedEmbeds.current.clear();
    }, []);

    const renderClipEmbed = useCallback((host: HTMLElement) => {
      const id = host.getAttribute("data-clip-embed") ?? "";
      const mode = host.getAttribute("data-embed-mode") ?? "inline";
      const entry = entriesRef.current.find((e) => e.id === id);
      const isBlock = mode === "block" && !!entry;
      const typeClass = !entry
        ? "clip-embed--missing"
        : entry.type === "image"
          ? "clip-embed--image"
          : entry.type === "file"
            ? "clip-embed--file"
            : "";

      host.className = ["clip-embed", typeClass, isBlock && "clip-embed--block"]
        .filter(Boolean)
        .join(" ");
      if (selectedEmbeds.current.has(host))
        host.classList.add("ns-embed--selected");
      host.setAttribute("contenteditable", "false");
      host.replaceChildren();
      host.classList.remove("clip-embed--scrollable");

      const applyDims = () => {
        const w = parseFloat(host.getAttribute("data-embed-width") ?? "");
        const h = parseFloat(host.getAttribute("data-embed-height") ?? "");
        if (w > 0) host.style.width = `${Math.round(w)}px`;
        else host.style.removeProperty("width");
        if (h > 0) host.style.height = `${Math.round(h)}px`;
        else host.style.removeProperty("height");
      };
      applyDims();

      const mkIcon = (svg: string) => {
        const s = document.createElement("span");
        s.className = "clip-embed-icon";
        s.innerHTML = svg;
        return s;
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

      const iconSvg = !entry
        ? SVG_MISSING
        : entry.type === "image"
          ? SVG_IMAGE
          : entry.type === "file"
            ? SVG_FILE
            : SVG_TEXT;

      const getLabel = (maxLen: number) => {
        if (!entry) return "Missing clip";
        const paths = entry.type === "file" ? filePaths(entry.content) : [];
        const fileKind =
          entry.type === "file" ? classifyFileEntry(entry.content) : "file";
        return entry.type === "image"
          ? (entry.label ?? "Image")
          : entry.type === "file"
            ? fileKind === "image"
              ? "Image file"
              : paths[0]
                ? fileName(paths[0])
                : "File"
            : truncateText(
                (entry.type === "html"
                  ? entry.content.replace(/<[^>]*>/g, "")
                  : entry.content
                )
                  .replace(/\s+/g, " ")
                  .trim(),
                maxLen,
              ) || "Clip";
      };

      if (isBlock) {
        const header = document.createElement("span");
        header.className = "clip-embed-block-header";
        const hTitle = document.createElement("span");
        hTitle.className = "clip-embed-block-title";
        hTitle.textContent = getLabel(60);
        const hToggle = document.createElement("span");
        hToggle.className = "clip-embed-toggle clip-embed-toggle--collapse";
        hToggle.title = "Collapse embed";
        hToggle.innerHTML = SVG_COLLAPSE;
        header.append(mkIcon(iconSvg), hTitle, hToggle);

        const body = document.createElement("span");
        body.className = "clip-embed-block-body";
        if (entry.type === "image") {
          body.classList.add("clip-embed-block-body--image");
          const wrap = document.createElement("span");
          wrap.className = "clip-embed-image-resizable";
          const img = document.createElement("img");
          img.src = resolveImageSrc(entry.content, convertFileSrc);
          img.alt = entry.label ?? "Image";
          img.className = "clip-embed-block-image";
          wrap.append(img);
          body.append(wrap);
        } else if (entry.type === "html") {
          body.textContent = entry.content
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
        } else if (entry.type === "text") {
          body.textContent = entry.content;
        } else if (entry.type === "file") {
          const ps = filePaths(entry.content);
          body.textContent = ps[0] ? fileName(ps[0]) : "File attachment";
        }
        host.append(header, body, mkResizeHandle());
        requestAnimationFrame(() => {
          host.classList.toggle(
            "clip-embed--scrollable",
            body.scrollHeight > body.clientHeight + 1,
          );
        });
      } else {
        const text = document.createElement("span");
        text.className = "clip-embed-text";
        if (!entry) {
          text.textContent = "Missing clip";
          text.classList.add("clip-embed-fallback");
          host.append(mkIcon(SVG_MISSING), text);
          return;
        }
        text.textContent = getLabel(34);
        const toggle = document.createElement("span");
        toggle.className = "clip-embed-toggle";
        toggle.title = "Expand";
        toggle.innerHTML = SVG_EXPAND;
        host.append(mkIcon(iconSvg), text, toggle, mkResizeHandle());
      }
    }, []);

    const renderGroupEmbed = useCallback((host: HTMLElement) => {
      const name = host.getAttribute("data-group-ref") ?? "Group";
      const c = groupColor(name);
      host.className = [
        "group-embed",
        selectedEmbeds.current.has(host) && "ns-embed--selected",
      ]
        .filter(Boolean)
        .join(" ");
      host.setAttribute("contenteditable", "false");
      host.style.setProperty("background", c.bg);
      host.style.setProperty("color", c.fg);
      host.replaceChildren();
      const dot = document.createElement("span");
      dot.className = "group-embed-dot";
      const lbl = document.createElement("span");
      lbl.className = "group-embed-label";
      lbl.textContent = name;
      const hdl = document.createElement("span");
      hdl.className = "embed-resize-handle";
      hdl.setAttribute("data-embed-resize-handle", "true");
      hdl.setAttribute("data-tooltip", "Drag to resize");
      hdl.setAttribute("data-tooltip-pos", "left");
      hdl.innerHTML = SVG_RESIZE;
      host.append(dot, lbl, hdl);
    }, []);

    const renderEmbedsIn = useCallback(
      (el: HTMLElement) => {
        el.querySelectorAll("[data-clip-embed]").forEach((h) =>
          renderClipEmbed(h as HTMLElement),
        );
        el.querySelectorAll("[data-group-ref]").forEach((h) =>
          renderGroupEmbed(h as HTMLElement),
        );
      },
      [renderClipEmbed, renderGroupEmbed],
    );

    useEffect(() => {
      blockRefs.current.forEach((el) => renderEmbedsIn(el));
    }, [entries, renderEmbedsIn]);

    // ── Resize ─────────────────────────────────────────────────────────────

    const beginResize = useCallback(
      (host: HTMLElement, startEv: React.MouseEvent) => {
        activeResize.current?.();
        clearSelectedEmbeds();
        const rect = host.getBoundingClientRect();
        const sx = startEv.clientX,
          sy = startEv.clientY;
        const sw = Math.max(EMBED_MIN_W, rect.width),
          sh = Math.max(EMBED_MIN_H, rect.height);
        const minW = host.classList.contains("clip-embed--block")
          ? 180
          : EMBED_MIN_W;
        const minH = host.classList.contains("clip-embed--block")
          ? 44
          : EMBED_MIN_H;
        host.classList.add("ns-embed--resizing");

        const onMove = (e: MouseEvent) => {
          const w = Math.round(Math.max(minW, sw + e.clientX - sx));
          const h = Math.round(Math.max(minH, sh + e.clientY - sy));
          host.style.width = `${w}px`;
          host.style.height = `${h}px`;
          host.setAttribute("data-embed-width", String(w));
          host.setAttribute("data-embed-height", String(h));
          if (host.classList.contains("clip-embed--block")) {
            const body = host.querySelector(
              ".clip-embed-block-body",
            ) as HTMLElement | null;
            host.classList.toggle(
              "clip-embed--scrollable",
              !!body && body.scrollHeight > body.clientHeight + 1,
            );
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
      },
      [clearSelectedEmbeds, scheduleSave],
    );

    // ── Structural operations ─────────────────────────────────────────────

    const splitAtCursor = useCallback(
      (key: string) => {
        const idx = blocksRef.current.findIndex((b) => b.key === key);
        if (idx < 0) return;
        const { node } = blocksRef.current[idx];
        if (!isParaBlock(node)) return;
        const el = blockRefs.current.get(key);
        if (!el) return;

        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const r = sel.getRangeAt(0);
        if (!r.collapsed) r.deleteContents();

        const beforeInlines = inlinesFromRange(
          el,
          el,
          0,
          r.startContainer,
          r.startOffset,
        );
        const afterInlines = inlinesFromRange(
          el,
          r.startContainer,
          r.startOffset,
          el,
          el.childNodes.length,
        );
        const align = ("align" in node ? (node as any).align : undefined) as
          | Alignment
          | undefined;
        const indent = ("indent" in node ? (node as any).indent : undefined) as
          | number
          | undefined;

        const firstNode: BlockNode =
          node.type === "todo"
            ? {
                type: "todo",
                children: beforeInlines,
                checked: node.checked,
                ...(align ? { align } : {}),
                ...(indent ? { indent } : {}),
              }
            : isAlignableBlock(node)
              ? ({
                  type: node.type,
                  children: beforeInlines,
                  ...(align ? { align } : {}),
                  ...(indent ? { indent } : {}),
                } as BlockNode)
              : ({
                  type: node.type,
                  children: beforeInlines,
                  ...(indent ? { indent } : {}),
                } as BlockNode);

        const secondNode: BlockNode =
          node.type === "todo"
            ? {
                type: "todo",
                children: afterInlines,
                checked: false,
                ...(indent ? { indent } : {}),
              }
            : { type: "p", children: afterInlines };

        const k1 = genKey(),
          k2 = genKey();
        setBlocks((current) => {
          const i = current.findIndex((b) => b.key === key);
          if (i < 0) return current;
          const next: BlockState[] = [
            ...current.slice(0, i),
            { key: k1, node: firstNode },
            { key: k2, node: secondNode },
            ...current.slice(i + 1),
          ];
          requestAnimationFrame(() => {
            const e2 = blockRefs.current.get(k2);
            if (e2) placeCursorAt(e2, false);
          });
          onChange({ v: 2, nodes: next.map((b) => b.node) });
          return next;
        });
      },
      [onChange],
    );

    const mergeWithPrev = useCallback(
      (key: string) => {
        const idx = blocksRef.current.findIndex((b) => b.key === key);
        if (idx <= 0) return;
        const prev = blocksRef.current[idx - 1];
        const cur = blocksRef.current[idx];
        if (!isParaBlock(prev.node)) return;

        const prevEl = blockRefs.current.get(prev.key);
        const curEl = blockRefs.current.get(cur.key);
        const prevInlines = prevEl
          ? parseInlines(prevEl)
          : isParaBlock(prev.node)
            ? prev.node.children
            : [];
        const curInlines = curEl
          ? parseInlines(curEl)
          : isParaBlock(cur.node)
            ? cur.node.children
            : isListBlock(cur.node)
              ? cur.node.items.flatMap((it) => it.children)
              : [];

        const mergedKey = genKey();
        const align = ("align" in prev.node ? (prev.node as any).align : undefined) as
          | Alignment
          | undefined;
        const indent = ("indent" in prev.node ? (prev.node as any).indent : undefined) as
          | number
          | undefined;
        const mergedNode: BlockNode =
          prev.node.type === "todo"
            ? {
                type: "todo",
                children: [...prevInlines, ...curInlines],
                checked: prev.node.checked,
                ...(align ? { align } : {}),
                ...(indent ? { indent } : {}),
              }
            : isAlignableBlock(prev.node)
              ? ({
                  type: prev.node.type as ParaBlockType,
                  children: [...prevInlines, ...curInlines],
                  ...(align ? { align } : {}),
                  ...(indent ? { indent } : {}),
                } as BlockNode)
              : ({
                  type: prev.node.type as ParaBlockType,
                  children: [...prevInlines, ...curInlines],
                  ...(indent ? { indent } : {}),
                } as BlockNode);

        const joinOffset = inlineLength(prevInlines);
        setBlocks((current) => {
          const i = current.findIndex((b) => b.key === key);
          if (i <= 0) return current;
          const next: BlockState[] = [
            ...current.slice(0, i - 1),
            { key: mergedKey, node: mergedNode },
            ...current.slice(i + 1),
          ];
          requestAnimationFrame(() => {
            const el = blockRefs.current.get(mergedKey);
            if (el) placeCursorAtTextOffset(el, joinOffset);
          });
          onChange({ v: 2, nodes: next.map((b) => b.node) });
          return next;
        });
      },
      [onChange],
    );

    const updateBlockType = useCallback(
      (key: string, newType: BlockType) => {
        const idx = blocksRef.current.findIndex((b) => b.key === key);
        if (idx < 0) return;
        const el = blockRefs.current.get(key);
        const curNode = blocksRef.current[idx].node;
        const inlines: InlineNode[] = el
          ? parseInlines(el)
          : isParaBlock(curNode)
            ? curNode.children
            : isListBlock(curNode)
              ? (curNode.items[0]?.children ?? [])
              : [];

        let newNode: BlockNode;
        if (newType === "ul" || newType === "ol")
          newNode = { type: newType, items: [{ children: inlines, level: 0 }] };
        else if (newType === "hr") newNode = { type: "hr" };
        else if (newType === "todo")
          newNode = { type: "todo", children: inlines, checked: false };
        else if (newType === "code")
          newNode = { type: "code", children: inlines };
        else newNode = { type: newType, children: inlines } as BlockNode;

        setFocusedType(newType);
        const newKey = genKey();
        setBlocks((current) => {
          const i = current.findIndex((b) => b.key === key);
          if (i < 0) return current;
          const next = current.map((b, j) =>
            j === i ? { key: newKey, node: newNode } : b,
          );
          requestAnimationFrame(() => {
            const e2 = blockRefs.current.get(newKey);
            if (e2) placeCursorAt(e2, true);
          });
          onChange({ v: 2, nodes: next.map((b) => b.node) });
          return next;
        });
      },
      [onChange],
    );

    const toggleTodo = useCallback(
      (key: string) => {
        setBlocks((current) => {
          const idx = current.findIndex((b) => b.key === key);
          if (idx < 0) return current;
          const old = current[idx].node;
          if (old.type !== "todo") return current;
          const updated: BlockNode = { ...old, checked: !old.checked };
          const newKey = genKey();
          const next = current.map((b, i) =>
            i === idx ? { key: newKey, node: updated } : b,
          );
          requestAnimationFrame(() => onChange({ v: 2, nodes: next.map((b) => b.node) }));
          return next;
        });
      },
      [onChange],
    );

    const setAlignment = useCallback(
      (align: Alignment | null) => {
        const key = focusedKeyRef.current;
        if (!key) return;
        const el = blockRefs.current.get(key);
        if (el) {
          if (align) el.setAttribute("data-align", align);
          else el.removeAttribute("data-align");
          el.className = el.className.replace(/\s*ns-be-align-\w+/g, "").trim();
          if (align) el.classList.add(`ns-be-align-${align}`);
        }
        setFocusedAlign(align);
        setBlocks((current) => {
          const idx = current.findIndex((b) => b.key === key);
          if (idx < 0) return current;
          const old = current[idx].node;
          if (!isAlignableBlock(old)) return current;
          const updated = { ...old, align: align ?? undefined } as BlockNode;
          const next = current.map((b, i) => (i === idx ? { ...b, node: updated } : b));
          return next;
        });
        scheduleSave();
      },
      [scheduleSave],
    );

    // ── Indent / outdent ───────────────────────────────────────────────────

    const adjustIndent = useCallback(
      (dir: 1 | -1) => {
        const cb = currentBlock();
        if (!cb) return;
        const t = cb.state.node.type;

        if (t === "ul" || t === "ol") {
          // Find <li> containing the cursor or selection
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount) return;
          const r = sel.getRangeAt(0);
          let n: Node | null = r.startContainer;
          let li: HTMLElement | null = null;
          while (n && n !== cb.el) {
            if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === "LI") {
              li = n as HTMLElement;
              break;
            }
            n = n.parentNode;
          }
          if (!li) return;
          const cur =
            parseInt(li.getAttribute("data-level") ?? "0", 10) || 0;
          const next = Math.max(0, Math.min(MAX_INDENT, cur + dir));
          setLiLevelClass(li, next);
          scheduleSave();
          return;
        }

        if (!isIndentableBlock(cb.state.node)) return;
        const cur =
          parseInt(cb.el.getAttribute("data-indent") ?? "0", 10) || 0;
        const next = Math.max(0, Math.min(MAX_INDENT, cur + dir));
        setIndentClass(cb.el, next);
        scheduleSave();
      },
      [currentBlock, scheduleSave],
    );

    // ── Cross-block delete ────────────────────────────────────────────────

    const deleteAcrossBlocks = useCallback(
      (startEl: HTMLElement, endEl: HTMLElement, range: Range) => {
        const startKey = startEl.getAttribute("data-block-key");
        const endKey = endEl.getAttribute("data-block-key");
        if (!startKey || !endKey) return;

        // Inlines preserved before the selection start (within startEl)
        const beforeInlines = inlinesFromRange(
          startEl,
          startEl,
          0,
          range.startContainer,
          range.startOffset,
        );
        // Inlines preserved after the selection end (within endEl)
        const afterInlines = inlinesFromRange(
          endEl,
          range.endContainer,
          range.endOffset,
          endEl,
          endEl.childNodes.length,
        );

        setBlocks((current) => {
          const sIdx = current.findIndex((b) => b.key === startKey);
          const eIdx = current.findIndex((b) => b.key === endKey);
          if (sIdx < 0 || eIdx < 0 || sIdx > eIdx) return current;

          const startNode = current[sIdx].node;
          const merged: InlineNode[] = [...beforeInlines, ...afterInlines];

          let newNode: BlockNode;
          if (startNode.type === "ul" || startNode.type === "ol") {
            // Convert merged remainder into a single list item at level 0
            newNode = { type: startNode.type, items: [{ children: merged, level: 0 }] };
          } else if (isParaBlock(startNode) && startNode.type !== "code") {
            const align = ("align" in startNode ? (startNode as any).align : undefined) as
              | Alignment
              | undefined;
            const indent = ("indent" in startNode ? (startNode as any).indent : undefined) as
              | number
              | undefined;
            if (startNode.type === "todo") {
              newNode = {
                type: "todo",
                children: merged,
                checked: startNode.checked,
                ...(align ? { align } : {}),
                ...(indent ? { indent } : {}),
              };
            } else if (isAlignableBlock(startNode)) {
              newNode = {
                type: startNode.type,
                children: merged,
                ...(align ? { align } : {}),
                ...(indent ? { indent } : {}),
              } as BlockNode;
            } else {
              newNode = {
                type: startNode.type as ParaBlockType,
                children: merged,
                ...(indent ? { indent } : {}),
              } as BlockNode;
            }
          } else if (startNode.type === "code") {
            newNode = { type: "code", children: merged };
          } else {
            newNode = { type: "p", children: merged };
          }

          const newKey = genKey();
          const next: BlockState[] = [
            ...current.slice(0, sIdx),
            { key: newKey, node: newNode },
            ...current.slice(eIdx + 1),
          ];

          // Ensure at least one block
          if (next.length === 0) {
            next.push({ key: genKey(), node: { type: "p", children: [] } });
          }

          const cursorOffset = inlineLength(beforeInlines);
          requestAnimationFrame(() => {
            const el =
              blockRefs.current.get(newKey) ??
              blockRefs.current.get(next[0].key);
            if (!el) return;
            placeCursorAtTextOffset(el, cursorOffset);
          });

          onChange({ v: 2, nodes: next.map((b) => b.node) });
          return next;
        });
      },
      [onChange],
    );

    // ── Inline insert ─────────────────────────────────────────────────────

    const insertInlineSpan = useCallback(
      (span: HTMLElement) => {
        const container = containerRef.current;
        if (!container) return;
        if (savedRange.current) {
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(savedRange.current);
          savedRange.current = null;
        }
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) {
          // Fallback: append to last block
          const last = blocksRef.current[blocksRef.current.length - 1];
          const lastEl = last && blockRefs.current.get(last.key);
          if (lastEl) {
            lastEl.appendChild(span);
            lastEl.appendChild(document.createTextNode(" "));
          }
          renderClipEmbed(span);
          scheduleSave();
          return;
        }
        const r = sel.getRangeAt(0);
        if (!container.contains(r.commonAncestorContainer)) {
          const last = blocksRef.current[blocksRef.current.length - 1];
          const lastEl = last && blockRefs.current.get(last.key);
          if (lastEl) {
            lastEl.appendChild(span);
            lastEl.appendChild(document.createTextNode(" "));
          }
          renderClipEmbed(span);
          scheduleSave();
          return;
        }
        r.deleteContents();
        r.insertNode(span);
        const space = document.createTextNode(" ");
        span.after(space);
        r.setStart(space, 1);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        renderClipEmbed(span);
        scheduleSave();
      },
      [renderClipEmbed, scheduleSave],
    );

    // ── Imperative handle ─────────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        execFmt: (cmd, value) => {
          const container = containerRef.current;
          if (!container) return;
          container.focus({ preventScroll: true });
          if (savedRange.current) {
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(savedRange.current);
            savedRange.current = null;
          }
          document.execCommand(cmd, false, value);
          scheduleSave();
        },
        getFormatState: () => {
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount) return emptyFormatState();
          const container = containerRef.current;
          if (!container) return emptyFormatState();
          if (!container.contains(sel.getRangeAt(0).commonAncestorContainer))
            return emptyFormatState();
          return {
            bold: document.queryCommandState("bold"),
            italic: document.queryCommandState("italic"),
            underline: document.queryCommandState("underline"),
            strikethrough: document.queryCommandState("strikeThrough"),
          };
        },
        setBlockType: (type) => {
          const key = focusedKeyRef.current;
          if (key) updateBlockType(key, type);
        },
        getBlockType: () => focusedTypeRef.current,
        setAlignment,
        getAlignment: () => focusedAlignRef.current,
        indent: () => adjustIndent(1),
        outdent: () => adjustIndent(-1),
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
          const container = containerRef.current;
          if (!container) return;
          container.focus({ preventScroll: true });
          if (savedRange.current) {
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(savedRange.current);
            savedRange.current = null;
          }
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed)
            document.execCommand("createLink", false, url);
          else
            document.execCommand(
              "insertHTML",
              false,
              `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
            );
          scheduleSave();
        },
        saveRange: () => {
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0)
            savedRange.current = sel.getRangeAt(0).cloneRange();
        },
        focus: () => {
          containerRef.current?.focus({ preventScroll: true });
        },
        flush,
      }),
      [
        adjustIndent,
        flush,
        insertInlineSpan,
        renderGroupEmbed,
        scheduleSave,
        setAlignment,
        updateBlockType,
      ],
    );

    // ── Container key handler ─────────────────────────────────────────────

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        const container = containerRef.current;
        if (!container) return;
        const sel = window.getSelection();
        if (!sel) return;

        // Ctrl/Cmd+A → let the browser select within this single contenteditable.
        // (Native behavior on a unified surface already covers everything.)

        // Tab / Shift+Tab → indent / outdent
        if (e.key === "Tab") {
          e.preventDefault();
          const cb = currentBlock();
          if (!cb) return;
          if (cb.state.node.type === "code") {
            document.execCommand("insertText", false, "\t");
            scheduleSave();
            return;
          }
          adjustIndent(e.shiftKey ? -1 : 1);
          return;
        }

        // Selected embeds
        if (selectedEmbeds.current.size > 0) {
          if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            const sels = Array.from(selectedEmbeds.current);
            clearSelectedEmbeds();
            sels.forEach((h) => h.remove());
            scheduleSave();
            return;
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const host = Array.from(selectedEmbeds.current)[0];
            if (host) {
              clearSelectedEmbeds();
              const r = document.createRange();
              if (e.key === "ArrowLeft") r.setStartBefore(host);
              else r.setStartAfter(host);
              r.collapse(true);
              window.getSelection()?.removeAllRanges();
              window.getSelection()?.addRange(r);
            }
            return;
          }
        }

        // Cross-block delete: when selection spans different blocks
        if (
          (e.key === "Backspace" || e.key === "Delete") &&
          sel.rangeCount &&
          !sel.isCollapsed
        ) {
          const r = sel.getRangeAt(0);
          const startBlock = blockElFromNode(r.startContainer, container);
          const endBlock = blockElFromNode(r.endContainer, container);
          if (startBlock && endBlock && startBlock !== endBlock) {
            e.preventDefault();
            deleteAcrossBlocks(startBlock, endBlock, r);
            return;
          }
          // Same block → let browser handle native delete
        }

        const cb = currentBlock();
        if (!cb) return;
        const { el, key, state } = cb;
        const type = state.node.type;

        // Code block: Enter at end → new paragraph; Enter inside → newline; Escape → to paragraph
        if (type === "code") {
          if (e.key === "Escape") {
            e.preventDefault();
            updateBlockType(key, "p");
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (caretAtEnd(el)) {
              const newKey = genKey();
              setBlocks((current) => {
                const idx = current.findIndex((b) => b.key === key);
                if (idx < 0) return current;
                const next: BlockState[] = [
                  ...current.slice(0, idx + 1),
                  { key: newKey, node: { type: "p", children: [] } },
                  ...current.slice(idx + 1),
                ];
                requestAnimationFrame(() => {
                  const e2 = blockRefs.current.get(newKey);
                  if (e2) placeCursorAt(e2, false);
                });
                onChange({ v: 2, nodes: next.map((b) => b.node) });
                return next;
              });
            } else {
              document.execCommand("insertText", false, "\n");
              scheduleSave();
            }
            return;
          }
          if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            splitAtCursor(key);
            return;
          }
        }

        // Backspace on empty code/blockquote/heading exits to paragraph
        if (
          e.key === "Backspace" &&
          caretAtStart(el) &&
          (type === "code" || type === "bq") &&
          !hasNonEmptyContent(el)
        ) {
          e.preventDefault();
          updateBlockType(key, "p");
          return;
        }

        // Backspace at start of indented block → outdent first
        if (e.key === "Backspace" && caretAtStart(el) && isIndentableBlock(state.node)) {
          const cur = parseInt(el.getAttribute("data-indent") ?? "0", 10) || 0;
          if (cur > 0) {
            e.preventDefault();
            setIndentClass(el, cur - 1);
            scheduleSave();
            return;
          }
        }

        // Todo: Enter on empty → convert to p; else split
        if (e.key === "Enter" && !e.shiftKey && type === "todo") {
          e.preventDefault();
          const clone = el.cloneNode(true) as HTMLElement;
          clone.querySelector("[data-todo-check]")?.remove();
          if (!clone.textContent?.trim()) updateBlockType(key, "p");
          else splitAtCursor(key);
          return;
        }

        // Para/heading/bq: Enter splits
        if (
          e.key === "Enter" &&
          !e.shiftKey &&
          (type === "p" ||
            type === "h1" ||
            type === "h2" ||
            type === "h3" ||
            type === "bq")
        ) {
          e.preventDefault();
          splitAtCursor(key);
          return;
        }

        // List behavior
        if (type === "ul" || type === "ol") {
          // Find current <li>
          let n: Node | null = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
          let li: HTMLElement | null = null;
          while (n && n !== el) {
            if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === "LI") {
              li = n as HTMLElement;
              break;
            }
            n = n.parentNode;
          }

          // Enter on empty trailing item → if level > 0 outdent; else exit to paragraph
          if (e.key === "Enter" && !e.shiftKey && li && !li.textContent?.trim()) {
            const lvl = parseInt(li.getAttribute("data-level") ?? "0", 10) || 0;
            if (lvl > 0) {
              e.preventDefault();
              setLiLevelClass(li, lvl - 1);
              scheduleSave();
              return;
            }
            if (!li.nextElementSibling) {
              e.preventDefault();
              li.remove();
              const newKey = genKey();
              setBlocks((current) => {
                const idx = current.findIndex((b) => b.key === key);
                if (idx < 0) return current;
                // If list now has no remaining items, drop the list block entirely
                const remainingItems = el.querySelectorAll(":scope > li").length;
                const after = remainingItems
                  ? [
                      ...current.slice(0, idx + 1),
                      { key: newKey, node: { type: "p", children: [] } as BlockNode },
                      ...current.slice(idx + 1),
                    ]
                  : [
                      ...current.slice(0, idx),
                      { key: newKey, node: { type: "p", children: [] } as BlockNode },
                      ...current.slice(idx + 1),
                    ];
                requestAnimationFrame(() => {
                  const e2 = blockRefs.current.get(newKey);
                  if (e2) placeCursorAt(e2, false);
                });
                onChange({ v: 2, nodes: after.map((b) => b.node) });
                return after;
              });
              return;
            }
          }

          // Backspace at start of first <li> with no content and no level → exit list to paragraph
          if (
            e.key === "Backspace" &&
            li &&
            caretAtStart(li) &&
            !li.previousElementSibling
          ) {
            const lvl = parseInt(li.getAttribute("data-level") ?? "0", 10) || 0;
            if (lvl > 0) {
              e.preventDefault();
              setLiLevelClass(li, lvl - 1);
              scheduleSave();
              return;
            }
            if (!hasNonEmptyContent(li)) {
              e.preventDefault();
              updateBlockType(key, "p");
              return;
            }
          }
          // Otherwise let browser handle Enter/Backspace within the list naturally
        }

        // Backspace at start → merge with previous (paragraph-like blocks)
        if (e.key === "Backspace" && caretAtStart(el) && isParaBlock(state.node)) {
          const idx = blocksRef.current.findIndex((b) => b.key === key);
          if (idx > 0 && isParaBlock(blocksRef.current[idx - 1].node)) {
            e.preventDefault();
            mergeWithPrev(key);
            return;
          }
        }

        // Arrow navigation across blocks
        if (e.key === "ArrowUp" && caretAtStart(el)) {
          const idx = blocksRef.current.findIndex((b) => b.key === key);
          if (idx > 0) {
            const prevEl = blockRefs.current.get(blocksRef.current[idx - 1].key);
            if (prevEl) {
              e.preventDefault();
              placeCursorAt(prevEl, true);
            }
          }
          return;
        }
        if (e.key === "ArrowDown" && caretAtEnd(el)) {
          const idx = blocksRef.current.findIndex((b) => b.key === key);
          if (idx >= 0 && idx < blocksRef.current.length - 1) {
            const nextEl = blockRefs.current.get(blocksRef.current[idx + 1].key);
            if (nextEl) {
              e.preventDefault();
              placeCursorAt(nextEl, false);
            }
          }
          return;
        }
      },
      [
        adjustIndent,
        clearSelectedEmbeds,
        currentBlock,
        deleteAcrossBlocks,
        mergeWithPrev,
        onChange,
        scheduleSave,
        splitAtCursor,
        updateBlockType,
      ],
    );

    // ── Mouse handlers ────────────────────────────────────────────────────

    const handleMouseDown = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const container = containerRef.current;
        if (!container) return;
        const target = e.target as HTMLElement;

        // Todo checkbox
        const checkEl = target.closest("[data-todo-check]") as HTMLElement | null;
        if (checkEl) {
          const blockEl = blockElFromNode(checkEl, container);
          const key = blockEl?.getAttribute("data-block-key");
          if (key) {
            e.preventDefault();
            toggleTodo(key);
            return;
          }
        }

        // Resize handle
        const resizeHandle = target.closest("[data-embed-resize-handle]");
        if (resizeHandle) {
          const host = resizeHandle.closest(
            "[data-clip-embed],[data-group-ref]",
          ) as HTMLElement | null;
          if (host) {
            e.preventDefault();
            beginResize(host, e);
            return;
          }
        }

        if (target.closest(".clip-embed-toggle")) return;

        const host = target.closest(
          "[data-clip-embed],[data-group-ref]",
        ) as HTMLElement | null;
        if (host) {
          e.preventDefault();
          const rect = host.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          if (frac < 0.22 || frac > 0.78) {
            clearSelectedEmbeds();
            const r = document.createRange();
            if (frac < 0.22) r.setStartBefore(host);
            else r.setStartAfter(host);
            r.collapse(true);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(r);
            container.focus({ preventScroll: true });
          } else {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) clearSelectedEmbeds();
            host.classList.add("ns-embed--selected");
            selectedEmbeds.current.add(host);
            const r = document.createRange();
            r.selectNode(host);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(r);
          }
        } else {
          clearSelectedEmbeds();
        }
      },
      [beginResize, clearSelectedEmbeds, toggleTodo],
    );

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const toggle = (e.target as HTMLElement).closest(".clip-embed-toggle");
        if (!toggle) return;
        e.preventDefault();
        const host = toggle.closest("[data-clip-embed]") as HTMLElement | null;
        if (!host) return;
        const cur = host.getAttribute("data-embed-mode") ?? "inline";
        host.setAttribute(
          "data-embed-mode",
          cur === "block" ? "inline" : "block",
        );
        renderClipEmbed(host);
        scheduleSave();
      },
      [renderClipEmbed, scheduleSave],
    );

    // Track caret-driven focus state for toolbar
    useEffect(() => {
      const handler = () => updateFocusFromSelection();
      document.addEventListener("selectionchange", handler);
      return () => document.removeEventListener("selectionchange", handler);
    }, [updateFocusFromSelection]);

    // ── Cleanup ────────────────────────────────────────────────────────────

    useEffect(
      () => () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        activeResize.current?.();
        clearSelectedEmbeds();
      },
      [clearSelectedEmbeds],
    );

    // ── Render ─────────────────────────────────────────────────────────────

    const showPlaceholder =
      blocks.length === 1 &&
      blocks[0].node.type === "p" &&
      isParaBlock(blocks[0].node) &&
      blocks[0].node.children.length === 0;

    return (
      <div
        ref={containerRef}
        className="ns-be"
        contentEditable
        suppressContentEditableWarning
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onInput={() => scheduleSave()}
      >
        {blocks.map(({ key, node }) => (
          <BlockEl
            key={key}
            bKey={key}
            node={node}
            blockRefs={blockRefs}
            renderEmbedsIn={renderEmbedsIn}
          />
        ))}
        {showPlaceholder && (
          <div className="ns-be-placeholder" aria-hidden contentEditable={false}>
            Start writing…
          </div>
        )}
      </div>
    );
  },
);

BlockEditor.displayName = "BlockEditor";
export default BlockEditor;

// ── BlockEl ───────────────────────────────────────────────────────────────

interface BlockElProps {
  bKey: string;
  node: BlockNode;
  blockRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  renderEmbedsIn: (el: HTMLElement) => void;
}

const BlockEl: React.FC<BlockElProps> = ({
  bKey,
  node,
  blockRefs,
  renderEmbedsIn,
}) => {
  const elRef = useRef<HTMLElement>(null);

  // Only re-runs on structural remount (key change), not during typing.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    blockRefs.current.set(bKey, el);
    el.innerHTML = getBlockHtml(node);
    renderEmbedsIn(el);
    return () => {
      blockRefs.current.delete(bKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bKey]);

  if (node.type === "hr") {
    return (
      <div
        ref={elRef as React.RefObject<HTMLDivElement>}
        className="ns-be-block ns-be-hr"
        data-be-block="true"
        data-block-key={bKey}
        contentEditable={false}
      >
        <hr />
      </div>
    );
  }

  const tag =
    node.type === "ul"
      ? "ul"
      : node.type === "ol"
        ? "ol"
        : node.type === "h1"
          ? "h1"
          : node.type === "h2"
            ? "h2"
            : node.type === "h3"
              ? "h3"
              : node.type === "bq"
                ? "blockquote"
                : node.type === "code"
                  ? "pre"
                  : "div";

  const align = ("align" in node ? (node as any).align : null) as Alignment | null;
  const indent = ("indent" in node ? (node as any).indent : 0) as number;
  const alignClass = align ? ` ns-be-align-${align}` : "";
  const indentClass = indent > 0 ? ` ns-be-indent-${indent}` : "";
  const todoClass =
    node.type === "todo" && node.checked ? " ns-be-todo--checked" : "";

  const props: any = {
    ref: elRef,
    className: `ns-be-block ns-be-${node.type}${alignClass}${indentClass}${todoClass}`,
    "data-be-block": "true",
    "data-block-key": bKey,
  };
  if (align) props["data-align"] = align;
  if (indent > 0) props["data-indent"] = String(indent);

  return React.createElement(tag, props);
};
