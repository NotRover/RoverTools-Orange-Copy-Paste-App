import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Note, ClipboardEntry } from "../../../../types";
import {
  classifyFileEntry,
  filePaths,
  groupColor,
  resolveImageSrc,
  timeAgo,
  truncateText,
} from "../../../../types";
import {
  CloseIcon,
  TrashIcon,
  PinIcon,
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  StrikethroughIcon,
  Heading1Icon,
  Heading2Icon,
  BulletListIcon,
  OrderedListIcon,
  QuoteIcon,
  EmbedClipIcon,
  CheckIcon,
  ImageIcon,
  FileIcon,
  ClipboardIcon,
  LinkIcon,
} from "../../../icons";
import {
  stripHtml,
  deriveNoteTitle,
  hasMeaningfulContent,
  fileName,
} from "../notes-utils";
import "./note-editor.css";

// ── Format state tracking ───────────────────────────────────────────

interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  unorderedList: boolean;
  orderedList: boolean;
}

function queryFormatState(): FormatState {
  return {
    bold: document.queryCommandState("bold"),
    italic: document.queryCommandState("italic"),
    underline: document.queryCommandState("underline"),
    strikethrough: document.queryCommandState("strikeThrough"),
    unorderedList: document.queryCommandState("insertUnorderedList"),
    orderedList: document.queryCommandState("insertOrderedList"),
  };
}

// ── Inline SVG strings for clip-embed type icons ─────────────────────

const SVG_IMAGE = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/></svg>`;
const SVG_FILE = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const SVG_TEXT = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>`;
const SVG_MISSING = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none"/></svg>`;
const SVG_EXPAND = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const SVG_COLLAPSE = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;

// ── NoteEditor Component ────────────────────────────────────────────

interface NoteEditorProps {
  note: Note;
  entries: ClipboardEntry[];
  availableGroups: string[];
  onUpdate: (id: string, title: string, content: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pin: boolean) => void;
  onSetGroups: (id: string, groups: string[]) => void;
  onCopyEntry?: (id: string) => void;
  onBack: () => void;
}

