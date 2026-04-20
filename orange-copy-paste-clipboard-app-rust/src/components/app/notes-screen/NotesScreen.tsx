import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Note, ClipboardEntry } from "../../../types";
import {
  classifyFileEntry,
  filePaths,
  groupColor,
  isImageFile,
  resolveImageSrc,
  timeAgo,
  truncateText,
} from "../../../types";
import type { SortMode } from "../sort-options";
import Topbar, {
  SortDropdown,
  LayoutSegment,
  GroupsButton,
} from "../topbar/Topbar";
import type { ClipboardLayout } from "../topbar/Topbar";
import {
  NotesIcon,
  PlusIcon,
  CloseIcon,
  TrashIcon,
  PinIcon,
  ComposeIcon,
  MultiSelectIcon,
  CheckIcon,
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  StrikethroughIcon,
  HeadingIcon,
  BulletListIcon,
  OrderedListIcon,
  QuoteIcon,
  EmbedClipIcon,
  ChevronRightIcon,
  FilterIcon,
  SearchXIcon,
  ImageIcon,
  FileIcon,
  ClipboardIcon,
} from "../../icons";
import { PinIcon as PinIconElement } from "../../entry-types/EntryTypePill";
import { useMultiSelect } from "../../../hooks/useMultiSelect";
import BulkActionsBar from "../clipboard-screen/bulk-actions/BulkActionsBar";
import CardMenu from "../card-menu/CardMenu";
import "../clipboard-screen/search-filter/SearchFilter.css";
import "./NotesScreen.css";

const NOTES_SPLIT_STORAGE_KEY = "ns-notes-list-width";
const NOTES_SPLIT_DEFAULT = 40;
const NOTES_SPLIT_MIN = 40;
const NOTES_SPLIT_MAX = 68;
const DEFAULT_NOTE_TITLE = "New note";

// ── Helpers ──────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent ?? tmp.innerText ?? "";
}

function plainNoteText(html: string): string {
  return stripHtml(html)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveNoteTitle(rawTitle: string, contentHtml: string): string {
  const fromTitle = rawTitle.trim();
  if (fromTitle) return fromTitle;

  const fromContent = plainNoteText(contentHtml);
  if (fromContent) return truncateText(fromContent, 54);

  return DEFAULT_NOTE_TITLE;
}

function hasMeaningfulContent(contentHtml: string): boolean {
  return plainNoteText(contentHtml).length > 0;
}

function isNoteExpandable(note: Note): boolean {
  return plainNoteText(note.content).length > 180;
}

function sanitizeNotePreviewHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;

  // Keep card previews compact by rendering note embeds as small chips.
  template.content.querySelectorAll("[data-clip-embed]").forEach((el) => {
    const embedId = el.getAttribute("data-clip-embed") ?? "";
    const chip = document.createElement("span");
    chip.className = "ns-preview-embed-chip";
    chip.textContent = embedId ? `Clip #${embedId}` : "Clip reference";
    el.replaceWith(chip);
  });

  template.content.querySelectorAll("[data-group-ref]").forEach((el) => {
    const group = el.getAttribute("data-group-ref") ?? "Group";
    const chip = document.createElement("span");
    chip.className = "ns-preview-group-chip";
    chip.textContent = `#${group}`;
    el.replaceWith(chip);
  });

  template.content
    .querySelectorAll("script, style, iframe, object, embed, link, meta")
    .forEach((el) => el.remove());

  template.content.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();

      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        return;
      }

      if (
        (name === "href" || name === "src") &&
        /^\s*javascript:/i.test(value)
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });

  return template.innerHTML;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ── Formatting state (active toolbar buttons) ───────────────────────

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

