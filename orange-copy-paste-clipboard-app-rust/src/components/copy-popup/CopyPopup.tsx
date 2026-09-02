import { startClock } from "../../clock";
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
import type { ClipboardEntry, AppTheme, Space } from "../../types";
import {
  deriveDisplayKind,
  fileNameFromPath,
  groupColor,
  htmlPlainText,
  isImageFile,
  isVideoFile,
  readTheme,
  resolveImageSrc,
  truncateText,
} from "../../types";
import { loadImagePreview } from "../../hooks/useFileMeta";
import { EntryTypePill } from "../entry-types/EntryTypePill";
import { DegradedPill } from "../DegradedPill";
import { ShareNetwork } from "@phosphor-icons/react";
import {
  TrashIcon,
  CloseIcon,
  PinIcon,
  SaveStarIcon,
  PlusIcon,
  CheckIcon,
  TagIcon,
} from "../icons";
import "./copyPopup.css";
import { installWebviewGuards } from "../../webview-guards";

// Window-height budget (logical px), width fixed at Rust COPY_POPUP_W. The
// preview is flex:1, so these only need to give it enough room — a little slack
// shows as breathing space, never a clip.
const CHROME_H = 120; // header + command row + paddings + base gaps
// A picker takes over the content slot (replacing the preview) rather than
// stacking below it. To avoid the window jumping taller when a picker opens, it
// keeps the preview's height and only leaves that range at the extremes: it
// grows to a floor when the preview is too short to use the picker, and caps at
// the picker's natural size so a tall image doesn't leave a mostly-empty list.
const GROUPS_REGION_H = 176; // header + group list + new-group input (natural cap)
const GROUPS_FLOOR_H = 128; // smallest usable groups picker (header + a row + input)
const SPACE_ROW_H = 30; // one space row in the share picker
const SPACES_REGION_MAX = 152; // share list scrolls past this
const SPACES_FLOOR_H = 112; // smallest usable share picker
const BLOCKED_REGION_H = 96; // the "sign in / make a space" hint
const MIN_PREVIEW_H = 44;
const MAX_PREVIEW_H = 172; // text cap
const MAX_MEDIA_H = 300; // image/video cap — they get more room than text

// The preview's usable inner width at the fixed window width (COPY_POPUP_W 340):
// minus body, container and preview padding + borders. Used to turn an image's
// natural size into the height it will actually render at.
const PREVIEW_INNER_W = 284;

// The one group the app treats specially; the quick Save toggle targets it.
const SAVED = "Saved";

// Height an image renders at inside the preview: contained within the available
// width and a max height, and never upscaled past its natural size.
function fittedImageHeight(naturalW: number, naturalH: number): number {
  if (!naturalW || !naturalH) return MIN_PREVIEW_H;
  const scale = Math.min(PREVIEW_INNER_W / naturalW, MAX_MEDIA_H / naturalH, 1);
  return Math.round(naturalH * scale);
}

function estimateTextHeight(kind: string, content: string): number {
  if (kind === "file") {
    const count = content.split("\n").filter((l) => l.trim()).length;
    return Math.min(Math.max(count * 20, MIN_PREVIEW_H), MAX_PREVIEW_H);
  }
  // Preview text is truncated to ~200 chars; ~38 chars per wrapped line at the
  // mono size, ~18px per line, plus the box padding.
  const lines = Math.ceil(Math.min(content.length, 200) / 38);
  return Math.min(Math.max(lines * 18 + 16, MIN_PREVIEW_H), MAX_PREVIEW_H);
}