const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  entries,
  availableGroups,
  onUpdate,
  onDelete,
  onPin,
  onSetGroups,
  onCopyEntry,
  onBack,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showGroupDropdown, setShowGroupDropdown] = useState(false);
  const groupDropdownRef = useRef<HTMLDivElement>(null);
  const [formatState, setFormatState] = useState<FormatState>(queryFormatState);
  const currentNoteIdRef = useRef(note.id);

  // ── Embed / link picker state ──
  const [showEmbedPicker, setShowEmbedPicker] = useState(false);
  const [embedSearch, setEmbedSearch] = useState("");
  const [embedTab, setEmbedTab] = useState<"entries" | "groups">("entries");
  const embedPickerRef = useRef<HTMLDivElement>(null);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkPickerRef = useRef<HTMLDivElement>(null);
  // Saved cursor range — captured when a picker opens so we can restore it on insert.
  const savedRangeRef = useRef<Range | null>(null);
  void onCopyEntry;

  const initialTitle = useMemo(
    () => deriveNoteTitle(note.title, note.content),
    [note.title, note.content],
  );

  // ── Format state tracking via selectionchange ──
  useEffect(() => {
    const update = () => setFormatState(queryFormatState());
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  // Render a single clipboard embed host element (inline chip or block card).
  const renderClipEmbed = useCallback(
    (host: HTMLElement) => {
      const embedId = host.getAttribute("data-clip-embed") ?? "";
      const embedMode = host.getAttribute("data-embed-mode") ?? "inline";
      const entry = entries.find((e) => e.id === embedId);

      const typeClass = !entry
        ? "clip-embed--missing"
        : entry.type === "image"
          ? "clip-embed--image"
          : entry.type === "file"
            ? "clip-embed--file"
            : "";
      const isBlock = embedMode === "block" && !!entry;
      host.className = ["clip-embed", typeClass, isBlock && "clip-embed--block"]
        .filter(Boolean)
        .join(" ");
      host.replaceChildren();

      const mkIcon = (svgStr: string): HTMLElement => {
        const s = document.createElement("span");
        s.className = "clip-embed-icon";
        s.innerHTML = svgStr;
        return s;
      };

      const entryIconSvg = !entry
        ? SVG_MISSING
        : entry.type === "image"
          ? SVG_IMAGE
          : entry.type === "file"
            ? SVG_FILE
            : SVG_TEXT;

      const getEntryLabel = (maxLen: number): string => {
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
                  ? stripHtml(entry.content)
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
        hTitle.textContent = getEntryLabel(60);
        const hToggle = document.createElement("span");
        hToggle.className = "clip-embed-toggle clip-embed-toggle--collapse";
        hToggle.title = "Collapse embed";
        hToggle.innerHTML = SVG_COLLAPSE;
        header.append(mkIcon(entryIconSvg), hTitle, hToggle);

        const body = document.createElement("span");
        body.className = "clip-embed-block-body";
        if (entry.type === "image") {
          body.classList.add("clip-embed-block-body--image");
          const wrapper = document.createElement("span");
          wrapper.className = "clip-embed-image-resizable";
          const img = document.createElement("img");
          img.src = resolveImageSrc(entry.content, convertFileSrc);
          img.alt = entry.label ?? "Image";
          img.className = "clip-embed-block-image";
          wrapper.append(img);
          body.append(wrapper);
        } else if (entry.type === "html") {
          body.textContent = stripHtml(entry.content)
            .replace(/\s+/g, " ")
            .trim();
        } else if (entry.type === "text") {
          body.textContent = entry.content;
        } else if (entry.type === "file") {
          const paths = filePaths(entry.content);
          body.textContent = paths[0] ? fileName(paths[0]) : "File attachment";
        }

        host.append(header, body);
      } else {
        const text = document.createElement("span");
        text.className = "clip-embed-text";

        if (!entry) {
          text.textContent = "Missing clip";
          text.classList.add("clip-embed-fallback");
          host.append(mkIcon(SVG_MISSING), text);
          return;
        }

        text.textContent = getEntryLabel(34);

        const toggle = document.createElement("span");
        toggle.className = "clip-embed-toggle";
        toggle.title = "Expand embed";
        toggle.innerHTML = SVG_EXPAND;

        host.append(mkIcon(entryIconSvg), text, toggle);
      }
    },
    [entries],
  );

  // Re-render all clip embeds whenever entries change.
  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.querySelectorAll("[data-clip-embed]").forEach((el) => {
      renderClipEmbed(el as HTMLElement);
    });
  }, [renderClipEmbed]);

  // Render group reference placeholders.
  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.querySelectorAll("[data-group-ref]").forEach((el) => {
      const groupName = el.getAttribute("data-group-ref")!;
      const c = groupColor(groupName);
      const host = el as HTMLElement;
      host.className = "group-embed";
      host.style.cssText = `background:${c.bg};color:${c.fg};`;
      host.replaceChildren();
      const dot = document.createElement("span");
      dot.className = "group-embed-dot";
      const label = document.createElement("span");
      label.className = "group-embed-label";
      label.textContent = groupName;
      host.append(dot, label);
    });
  });

  // Load content when note changes.
  useEffect(() => {
    if (currentNoteIdRef.current !== note.id) {
      currentNoteIdRef.current = note.id;
      if (editorRef.current) editorRef.current.innerHTML = note.content;
    }
  }, [note.id, note.content]);

  // Set initial content.
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== note.content) {
      editorRef.current.innerHTML = note.content;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus title for new empty notes.
  useEffect(() => {
    if (!note.title && !note.content && titleRef.current)
      titleRef.current.focus();
  }, [note.id]);

  // Ensure untitled notes are normalized as soon as the editor opens.
  useEffect(() => {
    if (!titleRef.current) return;
    if (titleRef.current.value.trim()) return;
    const nextTitle = deriveNoteTitle(note.title, note.content);
    titleRef.current.value = nextTitle;
    onUpdate(note.id, nextTitle, note.content);
  }, [note.id, note.title, note.content, onUpdate]);

  // Close group dropdown on outside click.
  useEffect(() => {
    if (!showGroupDropdown) return;
    const handler = (e: MouseEvent) => {
      if (
        groupDropdownRef.current &&
        !groupDropdownRef.current.contains(e.target as Node)
      )
        setShowGroupDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showGroupDropdown]);

  // Close embed picker on outside click.
  useEffect(() => {
    if (!showEmbedPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        embedPickerRef.current &&
        !embedPickerRef.current.contains(e.target as Node)
      )
        setShowEmbedPicker(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showEmbedPicker]);

  // Close link picker on outside click.
  useEffect(() => {
    if (!showLinkPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        linkPickerRef.current &&
        !linkPickerRef.current.contains(e.target as Node)
      ) {
        setShowLinkPicker(false);
        setLinkUrl("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showLinkPicker]);

  // Debounced auto-save.
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (!editorRef.current) return;
      const content = editorRef.current.innerHTML;
      const normalizedTitle = deriveNoteTitle(
        titleRef.current?.value ?? "",
        content,
      );
      if (titleRef.current && titleRef.current.value !== normalizedTitle) {
        titleRef.current.value = normalizedTitle;
      }
      onUpdate(note.id, normalizedTitle, content);
    }, 500);
  }, [note.id, onUpdate]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  // Flush before leaving.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        if (editorRef.current && titleRef.current) {
          const content = editorRef.current.innerHTML;
          const normalizedTitle = deriveNoteTitle(
            titleRef.current.value,
            content,
          );
          onUpdate(currentNoteIdRef.current, normalizedTitle, content);
        }
      }
    };
  }, [note.id]);

  const handleCloseEditor = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const content = editorRef.current?.innerHTML ?? note.content;
    if (!hasMeaningfulContent(content)) {
      onDelete(note.id);
      onBack();
      return;
    }

    const normalizedTitle = deriveNoteTitle(
      titleRef.current?.value ?? note.title,
      content,
    );
    if (titleRef.current) titleRef.current.value = normalizedTitle;
    onUpdate(note.id, normalizedTitle, content);
    onBack();
  }, [note.id, note.title, note.content, onDelete, onBack, onUpdate]);

  const execCmd = useCallback(
    (cmd: string, value?: string) => {
      editorRef.current?.focus();
      document.execCommand(cmd, false, value);
      scheduleSave();
      setTimeout(() => setFormatState(queryFormatState()), 0);
    },
    [scheduleSave],
  );

  // Restore saved selection range into the editor and return true on success.
  const restoreSavedRange = useCallback((): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    editor.focus();
    const saved = savedRangeRef.current;
    if (!saved) return false;
    savedRangeRef.current = null;
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(saved);
    return true;
  }, []);

  const insertInlineSpan = useCallback(
    (span: HTMLElement) => {
      const editor = editorRef.current;
      if (!editor) return;
      if (!restoreSavedRange()) editor.focus();
      const sel = window.getSelection();
      if (
        sel &&
        sel.rangeCount > 0 &&
        editor.contains(sel.getRangeAt(0).commonAncestorContainer)
      ) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(span);
        const space = document.createTextNode("\u00a0");
        span.after(space);
        range.setStart(space, 1);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editor.appendChild(span);
        editor.appendChild(document.createTextNode("\u00a0"));
      }
    },
    [restoreSavedRange],
  );

  const insertClipEmbed = useCallback(
    (id: string) => {
      const span = document.createElement("span");
      span.setAttribute("data-clip-embed", id);
      span.setAttribute("contenteditable", "false");
      span.textContent = `[clip:${id}]`;
      insertInlineSpan(span);
      scheduleSave();
      setShowEmbedPicker(false);
    },
    [insertInlineSpan, scheduleSave],
  );

  const insertGroupEmbed = useCallback(
    (group: string) => {
      const span = document.createElement("span");
      span.setAttribute("data-group-ref", group);
      span.setAttribute("contenteditable", "false");
      span.textContent = `[#${group}]`;
      insertInlineSpan(span);
      scheduleSave();
      setShowEmbedPicker(false);
    },
    [insertInlineSpan, scheduleSave],
  );

  const insertLink = useCallback(
    (url: string) => {
      if (!url.trim()) return;
      const editor = editorRef.current;
      if (!editor) return;
      if (!restoreSavedRange()) editor.focus();
      const sel = window.getSelection();
      const hasSelection = sel && !sel.isCollapsed;
      if (hasSelection) {
        document.execCommand("createLink", false, url.trim());
      } else {
        document.execCommand(
          "insertHTML",
          false,
          `<a href="${url.trim()}" target="_blank" rel="noopener noreferrer">${url.trim()}</a>`,
        );
      }
      scheduleSave();
      setShowLinkPicker(false);
      setLinkUrl("");
    },
    [restoreSavedRange, scheduleSave],
  );

  const toggleGroup = useCallback(
    (group: string) => {
      const next = note.groups.includes(group)
        ? note.groups.filter((g) => g !== group)
        : [...note.groups, group];
      onSetGroups(note.id, next);
    },
    [note.id, note.groups, onSetGroups],
  );

  const updateFormat = () => setFormatState(queryFormatState());

  // Filtered entries / groups for the embed picker
  const filteredPickerEntries = useMemo(() => {
    const q = embedSearch.trim().toLowerCase();
    const list = q
      ? entries.filter((e) => {
          const text = e.type === "html" ? stripHtml(e.content) : e.content;
          return (
            text.toLowerCase().includes(q) ||
            (e.label ?? "").toLowerCase().includes(q)
          );
        })
      : entries;
    return list.slice(0, 50);
  }, [entries, embedSearch]);

  const filteredPickerGroups = useMemo(() => {
    const q = embedSearch.trim().toLowerCase();
    return q
      ? availableGroups.filter((g) => g.toLowerCase().includes(q))
      : availableGroups;
  }, [availableGroups, embedSearch]);

  return (
    <div className="ns-editor-shell">
      <div className="ns-editor">
        {/* Header */}
        <div className="ns-editor-header">
          <button
            className="ns-back-btn"
            onClick={handleCloseEditor}
            data-tooltip="Close editor"
            data-tooltip-pos="right"
          >
            <CloseIcon size={12} />
          </button>
          <input
            ref={titleRef}
            className="ns-title-input"
            placeholder="Note title"
            defaultValue={initialTitle}
            key={note.id}
            onChange={scheduleSave}
          />
          <div className="ns-editor-actions">
            <button
              className={`ns-tb-btn${note.pinned ? " ns-tb-btn--active" : ""}`}
              onClick={() => onPin(note.id, !note.pinned)}
              data-tooltip={note.pinned ? "Unpin" : "Pin"}
              data-tooltip-pos="below"
            >
              <PinIcon size={12} filled={note.pinned} />
            </button>
            <button
              className="ns-tb-btn ns-tb-btn--danger"
              onClick={() => {
                onDelete(note.id);
                onBack();
              }}
              data-tooltip="Delete"
              data-tooltip-pos="below"
            >
              <TrashIcon size={11} />
            </button>
          </div>
        </div>

        {/* Group chips */}
        <div className="ns-editor-groups">
          {note.groups.map((g) => {
            const c = groupColor(g);
            return (
              <button
                key={g}
                className="ns-editor-group-chip"
                style={{ background: c.bg, color: c.fg }}
                onClick={() => toggleGroup(g)}
                title={`Remove from "${g}"`}
              >
                <span className="ns-chip-dot" />
                <span className="ns-chip-label">{g}</span>
              </button>
            );
          })}
          <div style={{ position: "relative" }} ref={groupDropdownRef}>
            <button
              className="ns-add-group-btn"
              onClick={() => setShowGroupDropdown((p) => !p)}
              title="Add to group"
            >
              +
            </button>
            {showGroupDropdown && (
              <div className="ns-group-dropdown">
                {availableGroups.length === 0 ? (
                  <div
                    className="ns-group-dropdown-item"
                    style={{ color: "var(--text-muted)", cursor: "default" }}
                  >
                    No groups yet
                  </div>
                ) : (
                  availableGroups.map((g) => {
                    const c = groupColor(g);
                    const isIn = note.groups.includes(g);
                    return (
                      <button
                        key={g}
                        className="ns-group-dropdown-item"
                        onClick={() => toggleGroup(g)}
                      >
                        <span
                          className="ns-group-dropdown-dot"
                          style={{ background: c.fg }}
                        />
                        {g}
                        {isIn && (
                          <CheckIcon
                            size={11}
                            className="ns-group-dropdown-check"
                          />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {/* Formatting toolbar */}
        <div className="ns-format-bar">
          <button
            className={`ns-fmt-btn${formatState.bold ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("bold")}
            data-tooltip="Bold (Ctrl+B)"
            data-tooltip-pos="below"
          >
            <BoldIcon size={13} />
          </button>
          <button
            className={`ns-fmt-btn${formatState.italic ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("italic")}
            data-tooltip="Italic (Ctrl+I)"
            data-tooltip-pos="below"
          >
            <ItalicIcon size={13} />
          </button>
          <button
            className={`ns-fmt-btn${formatState.underline ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("underline")}
            data-tooltip="Underline (Ctrl+U)"
            data-tooltip-pos="below"
          >
            <UnderlineIcon size={13} />
          </button>
          <button
            className={`ns-fmt-btn${formatState.strikethrough ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("strikeThrough")}
            data-tooltip="Strikethrough"
            data-tooltip-pos="below"
          >
            <StrikethroughIcon size={13} />
          </button>

          <span className="ns-fmt-sep" />

          <button
            className="ns-fmt-btn"
            onClick={() => execCmd("formatBlock", "h1")}
            data-tooltip="Heading 1"
            data-tooltip-pos="below"
          >
            <Heading1Icon size={14} />
          </button>
          <button
            className="ns-fmt-btn"
            onClick={() => execCmd("formatBlock", "h2")}
            data-tooltip="Heading 2"
            data-tooltip-pos="below"
          >
            <Heading2Icon size={14} />
          </button>

          <span className="ns-fmt-sep" />

          <button
            className={`ns-fmt-btn${formatState.unorderedList ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("insertUnorderedList")}
            data-tooltip="Bullet list"
            data-tooltip-pos="below"
          >
            <BulletListIcon size={13} />
          </button>
          <button
            className={`ns-fmt-btn${formatState.orderedList ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("insertOrderedList")}
            data-tooltip="Numbered list"
            data-tooltip-pos="below"
          >
            <OrderedListIcon size={13} />
          </button>
          <button
            className="ns-fmt-btn"
            onClick={() => execCmd("formatBlock", "blockquote")}
            data-tooltip="Quote"
            data-tooltip-pos="below"
          >
            <QuoteIcon size={13} />
          </button>

          <span className="ns-fmt-sep" />

          {/* Link picker */}
          <div className="ns-embed-wrap" ref={linkPickerRef}>
            <button
              className={`ns-fmt-btn${showLinkPicker ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                const sel = window.getSelection();
                if (
                  sel &&
                  sel.rangeCount > 0 &&
                  editorRef.current?.contains(
                    sel.getRangeAt(0).commonAncestorContainer,
                  )
                )
                  savedRangeRef.current = sel.getRangeAt(0).cloneRange();
                setShowLinkPicker((p) => !p);
                setShowEmbedPicker(false);
              }}
              data-tooltip="Insert link"
              data-tooltip-pos="below"
            >
              <LinkIcon size={12} />
            </button>
            {showLinkPicker && (
              <div className="ns-embed-picker ns-link-picker">
                <div className="ns-link-picker-row">
                  <input
                    className="ns-embed-search ns-link-input"
                    placeholder="https://…"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") insertLink(linkUrl);
                      if (e.key === "Escape") {
                        setShowLinkPicker(false);
                        setLinkUrl("");
                      }
                    }}
                    autoFocus
                  />
                  <button
                    className="ns-link-insert-btn"
                    onClick={() => insertLink(linkUrl)}
                    disabled={!linkUrl.trim()}
                  >
                    Insert
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Embed picker */}
          <div className="ns-embed-wrap" ref={embedPickerRef}>
            <button
              className={`ns-fmt-btn${showEmbedPicker ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                const sel = window.getSelection();
                if (
                  sel &&
                  sel.rangeCount > 0 &&
                  editorRef.current?.contains(
                    sel.getRangeAt(0).commonAncestorContainer,
                  )
                )
                  savedRangeRef.current = sel.getRangeAt(0).cloneRange();
                setShowEmbedPicker((p) => !p);
                setShowLinkPicker(false);
                setEmbedSearch("");
              }}
              data-tooltip="Embed clipboard entry"
              data-tooltip-pos="below"
            >
              <EmbedClipIcon size={13} />
            </button>
            {showEmbedPicker && (
              <div className="ns-embed-picker">
                <div className="ns-embed-picker-tabs">
                  <button
                    className={`ns-embed-tab${embedTab === "entries" ? " ns-embed-tab--active" : ""}`}
                    onClick={() => setEmbedTab("entries")}
                  >
                    Clipboard
                  </button>
                  <button
                    className={`ns-embed-tab${embedTab === "groups" ? " ns-embed-tab--active" : ""}`}
                    onClick={() => setEmbedTab("groups")}
                  >
                    Groups
                  </button>
                </div>
                <input
                  className="ns-embed-search"
                  placeholder={
                    embedTab === "entries"
                      ? "Search entries…"
                      : "Search groups…"
                  }
                  value={embedSearch}
                  onChange={(e) => setEmbedSearch(e.target.value)}
                  autoFocus
                />
                <div className="ns-embed-list">
                  {embedTab === "entries" ? (
                    filteredPickerEntries.length === 0 ? (
                      <div className="ns-embed-empty">No entries found</div>
                    ) : (
                      filteredPickerEntries.map((entry) => {
                        const text =
                          entry.type === "image"
                            ? (entry.label ?? "Image")
                            : truncateText(
                                entry.type === "html"
                                  ? stripHtml(entry.content)
                                  : entry.content,
                                72,
                              );
                        return (
                          <button
                            key={entry.id}
                            className="ns-embed-item"
                            onClick={() => insertClipEmbed(entry.id)}
                          >
                            <span className="ns-embed-item-icon">
                              {entry.type === "image" ? (
                                <ImageIcon size={10} />
                              ) : entry.type === "file" ? (
                                <FileIcon size={10} />
                              ) : (
                                <ClipboardIcon size={10} />
                              )}
                            </span>
                            <span className="ns-embed-item-text">{text}</span>
                            <span className="ns-embed-item-time">
                              {timeAgo(entry.timestamp)}
                            </span>
                          </button>
                        );
                      })
                    )
                  ) : filteredPickerGroups.length === 0 ? (
                    <div className="ns-embed-empty">No groups found</div>
                  ) : (
                    filteredPickerGroups.map((group) => {
                      const c = groupColor(group);
                      return (
                        <button
                          key={group}
                          className="ns-embed-item"
                          onClick={() => insertGroupEmbed(group)}
                        >
                          <span
                            className="ns-embed-item-group"
                            style={{ background: c.bg, color: c.fg }}
                          >
                            <span
                              className="ns-embed-group-dot"
                              style={{ background: c.fg }}
                            />
                            {group}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Richtext editor */}
        <div className="ns-editor-content">
          <div
            ref={editorRef}
            className="ns-richtext"
            contentEditable
            suppressContentEditableWarning
            onClick={(e) => {
              const toggle = (e.target as HTMLElement).closest(
                ".clip-embed-toggle",
              );
              if (toggle) {
                e.preventDefault();
                const host = toggle.closest(
                  "[data-clip-embed]",
                ) as HTMLElement | null;
                if (host) {
                  const cur = host.getAttribute("data-embed-mode") ?? "inline";
                  host.setAttribute(
                    "data-embed-mode",
                    cur === "block" ? "inline" : "block",
                  );
                  renderClipEmbed(host);
                  scheduleSave();
                }
              }
            }}
            onInput={() => {
              scheduleSave();
              updateFormat();
            }}
            onKeyUp={updateFormat}
            onMouseUp={updateFormat}
            onPaste={(e) => {
              const imageItem = Array.from(e.clipboardData.items).find((i) =>
                i.type.startsWith("image/"),
              );
              if (imageItem) {
                e.preventDefault();
                const file = imageItem.getAsFile();
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const src = ev.target?.result as string;
                    document.execCommand(
                      "insertHTML",
                      false,
                      `<img src="${src}" style="max-width:100%;border-radius:6px;display:block;margin:6px 0;" alt="Pasted image" />`,
                    );
                    scheduleSave();
                  };
                  reader.readAsDataURL(file);
                }
                return;
              }
              e.preventDefault();
              const html =
                e.clipboardData.getData("text/html") ||
                e.clipboardData.getData("text/plain");
              document.execCommand("insertHTML", false, html);
              scheduleSave();
            }}
          />
        </div>

        {/* Footer */}
        <div className="ns-editor-footer">
          <span className="ns-editor-footer-text">
            Updated {timeAgo(note.updated_at)}
          </span>
        </div>
      </div>
    </div>
  );
};

export default NoteEditor;
