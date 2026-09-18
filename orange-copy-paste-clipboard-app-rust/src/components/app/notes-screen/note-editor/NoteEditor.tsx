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
  LightbulbIcon,
  TextAlignLeftIcon,
  TextAlignCenterIcon,
  TextAlignRightIcon,
  PaletteIcon,
  HighlighterIcon,
  DownloadSimpleIcon,
  CopyIcon,
  LockSimpleIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import type { Note, ClipboardEntry } from "../../../../types";
import {
  fileNameFromPath,
  groupColor,
  truncateText,
} from "../../../../types";
import { timeAgoFor } from "../../../../hooks/useRelativeTime";
import {
  PinIcon,
  SaveStarIcon,
  ImageIcon,
  FileIcon,
  ClipboardIcon,
  ExpandIcon,
  CollapseIcon,
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
  type AlignValue,
  type CalloutTone,
  type EditorStats,
  type EmbedForm,
  imageAttachmentUrl,
  fileAttachmentUrl,
  noteToMarkdown,
} from "../editor-engine";
import {
  TEXT_ZOOM_STEPS,
  ToolbarFacts,
  ToolbarMoreButton,
  ToolbarZoom,
  ViewToolbar,
  stepZoom,
  useToolbarMenu,
  useZoomKeys,
} from "../../view-toolbar/ViewToolbar";
// The note's own right-click menu, anchored under the bar's button rather
// than at a cursor - the same thing the clipboard and Spaces reading panels
// do with theirs.
import CardMenu from "../../card-menu/CardMenu";
import ToolbarPopover from "./ToolbarPopover";
import "./note-editor.css";

/** Persisted reading size for the editor. A plain UI preference, so it goes in
 *  the generic settings store and needs nothing on the Rust side. */
const NOTES_ZOOM_KEY = "notes_editor_zoom";

const EMPTY_ACTIVE: ActiveState = { blockKind: "p" };

interface Swatch {
  label: string;
  value: string | null;
}

