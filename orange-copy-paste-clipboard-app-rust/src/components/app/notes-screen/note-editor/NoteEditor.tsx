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
  TextUnderlineIcon,
  TextStrikethroughIcon,
  TextHOneIcon,
  TextHTwoIcon,
  TextHThreeIcon,
  QuotesIcon,
  CodeBlockIcon,
  CheckSquareOffsetIcon,
  MinusIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  TextIndentIcon,
  TextOutdentIcon,
  TextAlignLeftIcon,
  TextAlignCenterIcon,
  TextAlignRightIcon,
  TextAlignJustifyIcon,
  LinkSimpleIcon,
  ClipboardTextIcon,
} from "@phosphor-icons/react";
import type { Note, ClipboardEntry } from "../../../../types";
import { groupColor, timeAgo, truncateText } from "../../../../types";
import {
  CloseIcon,
  TrashIcon,
  PinIcon,
  CheckIcon,
  ImageIcon,
  FileIcon,
  ClipboardIcon,
} from "../../../icons";
import {
  deriveNoteTitle,
  hasMeaningfulContent,
  stripHtml,
} from "../notes-utils";
import { parseNote } from "../prose-engine";
import type {
  Alignment,
  BlockType,
  EditorFormatState,
  NoteDoc,
} from "../prose-engine";
import BlockEditor, {
  type BlockEditorHandle,
} from "../prose-engine/BlockEditor";
import "./note-editor.css";

