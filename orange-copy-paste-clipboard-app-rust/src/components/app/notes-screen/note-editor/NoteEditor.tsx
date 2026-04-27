// ── Note Editor — Markdown dual-mode (source / preview) ───────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  TextBolderIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  CodeIcon,
  TextHOneIcon,
  TextHTwoIcon,
  TextHThreeIcon,
  QuotesIcon,
  CodeBlockIcon,
  CheckSquareOffsetIcon,
  MinusIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  TableIcon,
  LinkSimpleIcon,
  ClipboardTextIcon,
  PencilSimpleIcon,
  EyeIcon,
} from "@phosphor-icons/react";
import type { Note, ClipboardEntry } from "../../../../types";
import { groupColor, timeAgo, truncateText } from "../../../../types";
import {
  CloseIcon,
  TrashIcon,
  PinIcon,
  CheckIcon,
  PlusIcon,
  ImageIcon,
  FileIcon,
  ClipboardIcon,
} from "../../../icons";
import {
  deriveNoteTitle,
  hasMeaningfulContent,
  stripHtml,
} from "../notes-utils";
import {
  MarkdownEditor,
  parseNoteContent,
  type MarkdownEditorHandle,
  type EditorMode,
  type FormatAction,
  type BlockKind,
} from "../editor-engine";
import "./note-editor.css";