// ── NoteEditor ──────────────────────────────────────────────────────

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

  // ── Embed picker state ──
  const [showEmbedPicker, setShowEmbedPicker] = useState(false);
  const [embedSearch, setEmbedSearch] = useState("");
  const [embedTab, setEmbedTab] = useState<"entries" | "groups">("entries");
  const embedPickerRef = useRef<HTMLDivElement>(null);
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

  // Render clipboard embed placeholders.
  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current
      .querySelectorAll("[data-clip-embed]:not([data-rendered])")
      .forEach((el) => {
        const embedId = el.getAttribute("data-clip-embed") ?? "";
        const host = el as HTMLElement;
        host.setAttribute("data-rendered", "1");
        const entry = entries.find((e) => e.id === embedId);
        host.className = entry
          ? "clip-embed"
          : "clip-embed clip-embed--missing";
        host.onclick = null;
        host.replaceChildren();

        const header = document.createElement("div");
        header.className = "clip-embed-header";

        const title = document.createElement("span");
        title.className = "clip-embed-title";

        const kind = document.createElement("span");
        kind.className = "clip-embed-kind";

        const ts = document.createElement("span");
        ts.className = "clip-embed-time";

        const body = document.createElement("div");
        body.className = "clip-embed-body";

        if (!entry) {
          title.textContent = "Missing clipboard reference";
          kind.textContent = "missing";
          ts.textContent = "";
          body.textContent = `Reference #${embedId} no longer exists in history.`;
          body.classList.add("clip-embed-fallback");
        } else {
          const paths = entry.type === "file" ? filePaths(entry.content) : [];
          const fileKind =
            entry.type === "file" ? classifyFileEntry(entry.content) : "file";

          title.textContent =
            entry.label?.trim() ||
            (entry.type === "image"
              ? "Embedded image"
              : entry.type === "file"
                ? "Embedded file"
                : "Embedded clip");

          if (entry.type === "file" && fileKind === "image") {
            kind.textContent = "image set";
          } else {
            kind.textContent = entry.type;
          }
          ts.textContent = timeAgo(entry.timestamp);

          if (entry.type === "image") {
            const img = document.createElement("img");
            img.className = "clip-embed-image";
            img.alt = title.textContent;
            img.src = resolveImageSrc(entry.content, convertFileSrc);
            img.addEventListener(
              "error",
              () => {
                img.remove();
                body.textContent = "Image preview unavailable.";
                body.classList.add("clip-embed-fallback");
              },
              { once: true },
            );
            body.appendChild(img);
          } else if (entry.type === "file") {
            const firstImagePath = paths.find((p) => isImageFile(p));
            if (fileKind === "image" && firstImagePath) {
              const img = document.createElement("img");
              img.className = "clip-embed-image";
              img.alt = fileName(firstImagePath);
              img.src = convertFileSrc(firstImagePath);
              img.addEventListener(
                "error",
                () => {
                  img.remove();
                  body.textContent = "Image preview unavailable.";
                  body.classList.add("clip-embed-fallback");
                },
                { once: true },
              );
              body.appendChild(img);
            } else {
              const firstPath = paths[0] ?? "";
              body.textContent = firstPath
                ? `${fileName(firstPath)}${paths.length > 1 ? ` (+${paths.length - 1} more)` : ""}`
                : "File reference";
              body.classList.add("clip-embed-path");
            }
          } else {
            const source =
              entry.type === "html" ? stripHtml(entry.content) : entry.content;
            body.textContent =
              truncateText(source.replace(/\s+/g, " ").trim(), 220) ||
              "(Empty clip)";
          }
        }

        header.append(title, kind, ts);
        host.append(header, body);
      });
  });

  // Render group reference placeholders.
  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current
      .querySelectorAll("[data-group-ref]:not([data-rendered])")
      .forEach((el) => {
        const groupName = el.getAttribute("data-group-ref")!;
        el.setAttribute("data-rendered", "1");
        const c = groupColor(groupName);
        el.className = "group-embed";
        (el as HTMLElement).style.background = c.bg;
        (el as HTMLElement).style.color = c.fg;
        el.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;flex-shrink:0;opacity:0.8"></span>${groupName}`;
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

  const insertClipEmbed = useCallback(
    (id: string) => {
      editorRef.current?.focus();
      document.execCommand(
        "insertHTML",
        false,
        `<div data-clip-embed="${id}" contenteditable="false">[clip:${id}]</div><p><br></p>`,
      );
      scheduleSave();
      setShowEmbedPicker(false);
    },
    [scheduleSave],
  );

  const insertGroupEmbed = useCallback(
    (group: string) => {
      editorRef.current?.focus();
      document.execCommand(
        "insertHTML",
        false,
        `<span data-group-ref="${group}" contenteditable="false">[#${group}]</span>&nbsp;`,
      );
      scheduleSave();
      setShowEmbedPicker(false);
    },
    [scheduleSave],
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
              <PlusIcon size={9} />
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
            onClick={() => execCmd("strikethrough")}
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
            <HeadingIcon size={14} />
          </button>
          <button
            className="ns-fmt-btn"
            onClick={() => execCmd("formatBlock", "h2")}
            data-tooltip="Heading 2"
            data-tooltip-pos="below"
            style={{ opacity: 0.7 }}
          >
            <HeadingIcon size={11} />
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

          {/* Embed picker */}
          <div className="ns-embed-wrap" ref={embedPickerRef}>
            <button
              className={`ns-fmt-btn${showEmbedPicker ? " ns-fmt-btn--active" : ""}`}
              onClick={() => {
                setShowEmbedPicker((p) => !p);
                setEmbedSearch("");
              }}
              data-tooltip="Embed reference"
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
            onInput={() => {
              scheduleSave();
              updateFormat();
            }}
            onKeyUp={updateFormat}
            onMouseUp={updateFormat}
            onPaste={(e) => {
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

// ── Notes filter dropdown ───────────────────────────────────────────

interface NotesFilterState {
  pinnedOnly: boolean;
  setPinnedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  selectedGroups: Set<string>;
  toggleGroup: (g: string) => void;
  activeFilterCount: number;
  clearAll: () => void;
  filtersOpen: boolean;
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filterRef: React.RefObject<HTMLDivElement | null>;
}

function useNotesFilter(): NotesFilterState {
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const toggleGroup = useCallback((g: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (pinnedOnly) n++;
    if (selectedGroups.size > 0) n++;
    return n;
  }, [pinnedOnly, selectedGroups]);

  const clearAll = useCallback(() => {
    setPinnedOnly(false);
    setSelectedGroups(new Set());
  }, []);

  return {
    pinnedOnly,
    setPinnedOnly,
    selectedGroups,
    toggleGroup,
    activeFilterCount,
    clearAll,
    filtersOpen,
    setFiltersOpen,
    filterRef,
  };
}

const NotesFilterDropdown: React.FC<{
  nf: NotesFilterState;
  availableGroups: string[];
}> = ({ nf, availableGroups }) => (
  <div className="sort-dropdown" ref={nf.filterRef}>
    <button
      className={`cs-tb-btn${nf.filtersOpen ? " cs-tb-btn--open" : ""}`}
      onClick={() => {
        if (!nf.filtersOpen) document.dispatchEvent(new Event("tooltip:hide"));
        nf.setFiltersOpen((v) => !v);
      }}
      data-tooltip="Filters"
      data-tooltip-pos="below"
    >
      <FilterIcon size={12} />
      {nf.activeFilterCount > 0 && (
        <span className="cs-tb-badge">{nf.activeFilterCount}</span>
      )}
    </button>
    {nf.filtersOpen && (
      <div className="cs-filter-card">
        {/* System section */}
        <div className="cs-card-section">
          <div className="cs-section-label">System</div>
          <div className="cs-type-grid">
            <label
              className={`cs-type-option${nf.pinnedOnly ? " cs-type-option--on" : ""}`}
            >
              <input
                type="checkbox"
                checked={nf.pinnedOnly}
                onChange={() => nf.setPinnedOnly((v) => !v)}
                className="cs-type-cb"
              />
              <span
                className="cs-type-icon type-pill"
                style={{
                  background: "var(--accent-dim)",
                  color: "var(--accent)",
                }}
              >
                {PinIconElement}
              </span>
              <span className="cs-type-name">Pinned</span>
            </label>
          </div>
        </div>

        {/* Groups section */}
        {availableGroups.length > 0 && (
          <>
            <div className="cs-card-divider" />
            <div className="cs-card-section">
              <div className="cs-section-label">
                Groups
                {nf.selectedGroups.size > 0 && (
                  <span className="cs-count">{nf.selectedGroups.size}</span>
                )}
              </div>
              <div className="cs-type-grid">
                {availableGroups.map((g) => {
                  const gc = groupColor(g);
                  return (
                    <label
                      key={g}
                      className={`cs-type-option${nf.selectedGroups.has(g) ? " cs-type-option--on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={nf.selectedGroups.has(g)}
                        onChange={() => nf.toggleGroup(g)}
                        className="cs-type-cb"
                      />
                      <span
                        className="cs-type-icon type-pill"
                        style={{ background: gc.bg, color: gc.fg }}
                      >
                        <span
                          className="cs-color-dot"
                          style={{ background: gc.fg }}
                        />
                      </span>
                      <span className="cs-type-name">{g}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Clear filters button */}
        {nf.activeFilterCount > 0 && (
          <>
            <div className="cs-card-divider" />
            <button className="cs-card-clear-btn" onClick={nf.clearAll}>
              <CloseIcon size={12} />
              Clear Filters
            </button>
          </>
        )}
      </div>
    )}
  </div>
);

// ── NotesScreen ─────────────────────────────────────────────────────

interface NotesScreenProps {
  notes: Note[];
  entries: ClipboardEntry[];
  availableGroups: string[];
  onAddGroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onCreate: () => Promise<Note> | Note;
  onUpdate: (id: string, title: string, content: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pin: boolean) => void;
  onSetGroups: (id: string, groups: string[]) => void;
  onCopyEntry?: (id: string) => void;
  onBulkDelete?: (ids: string[]) => void;
  onBulkPin?: (ids: string[]) => void;
  onBulkUnpin?: (ids: string[]) => void;
  onBulkAddGroup?: (ids: string[], group: string) => void;
  onBulkRemoveGroup?: (ids: string[], group: string) => void;
}

const NotesScreen: React.FC<NotesScreenProps> = ({
  notes,
  entries,
  availableGroups,
  onAddGroup,
  onDeleteGroup,
  onRenameGroup,
  onCreate,
  onUpdate,
  onDelete,
  onPin,
  onSetGroups,
  onCopyEntry,
  onBulkDelete,
  onBulkPin,
  onBulkUnpin,
  onBulkAddGroup,
  onBulkRemoveGroup,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fading, setFading] = useState(false);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nf = useNotesFilter();

  const multiSelect = useMultiSelect();

  const [sort, setSort] = useState<SortMode>(() => {
    return (localStorage.getItem("ns-sort") as SortMode) ?? "newest";
  });
  const [layout, setLayout] = useState<ClipboardLayout>(() => {
    return (localStorage.getItem("ns-layout") as ClipboardLayout) ?? "tiles";
  });
  const [collapsedSections, setCollapsedSections] = useState({
    pinned: false,
    notes: false,
  });
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<string>>(
    new Set(),
  );
  const [menuState, setMenuState] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [notesListWidthPct, setNotesListWidthPct] = useState<number>(() => {
    const raw = Number(localStorage.getItem(NOTES_SPLIT_STORAGE_KEY));
    if (!Number.isFinite(raw)) return NOTES_SPLIT_DEFAULT;
    return Math.min(NOTES_SPLIT_MAX, Math.max(NOTES_SPLIT_MIN, raw));
  });
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  // Close filter dropdown on outside click
  useEffect(() => {
    if (!nf.filtersOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        nf.filterRef.current &&
        !nf.filterRef.current.contains(e.target as Node)
      )
        nf.setFiltersOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [nf.filtersOpen]);

  const filteredNotes = notes.filter((n) => {
    if (nf.pinnedOnly && !n.pinned) return false;
    if (
      nf.selectedGroups.size > 0 &&
      !n.groups.some((g) => nf.selectedGroups.has(g))
    )
      return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !n.title.toLowerCase().includes(q) &&
        !stripHtml(n.content).toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  const sortedNotes = [...filteredNotes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    switch (sort) {
      case "oldest":
        return a.updated_at - b.updated_at;
      case "a-z":
        return (a.title || "").localeCompare(b.title || "");
      case "z-a":
        return (b.title || "").localeCompare(a.title || "");
      default:
        return b.updated_at - a.updated_at;
    }
  });

  const editingNote = editingId
    ? (notes.find((n) => n.id === editingId) ?? null)
    : null;
  const menuNote = menuState
    ? (notes.find((n) => n.id === menuState.id) ?? null)
    : null;

  useEffect(() => {
    if (editingId && !notes.some((n) => n.id === editingId)) setEditingId(null);
  }, [notes, editingId]);

  useEffect(() => {
    if (menuState && !notes.some((n) => n.id === menuState.id)) {
      setMenuState(null);
    }
  }, [notes, menuState]);

  useEffect(() => {
    localStorage.setItem(NOTES_SPLIT_STORAGE_KEY, notesListWidthPct.toFixed(2));
  }, [notesListWidthPct]);

  useEffect(() => {
    if (!isResizingSplit) return;

    const onMove = (e: MouseEvent) => {
      const container = mainRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(NOTES_SPLIT_MAX, Math.max(NOTES_SPLIT_MIN, pct));
      setNotesListWidthPct(clamped);
    };

    const onUp = () => {
      setIsResizingSplit(false);
    };

    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizingSplit]);

  const handleCreate = useCallback(async () => {
    const note = await onCreate();
    setEditingId(note.id);
  }, [onCreate]);

  const handleDelete = useCallback(
    (id: string) => {
      onDelete(id);
      setExpandedNoteIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (editingId === id) setEditingId(null);
    },
    [onDelete, editingId],
  );

  useEffect(
    () => () => {
      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    },
    [],
  );

  const selectLayout = useCallback(
    (l: ClipboardLayout) => {
      if (l === layout) return;
      setFading(true);
      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = setTimeout(() => {
        setLayout(l);
        localStorage.setItem("ns-layout", l);
        setFading(false);
      }, 160);
    },
    [layout],
  );

  const pinnedCount = sortedNotes.filter((n) => n.pinned).length;
  const showSections = pinnedCount > 0 && pinnedCount < sortedNotes.length;
  const visibleNotes = showSections
    ? sortedNotes.filter((n) => {
        if (n.pinned && collapsedSections.pinned) return false;
        if (!n.pinned && collapsedSections.notes) return false;
        return true;
      })
    : sortedNotes;
  const allVisibleIds = visibleNotes.map((n) => n.id);

  // Prune stale selections when notes change
  useEffect(() => {
    if (!multiSelect.isSelecting) return;
    const activeIds = new Set(notes.map((n) => n.id));
    multiSelect.pruneStaleIds(activeIds);
  }, [notes, multiSelect.isSelecting]);

  // Exit multi-select on Escape
  useEffect(() => {
    if (!multiSelect.isSelecting) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") multiSelect.exitSelectMode();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [multiSelect.isSelecting]);

  // Compute bulk state
  const allPinned =
    multiSelect.selectedCount > 0 &&
    notes
      .filter((n) => multiSelect.selectedIds.has(n.id))
      .every((n) => n.pinned);
  const commonGroups = (() => {
    if (multiSelect.selectedCount === 0) return [] as string[];
    const sel = notes.filter((n) => multiSelect.selectedIds.has(n.id));
    if (sel.length === 0) return [] as string[];
    const first = new Set(sel[0].groups);
    return [...first].filter((g) => sel.every((n) => n.groups.includes(g)));
  })();

  return (
    <div
      className={`notes-screen-root${editingNote ? " notes-screen-root--editing" : ""}`}
    >
      <Topbar
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search notes…"
        searchInputRef={searchRef}
        leftSlot={
          <>
            <button
              className="cs-tb-btn"
              onClick={handleCreate}
              data-tooltip="New note"
              data-tooltip-pos="below"
            >
              <ComposeIcon size={13} />
            </button>

            <div className="cs-toolbar-sep" />

            <SortDropdown
              sort={sort}
              onSortChange={(s) => {
                setSort(s);
                localStorage.setItem("ns-sort", s);
              }}
            />
            <NotesFilterDropdown nf={nf} availableGroups={availableGroups} />
          </>
        }
        rightSlot={
          <>
            <LayoutSegment layout={layout} onLayoutChange={selectLayout} />

            <div className="cs-toolbar-sep" />

            {/* Select mode */}
            <div className="bulk-select-wrap">
              <button
                className={`cs-tb-btn${multiSelect.isSelecting ? " cs-tb-btn--active" : ""}`}
                onClick={() => {
                  document.dispatchEvent(new Event("tooltip:hide"));
                  multiSelect.isSelecting
                    ? multiSelect.exitSelectMode()
                    : multiSelect.enterSelectMode();
                }}
                data-tooltip={
                  multiSelect.isSelecting
                    ? multiSelect.selectedCount > 0
                      ? `${multiSelect.selectedCount} selected`
                      : "Exit selection"
                    : "Select notes"
                }
                data-tooltip-pos="below"
              >
                <MultiSelectIcon size={13} />
                {multiSelect.isSelecting && multiSelect.selectedCount > 0 && (
                  <span className="cs-tb-badge">
                    {multiSelect.selectedCount}
                  </span>
                )}
              </button>

              {multiSelect.isSelecting && (
                <BulkActionsBar
                  selectedCount={multiSelect.selectedCount}
                  totalCount={notes.length}
                  onSelectAll={() => multiSelect.selectAll(allVisibleIds)}
                  onDeselectAll={multiSelect.deselectAll}
                  onExitSelectMode={multiSelect.exitSelectMode}
                  onBulkDelete={() => {
                    if (onBulkDelete) {
                      onBulkDelete([...multiSelect.selectedIds]);
                      multiSelect.exitSelectMode();
                    }
                  }}
                  allPinned={allPinned}
                  onBulkTogglePin={() => {
                    if (allPinned) {
                      if (onBulkUnpin)
                        onBulkUnpin([...multiSelect.selectedIds]);
                    } else {
                      if (onBulkPin) onBulkPin([...multiSelect.selectedIds]);
                    }
                  }}
                  allSaved={false}
                  onBulkToggleSave={() => {}}
                  onBulkAddGroup={(group) => {
                    if (onBulkAddGroup)
                      onBulkAddGroup([...multiSelect.selectedIds], group);
                  }}
                  onBulkRemoveGroup={(group) => {
                    if (onBulkRemoveGroup)
                      onBulkRemoveGroup([...multiSelect.selectedIds], group);
                  }}
                  availableGroups={availableGroups}
                  commonGroups={commonGroups}
                />
              )}
            </div>

            <GroupsButton
              availableGroups={availableGroups}
              entries={entries}
              onAddGroup={onAddGroup}
              onDeleteGroup={onDeleteGroup}
              onRenameGroup={onRenameGroup}
              disabled={multiSelect.isSelecting}
            />
          </>
        }
      />

      <div
        ref={mainRef}
        className={`ns-main${editingNote ? " ns-main--editing" : ""}${isResizingSplit ? " ns-main--resizing" : ""}`}
      >
        {/* ── Masonry grid ── */}
        <div
          className={`ns-viewport${fading ? " ns-viewport--fading" : ""}`}
          style={
            editingNote
              ? {
                  flex: "0 0 auto",
                  width: `${notesListWidthPct}%`,
                }
              : undefined
          }
        >
          {notes.length === 0 ? (
            <div className="ns-empty">
              <NotesIcon size={36} className="ns-empty-icon" />
              <h3 className="ns-empty-title">No notes yet</h3>
              <p className="ns-empty-subtitle">
                Click the compose button to create your first note.
              </p>
            </div>
          ) : sortedNotes.length === 0 ? (
            <div className="cs-no-results">
              <SearchXIcon size={44} className="cs-no-results-icon" />
              <p className="cs-no-results-title">No matching notes</p>
              <p className="cs-no-results-subtitle">
                {search.trim() ? (
                  <>
                    Nothing matches &ldquo;{search.trim()}&rdquo;
                    {nf.activeFilterCount > 0
                      ? " with the current filters"
                      : ""}
                    .
                  </>
                ) : (
                  <>No notes match the current filters.</>
                )}
              </p>
            </div>
          ) : (
            <div
              className={`ns-grid${layout === "list" ? " ns-grid--list" : ""}`}
            >
              {sortedNotes.map((n, idx) => (
                <React.Fragment key={n.id}>
                  {showSections && idx === 0 && (
                    <button
                      type="button"
                      className="ns-section-label"
                      onClick={() =>
                        setCollapsedSections((prev) => ({
                          ...prev,
                          pinned: !prev.pinned,
                        }))
                      }
                      aria-expanded={!collapsedSections.pinned}
                    >
                      <PinIcon size={9} />
                      Pinned
                      <ChevronRightIcon
                        size={10}
                        className={`ns-section-chevron${collapsedSections.pinned ? "" : " ns-section-chevron--open"}`}
                      />
                    </button>
                  )}
                  {showSections && idx === pinnedCount && (
                    <button
                      type="button"
                      className="ns-section-label"
                      onClick={() =>
                        setCollapsedSections((prev) => ({
                          ...prev,
                          notes: !prev.notes,
                        }))
                      }
                      aria-expanded={!collapsedSections.notes}
                    >
                      <NotesIcon size={10} />
                      Notes
                      <ChevronRightIcon
                        size={10}
                        className={`ns-section-chevron${collapsedSections.notes ? "" : " ns-section-chevron--open"}`}
                      />
                    </button>
                  )}
                  {(!showSections ||
                    (n.pinned && !collapsedSections.pinned) ||
                    (!n.pinned && !collapsedSections.notes)) && (
                    <div
                      className={[
                        "ns-card",
                        multiSelect.isSelecting && "ns-card--selectable",
                        multiSelect.selectedIds.has(n.id) &&
                          "ns-card--selected",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onContextMenu={(e) => {
                        if (multiSelect.isSelecting) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setMenuState({ id: n.id, x: e.clientX, y: e.clientY });
                      }}
                      onClick={(e) => {
                        if (multiSelect.isSelecting) {
                          if (e.shiftKey) {
                            multiSelect.selectRange(n.id, allVisibleIds);
                          } else {
                            multiSelect.toggleSelect(n.id);
                          }
                          return;
                        }
                        setEditingId(n.id);
                      }}
                    >
                      {multiSelect.isSelecting && (
                        <span className="ns-card-checkbox">
                          <CheckIcon size={10} strokeWidth={3} />
                        </span>
                      )}
                      <div className="ns-card-body">
                        <div className="ns-card-title">
                          {deriveNoteTitle(n.title, n.content)}
                        </div>
                        {n.content && (
                          <div
                            className={[
                              "ns-card-preview",
                              "ns-card-preview--rich",
                              expandedNoteIds.has(n.id) &&
                                "ns-card-preview--expanded",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            dangerouslySetInnerHTML={{
                              __html: sanitizeNotePreviewHtml(n.content),
                            }}
                          />
                        )}
                        <div className="ns-card-footer">
                          <div className="ns-card-chips">
                            {n.groups.map((g) => {
                              const c = groupColor(g);
                              return (
                                <span
                                  key={g}
                                  className="ns-chip"
                                  style={{ background: c.bg, color: c.fg }}
                                >
                                  <span className="ns-chip-dot" />
                                  <span className="ns-chip-label">{g}</span>
                                </span>
                              );
                            })}
                          </div>
                          <span
                            className={`ns-card-time${n.pinned ? " ns-card-time--pinned" : ""}`}
                          >
                            {n.pinned && <PinIcon size={8} />}
                            {timeAgo(n.updated_at)}
                          </span>
                        </div>
                      </div>
                      <button
                        className="ns-card-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(n.id);
                        }}
                        data-tooltip="Delete"
                        data-tooltip-pos="left"
                      >
                        <TrashIcon size={10} />
                      </button>
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        {editingNote && (
          <>
            <div className="ns-splitter" aria-hidden="true">
              <button
                type="button"
                className="ns-splitter-handle"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsResizingSplit(true);
                }}
                aria-label="Resize notes list and editor"
                data-tooltip="Drag to resize"
                data-tooltip-pos="left"
              />
            </div>

            <div className="ns-editor-dock">
              <NoteEditor
                key={editingNote.id}
                note={editingNote}
                entries={entries}
                availableGroups={availableGroups}
                onUpdate={onUpdate}
                onDelete={handleDelete}
                onPin={onPin}
                onSetGroups={onSetGroups}
                onCopyEntry={onCopyEntry}
                onBack={() => setEditingId(null)}
              />
            </div>
          </>
        )}

        {menuNote && menuState && (
          <CardMenu
            open={true}
            anchorX={menuState.x}
            anchorY={menuState.y}
            onClose={() => setMenuState(null)}
            isPinned={menuNote.pinned}
            isSaved={false}
            copied={false}
            onCopy={() => {}}
            onDelete={() => handleDelete(menuNote.id)}
            onPin={(shouldPin) => onPin(menuNote.id, shouldPin)}
            onToggleSave={() => {}}
            availableGroups={availableGroups}
            entryGroups={menuNote.groups}
            onToggleGroup={(group) => {
              const next = menuNote.groups.includes(group)
                ? menuNote.groups.filter((g) => g !== group)
                : [...menuNote.groups, group];
              onSetGroups(menuNote.id, next);
            }}
            isExpandable={isNoteExpandable(menuNote)}
            isExpanded={expandedNoteIds.has(menuNote.id)}
            onToggleExpand={() => {
              setExpandedNoteIds((prev) => {
                const next = new Set(prev);
                if (next.has(menuNote.id)) next.delete(menuNote.id);
                else next.add(menuNote.id);
                return next;
              });
            }}
            showCopy={false}
            showSave={false}
          />
        )}
      </div>
    </div>
  );
};

export default NotesScreen;
