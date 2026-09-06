import { sharedNow, startClock } from "../../clock";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ClipboardEntry, AppTheme } from "../../types";
import {
  deriveDisplayKind,
  fileCount,
  fileNameFromPath,
  groupColor,
  htmlPlainText,
  isImageFile as isImagePath,
  isUrl,
  filePaths as getFilePaths,
  readSlots,
  readTheme,
  resolveImageSrc,
} from "../../types";
import { EntryTypePill, SaveIcon } from "../entry-types/EntryTypePill";
import { DegradedPill } from "../DegradedPill";
import { DotsSixVertical } from "@phosphor-icons/react";
import {
  CloseIcon,
  PinIcon,
  CopyIcon,
  TrashIcon,
  SearchIcon,
} from "../icons";
import ConfirmDeleteDialog from "../common/ConfirmDeleteDialog";
import {
  shouldConfirmDelete,
  disableSyncDeleteConfirm,
} from "../../confirmDelete";
import "./pastePopup.css";
import { installWebviewGuards } from "../../webview-guards";
import { usePopupDrag } from "../../hooks/usePopupDrag";

type Tab = "recent" | "pinned";

// Window widths — must match Rust PASTE_POPUP_W / PASTE_POPUP_W_WIDE.
const BASE_W = 360;
const WIDE_W = 540;

// Height budget (logical px). The body flexes between the search bar and the
// hint row; these figures decide how tall the *window* is asked to be so the
// list shows as many rows as it has (up to a cap) without leaving dead space.
const CHROME_H = 138; // header + search + hints + container/body padding
const ITEM_H = 44; // row min-height (40) + gap (3) + border
const LIST_MAX_H = 8 * ITEM_H; // cap; the list scrolls past this
const MIN_LIST_H = 84;
const PREVIEW_MIN_H = 286; // keep the panel tall enough for the boxy media + actions

