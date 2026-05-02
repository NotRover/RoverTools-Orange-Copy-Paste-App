// ── Note Editor — Notion-like Tiptap surface, JSON content storage ───────

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
  TextHFourIcon,
  TextHFiveIcon,
  QuotesIcon,
  CodeBlockIcon,
  CheckSquareOffsetIcon,
  MinusIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  TableIcon,
  LinkSimpleIcon,
  ClipboardTextIcon,
  CaretDownIcon,
  TextUnderlineIcon,
  CaretRightIcon,
  LightbulbIcon,
  TextAlignLeftIcon,
  TextAlignCenterIcon,
  TextAlignRightIcon,
  TextAlignJustifyIcon,
  PaletteIcon,
  HighlighterIcon,
  DownloadSimpleIcon,
  CopyIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import type { Note, ClipboardEntry } from "../../../../types";
import { groupColor, timeAgo, truncateText } from "../../../../types";
import {
  CloseIcon,
  TrashIcon,
  PinIcon,
  SaveStarIcon,
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
  NotionEditor,
  type NotionEditorHandle,
  type EditorCommand,
  type ActiveState,
  type CalloutTone,
  type EditorStats,
  imageAttachmentUrl,
  fileAttachmentUrl,
  noteToMarkdown,
} from "../editor-engine";
import "./note-editor.css";

const EMPTY_ACTIVE: ActiveState = { blockKind: "p" };

const TEXT_COLORS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Red", value: "#e5484d" },
  { label: "Orange", value: "#f76808" },
  { label: "Amber", value: "#ffba18" },
  { label: "Green", value: "#46a758" },
  { label: "Teal", value: "#12a594" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Purple", value: "#8e4ec6" },
  { label: "Pink", value: "#e93d82" },
  { label: "Gray", value: "#8d8d8d" },
];

const HIGHLIGHT_COLORS: { label: string; value: string | null }[] = [
  { label: "None", value: null },
  { label: "Yellow", value: "#fff3a8" },
  { label: "Lime", value: "#d6f5b8" },
  { label: "Mint", value: "#bdf0d6" },
  { label: "Sky", value: "#bee3f8" },
  { label: "Lavender", value: "#dcd2ff" },
  { label: "Pink", value: "#ffd2e6" },
  { label: "Peach", value: "#ffd9b4" },
  { label: "Gray", value: "#e2e2e2" },
];