// ── NoteEditor ────────────────────────────────────────────────────────────

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
  onBack,
}) => {
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mode, setMode] = useState<EditorMode>("source");
  const [blockKind, setBlockKind] = useState<BlockKind>("p");

  const [showGroupDropdown, setShowGroupDropdown] = useState(false);
  const groupDropdownRef = useRef<HTMLDivElement>(null);

  const [showEmbedPicker, setShowEmbedPicker] = useState(false);
  const [embedSearch, setEmbedSearch] = useState("");
  const [embedTab, setEmbedTab] = useState<"entries" | "groups">("entries");
  const embedPickerRef = useRef<HTMLDivElement>(null);

  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkPickerRef = useRef<HTMLDivElement>(null);

  const initialMarkdown = useMemo(() => parseNoteContent(note.content), [note.id]); // eslint-disable-line
  const initialTitle = useMemo(
    () => deriveNoteTitle(note.title, note.content),
    [note.id], // eslint-disable-line
  );

  // ── Save ──────────────────────────────────────────────────────────────

  const save = useCallback(
    (content: string) => {
      const title = deriveNoteTitle(titleRef.current?.value ?? "", content);
      if (titleRef.current && titleRef.current.value !== title)
        titleRef.current.value = title;
      onUpdate(note.id, title, content);
    },
    [note.id, onUpdate],
  );

  const handleEditorChange = useCallback(
    (markdown: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => save(markdown), 400);
    },
    [save],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const md = editorRef.current?.getMarkdown();
        if (md != null) save(md);
      }
    };
  }, [note.id, save]);

  useEffect(() => {
    if (!note.title && !note.content)
      setTimeout(() => titleRef.current?.focus(), 50);
  }, [note.id]); // eslint-disable-line

  // Track block kind under caret for toolbar active state.
  const refreshBlockKind = useCallback(() => {
    if (mode === "source") setBlockKind(editorRef.current?.getBlockKind() ?? "p");
  }, [mode]);

  useEffect(() => {
    if (mode !== "source") return;
    const handler = () => refreshBlockKind();
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [mode, refreshBlockKind]);

  // ── Close ─────────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const md = editorRef.current?.getMarkdown() ?? note.content;
    if (!hasMeaningfulContent(md)) {
      onDelete(note.id);
      onBack();
      return;
    }
    save(md);
    onBack();
  }, [note.id, note.content, onDelete, onBack, save]);

  // ── Toolbar actions ───────────────────────────────────────────────────

  const apply = useCallback((action: FormatAction) => {
    if (mode !== "source") setMode("source");
    requestAnimationFrame(() => editorRef.current?.applyFormat(action));
  }, [mode]);

  const inline = (before: string, after = before, placeholder = "") =>
    apply({ kind: "wrap", before, after, placeholder });

  const setHeading = (n: 1 | 2 | 3) => {
    const prefix = "#".repeat(n) + " ";
    apply({
      kind: "linePrefix",
      prefix,
      togglePrefixes: ["# ", "## ", "### ", "> ", "- [ ] ", "- [x] ", "- ", "* ", "+ "],
    });
  };

  const toggleQuote = () => apply({
    kind: "linePrefix",
    prefix: "> ",
    togglePrefixes: ["> ", "# ", "## ", "### "],
  });

  const toggleBullet = () => apply({
    kind: "linePrefix",
    prefix: "- ",
    togglePrefixes: ["- ", "* ", "+ ", "- [ ] ", "- [x] "],
  });

  const toggleNumbered = () => apply({
    kind: "linePrefix",
    prefix: "1. ",
    togglePrefixes: ["- ", "* ", "+ ", "- [ ] ", "- [x] "],
  });

  const toggleTodo = () => apply({
    kind: "linePrefix",
    prefix: "- [ ] ",
    togglePrefixes: ["- [ ] ", "- [x] ", "- ", "* ", "+ "],
  });

  const insertCodeBlock = () => apply({ kind: "fence" });
  const insertHr = () => apply({ kind: "insert", text: "\n\n---\n\n" });
  const insertTable = () => apply({
    kind: "insert",
    text: "\n\n| Column 1 | Column 2 |\n| --- | --- |\n| value | value |\n\n",
  });

  // ── Group toggle ──────────────────────────────────────────────────────

  const toggleGroup = useCallback(
    (group: string) => {
      const next = note.groups.includes(group)
        ? note.groups.filter((g) => g !== group)
        : [...note.groups, group];
      onSetGroups(note.id, next);
    },
    [note.id, note.groups, onSetGroups],
  );

  // ── Dropdown close handlers ───────────────────────────────────────────

  useEffect(() => {
    if (!showGroupDropdown) return;
    const h = (e: MouseEvent) => {
      if (groupDropdownRef.current && !groupDropdownRef.current.contains(e.target as Node))
        setShowGroupDropdown(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showGroupDropdown]);

  useEffect(() => {
    if (!showEmbedPicker) return;
    const h = (e: MouseEvent) => {
      if (embedPickerRef.current && !embedPickerRef.current.contains(e.target as Node))
        setShowEmbedPicker(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showEmbedPicker]);

  useEffect(() => {
    if (!showLinkPicker) return;
    const h = (e: MouseEvent) => {
      if (linkPickerRef.current && !linkPickerRef.current.contains(e.target as Node)) {
        setShowLinkPicker(false);
        setLinkUrl("");
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showLinkPicker]);

  // ── Embed / link insert ───────────────────────────────────────────────

  const insertClipEmbed = useCallback((id: string) => {
    if (mode !== "source") setMode("source");
    requestAnimationFrame(() => editorRef.current?.insertClipEmbed(id));
    setShowEmbedPicker(false);
  }, [mode]);

  const insertGroupEmbed = useCallback((name: string) => {
    if (mode !== "source") setMode("source");
    requestAnimationFrame(() => editorRef.current?.insertGroupEmbed(name));
    setShowEmbedPicker(false);
  }, [mode]);

  const insertLink = useCallback((url: string) => {
    if (!url.trim()) return;
    if (mode !== "source") setMode("source");
    requestAnimationFrame(() => editorRef.current?.insertLink(url.trim()));
    setShowLinkPicker(false);
    setLinkUrl("");
  }, [mode]);

  // ── Picker entry lists ────────────────────────────────────────────────

  const filteredEntries = useMemo(() => {
    const q = embedSearch.trim().toLowerCase();
    const list = q
      ? entries.filter((e) => {
          const text = e.type === "html" ? stripHtml(e.content) : e.content;
          return text.toLowerCase().includes(q) || (e.label ?? "").toLowerCase().includes(q);
        })
      : entries;
    return list.slice(0, 50);
  }, [entries, embedSearch]);

  const filteredGroups = useMemo(() => {
    const q = embedSearch.trim().toLowerCase();
    return q ? availableGroups.filter((g) => g.toLowerCase().includes(q)) : availableGroups;
  }, [availableGroups, embedSearch]);

  // ── Render ────────────────────────────────────────────────────────────

  const isPreview = mode === "preview";
  const fmtDisabled = isPreview;

  return (
    <div className="ns-editor-shell">
      <div className="ns-editor">
        {/* Header */}
        <div className="ns-editor-header">
          <button
            className="ns-back-btn"
            onClick={handleClose}
            data-tooltip="Close"
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
            onChange={() => {
              if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
              saveTimerRef.current = setTimeout(() => {
                const md = editorRef.current?.getMarkdown();
                if (md != null) save(md);
              }, 400);
            }}
          />
          <div className="ns-editor-actions">
            <button
              className={`ns-tb-btn${isPreview ? " ns-tb-btn--active" : ""}`}
              onClick={() => setMode(isPreview ? "source" : "preview")}
              data-tooltip={isPreview ? "Edit markdown" : "Preview"}
              data-tooltip-pos="below"
            >
              {isPreview ? <PencilSimpleIcon size={12} weight="bold" /> : <EyeIcon size={12} weight="bold" />}
            </button>
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
              onClick={() => { onDelete(note.id); onBack(); }}
              data-tooltip="Delete"
              data-tooltip-pos="below"
            >
              <TrashIcon size={11} />
            </button>
          </div>
        </div>

        {/* Groups */}
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
              <PlusIcon size={11} strokeWidth={2.8} />
            </button>
            {showGroupDropdown && (
              <div className="ns-group-dropdown">
                {availableGroups.length === 0 ? (
                  <div className="ns-group-dropdown-item" style={{ color: "var(--text-muted)", cursor: "default" }}>
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
                        <span className="ns-group-dropdown-dot" style={{ background: c.fg }} />
                        {g}
                        {isIn && <CheckIcon size={11} className="ns-group-dropdown-check" />}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {/* Formatting toolbar */}
        <div className={`ns-format-bar${fmtDisabled ? " ns-format-bar--disabled" : ""}`}>
          {/* Inline marks */}
          <button className="ns-fmt-btn" onClick={() => inline("**", "**", "bold")}    data-tooltip="Bold (Ctrl+B)" data-tooltip-pos="below" disabled={fmtDisabled}><TextBolderIcon size={13} weight="bold" /></button>
          <button className="ns-fmt-btn" onClick={() => inline("*",  "*",  "italic")}  data-tooltip="Italic (Ctrl+I)" data-tooltip-pos="below" disabled={fmtDisabled}><TextItalicIcon size={13} weight="bold" /></button>
          <button className="ns-fmt-btn" onClick={() => inline("~~", "~~", "strike")}  data-tooltip="Strikethrough" data-tooltip-pos="below" disabled={fmtDisabled}><TextStrikethroughIcon size={13} weight="bold" /></button>
          <button className="ns-fmt-btn" onClick={() => inline("`",  "`",  "code")}    data-tooltip="Inline code (Ctrl+E)" data-tooltip-pos="below" disabled={fmtDisabled}><CodeIcon size={13} weight="bold" /></button>

          <span className="ns-fmt-sep" />

          {/* Block types */}
          <button className={`ns-fmt-btn${blockKind === "h1" ? " ns-fmt-btn--active" : ""}`} onClick={() => setHeading(1)} data-tooltip="Heading 1" data-tooltip-pos="below" disabled={fmtDisabled}><TextHOneIcon size={14} weight="bold" /></button>
          <button className={`ns-fmt-btn${blockKind === "h2" ? " ns-fmt-btn--active" : ""}`} onClick={() => setHeading(2)} data-tooltip="Heading 2" data-tooltip-pos="below" disabled={fmtDisabled}><TextHTwoIcon size={14} weight="bold" /></button>
          <button className={`ns-fmt-btn${blockKind === "h3" ? " ns-fmt-btn--active" : ""}`} onClick={() => setHeading(3)} data-tooltip="Heading 3" data-tooltip-pos="below" disabled={fmtDisabled}><TextHThreeIcon size={14} weight="bold" /></button>
          <button className={`ns-fmt-btn${blockKind === "bq" ? " ns-fmt-btn--active" : ""}`} onClick={toggleQuote} data-tooltip="Quote" data-tooltip-pos="below" disabled={fmtDisabled}><QuotesIcon size={13} weight="bold" /></button>
          <button className={`ns-fmt-btn${blockKind === "code" ? " ns-fmt-btn--active" : ""}`} onClick={insertCodeBlock} data-tooltip="Code block" data-tooltip-pos="below" disabled={fmtDisabled}><CodeBlockIcon size={13} weight="bold" /></button>
          <button className={`ns-fmt-btn${blockKind === "todo" || blockKind === "todoChecked" ? " ns-fmt-btn--active" : ""}`} onClick={toggleTodo} data-tooltip="Checklist" data-tooltip-pos="below" disabled={fmtDisabled}><CheckSquareOffsetIcon size={13} weight="bold" /></button>
          <button className="ns-fmt-btn" onClick={insertHr} data-tooltip="Horizontal rule" data-tooltip-pos="below" disabled={fmtDisabled}><MinusIcon size={13} weight="bold" /></button>

          <span className="ns-fmt-sep" />

          {/* Lists & table */}
          <button className={`ns-fmt-btn${blockKind === "ul" ? " ns-fmt-btn--active" : ""}`} onClick={toggleBullet}   data-tooltip="Bullet list"   data-tooltip-pos="below" disabled={fmtDisabled}><ListBulletsIcon size={13} weight="bold" /></button>
          <button className={`ns-fmt-btn${blockKind === "ol" ? " ns-fmt-btn--active" : ""}`} onClick={toggleNumbered} data-tooltip="Numbered list" data-tooltip-pos="below" disabled={fmtDisabled}><ListNumbersIcon size={13} weight="bold" /></button>
          <button className="ns-fmt-btn" onClick={insertTable} data-tooltip="Insert table" data-tooltip-pos="below" disabled={fmtDisabled}><TableIcon size={13} weight="bold" /></button>

          <span className="ns-fmt-sep" />

          {/* Link picker */}
          <div className="ns-embed-wrap" ref={linkPickerRef}>
            <button
              className={`ns-fmt-btn${showLinkPicker ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                editorRef.current?.saveRange();
                setShowLinkPicker((p) => !p);
                setShowEmbedPicker(false);
              }}
              data-tooltip="Insert link"
              data-tooltip-pos="below"
              disabled={fmtDisabled}
            >
              <LinkSimpleIcon size={12} weight="bold" />
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
                      if (e.key === "Escape") { setShowLinkPicker(false); setLinkUrl(""); }
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
                editorRef.current?.saveRange();
                setShowEmbedPicker((p) => !p);
                setShowLinkPicker(false);
                setEmbedSearch("");
              }}
              data-tooltip="Embed clipboard entry"
              data-tooltip-pos="below"
              disabled={fmtDisabled}
            >
              <ClipboardTextIcon size={13} weight="bold" />
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
                  placeholder={embedTab === "entries" ? "Search entries…" : "Search groups…"}
                  value={embedSearch}
                  onChange={(e) => setEmbedSearch(e.target.value)}
                  autoFocus
                />
                <div className="ns-embed-list">
                  {embedTab === "entries" ? (
                    filteredEntries.length === 0 ? (
                      <div className="ns-embed-empty">No entries found</div>
                    ) : (
                      filteredEntries.map((entry) => {
                        const text =
                          entry.type === "image"
                            ? (entry.label ?? "Image")
                            : truncateText(
                                entry.type === "html" ? stripHtml(entry.content) : entry.content,
                                72,
                              );
                        return (
                          <button
                            key={entry.id}
                            className="ns-embed-item"
                            onClick={() => insertClipEmbed(entry.id)}
                          >
                            <span className="ns-embed-item-icon">
                              {entry.type === "image" ? <ImageIcon size={10} /> :
                               entry.type === "file"  ? <FileIcon  size={10} /> :
                                                        <ClipboardIcon size={10} />}
                            </span>
                            <span className="ns-embed-item-text">{text}</span>
                            <span className="ns-embed-item-time">{timeAgo(entry.timestamp)}</span>
                          </button>
                        );
                      })
                    )
                  ) : filteredGroups.length === 0 ? (
                    <div className="ns-embed-empty">No groups found</div>
                  ) : (
                    filteredGroups.map((group) => {
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
                            <span className="ns-embed-group-dot" style={{ background: c.fg }} />
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

        {/* Editor content area */}
        <div className="ns-editor-content">
          <MarkdownEditor
            ref={editorRef}
            noteId={note.id}
            initialMarkdown={initialMarkdown}
            entries={entries}
            mode={mode}
            onChange={handleEditorChange}
            onSelectionChange={refreshBlockKind}
          />
        </div>

        {/* Footer */}
        <div className="ns-editor-footer">
          <span className="ns-editor-footer-text">
            {isPreview ? "Preview · " : "Markdown · "}
            Updated {timeAgo(note.updated_at)}
          </span>
        </div>
      </div>
    </div>
  );
};

export default NoteEditor;