const EMPTY_FORMAT_STATE: EditorFormatState = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
};

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
  const editorRef = useRef<BlockEditorHandle>(null);
  const currentNoteIdRef = useRef(note.id);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [formatState, setFormatState] =
    useState<EditorFormatState>(EMPTY_FORMAT_STATE);
  const [blockType, setBlockType] = useState<BlockType>("p");
  const [alignment, setAlignState] = useState<Alignment | null>(null);

  const [showGroupDropdown, setShowGroupDropdown] = useState(false);
  const groupDropdownRef = useRef<HTMLDivElement>(null);

  const [showEmbedPicker, setShowEmbedPicker] = useState(false);
  const [embedSearch, setEmbedSearch] = useState("");
  const [embedTab, setEmbedTab] = useState<"entries" | "groups">("entries");
  const embedPickerRef = useRef<HTMLDivElement>(null);

  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkPickerRef = useRef<HTMLDivElement>(null);

  const initialDoc = useMemo(() => parseNote(note.content), [note.id]); // eslint-disable-line
  const initialTitle = useMemo(
    () => deriveNoteTitle(note.title, note.content),
    [note.id],
  ); // eslint-disable-line

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
    (doc: NoteDoc) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        save(JSON.stringify(doc));
      }, 400);
    },
    [save],
  );

  useEffect(() => {
    currentNoteIdRef.current = note.id;
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const doc = editorRef.current?.flush();
        if (doc) save(JSON.stringify(doc));
      }
    };
  }, [note.id, save]);

  useEffect(() => {
    if (!note.title && !note.content)
      setTimeout(() => titleRef.current?.focus(), 50);
  }, [note.id]);

  useEffect(() => {
    if (!titleRef.current || titleRef.current.value.trim()) return;
    const nextTitle = deriveNoteTitle(note.title, note.content);
    titleRef.current.value = nextTitle;
    onUpdate(note.id, nextTitle, note.content);
  }, [note.id, note.title, note.content, onUpdate]);

  // Track format/block type/alignment on selection change
  useEffect(() => {
    const update = () => {
      setFormatState(editorRef.current?.getFormatState() ?? EMPTY_FORMAT_STATE);
      if (editorRef.current) {
        setBlockType(editorRef.current.getBlockType());
        setAlignState(editorRef.current.getAlignment());
      }
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  // ── Close ─────────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const doc = editorRef.current?.flush();
    const content = doc ? JSON.stringify(doc) : note.content;
    if (!hasMeaningfulContent(content)) {
      onDelete(note.id);
      onBack();
      return;
    }
    save(content);
    onBack();
  }, [note.id, note.content, onDelete, onBack, save]);

  // ── Toolbar helpers ───────────────────────────────────────────────────

  const execFmt = (cmd: string, value?: string) => {
    editorRef.current?.execFmt(cmd, value);
    setTimeout(() => {
      setFormatState(editorRef.current?.getFormatState() ?? EMPTY_FORMAT_STATE);
    }, 0);
  };

  const changeBlockType = (type: BlockType) => {
    editorRef.current?.setBlockType(type);
    setBlockType(type);
  };

  const changeAlignment = (align: Alignment | null) => {
    editorRef.current?.setAlignment(align);
    setAlignState(align);
  };

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
      if (
        groupDropdownRef.current &&
        !groupDropdownRef.current.contains(e.target as Node)
      )
        setShowGroupDropdown(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showGroupDropdown]);

  useEffect(() => {
    if (!showEmbedPicker) return;
    const h = (e: MouseEvent) => {
      if (
        embedPickerRef.current &&
        !embedPickerRef.current.contains(e.target as Node)
      )
        setShowEmbedPicker(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showEmbedPicker]);

  useEffect(() => {
    if (!showLinkPicker) return;
    const h = (e: MouseEvent) => {
      if (
        linkPickerRef.current &&
        !linkPickerRef.current.contains(e.target as Node)
      ) {
        setShowLinkPicker(false);
        setLinkUrl("");
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showLinkPicker]);

  // ── Embed / link insert ───────────────────────────────────────────────

  const insertClipEmbed = useCallback((id: string) => {
    editorRef.current?.insertClipEmbed(id);
    setShowEmbedPicker(false);
  }, []);

  const insertGroupEmbed = useCallback((name: string) => {
    editorRef.current?.insertGroupEmbed(name);
    setShowEmbedPicker(false);
  }, []);

  const insertLink = useCallback((url: string) => {
    if (!url.trim()) return;
    editorRef.current?.insertLink(url.trim());
    setShowLinkPicker(false);
    setLinkUrl("");
  }, []);

  // ── Picker entry lists ────────────────────────────────────────────────

  const filteredEntries = useMemo(() => {
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

  const filteredGroups = useMemo(() => {
    const q = embedSearch.trim().toLowerCase();
    return q
      ? availableGroups.filter((g) => g.toLowerCase().includes(q))
      : availableGroups;
  }, [availableGroups, embedSearch]);

  // ── Render ────────────────────────────────────────────────────────────

  const isList = blockType === "ul" || blockType === "ol";

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
                const doc = editorRef.current?.flush();
                if (doc) save(JSON.stringify(doc));
              }, 400);
            }}
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
          {/* Inline marks */}
          <button
            className={`ns-fmt-btn${formatState.bold ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execFmt("bold")}
            data-tooltip="Bold (Ctrl+B)"
            data-tooltip-pos="below"
          >
            <TextBolderIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${formatState.italic ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execFmt("italic")}
            data-tooltip="Italic (Ctrl+I)"
            data-tooltip-pos="below"
          >
            <TextItalicIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${formatState.underline ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execFmt("underline")}
            data-tooltip="Underline (Ctrl+U)"
            data-tooltip-pos="below"
          >
            <TextUnderlineIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${formatState.strikethrough ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execFmt("strikeThrough")}
            data-tooltip="Strikethrough"
            data-tooltip-pos="below"
          >
            <TextStrikethroughIcon size={13} weight="bold" />
          </button>

          <span className="ns-fmt-sep" />

          {/* Block types */}
          <button
            className={`ns-fmt-btn${blockType === "h1" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeBlockType("h1")}
            data-tooltip="Heading 1"
            data-tooltip-pos="below"
          >
            <TextHOneIcon size={14} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${blockType === "h2" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeBlockType("h2")}
            data-tooltip="Heading 2"
            data-tooltip-pos="below"
          >
            <TextHTwoIcon size={14} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${blockType === "h3" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeBlockType("h3")}
            data-tooltip="Heading 3"
            data-tooltip-pos="below"
          >
            <TextHThreeIcon size={14} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${blockType === "bq" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeBlockType("bq")}
            data-tooltip="Quote"
            data-tooltip-pos="below"
          >
            <QuotesIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${blockType === "code" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeBlockType("code")}
            data-tooltip="Code block"
            data-tooltip-pos="below"
          >
            <CodeBlockIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${blockType === "todo" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeBlockType("todo")}
            data-tooltip="Checklist"
            data-tooltip-pos="below"
          >
            <CheckSquareOffsetIcon size={13} weight="bold" />
          </button>
          <button
            className="ns-fmt-btn"
            onClick={() => changeBlockType("hr")}
            data-tooltip="Horizontal rule"
            data-tooltip-pos="below"
          >
            <MinusIcon size={13} weight="bold" />
          </button>

          <span className="ns-fmt-sep" />

          {/* Lists */}
          <button
            className={`ns-fmt-btn${blockType === "ul" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeBlockType("ul")}
            data-tooltip="Bullet list"
            data-tooltip-pos="below"
          >
            <ListBulletsIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${blockType === "ol" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeBlockType("ol")}
            data-tooltip="Numbered list"
            data-tooltip-pos="below"
          >
            <ListNumbersIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${!isList ? " ns-fmt-btn--disabled" : ""}`}
            onClick={() => editorRef.current?.indent()}
            data-tooltip="Indent"
            data-tooltip-pos="below"
            disabled={!isList}
          >
            <TextIndentIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${!isList ? " ns-fmt-btn--disabled" : ""}`}
            onClick={() => editorRef.current?.outdent()}
            data-tooltip="Outdent"
            data-tooltip-pos="below"
            disabled={!isList}
          >
            <TextOutdentIcon size={13} weight="bold" />
          </button>

          <span className="ns-fmt-sep" />

          {/* Alignment */}
          <button
            className={`ns-fmt-btn${alignment === "left" || alignment === null ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeAlignment(null)}
            data-tooltip="Align left"
            data-tooltip-pos="below"
          >
            <TextAlignLeftIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${alignment === "center" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeAlignment("center")}
            data-tooltip="Align center"
            data-tooltip-pos="below"
          >
            <TextAlignCenterIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${alignment === "right" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeAlignment("right")}
            data-tooltip="Align right"
            data-tooltip-pos="below"
          >
            <TextAlignRightIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${alignment === "justify" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => changeAlignment("justify")}
            data-tooltip="Justify"
            data-tooltip-pos="below"
          >
            <TextAlignJustifyIcon size={13} weight="bold" />
          </button>

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
                editorRef.current?.saveRange();
                setShowEmbedPicker((p) => !p);
                setShowLinkPicker(false);
                setEmbedSearch("");
              }}
              data-tooltip="Embed clipboard entry"
              data-tooltip-pos="below"
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
                    filteredEntries.length === 0 ? (
                      <div className="ns-embed-empty">No entries found</div>
                    ) : (
                      filteredEntries.map((entry) => {
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

        {/* Editor content area */}
        <div className="ns-editor-content">
          <BlockEditor
            ref={editorRef}
            noteId={note.id}
            initialDoc={initialDoc}
            entries={entries}
            onChange={handleEditorChange}
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