function relativeTime(ts: number): string {
  const diff = sharedNow() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** Badge label: 1-9, 0 for slot 10 */
function badgeLabel(index: number): string {
  return index === 9 ? "0" : String(index + 1);
}

interface PastePayload {
  recent: ClipboardEntry[];
  pinned: ClipboardEntry[];
}

/** Plain, searchable text for an entry (what the user sees / can match on). */
function entryText(entry: ClipboardEntry): string {
  if (entry.type === "html") return htmlPlainText(entry.content);
  if (entry.type === "file")
    return getFilePaths(entry.content).map(fileNameFromPath).join(" ");
  if (entry.type === "image") return entry.label ?? "image";
  return entry.content;
}

/** One-line preview for a list row. */
function rowPreview(entry: ClipboardEntry, max = 64): string {
  const line = entryText(entry).replace(/[\r\n]+/g, " ").trim();
  return line.length > max ? line.slice(0, max) + "..." : line;
}

const PastePopup: React.FC = () => {
  const { onMouseDown: onHeaderDrag, isDragging } = usePopupDrag("paste-popup");
  const [recentAll, setRecentAll] = useState<ClipboardEntry[]>([]);
  const [pinnedAll, setPinnedAll] = useState<ClipboardEntry[]>([]);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [tab, setTab] = useState<Tab>("recent");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [slots, setSlots] = useState(readSlots);
  const [query, setQuery] = useState("");
  const [previewOpen, setPreviewOpen] = useState(true);
  // Bumped on every show so the resize below re-applies the current width even
  // when the popup was closed via the global shortcut (which hides the window
  // without changing any React state, so no other dep would change).
  const [showNonce, setShowNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Whether the last selection change came from the keyboard. Only then should
  // the list auto-scroll to follow it — on hover the row must stay put under
  // the cursor rather than scrolling itself into view.
  const keyboardNav = useRef(false);

  const source = tab === "pinned" ? pinnedAll : recentAll;

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter((e) => entryText(e).toLowerCase().includes(q));
  }, [source, query]);

  // Number-key range: honour the user's paste-slots setting (3-10), capped at
  // the ten digit keys. Rows past this are reachable by arrow / scroll / search.
  const numbered = Math.min(slots, 10);

  // Keep the selection inside the (possibly filtered) list.
  useEffect(() => {
    setSelectedIdx((i) => (entries.length === 0 ? 0 : Math.min(i, entries.length - 1)));
  }, [entries.length]);

  const selected = entries[selectedIdx];

  // Resize the window to fit the content (and the current width).
  useEffect(() => {
    if (!visible) return;
    const listH = entries.length > 0 ? Math.min(entries.length * ITEM_H, LIST_MAX_H) : MIN_LIST_H;
    const bodyH = previewOpen ? Math.max(listH, PREVIEW_MIN_H) : listH;
    const width = previewOpen ? WIDE_W : BASE_W;
    invoke("resize_paste_popup", { width, height: CHROME_H + bodyH }).catch(console.error);
  }, [visible, entries.length, previewOpen, showNonce]);

  // Bring the selected row into view as the selection moves — but only for
  // keyboard moves, so hovering a clipped row doesn't scroll it out from under
  // the pointer.
  useEffect(() => {
    if (!selected || !keyboardNav.current) return;
    rowRefs.current[selected.id]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Sync theme across windows.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sc-theme") setTheme((e.newValue as AppTheme) ?? "dark");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Read the preview preference once, and refresh volatile prefs on each show.
  useEffect(() => {
    let cancelled = false;
    invoke<boolean | null>("get_setting", { key: "paste_preview_open" })
      .then((v) => {
        if (!cancelled && v !== null) setPreviewOpen(v === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (visible) {
      setTheme(readTheme());
      setSlots(readSlots());
      // Focus the search field so typing filters immediately.
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [visible]);

  // Listen for entries.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<PastePayload>("paste-popup:entries", (event) => {
      if (cancelled) return;
      setRecentAll(event.payload.recent);
      setPinnedAll(event.payload.pinned);
      setSelectedIdx(0);
      setTab("recent");
      setQuery("");
      setVisible(true);
      setShowNonce((n) => n + 1);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Dismiss on blur.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .listen("tauri://blur", () => {
        if (cancelled) return;
        // A header drag is an OS move loop that blurs this window; ignore that
        // blur so the drag does not dismiss the popup. Real click-aways close.
        if (isDragging()) return;
        setVisible(false);
        invoke("close_paste_popup").catch(console.error);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isDragging]);

  const handleClose = useCallback(() => {
    setVisible(false);
    invoke("close_paste_popup").catch(console.error);
  }, []);

  const handlePaste = useCallback((id: string) => {
    invoke("paste_entry", { id }).catch(console.error);
    setVisible(false);
  }, []);

  // "Paste and pop": paste, then drop it from Recent so a one-time value
  // doesn't linger. Both are existing commands.
  const handlePasteAndPop = useCallback((id: string) => {
    invoke("paste_entry", { id }).catch(console.error);
    invoke("delete_entry", { id }).catch(console.error);
    setVisible(false);
  }, []);

  const handleCopyOnly = useCallback((id: string) => {
    invoke("copy_entry", { id }).catch(console.error);
    setVisible(false);
  }, []);

  const applyPinLocally = useCallback((entry: ClipboardEntry, pinned: boolean) => {
    setRecentAll((list) => list.map((e) => (e.id === entry.id ? { ...e, pinned } : e)));
    setPinnedAll((prev) => {
      if (pinned) {
        if (prev.some((x) => x.id === entry.id)) return prev;
        return [{ ...entry, pinned: true }, ...prev];
      }
      return prev.filter((x) => x.id !== entry.id);
    });
  }, []);

  const handlePin = useCallback(
    async (entry: ClipboardEntry) => {
      const cmd = entry.pinned ? "unpin_entry" : "pin_entry";
      const ok = await invoke<boolean>(cmd, { id: entry.id }).catch(() => false);
      if (ok) applyPinLocally(entry, !entry.pinned);
    },
    [applyPinLocally],
  );

  // A synced entry gets a confirmation first (there is no Undo in the popup, so
  // the dialog is the only safety net); local-only entries delete immediately.
  const [confirmEntry, setConfirmEntry] = useState<ClipboardEntry | null>(null);

  const performDelete = useCallback(async (entry: ClipboardEntry) => {
    await invoke("delete_entry", { id: entry.id }).catch(console.error);
    setRecentAll((list) => list.filter((e) => e.id !== entry.id));
    setPinnedAll((list) => list.filter((e) => e.id !== entry.id));
  }, []);

  const handleDelete = useCallback(
    async (entry: ClipboardEntry) => {
      if (await shouldConfirmDelete([`clipboard:${entry.id}`])) {
        setConfirmEntry(entry);
      } else {
        void performDelete(entry);
      }
    },
    [performDelete],
  );

  const switchTab = useCallback((t: Tab) => {
    keyboardNav.current = true; // scroll the new tab's list back to the top
    setTab(t);
    setSelectedIdx(0);
  }, []);

  const togglePreview = useCallback(() => {
    setPreviewOpen((v) => {
      const next = !v;
      invoke("set_setting", { key: "paste_preview_open", value: next }).catch(
        console.error,
      );
      return next;
    });
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  // Keyboard model — see the design's "empty field pastes" rule: while the
  // search box is empty, digits paste the numbered rows and Space toggles the
  // preview; once there's a query, those keys type into it instead.
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      // The confirm dialog owns the keyboard while it is up (it handles its own
      // Escape); nothing here should paste or navigate underneath it.
      if (confirmEntry) return;
      const empty = query.length === 0;

      if (empty && /^[0-9]$/.test(e.key)) {
        const num = e.key === "0" ? 10 : parseInt(e.key, 10);
        if (num <= numbered && num <= entries.length) {
          e.preventDefault();
          const entry = entries[num - 1];
          if (e.altKey) handlePasteAndPop(entry.id);
          else handlePaste(entry.id);
        }
        return;
      }

      switch (e.key) {
        case "Tab":
          e.preventDefault();
          switchTab(tab === "recent" ? "pinned" : "recent");
          break;
        case " ":
          if (empty) {
            e.preventDefault();
            togglePreview();
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (entries.length > 0) {
            keyboardNav.current = true;
            setSelectedIdx((i) => (i + 1) % entries.length);
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          if (entries.length > 0) {
            keyboardNav.current = true;
            setSelectedIdx((i) => (i - 1 + entries.length) % entries.length);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (selected) {
            if (e.altKey) handlePasteAndPop(selected.id);
            else handlePaste(selected.id);
          }
          break;
        case "Escape":
          e.preventDefault();
          handleClose();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    visible,
    confirmEntry,
    entries,
    selected,
    numbered,
    query,
    tab,
    handlePaste,
    handlePasteAndPop,
    handleClose,
    switchTab,
    togglePreview,
  ]);

  const recentCount = recentAll.length;
  const pinnedCount = pinnedAll.length;

  const stop = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div
      className={`paste-container${visible ? " visible" : ""}${previewOpen ? " paste-container--wide" : ""}`}
      data-theme={theme}
    >
      {/* Header */}
      <div className="paste-header" onMouseDown={onHeaderDrag}>
        <DotsSixVertical
          className="paste-grip"
          size={14}
          weight="bold"
          aria-hidden="true"
        />
        <div className="paste-header-left">
          <span className="paste-title">Quick Paste</span>
          <span className="paste-count">{entries.length}</span>
          <DegradedPill />
        </div>
        <div className="paste-tabs">
          <button
            className={`paste-tab${tab === "recent" ? " paste-tab--active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              switchTab("recent");
            }}
          >
            Recent
            {recentCount > 0 && <span className="paste-tab-count">{recentCount}</span>}
          </button>
          <button
            className={`paste-tab${tab === "pinned" ? " paste-tab--active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              switchTab("pinned");
            }}
          >
            Pinned
            {pinnedCount > 0 && <span className="paste-tab-count">{pinnedCount}</span>}
          </button>
        </div>
        <button
          className={`paste-preview-toggle${previewOpen ? " is-open" : ""}`}
          title={previewOpen ? "Hide preview (Space)" : "Show preview (Space)"}
          onMouseDown={stop}
          onClick={togglePreview}
        >
          <PreviewPanelIcon open={previewOpen} />
        </button>
        <button className="paste-close" onMouseDown={stop} onClick={handleClose}>
          <CloseIcon size={10} />
        </button>
      </div>

      {/* Search */}
      <div className="paste-search">
        <SearchIcon size={13} />
        <input
          ref={searchRef}
          className="paste-search-input"
          type="text"
          placeholder={`Search ${source.length} clip${source.length === 1 ? "" : "s"}...`}
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIdx(0);
          }}
        />
        {query && (
          <button
            className="paste-search-clear"
            onMouseDown={stop}
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
          >
            <CloseIcon size={9} />
          </button>
        )}
      </div>

      {/* Body: list (+ preview) */}
      <div className="paste-body">
        {entries.length === 0 ? (
          <div className="paste-empty">
            <SearchIcon size={26} />
            <span>{query ? "No matches" : tab === "pinned" ? "No pinned items" : "No recent items"}</span>
          </div>
        ) : (
          <div className="paste-list">
            {entries.map((entry, index) => (
              <button
                key={entry.id}
                ref={(el) => {
                  rowRefs.current[entry.id] = el;
                }}
                className={`paste-item${index === selectedIdx ? " paste-item--selected" : ""}`}
                onMouseEnter={() => {
                  keyboardNav.current = false;
                  setSelectedIdx(index);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handlePaste(entry.id);
                }}
              >
                <span className={`paste-key-badge${index >= numbered ? " paste-key-badge--none" : ""}`}>
                  {index < numbered ? badgeLabel(index) : ""}
                </span>

                {entry.type === "image" ? (
                  <img
                    className="paste-thumb"
                    src={resolveImageSrc(entry.content, convertFileSrc)}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <EntryTypePill
                    kind={deriveDisplayKind(entry)}
                    count={fileCount(entry)}
                  />
                )}

                <span className="paste-row-preview">{rowPreview(entry)}</span>

                <span className="paste-item-meta">
                  {entry.pinned && <PinIcon className="paste-pin-icon" size={9} filled />}
                  <span className="paste-item-time">{relativeTime(entry.timestamp)}</span>
                </span>

                {/* Inline actions on hover / selection */}
                <span className="paste-row-actions">
                  <span
                    className={`paste-ia paste-ia--pin${entry.pinned ? " is-on" : ""}`}
                    title={entry.pinned ? "Unpin" : "Pin"}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handlePin(entry);
                    }}
                  >
                    <PinIcon size={12} filled={entry.pinned} />
                  </span>
                  <span
                    className="paste-ia paste-ia--copy"
                    title="Copy without pasting"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleCopyOnly(entry.id);
                    }}
                  >
                    <CopyIcon size={12} />
                  </span>
                  <span
                    className="paste-ia paste-ia--danger"
                    title="Delete"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDelete(entry);
                    }}
                  >
                    <TrashIcon size={12} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {previewOpen && selected && <PreviewPanel entry={selected} onPaste={handlePaste} onPin={handlePin} onCopy={handleCopyOnly} onDelete={handleDelete} stop={stop} />}
      </div>

      {/* Hints */}
      <div className="paste-hints">
        <span className="paste-hint"><kbd>1-{numbered === 10 ? "0" : numbered}</kbd> paste</span>
        <span className="paste-hint"><kbd><ArrowKeyIcon dir="up" />Up</kbd><kbd><ArrowKeyIcon dir="down" />Dn</kbd> move</span>
        <span className="paste-hint"><kbd>Enter</kbd> paste</span>
        <span className="paste-hint"><kbd>type</kbd> search</span>
      </div>

      <ConfirmDeleteDialog
        open={!!confirmEntry}
        entryKeys={confirmEntry ? [`clipboard:${confirmEntry.id}`] : undefined}
        onCancel={() => setConfirmEntry(null)}
        onConfirm={(dontAsk) => {
          const entry = confirmEntry;
          setConfirmEntry(null);
          if (dontAsk) void disableSyncDeleteConfirm();
          if (entry) void performDelete(entry);
        }}
      />
    </div>
  );
};

/** Up / down arrow glyph for the move hint (SVG, not a unicode arrow). */
const ArrowKeyIcon: React.FC<{ dir: "up" | "down" }> = ({ dir }) => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
    {dir === "up" ? (
      <>
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="6 11 12 5 18 11" />
      </>
    ) : (
      <>
        <line x1="12" y1="5" x2="12" y2="19" />
        <polyline points="6 13 12 19 18 13" />
      </>
    )}
  </svg>
);

/** Small two-pane glyph for the preview toggle. */
const PreviewPanelIcon: React.FC<{ open: boolean }> = ({ open }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="15" y1="4" x2="15" y2="20" />
    {open && <rect x="15" y="4" width="6" height="16" fill="currentColor" opacity="0.25" stroke="none" />}
  </svg>
);

interface PreviewProps {
  entry: ClipboardEntry;
  onPaste: (id: string) => void;
  onPin: (entry: ClipboardEntry) => void;
  onCopy: (id: string) => void;
  onDelete: (entry: ClipboardEntry) => void;
  stop: (e: React.MouseEvent) => void;
}

const PreviewPanel: React.FC<PreviewProps> = ({ entry, onPaste, onPin, onCopy, onDelete, stop }) => {
  const files = entry.type === "file" ? getFilePaths(entry.content) : [];
  const firstFile = files[0] ?? "";
  const isImg = entry.type === "image";
  const isFileImg = entry.type === "file" && files.length === 1 && isImagePath(firstFile);
  const showsImage = isImg || isFileImg;

  // Natural image size, filled in on load. Shown in the corner badge, so it is
  // reset per entry to avoid flashing the previous image's size.
  const [dims, setDims] = useState<string | null>(null);
  useEffect(() => {
    setDims(null);
  }, [entry.id]);
  const onImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      setDims(`${img.naturalWidth} x ${img.naturalHeight}`);
    }
  }, []);


  const kindLabel = deriveDisplayKind(entry);
  // The size/count sits in a corner badge on the preview box, not in the pill
  // row, so the row is only pills (type + Saved + groups).
  let measure: string | null = null;
  const isLink = entry.type === "text" && isUrl(entry.content.trim());
  if (entry.type === "text" || entry.type === "html") {
    const plain = entry.type === "html" ? htmlPlainText(entry.content) : entry.content;
    measure = `${plain.length} chars`;
  } else if (entry.type === "file") {
    measure = `${files.length} file${files.length === 1 ? "" : "s"}`;
  } else if (showsImage && dims) {
    measure = dims;
  }

  // One line of chips: the type pill leads, then Saved and the custom groups.
  // Only the first few are shown; the rest collapse into a "+N" whose tooltip
  // names them, so the row never wraps.
  const chips: { key: string; label: string; node: React.ReactNode }[] = [
    { key: "type", label: kindLabel, node: <EntryTypePill kind={kindLabel} /> },
  ];
  if (isLink) {
    chips.push({ key: "link", label: "link", node: <span className="paste-preview-metabit">link</span> });
  }
  if (entry.groups.includes("Saved")) {
    chips.push({
      key: "saved",
      label: "Saved",
      node: (
        <span className="paste-preview-saved">
          {SaveIcon}
          Saved
        </span>
      ),
    });
  }
  for (const g of entry.groups.filter((g) => g !== "Saved")) {
    const gc = groupColor(g);
    chips.push({
      key: `g:${g}`,
      label: g,
      node: (
        <span className="paste-preview-group" style={{ background: gc.bg, color: gc.fg }}>
          <span className="paste-preview-group-dot" />
          <span className="paste-preview-group-label">{g}</span>
        </span>
      ),
    });
  }
  const MAX_CHIPS = 3;
  const shownChips = chips.slice(0, MAX_CHIPS);
  const hiddenChips = chips.slice(MAX_CHIPS);

  return (
    <div className="paste-preview" onMouseDown={stop}>
      <div className="paste-preview-kind">Preview</div>
      <div className={`paste-preview-media${showsImage ? " paste-preview-media--image" : ""}`}>
        {isImg ? (
          <img className="paste-preview-img" src={resolveImageSrc(entry.content, convertFileSrc)} alt="" draggable={false} onLoad={onImgLoad} />
        ) : isFileImg ? (
          <img className="paste-preview-img" src={convertFileSrc(firstFile)} alt="" draggable={false} onLoad={onImgLoad} />
        ) : entry.type === "file" ? (
          <div className="paste-preview-files">
            {files.map((f) => (
              <div key={f} className="paste-preview-file">
                {fileNameFromPath(f)}
              </div>
            ))}
          </div>
        ) : (
          <div className="paste-preview-text">
            {entry.type === "html" ? htmlPlainText(entry.content) : entry.content}
          </div>
        )}
        {measure && <span className="paste-preview-measure">{measure}</span>}
      </div>

      <div className="paste-preview-meta">
        {shownChips.map((c) => (
          <React.Fragment key={c.key}>{c.node}</React.Fragment>
        ))}
        {hiddenChips.length > 0 && (
          <span
            className="paste-preview-more"
            title={hiddenChips.map((c) => c.label).join(", ")}
          >
            +{hiddenChips.length}
          </span>
        )}
      </div>

      <button className="paste-preview-paste" onMouseDown={stop} onClick={() => onPaste(entry.id)}>
        Paste <kbd>Enter</kbd>
      </button>
      <div className="paste-preview-actions">
        <button className={`paste-pa paste-pa--pin${entry.pinned ? " is-on" : ""}`} title={entry.pinned ? "Unpin" : "Pin"} onMouseDown={stop} onClick={() => onPin(entry)}>
          <span>{entry.pinned ? "Unpin" : "Pin"}</span>
          <PinIcon size={13} filled={entry.pinned} />
        </button>
        <button className="paste-pa paste-pa--copy" title="Copy without pasting" onMouseDown={stop} onClick={() => onCopy(entry.id)}>
          <span>Copy</span>
          <CopyIcon size={13} />
        </button>
        <span className="paste-pa-divider" />
        <button className="paste-pa paste-pa--danger" title="Delete" onMouseDown={stop} onClick={() => onDelete(entry)}>
          <span>Delete</span>
          <TrashIcon size={13} />
        </button>
      </div>
    </div>
  );
};

export default PastePopup;

installWebviewGuards();

// Follow this machine's error against the server, so every "x ago" in
// this window is measured in the same frame the timestamps were written
// in. See `clock.ts`.
startClock();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <PastePopup />,
);