type HeadingLevel = 1 | 2 | 3 | 4 | 5;

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
  const editorRef = useRef<NotionEditorHandle>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [active, setActive] = useState<ActiveState>(EMPTY_ACTIVE);
  const [stats, setStats] = useState<EditorStats>({
    blocks: 1,
    line: 1,
    chars: 0,
    words: 0,
  });
  const [showCalloutPicker, setShowCalloutPicker] = useState(false);
  const calloutPickerRef = useRef<HTMLDivElement>(null);

  const [showGroupDropdown, setShowGroupDropdown] = useState(false);
  const groupDropdownRef = useRef<HTMLDivElement>(null);

  const [showHeadingDropdown, setShowHeadingDropdown] = useState(false);
  const headingDropdownRef = useRef<HTMLDivElement>(null);
  const [preferredHeadingLevel, setPreferredHeadingLevel] =
    useState<HeadingLevel>(1);

  const [showStructureDropdown, setShowStructureDropdown] = useState(false);
  const structureDropdownRef = useRef<HTMLDivElement>(null);

  const [showAlignDropdown, setShowAlignDropdown] = useState(false);
  const alignDropdownRef = useRef<HTMLDivElement>(null);

  const [showEmbedPicker, setShowEmbedPicker] = useState(false);
  const [embedSearch, setEmbedSearch] = useState("");
  const [embedTab, setEmbedTab] = useState<"entries" | "groups">("entries");
  const embedPickerRef = useRef<HTMLDivElement>(null);

  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");
  const linkPickerRef = useRef<HTMLDivElement>(null);

  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [exportToast, setExportToast] = useState<string | null>(null);

  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const [showHighlightPicker, setShowHighlightPicker] = useState(false);
  const highlightPickerRef = useRef<HTMLDivElement>(null);

  const initialContent = useMemo(() => note.content ?? "", [note.id]); // eslint-disable-line
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
    (content: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => save(content), 400);
    },
    [save],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const c = editorRef.current?.getContent();
        if (c != null) save(c);
      }
    };
  }, [note.id, save]);

  useEffect(() => {
    if (!note.title && !note.content)
      setTimeout(() => titleRef.current?.focus(), 50);
  }, [note.id]); // eslint-disable-line

  // Toolbar active state.
  const refreshActive = useCallback(() => {
    setActive(editorRef.current?.getActiveState() ?? EMPTY_ACTIVE);
  }, []);

  useEffect(() => {
    const handler = () => refreshActive();
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [refreshActive]);

  // ── Ctrl+S — flush debounced save immediately ─────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        const c = editorRef.current?.getContent();
        if (c != null) save(c);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [save]);

  // ── Close ─────────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const c = editorRef.current?.getContent() ?? note.content;
    if (!hasMeaningfulContent(c)) {
      onDelete(note.id);
      onBack();
      return;
    }
    save(c);
    onBack();
  }, [note.id, note.content, onDelete, onBack, save]);

  // ── Toolbar dispatch ──────────────────────────────────────────────────

  const dispatch = useCallback(
    (cmd: EditorCommand) => {
      editorRef.current?.applyCommand(cmd);
      setTimeout(refreshActive, 0);
    },
    [refreshActive],
  );

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
    if (!showHeadingDropdown) return;
    const h = (e: MouseEvent) => {
      if (
        headingDropdownRef.current &&
        !headingDropdownRef.current.contains(e.target as Node)
      )
        setShowHeadingDropdown(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showHeadingDropdown]);

  useEffect(() => {
    if (!showStructureDropdown) return;
    const h = (e: MouseEvent) => {
      if (
        structureDropdownRef.current &&
        !structureDropdownRef.current.contains(e.target as Node)
      )
        setShowStructureDropdown(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showStructureDropdown]);

  useEffect(() => {
    if (!showAlignDropdown) return;
    const h = (e: MouseEvent) => {
      if (
        alignDropdownRef.current &&
        !alignDropdownRef.current.contains(e.target as Node)
      )
        setShowAlignDropdown(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showAlignDropdown]);

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
    if (!showColorPicker) return;
    const h = (e: MouseEvent) => {
      if (
        colorPickerRef.current &&
        !colorPickerRef.current.contains(e.target as Node)
      )
        setShowColorPicker(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showColorPicker]);

  useEffect(() => {
    if (!showHighlightPicker) return;
    const h = (e: MouseEvent) => {
      if (
        highlightPickerRef.current &&
        !highlightPickerRef.current.contains(e.target as Node)
      )
        setShowHighlightPicker(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showHighlightPicker]);

  useEffect(() => {
    if (!showCalloutPicker) return;
    const h = (e: MouseEvent) => {
      if (
        calloutPickerRef.current &&
        !calloutPickerRef.current.contains(e.target as Node)
      )
        setShowCalloutPicker(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showCalloutPicker]);

  useEffect(() => {
    if (!showLinkPicker) return;
    const h = (e: MouseEvent) => {
      if (
        linkPickerRef.current &&
        !linkPickerRef.current.contains(e.target as Node)
      ) {
        setShowLinkPicker(false);
        setLinkUrl("");
        setLinkText("");
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showLinkPicker]);

  useEffect(() => {
    if (!showExportMenu) return;
    const h = (e: MouseEvent) => {
      if (
        exportMenuRef.current &&
        !exportMenuRef.current.contains(e.target as Node)
      )
        setShowExportMenu(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showExportMenu]);

  const showToast = useCallback((msg: string) => {
    setExportToast(msg);
    setTimeout(() => setExportToast(null), 2800);
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    setShowExportMenu(false);
    const content = editorRef.current?.getContent() ?? note.content;
    const markdown = noteToMarkdown(content);
    const title = deriveNoteTitle(titleRef.current?.value ?? "", content);
    const safeTitle =
      title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_") || "note";
    try {
      const savedPath = await invoke<string>("export_note_text", {
        text: markdown,
        filename: `${safeTitle}.md`,
      });
      const name = savedPath.replace(/\\/g, "/").split("/").pop() ?? "note.md";
      showToast(`Saved: ${name}`);
    } catch (err) {
      console.error("[notes] export failed", err);
      showToast("Export failed");
    }
  }, [note.id, note.content, showToast]);

  const handleCopyMarkdown = useCallback(async () => {
    setShowExportMenu(false);
    const content = editorRef.current?.getContent() ?? note.content;
    const markdown = noteToMarkdown(content);
    try {
      await navigator.clipboard.writeText(markdown);
      showToast("Copied as Markdown");
    } catch {
      showToast("Copy failed");
    }
  }, [note.id, note.content, showToast]);

  // ── Embed / link insert ───────────────────────────────────────────────

  const insertClipEmbed = useCallback((id: string) => {
    editorRef.current?.insertClipEmbed(id);
    setShowEmbedPicker(false);
  }, []);

  const insertGroupEmbed = useCallback((name: string) => {
    editorRef.current?.insertGroupEmbed(name);
    setShowEmbedPicker(false);
  }, []);

  const insertLink = useCallback((url: string, text?: string) => {
    if (!url.trim()) return;
    editorRef.current?.insertLink(url.trim(), text?.trim() || undefined);
    setShowLinkPicker(false);
    setLinkUrl("");
    setLinkText("");
  }, []);

  // ── Attachment uploads ──────────────────────────────────────────────────
  // Hidden <input type="file"> elements; one for images, one for any document.
  // Files are persisted under app_data/note-attachments/{images,files}/ via the
  // backend, then referenced as tauri-asset URLs so the markdown stays small
  // and round-trips cleanly between rich and markdown modes.

  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImagePick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        const ext = (
          file.name.includes(".")
            ? (file.name.split(".").pop() ?? "png")
            : (file.type.split("/")[1] ?? "png")
        ).toLowerCase();
        const filename = await invoke<string>("save_note_image", {
          bytes,
          ext,
        });
        editorRef.current?.applyCommand({
          kind: "image",
          src: imageAttachmentUrl(filename),
          alt: file.name,
        });
      } catch (err) {
        console.error("[notes] image upload failed", err);
      }
    },
    [],
  );

  const handleDocumentPick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        const filename = await invoke<string>("save_note_file", {
          bytes,
          name: file.name,
        });
        editorRef.current?.insertLink(fileAttachmentUrl(filename), file.name);
      } catch (err) {
        console.error("[notes] document upload failed", err);
      }
    },
    [],
  );

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

  const bk = active.blockKind;
  const structureActive = bk === "ul" || bk === "ol";
  const alignValue = active.align ?? "left";

  const applyHeadingLevel = useCallback(
    (level: HeadingLevel) => {
      setPreferredHeadingLevel(level);
      dispatch({ kind: "heading", level });
      setShowHeadingDropdown(false);
    },
    [dispatch],
  );

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
                const c = editorRef.current?.getContent();
                if (c != null) save(c);
              }, 400);
            }}
          />
          <div className="ns-editor-actions">
            {/* Export */}
            <div className="ns-export-wrap" ref={exportMenuRef}>
              <button
                className={`ns-tb-btn${showExportMenu ? " ns-tb-btn--active" : ""}`}
                onClick={() => setShowExportMenu((p) => !p)}
                data-tooltip="Export note"
                data-tooltip-pos="below"
              >
                <DownloadSimpleIcon size={12} weight="bold" />
              </button>
              {showExportMenu && (
                <div className="ns-export-menu">
                  <button
                    className="ns-export-item"
                    onClick={handleExportMarkdown}
                  >
                    <DownloadSimpleIcon size={12} weight="bold" />
                    Save as .md
                  </button>
                  <div className="ns-export-sep" />
                  <button
                    className="ns-export-item"
                    onClick={handleCopyMarkdown}
                  >
                    <CopyIcon size={12} weight="bold" />
                    Copy as Markdown
                  </button>
                </div>
              )}
              {exportToast && (
                <div className="ns-export-toast">{exportToast}</div>
              )}
            </div>

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
              <PlusIcon size={11} strokeWidth={2.8} />
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
          <div className="ns-fmt-group">
          <button
            className={`ns-fmt-btn${active.bold ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "bold" })}
            data-tooltip="Bold (Ctrl+B)"
            data-tooltip-pos="below"
          >
            <TextBolderIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${active.italic ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "italic" })}
            data-tooltip="Italic (Ctrl+I)"
            data-tooltip-pos="below"
          >
            <TextItalicIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${active.underline ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "underline" })}
            data-tooltip="Underline (Ctrl+U)"
            data-tooltip-pos="below"
          >
            <TextUnderlineIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${active.strike ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "strike" })}
            data-tooltip="Strikethrough"
            data-tooltip-pos="below"
          >
            <TextStrikethroughIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${active.code ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "code" })}
            data-tooltip="Inline code (Ctrl+E)"
            data-tooltip-pos="below"
          >
            <CodeIcon size={13} weight="bold" />
          </button>
          </div>

          {/* Color & highlight */}
          <div className="ns-fmt-group">
          <div className="ns-toolbar-wrap" ref={colorPickerRef}>
            <button
              className={`ns-fmt-btn${active.textColor ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                setShowColorPicker((p) => !p);
                setShowHighlightPicker(false);
                setShowHeadingDropdown(false);
                setShowStructureDropdown(false);
                setShowAlignDropdown(false);
              }}
              data-tooltip="Text color"
              data-tooltip-pos="below"
              style={active.textColor ? { color: active.textColor } : undefined}
            >
              <PaletteIcon size={13} weight="bold" />
            </button>
            {showColorPicker && (
              <div className="ns-embed-picker ns-color-picker">
                <div className="ns-color-grid">
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c.value ?? "none"}
                      className="ns-color-swatch"
                      style={{
                        background: c.value ?? "transparent",
                        border: c.value
                          ? "1px solid var(--border)"
                          : "1px dashed var(--border)",
                      }}
                      title={c.label}
                      onClick={() => {
                        dispatch({ kind: "textColor", value: c.value });
                        setShowColorPicker(false);
                      }}
                    >
                      {c.value == null && (
                        <span className="ns-color-swatch-none">×</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Highlight color */}
          <div className="ns-toolbar-wrap" ref={highlightPickerRef}>
            <button
              className={`ns-fmt-btn${active.highlight ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                setShowHighlightPicker((p) => !p);
                setShowColorPicker(false);
                setShowHeadingDropdown(false);
                setShowStructureDropdown(false);
                setShowAlignDropdown(false);
              }}
              data-tooltip="Highlight"
              data-tooltip-pos="below"
              style={
                active.highlight ? { background: active.highlight } : undefined
              }
            >
              <HighlighterIcon size={13} weight="bold" />
            </button>
            {showHighlightPicker && (
              <div className="ns-embed-picker ns-color-picker">
                <div className="ns-color-grid">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c.value ?? "none"}
                      className="ns-color-swatch"
                      style={{
                        background: c.value ?? "transparent",
                        border: c.value
                          ? "1px solid var(--border)"
                          : "1px dashed var(--border)",
                      }}
                      title={c.label}
                      onClick={() => {
                        dispatch({ kind: "highlight", value: c.value });
                        setShowHighlightPicker(false);
                      }}
                    >
                      {c.value == null && (
                        <span className="ns-color-swatch-none">×</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          </div>

          {/* Block types */}
          <div className="ns-fmt-group">
          <div className="ns-heading-wrap" ref={headingDropdownRef}>
            <button
              className={`ns-fmt-btn ns-fmt-btn--dropdown${bk === "h1" || bk === "h2" || bk === "h3" || bk === "h4" || bk === "h5" ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                setShowHeadingDropdown((p) => !p);
                setShowStructureDropdown(false);
                setShowAlignDropdown(false);
                setShowEmbedPicker(false);
                setShowLinkPicker(false);
                setShowColorPicker(false);
                setShowHighlightPicker(false);
              }}
              data-tooltip="Heading size"
              data-tooltip-pos="below"
            >
              {preferredHeadingLevel === 2 ? (
                <TextHTwoIcon size={14} weight="bold" />
              ) : preferredHeadingLevel === 3 ? (
                <TextHThreeIcon size={14} weight="bold" />
              ) : preferredHeadingLevel === 4 ? (
                <TextHFourIcon size={14} weight="bold" />
              ) : preferredHeadingLevel === 5 ? (
                <TextHFiveIcon size={14} weight="bold" />
              ) : (
                <TextHOneIcon size={14} weight="bold" />
              )}
              <CaretDownIcon
                size={11}
                weight="bold"
                className={`ns-fmt-btn-caret${showHeadingDropdown ? " ns-fmt-btn-caret--open" : ""}`}
              />
            </button>
            {showHeadingDropdown && (
              <div className="ns-heading-dropdown">
                <button
                  className={`ns-heading-dropdown-item${preferredHeadingLevel === 1 ? " ns-heading-dropdown-item--active" : ""}`}
                  onClick={() => applyHeadingLevel(1)}
                >
                  <TextHOneIcon size={15} weight="bold" />
                  <span className="ns-heading-size-text ns-heading-size-text--h1">
                    Heading 1
                  </span>
                </button>
                <button
                  className={`ns-heading-dropdown-item${preferredHeadingLevel === 2 ? " ns-heading-dropdown-item--active" : ""}`}
                  onClick={() => applyHeadingLevel(2)}
                >
                  <TextHTwoIcon size={13} weight="bold" />
                  <span className="ns-heading-size-text ns-heading-size-text--h2">
                    Heading 2
                  </span>
                </button>
                <button
                  className={`ns-heading-dropdown-item${preferredHeadingLevel === 3 ? " ns-heading-dropdown-item--active" : ""}`}
                  onClick={() => applyHeadingLevel(3)}
                >
                  <TextHThreeIcon size={13} weight="bold" />
                  <span className="ns-heading-size-text ns-heading-size-text--h3">
                    Heading 3
                  </span>
                </button>
                <button
                  className={`ns-heading-dropdown-item${preferredHeadingLevel === 4 ? " ns-heading-dropdown-item--active" : ""}`}
                  onClick={() => applyHeadingLevel(4)}
                >
                  <TextHFourIcon size={12} weight="bold" />
                  <span className="ns-heading-size-text ns-heading-size-text--h4">
                    Heading 4
                  </span>
                </button>
                <button
                  className={`ns-heading-dropdown-item${preferredHeadingLevel === 5 ? " ns-heading-dropdown-item--active" : ""}`}
                  onClick={() => applyHeadingLevel(5)}
                >
                  <TextHFiveIcon size={11} weight="bold" />
                  <span className="ns-heading-size-text ns-heading-size-text--h5">
                    Heading 5
                  </span>
                </button>
              </div>
            )}
          </div>

          <button
            className={`ns-fmt-btn${bk === "bq" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "blockquote" })}
            data-tooltip="Quote"
            data-tooltip-pos="below"
          >
            <QuotesIcon size={13} weight="bold" />
          </button>
          <div className="ns-toolbar-wrap" ref={calloutPickerRef}>
            <button
              className={`ns-fmt-btn ns-fmt-btn--dropdown${bk === "callout" ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                setShowCalloutPicker((p) => !p);
                setShowHeadingDropdown(false);
                setShowStructureDropdown(false);
                setShowAlignDropdown(false);
                setShowEmbedPicker(false);
                setShowLinkPicker(false);
                setShowColorPicker(false);
                setShowHighlightPicker(false);
              }}
              data-tooltip="Callout"
              data-tooltip-pos="below"
            >
              <LightbulbIcon size={13} weight="bold" />
              <CaretDownIcon
                size={11}
                weight="bold"
                className={`ns-fmt-btn-caret${showCalloutPicker ? " ns-fmt-btn-caret--open" : ""}`}
              />
            </button>
            {showCalloutPicker && (
              <div className="ns-toolbar-dropdown">
                {(
                  [
                    { tone: "info", label: "Info" },
                    { tone: "success", label: "Success" },
                    { tone: "warning", label: "Warning" },
                    { tone: "danger", label: "Danger" },
                    { tone: "neutral", label: "Neutral" },
                  ] as { tone: CalloutTone; label: string }[]
                ).map((opt) => (
                  <button
                    key={opt.tone}
                    className="ns-toolbar-dropdown-item"
                    onClick={() => {
                      dispatch({ kind: "callout", tone: opt.tone });
                      setShowCalloutPicker(false);
                    }}
                  >
                    <span
                      className={`ns-callout-swatch ns-callout-swatch--${opt.tone}`}
                    />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={`ns-fmt-btn${bk === "toggle" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "toggle" })}
            data-tooltip="Toggle list"
            data-tooltip-pos="below"
          >
            <CaretRightIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${bk === "code" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "codeBlock" })}
            data-tooltip="Code block"
            data-tooltip-pos="below"
          >
            <CodeBlockIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${bk === "todo" || bk === "todoChecked" ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "taskList" })}
            data-tooltip="Checklist"
            data-tooltip-pos="below"
          >
            <CheckSquareOffsetIcon size={13} weight="bold" />
          </button>
          <button
            className={`ns-fmt-btn${active.inTable ? " ns-fmt-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "insertTable" })}
            data-tooltip="Insert table"
            data-tooltip-pos="below"
          >
            <TableIcon size={13} weight="bold" />
          </button>
          <button
            className="ns-fmt-btn"
            onClick={() => dispatch({ kind: "hr" })}
            data-tooltip="Horizontal rule"
            data-tooltip-pos="below"
          >
            <MinusIcon size={13} weight="bold" />
          </button>
          </div>

          {/* Lists */}
          <div className="ns-fmt-group">
          <div className="ns-toolbar-wrap" ref={structureDropdownRef}>
            <button
              className={`ns-fmt-btn ns-fmt-btn--dropdown${structureActive ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                setShowStructureDropdown((p) => !p);
                setShowHeadingDropdown(false);
                setShowAlignDropdown(false);
                setShowEmbedPicker(false);
                setShowLinkPicker(false);
                setShowColorPicker(false);
                setShowHighlightPicker(false);
              }}
              data-tooltip="Lists"
              data-tooltip-pos="below"
            >
              <ListBulletsIcon size={13} weight="bold" />
              <CaretDownIcon
                size={11}
                weight="bold"
                className={`ns-fmt-btn-caret${showStructureDropdown ? " ns-fmt-btn-caret--open" : ""}`}
              />
            </button>
            {showStructureDropdown && (
              <div className="ns-toolbar-dropdown">
                <button
                  className={`ns-toolbar-dropdown-item${bk === "ul" ? " ns-toolbar-dropdown-item--active" : ""}`}
                  onClick={() => {
                    dispatch({ kind: "bulletList" });
                    setShowStructureDropdown(false);
                  }}
                >
                  <ListBulletsIcon size={13} weight="bold" />
                  Bullet list
                </button>
                <button
                  className={`ns-toolbar-dropdown-item${bk === "ol" ? " ns-toolbar-dropdown-item--active" : ""}`}
                  onClick={() => {
                    dispatch({ kind: "orderedList" });
                    setShowStructureDropdown(false);
                  }}
                >
                  <ListNumbersIcon size={13} weight="bold" />
                  Numbered list
                </button>
              </div>
            )}
          </div>
          </div>

          {/* Text alignment */}
          <div className="ns-fmt-group">
          <div className="ns-toolbar-wrap" ref={alignDropdownRef}>
            <button
              className={`ns-fmt-btn ns-fmt-btn--dropdown${active.align ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                setShowAlignDropdown((p) => !p);
                setShowHeadingDropdown(false);
                setShowStructureDropdown(false);
                setShowEmbedPicker(false);
                setShowLinkPicker(false);
                setShowColorPicker(false);
                setShowHighlightPicker(false);
              }}
              data-tooltip="Alignment"
              data-tooltip-pos="below"
            >
              {alignValue === "center" ? (
                <TextAlignCenterIcon size={13} weight="bold" />
              ) : alignValue === "right" ? (
                <TextAlignRightIcon size={13} weight="bold" />
              ) : alignValue === "justify" ? (
                <TextAlignJustifyIcon size={13} weight="bold" />
              ) : (
                <TextAlignLeftIcon size={13} weight="bold" />
              )}
              <CaretDownIcon
                size={11}
                weight="bold"
                className={`ns-fmt-btn-caret${showAlignDropdown ? " ns-fmt-btn-caret--open" : ""}`}
              />
            </button>
            {showAlignDropdown && (
              <div className="ns-toolbar-dropdown ns-toolbar-dropdown--left">
                <button
                  className={`ns-toolbar-dropdown-item${alignValue === "left" ? " ns-toolbar-dropdown-item--active" : ""}`}
                  onClick={() => {
                    dispatch({ kind: "align", value: "left" });
                    setShowAlignDropdown(false);
                  }}
                >
                  <TextAlignLeftIcon size={13} weight="bold" />
                  Align left
                </button>
                <button
                  className={`ns-toolbar-dropdown-item${alignValue === "center" ? " ns-toolbar-dropdown-item--active" : ""}`}
                  onClick={() => {
                    dispatch({ kind: "align", value: "center" });
                    setShowAlignDropdown(false);
                  }}
                >
                  <TextAlignCenterIcon size={13} weight="bold" />
                  Align center
                </button>
                <button
                  className={`ns-toolbar-dropdown-item${alignValue === "right" ? " ns-toolbar-dropdown-item--active" : ""}`}
                  onClick={() => {
                    dispatch({ kind: "align", value: "right" });
                    setShowAlignDropdown(false);
                  }}
                >
                  <TextAlignRightIcon size={13} weight="bold" />
                  Align right
                </button>
                <button
                  className={`ns-toolbar-dropdown-item${alignValue === "justify" ? " ns-toolbar-dropdown-item--active" : ""}`}
                  onClick={() => {
                    dispatch({ kind: "align", value: "justify" });
                    setShowAlignDropdown(false);
                  }}
                >
                  <TextAlignJustifyIcon size={13} weight="bold" />
                  Justify
                </button>
              </div>
            )}
          </div>
          </div>

          {/* Insert */}
          <div className="ns-fmt-group">
          <div className="ns-embed-wrap" ref={linkPickerRef}>
            <button
              className={`ns-fmt-btn${showLinkPicker ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                editorRef.current?.saveRange();
                setShowLinkPicker((p) => !p);
                setShowEmbedPicker(false);
                setShowHeadingDropdown(false);
                setShowStructureDropdown(false);
                setShowAlignDropdown(false);
                setShowColorPicker(false);
                setShowHighlightPicker(false);
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
                    placeholder="Display text (optional)"
                    value={linkText}
                    onChange={(e) => setLinkText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") insertLink(linkUrl, linkText);
                      if (e.key === "Escape") {
                        setShowLinkPicker(false);
                        setLinkUrl("");
                        setLinkText("");
                      }
                    }}
                  />
                </div>
                <div className="ns-link-picker-row">
                  <input
                    className="ns-embed-search ns-link-input"
                    placeholder="https://…"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") insertLink(linkUrl, linkText);
                      if (e.key === "Escape") {
                        setShowLinkPicker(false);
                        setLinkUrl("");
                        setLinkText("");
                      }
                    }}
                    autoFocus
                  />
                  <button
                    className="ns-link-insert-btn"
                    onClick={() => insertLink(linkUrl, linkText)}
                    disabled={!linkUrl.trim()}
                  >
                    Insert
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Image / file attachment buttons (sit next to Insert link). Both
              use a hidden <input type="file"> trigger and route through the
              backend save_note_{image,file} commands. */}
          <button
            className="ns-fmt-btn"
            onClick={() => imageInputRef.current?.click()}
            data-tooltip="Insert image"
            data-tooltip-pos="below"
          >
            <ImageIcon size={12} />
          </button>
          <button
            className="ns-fmt-btn"
            onClick={() => fileInputRef.current?.click()}
            data-tooltip="Attach document"
            data-tooltip-pos="below"
          >
            <FileIcon size={12} />
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleImagePick}
          />
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={handleDocumentPick}
          />

          {/* Embed picker */}
          <div className="ns-embed-wrap" ref={embedPickerRef}>
            <button
              className={`ns-fmt-btn${showEmbedPicker ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                editorRef.current?.saveRange();
                setShowEmbedPicker((p) => !p);
                setShowLinkPicker(false);
                setEmbedSearch("");
                setShowHeadingDropdown(false);
                setShowStructureDropdown(false);
                setShowAlignDropdown(false);
                setShowColorPicker(false);
                setShowHighlightPicker(false);
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
                  ) : (
                    <>
                      {/* System groups */}
                      <button
                        className="ns-embed-item"
                        onClick={() => insertGroupEmbed("pinned")}
                      >
                        <span className="ns-embed-item-group ns-embed-item-group--system ns-embed-item-group--pinned">
                          <PinIcon size={10} />
                          Pinned
                        </span>
                      </button>
                      <button
                        className="ns-embed-item"
                        onClick={() => insertGroupEmbed("Saved")}
                      >
                        <span className="ns-embed-item-group ns-embed-item-group--system ns-embed-item-group--saved">
                          <SaveStarIcon size={10} />
                          Saved
                        </span>
                      </button>
                      {/* User groups */}
                      {filteredGroups.length === 0 && embedSearch.trim() !== "" ? (
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
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          </div>
        </div>

        {/* Editor content area */}
        <div className="ns-editor-content">
          <NotionEditor
            ref={editorRef}
            noteId={note.id}
            initialContent={initialContent}
            entries={entries}
            onChange={handleEditorChange}
            onSelectionChange={refreshActive}
            onStatsChange={setStats}
          />
        </div>

        {/* Footer */}
        <div className="ns-editor-footer">
          <span className="ns-editor-footer-text">
            Updated {timeAgo(note.updated_at)}
          </span>
          <span className="ns-editor-footer-stats">
            Ln {stats.line} / {stats.blocks} · {stats.words} word
            {stats.words === 1 ? "" : "s"} · {stats.chars} char
            {stats.chars === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
};

export default NoteEditor;