const CopyPopup: React.FC = () => {
  const [kind, setKind] = useState<"text" | "image" | "file" | "html">("text");
  const [content, setContent] = useState("");
  const [entryId, setEntryId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<string[]>([]);
  const [deleted, setDeleted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  // Which assignment panel is open below the command row: the group picker, the
  // space (share) picker, or neither. Only one at a time.
  const [picker, setPicker] = useState<"groups" | "spaces" | null>(null);
  const [newGroup, setNewGroup] = useState("");
  // Sharing state, read from the same Rust bookkeeping the main window uses.
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [entrySpaceIds, setEntrySpaceIds] = useState<string[]>([]);
  // The height the loaded preview image renders at, so the box (and window) can
  // size to the image instead of a fixed budget. Null until an image loads.
  const [mediaH, setMediaH] = useState<number | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newGroupRef = useRef<HTMLInputElement>(null);
  // The window is shown by React (not Rust) once it has rendered and sized the
  // new entry, so it never visibly updates on screen. `needPresent` is armed on
  // each open; `presentTimer` is a fallback in case a resize never resolves.
  const needPresent = useRef(false);
  const presentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const present = useCallback(() => {
    if (!needPresent.current) return;
    needPresent.current = false;
    if (presentTimer.current) {
      clearTimeout(presentTimer.current);
      presentTimer.current = null;
    }
    invoke("present_copy_popup").catch(console.error);
  }, []);

  const saved = groups.includes(SAVED);

  // Sync theme
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sc-theme") setTheme((e.newValue as AppTheme) ?? "dark");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (visible) setTheme(readTheme());
  }, [visible]);

  // Listen for clipboard:copied
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listen<{
      id: string;
      kind: "text" | "image" | "file" | "html";
      content: string;
      pinned: boolean;
      groups: string[];
      shares: string[];
    }>(
      "clipboard:copied",
      async (event) => {
        if (cancelled) return;
        const id = event.payload.id;
        setDeleted(false);
        setPicker(null);
        setNewGroup("");
        setMediaH(null);
        setKind(event.payload.kind);
        setContent(event.payload.content);
        setEntryId(id);
        // State comes with the event, so the chips render on the first paint.
        setPinned(event.payload.pinned);
        setGroups(event.payload.groups ?? []);
        setEntrySpaceIds(event.payload.shares ?? []);
        // Arm the deferred reveal: the window shows once it has sized itself.
        needPresent.current = true;
        if (presentTimer.current) clearTimeout(presentTimer.current);
        presentTimer.current = setTimeout(present, 200);
        setVisible(false);
        requestAnimationFrame(() => setVisible(true));

        // The rest only feeds the pickers (group options, space names, sign-in
        // state); it never changes what the chips show for a fresh capture, so
        // it can resolve after the window is already up without any visible jump.
        try {
          const history = await invoke<ClipboardEntry[]>("get_history");
          if (cancelled) return;
          const names = new Set<string>();
          for (const h of history) for (const g of h.groups ?? []) names.add(g);
          setAllGroups([...names]);
        } catch {
          /* state unavailable, defaults are fine */
        }
        try {
          const list = await invoke<Space[]>("spaces_cached");
          if (!cancelled) setSpaces(list);
        } catch {
          /* none */
        }
        try {
          const user = await invoke<{ user_id: string } | null>("sync_get_user");
          if (!cancelled) setSignedIn(!!user);
        } catch {
          if (!cancelled) setSignedIn(false);
        }
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      if (presentTimer.current) clearTimeout(presentTimer.current);
    };
  }, []);

  // Dismiss on blur
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .listen("tauri://blur", () => {
        if (cancelled) return;
        // Delay so button clicks inside the popup can process first;
        // transparent frameless windows on Windows can fire blur on click.
        blurTimer.current = setTimeout(() => {
          setVisible(false);
          invoke("close_copy_popup").catch(console.error);
        }, 200);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Image file preview
  const files =
    kind === "file"
      ? content
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  const firstFile = files[0] ?? "";

  // Whether the preview shows an image/video, so it can be centered/sized to it.
  const mediaPreview =
    kind === "image" ||
    (kind === "file" && !!firstFile && (isImageFile(firstFile) || isVideoFile(firstFile)));

  useEffect(() => {
    if (kind !== "file" || !firstFile || !isImageFile(firstFile)) {
      setImagePreview(null);
      return;
    }
    let active = true;
    loadImagePreview(firstFile).then((p) => {
      if (active) setImagePreview(p);
    });
    return () => {
      active = false;
    };
  }, [kind, firstFile]);

  // Size the window to fit the content. Images take exactly the height they
  // render at (measured on load) so nothing is wasted or clipped; text falls
  // back to an estimate. The chips row and open picker add their own height.
  useEffect(() => {
    if (!visible) return;
    let previewH: number;
    if (mediaH != null) {
      // Loaded image: its fitted height, plus the box padding (~18) and, for
      // file entries, the filename line (~24) beneath it.
      previewH = Math.min(mediaH + (kind === "file" ? 42 : 18), MAX_MEDIA_H + 42);
    } else if (mediaPreview) {
      // Media entry still loading (or a video): a reasonable interim height.
      previewH = MAX_PREVIEW_H;
    } else {
      previewH = estimateTextHeight(kind, content);
    }
    // The content slot shows either the preview or, while one is open, a picker
    // in its place. Keep the preview's height across that swap so the window
    // doesn't jump: only clamp into [floor, natural] so a too-short preview grows
    // enough to use the picker and a too-tall one doesn't waste space.
    let contentH = previewH;
    if (picker === "groups") {
      contentH = Math.min(Math.max(previewH, GROUPS_FLOOR_H), GROUPS_REGION_H);
    } else if (picker === "spaces") {
      const need =
        !signedIn || spaces.length === 0
          ? BLOCKED_REGION_H
          : Math.min(52 + spaces.length * SPACE_ROW_H, SPACES_REGION_MAX);
      contentH = Math.min(Math.max(previewH, Math.min(need, SPACES_FLOOR_H)), need);
    }
    // Chips ride on the header line now, so they add no height of their own.
    const totalH = CHROME_H + contentH;
    // A media entry waits to be revealed until its height is measured, so it
    // doesn't pop in at an interim size and then reflow; everything else reveals
    // as soon as the first resize lands.
    const measured = !mediaPreview || mediaH != null;
    invoke("resize_copy_popup", { height: totalH })
      .then(() => {
        if (measured) present();
      })
      .catch(() => present());
  }, [
    visible,
    kind,
    content,
    mediaH,
    mediaPreview,
    pinned,
    groups,
    entrySpaceIds,
    picker,
    spaces,
    signedIn,
    present,
  ]);

  useEffect(() => {
    if (picker === "groups") requestAnimationFrame(() => newGroupRef.current?.focus());
  }, [picker]);

  const cancelBlur = useCallback(() => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    cancelBlur();
    setVisible(false);
    invoke("close_copy_popup").catch(console.error);
  }, [cancelBlur]);

  const handlePin = useCallback(async () => {
    if (!entryId) return;
    cancelBlur();
    const cmd = pinned ? "unpin_entry" : "pin_entry";
    const ok = await invoke<boolean>(cmd, { id: entryId }).catch(() => false);
    if (ok) setPinned((p) => !p);
  }, [entryId, pinned, cancelBlur]);

  // Persist a new group membership set for the current entry.
  const commitGroups = useCallback(
    async (next: string[]) => {
      if (!entryId) return;
      cancelBlur();
      setGroups(next);
      await invoke("set_entry_groups", { id: entryId, groups: next }).catch(console.error);
    },
    [entryId, cancelBlur],
  );

  const toggleGroup = useCallback(
    (name: string) => {
      const next = groups.includes(name)
        ? groups.filter((g) => g !== name)
        : [...groups, name];
      if (!allGroups.includes(name)) setAllGroups((a) => [...a, name]);
      void commitGroups(next);
    },
    [groups, allGroups, commitGroups],
  );

  const handleQuickSave = useCallback(() => {
    toggleGroup(SAVED);
  }, [toggleGroup]);

  // Share the entry into a space, or stop sharing it there. Optimistic: the
  // chip and checkmark move with the click; a failed command puts it back.
  // A space we hold no key for is queued, not refused (Rust flushes it when the
  // key lands) — same behavior as the card menu's share row.
  const toggleSpace = useCallback(
    (spaceId: string) => {
      if (!entryId) return;
      cancelBlur();
      const next = entrySpaceIds.includes(spaceId)
        ? entrySpaceIds.filter((s) => s !== spaceId)
        : [...entrySpaceIds, spaceId];
      setEntrySpaceIds(next);
      invoke("space_set_entry_shares", {
        entryId,
        entryType: "clipboard",
        spaceIds: next,
      }).catch(() => {
        setEntrySpaceIds(entrySpaceIds); // put the old set back on failure
      });
    },
    [entryId, entrySpaceIds, cancelBlur],
  );

  const handleCreateGroup = useCallback(() => {
    const name = newGroup.trim();
    if (!name) return;
    setNewGroup("");
    if (!groups.includes(name)) void commitGroups([...groups, name]);
    if (!allGroups.includes(name)) setAllGroups((a) => [...a, name]);
  }, [newGroup, groups, allGroups, commitGroups]);

  const handleDelete = useCallback(async () => {
    if (!entryId) return;
    cancelBlur();
    await invoke("delete_entry", { id: entryId }).catch(console.error);
    setDeleted(true);
    setTimeout(() => {
      invoke("close_copy_popup").catch(console.error);
    }, 800);
  }, [entryId, cancelBlur]);

  // Keyboard: one key per action. Skip letter/delete shortcuts while the
  // new-group field is focused so the user can actually type into it.
  useEffect(() => {
    if (!visible || deleted) return;
    const handler = (e: KeyboardEvent) => {
      const typing =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement;

      if (e.key === "Escape") {
        e.preventDefault();
        if (picker) setPicker(null);
        else handleClose();
        return;
      }
      if (typing) return;

      switch (e.key.toLowerCase()) {
        case "p":
          e.preventDefault();
          void handlePin();
          break;
        case "s":
          e.preventDefault();
          handleQuickSave();
          break;
        case "g":
          e.preventDefault();
          setPicker((p) => (p === "groups" ? null : "groups"));
          break;
        case "delete":
        case "backspace":
          e.preventDefault();
          void handleDelete();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, deleted, picker, handlePin, handleQuickSave, handleDelete, handleClose]);

  const previewText = truncateText(content, 200);

  const displayKind = deriveDisplayKind({
    id: entryId ?? "",
    type: kind,
    content,
    timestamp: 0,
    pinned,
    groups: [],
  });

  // Custom groups (everything except the special Saved group, which gets its
  // own star chip) and the spaces this entry is shared into.
  const customGroups = useMemo(() => groups.filter((g) => g !== SAVED), [groups]);
  const sharedSpaces = useMemo(
    () =>
      entrySpaceIds.map((id) => {
        const s = spaces.find((sp) => sp.id === id);
        return { id, name: s?.name ?? "a space", waiting: s ? !s.has_key : false };
      }),
    [entrySpaceIds, spaces],
  );

  // Custom groups the picker offers, Saved excluded (it has its own top row).
  const pickerGroups = useMemo(
    () => [...new Set(allGroups)].filter((g) => g !== SAVED),
    [allGroups],
  );

  // Why the share picker can't act yet, or null when it can.
  const shareBlocked = !signedIn
    ? "Sign in on the Account screen to share."
    : spaces.length === 0
      ? "Create a space on the Spaces screen first."
      : null;

  // The header chip row, capped: the type pill leads, then pin / Saved / groups /
  // shared spaces. Only the first few show; the rest collapse into a "+N" whose
  // tooltip names them, so the row stays on one line.
  const chips: { key: string; label: string; node: React.ReactNode }[] = [
    { key: "type", label: displayKind, node: <EntryTypePill kind={displayKind} /> },
  ];
  if (pinned) {
    chips.push({
      key: "pin",
      label: "Pinned",
      node: (
        <span className="popup-chip popup-chip--pin">
          <PinIcon size={9} filled />
          Pinned
        </span>
      ),
    });
  }
  if (saved) {
    chips.push({
      key: "saved",
      label: "Saved",
      node: (
        <span className="popup-chip popup-chip--saved">
          <SaveStarIcon size={9} filled />
          Saved
        </span>
      ),
    });
  }
  for (const g of customGroups) {
    const c = groupColor(g);
    chips.push({
      key: `g:${g}`,
      label: g,
      node: (
        <span className="popup-chip popup-chip--group" style={{ color: c.fg, background: c.bg }}>
          <span className="popup-chip-dot" style={{ background: c.fg }} />
          {g}
        </span>
      ),
    });
  }
  for (const s of sharedSpaces) {
    chips.push({
      key: `s:${s.id}`,
      label: s.name + (s.waiting ? " (waiting)" : ""),
      node: (
        <span
          className={`popup-chip popup-chip--space${s.waiting ? " is-waiting" : ""}`}
          title={
            s.waiting
              ? "Waiting for this space's key. It goes out when the key arrives."
              : undefined
          }
        >
          <ShareNetwork size={10} weight="bold" />
          {s.name}
        </span>
      ),
    });
  }
  const MAX_CHIPS = 3;
  const shownChips = chips.slice(0, MAX_CHIPS);
  const hiddenChips = chips.slice(MAX_CHIPS);

  return (
    <div
      className={`popup-container${visible ? " visible" : ""}`}
      data-theme={theme}
      onMouseEnter={cancelBlur}
    >
      {deleted ? (
        <div className="popup-deleted-state">
          <TrashIcon size={20} />
          <span>Removed from history</span>
        </div>
      ) : (
        <>
          {/* Header — "Copied" leads, then a single, non-wrapping chip row on the
              same line: the type pill, then state chips (pin, Saved star, custom
              group, shared space). Extra chips collapse into a "+N" that names
              them on hover. */}
          <div className="popup-header">
            <div className="popup-header-left">
              <span className="popup-title">Copied</span>
              {kind === "file" && files.length > 1 && (
                <span className="popup-file-count">{files.length} files</span>
              )}
              <DegradedPill />
              <div className="popup-chips">
                {shownChips.map((c) => (
                  <React.Fragment key={c.key}>{c.node}</React.Fragment>
                ))}
                {hiddenChips.length > 0 && (
                  <span
                    className="popup-chips-more"
                    title={hiddenChips.map((c) => c.label).join(", ")}
                  >
                    +{hiddenChips.length}
                  </span>
                )}
              </div>
            </div>
            <button className="popup-close" onMouseDown={cancelBlur} onClick={handleClose}>
              <CloseIcon size={10} />
            </button>
          </div>

          {/* Content slot: the preview, or a picker in its place while one is
              open (rather than a panel stacked below the preview). */}
          {!picker && (
          <div className={`popup-preview${mediaPreview ? " popup-preview--media" : ""}`}>
            {kind === "image" && content ? (
              <img
                src={resolveImageSrc(content, convertFileSrc)}
                alt="Copied image"
                className="popup-preview-media"
                onLoad={(e) =>
                  setMediaH(fittedImageHeight(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))
                }
              />
            ) : kind === "html" ? (
              <p className="popup-preview-text">
                {truncateText(htmlPlainText(content), 200) || "Rich text copied"}
              </p>
            ) : kind === "file" ? (
              <>
                {firstFile && isImageFile(firstFile) && (
                  <img
                    src={imagePreview ?? convertFileSrc(firstFile)}
                    alt="File preview"
                    className="popup-preview-media"
                    onLoad={(e) =>
                      setMediaH(fittedImageHeight(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))
                    }
                  />
                )}
                {firstFile && isVideoFile(firstFile) && (
                  <video
                    className="popup-preview-media"
                    controls
                    preload="metadata"
                    src={convertFileSrc(firstFile)}
                    onLoadedMetadata={(e) =>
                      setMediaH(fittedImageHeight(e.currentTarget.videoWidth, e.currentTarget.videoHeight))
                    }
                  />
                )}
                <p className="popup-preview-text">{files.map(fileNameFromPath).join(", ")}</p>
              </>
            ) : (
              <p className="popup-preview-text">{previewText}</p>
            )}
          </div>
          )}

          {/* Groups picker — Saved sits at the top as the one special group. */}
          {picker === "groups" && (
            <div className="popup-picker" onMouseDown={cancelBlur}>
              <div className="popup-picker-head">Groups</div>
              <div className="popup-picker-list">
                <button
                  className={`popup-picker-item popup-picker-item--saved${saved ? " is-on" : ""}`}
                  onMouseDown={cancelBlur}
                  onClick={handleQuickSave}
                >
                  <span className="popup-picker-check">{saved && <CheckIcon size={10} />}</span>
                  <SaveStarIcon size={11} filled={saved} />
                  <span className="popup-picker-name">Saved</span>
                </button>
                {pickerGroups.map((g) => {
                  const on = groups.includes(g);
                  const c = groupColor(g);
                  return (
                    <button
                      key={g}
                      className={`popup-picker-item${on ? " is-on" : ""}`}
                      onMouseDown={cancelBlur}
                      onClick={() => toggleGroup(g)}
                    >
                      <span className="popup-picker-check">{on && <CheckIcon size={10} />}</span>
                      <span className="popup-chip-dot" style={{ background: c.fg }} />
                      <span className="popup-picker-name">{g}</span>
                    </button>
                  );
                })}
              </div>
              <div className="popup-picker-new">
                <PlusIcon size={12} />
                <input
                  ref={newGroupRef}
                  className="popup-picker-input"
                  type="text"
                  placeholder="New group"
                  value={newGroup}
                  spellCheck={false}
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateGroup();
                    }
                  }}
                />
              </div>
            </div>
          )}

          {/* Share-to-space picker */}
          {picker === "spaces" && (
            <div className="popup-picker" onMouseDown={cancelBlur}>
              <div className="popup-picker-head">Share to space</div>
              {shareBlocked ? (
                <div className="popup-picker-empty">{shareBlocked}</div>
              ) : (
                <div className="popup-picker-list">
                  {spaces.map((sp) => {
                    const on = entrySpaceIds.includes(sp.id);
                    return (
                      <button
                        key={sp.id}
                        className={`popup-picker-item${on ? " is-on" : ""}`}
                        onMouseDown={cancelBlur}
                        onClick={() => toggleSpace(sp.id)}
                        title={
                          sp.has_key
                            ? undefined
                            : "Waiting for this space's key. Your choice is kept and sent when it arrives."
                        }
                      >
                        <span className="popup-picker-check">{on && <CheckIcon size={10} />}</span>
                        <span className="popup-picker-name">{sp.name}</span>
                        {!sp.has_key && <span className="popup-picker-wait">waiting</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Command row */}
          <div className="popup-actions">
            <button
              className={`popup-menu-item popup-menu-item--pin${pinned ? " popup-menu-item--active" : ""}`}
              onMouseDown={cancelBlur}
              onClick={handlePin}
              disabled={!entryId}
            >
              <span>{pinned ? "Unpin" : "Pin"}</span>
              <PinIcon size={13} filled={pinned} />
            </button>

            <button
              className={`popup-menu-item popup-menu-item--groups${picker === "groups" ? " popup-menu-item--active" : ""}`}
              onMouseDown={cancelBlur}
              onClick={() => setPicker((p) => (p === "groups" ? null : "groups"))}
              disabled={!entryId}
            >
              <span>Groups</span>
              <TagIcon size={13} />
            </button>

            <button
              className={`popup-menu-item popup-menu-item--share${picker === "spaces" ? " popup-menu-item--active" : ""}`}
              onMouseDown={cancelBlur}
              onClick={() => setPicker((p) => (p === "spaces" ? null : "spaces"))}
              disabled={!entryId}
            >
              <span>Share</span>
              <ShareNetwork size={13} weight="bold" />
            </button>

            <span className="popup-menu-divider" />

            <button
              className="popup-menu-item popup-menu-item--danger"
              onMouseDown={cancelBlur}
              onClick={handleDelete}
              disabled={!entryId}
            >
              <span>Delete</span>
              <TrashIcon />
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default CopyPopup;

installWebviewGuards();

// Follow this machine's error against the server, so every "x ago" in
// this window is measured in the same frame the timestamps were written
// in. See `clock.ts`.
startClock();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <CopyPopup />,
);