const TEXT_COLORS: Swatch[] = [
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

const HIGHLIGHT_COLORS: Swatch[] = [
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

type HeadingLevel = 1 | 2 | 3;

const HEADINGS: { level: HeadingLevel; label: string; Icon: typeof TextHOneIcon }[] = [
  { level: 1, label: "Heading 1", Icon: TextHOneIcon },
  { level: 2, label: "Heading 2", Icon: TextHTwoIcon },
  { level: 3, label: "Heading 3", Icon: TextHThreeIcon },
];

const CALLOUT_TONES: { tone: CalloutTone; label: string }[] = [
  { tone: "info", label: "Info" },
  { tone: "success", label: "Success" },
  { tone: "warning", label: "Warning" },
  { tone: "danger", label: "Danger" },
  { tone: "neutral", label: "Neutral" },
];

const ALIGNMENTS: { value: AlignValue; label: string; Icon: typeof TextAlignLeftIcon }[] = [
  { value: "left", label: "Align left", Icon: TextAlignLeftIcon },
  { value: "center", label: "Align center", Icon: TextAlignCenterIcon },
  { value: "right", label: "Align right", Icon: TextAlignRightIcon },
];

/** Every panel the toolbar can have open. One at a time, by construction. */
type MenuId =
  | "export"
  | "color"
  | "highlight"
  | "heading"
  | "callout"
  | "lists"
  | "align"
  | "link"
  | "embed";

let lastEmbedForm: EmbedForm = "card";

const EMBED_FORMS: { value: EmbedForm; label: string; hint: string }[] = [
  { value: "card", label: "Card", hint: "Own row, shows the content" },
  { value: "chip", label: "Chip", hint: "In the sentence, preview on hover" },
];

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
  /** Whether the editor is filling the screen rather than sharing it with the
   *  list. Owned by the screen, which persists the choice. */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Someone else wrote this note; show it, but do not let it be edited. */
  readOnly?: boolean;
  /** Their display name, for the line explaining why it is locked. */
  ownerName?: string;
}

// ── Small pieces ──────────────────────────────────────────────────────────

const SwatchGrid: React.FC<{
  colors: Swatch[];
  onPick: (value: string | null) => void;
}> = ({ colors, onPick }) => (
  <div className="ns-color-grid">
    {colors.map((c) => (
      <button
        key={c.value ?? "none"}
        className={`ns-color-swatch${c.value ? "" : " ns-color-swatch--none"}`}
        style={c.value ? { background: c.value } : undefined}
        title={c.label}
        onClick={() => onPick(c.value)}
      >
        {c.value == null && <span>x</span>}
      </button>
    ))}
  </div>
);

const MenuItem: React.FC<{
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    className={`ns-popover-item${active ? " ns-popover-item--active" : ""}`}
    onClick={onClick}
  >
    {children}
  </button>
);

// ── Component ─────────────────────────────────────────────────────────────

const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  entries,
  availableGroups,
  onUpdate,
  onDelete,
  onPin,
  onSetGroups,
  onBack,
  fullscreen = false,
  onToggleFullscreen,
  readOnly = false,
  ownerName,
}) => {
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<NotionEditorHandle>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The newest content the editor reported. The unmount flush below cannot
  // ask the editor: React clears imperative refs before passive cleanups run,
  // so reading `editorRef` there returned nothing and the last 400ms of
  // typing before switching notes was lost.
  const latestContentRef = useRef<string>(note.content ?? "");

  const [active, setActive] = useState<ActiveState>(EMPTY_ACTIVE);
  const [stats, setStats] = useState<EditorStats>({
    blocks: 1,
    line: 1,
    chars: 0,
    words: 0,
  });

  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const toggleMenu = useCallback(
    (id: MenuId) => setOpenMenu((prev) => (prev === id ? null : id)),
    [],
  );

  const [preferredHeadingLevel, setPreferredHeadingLevel] =
    useState<HeadingLevel>(1);
  const [embedSearch, setEmbedSearch] = useState("");
  const [embedTab, setEmbedTab] = useState<"entries" | "groups">("entries");
  // Chip or card. Remembered for the session, not per note.
  const [embedForm, setEmbedFormState] = useState<EmbedForm>(() => lastEmbedForm);
  const setEmbedForm = useCallback((form: EmbedForm) => {
    lastEmbedForm = form;
    setEmbedFormState(form);
  }, []);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");
  const [exportToast, setExportToast] = useState<string | null>(null);

  // Pickers with their own inputs start clean each time they open.
  useEffect(() => {
    if (openMenu !== "link") {
      setLinkUrl("");
      setLinkText("");
    }
    if (openMenu !== "embed") setEmbedSearch("");
  }, [openMenu]);

  const initialContent = useMemo(() => note.content ?? "", [note.id]); // eslint-disable-line
  // The note's own title, not a derived one. Seeding the box with the title
  // the cards fall back to made that fallback real the moment anything saved,
  // and there was then no way to get rid of it: clearing the box only derived
  // it again. The placeholder covers an empty box; deriving is for display.
  const initialTitle = useMemo(() => note.title, [note.id]); // eslint-disable-line

  // ── Save ──────────────────────────────────────────────────────────────

  const save = useCallback(
    (content: string) => {
      // Rust refuses the write for someone else's note anyway; stopping here
      // keeps a doomed save off the debounce timer entirely.
      if (readOnly) return;
      // Stored exactly as typed, empty included. Writing a derived title back
      // into the box fought the user for the field: every keystroke that
      // emptied it put the first line of the note back.
      onUpdate(note.id, (titleRef.current?.value ?? "").trim(), content);
    },
    [note.id, onUpdate, readOnly],
  );

  const currentContent = useCallback(
    () => editorRef.current?.getContent() ?? latestContentRef.current,
    [],
  );

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const scheduleSave = useCallback(() => {
    clearSaveTimer();
    saveTimerRef.current = setTimeout(() => save(currentContent()), 400);
  }, [clearSaveTimer, save, currentContent]);

  const flushSave = useCallback(() => {
    if (!saveTimerRef.current) return;
    clearSaveTimer();
    save(currentContent());
  }, [clearSaveTimer, save, currentContent]);

  const handleEditorChange = useCallback(
    (content: string) => {
      latestContentRef.current = content;
      scheduleSave();
    },
    [scheduleSave],
  );

  // Flush whatever is still on the timer when the editor goes away.
  useEffect(() => flushSave, [note.id, flushSave]);

  useEffect(() => {
    if (!note.title && !note.content)
      setTimeout(() => titleRef.current?.focus(), 50);
  }, [note.id]); // eslint-disable-line

  // Toolbar active state.
  const refreshActive = useCallback(() => {
    setActive(editorRef.current?.getActiveState() ?? EMPTY_ACTIVE);
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshActive);
    return () => document.removeEventListener("selectionchange", refreshActive);
  }, [refreshActive]);

  // Ctrl+S saves now rather than in 400ms.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        clearSaveTimer();
        save(currentContent());
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [clearSaveTimer, save, currentContent]);

  // ── Close ─────────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    clearSaveTimer();
    const c = currentContent();
    // A title on its own is a note, and so is a note that is only an image
    // or a table. Only body text used to count, so writing a heading and
    // closing to come back to it threw the note away.
    const t = (titleRef.current?.value ?? "").trim();
    if (!t && !hasMeaningfulContent(c)) {
      onDelete(note.id);
      onBack();
      return;
    }
    save(c);
    onBack();
  }, [note.id, onDelete, onBack, save, clearSaveTimer, currentContent]);

  // ── Toolbar dispatch ──────────────────────────────────────────────────

  const dispatch = useCallback(
    (cmd: EditorCommand) => {
      editorRef.current?.applyCommand(cmd);
      setTimeout(refreshActive, 0);
    },
    [refreshActive],
  );

  /** Dispatch from inside a popover and close it. */
  const pick = useCallback(
    (cmd: EditorCommand) => {
      dispatch(cmd);
      closeMenu();
    },
    [dispatch, closeMenu],
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

  const menu = useToolbarMenu();

  // Reading size for the note itself. Persisted, because how big you like your
  // text is a way of working rather than a property of one note - the same
  // reasoning as the full-screen preference above it.
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    invoke<number | null>("get_setting", { key: NOTES_ZOOM_KEY })
      .then((v) => setZoom(typeof v === "number" && v > 0 ? v : 1))
      .catch(() => setZoom(1));
  }, []);

  const applyZoom = useCallback((next: number) => {
    setZoom(next);
    void invoke("set_setting", { key: NOTES_ZOOM_KEY, value: next });
  }, []);

  const zoomIn = useCallback(
    () => applyZoom(stepZoom(TEXT_ZOOM_STEPS, zoom, 1)),
    [applyZoom, zoom],
  );
  const zoomOut = useCallback(
    () => applyZoom(stepZoom(TEXT_ZOOM_STEPS, zoom, -1)),
    [applyZoom, zoom],
  );
  const zoomReset = useCallback(() => applyZoom(1), [applyZoom]);

  // Not while the overflow menu is open: its own rows do not zoom, and a menu
  // that swallowed the keys would be a worse surprise than one that ignores them.
  useZoomKeys(
    { in: zoomIn, out: zoomOut, reset: zoomReset },
    menu.isOpen,
  );

  // ── Export ────────────────────────────────────────────────────────────

  const showToast = useCallback((msg: string) => {
    setExportToast(msg);
    setTimeout(() => setExportToast(null), 2800);
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    closeMenu();
    const content = currentContent();
    const markdown = noteToMarkdown(content);
    const title = deriveNoteTitle(titleRef.current?.value ?? "", content);
    const safeTitle =
      title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_") || "note";
    try {
      const savedPath = await invoke<string>("export_note_text", {
        text: markdown,
        filename: `${safeTitle}.md`,
      });
      showToast(`Saved: ${fileNameFromPath(savedPath)}`);
    } catch (err) {
      console.error("[notes] export failed", err);
      showToast("Export failed");
    }
  }, [closeMenu, currentContent, showToast]);

  const handleCopyMarkdown = useCallback(async () => {
    closeMenu();
    const markdown = noteToMarkdown(currentContent());
    try {
      await navigator.clipboard.writeText(markdown);
      showToast("Copied as Markdown");
    } catch {
      showToast("Copy failed");
    }
  }, [closeMenu, currentContent, showToast]);

  // ── Embed / link insert ───────────────────────────────────────────────

  const insertClipEmbed = useCallback(
    (id: string) => {
      editorRef.current?.insertClipEmbed(id, embedForm);
      closeMenu();
    },
    [closeMenu, embedForm],
  );

  const insertGroupEmbed = useCallback(
    (name: string) => {
      editorRef.current?.insertGroupEmbed(name, embedForm);
      closeMenu();
    },
    [closeMenu, embedForm],
  );

  const insertLink = useCallback(
    (url: string, text?: string) => {
      if (!url.trim()) return;
      editorRef.current?.insertLink(url.trim(), text?.trim() || undefined);
      closeMenu();
    },
    [closeMenu],
  );

  // ── Attachment uploads ──────────────────────────────────────────────────
  // Hidden <input type="file"> elements; one for images, one for any document.
  // Files are persisted under app_data/note-attachments/{images,files}/ by
  // Rust and referenced by a short custom-scheme URL that resolves at render.

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
        editorRef.current?.applyCommand({
          kind: "fileCard",
          href: fileAttachmentUrl(filename),
          name: file.name,
          size: file.size,
        });
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
  const isHeading = bk.startsWith("h");
  const listActive = bk === "ul" || bk === "ol";
  const alignValue = active.align ?? "left";
  const HeadingIcon = HEADINGS.find((h) => h.level === preferredHeadingLevel)!.Icon;
  const AlignIcon = (ALIGNMENTS.find((a) => a.value === alignValue) ?? ALIGNMENTS[0]).Icon;

  const applyHeadingLevel = useCallback(
    (level: HeadingLevel) => {
      setPreferredHeadingLevel(level);
      pick({ kind: "heading", level });
    },
    [pick],
  );

  const caret = (id: MenuId) => (
    <CaretDownIcon
      size={11}
      weight="bold"
      className={`ns-fmt-btn-caret${openMenu === id ? " ns-fmt-btn-caret--open" : ""}`}
    />
  );

  const linkKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") insertLink(linkUrl, linkText);
  };

  return (
    <div className="ns-editor-shell">
      <div className="ns-editor">
        {/* The bar. Same shape as an opened clipboard entry and an opened item
            in a space: the way out, then what you are looking at, then what you
            can do with it. */}
        <ViewToolbar
          onBack={handleClose}
          backLabel="Close"
          actions={
            <>
              {/* Relative wrapper so the toast hangs under the button; the bar
                  itself is not a positioning context. */}
              <div className="ns-export-anchor">
              <ToolbarPopover
                open={openMenu === "export"}
                onClose={closeMenu}
                align="right"
                panelClassName="ns-popover--menu ns-export-menu"
                trigger={
                  <button
                    className={`vt-btn${openMenu === "export" ? " vt-btn--on" : ""}`}
                    onClick={() => toggleMenu("export")}
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "export"}
                    data-tooltip="Save the note out, or copy it as Markdown"
                    data-tooltip-pos="below"
                  >
                    <DownloadSimpleIcon size={13} weight="bold" />
                    Export
                  </button>
                }
              >
                <MenuItem onClick={handleExportMarkdown}>
                  <DownloadSimpleIcon size={12} weight="bold" />
                  Save as .md
                </MenuItem>
                <div className="ns-popover-sep" />
                <MenuItem onClick={handleCopyMarkdown}>
                  <CopyIcon size={12} weight="bold" />
                  Copy as Markdown
                </MenuItem>
              </ToolbarPopover>
              {exportToast && (
                <div className="ns-export-toast">{exportToast}</div>
              )}
              </div>

              {/* How big the note reads. Ctrl and plus or minus do the same,
                  and Ctrl and nought puts it back. */}
              <ToolbarZoom
                label={`${Math.round(zoom * 100)}%`}
                atDefault={zoom === 1}
                resetTooltip="Reset to 100%"
                onIn={zoomIn}
                onOut={zoomOut}
                onReset={zoomReset}
              />

              {onToggleFullscreen && (
                <button
                  className="vt-btn"
                  onClick={onToggleFullscreen}
                  aria-pressed={fullscreen}
                  data-tooltip={
                    fullscreen
                      ? "Bring the notes list back"
                      : "Hide the notes list and fill the window"
                  }
                  data-tooltip-pos="below"
                >
                  {fullscreen ? (
                    <>
                      <CollapseIcon size={13} /> Collapse
                    </>
                  ) : (
                    <>
                      <ExpandIcon size={13} /> Expand
                    </>
                  )}
                </button>
              )}

              <span className="vt-sep" aria-hidden="true" />

              {/* Pin, groups and delete live in here: the note's own
                  right-click menu rather than a rebuilt copy of it. */}
              <ToolbarMoreButton menu={menu} />
            </>
          }
        >
          <ToolbarFacts
            facts={[
              `${stats.words} ${stats.words === 1 ? "word" : "words"}`,
              `${stats.chars} ${stats.chars === 1 ? "character" : "characters"}`,
              `Updated ${timeAgoFor(note.updated_at, `note:${note.id}`)}`,
            ]}
          />
        </ViewToolbar>

        {/* Title, and the groups it is in. The chips only report: the menu
            above is where they are changed. */}
        <div className="ns-title-row">
          <input
            ref={titleRef}
            className="ns-title-input"
            placeholder="Note title"
            defaultValue={initialTitle}
            key={note.id}
            readOnly={readOnly}
            onChange={scheduleSave}
          />
          {note.groups.length > 0 && (
            <div className="ns-title-groups">
              {note.groups.slice(0, 3).map((g) => {
                const c = groupColor(g);
                return (
                  <span
                    key={g}
                    className="ns-editor-group-chip"
                    style={{ background: c.bg, color: c.fg }}
                  >
                    <span className="ns-chip-dot" />
                    <span className="ns-chip-label">{g}</span>
                  </span>
                );
              })}
              {note.groups.length > 3 && (
                <span className="ns-title-groups-more">
                  +{note.groups.length - 3}
                </span>
              )}
            </div>
          )}
        </div>

        {readOnly && (
          <div className="ns-readonly-bar">
            <LockSimpleIcon size={12} />
            <span>
              {ownerName ? `${ownerName} shared this note.` : "Shared with you."}{" "}
              Only they can edit it.
            </span>
          </div>
        )}

        {/* Formatting toolbar */}
        <div
          className={`ns-format-bar${readOnly ? " ns-format-bar--locked" : ""}`}
        >
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

          {/* Color and highlight */}
          <div className="ns-fmt-group">
            <ToolbarPopover
              open={openMenu === "color"}
              onClose={closeMenu}
              panelClassName="ns-popover--panel ns-color-picker"
              trigger={
                <button
                  className={`ns-fmt-btn${active.textColor ? " ns-fmt-btn--active" : ""}`}
                  onClick={() => toggleMenu("color")}
                  data-tooltip="Text color"
                  data-tooltip-pos="below"
                  style={active.textColor ? { color: active.textColor } : undefined}
                >
                  <PaletteIcon size={13} weight="bold" />
                </button>
              }
            >
              <SwatchGrid
                colors={TEXT_COLORS}
                onPick={(value) => pick({ kind: "textColor", value })}
              />
            </ToolbarPopover>

            <ToolbarPopover
              open={openMenu === "highlight"}
              onClose={closeMenu}
              panelClassName="ns-popover--panel ns-color-picker"
              trigger={
                <button
                  className={`ns-fmt-btn${active.highlight ? " ns-fmt-btn--active" : ""}`}
                  onClick={() => toggleMenu("highlight")}
                  data-tooltip="Highlight"
                  data-tooltip-pos="below"
                  style={
                    active.highlight ? { background: active.highlight } : undefined
                  }
                >
                  <HighlighterIcon size={13} weight="bold" />
                </button>
              }
            >
              <SwatchGrid
                colors={HIGHLIGHT_COLORS}
                onPick={(value) => pick({ kind: "highlight", value })}
              />
            </ToolbarPopover>
          </div>

          {/* Block types */}
          <div className="ns-fmt-group">
            <ToolbarPopover
              open={openMenu === "heading"}
              onClose={closeMenu}
              panelClassName="ns-popover--menu"
              trigger={
                <button
                  className={`ns-fmt-btn ns-fmt-btn--dropdown${isHeading ? " ns-fmt-btn--active" : ""}`}
                  onClick={() => toggleMenu("heading")}
                  data-tooltip="Heading size"
                  data-tooltip-pos="below"
                >
                  <HeadingIcon size={14} weight="bold" />
                  {caret("heading")}
                </button>
              }
            >
              {HEADINGS.map(({ level, label, Icon }) => (
                <MenuItem
                  key={level}
                  active={preferredHeadingLevel === level}
                  onClick={() => applyHeadingLevel(level)}
                >
                  <Icon size={13} weight="bold" />
                  <span className={`ns-heading-size-text ns-heading-size-text--h${level}`}>
                    {label}
                  </span>
                </MenuItem>
              ))}
            </ToolbarPopover>

            <button
              className={`ns-fmt-btn${bk === "bq" ? " ns-fmt-btn--active" : ""}`}
              onClick={() => dispatch({ kind: "blockquote" })}
              data-tooltip="Quote"
              data-tooltip-pos="below"
            >
              <QuotesIcon size={13} weight="bold" />
            </button>

            <ToolbarPopover
              open={openMenu === "callout"}
              onClose={closeMenu}
              panelClassName="ns-popover--menu"
              trigger={
                <button
                  className={`ns-fmt-btn ns-fmt-btn--dropdown${bk === "callout" ? " ns-fmt-btn--active" : ""}`}
                  onClick={() => toggleMenu("callout")}
                  data-tooltip="Callout"
                  data-tooltip-pos="below"
                >
                  <LightbulbIcon size={13} weight="bold" />
                  {caret("callout")}
                </button>
              }
            >
              {CALLOUT_TONES.map((opt) => (
                <MenuItem
                  key={opt.tone}
                  onClick={() => pick({ kind: "callout", tone: opt.tone })}
                >
                  <span className={`ns-callout-swatch ns-callout-swatch--${opt.tone}`} />
                  {opt.label}
                </MenuItem>
              ))}
            </ToolbarPopover>

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

          {/* Lists and alignment */}
          <div className="ns-fmt-group">
            <ToolbarPopover
              open={openMenu === "lists"}
              onClose={closeMenu}
              panelClassName="ns-popover--menu"
              trigger={
                <button
                  className={`ns-fmt-btn ns-fmt-btn--dropdown${listActive ? " ns-fmt-btn--active" : ""}`}
                  onClick={() => toggleMenu("lists")}
                  data-tooltip="Lists"
                  data-tooltip-pos="below"
                >
                  <ListBulletsIcon size={13} weight="bold" />
                  {caret("lists")}
                </button>
              }
            >
              <MenuItem active={bk === "ul"} onClick={() => pick({ kind: "bulletList" })}>
                <ListBulletsIcon size={13} weight="bold" />
                Bullet list
              </MenuItem>
              <MenuItem active={bk === "ol"} onClick={() => pick({ kind: "orderedList" })}>
                <ListNumbersIcon size={13} weight="bold" />
                Numbered list
              </MenuItem>
            </ToolbarPopover>

            <ToolbarPopover
              open={openMenu === "align"}
              onClose={closeMenu}
              panelClassName="ns-popover--menu"
              trigger={
                <button
                  className={`ns-fmt-btn ns-fmt-btn--dropdown${active.align && active.align !== "left" ? " ns-fmt-btn--active" : ""}`}
                  onClick={() => toggleMenu("align")}
                  data-tooltip="Alignment"
                  data-tooltip-pos="below"
                >
                  <AlignIcon size={13} weight="bold" />
                  {caret("align")}
                </button>
              }
            >
              {ALIGNMENTS.map(({ value, label, Icon }) => (
                <MenuItem
                  key={value}
                  active={alignValue === value}
                  onClick={() => pick({ kind: "align", value })}
                >
                  <Icon size={13} weight="bold" />
                  {label}
                </MenuItem>
              ))}
            </ToolbarPopover>
          </div>

          {/* Insert */}
          <div className="ns-fmt-group">
            <ToolbarPopover
              open={openMenu === "link"}
              onClose={closeMenu}
              align="right"
              panelClassName="ns-popover--panel ns-link-picker"
              trigger={
                <button
                  className={`ns-fmt-btn${openMenu === "link" ? " ns-fmt-btn--active" : ""}`}
                  onClick={() => toggleMenu("link")}
                  data-tooltip="Insert link"
                  data-tooltip-pos="below"
                >
                  <LinkSimpleIcon size={12} weight="bold" />
                </button>
              }
            >
              <input
                className="ns-picker-input"
                placeholder="Display text (optional)"
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                onKeyDown={linkKeys}
              />
              <div className="ns-link-picker-row">
                <input
                  className="ns-picker-input"
                  placeholder="https://..."
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={linkKeys}
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
            </ToolbarPopover>

            {/* Image and file attachments. Both use a hidden <input type="file">
                and route through the Rust save_note_{image,file} commands. */}
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

            <ToolbarPopover
              open={openMenu === "embed"}
              onClose={closeMenu}
              align="right"
              panelClassName="ns-popover--panel ns-embed-picker"
              trigger={
                <button
                  className={`ns-fmt-btn${openMenu === "embed" ? " ns-fmt-btn--active" : ""}`}
                  onClick={() => toggleMenu("embed")}
                  data-tooltip="Embed clipboard entry"
                  data-tooltip-pos="below"
                >
                  <ClipboardTextIcon size={13} weight="bold" />
                </button>
              }
            >
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
              <div className="ns-embed-controls">
                <input
                  className="ns-picker-input ns-embed-search"
                  placeholder={
                    embedTab === "entries" ? "Search entries..." : "Search groups..."
                  }
                  value={embedSearch}
                  onChange={(e) => setEmbedSearch(e.target.value)}
                  autoFocus
                />
                <div className="ns-embed-form" role="radiogroup" aria-label="Insert as">
                  {EMBED_FORMS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      role="radio"
                      aria-checked={embedForm === f.value}
                      className={`ns-embed-form-btn${embedForm === f.value ? " ns-embed-form-btn--on" : ""}`}
                      onClick={() => setEmbedForm(f.value)}
                      data-tooltip={f.hint}
                      data-tooltip-pos="below"
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
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
                            {timeAgoFor(entry.timestamp, `clipboard:${entry.id}`)}
                          </span>
                        </button>
                      );
                    })
                  )
                ) : (
                  <>
                    <button
                      className="ns-embed-item"
                      onClick={() => insertGroupEmbed("pinned")}
                    >
                      <span className="ns-embed-item-group ns-embed-item-group--pinned">
                        <PinIcon size={10} />
                        Pinned
                      </span>
                    </button>
                    <button
                      className="ns-embed-item"
                      onClick={() => insertGroupEmbed("Saved")}
                    >
                      <span className="ns-embed-item-group ns-embed-item-group--saved">
                        <SaveStarIcon size={10} />
                        Saved
                      </span>
                    </button>
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
            </ToolbarPopover>
          </div>
        </div>

        {/* Editor content area.
            `zoom` rather than a font-size: the editor is a contenteditable full
            of blocks with their own sizes, and zoom scales the caret and the
            click targets with them. The scrollbar is on this element too, so
            zoom scaled that as well; dividing the two sizes App.css exposes by
            the same factor cancels it. */}
        <div
          className="ns-editor-content"
          style={
            zoom === 1
              ? undefined
              : ({
                  zoom,
                  "--sb-size": `${12 / zoom}px`,
                  "--sb-inset": `${2 / zoom}px`,
                } as React.CSSProperties)
          }
        >
          <NotionEditor
            ref={editorRef}
            noteId={note.id}
            initialContent={initialContent}
            entries={entries}
            onChange={handleEditorChange}
            onSelectionChange={refreshActive}
            onStatsChange={setStats}
            readOnly={readOnly}
          />
        </div>

        {/* Footer: the one thing that is about where the caret is rather than
            what the note is. Word and character counts sit in the bar. */}
        <div className="ns-editor-footer">
          <span className="ns-editor-footer-stats">
            Ln {stats.line} / {stats.blocks}{" "}
            {stats.blocks === 1 ? "block" : "blocks"}
          </span>
        </div>

        <CardMenu
          open={menu.isOpen}
          anchorX={menu.pos?.x ?? 0}
          anchorY={menu.pos?.y ?? 0}
          onClose={menu.close}
          isPinned={note.pinned}
          isSaved={false}
          copied={false}
          showCopy={false}
          showSave={false}
          onCopy={() => {}}
          onToggleSave={() => {}}
          onDelete={() => {
            onDelete(note.id);
            onBack();
          }}
          onPin={(shouldPin) => onPin(note.id, shouldPin)}
          availableGroups={availableGroups}
          entryGroups={note.groups}
          onToggleGroup={toggleGroup}
        />
      </div>
    </div>
  );
};

export default NoteEditor;
